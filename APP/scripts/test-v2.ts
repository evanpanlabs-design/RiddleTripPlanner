/** v2 纯逻辑单测（0.4.1）：不依赖任何外部 API key。
 * 覆盖：assembleDraft（结构校验/时间窗拓宽）、V8 链条完整、v1→v2 迁移、v2→v1 投影、
 *      convexHull / douglasPeucker / wgs84ToGcj02。
 * 用法：npm run test:v2 */
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assembleDraft, checkChainCompleteness, checkPlanQuality, walkTree, type DraftV2, type EventV2, type RouteDetail, type PoiDetail, type OpeningDetail } from "../src/memory/event-v2.ts";
import { migrateTripV1toV2 } from "../src/memory/migrate-v2.ts";
import { editEvent, reorderEvents, insertPoiOnRoute, pinEvent } from "../src/memory/edits.ts";
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

// ---------- v1 → v2 迁移 + TripStore 惰性迁移（0.4.3 起投影桥退役） ----------
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

// TripStore 惰性迁移（用 runs/ 下的临时目录，测完即删）
const tmp = join(import.meta.dirname, "../runs/_test_v2_tmp");
mkdirSync(tmp, { recursive: true });
try {
  const legacy: Trip = { ...JSON.parse(JSON.stringify(v1)), events_v2: undefined };
  const st = new TripStore(legacy, tmp);
  ok(Object.keys(st.trip.events_v2 ?? {}).length === 3, "TripStore 构造触发惰性迁移");
  ok(st.trip.nodes === undefined && st.trip.events === undefined, "0.4.3：迁移后 legacy v1 三表从内存剥离");
  const persisted = JSON.parse(readFileSync(join(st.dir, "trip.json"), "utf8"));
  ok(persisted.nodes === undefined && persisted.events === undefined && Object.keys(persisted.events_v2 ?? {}).length === 3, "0.4.3：落盘只存 v2 事实源");
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

// ---------- Q1–Q3 方案质量判断（0.4.3） ----------
console.log("== 方案质量判断 ==");
const mkPoi = (id: string, name: string, day: number, start: string | null, geo?: { lat: number; lng: number } | null, extra?: Partial<PoiDetail>): EventV2 => ({
  event_id: id, kind: "poi", name, parent_id: null, seq: 1, day_refs: [day],
  time_window: start ? { start, end: null, source: "user" as const } : null,
  status: "active", provenance: "user",
  detail: { role: "activity", geo: geo ? { ...geo, source: "api" as const } : null, ...extra },
});
const od = (periods: OpeningDetail["periods"], text: string, source: OpeningDetail["source"] = "api"): OpeningDetail => ({ periods, text, source });
// Q3：2024-10-07 是周一（百度 day=1）；博物馆周一 9:00–17:00 开放
const museum = (start: string, source: OpeningDetail["source"] = "api") =>
  mkPoi("m1", "博物馆", 1, start, null, { opening_detail: od([{ open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 17, minute: 0 } }], "周一 9:00-17:00", source) });
const q3Hard = checkPlanQuality({ m1: museum("20:00") }, { startDate: "2024-10-07", days: 1 });
ok(q3Hard.hard.length === 1 && q3Hard.hard[0].code === "Q3_OPENING_CONFLICT", "Q3：闭馆时段到访 → 硬冲突", JSON.stringify(q3Hard.hard));
ok(checkPlanQuality({ m1: museum("10:00") }, { startDate: "2024-10-07", days: 1 }).hard.length === 0, "Q3：开放时段内到访 → 通过");
ok(checkPlanQuality({ m1: museum("20:00", "llm_inference") }, { startDate: "2024-10-07", days: 1 }).hard.length === 0, "Q3：llm_inference 来源不作校验依据");
ok(checkPlanQuality({ m1: museum("20:00") }, { startDate: null, days: 1 }).hard.length === 0, "Q3：缺出发日期跳过星期映射");
const nightOwl = mkPoi("n1", "夜市", 1, "23:00", null, { opening_detail: od([{ open: { day: 1, hour: 20, minute: 0 }, close: { day: 2, hour: 2, minute: 0 } }], "20:00-次日02:00") });
ok(checkPlanQuality({ n1: nightOwl }, { startDate: "2024-10-07", days: 1 }).hard.length === 0, "Q3：跨夜时段只判下限 → 通过");
// Q1：A(31,120) 09:00 → B(31,121) 12:00 → C(31.05,120.05) 15:00，AB/BC ≈100km 而 AC ≈8km
const bt = {
  a: mkPoi("a", "城东", 1, "09:00", { lat: 31.0, lng: 120.0 }),
  b: mkPoi("b", "远郊", 1, "12:00", { lat: 31.0, lng: 121.0 }),
  c: mkPoi("c", "城东北", 1, "15:00", { lat: 31.05, lng: 120.05 }),
};
const q1 = checkPlanQuality(bt, { days: 1 });
ok(q1.advisories.length === 1 && q1.advisories[0].code === "Q1_BACKTRACK" && q1.hard.length === 0, "Q1：明显折返 → 建议级不打回", JSON.stringify(q1.advisories));
const far = { ...bt, c: mkPoi("c", "更远的下一站", 1, "15:00", { lat: 31.0, lng: 121.9 }) };
ok(checkPlanQuality(far, { days: 1 }).advisories.length === 0, "Q1：一路向东不折返 → 通过");
// Q2：单日 8 个活动过满；3 天行程中间天空置
const packed: Record<string, EventV2> = {};
for (let i = 1; i <= 8; i++) packed[`p${i}`] = mkPoi(`p${i}`, `点位${i}`, 1, `${8 + i}:00`.slice(0, 5));
ok(checkPlanQuality(packed, { days: 2 }).advisories.some(q => q.code === "Q2_INTENSITY" && q.message.includes("密度过高")), "Q2：单日 8 活动 → 过满提示");
const gapDay: Record<string, EventV2> = {};
for (let i = 1; i <= 4; i++) gapDay[`g${i}`] = mkPoi(`g${i}`, `点位${i}`, 1, `${8 + i}:00`.slice(0, 5));
gapDay.g5 = mkPoi("g5", "收尾", 3, "10:00");
ok(checkPlanQuality(gapDay, { days: 3 }).advisories.some(q => q.code === "Q2_INTENSITY" && q.message.includes("Day2")), "Q2：中间天空置 → 强度不均提示");
ok(checkPlanQuality(bt, { days: 1 }).hard.length === 0, "Q 族整体：正常方案无硬冲突");

// ---------- 0.5 共创编辑器：编辑 op（edits.ts） ----------
console.log("== 0.5 编辑 op ==");
const mkRoute = (id: string, from: string, to: string, seq: number): EventV2 => ({
  event_id: id, kind: "route", name: `${from}→${to}`, parent_id: null, seq, day_refs: [1],
  time_window: { start: "08:00", end: "09:00", source: "llm_inference" as const }, cost: null,
  status: "active", provenance: "llm_inference",
  detail: { mode: "驾车", from_ref: from, to_ref: to, geometry: [], data_source: "amap_drive" as const },
});
{
  const tmp2 = join(import.meta.dirname, "../runs/_test_edits_tmp");
  mkdirSync(tmp2, { recursive: true });
  try {
    const t = emptyTrip();
    t.days = 1;
    t.events_v2 = { p1: mkPoi("p1", "甲", 1, "09:00"), p2: mkPoi("p2", "乙", 1, "14:00"), r1: mkRoute("r1", "p1", "p2", 2) };
    t.events_v2.p1.seq = 1; t.events_v2.p2.seq = 3;
    t.events_v2.p1.time_window!.source = "llm_inference"; // 验证 editEvent 会把来源改写成 user
    const st = new TripStore(t, tmp2);
    // editEvent：改时间 → source=user 不自动钉；倒挂 → TIME_INVERSION 即时检出
    const cf1 = editEvent(st, "p1", { time_window: { start: "18:00", end: "10:00" } });
    ok(st.trip.events_v2!.p1.time_window?.source === "user" && !st.trip.events_v2!.p1.time_window?.pinned, "editEvent：改时间置 user 软值、不自动钉");
    ok(cf1.some(c => c.code === "TIME_INVERSION" && c.ids.includes("p1")), "editEvent：时间倒挂即时检出", JSON.stringify(cf1));
    st.undo(); st.undo(); // log（undo=null）+ snapshot 两条
    ok(st.trip.events_v2!.p1.time_window?.start === "09:00", "undo 恢复编辑前时间");
    // reorderEvents：p2 排到最前 → seq 重排 + r1 标 stale
    reorderEvents(st, 1, ["p2", "r1", "p1"]);
    ok(st.trip.events_v2!.p2.seq === 1 && st.trip.events_v2!.p1.seq === 3, "reorder：seq 重排");
    ok((st.trip.events_v2!.r1.detail as RouteDetail).stale === true, "reorder：受影响 route 标 stale");
    // insertPoiOnRoute：r1 分裂两段 + draft POI（user 来源）
    const { poiId } = insertPoiOnRoute(st, "r1", "中途点");
    const r2 = Object.values(st.trip.events_v2!).find(e => e.kind === "route" && e.event_id !== "r1")!;
    ok((st.trip.events_v2!.r1.detail as RouteDetail).to_ref === poiId && (r2.detail as RouteDetail).from_ref === poiId, "insert：route 分裂为 A→P、P→B 两段");
    ok(st.trip.events_v2![poiId].status === "draft" && st.trip.events_v2![poiId].provenance === "user", "insert：draft POI 为 user 来源");
    ok((st.trip.events_v2!.r1.detail as RouteDetail).stale === true && (r2.detail as RouteDetail).stale === true, "insert：两段都 stale");
    // pinEvent：无时间不能钉；有时间可钉可拔
    let threw = false;
    try { pinEvent(st, poiId, true); } catch { threw = true; }
    ok(threw, "pin：无时间事件不能钉");
    pinEvent(st, "p1", true);
    ok(st.trip.events_v2!.p1.time_window?.pinned === true, "pin：钉住");
    pinEvent(st, "p1", false);
    ok(st.trip.events_v2!.p1.time_window?.pinned === false, "pin：拔钉");
  } finally { rmSync(tmp2, { recursive: true, force: true }); }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
