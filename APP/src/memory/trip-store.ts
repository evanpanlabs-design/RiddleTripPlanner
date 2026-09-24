/** 领域记忆：Trip 图状态 + 审计记忆（event sourcing 操作日志）。
 * 移植自 LAB/lab02 models.py + store.py，schema 保持一致。 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EventV2 } from "./event-v2.ts";
import { isAoi, isPoi, isRoute, walkTree } from "./event-v2.ts";
import { migrateTripV1toV2 } from "./migrate-v2.ts";

export const STAGES = ["explore", "planning", "preparing", "ready"] as const;
export type Stage = typeof STAGES[number];

export interface Node_ { node_id: string; name: string; anchor: "none" | "lodging" | "terminal"; geo?: { lat: number; lng: number } | null; amap_poi_id?: string | null; category_tags?: string[]; opening_hours?: unknown | null; city?: string | null; }
export interface Edge_ { edge_id: string; from_id: string; to_id: string; mode: string; distance_m?: number | null; duration_s?: number | null; data_source: string; geometry?: unknown[]; }
export interface Event_ { event_id: string; anchor_kind: "node" | "edge"; anchor_ref: string; kind: string; day_refs: number[]; time_window?: { start?: string | null; end?: string | null; source?: string } | null; cost?: number | null; status: "candidate" | "tentative" | "locked"; note: string; }
export interface ChecklistItem_ { item_id: string; title: string; category: "booking" | "item" | "info"; info_spec?: { what: string; expect: string; impact: string } | null; done: boolean; due_offset_days?: number | null; note?: string | null; }
export interface CandidateItem_ { item_id: string; name: string; source_material: string; status: "pooled" | "promoted" | "discarded"; }

export interface Trip {
  trip_id: string; stage: Stage; days: number; destination: string[];
  slots: Record<string, unknown>;
  checklist: Record<string, ChecklistItem_>;
  candidate_pool: Record<string, CandidateItem_>;
  /** v2 事件树（0.4.1 起的事实源；0.4.3 起所有消费方直读它） */
  events_v2?: Record<string, EventV2>;
  /** 用户绕过对话的手动操作（如手动勾选清单），注入状态摘要让 LLM 知晓 */
  user_actions?: { ts: number; text: string }[];
  /** legacy v1 扁平结构：仅存于旧 trip.json/ops 快照，作为惰性迁移的输入；0.4.3 起不再生成/维护/下发 */
  nodes?: Record<string, Node_>; edges?: Record<string, Edge_>;
  events?: Record<string, Event_>;
}

const nid = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

export function emptyTrip(): Trip {
  return {
    trip_id: nid("trip"), stage: "explore", days: 0, destination: [],
    slots: { destination: [], date_range: null, origin: null, budget_band: null, party: null, pace: null, interests: [], stay_pref: null, mobility: null },
    checklist: {}, candidate_pool: {},
    events_v2: {},
    user_actions: [],
  };
}

/** D3 阶段门槛（机械检查，T2） */
/** destination 读取统一入口：历史数据里 slots.destination 可能是裸字符串，一律按数组取（源头归一在 updateSlot，此处防御旧数据） */
export function destList(t: Trip): string[] {
  const v: unknown = t.destination.length ? t.destination : t.slots.destination;
  if (Array.isArray(v)) return v as string[];
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

export function gateReport(t: Trip): { stage: Stage; missing: string[] } {
  const missing: string[] = [];
  if (!destList(t).length) missing.push("S1_destination");
  if (!t.slots.date_range && !t.days) missing.push("S2_date_range");
  let stage: Stage = "explore";
  if (!missing.length) {
    stage = "planning";
    const live = Object.values(t.events_v2 ?? {}).filter(e => e.status !== "dropped");
    const drafts = live.filter(e => e.status === "draft");
    if (live.length && !drafts.length) {
      stage = "preparing";
      const items = Object.values(t.checklist);
      if (items.length && items.every(c => c.done)) stage = "ready";
    }
  }
  return { stage, missing };
}

/** 给 Jev/LLM 的紧凑状态摘要（0.4.3 起直读 v2 树） */
export function tripSummary(t: Trip) {
  const tree = walkTree(t.events_v2 ?? {});
  return {
    stage: t.stage, days: t.days, slots: t.slots,
    nodes: tree.filter(e => isPoi(e) || isAoi(e)).map(e => ({ id: e.event_id, name: e.name, role: isPoi(e) ? e.detail.role : "aoi", parent: e.parent_id })),
    events: tree.map(e => ({ id: e.event_id, kind: e.kind, name: e.name, days: e.day_refs, tw: e.time_window, status: e.status, parent: e.parent_id, note: (e.note ?? "").slice(0, 80) })),
    candidate_pool: Object.values(t.candidate_pool).map(c => ({ id: c.item_id, name: c.name, status: c.status })),
    checklist: Object.values(t.checklist).map(c => ({ id: c.item_id, title: c.title, done: c.done, note: c.note ?? null })),  // 实体级勾选：LLM 依此提 item_id；note 是用户补记的完成细节
    checklist_open: Object.values(t.checklist).filter(c => !c.done).length,
    // 用户手动操作（未经过对话）：让 LLM 知道"这件事人自己干了"，避免重复确认或误判差异
    user_actions: (t.user_actions ?? []).slice(-5).map(a => a.text),
  };
}

/** 记录一条用户手动操作（保留最近 8 条） */
export function recordUserAction(t: Trip, text: string) {
  t.user_actions = [...(t.user_actions ?? []), { ts: Date.now(), text }].slice(-8);
}

/** D7 审阅用自然语言方案描述（含 checklist 状态，避免 V7 误报；0.4.3 起直读 v2 树，嵌套事件带父级前缀） */
export function planDesc(t: Trip): string {
  const events = t.events_v2 ?? {};
  const nameOf = (id: string) => events[id]?.name ?? "?";
  const lines = [`共${t.days}天，目的地：${destList(t).join("、") || "未定"}`];
  for (let day = 1; day <= t.days; day++) {
    const evs = walkTree(events).filter(e => e.day_refs.includes(day))
      .sort((a, b) => (a.time_window?.start ?? "99").localeCompare(b.time_window?.start ?? "99") || a.seq - b.seq);
    const parts = evs.map(e => {
      const span = e.time_window ? `${e.time_window.start ?? "?"}–${e.time_window.end ?? "?"}` : "时间未定";
      const scope = e.parent_id && events[e.parent_id] ? `${nameOf(e.parent_id)}/` : "";
      let label: string;
      if (isRoute(e)) label = `transit:${scope}${nameOf(e.detail.from_ref)}→${nameOf(e.detail.to_ref)}(${e.detail.mode})`;
      else if (isAoi(e)) label = `aoi:${e.name}`;
      else if (isPoi(e)) label = `${e.detail.role === "lodging" ? "lodging" : e.detail.role === "terminal" ? "terminal" : "visit"}:${scope}${e.name}`;
      else label = `visit:${scope}${e.name}`;
      return `${span} ${label}`;
    });
    lines.push(`Day${day}: ${parts.join("；")}`);
  }
  const items = Object.values(t.checklist);
  if (items.length) lines.push(`准备清单：${items.map(c => `${c.title}(${c.done ? "已办" : "待办"}${c.note ? `，补记：${c.note}` : ""})`).join("、")}`);
  return lines.join("\n");
}

/** 审计记忆：event sourcing 操作日志 + 快照 + undo */
export class TripStore {
  trip: Trip;
  readonly dir: string;
  private opsPath: string;
  private applied: any[] = [];

  constructor(trip?: Trip, runsRoot = join(import.meta.dirname, "../../runs")) {
    this.trip = trip ?? emptyTrip();
    this.dir = join(runsRoot, this.trip.trip_id);
    mkdirSync(this.dir, { recursive: true });
    this.opsPath = join(this.dir, "ops.jsonl");
    if (existsSync(this.opsPath)) {
      this.applied = readFileSync(this.opsPath, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
    }
    // v1 → v2 惰性迁移（SPEC/event-model-v2.md §9）：有 v1 数据但无 v2 树时触发。
    // 0.4.3 起 v1 投影桥退役：迁移后丢掉 legacy 三表，v2 树成为内存与落盘的唯一事实源。
    if (this.trip.events_v2 === undefined && (Object.keys(this.trip.events ?? {}).length || Object.keys(this.trip.nodes ?? {}).length)) {
      const { events, warnings } = migrateTripV1toV2(this.trip);
      this.trip.events_v2 = events;
      if (warnings.length) console.warn(`[migrate-v2] trip=${this.trip.trip_id}: ${warnings.join("；")}`);
    }
    this.trip.events_v2 ??= {};
    delete this.trip.nodes; delete this.trip.edges; delete this.trip.events;
    this.save();
  }

  save() {
    // 防御：undo 恢复的历史快照可能带 legacy v1 三表——落盘前一律剥掉，磁盘只存 v2 事实源
    const { nodes: _n, edges: _e, events: _v, ...persist } = this.trip;
    writeFileSync(join(this.dir, "trip.json"), JSON.stringify(persist, null, 2));
  }

  /** 只读访问已应用操作日志（供 UI 操作日志面板） */
  get ops(): readonly any[] { return this.applied; }

  log(op: string, payload: unknown, undo: unknown, meta: unknown = {}) {
    const rec = { seq: this.applied.length + 1, ts: Date.now(), op, payload, undo, meta };
    appendFileSync(this.opsPath, JSON.stringify(rec) + "\n");
    this.applied.push(rec);
    this.save();
  }

  /** 生成/大改前快照 */
  snapshot(op: string, meta: unknown = {}) {
    this.log(op, {}, { kind: "restore_trip", trip: JSON.parse(JSON.stringify(this.trip)) }, meta);
  }

  undo(): any | null {
    const rec = this.applied.pop();
    if (!rec) return null;
    if (rec.undo?.kind === "restore_trip") this.trip = rec.undo.trip;
    if (rec.undo?.kind === "restore_slots") this.trip.slots = rec.undo.slots;
    writeFileSync(this.opsPath, this.applied.map(r => JSON.stringify(r)).join("\n") + (this.applied.length ? "\n" : ""));
    this.trip.stage = gateReport(this.trip).stage;
    this.save();
    return rec;
  }
}
