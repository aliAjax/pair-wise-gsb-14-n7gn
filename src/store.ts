import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

export const FUELS = ["92号汽油", "95号汽油", "98号汽油", "柴油"] as const;
export const SHIFTS = ["早班", "中班", "晚班"] as const;

export type VersionStatus = "effective" | "superseded";
export type BatchStatus = "pending" | "partial" | "committed";
export type HandoverStatus = "pending" | "confirmed" | "invalidated" | "discarded";

/** 价格版本：不可变历史，同一油品同一生效时刻只留一份有效价 */
export interface PriceVersion {
  id: string;
  fuel: string;
  price: number;
  effectiveAt: string; // ISO 生效时刻
  revision: number; // 每油品单调递增修订号
  batchId: string;
  operator: string;
  status: VersionStatus;
  diffFromPrev: number; // 提交时算定的原始差额，永久可查
  note: string;
  createdAt: string;
}

/** 批次条目：key 为幂等键，重试时跳过已写入条目，不重复算差额 */
export interface BatchItem {
  key: string;
  fuel: string;
  price: number;
  effectiveAt: string;
  revision: number; // 提交方基于的修订号（head + 1）
}

export interface Batch {
  id: string; // 客户端幂等批次号，重复提交不重复落库
  operator: string;
  note: string;
  items: BatchItem[];
  appliedKeys: string[]; // 已落库条目，失败续传/重试时跳过
  status: BatchStatus;
  createdAt: string;
}

/** 冲突草稿：修订号过期 / 生效时刻撞车 / 旧窗口改动 */
export interface ConflictDraft {
  id: string;
  fuel: string;
  price: number;
  effectiveAt: string;
  revision: number;
  batchId: string;
  operator: string;
  reason: string;
  currentPrice: number; // 冲突时的生效价
  status: "pending" | "resolved";
  createdAt: string;
}

/** 交接字段：基准值 + 本班改动 + 交班包改动，两边都改的并列保留 */
export interface HandoverField {
  name: string;
  base: number;
  local: number;
  remote: number;
  bothChanged: boolean;
  confirmed?: number;
}

export interface HandoverItem {
  id: string;
  shift: string;
  fuel: string;
  fields: HandoverField[];
  status: HandoverStatus;
  priceDiffAtMerge: number; // 合并时拟调价相对生效价的差额
  invalidatedReason?: string;
  createdAt: string;
}

/** 审计事件：旧版本、原差额、批次重试等均可查 */
export interface AuditEvent {
  id: string;
  at: string;
  kind: string;
  summary: string;
  detail: string;
}

const STORAGE_KEY = "dfwlfront-9-price-v2";

function uid() {
  return crypto.randomUUID();
}

function nowIso() {
  return new Date().toISOString();
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

export function fmtDiff(diff: number) {
  return `${diff > 0 ? "+" : ""}${diff.toFixed(2)}`;
}

interface PersistedState {
  versions: PriceVersion[];
  batches: Batch[];
  conflicts: ConflictDraft[];
  handovers: HandoverItem[];
  audit: AuditEvent[];
}

function seedState(): PersistedState {
  const day = 86400000;
  const at = (daysAgo: number, hour: number) => {
    const d = new Date(Date.now() - daysAgo * day);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const seed = (
    fuel: string,
    price: number,
    revision: number,
    effectiveAt: string,
    status: VersionStatus,
    diffFromPrev: number,
    note: string
  ): PriceVersion => ({
    id: uid(),
    fuel,
    price,
    effectiveAt,
    revision,
    batchId: "seed",
    operator: "站长",
    status,
    diffFromPrev,
    note,
    createdAt: effectiveAt
  });
  return {
    versions: [
      seed("92号汽油", 7.55, 1, at(2, 6), "superseded", 0, "月初定价"),
      seed("92号汽油", 7.62, 2, at(1, 6), "effective", 0.07, "跟涨"),
      seed("95号汽油", 8.14, 1, at(1, 6), "effective", 0, "月初定价"),
      seed("98号汽油", 8.86, 1, at(1, 6), "effective", 0, "月初定价"),
      seed("柴油", 7.18, 1, at(1, 6), "effective", 0, "月初定价")
    ],
    batches: [],
    conflicts: [],
    handovers: [],
    audit: [
      {
        id: uid(),
        at: nowIso(),
        kind: "初始化",
        summary: "载入示例价格版本",
        detail: "92号汽油 r1→r2 历史已保留，原始差额 +0.07 可查"
      }
    ]
  };
}

function loadState(): PersistedState {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return seedState();
  try {
    return JSON.parse(raw) as PersistedState;
  } catch {
    return seedState();
  }
}

export const usePriceStore = defineStore("price", () => {
  const state = loadState();
  const versions = ref<PriceVersion[]>(state.versions);
  const batches = ref<Batch[]>(state.batches);
  const conflicts = ref<ConflictDraft[]>(state.conflicts);
  const handovers = ref<HandoverItem[]>(state.handovers);
  const audit = ref<AuditEvent[]>(state.audit);

  /** 演示用：下一次批次写入在中途失败，用于验证断点续传 */
  const failArmed = ref(false);

  watch(
    [versions, batches, conflicts, handovers, audit],
    () => {
      const snapshot: PersistedState = {
        versions: versions.value,
        batches: batches.value,
        conflicts: conflicts.value,
        handovers: handovers.value,
        audit: audit.value.slice(0, 200)
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    },
    { deep: true }
  );

  function log(kind: string, summary: string, detail = "") {
    audit.value.unshift({ id: uid(), at: nowIso(), kind, summary, detail });
  }

  // ---------- 查询 ----------

  function headRevision(fuel: string) {
    return versions.value
      .filter((v) => v.fuel === fuel)
      .reduce((max, v) => Math.max(max, v.revision), 0);
  }

  function effectiveOf(fuel: string) {
    return versions.value.find((v) => v.fuel === fuel && v.status === "effective");
  }

  function timelineOf(fuel: string) {
    return versions.value
      .filter((v) => v.fuel === fuel)
      .slice()
      .sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt));
  }

  const effectiveVersions = computed(() => versions.value.filter((v) => v.status === "effective"));

  /** 均价只统计生效价；待确认交接项的拟调价不进入均价 */
  const averagePrice = computed(() => {
    if (effectiveVersions.value.length === 0) return 0;
    const sum = effectiveVersions.value.reduce((acc, v) => acc + v.price, 0);
    return round2(sum / effectiveVersions.value.length);
  });

  const pendingHandovers = computed(() => handovers.value.filter((h) => h.status === "pending"));
  const pendingConflicts = computed(() => conflicts.value.filter((c) => c.status === "pending"));

  // ---------- 调价批次 ----------

  function conflictFromItem(batch: Batch, item: BatchItem, reason: string) {
    const current = effectiveOf(item.fuel);
    conflicts.value.unshift({
      id: uid(),
      fuel: item.fuel,
      price: item.price,
      effectiveAt: item.effectiveAt,
      revision: item.revision,
      batchId: batch.id,
      operator: batch.operator,
      reason,
      currentPrice: current?.price ?? 0,
      status: "pending",
      createdAt: nowIso()
    });
    log("冲突草稿", `${item.fuel} 调价 ${item.price.toFixed(2)} 元转入冲突草稿`, reason);
  }

  function commitItem(batch: Batch, item: BatchItem) {
    const prev = effectiveOf(item.fuel);
    const diff = prev ? round2(item.price - prev.price) : 0;
    if (prev) {
      prev.status = "superseded";
      log(
        "版本更替",
        `${item.fuel} r${prev.revision}（${prev.price.toFixed(2)} 元）转入历史`,
        `原差额 ${fmtDiff(prev.diffFromPrev)} 保留可查，新版本 r${item.revision} 差额 ${fmtDiff(diff)}`
      );
    }
    versions.value.push({
      id: uid(),
      fuel: item.fuel,
      price: item.price,
      effectiveAt: item.effectiveAt,
      revision: item.revision,
      batchId: batch.id,
      operator: batch.operator,
      status: "effective",
      diffFromPrev: diff,
      note: batch.note || "正常调价",
      createdAt: nowIso()
    });
    invalidateHandovers(item.fuel, item.price);
    log(
      "调价生效",
      `${item.fuel} r${item.revision} 生效价 ${item.price.toFixed(2)} 元（差额 ${fmtDiff(diff)}）`,
      `批次 ${batch.id.slice(0, 8)} · ${batch.operator}`
    );
  }

  function applyItem(batch: Batch, item: BatchItem) {
    const head = headRevision(item.fuel);
    const current = effectiveOf(item.fuel);
    if (item.revision !== head + 1) {
      // 晚到的草稿：回连时生效版本已前进，旧修订号不允许覆盖
      conflictFromItem(batch, item, `修订号过期：草稿基于 r${item.revision}，当前已到 r${head}，晚到价不得覆盖生效版本`);
      return;
    }
    const clash = versions.value.find((v) => v.fuel === item.fuel && v.effectiveAt === item.effectiveAt);
    if (clash) {
      conflictFromItem(
        batch,
        item,
        `生效时刻撞车：该时刻已存在 r${clash.revision}（${clash.price.toFixed(2)} 元），同一生效时刻只留一份有效价`
      );
      return;
    }
    if (current && item.effectiveAt <= current.effectiveAt) {
      conflictFromItem(batch, item, `旧窗口改动：生效时刻早于当前生效价 r${current.revision} 的窗口，转入冲突草稿复核`);
      return;
    }
    commitItem(batch, item);
  }

  function applyBatch(batch: Batch) {
    let appliedThisRun = 0;
    for (const item of batch.items) {
      if (batch.appliedKeys.includes(item.key)) continue; // 幂等：已写入的条目不重复算差额
      if (failArmed.value && (appliedThisRun >= 1 || batch.items.length === 1)) {
        failArmed.value = false;
        batch.status = "partial";
        log(
          "写入失败",
          `批次 ${batch.id.slice(0, 8)} 在 ${batch.appliedKeys.length}/${batch.items.length} 条处中断`,
          "已写入条目保留幂等键，重试从完整批次继续且不重复算差额"
        );
        return;
      }
      applyItem(batch, item);
      batch.appliedKeys.push(item.key);
      appliedThisRun += 1;
    }
    batch.status = "committed";
  }

  function submitBatch(input: { id?: string; operator: string; note: string; items: BatchItem[]; armFail?: boolean }) {
    if (input.armFail) failArmed.value = true;
    const existing = batches.value.find((b) => b.id === input.id);
    if (existing) {
      // 同一批次号重复提交：幂等续传，不重复落库
      log("幂等去重", `批次 ${existing.id.slice(0, 8)} 已存在，继续未完成写入`);
      applyBatch(existing);
      return existing;
    }
    const batch: Batch = {
      id: input.id ?? uid(),
      operator: input.operator,
      note: input.note,
      items: input.items,
      appliedKeys: [],
      status: "pending",
      createdAt: nowIso()
    };
    batches.value.unshift(batch);
    log("批次提交", `批次 ${batch.id.slice(0, 8)} 提交 ${batch.items.length} 条调价`, `操作员 ${batch.operator}`);
    applyBatch(batch);
    return batch;
  }

  function retryBatch(id: string) {
    const batch = batches.value.find((b) => b.id === id);
    if (!batch || batch.status === "committed") return;
    log(
      "批次重试",
      `批次 ${id.slice(0, 8)} 从完整批次继续，已写入 ${batch.appliedKeys.length} 条跳过`,
      "重试不重复算差额"
    );
    applyBatch(batch);
  }

  // ---------- 冲突草稿 ----------

  function resolveConflict(id: string, action: "resubmit" | "discard") {
    const draft = conflicts.value.find((c) => c.id === id);
    if (!draft || draft.status !== "pending") return;
    draft.status = "resolved";
    if (action === "discard") {
      log("冲突处理", `${draft.fuel} 冲突草稿已丢弃`, draft.reason);
      return;
    }
    // 重新提交：取最新修订号，生效时刻改为当前时间，避免再次撞车
    submitBatch({
      operator: draft.operator,
      note: `冲突草稿重提（原批次 ${draft.batchId.slice(0, 8)}）`,
      items: [
        {
          key: uid(),
          fuel: draft.fuel,
          price: draft.price,
          effectiveAt: nowIso(),
          revision: headRevision(draft.fuel) + 1
        }
      ]
    });
    log("冲突处理", `${draft.fuel} 冲突草稿按最新修订号重新提交`, draft.reason);
  }

  // ---------- 班次交接 ----------

  const HANDOVER_FIELDS = ["销售量", "销售额", "拟调价"] as const;

  function mergeHandover(input: {
    shift: string;
    fuel: string;
    local: [number, number, number];
    remote: [number, number, number];
  }) {
    const current = effectiveOf(input.fuel);
    const baseValues: Record<string, number> = {
      销售量: 0,
      销售额: 0,
      拟调价: current?.price ?? 0
    };
    const fields: HandoverField[] = HANDOVER_FIELDS.map((name, index) => {
      const base = baseValues[name];
      const local = input.local[index];
      const remote = input.remote[index];
      const bothChanged = local !== base && remote !== base && local !== remote;
      return {
        name,
        base,
        local,
        remote,
        bothChanged,
        // 单边改动自动取值；两边都改的并列保留，等站长确认
        confirmed: bothChanged ? undefined : local !== base ? local : remote
      };
    });
    const item: HandoverItem = {
      id: uid(),
      shift: input.shift,
      fuel: input.fuel,
      fields,
      status: "pending",
      priceDiffAtMerge: round2(input.remote[2] - (current?.price ?? 0)),
      createdAt: nowIso()
    };
    handovers.value.unshift(item);
    const both = fields.filter((f) => f.bothChanged).map((f) => f.name);
    log(
      "交接合并",
      `${input.shift} · ${input.fuel} 离线交接包已合并`,
      both.length > 0
        ? `两边都改过的字段并列保留：${both.join("、")}；站长确认前不进入均价`
        : "无双改字段，待站长确认"
    );
  }

  function confirmHandover(id: string, side: "local" | "remote") {
    const item = handovers.value.find((h) => h.id === id);
    if (!item || (item.status !== "pending" && item.status !== "invalidated")) return;
    for (const field of item.fields) {
      if (field.bothChanged) field.confirmed = field[side];
    }
    item.status = "confirmed";
    log("交接确认", `${item.shift} · ${item.fuel} 交接项由站长确认（采用${side === "local" ? "本班" : "交班包"}）`);
    const priceField = item.fields.find((f) => f.name === "拟调价");
    const confirmedPrice = priceField?.confirmed;
    const current = effectiveOf(item.fuel);
    if (typeof confirmedPrice === "number" && current && confirmedPrice !== current.price) {
      // 确认后的拟调价走正常批次流程，确认前不进入均价；
      // 若当前生效价是未来窗口，生效时刻顺延到其之后，避免落入旧窗口
      const now = nowIso();
      const effectiveAt = now > current.effectiveAt ? now : new Date(Date.parse(current.effectiveAt) + 1000).toISOString();
      submitBatch({
        operator: "站长",
        note: `${item.shift}交接确认调价`,
        items: [
          {
            key: uid(),
            fuel: item.fuel,
            price: confirmedPrice,
            effectiveAt,
            revision: headRevision(item.fuel) + 1
          }
        ]
      });
    }
  }

  function discardHandover(id: string) {
    const item = handovers.value.find((h) => h.id === id);
    if (!item || item.status === "confirmed") return;
    item.status = "discarded";
    log("交接丢弃", `${item.shift} · ${item.fuel} 交接项已丢弃`);
  }

  /** 价格一变动，未确认交接项失效重算；原差额写入审计保留可查 */
  function invalidateHandovers(fuel: string, newPrice: number) {
    for (const item of handovers.value) {
      if (item.fuel !== fuel || item.status !== "pending") continue;
      const priceField = item.fields.find((f) => f.name === "拟调价");
      const originalDiff = item.priceDiffAtMerge;
      item.status = "invalidated";
      item.invalidatedReason = `生效价已变为 ${newPrice.toFixed(2)} 元，未确认交接项失效重算`;
      const proposed = priceField ? (priceField.confirmed ?? priceField.remote) : newPrice;
      item.priceDiffAtMerge = round2(proposed - newPrice);
      log(
        "交接失效",
        `${item.shift} · ${fuel} 未确认交接项失效重算`,
        `原差额 ${fmtDiff(originalDiff)} 保留可查，按新生效价重算差额 ${fmtDiff(item.priceDiffAtMerge)}`
      );
    }
  }

  return {
    versions,
    batches,
    conflicts,
    handovers,
    audit,
    failArmed,
    headRevision,
    effectiveOf,
    timelineOf,
    effectiveVersions,
    averagePrice,
    pendingHandovers,
    pendingConflicts,
    submitBatch,
    retryBatch,
    resolveConflict,
    mergeHandover,
    confirmHandover,
    discardHandover
  };
});
