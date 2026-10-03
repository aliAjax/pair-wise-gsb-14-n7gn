<script setup lang="ts">
import { computed, reactive } from "vue";
import {
  HANDOVER_FIELDS,
  formatDateTime,
  fromLocalInput,
  money,
  priceYuan,
  toCents,
  toLocalInput,
  uid,
  usePriceStore,
  type HandoverFieldKey,
  type PriceBatch,
  type PriceVersion,
  type Side,
  type TerminalId
} from "./priceStore";

const store = usePriceStore();
const { state } = store;

const statusText: Record<PriceVersion["status"], string> = {
  active: "有效",
  superseded: "历史版本",
  "conflict-draft": "冲突草稿"
};

const handoverStatusText = {
  pending: "待合并",
  merged: "已合并待确认",
  invalidated: "已作废重算",
  confirmed: "站长已确认"
} as const;

const terminalText: Record<TerminalId, string> = {
  A: "A终端",
  B: "B终端",
  station: "站长端"
};

const priceForm = reactive({
  fuelId: state.fuels[0]?.id ?? "",
  price: "7.86",
  effectiveAt: toLocalInput(new Date().toISOString()),
  terminalId: "A" as TerminalId,
  operator: "A班收银员",
  baseRevision: state.fuels[0]?.revision ?? 0,
  note: ""
});

const batchForm = reactive({
  terminalId: "B" as TerminalId,
  operator: "B班收银员",
  effectiveAt: toLocalInput(new Date().toISOString()),
  note: "多终端回连调价批次",
  failAtIndex: 1,
  rows: [
    { fuelId: "f-95", price: "8.29" },
    { fuelId: "f-0", price: "7.31" }
  ]
});

function selectedFuelRevision(fuelId: string) {
  return store.fuelById(fuelId).revision;
}

function syncBaseRevision() {
  priceForm.baseRevision = selectedFuelRevision(priceForm.fuelId);
}

function submitPrice() {
  store.acceptPrice({
    fuelId: priceForm.fuelId,
    priceCents: toCents(priceForm.price),
    effectiveAt: fromLocalInput(priceForm.effectiveAt),
    terminalId: priceForm.terminalId,
    operator: priceForm.operator,
    requestId: uid("req"),
    baseRevisionOverride: Number(priceForm.baseRevision),
    reason: priceForm.note || undefined
  });
  priceForm.baseRevision = selectedFuelRevision(priceForm.fuelId);
}

function submitBatch() {
  store.submitDraftBatch({
    terminalId: batchForm.terminalId,
    operator: batchForm.operator,
    effectiveAt: fromLocalInput(batchForm.effectiveAt),
    note: batchForm.note,
    items: batchForm.rows,
    failAtIndex: batchForm.failAtIndex
  });
}

function retryBatch(batch: PriceBatch) {
  store.commitBatch(batch.id);
}

function resolveConflict(version: PriceVersion) {
  store.rebaseConflict(version.id);
}

const conflictDrafts = computed(() =>
  state.versions
    .filter((version) => version.status === "conflict-draft")
    .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
);

const sortedVersions = computed(() =>
  state.fuels.map((fuel) => ({
    fuel,
    current: store.currentVersion(fuel.id),
    versions: state.versions
      .filter((version) => version.fuelId === fuel.id)
      .sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt) || b.revision - a.revision)
  }))
);

const failedBatches = computed(() => state.batches.filter((batch) => batch.status === "failed").length);
const pendingPackages = computed(() =>
  state.packages.filter((pkg) => pkg.status !== "confirmed").length
);
const metrics = computed(() => [
  { label: "当前有效均价", value: `¥${priceYuan(store.averagePrice())}`, hint: "未确认交接价不参与" },
  { label: "待站长处理", value: store.unresolvedConflictCount(), hint: "价格草稿 + 双端字段" },
  { label: "失败/待续批次", value: failedBatches.value, hint: "重试跳过已提交项" },
  { label: "未确认交接包", value: pendingPackages.value, hint: "价格变动会触发重算" }
]);

function batchResultText(batch: PriceBatch, itemId: string) {
  const result = batch.results[itemId];
  if (!result) return batch.simulateFailureItemId === itemId ? "模拟将失败" : "等待写入";
  if (result.status === "applied") return "已写入";
  if (result.status === "conflict") return "已转冲突";
  return "重复请求已跳过";
}

function fuelName(fuelId: string) {
  return state.fuels.find((fuel) => fuel.id === fuelId)?.name ?? fuelId;
}

function sideValue(packageId: string, itemId: string, side: Side, key: HandoverFieldKey) {
  const item = state.items.find((entry) => entry.id === itemId);
  return item?.sideValues[side]?.[key] ?? "";
}

function updateSide(
  packageId: string,
  itemId: string,
  side: Side,
  key: HandoverFieldKey,
  event: Event
) {
  const value = (event.target as HTMLInputElement).value;
  store.recordSideChange(packageId, itemId, side, key, value);
}

function chooseField(packageId: string, itemId: string, key: HandoverFieldKey, side: Side) {
  store.resolveField(packageId, itemId, key, side);
}

function confirmPackage(packageId: string) {
  try {
    store.confirmPackage(packageId);
  } catch (error) {
    window.alert(error instanceof Error ? error.message : "确认失败");
  }
}

function handoverDiff(value: string) {
  return toCents(value);
}

function eventTypeText(type: string) {
  return {
    price: "价格",
    batch: "批次",
    handover: "交接",
    conflict: "冲突",
    system: "系统"
  }[type] ?? type;
}
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">油品调价 · 离线并发一致性</p>
          <h1>价格、批次、交接与时间轴联动</h1>
          <p class="subtitle">
            每次提交携带油品修订号；同一生效时刻只保留一份有效价。旧窗口离线价进入冲突草稿，
            完整批次按 requestId 幂等续传；双端交接字段并列保存，站长确认后才进入均价。
          </p>
        </div>
        <div class="stack">
          <span class="tag">Vue 3</span>
          <span class="tag">乐观锁 r{{ state.fuels.map((fuel) => fuel.revision).join("/") }}</span>
          <span class="tag">localStorage 离线回放</span>
        </div>
      </header>

      <section class="metrics">
        <article v-for="metric in metrics" :key="metric.label" class="metric">
          <span>{{ metric.label }}</span>
          <strong>{{ metric.value }}</strong>
          <em>{{ metric.hint }}</em>
        </article>
      </section>

      <section class="workspace">
        <div class="column">
          <form class="panel" @submit.prevent="submitPrice">
            <h2>提交终端调价</h2>
            <p class="panel-note">改一下基线修订号即可模拟离线终端带着旧版本回连。</p>
            <div class="form-grid">
              <label>
                油品
                <select v-model="priceForm.fuelId" @change="syncBaseRevision">
                  <option v-for="fuel in state.fuels" :key="fuel.id" :value="fuel.id">{{ fuel.name }}</option>
                </select>
              </label>
              <label>
                挂牌价
                <input v-model="priceForm.price" type="number" step="0.01" min="0" required />
              </label>
              <label>
                生效时刻
                <input v-model="priceForm.effectiveAt" type="datetime-local" required />
              </label>
              <label>
                提交终端
                <select v-model="priceForm.terminalId">
                  <option value="A">A终端</option>
                  <option value="B">B终端</option>
                  <option value="station">站长端</option>
                </select>
              </label>
              <label>
                操作员
                <input v-model="priceForm.operator" required />
              </label>
              <label>
                客户端基线修订号
                <input v-model.number="priceForm.baseRevision" type="number" min="0" required />
              </label>
              <label class="wide">
                备注
                <textarea v-model="priceForm.note" placeholder="例如：早高峰前挂牌价调整" />
              </label>
            </div>
            <button type="submit" class="primary">带修订号提交</button>
          </form>

          <section class="panel">
            <h2>完整调价批次</h2>
            <p class="panel-note">先模拟第 2 项失败，再从原批次继续；第 1 项不会重复提交或重复计算差额。</p>
            <div class="batch-editor">
              <label>
                终端
                <select v-model="batchForm.terminalId">
                  <option value="A">A终端</option>
                  <option value="B">B终端</option>
                  <option value="station">站长端</option>
                </select>
              </label>
              <label>
                操作员
                <input v-model="batchForm.operator" />
              </label>
              <label class="wide">
                批次生效时刻
                <input v-model="batchForm.effectiveAt" type="datetime-local" />
              </label>
              <div v-for="(row, index) in batchForm.rows" :key="index" class="batch-row">
                <select v-model="row.fuelId">
                  <option v-for="fuel in state.fuels" :key="fuel.id" :value="fuel.id">{{ fuel.name }}</option>
                </select>
                <input v-model="row.price" type="number" step="0.01" placeholder="价格" />
              </div>
              <label>
                模拟第几项写入失败
                <select v-model.number="batchForm.failAtIndex">
                  <option :value="0">第1项</option>
                  <option :value="1">第2项</option>
                </select>
              </label>
              <label class="wide">
                批次备注
                <input v-model="batchForm.note" />
              </label>
            </div>
            <button type="button" class="primary" @click="submitBatch">提交批次并模拟中断</button>
          </section>
        </div>

        <div class="column">
          <section class="panel conflict-panel">
            <div class="section-head">
              <h2>冲突草稿（{{ conflictDrafts.length }}）</h2>
              <span>晚到价不覆盖有效价</span>
            </div>
            <div v-if="conflictDrafts.length === 0" class="empty">当前没有待处理冲突</div>
            <article v-for="version in conflictDrafts" :key="version.id" class="conflict-card">
              <div>
                <strong>{{ fuelName(version.fuelId) }} ¥{{ priceYuan(version.priceCents) }}</strong>
                <p>{{ version.reason }}</p>
                <small>
                  原差额 {{ money(version.originalDiffCents) }} · {{ terminalText[version.terminalId] }} ·
                  r{{ version.baseRevision }} → 拟 r{{ version.revision }}
                </small>
              </div>
              <button
                type="button"
                class="secondary"
                :disabled="Boolean(version.resolvedByVersionId)"
                @click="resolveConflict(version)"
              >
                {{ version.resolvedByVersionId ? "已重提" : "按新基线采纳" }}
              </button>
            </article>
          </section>

          <section class="panel">
            <div class="section-head">
              <h2>价格时间轴</h2>
              <span>旧版本与原差额留痕</span>
            </div>
            <div v-for="group in sortedVersions" :key="group.fuel.id" class="timeline-fuel">
              <h3>
                {{ group.fuel.name }}
                <small>当前 r{{ group.current?.revision ?? "—" }} / ¥{{ group.current ? priceYuan(group.current.priceCents) : "—" }}</small>
              </h3>
              <div v-for="version in group.versions" :key="version.id" class="timeline-row">
                <div class="timeline-dot" :class="version.status"></div>
                <div class="timeline-content">
                  <div class="timeline-title">
                    <strong>¥{{ priceYuan(version.priceCents) }}</strong>
                    <span class="badge" :class="version.status">{{ statusText[version.status] }}</span>
                    <span v-if="group.current?.id === version.id" class="badge current">当前取价</span>
                    <span>r{{ version.revision }}</span>
                  </div>
                  <p>
                    生效 {{ formatDateTime(version.effectiveAt) }} · 提交 {{ formatDateTime(version.submittedAt) }} ·
                    {{ terminalText[version.terminalId] }} / {{ version.operator }}
                  </p>
                  <p>
                    当前差额 <b>{{ money(store.currentDiff(version)) }}</b>
                    <span class="muted">；提交时原差额 {{ money(version.originalDiffCents) }}</span>
                  </p>
                  <p v-if="version.batchId" class="muted">批次：{{ version.batchId }}</p>
                  <p v-if="version.handoverPackageId" class="muted">来源：站长确认的交接包 {{ version.handoverPackageId }}</p>
                  <p v-if="version.reason" class="reason">{{ version.reason }}</p>
                </div>
              </div>
            </div>
          </section>
        </div>
      </section>

      <section class="panel handover-panel">
        <div class="section-head">
          <h2>班次交接离线合并</h2>
          <span>双端改过的字段并列保留；未确认前不进入均价</span>
        </div>

        <div v-for="pkg in state.packages" :key="pkg.id" class="package-card">
          <div class="package-head">
            <div>
              <h3>{{ pkg.shiftName }}</h3>
              <p>{{ pkg.terminalA }} ↔ {{ pkg.terminalB }} · 创建 {{ formatDateTime(pkg.createdAt) }}</p>
            </div>
            <div class="package-actions">
              <button type="button" class="secondary" :disabled="pkg.status === 'confirmed'" @click="store.simulateOfflineEdits(pkg.id)">
                模拟双端离线改动
              </button>
              <button type="button" class="secondary" :disabled="pkg.status === 'confirmed'" @click="store.mergePackage(pkg.id)">
                离线合并
              </button>
              <button type="button" class="primary" :disabled="pkg.status === 'confirmed'" @click="confirmPackage(pkg.id)">
                站长确认并入均价
              </button>
            </div>
          </div>

          <div v-for="item in store.currentPackageItems(pkg)" :key="item.id" class="handover-item">
            <div class="item-title">
              <strong>{{ item.label }}</strong>
              <span class="badge" :class="item.status">{{ handoverStatusText[item.status] }}</span>
              <span class="gen">第 {{ item.gen }} 代</span>
              <span>基线 ¥{{ priceYuan(item.baselinePriceCents) }}</span>
            </div>

            <div class="field-table">
              <div class="field-row field-head-row">
                <span>字段</span><span>共同基线</span><span>A端</span><span>B端</span><span>并列结果 / 站长裁决</span>
              </div>
              <div
                v-for="field in HANDOVER_FIELDS"
                :key="field.key"
                class="field-row"
                :class="{ conflict: store.fieldMerge(item, field.key).unresolved }"
              >
                <span>{{ field.label }}</span>
                <span>{{ store.fieldMerge(item, field.key).base || "空" }}</span>
                <span>
                  <input
                    :value="sideValue(pkg.id, item.id, 'A', field.key)"
                    :disabled="pkg.status === 'confirmed'"
                    @change="updateSide(pkg.id, item.id, 'A', field.key, $event)"
                  />
                  <small v-if="field.price && store.fieldMerge(item, field.key).a !== undefined">
                    差 {{ money(handoverDiff(store.fieldMerge(item, field.key).a ?? '') - item.baselinePriceCents) }}
                  </small>
                </span>
                <span>
                  <input
                    :value="sideValue(pkg.id, item.id, 'B', field.key)"
                    :disabled="pkg.status === 'confirmed'"
                    @change="updateSide(pkg.id, item.id, 'B', field.key, $event)"
                  />
                  <small v-if="field.price && store.fieldMerge(item, field.key).b !== undefined">
                    差 {{ money(handoverDiff(store.fieldMerge(item, field.key).b ?? '') - item.baselinePriceCents) }}
                  </small>
                </span>
                <span class="resolution">
                  <b>{{ store.fieldMerge(item, field.key).value || "空" }}</b>
                  <template v-if="store.fieldMerge(item, field.key).conflict">
                    <button
                      type="button"
                      :class="['tiny', item.resolution[field.key]?.side === 'A' ? 'primary' : 'secondary']"
                      :disabled="pkg.status === 'confirmed'"
                      @click="chooseField(pkg.id, item.id, field.key, 'A')"
                    >取A</button>
                    <button
                      type="button"
                      :class="['tiny', item.resolution[field.key]?.side === 'B' ? 'primary' : 'secondary']"
                      :disabled="pkg.status === 'confirmed'"
                      @click="chooseField(pkg.id, item.id, field.key, 'B')"
                    >取B</button>
                  </template>
                  <small v-else-if="store.fieldMerge(item, field.key).aChanged || store.fieldMerge(item, field.key).bChanged">
                    单端改动，自动并列
                  </small>
                </span>
              </div>
            </div>
          </div>

          <details class="history-details">
            <summary>查看交接代际、作废原因与原始差额</summary>
            <div v-for="historyItem in state.items.filter((entry) => entry.packageId === pkg.id)" :key="historyItem.id" class="history-item">
              <strong>{{ historyItem.label }} · 第{{ historyItem.gen }}代 · {{ handoverStatusText[historyItem.status] }}</strong>
              <p>
                基线 ¥{{ priceYuan(historyItem.baselinePriceCents) }}；
                A报价 {{ historyItem.sideValues.A?.observedPrice ?? "未改" }}，
                B报价 {{ historyItem.sideValues.B?.observedPrice ?? "未改" }}
              </p>
              <p v-if="historyItem.recalculatedFromItemId">由 {{ historyItem.recalculatedFromItemId }} 在价格变动后重算</p>
              <p v-if="historyItem.invalidatedByVersionId">
                旧条目被 {{ historyItem.invalidatedByVersionId }} 作废，作废时间 {{ formatDateTime(historyItem.invalidatedAt ?? '') }}
              </p>
              <p v-if="historyItem.confirmedVersionId">确认形成价格版本：{{ historyItem.confirmedVersionId }}</p>
            </div>
          </details>
        </div>
      </section>

      <section class="workspace bottom-grid">
        <section class="panel">
          <h2>批次续传记录</h2>
          <article v-for="batch in state.batches" :key="batch.id" class="batch-record" :class="batch.status">
            <div class="batch-record-head">
              <strong>{{ batch.note }}</strong>
              <span class="badge" :class="batch.status">{{ batch.status === "committed" ? "已完成" : "失败待续" }}</span>
            </div>
            <p>{{ terminalText[batch.terminalId] }} / {{ batch.operator }} · {{ formatDateTime(batch.effectiveAt) }}</p>
            <ul>
              <li v-for="item in batch.items" :key="item.id">
                {{ fuelName(item.fuelId) }} ¥{{ priceYuan(item.priceCents) }} — {{ batchResultText(batch, item.id) }}
              </li>
            </ul>
            <p v-if="batch.lastError" class="reason">{{ batch.lastError }}</p>
            <button v-if="batch.status === 'failed'" type="button" class="primary" @click="retryBatch(batch)">
              从完整批次继续
            </button>
          </article>
        </section>

        <section class="panel">
          <h2>一致性事件流水</h2>
          <div class="event-list">
            <article v-for="event in state.events" :key="event.id" class="event">
              <span class="event-type" :class="event.type">{{ eventTypeText(event.type) }}</span>
              <div>
                <p>{{ event.message }}</p>
                <small>{{ formatDateTime(event.at) }}</small>
              </div>
            </article>
          </div>
        </section>
      </section>
    </div>
  </main>
</template>
