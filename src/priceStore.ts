import { reactive, ref } from "vue";

export type TerminalId = "A" | "B" | "station";
export type PriceStatus = "active" | "superseded" | "conflict-draft";
export type HandoverStatus = "pending" | "merged" | "invalidated" | "confirmed";
export type PackageStatus = "draft" | "merged" | "confirmed";

export interface Fuel {
  id: string;
  name: string;
  revision: number;
}

export interface PriceVersion {
  id: string;
  fuelId: string;
  priceCents: number;
  effectiveAt: string;
  submittedAt: string;
  terminalId: TerminalId;
  operator: string;
  revision: number;
  baseRevision: number;
  status: PriceStatus;
  requestId: string;
  reason?: string;
  batchId?: string;
  handoverPackageId?: string;
  supersededByVersionId?: string;
  resolvedByVersionId?: string;
  priorVersionId?: string | null;
  originalDiffCents: number | null;
}

export interface PriceBatchItem {
  id: string;
  fuelId: string;
  priceCents: number;
}

export interface BatchResult {
  status: "applied" | "conflict" | "duplicate";
  versionId?: string;
  reason?: string;
}

export interface PriceBatch {
  id: string;
  terminalId: TerminalId;
  operator: string;
  effectiveAt: string;
  note: string;
  createdAt: string;
  committedAt?: string;
  status: "failed" | "committed";
  items: PriceBatchItem[];
  results: Record<string, BatchResult>;
  simulateFailureItemId?: string | null;
  lastError?: string;
}

export type HandoverFieldKey = "observedPrice" | "tankStock" | "meterReading" | "note";
export type Side = "A" | "B";

export interface FieldResolution {
  side: Side | "manual";
  value?: string;
}

export interface HandoverItem {
  id: string;
  packageId: string;
  fuelId: string;
  label: string;
  gen: number;
  status: HandoverStatus;
  baselinePriceCents: number;
  baselineVersionId: string;
  base: Record<HandoverFieldKey, string>;
  sideValues: Partial<Record<Side, Partial<Record<HandoverFieldKey, string>>>>;
  resolution: Partial<Record<HandoverFieldKey, FieldResolution>>;
  createdAt: string;
  recalculatedFromItemId?: string;
  recalculatedByVersionId?: string;
  recalculatedAt?: string;
  invalidatedByVersionId?: string;
  invalidatedAt?: string;
  confirmedAt?: string;
  confirmedVersionId?: string;
}

export interface HandoverPackage {
  id: string;
  shiftName: string;
  terminalA: string;
  terminalB: string;
  createdAt: string;
  confirmedAt?: string;
  status: PackageStatus;
  itemIds: string[];
  currentItemIds: string[];
}

export interface DomainEvent {
  id: string;
  at: string;
  type: "price" | "batch" | "handover" | "conflict" | "system";
  message: string;
}

interface State {
  storageVersion: 1;
  fuels: Fuel[];
  versions: PriceVersion[];
  batches: PriceBatch[];
  packages: HandoverPackage[];
  items: HandoverItem[];
  events: DomainEvent[];
  currentVersionIds: Record<string, string>;
}

export const HANDOVER_FIELDS: { key: HandoverFieldKey; label: string; price?: boolean }[] = [
  { key: "observedPrice", label: "交接报价", price: true },
  { key: "tankStock", label: "库存（升）" },
  { key: "meterReading", label: "泵码读数" },
  { key: "note", label: "交接备注" }
];

const STORAGE_KEY = "fuel-price-concurrency-v1";

export function uid(prefix = "id") {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function toCents(value: string | number) {
  const cents = Math.round(Number(value) * 100);
  return Number.isFinite(cents) ? cents : 0;
}

export function money(cents: number | null | undefined) {
  if (cents === null || cents === undefined) return "—";
  const sign = cents > 0 ? "+" : "";
  return `${sign}${(cents / 100).toFixed(2)}`;
}

export function priceYuan(cents: number) {
  return (cents / 100).toFixed(2);
}

export function toLocalInput(iso: string) {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string) {
  return new Date(value).toISOString();
}

export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function addEvent(state: State, type: DomainEvent["type"], message: string) {
  state.events.unshift({ id: uid("evt"), at: new Date().toISOString(), type, message });
  state.events = state.events.slice(0, 80);
}

function seedState(): State {
  const fuels: Fuel[] = [
    { id: "f-92", name: "92号汽油", revision: 2 },
    { id: "f-95", name: "95号汽油", revision: 3 },
    { id: "f-98", name: "98号汽油", revision: 2 },
    { id: "f-0", name: "柴油", revision: 1 }
  ];

  const versions: PriceVersion[] = [
    {
      id: "v-92-base",
      fuelId: "f-92",
      priceCents: 762,
      effectiveAt: hoursAgo(48),
      submittedAt: hoursAgo(49),
      terminalId: "station",
      operator: "站长",
      revision: 1,
      baseRevision: 0,
      status: "active",
      requestId: "seed-92-base",
      priorVersionId: null,
      originalDiffCents: null
    },
    {
      id: "v-92-current",
      fuelId: "f-92",
      priceCents: 770,
      effectiveAt: hoursAgo(2),
      submittedAt: hoursAgo(3),
      terminalId: "A",
      operator: "一班",
      revision: 2,
      baseRevision: 1,
      status: "active",
      requestId: "seed-92-current",
      priorVersionId: "v-92-base",
      originalDiffCents: 8
    },
    {
      id: "v-92-stale",
      fuelId: "f-92",
      priceCents: 755,
      effectiveAt: hoursAgo(20),
      submittedAt: hoursAgo(1),
      terminalId: "B",
      operator: "离线旧窗口",
      revision: 2,
      baseRevision: 1,
      status: "conflict-draft",
      requestId: "seed-92-stale",
      reason: "基线修订号已过期，且生效时刻早于当前价格窗口",
      priorVersionId: "v-92-base",
      originalDiffCents: -7
    },
    {
      id: "v-95-base",
      fuelId: "f-95",
      priceCents: 815,
      effectiveAt: hoursAgo(48),
      submittedAt: hoursAgo(49),
      terminalId: "station",
      operator: "站长",
      revision: 1,
      baseRevision: 0,
      status: "active",
      requestId: "seed-95-base",
      priorVersionId: null,
      originalDiffCents: null
    },
    {
      id: "v-95-wrong-slot",
      fuelId: "f-95",
      priceCents: 820,
      effectiveAt: hoursAgo(24),
      submittedAt: hoursAgo(25),
      terminalId: "A",
      operator: "一班",
      revision: 2,
      baseRevision: 1,
      status: "superseded",
      requestId: "seed-95-wrong",
      supersededByVersionId: "v-95-correct",
      priorVersionId: "v-95-base",
      originalDiffCents: 5
    },
    {
      id: "v-95-correct",
      fuelId: "f-95",
      priceCents: 822,
      effectiveAt: hoursAgo(24),
      submittedAt: hoursAgo(24.5 as number),
      terminalId: "station",
      operator: "站长修正",
      revision: 3,
      baseRevision: 2,
      status: "active",
      requestId: "seed-95-correct",
      priorVersionId: "v-95-base",
      originalDiffCents: 7
    },
    {
      id: "v-98-base",
      fuelId: "f-98",
      priceCents: 908,
      effectiveAt: hoursAgo(48),
      submittedAt: hoursAgo(49),
      terminalId: "station",
      operator: "站长",
      revision: 1,
      baseRevision: 0,
      status: "active",
      requestId: "seed-98-base",
      priorVersionId: null,
      originalDiffCents: null
    },
    {
      id: "v-98-batch",
      fuelId: "f-98",
      priceCents: 915,
      effectiveAt: hoursAgo(1),
      submittedAt: hoursAgo(1.2 as number),
      terminalId: "A",
      operator: "一班",
      revision: 2,
      baseRevision: 1,
      status: "active",
      requestId: "batch-seed-batch:item-98",
      batchId: "batch-seed",
      priorVersionId: "v-98-base",
      originalDiffCents: 7
    },
    {
      id: "v-0-base",
      fuelId: "f-0",
      priceCents: 718,
      effectiveAt: hoursAgo(48),
      submittedAt: hoursAgo(49),
      terminalId: "station",
      operator: "站长",
      revision: 1,
      baseRevision: 0,
      status: "active",
      requestId: "seed-0-base",
      priorVersionId: null,
      originalDiffCents: null
    }
  ];

  const batches: PriceBatch[] = [
    {
      id: "batch-seed",
      terminalId: "A",
      operator: "一班",
      effectiveAt: hoursAgo(1),
      note: "回连中断的完整调价批次",
      createdAt: hoursAgo(1.3 as number),
      status: "failed",
      items: [
        { id: "item-98", fuelId: "f-98", priceCents: 915 },
        { id: "item-0", fuelId: "f-0", priceCents: 728 }
      ],
      results: {
        "item-98": { status: "applied", versionId: "v-98-batch" }
      },
      lastError: "网络中断：服务端写入结果未确认，第二油品尚未写入"
    }
  ];

  const baseHandover = (
    id: string,
    fuelId: string,
    label: string,
    baseline: number,
    baselineVersionId: string,
    a: Partial<Record<HandoverFieldKey, string>>,
    b: Partial<Record<HandoverFieldKey, string>>
  ): HandoverItem => ({
    id,
    packageId: "pkg-night",
    fuelId,
    label,
    gen: 1,
    status: "merged",
    baselinePriceCents: baseline,
    baselineVersionId,
    base: {
      observedPrice: priceYuan(baseline),
      tankStock: fuelId === "f-92" ? "12000" : "18000",
      meterReading: fuelId === "f-92" ? "82450" : "156900",
      note: ""
    },
    sideValues: { A: a, B: b },
    resolution: {},
    createdAt: hoursAgo(0.5)
  });

  const items: HandoverItem[] = [
    baseHandover(
      "item-92",
      "f-92",
      "92号汽油交接",
      770,
      "v-92-current",
      { observedPrice: "7.76", tankStock: "12120", note: "A班测量：温度正常" },
      { observedPrice: "7.74", tankStock: "12080", note: "B班复核：液位仪偏差" }
    ),
    baseHandover(
      "item-0",
      "f-0",
      "柴油交接",
      718,
      "v-0-base",
      { observedPrice: "7.18", note: "A班已盘点" },
      { observedPrice: "7.20", tankStock: "17980" }
    )
  ];

  const packages: HandoverPackage[] = [
    {
      id: "pkg-night",
      shiftName: "夜班 → 白班",
      terminalA: "A端收银机",
      terminalB: "B端移动终端",
      createdAt: hoursAgo(0.5),
      status: "merged",
      itemIds: items.map((item) => item.id),
      currentItemIds: items.map((item) => item.id)
    }
  ];

  return {
    storageVersion: 1,
    fuels,
    versions,
    batches,
    packages,
    items,
    currentVersionIds: {
      "f-92": "v-92-current",
      "f-95": "v-95-correct",
      "f-98": "v-98-batch",
      "f-0": "v-0-base"
    },
    events: [
      { id: uid("evt"), at: hoursAgo(1), type: "batch", message: "批次 batch-seed 在第 2 项写入失败，已保留完整批次和第 1 项结果" },
      { id: uid("evt"), at: hoursAgo(24.5 as number), type: "price", message: "95号汽油同一时刻旧价已转为历史版本，新差额按上一有效价重算" },
      { id: uid("evt"), at: hoursAgo(1), type: "conflict", message: "B端旧窗口的92号汽油改动已转为冲突草稿，未覆盖有效价" }
    ]
  };
}

function loadState(): State {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return seedState();
  try {
    const parsed = JSON.parse(raw) as State;
    if (parsed.storageVersion !== 1) return seedState();
    return parsed;
  } catch {
    return seedState();
  }
}

const state = reactive<State>(loadState());
const nowTick = ref(Date.now());

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function usePriceStore() {
  function fuelById(fuelId: string) {
    const fuel = state.fuels.find((item) => item.id === fuelId);
    if (!fuel) throw new Error(`未知油品：${fuelId}`);
    return fuel;
  }

  function activeTimeline(fuelId: string) {
    return state.versions
      .filter((version) => version.fuelId === fuelId && version.status === "active")
      .sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.revision - b.revision);
  }

  function currentVersion(fuelId: string, at = Date.now()) {
    const dueVersions = activeTimeline(fuelId).filter((version) => new Date(version.effectiveAt).getTime() <= at);
    return dueVersions[dueVersions.length - 1];
  }

  function currentDiff(version: PriceVersion) {
    if (version.status !== "active") return version.originalDiffCents;
    const timeline = activeTimeline(version.fuelId);
    const index = timeline.findIndex((item) => item.id === version.id);
    const previous = timeline[index - 1];
    return previous ? version.priceCents - previous.priceCents : null;
  }

  function versionById(id?: string) {
    return state.versions.find((version) => version.id === id);
  }

  interface AcceptPriceInput {
    fuelId: string;
    priceCents: number;
    effectiveAt: string;
    terminalId: TerminalId;
    operator: string;
    requestId?: string;
    baseRevisionOverride?: number;
    reason?: string;
    batchId?: string;
    handoverPackageId?: string;
  }

  interface AcceptResult {
    status: "applied" | "conflict" | "duplicate";
    version: PriceVersion;
    reason?: string;
  }

  function invalidateItemsForFuel(
    fuelId: string,
    version: PriceVersion,
    exceptPackageId?: string
  ) {
    for (const pkg of state.packages) {
      if (pkg.status === "confirmed" || pkg.id === exceptPackageId) continue;

      const oldItems = pkg.currentItemIds
        .map((id) => state.items.find((item) => item.id === id))
        .filter((item): item is HandoverItem => Boolean(item))
        .filter((item) => item.fuelId === fuelId && ["pending", "merged"].includes(item.status));

      const replacementIds = [...pkg.currentItemIds];
      let changed = false;

      for (const oldItem of oldItems) {
        const now = new Date().toISOString();
        const previousStatus = oldItem.status;
        oldItem.status = "invalidated";
        oldItem.invalidatedAt = now;
        oldItem.invalidatedByVersionId = version.id;

        const newId = uid("item");
        const newItem: HandoverItem = {
          ...structuredClone(oldItem),
          id: newId,
          gen: oldItem.gen + 1,
          status: previousStatus === "pending" ? "pending" : "merged",
          baselinePriceCents: version.priceCents,
          baselineVersionId: version.id,
          resolution: Object.fromEntries(
            Object.entries(oldItem.resolution).filter(([key]) => key !== "observedPrice")
          ) as HandoverItem["resolution"],
          recalculatedFromItemId: oldItem.id,
          recalculatedByVersionId: version.id,
          recalculatedAt: now,
          invalidatedAt: undefined,
          invalidatedByVersionId: undefined,
          confirmedAt: undefined,
          confirmedVersionId: undefined
        };

        state.items.push(newItem);
        pkg.itemIds.push(newId);
        const index = replacementIds.indexOf(oldItem.id);
        if (index >= 0) replacementIds[index] = newId;
        changed = true;

        addEvent(state, "handover", `${pkg.shiftName}的${oldItem.label}未确认，已按新版价作废并重算为第 ${newItem.gen} 代`);
      }

      if (changed) {
        pkg.currentItemIds = replacementIds;
        pkg.status = pkg.currentItemIds.some((id) => state.items.find((item) => item.id === id)?.status === "pending")
          ? "draft"
          : "merged";
      }
    }
  }

  function acceptPrice(input: AcceptPriceInput): AcceptResult {
    const fuel = fuelById(input.fuelId);
    const requestId = input.requestId || uid("req");
    const duplicate = state.versions.find((version) => version.requestId === requestId);
    if (duplicate) {
      addEvent(state, "system", `重复请求 ${requestId} 已忽略，未重复生成差额`);
      return { status: "duplicate", version: duplicate };
    }

    const submittedAt = new Date().toISOString();
    const baseRevision = input.baseRevisionOverride ?? fuel.revision;
    const timeline = activeTimeline(input.fuelId);
    const latest = timeline[timeline.length - 1];
    const sameSlot = timeline.find((version) => version.effectiveAt === input.effectiveAt);
    const previous = [...timeline]
      .reverse()
      .find((version) => version.effectiveAt < input.effectiveAt);

    const reasons: string[] = [];
    if (baseRevision !== fuel.revision) {
      reasons.push(`客户端基线 r${baseRevision} 已过期，当前为 r${fuel.revision}`);
    }
    if (latest && input.effectiveAt < latest.effectiveAt) {
      reasons.push("生效时刻早于最新价格窗口，旧窗口改动不能直接改历史");
    }

    const attemptedRevision = fuel.revision + 1;
    if (reasons.length > 0) {
      const draft: PriceVersion = {
        id: uid("v"),
        fuelId: input.fuelId,
        priceCents: input.priceCents,
        effectiveAt: input.effectiveAt,
        submittedAt,
        terminalId: input.terminalId,
        operator: input.operator,
        revision: attemptedRevision,
        baseRevision,
        status: "conflict-draft",
        requestId,
        reason: reasons.join("；"),
        batchId: input.batchId,
        handoverPackageId: input.handoverPackageId,
        priorVersionId: previous?.id ?? null,
        originalDiffCents: previous ? input.priceCents - previous.priceCents : null
      };
      state.versions.push(draft);
      addEvent(state, "conflict", `${fuel.name}报价 ${priceYuan(input.priceCents)} 已转冲突草稿：${draft.reason}`);
      persist();
      return { status: "conflict", version: draft, reason: draft.reason };
    }

    if (sameSlot) {
      sameSlot.status = "superseded";
      sameSlot.supersededByVersionId = "pending";
      addEvent(state, "price", `${fuel.name}在${formatDateTime(input.effectiveAt)}只保留一份有效价，旧版本封存`);
    }

    const version: PriceVersion = {
      id: uid("v"),
      fuelId: input.fuelId,
      priceCents: input.priceCents,
      effectiveAt: input.effectiveAt,
      submittedAt,
      terminalId: input.terminalId,
      operator: input.operator,
      revision: attemptedRevision,
      baseRevision,
      status: "active",
      requestId,
      reason: input.reason,
      batchId: input.batchId,
      handoverPackageId: input.handoverPackageId,
      priorVersionId: previous?.id ?? null,
      originalDiffCents: previous ? input.priceCents - previous.priceCents : null
    };

    if (sameSlot) sameSlot.supersededByVersionId = version.id;
    fuel.revision = attemptedRevision;
    state.versions.push(version);

    const isDue = new Date(version.effectiveAt).getTime() <= Date.now();
    if (isDue) state.currentVersionIds[input.fuelId] = version.id;
    if (isDue) {
      invalidateItemsForFuel(input.fuelId, version, input.handoverPackageId);
    }

    addEvent(
      state,
      "price",
      `${fuel.name} r${version.revision} 生效：${priceYuan(version.priceCents)}，原始差额 ${money(version.originalDiffCents)}`
    );
    persist();
    return { status: "applied", version };
  }

  function rebaseConflict(versionId: string) {
    const draft = state.versions.find((version) => version.id === versionId && version.status === "conflict-draft");
    if (!draft || draft.resolvedByVersionId) return;

    const dueAt = new Date(draft.effectiveAt).getTime() > Date.now()
      ? draft.effectiveAt
      : new Date().toISOString();
    const result = acceptPrice({
      fuelId: draft.fuelId,
      priceCents: draft.priceCents,
      effectiveAt: dueAt,
      terminalId: "station",
      operator: "站长采纳冲突价",
      reason: `冲突草稿 ${versionId} 经确认后按当前修订重提`,
      requestId: uid("req")
    });
    if (result.status === "applied") draft.resolvedByVersionId = result.version.id;
    persist();
  }

  interface DraftBatchInput {
    terminalId: TerminalId;
    operator: string;
    effectiveAt: string;
    note: string;
    items: { fuelId: string; priceYuan: string }[];
    failAtIndex?: number;
  }

  function submitDraftBatch(input: DraftBatchInput) {
    const batch: PriceBatch = {
      id: uid("batch"),
      terminalId: input.terminalId,
      operator: input.operator,
      effectiveAt: input.effectiveAt,
      note: input.note,
      createdAt: new Date().toISOString(),
      status: "failed",
      items: input.items.map((item) => ({
        id: uid("batch-item"),
        fuelId: item.fuelId,
        priceCents: toCents(item.priceYuan)
      })),
      results: {}
    };
    if (input.failAtIndex !== undefined && batch.items[input.failAtIndex]) {
      batch.simulateFailureItemId = batch.items[input.failAtIndex].id;
    }
    state.batches.unshift(batch);
    commitBatch(batch.id);
    return batch.id;
  }

  function commitBatch(batchId: string) {
    const batch = state.batches.find((item) => item.id === batchId);
    if (!batch || batch.status === "committed") return;

    addEvent(state, "batch", `从完整批次 ${batch.id} 开始/继续提交，已写入项按结果跳过`);
    for (const item of batch.items) {
      const existing = batch.results[item.id];
      if (existing) continue;

      if (batch.simulateFailureItemId === item.id) {
        batch.simulateFailureItemId = null;
        batch.lastError = `模拟写入失败：${fuelById(item.fuelId).name}未得到服务端确认`;
        batch.status = "failed";
        addEvent(state, "batch", batch.lastError);
        persist();
        return;
      }

      const result = acceptPrice(
        {
          fuelId: item.fuelId,
          priceCents: item.priceCents,
          effectiveAt: batch.effectiveAt,
          terminalId: batch.terminalId,
          operator: batch.operator,
          requestId: `${batch.id}:${item.id}`,
          reason: batch.note,
          batchId: batch.id
        }
      );

      batch.results[item.id] = {
        status: result.status,
        versionId: result.version.id,
        reason: result.reason
      };
    }

    batch.status = "committed";
    batch.committedAt = new Date().toISOString();
    batch.lastError = undefined;
    const conflicts = batch.items.filter((item) => batch.results[item.id]?.status === "conflict").length;
    addEvent(
      state,
      "batch",
      `批次 ${batch.id} 已处理完，${conflicts ? `其中 ${conflicts} 项转冲突草稿` : "无重复差额"}`
    );
    persist();
  }

  function currentPackageItems(pkg: HandoverPackage) {
    return pkg.currentItemIds
      .map((id) => state.items.find((item) => item.id === id))
      .filter((item): item is HandoverItem => Boolean(item));
  }

  function fieldMerge(item: HandoverItem, key: HandoverFieldKey) {
    const a = item.sideValues.A?.[key];
    const b = item.sideValues.B?.[key];
    const base = item.base[key];
    const aChanged = a !== undefined && a !== base;
    const bChanged = b !== undefined && b !== base;
    const bothChanged = aChanged && bChanged;
    const conflict = bothChanged && a !== b;
    const resolution = item.resolution[key];

    let value = base;
    if (resolution?.side === "A") value = a ?? base;
    if (resolution?.side === "B") value = b ?? base;
    if (resolution?.side === "manual" && resolution.value !== undefined) value = resolution.value;
    if (!resolution) {
      if (aChanged && bChanged) value = a === b ? a ?? base : base;
      else if (aChanged) value = a ?? base;
      else if (bChanged) value = b ?? base;
    }

    return { a, b, base, aChanged, bChanged, conflict, unresolved: conflict && !resolution, value };
  }

  function itemConflicts(item: HandoverItem) {
    return HANDOVER_FIELDS.map((field) => field.key).filter((key) => fieldMerge(item, key).unresolved);
  }

  function packageConflicts(pkg: HandoverPackage) {
    return currentPackageItems(pkg).flatMap((item) =>
      itemConflicts(item).map((key) => ({ item, key }))
    );
  }

  function ensureCurrentItem(packageId: string, itemId: string) {
    const pkg = state.packages.find((item) => item.id === packageId);
    const handoverItem = state.items.find((item) => item.id === itemId);
    if (!pkg || !handoverItem || !pkg.currentItemIds.includes(itemId)) {
      throw new Error("交接项已失效，请在新一代条目上处理");
    }
    return { pkg, item: handoverItem };
  }

  function recordSideChange(packageId: string, itemId: string, side: Side, key: HandoverFieldKey, value: string) {
    const { pkg, item } = ensureCurrentItem(packageId, itemId);
    item.sideValues[side] ??= {};
    item.sideValues[side]![key] = value;
    item.status = "pending";
    item.resolution[key] = undefined;
    pkg.status = "draft";
    addEvent(state, "handover", `${side === "A" ? pkg.terminalA : pkg.terminalB}离线修改了${item.label}的${key}`);
    persist();
  }

  function resolveField(packageId: string, itemId: string, key: HandoverFieldKey, side: Side) {
    const { item } = ensureCurrentItem(packageId, itemId);
    item.resolution[key] = { side };
    persist();
  }

  function mergePackage(packageId: string) {
    const pkg = state.packages.find((item) => item.id === packageId);
    if (!pkg || pkg.status === "confirmed") return;
    currentPackageItems(pkg).forEach((item) => {
      if (item.status === "pending") item.status = "merged";
    });
    pkg.status = "merged";
    addEvent(state, "handover", `${pkg.shiftName}已离线合并；双端同字段不同值并列保留，等待站长裁决`);
    persist();
  }

  function confirmPackage(packageId: string) {
    const pkg = state.packages.find((item) => item.id === packageId);
    if (!pkg || pkg.status === "confirmed") return;
    const items = currentPackageItems(pkg);
    if (items.some((item) => item.status !== "merged")) {
      throw new Error("仍有离线改动未合并");
    }
    const unresolved = packageConflicts(pkg);
    if (unresolved.length > 0) {
      throw new Error(`还有 ${unresolved.length} 个双端冲突字段未由站长确认`);
    }

    for (const item of items) {
      const observed = fieldMerge(item, "observedPrice").value;
      const observedCents = toCents(observed);
      const current = currentVersion(item.fuelId);
      let versionId = current?.id;

      if (!current || observedCents !== current.priceCents) {
        const result = acceptPrice(
          {
            fuelId: item.fuelId,
            priceCents: observedCents,
            effectiveAt: new Date().toISOString(),
            terminalId: "station",
            operator: "站长",
            reason: `${pkg.shiftName}交接确认`,
            handoverPackageId: pkg.id,
            requestId: `${pkg.id}:${item.id}:confirm`
          },
        );
        versionId = result.version.id;
      }

      item.status = "confirmed";
      item.confirmedAt = new Date().toISOString();
      item.confirmedVersionId = versionId;
    }

    pkg.status = "confirmed";
    pkg.confirmedAt = new Date().toISOString();
    addEvent(state, "handover", `${pkg.shiftName}经站长确认，交接价正式进入价格时间轴和均价`);
    persist();
  }

  function simulateOfflineEdits(packageId: string) {
    const pkg = state.packages.find((item) => item.id === packageId);
    if (!pkg || pkg.status === "confirmed") return;
    currentPackageItems(pkg).forEach((item, index) => {
      const current = currentVersion(item.fuelId);
      const baseCents = current?.priceCents ?? item.baselinePriceCents;
      recordSideChange(packageId, item.id, "A", "observedPrice", priceYuan(baseCents + 3));
      recordSideChange(packageId, item.id, "B", "observedPrice", priceYuan(baseCents + 1));
      recordSideChange(packageId, item.id, "A", "tankStock", String(Number(item.base.tankStock) + 100 + index * 10));
      recordSideChange(packageId, item.id, "B", "note", `B端二次复核 #${item.gen}`);
    });
  }

  function activateDueVersions() {
    for (const fuel of state.fuels) {
      const version = currentVersion(fuel.id, Date.now());
      if (!version || state.currentVersionIds[fuel.id] === version.id) continue;
      state.currentVersionIds[fuel.id] = version.id;
      invalidateItemsForFuel(fuel.id, version);
      addEvent(state, "price", `${fuel.name}到达计划生效时刻，当前有效价切换为 ${priceYuan(version.priceCents)}`);
      persist();
    }
  }

  function averagePrice(at = Date.now()) {
    const prices = state.fuels
      .map((fuel) => currentVersion(fuel.id, at)?.priceCents)
      .filter((price): price is number => typeof price === "number");
    return Math.round(prices.reduce((sum, price) => sum + price, 0) / prices.length);
  }

  function unresolvedConflictCount() {
    const priceConflicts = state.versions.filter(
      (version) => version.status === "conflict-draft" && !version.resolvedByVersionId
    ).length;
    const handoverConflicts = state.packages
      .filter((pkg) => pkg.status !== "confirmed")
      .reduce((sum, pkg) => sum + packageConflicts(pkg).length, 0);
    return priceConflicts + handoverConflicts;
  }

  setInterval(() => {
    nowTick.value = Date.now();
    activateDueVersions();
  }, 1000);
  activateDueVersions();

  return {
    state,
    nowTick,
    fuelById,
    activeTimeline,
    currentVersion,
    currentDiff,
    versionById,
    acceptPrice,
    rebaseConflict,
    submitDraftBatch,
    commitBatch,
    currentPackageItems,
    fieldMerge,
    itemConflicts,
    packageConflicts,
    recordSideChange,
    resolveField,
    mergePackage,
    confirmPackage,
    simulateOfflineEdits,
    averagePrice,
    unresolvedConflictCount
  };
}
