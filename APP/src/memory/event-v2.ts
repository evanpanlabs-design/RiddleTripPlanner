/** 事件模型 v2（SPEC/event-model-v2.md §3/§6/§8 的工程落地）。
 *
 * 三类事件构成可嵌套的事件树：poi（点）/ route（线）/ aoi（面）。
 * LLM 提交扁平事件列表（tmp_id + parent_id + seq），服务端组装成树并强制结构校验。
 * 每个关键字段带 source 三级来源标记（api/user/llm_inference），llm_inference 不可作为校验依据。
 * v2 树是事实源；UI/D7 继续消费由 project-v1.ts 派生的 v1 视图（0.4.3 再切前台）。 */

// ---------------- 来源标记（SPEC §5） ----------------
export type Source = "api" | "user" | "llm_inference";
/** 事件整体权威来源：llm_inference=LLM 草案 / user=用户手动加 / api=数据源直接落图 */
export type Provenance = Source;

export interface TimeWindow {
  start?: string | null;   // "HH:MM"，不存绝对时间戳（SPEC §4.1）
  end?: string | null;
  source: Source | "blank"; // blank = 留空待共创（v1 迁移兼容）
}

export interface Cost { amount: number; currency: string; source: Source }

/** SPEC §4.2：对齐百度 regular_open_hour.periods，零转换成本 */
export interface OpeningDetail {
  periods: { open: { day: number; hour: number; minute: number }; close: { day: number; hour: number; minute: number } }[];
  text?: string | null;    // 百度 shop_hours 原文，展示兜底
  source: Source;
  fetched_at?: number;     // 数据新鲜度，缓存失效判断用
}

// ---------------- 基座 + 判别联合（SPEC §3.1） ----------------
export type EventKind = "poi" | "route" | "aoi";
export type EventStatus = "draft" | "active" | "dropped";

export interface EventBase {
  event_id: string;
  kind: EventKind;
  name: string;
  parent_id: string | null;     // null = 顶层
  seq: number;                  // 同级内顺序，从 1 开始
  day_refs: number[];           // 可跨日（夜班火车）
  time_window?: TimeWindow | null;
  cost?: Cost | null;
  status: EventStatus;
  provenance: Provenance;
  note?: string;
}

export interface PoiDetail {
  role: "activity" | "lodging" | "terminal";   // v1 anchor 升格为 poi 角色（SPEC §2.3）
  geo?: { lat: number; lng: number; source: Source } | null;   // GCJ02
  poi_ref?: { baidu_uid?: string | null; amap_poi_id?: string | null };
  category_tags?: string[];     // 百度 classified_poi_tag 拆分 / 高德 type
  scope_grade?: string | null;  // 景区等级（百度 scope_grade，如 AAAAA）
  opening_detail?: OpeningDetail | null;
  price?: { amount: number; desc?: string; source: Source } | null;
  rating?: { score: number; votes?: number; source: Source } | null;
  city?: string | null;         // 在线 POI 校验的同城 sanity 用
}

export type RouteMode = "步行" | "骑行" | "公交" | "地铁" | "驾车" | "火车" | "飞机" | "大巴";

export interface RouteDetail {
  mode: string;                 // LLM 自由文本，解析后归一到 RouteMode 语义
  from_ref: string;             // 两端事件 id（poi 或 aoi，SPEC §3.3/§6）
  to_ref: string;
  distance_m?: number | null;
  duration_s?: number | null;
  geometry: [number, number][]; // GCJ02 折线，已抽稀；空数组 = 待回填
  data_source: "amap_walk" | "amap_drive" | "amap_ride" | "amap_transit" | "baidu_transit" | "geodesic" | "estimated" | "empty";
  schedule?: {                  // 大交通真实班次（baidu_transit 才有）
    line: string; depart?: string; arrive?: string; price?: number | null; disclaimer?: string;
  } | null;
  is_entry_exit?: boolean;      // true = AOI 的进出段
}

export interface AoiDetail {
  boundary?: {
    polygon: [number, number][];                 // GCJ02，DP 抽稀后 ≤200 点
    source: "osm" | "envelope" | "user_confirmed";
    osm_relation_id?: number | null;
    attribution?: string;                        // ODbL 要求，source=osm 时必有
  } | null;
  opening_detail?: OpeningDetail | null;
  ticket?: { amount: number; desc?: string; source: Source } | null;
  envelope_fallback?: boolean;  // true = 边界是子事件外包络，UI 虚线面渲染
  /** 边界后台任务状态：pending=OSM 获取中 / done=已有真边界或包络 / failed=两条链都失败（已入清单共创） */
  boundary_status?: "pending" | "done" | "failed";
}

export interface EventV2 extends EventBase {
  detail: PoiDetail | RouteDetail | AoiDetail;
}
export interface PoiEvent extends EventBase { kind: "poi"; detail: PoiDetail }
export interface RouteEvent extends EventBase { kind: "route"; detail: RouteDetail }
export interface AoiEvent extends EventBase { kind: "aoi"; detail: AoiDetail }

export const isPoi = (e: EventV2): e is PoiEvent => e.kind === "poi";
export const isRoute = (e: EventV2): e is RouteEvent => e.kind === "route";
export const isAoi = (e: EventV2): e is AoiEvent => e.kind === "aoi";

// ---------------- 嵌套规则（SPEC §2.2） ----------------
/** children(poi)=∅；children(route)=route|poi；children(aoi)=poi|route；AOI 不套 AOI */
export function nestingAllowed(parent: EventKind, child: EventKind): boolean {
  if (parent === "poi") return false;
  if (parent === "route") return child === "route" || child === "poi";
  return child === "poi" || child === "route"; // aoi
}
export const MAX_DEPTH = 3; // aoi ⊃ route ⊃ poi 是合法最深链

// ---------------- 树工具 ----------------
export function childrenOf(events: Record<string, EventV2>, id: string | null): EventV2[] {
  return Object.values(events).filter(e => e.parent_id === id && e.status !== "dropped")
    .sort((a, b) => a.seq - b.seq);
}

export function depthOf(events: Record<string, EventV2>, e: EventV2): number {
  let d = 1, cur = e;
  while (cur.parent_id && events[cur.parent_id]) { d++; cur = events[cur.parent_id]; }
  return d;
}

/** 先序遍历（父→子按 seq），dropped 默认跳过 */
export function walkTree(events: Record<string, EventV2>, includeDropped = false): EventV2[] {
  const out: EventV2[] = [];
  const visit = (pid: string | null) => {
    const kids = Object.values(events).filter(e => e.parent_id === pid && (includeDropped || e.status !== "dropped"))
      .sort((a, b) => a.seq - b.seq);
    for (const k of kids) { out.push(k); visit(k.event_id); }
  };
  visit(null);
  return out;
}

// ---------------- LLM 草案格式（SPEC §6） ----------------
export interface DraftEvent {
  tmp_id: string;
  kind: EventKind;
  name: string;
  parent_id?: string | null;   // 引用其他 tmp_id
  seq?: number;
  day_refs: number[];
  time_window?: { start?: string | null; end?: string | null } | null;
  cost?: { amount: number; currency?: string } | null;
  note?: string;
  detail?: Record<string, unknown>;
}

export interface DraftV2 {
  days: number;
  events: DraftEvent[];
  checklist?: { title: string; category: "booking" | "item" | "info"; info_spec?: { what: string; expect: string; impact: string } | null }[];
}

export interface AssemblyError { code: string; message: string; tmp_ids?: string[] }
export type AssemblyResult =
  | { ok: true; events: Record<string, EventV2>; warnings: string[] }
  | { ok: false; errors: AssemblyError[] };

const eid = () => `evt_${Math.random().toString(16).slice(2, 10)}`;
const toMin = (hhmm?: string | null): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? "").trim());
  return m ? +m[1] * 60 + +m[2] : null;
};

/** 扁平草案 → 事件树（SPEC §6 服务端组装职责 1–3）。
 * 纯函数：只负责结构与时间窗，不做任何外部 IO（地理解析/边界获取在 applyDraftV2 管线）。 */
export function assembleDraft(draft: DraftV2): AssemblyResult {
  const errors: AssemblyError[] = [];
  const warnings: string[] = [];
  const list = draft.events ?? [];
  if (!list.length) return { ok: false, errors: [{ code: "EMPTY", message: "events 为空" }] };

  // 1. tmp_id 唯一性 + tmp_id → event_id 映射
  const seen = new Set<string>();
  for (const d of list) {
    if (!d.tmp_id || seen.has(d.tmp_id)) errors.push({ code: "DUP_TMP", message: `tmp_id「${d.tmp_id}」重复或为空` });
    seen.add(d.tmp_id);
    if (!["poi", "route", "aoi"].includes(d.kind)) errors.push({ code: "BAD_KIND", message: `事件「${d.name}」kind 非法：${d.kind}` });
  }
  if (errors.length) return { ok: false, errors };

  const idMap = new Map<string, string>(list.map(d => [d.tmp_id, eid()]));
  const events: Record<string, EventV2> = {};

  // 2. parent_id 悬空检查 + 建事件
  for (const d of list) {
    const pid = d.parent_id ?? null;
    if (pid && !idMap.has(pid)) {
      errors.push({ code: "DANGLING_PARENT", message: `事件「${d.name}」的 parent_id「${pid}」不存在`, tmp_ids: [d.tmp_id] });
      continue;
    }
    const ev: EventV2 = {
      event_id: idMap.get(d.tmp_id)!,
      kind: d.kind,
      name: d.name,
      parent_id: pid ? idMap.get(pid)! : null,
      seq: d.seq ?? 0, // 占位，§3 统一排序重排
      day_refs: Array.isArray(d.day_refs) && d.day_refs.length ? [...new Set(d.day_refs)].sort((a, b) => a - b) : [],
      time_window: d.time_window ? { start: d.time_window.start ?? null, end: d.time_window.end ?? null, source: d.time_window.start ? "llm_inference" : "blank" } : null,
      cost: d.cost ? { amount: d.cost.amount, currency: d.cost.currency ?? "CNY", source: "llm_inference" } : null,
      status: "draft",
      provenance: "llm_inference",   // LLM 草案整体来源；字段级 source 可更强（SPEC §5）
      note: (d.note ?? "").slice(0, 200),
      detail: buildDetail(d, idMap, errors),
    };
    events[ev.event_id] = ev;
  }
  if (errors.length) return { ok: false, errors };

  // 3. 嵌套规则 + 深度（SPEC §2.2）+ route 端点类型（SPEC §3.3）
  for (const ev of Object.values(events)) {
    if (ev.parent_id) {
      const parent = events[ev.parent_id];
      if (!nestingAllowed(parent.kind, ev.kind)) {
        errors.push({ code: "BAD_NESTING", message: `嵌套非法：${parent.kind}「${parent.name}」不能包含 ${ev.kind}「${ev.name}」` });
      }
      if (depthOf(events, ev) > MAX_DEPTH) {
        errors.push({ code: "TOO_DEEP", message: `嵌套深度超过 ${MAX_DEPTH}：「${ev.name}」——请拍平为同级 seq` });
      }
    }
    if (isRoute(ev)) {
      for (const ref of [ev.detail.from_ref, ev.detail.to_ref]) {
        const target = events[ref];
        if (!target) errors.push({ code: "DANGLING_ENDPOINT", message: `route「${ev.name}」端点 ${ref} 不存在` });
        else if (target.kind === "route") errors.push({ code: "BAD_ENDPOINT", message: `route「${ev.name}」的端点不能是 route（${target.name}）` });
      }
      // route 挂在 route 下时，端点可指向父 route 之外的事件（中转段），不额外约束
    }
  }
  if (errors.length) return { ok: false, errors };

  // 4. 同级按 seq 排序并重排为连续 1..n（LLM 给的 seq 只表达相对顺序，容忍缺号/重号）
  const byParent = new Map<string | null, EventV2[]>();
  for (const ev of Object.values(events)) {
    const k = ev.parent_id;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(ev);
  }
  // 稳定排序需要原始提交顺序做 tiebreak
  const order = new Map(list.map((d, i) => [idMap.get(d.tmp_id)!, i]));
  for (const kids of byParent.values()) {
    kids.sort((a, b) => (a.seq - b.seq) || (order.get(a.event_id)! - order.get(b.event_id)!));
    kids.forEach((k, i) => { k.seq = i + 1; });
  }

  // 5. 父事件时间窗 ⊇ 子事件并集（SPEC §2.2/§6.3）：不满足则 widen 父窗并记 llm_inference
  for (const parent of Object.values(events)) {
    const kids = childrenOf(events, parent.event_id);
    if (!kids.length) continue;
    const starts = kids.map(k => toMin(k.time_window?.start)).filter((v): v is number => v != null);
    const ends = kids.map(k => toMin(k.time_window?.end)).filter((v): v is number => v != null);
    if (!starts.length && !ends.length) continue;
    const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const pw = parent.time_window ?? { start: null, end: null, source: "blank" as const };
    const pStart = toMin(pw.start), pEnd = toMin(pw.end);
    let widened = false;
    if (starts.length && (pStart == null || Math.min(...starts) < pStart)) { pw.start = fmt(Math.min(...starts)); widened = true; }
    if (ends.length && (pEnd == null || Math.max(...ends) > pEnd)) { pw.end = fmt(Math.max(...ends)); widened = true; }
    if (widened) {
      pw.source = "llm_inference"; // widen 是推断，不可作为校验依据（SPEC §5）
      parent.time_window = pw;
      warnings.push(`父事件「${parent.name}」时间窗已按子事件并集拓宽为 ${pw.start}–${pw.end}（标记 llm_inference）`);
    }
  }

  // 6. AOI 进出段推断（SPEC §6.2）：AOI 的首/末子事件若不是 route 且未标 is_entry_exit，记 warning 提示
  for (const aoi of Object.values(events).filter(isAoi)) {
    const kids = childrenOf(events, aoi.event_id);
    if (kids.length >= 2) {
      for (const edgeKid of [kids[0], kids[kids.length - 1]]) {
        if (edgeKid.kind !== "route") warnings.push(`AOI「${aoi.name}」的${edgeKid === kids[0] ? "首" : "末"}子事件「${edgeKid.name}」不是 route，进出段可能缺失`);
      }
    }
  }

  return { ok: true, events, warnings };
}

function buildDetail(d: DraftEvent, idMap: Map<string, string>, errors: AssemblyError[]): PoiDetail | RouteDetail | AoiDetail {
  const raw = (d.detail ?? {}) as Record<string, any>;
  if (d.kind === "poi") {
    return {
      role: ["activity", "lodging", "terminal"].includes(raw.role) ? raw.role : "activity",
      geo: null,
      poi_ref: { baidu_uid: null, amap_poi_id: null },
      category_tags: [],
    } satisfies PoiDetail;
  }
  if (d.kind === "route") {
    const from = raw.from ?? raw.from_ref, to = raw.to ?? raw.to_ref;
    if (!from || !idMap.has(from)) errors.push({ code: "DANGLING_ENDPOINT", message: `route「${d.name}」缺少有效 from 端点`, tmp_ids: [d.tmp_id] });
    if (!to || !idMap.has(to)) errors.push({ code: "DANGLING_ENDPOINT", message: `route「${d.name}」缺少有效 to 端点`, tmp_ids: [d.tmp_id] });
    return {
      mode: String(raw.mode ?? "驾车"),
      from_ref: idMap.get(from) ?? String(from ?? ""),
      to_ref: idMap.get(to) ?? String(to ?? ""),
      distance_m: null, duration_s: null,
      geometry: [], data_source: "empty",
      schedule: null,
      is_entry_exit: !!raw.is_entry_exit,
    } satisfies RouteDetail;
  }
  return { boundary: null, opening_detail: null, ticket: null, envelope_fallback: false, boundary_status: "pending" } satisfies AoiDetail;
}

// ---------------- V8 链条完整（SPEC §8，schema 层硬校验） ----------------
/** 同日相邻顶层活动事件（poi/aoi，含 lodging/terminal）之间必须存在 route 连接。
 * v2 把"走得通"从 prompt 约束升级为 schema 校验：漏了就是校验失败打回，不再工程兜底补边。
 * 跨日相邻（夜班火车）按 day_refs 任一共同日判断；无时间窗时按 seq 顺序。 */
export function checkChainCompleteness(events: Record<string, EventV2>): AssemblyError[] {
  const errors: AssemblyError[] = [];
  const top = childrenOf(events, null).filter(e => e.kind !== "route");
  const routes = childrenOf(events, null).filter(isRoute);
  const linked = (a: string, b: string) =>
    routes.some(r => (r.detail.from_ref === a && r.detail.to_ref === b) || (r.detail.from_ref === b && r.detail.to_ref === a));

  const days = [...new Set(top.flatMap(e => e.day_refs))].sort((a, b) => a - b);
  for (const day of days) {
    const dayEvents = top.filter(e => e.day_refs.includes(day))
      .sort((x, y) => (toMin(x.time_window?.start) ?? 9999) - (toMin(y.time_window?.start) ?? 9999) || x.seq - y.seq);
    for (let i = 0; i + 1 < dayEvents.length; i++) {
      const a = dayEvents[i], b = dayEvents[i + 1];
      if (a.event_id === b.event_id) continue;
      // route 可能本身就是顶层（连接两个顶层活动）；嵌套在 aoi 内的通勤不影响顶层链条
      if (!linked(a.event_id, b.event_id)) {
        errors.push({
          code: "V8_CHAIN_BROKEN",
          message: `Day${day}：「${a.name}」与「${b.name}」之间缺少 route 通勤事件——请补充一个 kind=route 的事件（mode 写明真实通勤方式）连接它们`,
          tmp_ids: [a.event_id, b.event_id],
        });
      }
    }
  }
  return errors;
}
