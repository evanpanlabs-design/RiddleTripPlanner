/** v2 纯逻辑单测（0.4.1）：不依赖任何外部 API key。
 * 覆盖：assembleDraft（结构校验/时间窗拓宽）、V8 链条完整、v1→v2 迁移、v2→v1 投影、
 *      convexHull / douglasPeucker / wgs84ToGcj02。
 * 用法：npm run test:v2 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assembleDraft, checkChainCompleteness, walkTree, type DraftV2, type EventV2, type RouteDetail, type PoiDetail } from "../src/memory/event-v2.ts";
import { migrateTripV1toV2 } from "../src/memory/migrate-v2.ts";
import { projectV1, syncProjection } from "../src/memory/project-v1.ts";
import { TripStore, emptyTrip, type Trip } from "../src/memory/trip-store.ts";
import { convexHull, douglasPeucker, wgs84ToGcj02 } from "../src/tools/osm-aoi.ts";

let pass = 0, fail = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}

// ---------- 合法草案：嵌套 + 时间窗拓宽 + seq 重排 ----------
console.log("== assembleDraft: 合法草案 ==");
const draft: DraftV2 = {
  days: 3,
  events: [
    { tmp_id: "e1", kind: "poi", name: "成都东站", day_refs: [1], detail: { role: "terminal" }, time_window: { start: "07:30" } },
    { tmp_id: "e2", kind: "route", name: "成都→九寨沟", day_refs: [1], detail: { mode: "大巴", from: "e1", to: "e3" } },
    { tmp_id: "e3", kind: "aoi", name: "九寨沟", day_refs: [1, 2, 3] },
    { tmp_id: "e5", kind: "route", name: "观光车", parent_id: "e3", seq: 2, day_refs: [2], detail: { mode: "公交", from: "e4", to: "e6" } },
    { tmp_id: "e4", kind: "poi", name: "则查洼沟", parent_id: "e3", seq: 1, day_refs: [2], time_window: { start: "09:30", end: "12:00" } },
    { tmp_id: "e6", kind: "poi", name: "日则沟", parent_id: "e3", seq: 3, day_refs: [2], time_window: { start: "13:00", end: "16:00" } },
    { tmp_id: "e7", kind: "poi", name: "沟口酒店", day_refs: [2], detail: { role: "lodging" }, time_window: { start: "18:00" } },
    { tmp_id: "e8", kind: "route", name: "景区→酒店", day_refs: [2], detail: { mode: "步行", from: "e3", to: "e7" } },
  ],
  checklist: [{ title: "预约九寨沟门票", category: "booking" }],
};
const asm = assembleDraft(draft);
ok(asm.ok, "合法草案组装成功", JSON.stringify(asm.ok ? [] : asm.errors));
if (asm.ok) {
  const evs = Object.values(asm.events);
  const aoi = evs.find(e => e.kind === "aoi")!;
  ok(aoi.time_window?.start === "09:30" && aoi.time_window?.end === "16:00", "父窗拓宽为子事件并集", JSON.stringify(aoi.time_window));
  ok(aoi.time_window?.source === "llm_inference", "拓宽的父窗标记 llm_inference");
  const kids = evs.filter(e => e.parent_id === aoi.event_id).sort((a, b) => a.seq - b.seq).map(e => e.name);
  ok(kids.join(",") === "则查洼沟,观光车,日则沟", "同级按 seq 排序", kids.join(","));
  const tree = walkTree(asm.events).map(e => e.name);
  ok(tree[0] === "成都东站" && tree.includes("九寨沟"), "先序遍历含全部顶层事件");
  ok(checkChainCompleteness(asm.events).length === 0, "V8：链条完整通过");
}

// ---------- 结构错误：悬空 parent / 非法嵌套 / 超深 / 端点非法 ----------
console.log("== assembleDraft: 结构错误打回 ==");
const bad1 = assembleDraft({ days: 1, events: [{ tmp_id: "a", kind: "poi", name: "x", parent_id: "ghost", day_refs: [1] }] });
ok(!bad1.ok && !bad1.ok && bad1.errors.some(e => e.code === "DANGLING_PARENT"), "悬空 parent_id 打回");
const bad2 = assembleDraft({ days: 1, events: [
  { tmp_id: "a", kind: "aoi", name: "外景区", day_refs: [1] },
  { tmp_id: "b", kind: "aoi", name: "内景区", parent_id: "a", day_refs: [1] },
] });
ok(!bad2.ok && bad2.errors.some(e => e.code === "BAD_NESTING"), "AOI 套 AOI 打回");
const bad3 = assembleDraft({ days: 1, events: [
  { tmp_id: "a", kind: "aoi", name: "A", day_refs: [1] },
  { tmp_id: "r", kind: "route", name: "R", parent_id: "a", day_refs: [1], detail: { from: "p1", to: "p2" } },
  { tmp_id: "p1", kind: "poi", name: "P1", parent_id: "r", day_refs: [1] },
  { tmp_id: "p2", kind: "poi", name: "P2", parent_id: "p1", day_refs: [1] }, // poi 不可嵌套
] });
ok(!bad3.ok && bad3.errors.some(e => e.code === "BAD_NESTING"), "poi 嵌套打回");

// ---------- V8：同日相邻活动缺 route ----------
console.log("== V8 链条完整 ==");
const broken = assembleDraft({ days: 1, events: [
  { tmp_id: "a", kind: "poi", name: "拙政园", day_refs: [1], time_window: { start: "09:00" } },
  { tmp_id: "b", kind: "poi", name: "狮子林", day_refs: [1], time_window: { start: "13:00" } },
] });
ok(broken.ok, "无 route 的草案组装本身成功");
if (broken.ok) {
  const v8 = checkChainCompleteness(broken.events);
  ok(v8.length === 1 && v8[0].code === "V8_CHAIN_BROKEN", "V8：缺 route 打回", JSON.stringify(v8));
}

// ---------- V8 嵌套感知（0.4.2）：端点指向 AOI 子事件 ≡ 指向 AOI；AOI 内部链条同规则 ----------
console.log("== V8 嵌套感知 ==");
const nested = assembleDraft({ days: 1, events: [
  { tmp_id: "h", kind: "poi", name: "酒店", day_refs: [1], detail: { role: "lodging" }, time_window: { start: "08:00" } },
  { tmp_id: "g", kind: "aoi", name: "景区", day_refs: [1] },
  { tmp_id: "gate", kind: "poi", name: "景区大门", parent_id: "g", seq: 1, day_refs: [1], time_window: { start: "09:00" } },
  { tmp_id: "r1", kind: "route", name: "酒店→大门", day_refs: [1], detail: { mode: "驾车", from: "h", to: "gate" } },
] });
ok(nested.ok, "嵌套草案组装成功", JSON.stringify(nested.ok ? [] : nested.errors));
if (nested.ok) {
  const v8 = checkChainCompleteness(nested.events);
  ok(v8.length === 0, "V8：route 端点指向 AOI 子事件算连上顶层链条", JSON.stringify(v8));
}
const innerBroken = assembleDraft({ days: 1, events: [
  { tmp_id: "g", kind: "aoi", name: "九寨沟", day_refs: [1] },
  { tmp_id: "p1", kind: "poi", name: "则查洼沟", parent_id: "g", seq: 1, day_refs: [1], time_window: { start: "09:00" } },
  { tmp_id: "p2", kind: "poi", name: "日则沟", parent_id: "g", seq: 2, day_refs: [1], time_window: { start: "13:00" } },
] });
ok(innerBroken.ok, "AOI 内部缺 route 草案组装成功");
if (innerBroken.ok) {
  const v8 = checkChainCompleteness(innerBroken.events);
  ok(v8.length === 1 && v8[0].code === "V8_CHAIN_BROKEN" && v8[0].message.includes("九寨沟"), "V8：AOI 内部相邻活动缺 route 打回", JSON.stringify(v8));
}
const innerLinked = assembleDraft({ days: 1, events: [
  { tmp_id: "g", kind: "aoi", name: "九寨沟", day_refs: [1] },
  { tmp_id: "p1", kind: "poi", name: "则查洼沟", parent_id: "g", seq: 1, day_refs: [1], time_window: { start: "09:00" } },
  { tmp_id: "r", kind: "route", name: "观光车", parent_id: "g", seq: 2, day_refs: [1], detail: { mode: "公交", from: "p1", to: "p2" } },
  { tmp_id: "p2", kind: "poi", name: "日则沟", parent_id: "g", seq: 3, day_refs: [1], time_window: { start: "13:00" } },
] });
ok(innerLinked.ok, "AOI 内部含 route 草案组装成功");
if (innerLinked.ok) {
  ok(checkChainCompleteness(innerLinked.events).length === 0, "V8：AOI 内部有 route 通过");
}

// ---------- v1 → v2 迁移 + TripStore 惰性迁移 + 投影 ----------
console.log("== 迁移与投影 ==");
const v1: Trip = emptyTrip();
v1.days = 2;
v1.destination = ["苏州"];
v1.nodes = {
  node_a: { node_id: "node_a", name: "拙政园", anchor: "none", geo: { lat: 31.32, lng: 120.63 }, amap_poi_id: "B0FF1", category_tags: ["旅游景点"], city: "苏州" },
  node_b: { node_id: "node_b", name: "全季酒店", anchor: "lodging", geo: { lat: 31.30, lng: 120.62 }, amap_poi_id: null, category_tags: [], city: "苏州" },
};
v1.edges = {
  edge_1: { edge_id: "edge_1", from_id: "node_a", to_id: "node_b", mode: "步行", distance_m: 800, duration_s: 600, data_source: "amap_walk", geometry: [[120.63, 31.32], [120.62, 31.30]] },
};
v1.events = {
  evt_1: { event_id: "evt_1", anchor_kind: "node", anchor_ref: "node_a", kind: "visit", day_refs: [1], time_window: { start: "09:00", end: "12:00", source: "inferred" }, cost: 70, status: "locked", note: "" },
  evt_2: { event_id: "evt_2", anchor_kind: "edge", anchor_ref: "edge_1", kind: "transit", day_refs: [1], time_window: { start: "12:00", end: "12:15", source: "inferred" }, cost: null, status: "locked", note: "拙政园→全季酒店（步行）" },
  evt_3: { event_id: "evt_3", anchor_kind: "node", anchor_ref: "node_b", kind: "lodging", day_refs: [1], time_window: { start: "18:00", end: null, source: "inferred" }, cost: 300, status: "tentative", note: "" },
};
const mig = migrateTripV1toV2(v1);
ok(Object.keys(mig.events).length === 3, "迁移生成 3 个 v2 事件", `实际 ${Object.keys(mig.events).length}`);
const migPoi = Object.values(mig.events).find(e => e.name === "拙政园");
ok(migPoi?.kind === "poi" && (migPoi.detail as PoiDetail).role === "activity", "anchor=none → role=activity");
ok(migPoi?.status === "active", "locked → active");
ok((migPoi?.detail as PoiDetail)?.geo?.source === "api", "geo 字段级 source=api");
const migRoute = Object.values(mig.events).find(e => e.kind === "route");
ok(migRoute?.kind === "route" && (migRoute.detail as RouteDetail).data_source === "amap_walk", "Edge_ → route 保留数据源");
ok(migRoute?.time_window?.source === "llm_inference", "v1 inferred → llm_inference");
const lodging = Object.values(mig.events).find(e => e.name === "全季酒店");
ok(lodging?.status === "draft", "tentative → draft");

// 投影
v1.events_v2 = mig.events;
syncProjection(v1);
ok(Object.keys(v1.nodes).length === 2 && Object.keys(v1.edges).length === 1 && Object.keys(v1.events).length === 3, "投影重建 v1 三表");
ok(Object.values(v1.events).find(e => e.kind === "lodging")?.status === "tentative", "投影 draft → tentative");
ok(Object.values(v1.events).find(e => e.kind === "visit")?.status === "locked", "投影 active → locked");
ok(Object.values(v1.nodes).find(n => n.name === "全季酒店")?.anchor === "lodging", "投影保留 anchor 角色");
const projTransit = Object.values(v1.events).find(e => e.kind === "transit");
ok(projTransit?.time_window?.source === "inferred", "投影 llm_inference → inferred");
ok(Object.keys(v1.events).every(id => id.startsWith("evt_")), "投影事件与 v2 共用 event_id");

// TripStore 惰性迁移（用 runs/ 下的临时目录，测完即删）
const tmp = join(import.meta.dirname, "../runs/_test_v2_tmp");
mkdirSync(tmp, { recursive: true });
try {
  const legacy: Trip = { ...JSON.parse(JSON.stringify(v1)), events_v2: undefined };
  const st = new TripStore(legacy, tmp);
  ok(Object.keys(st.trip.events_v2 ?? {}).length === 3, "TripStore 构造触发惰性迁移");
  ok(Object.keys(st.trip.nodes).length === 2, "迁移后投影自动同步");
} finally { rmSync(tmp, { recursive: true, force: true }); }

// ---------- 几何与坐标 ----------
console.log("== 几何与坐标 ==");
const hull = convexHull([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]);
ok(hull.length === 4, "凸包去掉内点", `hull=${hull.length}`);
ok(convexHull([[0, 0], [1, 1]]).length === 2, "两点凸包原样返回");
const dense: [number, number][] = Array.from({ length: 100 }, (_, i) => [i * 0.0001, i * 0.0001]); // 共线 100 点
const simp = douglasPeucker(dense, 50);
ok(simp.length === 2, "共线 100 点 DP 抽稀到 2 点", `实际 ${simp.length}`);
const [glng, glat] = wgs84ToGcj02(116.404, 39.915);
ok(Math.abs(glng - 116.404) < 0.01 && Math.abs(glat - 39.915) < 0.01 && (glng !== 116.404 || glat !== 39.915), "WGS84→GCJ02 国内偏移合理");
const [olng, olat] = wgs84ToGcj02(-74.006, 40.7128);
ok(olng === -74.006 && olat === 40.7128, "境外坐标不偏移");

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
