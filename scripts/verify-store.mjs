import { createPinia, setActivePinia } from "pinia";
import { usePriceStore } from "../src/store";

// node 环境补齐浏览器 API
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
};
globalThis.crypto ??= (await import("node:crypto")).webcrypto;

setActivePinia(createPinia());
const store = usePriceStore();

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failed += 1;
}

const iso = (h) => new Date(Date.now() + h * 3600000).toISOString();
const item = (fuel, price, h, rev) => ({ key: crypto.randomUUID(), fuel, price, effectiveAt: iso(h), revision: rev });

// 1. 正常提交：修订号 +1，差额正确
const head = store.headRevision("95号汽油");
store.submitBatch({ operator: "站长", note: "t1", items: [item("95号汽油", 8.2, 1, head + 1)] });
check("正常提交生效", store.effectiveOf("95号汽油").price === 8.2);
check("差额计算正确", store.effectiveOf("95号汽油").diffFromPrev === 0.06);
check("旧版本转历史", store.versions.filter((v) => v.fuel === "95号汽油" && v.status === "superseded").length === 1);

// 2. 晚到价（旧修订号）→ 冲突草稿，不覆盖生效版本
store.submitBatch({ operator: "值班经理", note: "t2", items: [item("95号汽油", 9.99, 2, head + 1)] });
check("晚到价不覆盖生效版本", store.effectiveOf("95号汽油").price === 8.2);
check("晚到价转冲突草稿", store.pendingConflicts.some((c) => c.fuel === "95号汽油" && c.price === 9.99));

// 3. 同一生效时刻只留一份有效价
const dupAt = store.effectiveOf("95号汽油").effectiveAt;
store.submitBatch({
  operator: "值班经理",
  note: "t3",
  items: [{ key: crypto.randomUUID(), fuel: "95号汽油", price: 8.5, effectiveAt: dupAt, revision: store.headRevision("95号汽油") + 1 }]
});
check("同一生效时刻撞车转冲突", store.pendingConflicts.some((c) => c.price === 8.5));

// 4. 旧窗口改动 → 冲突草稿
const rev4 = store.headRevision("柴油") + 1;
store.submitBatch({ operator: "站长", note: "t4", items: [item("柴油", 6.5, -100, rev4)] });
check("旧窗口改动转冲突", store.pendingConflicts.some((c) => c.fuel === "柴油" && c.price === 6.5));
check("旧窗口不覆盖生效价", store.effectiveOf("柴油").price === 7.18);

// 5. 写入失败断点续传：两条批次，第一条写入后中断
const rev95 = store.headRevision("95号汽油");
const batch = store.submitBatch({
  id: "batch-fail-1",
  operator: "站长",
  note: "t5",
  armFail: true,
  items: [item("95号汽油", 8.3, 3, rev95 + 1), item("98号汽油", 8.9, 3, store.headRevision("98号汽油") + 1)]
});
check("批次中断为 partial", batch.status === "partial");
check("第一条已写入", store.effectiveOf("95号汽油").price === 8.3);
check("第二条未写入", store.effectiveOf("98号汽油").price === 8.86);
const diffBefore = store.effectiveOf("95号汽油").diffFromPrev;
store.retryBatch("batch-fail-1");
check("重试后批次完成", store.batches.find((b) => b.id === "batch-fail-1").status === "committed");
check("续传写入剩余条目", store.effectiveOf("98号汽油").price === 8.9);
check("重试不重复算差额", store.effectiveOf("95号汽油").diffFromPrev === diffBefore);
check("95号版本数未重复", store.versions.filter((v) => v.fuel === "95号汽油" && v.price === 8.3).length === 1);

// 6. 同幂等号重复提交不重复落库
const countBefore = store.versions.length;
store.submitBatch({ id: "batch-fail-1", operator: "站长", note: "dup", items: [] });
check("幂等号去重", store.versions.length === countBefore);

// 7. 交接合并：双改字段并列保留，确认前不进均价
const avgBefore = store.averagePrice;
store.mergeHandover({ shift: "早班", fuel: "92号汽油", local: [100, 762, 7.7], remote: [120, 914, 7.8] });
const ho = store.pendingHandovers[0];
check("双改字段并列保留", ho.fields.every((f) => f.bothChanged) && ho.fields[0].confirmed === undefined);
check("确认前不进均价", store.averagePrice === avgBefore);

// 8. 价格变动 → 未确认交接项失效重算，原差额可查
const originalDiff = ho.priceDiffAtMerge;
store.submitBatch({ operator: "站长", note: "t8", items: [item("92号汽油", 7.7, 5, store.headRevision("92号汽油") + 1)] });
check("交接项失效重算", ho.status === "invalidated" && ho.priceDiffAtMerge === 0.1);
check("原差额审计可查", store.audit.some((e) => e.kind === "交接失效" && e.detail.includes(originalDiff.toFixed(2))));

// 9. 站长确认交接（采用交班包）→ 拟调价进入均价
store.confirmHandover(ho.id, "remote");
check("确认后拟调价生效", store.effectiveOf("92号汽油").price === 7.8);
check("旧版本原差额仍可查", store.timelineOf("92号汽油").some((v) => v.status === "superseded" && v.diffFromPrev !== 0));

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
