/** 领域记忆：Trip 图状态 + 审计记忆（event sourcing 操作日志）。
 * 移植自 LAB/lab02 models.py + store.py，schema 保持一致。 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const STAGES = ["explore", "planning", "preparing", "ready"] as const;
export type Stage = typeof STAGES[number];

export interface Node_ { node_id: string; name: string; anchor: "none" | "lodging" | "terminal"; geo?: { lat: number; lng: number } | null; amap_poi_id?: string | null; category_tags?: string[]; opening_hours?: unknown | null; }
export interface Edge_ { edge_id: string; from_id: string; to_id: string; mode: string; distance_m?: number | null; duration_s?: number | null; data_source: string; geometry?: unknown[]; }
export interface Event_ { event_id: string; anchor_kind: "node" | "edge"; anchor_ref: string; kind: string; day_refs: number[]; time_window?: { start?: string | null; end?: string | null; source?: string } | null; cost?: number | null; status: "candidate" | "tentative" | "locked"; note: string; }
export interface ChecklistItem_ { item_id: string; title: string; category: "booking" | "item" | "info"; info_spec?: { what: string; expect: string; impact: string } | null; done: boolean; due_offset_days?: number | null; }
export interface CandidateItem_ { item_id: string; name: string; source_material: string; status: "pooled" | "promoted" | "discarded"; }

export interface Trip {
  trip_id: string; stage: Stage; days: number; destination: string[];
  slots: Record<string, unknown>;
  nodes: Record<string, Node_>; edges: Record<string, Edge_>;
  events: Record<string, Event_>; checklist: Record<string, ChecklistItem_>;
  candidate_pool: Record<string, CandidateItem_>;
}

const nid = (p: string) => `${p}_${randomUUID().slice(0, 8)}`;

export function emptyTrip(): Trip {
  return {
    trip_id: nid("trip"), stage: "explore", days: 0, destination: [],
    slots: { destination: [], date_range: null, origin: null, budget_band: null, party: null, pace: null, interests: [], stay_pref: null },
    nodes: {}, edges: {}, events: {}, checklist: {}, candidate_pool: {},
  };
}

/** D3 阶段门槛（机械检查，T2） */
export function gateReport(t: Trip): { stage: Stage; missing: string[] } {
  const missing: string[] = [];
  if (!(t.slots.destination as string[])?.length && !t.destination.length) missing.push("S1_destination");
  if (!t.slots.date_range && !t.days) missing.push("S2_date_range");
  let stage: Stage = "explore";
  if (!missing.length) {
    stage = "planning";
    const tentatives = Object.values(t.events).filter(e => e.status === "tentative");
    if (Object.keys(t.events).length && !tentatives.length) {
      stage = "preparing";
      const items = Object.values(t.checklist);
      if (items.length && items.every(c => c.done)) stage = "ready";
    }
  }
  return { stage, missing };
}

/** 给 Jev/LLM 的紧凑状态摘要 */
export function tripSummary(t: Trip) {
  return {
    stage: t.stage, days: t.days, slots: t.slots,
    nodes: Object.values(t.nodes).map(n => ({ id: n.node_id, name: n.name, anchor: n.anchor })),
    events: Object.values(t.events).map(e => ({ id: e.event_id, kind: e.kind, days: e.day_refs, tw: e.time_window, status: e.status, note: e.note.slice(0, 80) })),
    candidate_pool: Object.values(t.candidate_pool).map(c => ({ id: c.item_id, name: c.name, status: c.status })),
    checklist: Object.values(t.checklist).map(c => ({ id: c.item_id, title: c.title, done: c.done })),  // 实体级勾选：LLM 依此提 item_id
    checklist_open: Object.values(t.checklist).filter(c => !c.done).length,
  };
}

/** D7 审阅用自然语言方案描述（含 checklist 状态，避免 V7 误报） */
export function planDesc(t: Trip): string {
  const lines = [`共${t.days}天，目的地：${t.destination.join("、") || (t.slots.destination as string[])?.join("、") || "未定"}`];
  for (let day = 1; day <= t.days; day++) {
    const evs = Object.values(t.events).filter(e => e.day_refs.includes(day))
      .sort((a, b) => (a.time_window?.start ?? "99").localeCompare(b.time_window?.start ?? "99"));
    const parts = evs.map(e => {
      const span = e.time_window ? `${e.time_window.start ?? "?"}–${e.time_window.end ?? "?"}` : "时间未定";
      let name = e.note;
      if (e.anchor_kind === "node" && t.nodes[e.anchor_ref]) name = t.nodes[e.anchor_ref].name;
      if (e.anchor_kind === "edge" && t.edges[e.anchor_ref]) {
        const ed = t.edges[e.anchor_ref];
        name = `${t.nodes[ed.from_id]?.name ?? "?"}→${t.nodes[ed.to_id]?.name ?? "?"}(${ed.mode})`;
      }
      return `${span} ${e.kind}:${name}`;
    });
    lines.push(`Day${day}: ${parts.join("；")}`);
  }
  const items = Object.values(t.checklist);
  if (items.length) lines.push(`准备清单：${items.map(c => `${c.title}(${c.done ? "已办" : "待办"})`).join("、")}`);
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
  }

  save() { writeFileSync(join(this.dir, "trip.json"), JSON.stringify(this.trip, null, 2)); }

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
