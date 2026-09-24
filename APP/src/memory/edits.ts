/** 0.5 共创编辑器：用户编辑操作（edit_event / reorder_events / insert_poi_on_route / pin_event）。
 * 全部是同步落 op 的纯数据变更（不触发 LLM 轮）；每次变更前 snapshot（undo 走 restore_trip）。
 * 三层时间模型（SPEC/editor-schema-0.5.md §1）：
 *   派生层（source≠user 未钉，顺序变即重算）/ 用户软值（source=user 未钉，LOOP 明说留痕）/ 钉住层（pinned，LOOP 免碰）。
 * 手动改时间不自动钉；钉/拔钉只走 pinEvent；mode 或顺序变更把受影响 route 标 stale，下轮 LOOP 重算。 */
import { randomUUID } from "node:crypto";
import type { TripStore } from "./trip-store.ts";
import { isRoute, isPoi, type EventV2, type RouteEvent, type TimeWindow } from "./event-v2.ts";

// ---------------- 即时机械冲突校验（允许暂存非法态，前台标红；D7 前必须清零） ----------------

export interface EditConflict {
  code: "TIME_INVERSION" | "TIME_OVERLAP";
  message: string;
  ids: string[];
}

const toMin = (s?: string | null): number | null => {
  if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(":").map(Number);
  return h * 60 + m;
};

/** 同父同日的事件链上查时间倒挂（start>end）与相邻重叠（prev.end > next.start）。
 * 覆盖顶层链与每个 AOI/ROUTE 内部链；day 缺省查全部日。
 * 同一天内比较：先按 day_refs 分桶（跨天事件进多个桶），桶内按开始时间排序查相邻重叠；
 * 倒挂是事件自身属性，全量查一次（按 id 去重）。 */
export function checkTimeConflicts(events: Record<string, EventV2>, day?: number): EditConflict[] {
  const out: EditConflict[] = [];
  const live = Object.values(events).filter(e => e.status !== "dropped");
  const parents: (string | null)[] = [null, ...live.filter(e => e.kind !== "poi").map(e => e.event_id)];
  const inversionSeen = new Set<string>();
  const overlapSeen = new Set<string>();
  for (const pid of parents) {
    const group = live.filter(e => e.parent_id === pid && (day === undefined || e.day_refs.includes(day)));
    // 倒挂：事件自身 start>end，与分桶无关
    for (const e of group) {
      const s = toMin(e.time_window?.start), en = toMin(e.time_window?.end);
      if (s != null && en != null && en < s && !inversionSeen.has(e.event_id)) {
        inversionSeen.add(e.event_id);
        out.push({ code: "TIME_INVERSION", message: `「${e.name}」时间倒挂（${e.time_window?.start}–${e.time_window?.end}）`, ids: [e.event_id] });
      }
    }
    // 重叠：按日分桶（无日期的进 0 桶），只在同桶内比相邻
    const buckets = new Map<number, EventV2[]>();
    for (const e of group) {
      const days = e.day_refs.length ? e.day_refs : [0];
      for (const d of days) {
        if (!buckets.has(d)) buckets.set(d, []);
        buckets.get(d)!.push(e);
      }
    }
    for (const chain of buckets.values()) {
      chain.sort((a, b) => (toMin(a.time_window?.start) ?? 9999) - (toMin(b.time_window?.start) ?? 9999) || a.seq - b.seq);
      let prev: EventV2 | null = null;
      for (const e of chain) {
        const s = toMin(e.time_window?.start);
        if (prev) {
          const pe = toMin(prev.time_window?.end);
          const key = `${prev.event_id}|${e.event_id}`;
          if (pe != null && s != null && s < pe && !overlapSeen.has(key)) {
            overlapSeen.add(key);
            out.push({ code: "TIME_OVERLAP", message: `「${prev.name}」与「${e.name}」时间重叠`, ids: [prev.event_id, e.event_id] });
          }
        }
        if (toMin(e.time_window?.end) != null || toMin(e.time_window?.start) != null) prev = e;
      }
    }
  }
  return out;
}

// ---------------- 四个编辑 op ----------------

export interface EditPatch {
  time_window?: { start?: string | null; end?: string | null };
  note?: string;
  mode?: string; // 仅 route：改交通方式 → 标 stale 待重算
}

/** edit_event：手动微调时间/备注/交通方式。被改时间字段 source 置 user（不自动钉）。 */
export function editEvent(store: TripStore, eventId: string, patch: EditPatch): EditConflict[] {
  const e = store.trip.events_v2?.[eventId];
  if (!e) throw new Error(`事件不存在：${eventId}`);
  store.snapshot("edit_event", { event_id: eventId });
  const before: EditPatch = {};
  if (patch.time_window) {
    before.time_window = { start: e.time_window?.start ?? null, end: e.time_window?.end ?? null };
    const tw: TimeWindow = { ...(e.time_window ?? { source: "blank" }), ...patch.time_window, source: "user" };
    e.time_window = tw; // 手动改时间不自动钉（pinned 保持原值）
  }
  if (patch.note !== undefined) { before.note = e.note; e.note = patch.note; }
  if (patch.mode && isRoute(e)) {
    before.mode = e.detail.mode;
    e.detail.mode = patch.mode;
    e.detail.stale = true; // 方式变了，里程/耗时/几何待下轮 LOOP 重算
  }
  store.log("edit_event", { event_id: eventId, patch, before }, null, { actor: "user" });
  return checkTimeConflicts(store.trip.events_v2 ?? {});
}

/** reorder_events：拖拽重排（只动 seq，不动时间）；同日受影响 route 标 stale。 */
export function reorderEvents(store: TripStore, day: number, orderedIds: string[]): EditConflict[] {
  const events = store.trip.events_v2 ?? {};
  const set = new Set(orderedIds);
  store.snapshot("reorder_events", { day });
  orderedIds.forEach((id, i) => {
    const e = events[id];
    if (e && e.day_refs.includes(day)) e.seq = i + 1;
  });
  // 端点都在被重排集合内的 route：相对顺序可能已变 → stale
  for (const r of Object.values(events).filter(isRoute)) {
    if (set.has(r.detail.from_ref) && set.has(r.detail.to_ref)) r.detail.stale = true;
  }
  store.log("reorder_events", { day, ordered_ids: orderedIds }, null, { actor: "user" });
  return checkTimeConflicts(events, day);
}

/** insert_poi_on_route：route A→B 上插 draft POI P → R 变 A→P（stale），新建 P→B（stale）。
 * P 为 user 来源的 draft 节点，下轮 LOOP 负责地理解析 + 时间重排。 */
export function insertPoiOnRoute(store: TripStore, routeId: string, name: string): { poiId: string; conflicts: EditConflict[] } {
  const events = store.trip.events_v2 ?? {};
  const r = events[routeId];
  if (!r || !isRoute(r)) throw new Error(`通勤段不存在：${routeId}`);
  store.snapshot("insert_poi_on_route", { route_id: routeId });
  const poiId = `evt_${randomUUID().slice(0, 8)}`;
  const poi: EventV2 = {
    event_id: poiId, kind: "poi", name,
    parent_id: r.parent_id, seq: r.seq + 0.4,
    day_refs: [...r.day_refs], time_window: null, cost: null,
    status: "draft", provenance: "user",
    note: "手动插入：待 LOOP 地理解析与时间重排",
    detail: { role: "activity", geo: null, poi_ref: {}, category_tags: [] },
  };
  const r2: RouteEvent = {
    event_id: `evt_${randomUUID().slice(0, 8)}`, kind: "route", name: `${name} → ${events[r.detail.to_ref]?.name ?? "?"}`,
    parent_id: r.parent_id, seq: r.seq + 0.8,
    day_refs: [...r.day_refs], time_window: null, cost: null,
    status: "draft", provenance: "user",
    detail: { mode: r.detail.mode, from_ref: poiId, to_ref: r.detail.to_ref, geometry: [], data_source: "empty", stale: true },
  };
  r.detail.to_ref = poiId; // R 变 A→P
  r.detail.stale = true;
  events[poiId] = poi;
  events[r2.event_id] = r2;
  store.log("insert_poi_on_route", { route_id: routeId, poi_id: poiId, new_route_id: r2.event_id, name }, null, { actor: "user" });
  return { poiId, conflicts: checkTimeConflicts(events) };
}

/** 三层时间模型合并（apply_plan 重建树时调用，LOOP 侧的主权执行点）：
 * 钉住层（pinned）免碰——旧 time_window 原样盖回同名新事件；
 * 用户软值（source=user 未钉）被新草案改动 → 返回明说清单（调用方留痕 + 要求 LLM 回复明示）；
 * 派生层随草案重算，不干预。
 * 身份匹配启发式：kind + name + day_refs 有交集（草案重建没有稳定 id）。
 * 直接原地修改 events；返回软值被改的明说清单。 */
export function mergeTimeSovereignty(prevTree: Record<string, EventV2>, events: Record<string, EventV2>): string[] {
  const softOverrides: string[] = [];
  if (!Object.keys(prevTree).length) return softOverrides;
  const matchPrev = (e: EventV2) => Object.values(prevTree).find(o =>
    o.status !== "dropped" && o.kind === e.kind && o.name === e.name &&
    o.day_refs.some(d => e.day_refs.includes(d)));
  for (const e of Object.values(events)) {
    const o = matchPrev(e);
    const otw = o?.time_window;
    if (!o || !otw) continue;
    if (otw.pinned) {
      e.time_window = { ...otw }; // 钉住层：LOOP 免碰
    } else if (otw.source === "user" && e.time_window &&
      (e.time_window.start !== otw.start || e.time_window.end !== otw.end)) {
      softOverrides.push(`「${e.name}」你手动改的时间 ${otw.start ?? "?"}${otw.end ? `–${otw.end}` : ""} 被重排为 ${e.time_window.start ?? "?"}${e.time_window.end ? `–${e.time_window.end}` : ""}`);
    }
  }
  return softOverrides;
}

/** pin_event：图钉。钉住要求已有时间（无时间的钉没有意义）；拔钉随时可。 */
export function pinEvent(store: TripStore, eventId: string, pinned: boolean): void {
  const e = store.trip.events_v2?.[eventId];
  if (!e) throw new Error(`事件不存在：${eventId}`);
  if (pinned && !toMin(e.time_window?.start)) throw new Error("该事件还没有时间，无法钉住");
  store.snapshot("pin_event", { event_id: eventId });
  e.time_window = { ...(e.time_window ?? { source: "user" }), pinned };
  store.log("pin_event", { event_id: eventId, pinned }, null, { actor: "user" });
}
