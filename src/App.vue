<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { FUELS, SHIFTS, fmtDiff, usePriceStore, type BatchItem } from "./store";

const store = usePriceStore();

const tabs = ["调价批次", "价格时间轴", "冲突草稿", "班次交接", "历史差额"] as const;
const activeTab = ref<(typeof tabs)[number]>("调价批次");

function uid() {
  return crypto.randomUUID();
}

function fmtTime(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function short(id: string) {
  return id.slice(0, 8);
}

// ---------- 调价批次表单 ----------

const OPERATORS = ["站长", "值班经理", "收银员"];

const itemForm = reactive({
  fuel: FUELS[0] as string,
  price: 7.62,
  effectiveAt: toLocalInput(new Date()),
  operator: OPERATORS[0] as string
});
const batchNote = ref("");
const armFail = ref(false);
const batchId = ref(uid());
const draftItems = ref<BatchItem[]>([]);

/** 提交带修订号：同一批次内同一油品的条目依次递增 */
function nextRevision(fuel: string) {
  return store.headRevision(fuel) + draftItems.value.filter((i) => i.fuel === fuel).length + 1;
}

function addItem() {
  draftItems.value.push({
    key: uid(),
    fuel: itemForm.fuel,
    price: Number(itemForm.price),
    effectiveAt: new Date(itemForm.effectiveAt).toISOString(),
    revision: nextRevision(itemForm.fuel)
  });
}

function removeItem(key: string) {
  draftItems.value = draftItems.value.filter((i) => i.key !== key);
}

function submitBatch() {
  if (draftItems.value.length === 0) return;
  const batch = store.submitBatch({
    id: batchId.value,
    operator: itemForm.operator,
    note: batchNote.value,
    items: draftItems.value,
    armFail: armFail.value
  });
  armFail.value = false;
  if (batch.status === "committed") {
    // 已完成的批次更换幂等号；未完成的保留原号，再次提交即断点续传
    batchId.value = uid();
    draftItems.value = [];
    batchNote.value = "";
  }
}

const batchStatusText: Record<string, string> = {
  pending: "写入中",
  partial: "写入中断",
  committed: "已提交"
};

// ---------- 价格时间轴 ----------

const timelineFuel = ref<string>(FUELS[0]);
const timeline = computed(() => store.timelineOf(timelineFuel.value));

// ---------- 班次交接表单 ----------

const handoverForm = reactive({
  shift: SHIFTS[0] as string,
  fuel: FUELS[0] as string,
  localVolume: 0,
  localAmount: 0,
  localPrice: 7.62,
  remoteVolume: 0,
  remoteAmount: 0,
  remotePrice: 7.62
});

function mergeHandover() {
  store.mergeHandover({
    shift: handoverForm.shift,
    fuel: handoverForm.fuel,
    local: [Number(handoverForm.localVolume), Number(handoverForm.localAmount), Number(handoverForm.localPrice)],
    remote: [Number(handoverForm.remoteVolume), Number(handoverForm.remoteAmount), Number(handoverForm.remotePrice)]
  });
}

const handoverStatusText: Record<string, string> = {
  pending: "待站长确认",
  confirmed: "已确认",
  invalidated: "已失效重算",
  discarded: "已丢弃"
};

const visibleHandovers = computed(() => store.handovers.filter((h) => h.status !== "discarded"));

// ---------- 指标 ----------

const metrics = computed(() => [
  { label: "生效均价（元/升）", value: store.averagePrice.toFixed(2) },
  { label: "生效油品", value: store.effectiveVersions.length },
  { label: "待确认交接", value: store.pendingHandovers.length },
  { label: "冲突草稿", value: store.pendingConflicts.length }
]);
</script>

<template>
  <main class="app">
    <div class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">石油行业 · 多终端协同调价</p>
          <h1>油品价格维护</h1>
          <p class="subtitle">
            调价批次带修订号提交，同一生效时刻只留一份有效价；旧窗口改动转冲突草稿；换班包离线合并、双改字段并列保留，站长确认前不进入均价；写入失败断点续传，重试不重复算差额。
          </p>
        </div>
      </header>

      <section class="metrics">
        <article v-for="m in metrics" :key="m.label" class="metric">
          <span>{{ m.label }}</span>
          <strong>{{ m.value }}</strong>
        </article>
      </section>

      <nav class="tabs">
        <button
          v-for="tab in tabs"
          :key="tab"
          type="button"
          class="tab"
          :class="{ active: activeTab === tab }"
          @click="activeTab = tab"
        >
          {{ tab }}
          <em v-if="tab === '冲突草稿' && store.pendingConflicts.length">{{ store.pendingConflicts.length }}</em>
          <em v-else-if="tab === '班次交接' && store.pendingHandovers.length">{{ store.pendingHandovers.length }}</em>
        </button>
      </nav>

      <!-- 调价批次 -->
      <section v-if="activeTab === '调价批次'" class="workspace">
        <form class="panel" @submit.prevent="addItem">
          <h2>加入调价批次</h2>
          <div class="form-grid">
            <label>
              油品
              <select v-model="itemForm.fuel">
                <option v-for="f in FUELS" :key="f">{{ f }}</option>
              </select>
            </label>
            <label>
              挂牌价（元/升）
              <input v-model="itemForm.price" type="number" step="0.01" min="0" required />
            </label>
            <label>
              生效时刻
              <input v-model="itemForm.effectiveAt" type="datetime-local" required />
            </label>
            <label>
              操作员
              <select v-model="itemForm.operator">
                <option v-for="o in OPERATORS" :key="o">{{ o }}</option>
              </select>
            </label>
            <p class="hint">修订号：r{{ nextRevision(itemForm.fuel) }}（基于当前最新版本 +1）</p>
            <button type="submit" class="secondary">加入批次</button>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar">
            <h2>当前批次（幂等号 {{ short(batchId) }}）</h2>
          </div>
          <div class="record-grid">
            <div v-if="draftItems.length === 0" class="empty">批次为空，请先从左侧加入调价条目</div>
            <article v-for="item in draftItems" :key="item.key" class="record">
              <div class="record-head">
                <p class="record-title">{{ item.fuel }} / {{ item.price.toFixed(2) }} 元</p>
                <span class="status">r{{ item.revision }}</span>
              </div>
              <div class="details">
                <span>生效时刻：{{ fmtTime(item.effectiveAt) }}</span>
                <span>操作员：{{ itemForm.operator }}</span>
              </div>
              <div class="actions">
                <button class="danger" type="button" @click="removeItem(item.key)">移出批次</button>
              </div>
            </article>
          </div>
          <div class="submit-row">
            <input v-model="batchNote" placeholder="批次备注，如：跟涨/促销" />
            <label class="inline">
              <input v-model="armFail" type="checkbox" /> 模拟写入中断
            </label>
            <button type="button" :disabled="draftItems.length === 0" @click="submitBatch">提交批次</button>
          </div>

          <h2 class="section-title">批次记录</h2>
          <div class="record-grid">
            <div v-if="store.batches.length === 0" class="empty">暂无批次</div>
            <article v-for="batch in store.batches" :key="batch.id" class="record">
              <div class="record-head">
                <p class="record-title">批次 {{ short(batch.id) }}</p>
                <span class="status" :class="batch.status">{{ batchStatusText[batch.status] }}</span>
              </div>
              <div class="details">
                <span>条目：{{ batch.appliedKeys.length }}/{{ batch.items.length }} 已写入</span>
                <span>操作员：{{ batch.operator }}</span>
                <span>提交时间：{{ fmtTime(batch.createdAt) }}</span>
                <span>备注：{{ batch.note || "—" }}</span>
              </div>
              <div class="actions">
                <button v-if="batch.status !== 'committed'" type="button" @click="store.retryBatch(batch.id)">
                  重试（从完整批次继续）
                </button>
              </div>
            </article>
          </div>
        </section>
      </section>

      <!-- 价格时间轴 -->
      <section v-else-if="activeTab === '价格时间轴'" class="list-panel">
        <div class="toolbar">
          <h2>价格时间轴</h2>
          <select v-model="timelineFuel" class="narrow">
            <option v-for="f in FUELS" :key="f">{{ f }}</option>
          </select>
        </div>
        <div class="timeline">
          <article v-for="v in timeline" :key="v.id" class="t-item" :class="v.status">
            <div class="t-dot" />
            <div class="t-body">
              <div class="record-head">
                <p class="record-title">
                  {{ v.price.toFixed(2) }} 元/升
                  <span class="rev">r{{ v.revision }}</span>
                </p>
                <span class="status" :class="v.status">{{ v.status === "effective" ? "生效中" : "已更替" }}</span>
              </div>
              <div class="details">
                <span>生效时刻：{{ fmtTime(v.effectiveAt) }}</span>
                <span>
                  原始差额：
                  <b class="diff" :class="v.diffFromPrev > 0 ? 'up' : v.diffFromPrev < 0 ? 'down' : 'flat'">
                    {{ fmtDiff(v.diffFromPrev) }}
                  </b>
                </span>
                <span>操作员：{{ v.operator }}</span>
                <span>批次：{{ short(v.batchId) }}</span>
              </div>
              <p class="note">{{ v.note }}</p>
            </div>
          </article>
        </div>
      </section>

      <!-- 冲突草稿 -->
      <section v-else-if="activeTab === '冲突草稿'" class="list-panel">
        <div class="toolbar"><h2>冲突草稿</h2></div>
        <div class="record-grid">
          <div v-if="store.conflicts.length === 0" class="empty">暂无冲突：晚到价、旧窗口改动会转入这里</div>
          <article v-for="c in store.conflicts" :key="c.id" class="record" :class="{ muted: c.status === 'resolved' }">
            <div class="record-head">
              <p class="record-title">{{ c.fuel }} / {{ c.price.toFixed(2) }} 元</p>
              <span class="status" :class="c.status === 'pending' ? 'pending' : 'superseded'">
                {{ c.status === "pending" ? "待处理" : "已处理" }}
              </span>
            </div>
            <div class="details">
              <span>草稿修订号：r{{ c.revision }}</span>
              <span>当前生效价：{{ c.currentPrice.toFixed(2) }} 元</span>
              <span>生效时刻：{{ fmtTime(c.effectiveAt) }}</span>
              <span>来源批次：{{ short(c.batchId) }}</span>
            </div>
            <p class="note">{{ c.reason }}</p>
            <div v-if="c.status === 'pending'" class="actions">
              <button type="button" @click="store.resolveConflict(c.id, 'resubmit')">按最新修订号重新提交</button>
              <button class="danger" type="button" @click="store.resolveConflict(c.id, 'discard')">丢弃</button>
            </div>
          </article>
        </div>
      </section>

      <!-- 班次交接 -->
      <section v-else-if="activeTab === '班次交接'" class="workspace">
        <form class="panel" @submit.prevent="mergeHandover">
          <h2>合并离线交接包</h2>
          <div class="form-grid">
            <label>
              班次
              <select v-model="handoverForm.shift">
                <option v-for="s in SHIFTS" :key="s">{{ s }}</option>
              </select>
            </label>
            <label>
              油品
              <select v-model="handoverForm.fuel">
                <option v-for="f in FUELS" :key="f">{{ f }}</option>
              </select>
            </label>
            <div class="side-grid">
              <fieldset>
                <legend>本班记录</legend>
                <label>销售量（升）<input v-model="handoverForm.localVolume" type="number" min="0" /></label>
                <label>销售额（元）<input v-model="handoverForm.localAmount" type="number" min="0" /></label>
                <label>拟调价（元/升）<input v-model="handoverForm.localPrice" type="number" step="0.01" min="0" /></label>
              </fieldset>
              <fieldset>
                <legend>交班离线包</legend>
                <label>销售量（升）<input v-model="handoverForm.remoteVolume" type="number" min="0" /></label>
                <label>销售额（元）<input v-model="handoverForm.remoteAmount" type="number" min="0" /></label>
                <label>拟调价（元/升）<input v-model="handoverForm.remotePrice" type="number" step="0.01" min="0" /></label>
              </fieldset>
            </div>
            <button type="submit">离线合并</button>
          </div>
        </form>

        <section class="list-panel">
          <div class="toolbar"><h2>交接项（确认前不进入均价）</h2></div>
          <div class="record-grid">
            <div v-if="visibleHandovers.length === 0" class="empty">暂无交接项</div>
            <article v-for="h in visibleHandovers" :key="h.id" class="record">
              <div class="record-head">
                <p class="record-title">{{ h.shift }} · {{ h.fuel }}</p>
                <span class="status" :class="h.status">{{ handoverStatusText[h.status] }}</span>
              </div>
              <table class="kv">
                <thead>
                  <tr><th>字段</th><th>基准</th><th>本班</th><th>交班包</th><th>确认值</th></tr>
                </thead>
                <tbody>
                  <tr v-for="f in h.fields" :key="f.name" :class="{ both: f.bothChanged }">
                    <td>{{ f.name }}</td>
                    <td>{{ f.base }}</td>
                    <td>{{ f.local }}</td>
                    <td>{{ f.remote }}</td>
                    <td>{{ f.confirmed ?? "待确认" }}</td>
                  </tr>
                </tbody>
              </table>
              <p class="note">
                拟调价差额：
                <b class="diff" :class="h.priceDiffAtMerge > 0 ? 'up' : h.priceDiffAtMerge < 0 ? 'down' : 'flat'">
                  {{ fmtDiff(h.priceDiffAtMerge) }}
                </b>
                <template v-if="h.invalidatedReason">　{{ h.invalidatedReason }}</template>
              </p>
              <div v-if="h.status === 'pending' || h.status === 'invalidated'" class="actions">
                <button type="button" @click="store.confirmHandover(h.id, 'local')">确认（采用本班）</button>
                <button class="secondary" type="button" @click="store.confirmHandover(h.id, 'remote')">确认（采用交班包）</button>
                <button class="danger" type="button" @click="store.discardHandover(h.id)">丢弃</button>
              </div>
            </article>
          </div>
        </section>
      </section>

      <!-- 历史差额 -->
      <section v-else class="list-panel">
        <div class="toolbar"><h2>历史与差额审计</h2></div>
        <div class="record-grid">
          <div v-if="store.audit.length === 0" class="empty">暂无审计记录</div>
          <article v-for="e in store.audit" :key="e.id" class="record">
            <div class="record-head">
              <p class="record-title">{{ e.summary }}</p>
              <span class="status neutral">{{ e.kind }}</span>
            </div>
            <div class="details">
              <span>{{ fmtTime(e.at) }}</span>
            </div>
            <p v-if="e.detail" class="note">{{ e.detail }}</p>
          </article>
        </div>
      </section>
    </div>
  </main>
</template>
