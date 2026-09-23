/** v2 → v1 投影（0.4.1 兼容桥）。
 *
 * v2 事件树是唯一事实源；现有 UI（app.html）、D7 planDesc、tripSummary、gateReport
 * 仍消费 v1 的 nodes/edges/events 扁平结构——这里从 v2 树单向派生这份视图。
 * 0.4.2（V8 进 D7）/0.4.3（时间线消费 v2 树）会逐步把消费方切到 v2，届时本文件退役。
 *
 * 投影规则：
 *   poi/aoi 事件 → Node_（aoi 的 geo 取首个有坐标子事件，仅作地图占位）
 *   route 事件   → Edge_（含嵌套在 aoi 内的内部通勤段）
 *   v2 事件      → Event_（event_id 与 v2 一致，confirm_progress 锁定可双向同步）
 *   status：draft → tentative，active → locked；dropped 不进投影（保留在 events_v2 供追溯）
 *   time_window.source：llm_inference → inferred（v1 词汇），blank/api/user 直通 */
import type { Trip, Node_, Edge_, Event_ } from "./trip-store.ts";
import type { EventV2, PoiEvent, RouteEvent } from "./event-v2.ts";
import { isRoute, isAoi, isPoi, walkTree } from "./event-v2.ts";

const STATUS_OUT: Record<EventV2["status"], Event_["status"]> = {
  draft: "tentative", active: "locked", dropped: "candidate",
};
const TW_SOURCE_OUT: Record<string, string> = { llm_inference: "inferred", blank: "blank", api: "api", user: "user" };

const nodeIdOf = (eventId: string) => eventId.replace(/^evt_/, "node_");
const edgeIdOf = (eventId: string) => eventId.replace(/^evt_/, "edge_");

export interface V1View { nodes: Trip["nodes"]; edges: Trip["edges"]; events: Trip["events"] }

/** 从 v2 事件树派生 v1 视图（纯函数） */
export function projectV1(eventsV2: Record<string, EventV2>): V1View {
  const nodes: Trip["nodes"] = {};
  const edges: Trip["edges"] = {};
  const events: Trip["events"] = {};

  const live = walkTree(eventsV2).filter(e => e.status !== "dropped");

  // 1. poi/aoi → Node_
  for (const ev of live) {
    if (!isPoi(ev) && !isAoi(ev)) continue;
    const nodeId = nodeIdOf(ev.event_id);
    let geo: { lat: number; lng: number } | null = null;
    let amapPoiId: string | null = null;
    let categoryTags: string[] = [];
    let city: string | null = null;
    if (isPoi(ev)) {
      geo = ev.detail.geo ? { lat: ev.detail.geo.lat, lng: ev.detail.geo.lng } : null;
      amapPoiId = ev.detail.poi_ref?.amap_poi_id ?? null;
      categoryTags = ev.detail.category_tags ?? [];
      city = ev.detail.city ?? null;
    } else {
      // aoi 占位：取首个有坐标的子孙 poi
      const kid = firstGeoDescendant(eventsV2, ev.event_id);
      geo = kid?.detail.geo ? { lat: kid.detail.geo.lat, lng: kid.detail.geo.lng } : null;
    }
    nodes[nodeId] = {
      node_id: nodeId, name: ev.name,
      anchor: isPoi(ev) && ev.detail.role !== "activity" ? ev.detail.role : "none",
      geo, amap_poi_id: amapPoiId, category_tags: categoryTags,
      opening_hours: (ev.detail as PoiEvent["detail"]).opening_detail ?? null,
      city,
    } satisfies Node_;
  }

  // 2. route → Edge_（端点事件必须已投影为节点；aoi 端点也已有占位节点）
  for (const ev of live.filter(isRoute)) {
    const fromNode = nodes[nodeIdOf(ev.detail.from_ref)], toNode = nodes[nodeIdOf(ev.detail.to_ref)];
    if (!fromNode || !toNode) continue; // 端点是 dropped 事件：跳过
    const edgeId = edgeIdOf(ev.event_id);
    edges[edgeId] = {
      edge_id: edgeId,
      from_id: fromNode.node_id, to_id: toNode.node_id,
      mode: ev.detail.mode,
      distance_m: ev.detail.distance_m ?? null,
      duration_s: ev.detail.duration_s ?? null,
      data_source: ev.detail.data_source,
      geometry: ev.detail.geometry,
    } satisfies Edge_;
  }

  // 3. v2 事件 → Event_
  for (const ev of live) {
    const tw = ev.time_window
      ? { start: ev.time_window.start ?? null, end: ev.time_window.end ?? null, source: TW_SOURCE_OUT[ev.time_window.source] ?? "blank" }
      : null;
    if (isRoute(ev)) {
      const edgeId = edgeIdOf(ev.event_id);
      if (!edges[edgeId]) continue;
      const fromName = nodes[edges[edgeId].from_id]?.name ?? "?", toName = nodes[edges[edgeId].to_id]?.name ?? "?";
      const sched = ev.detail.schedule;
      const note = ev.note || `${fromName}→${toName}（${ev.detail.mode}）`
        + (sched?.line ? `，${sched.line} ${sched.depart ?? ""} 发` : "");
      events[ev.event_id] = {
        event_id: ev.event_id, anchor_kind: "edge", anchor_ref: edgeId, kind: "transit",
        day_refs: ev.day_refs, time_window: tw,
        cost: ev.cost?.amount ?? sched?.price ?? null,
        status: STATUS_OUT[ev.status], note,
      } satisfies Event_;
    } else {
      // EventV2 是基座+联合 detail（非判别联合），kind 推导显式走 isPoi 收窄
      const v1Kind = isPoi(ev)
        ? (ev.detail.role === "lodging" ? "lodging" : ev.detail.role === "terminal" ? "transit" : "visit")
        : "visit"; // aoi 在 v1 视图里按普通游览点呈现（0.4.3 前台再出面状渲染）
      events[ev.event_id] = {
        event_id: ev.event_id, anchor_kind: "node", anchor_ref: nodeIdOf(ev.event_id),
        kind: v1Kind,
        day_refs: ev.day_refs, time_window: tw,
        cost: ev.cost?.amount ?? (ev.detail as PoiEvent["detail"]).price?.amount ?? null,
        status: STATUS_OUT[ev.status], note: ev.note ?? "",
      } satisfies Event_;
    }
  }
  return { nodes, edges, events };
}

function firstGeoDescendant(events: Record<string, EventV2>, id: string): PoiEvent | null {
  for (const kid of Object.values(events).filter(e => e.parent_id === id)) {
    if (isPoi(kid) && kid.detail.geo) return kid;
    const deeper = firstGeoDescendant(events, kid.event_id);
    if (deeper) return deeper;
  }
  return null;
}

/** 把投影写回 Trip（单向：events_v2 → nodes/edges/events），所有 v2 变更后必须调用 */
export function syncProjection(trip: Trip) {
  if (!trip.events_v2) return;
  const view = projectV1(trip.events_v2);
  trip.nodes = view.nodes;
  trip.edges = view.edges;
  trip.events = view.events;
}
