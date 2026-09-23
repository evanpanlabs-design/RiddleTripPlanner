/** v1 → v2 惰性迁移器（SPEC/event-model-v2.md §9）。
 *
 * 映射规则：
 *   Node_(anchor=lodging/terminal/none) → poi { role: lodging/terminal/activity }
 *   Edge_ → route { mode, from_ref, to_ref, distance_m, duration_s, geometry, data_source }
 *   Event_(anchor_kind=node/edge) → 合并进对应 poi/route（day_refs/time_window/cost/status/note 上移）
 *   status：candidate/tentative → draft，locked → active
 *   provenance：事件级 = llm_inference；geo/geometry 字段级 = api（本来就是解析来的）
 *   auto 补边（0.3.5 产物）→ route { data_source: 原值, note: "v1 工程兜底补边" }
 *
 * 迁移是惰性的：TripStore 构造时发现 events_v2 为空且存在 v1 数据即触发。
 * v1 的 nodes/edges/events 不删——迁移后由 project-v1.ts 重新生成（投影覆盖），保持单向事实源。 */
import type { Trip, Node_, Edge_, Event_ } from "./trip-store.ts";
import type { EventV2, PoiDetail, RouteDetail, TimeWindow } from "./event-v2.ts";

const eid = () => `evt_${Math.random().toString(16).slice(2, 10)}`;

const STATUS_MAP: Record<Event_["status"], EventV2["status"]> = {
  candidate: "draft", tentative: "draft", locked: "active",
};

function twOf(ev: Event_ | undefined): TimeWindow | null {
  if (!ev?.time_window) return null;
  const src = ev.time_window.source;
  return {
    start: ev.time_window.start ?? null,
    end: ev.time_window.end ?? null,
    source: src === "inferred" ? "llm_inference" : src === "api" || src === "user" ? src : "blank",
  };
}

export interface MigrationResult {
  events: Record<string, EventV2>;
  warnings: string[];
}

/** 把 v1 Trip 的 nodes/edges/events 转成 v2 事件树（扁平，全部顶层——v1 无嵌套信息） */
export function migrateTripV1toV2(trip: Trip): MigrationResult {
  const warnings: string[] = [];
  const events: Record<string, EventV2> = {};
  const node2evt = new Map<string, string>(); // v1 node_id → v2 event_id（route 端点要用）

  // 1. Node_ → poi
  for (const n of Object.values(trip.nodes ?? {}) as Node_[]) {
    const attached = Object.values(trip.events ?? {}).find(e => e.anchor_kind === "node" && e.anchor_ref === n.node_id);
    if (!attached) { warnings.push(`节点「${n.name}」无对应 v1 Event，跳过`); continue; }
    const detail: PoiDetail = {
      role: n.anchor === "lodging" ? "lodging" : n.anchor === "terminal" ? "terminal" : "activity",
      geo: n.geo ? { ...n.geo, source: "api" } : null,
      poi_ref: { baidu_uid: null, amap_poi_id: n.amap_poi_id ?? null },
      category_tags: n.category_tags ?? [],
      opening_detail: (n.opening_hours as PoiDetail["opening_detail"]) ?? null,
      city: n.city ?? null,
    };
    const ev: EventV2 = {
      event_id: eid(), kind: "poi", name: n.name,
      parent_id: null, seq: 0,
      day_refs: attached.day_refs ?? [],
      time_window: twOf(attached),
      cost: attached.cost != null ? { amount: attached.cost, currency: "CNY", source: "llm_inference" } : null,
      status: STATUS_MAP[attached.status] ?? "draft",
      provenance: "llm_inference",
      note: attached.note ?? "",
      detail,
    };
    events[ev.event_id] = ev;
    node2evt.set(n.node_id, ev.event_id);
  }

  // 2. Edge_ → route（端点重指到 poi 事件）
  for (const e of Object.values(trip.edges ?? {}) as Edge_[] & { auto?: boolean; coord_type?: string }[]) {
    const fromRef = node2evt.get(e.from_id), toRef = node2evt.get(e.to_id);
    if (!fromRef || !toRef) { warnings.push(`边 ${e.edge_id} 端点缺失，跳过`); continue; }
    const attached = Object.values(trip.events ?? {}).find(ev => ev.anchor_kind === "edge" && ev.anchor_ref === e.edge_id);
    const autoNote = (e as any).auto ? "v1 工程兜底补边" : "";
    const detail: RouteDetail = {
      mode: e.mode,
      from_ref: fromRef, to_ref: toRef,
      distance_m: e.distance_m ?? null,
      duration_s: e.duration_s ?? null,
      geometry: (Array.isArray(e.geometry) ? e.geometry : []) as [number, number][],
      data_source: (["amap_walk", "amap_drive", "amap_ride", "amap_transit", "baidu_transit", "geodesic"].includes(e.data_source)
        ? e.data_source : e.data_source === "empty" ? "empty" : "estimated") as RouteDetail["data_source"],
      schedule: null,
      is_entry_exit: false,
    };
    const ev: EventV2 = {
      event_id: eid(), kind: "route",
      name: attached?.note || `${trip.nodes[e.from_id]?.name ?? "?"}→${trip.nodes[e.to_id]?.name ?? "?"}`,
      parent_id: null, seq: 0,
      day_refs: attached?.day_refs ?? [],
      time_window: twOf(attached),
      cost: attached?.cost != null ? { amount: attached.cost, currency: "CNY", source: "llm_inference" } : null,
      status: STATUS_MAP[attached?.status ?? "tentative"],
      provenance: "llm_inference",
      note: [attached?.note, autoNote].filter(Boolean).join("；"),
      detail,
    };
    events[ev.event_id] = ev;
  }

  // 3. 顶层 seq：按日 + 时间窗（v1 无 seq，用时间窗恢复顺序；route 插回其连接的活动之间）
  assignTopLevelSeq(events);
  return { events, warnings };
}

/** v1 是扁平的"节点事件 + 通勤事件"交错序列，迁移时按 日→时间窗 重建同级 seq */
function assignTopLevelSeq(events: Record<string, EventV2>) {
  const all = Object.values(events);
  const toMin = (hhmm?: string | null) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
    return m ? +m[1] * 60 + +m[2] : 9999;
  };
  // 排序键：最小日 → 时间窗起点 → 类型（route 排在其 from 端点之后）
  all.sort((a, b) =>
    (Math.min(...a.day_refs, 999) - Math.min(...b.day_refs, 999)) ||
    (toMin(a.time_window?.start) - toMin(b.time_window?.start)));
  // route 尽量紧跟其 from 端点事件之后（恢复 v1 的交错顺序）
  const ordered: EventV2[] = [];
  const pool = new Set(all);
  for (const ev of all) {
    if (!pool.has(ev)) continue;
    pool.delete(ev); ordered.push(ev);
    if (ev.kind === "poi" || ev.kind === "aoi") {
      const next = [...pool].find(r => r.kind === "route" && (r.detail as RouteDetail).from_ref === ev.event_id);
      if (next) { pool.delete(next); ordered.push(next); }
    }
  }
  ordered.forEach((ev, i) => { ev.seq = i + 1; });
}
