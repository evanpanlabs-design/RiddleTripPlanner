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
/** 0.5 三层时间模型：true = 钉住层（用户锚点，LOOP 免碰只能用户拔钉）；
 * 未钉时 source=user 为用户软值（LOOP 可调但必须明说留痕），其余为派生层（顺序变即重算） */
pinned?: boolean;
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
  /** 0.5：端点顺序/交通方式被用户改过后置 true——里程/耗时/几何待下轮 LOOP 重算，D7 未清计入 fails */
  stale?: boolean;
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
        const fix = parent.kind === "poi"
          ? `修复：若「${parent.name}」是景区/区域，请改为 kind=aoi 再容纳子事件；否则把「${ev.name}」拍平为顶层事件（去掉 parent_id）`
          : `修复：AOI 不能套 AOI，把「${ev.name}」拍平或改挂到顶层`;
        errors.push({ code: "BAD_NESTING", message: `嵌套非法：${parent.kind}「${parent.name}」不能包含 ${ev.kind}「${ev.name}」。${fix}` });
      }
      if (depthOf(events, ev) > MAX_DEPTH) {
        errors.push({ code: "TOO_DEEP", message: `嵌套深度超过 ${MAX_DEPTH}：「${ev.name}」——请拍平为同级 seq` });
      }
    }
    if (isRoute(ev)) {
      for (const ref of [ev.detail.from_ref, ev.detail.to_ref]) {
        const target = events[ref];
        if (!target) errors.push({ code: "DANGLING_ENDPOINT", message: `route「${ev.name}」端点 ${ref} 不存在。修复：detail.from/to 必须填同批提交事件里某个 poi/aoi 的 tmp_id（不是事件名）` });
        else if (target.kind === "route") errors.push({ code: "BAD_ENDPOINT", message: `route「${ev.name}」的端点不能是 route（${target.name}）。修复：端点改为该 route 两端poi/aoi 的 tmp_id；如需表达中转，把中转段作为子 route 挂在父 route 下` });
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
    if (!from || !idMap.has(from)) errors.push({ code: "DANGLING_ENDPOINT", message: `route「${d.name}」缺少有效 from 端点（填同批某 poi/aoi 的 tmp_id）`, tmp_ids: [d.tmp_id] });
    if (!to || !idMap.has(to)) errors.push({ code: "DANGLING_ENDPOINT", message: `route「${d.name}」缺少有效 to 端点（填同批某 poi/aoi 的 tmp_id）`, tmp_ids: [d.tmp_id] });
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

// ---------------- V8 链条完整（SPEC §8，schema 层硬校验，0.4.2 嵌套感知） ----------------
/** id 及其全部后代（非 dropped）：端点指向 AOI 内部子事件 ≡ 指向该 AOI。 */
function selfAndDescendants(events: Record<string, EventV2>, id: string): Set<string> {
  const out = new Set<string>([id]);
  const walk = (pid: string) => {
    for (const k of childrenOf(events, pid)) { out.add(k.event_id); walk(k.event_id); }
  };
  walk(id);
  return out;
}

/** 同日相邻活动事件（poi/aoi，含 lodging/terminal）之间必须存在 route 连接——嵌套感知：
 * ① 顶层链条：route 端点落在 a/b 各自子树内即算连接（AOI 的出园段可嵌在 AOI 内，端点指其子事件）；
 * ② AOI 内部链条：同一 AOI 下同日相邻的子活动之间同样必须有 route（景区内通勤/观光车/步行段）。
 * v2 把"走得通"从 prompt 约束升级为 schema 校验：漏了就是校验失败打回，不再工程兜底补边。
 * 跨日相邻（夜班火车）按 day_refs 任一共同日判断；无时间窗时按 seq 顺序。 */
export function checkChainCompleteness(events: Record<string, EventV2>): AssemblyError[] {
  const errors: AssemblyError[] = [];
  const routes = Object.values(events).filter(isRoute);
  const linked = (a: string, b: string) => {
    const da = selfAndDescendants(events, a), db = selfAndDescendants(events, b);
    return routes.some(r =>
      (da.has(r.detail.from_ref) && db.has(r.detail.to_ref)) || (db.has(r.detail.from_ref) && da.has(r.detail.to_ref)));
  };
  // 同一父级下按日分组检查相邻活动链条；scope 为空串=顶层，否则=AOI 名（用于报错文案）
  const checkLevel = (kids: EventV2[], scope: string) => {
    const acts = kids.filter(e => e.kind !== "route");
    const days = [...new Set(acts.flatMap(e => e.day_refs))].sort((a, b) => a - b);
    for (const day of days) {
      const dayEvents = acts.filter(e => e.day_refs.includes(day))
        .sort((x, y) => (toMin(x.time_window?.start) ?? 9999) - (toMin(y.time_window?.start) ?? 9999) || x.seq - y.seq);
      for (let i = 0; i + 1 < dayEvents.length; i++) {
        const a = dayEvents[i], b = dayEvents[i + 1];
        if (a.event_id === b.event_id) continue;
        if (linked(a.event_id, b.event_id)) continue;
        errors.push({
          code: "V8_CHAIN_BROKEN",
          message: scope
            ? `Day${day}：景区「${scope}」内部「${a.name}」与「${b.name}」之间缺少 route 通勤段——景区内相邻活动也需要 route（观光车/步行/索道等）连接，detail.from/to 填这两个子事件的 tmp_id`
            : `Day${day}：「${a.name}」与「${b.name}」之间缺少 route 通勤事件——请补充一个 kind=route 的事件（mode 写明真实通勤方式）连接它们；若其中一方是景区，端点也可填该景区内部的出入口子事件`,
          tmp_ids: [a.event_id, b.event_id],
        });
      }
    }
  };
  checkLevel(childrenOf(events, null), "");
  for (const aoi of Object.values(events).filter(isAoi)) {
    checkLevel(childrenOf(events, aoi.event_id), aoi.name);
  }
  return errors;
}

// ---------------- Q1–Q3 方案质量判断（0.4.3，SPEC §8 质量族） ----------------
/** 机械质量校验：吃 0.4.1 抓回的 detail 字段（geo/opening_detail/route 耗时）。
 * 与 V 族结构校验的区别：V 族判"结构对不对"，Q 族判"方案好不好"。
 * llm_inference 来源的字段按 SPEC §5 不作为校验依据。 */
export interface QualityProblem { code: "Q1_BACKTRACK" | "Q2_INTENSITY" | "Q3_OPENING_CONFLICT" | "Q4_MOBILITY"; message: string; ids: string[] }
export interface PlanQuality { hard: QualityProblem[]; advisories: QualityProblem[] }

/** haversine 距离（米）。memory 层保持零依赖，不引 tools/amap */
function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** 事件坐标：poi 取 detail.geo；aoi 取首个有坐标后代（与 UI 占位同一规则） */
function geoOfEvent(events: Record<string, EventV2>, e: EventV2): { lat: number; lng: number } | null {
  if (isPoi(e)) return e.detail.geo ?? null;
  const queue = [...childrenOf(events, e.event_id)];
  while (queue.length) {
    const k = queue.shift()!;
    if (isPoi(k) && k.detail.geo) return k.detail.geo;
    queue.push(...childrenOf(events, k.event_id));
  }
  return null;
}

/** 出发日期把 day_refs 映射为星期几；百度 regular_open_hour.periods.day：1=周一 … 7=周日 */
function baiduWeekday(startDate: string, day: number): number | null {
  const base = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  const d = new Date(base.getTime() + (day - 1) * 86400_000);
  const js = d.getUTCDay(); // 0=周日 … 6=周六
  return js === 0 ? 7 : js;
}

const fmtKm = (m: number) => (m / 1000).toFixed(0);

export function checkPlanQuality(
  events: Record<string, EventV2>,
  opts: { startDate?: string | null; days?: number; mobility?: string | null } = {},
): PlanQuality {
  const hard: QualityProblem[] = [];
  const advisories: QualityProblem[] = [];
  const live = Object.values(events).filter(e => e.status !== "dropped");

  // ---- Q1 动线折返（建议级）：同一父级同日活动链 A→B→C 明显回头 ----
  const checkBacktrack = (kids: EventV2[], scope: string) => {
    const acts = kids.filter(e => e.kind !== "route");
    const days = [...new Set(acts.flatMap(e => e.day_refs))].sort((a, b) => a - b);
    for (const day of days) {
      const chain = acts.filter(e => e.day_refs.includes(day))
        .sort((x, y) => (toMin(x.time_window?.start) ?? 9999) - (toMin(y.time_window?.start) ?? 9999) || x.seq - y.seq)
        .map(e => ({ e, geo: geoOfEvent(events, e) }));
      for (let i = 0; i + 2 < chain.length; i++) {
        const [A, B, C] = [chain[i], chain[i + 1], chain[i + 2]];
        if (!A.geo || !B.geo || !C.geo) continue;
        const dAB = haversineM(A.geo, B.geo), dBC = haversineM(B.geo, C.geo), dAC = haversineM(A.geo, C.geo);
        // 回头判定：AC 明显短于 AB/BC（B 是远离的折点）且绕行总量有实际代价（>20km）
        if (dAB + dBC > 20_000 && dAC < 0.6 * Math.min(dAB, dBC)) {
          advisories.push({
            code: "Q1_BACKTRACK",
            message: `Day${day}${scope ? `（${scope}）` : ""}：「${A.e.name}」→「${B.e.name}」→「${C.e.name}」动线折返——${fmtKm(dAB)}km + ${fmtKm(dBC)}km 的往返，但「${A.e.name}」与「${C.e.name}」仅相距 ${fmtKm(dAC)}km，建议调整顺序或合并同一天`,
            ids: [A.e.event_id, B.e.event_id, C.e.event_id],
          });
        }
      }
    }
  };
  checkBacktrack(childrenOf(events, null), "");
  for (const aoi of live.filter(isAoi)) checkBacktrack(childrenOf(events, aoi.event_id), aoi.name);

  // ---- Q2 强度均匀（建议级）：单日过满 / 空置 ----
  const totalDays = opts.days ?? Math.max(0, ...live.flatMap(e => e.day_refs));
  if (totalDays > 1) {
    const dayStats: { acts: number; commuteS: number }[] = [];
    for (let day = 1; day <= totalDays; day++) {
      // 活动计数：叶子访问（poi activity）+ 无子事件的 aoi 各计 1，避免父子双计
      const acts = live.filter(e => e.day_refs.includes(day) && (
        (isPoi(e) && e.detail.role === "activity") ||
        (isAoi(e) && !childrenOf(events, e.event_id).some(k => k.day_refs.includes(day) && k.kind !== "route"))
      )).length;
      const commuteS = live.filter(e => isRoute(e) && e.day_refs.includes(day) && e.detail.data_source !== "empty")
        .reduce((s, e) => s + ((e as RouteEvent).detail.duration_s ?? 0), 0);
      dayStats.push({ acts, commuteS });
    }
    const busy = Math.max(...dayStats.map(s => s.acts));
    dayStats.forEach((s, i) => {
      if (s.acts >= 8) advisories.push({ code: "Q2_INTENSITY", message: `Day${i + 1}：当天 ${s.acts} 个活动，密度过高，建议拆分到相邻天`, ids: [] });
      else if (s.commuteS >= 4 * 3600) advisories.push({ code: "Q2_INTENSITY", message: `Day${i + 1}：当天通勤合计约 ${(s.commuteS / 3600).toFixed(1)} 小时，在路上的时间过长，建议压缩或调整住宿锚点`, ids: [] });
      else if (s.acts === 0 && busy >= 4) advisories.push({ code: "Q2_INTENSITY", message: `Day${i + 1}：当天没有安排活动，而其他天有多达 ${busy} 个——强度不均，建议匀一匀`, ids: [] });
    });
  }

  // ---- Q3 营业时段冲突（硬校验）：计划到达时间落在当天开放时段之外 ----
  if (opts.startDate) {
    for (const e of live) {
      if (!isPoi(e) && !isAoi(e)) continue;
      const od = e.detail.opening_detail;
      if (!od || od.source === "llm_inference" || !od.periods?.length) continue; // SPEC §5：推断数据不作校验依据
      const startMin = toMin(e.time_window?.start);
      const day = e.day_refs[0];
      if (startMin == null || day == null) continue;
      const wd = baiduWeekday(opts.startDate, day);
      if (wd == null) continue;
      const open = od.periods.some(p => {
        if (p.open.day !== wd) return false;
        const oMin = p.open.hour * 60 + p.open.minute;
        if (startMin < oMin) return false;
        // 跨夜段（close.day≠open.day）只判下限；当日段判到达时间在关门前
        if (p.close.day === p.open.day) return startMin <= p.close.hour * 60 + p.close.minute;
        return true;
      });
      if (!open) {
        const wdLabel = ["一", "二", "三", "四", "五", "六", "日"][wd - 1];
        hard.push({
          code: "Q3_OPENING_CONFLICT",
          message: `Day${day}「${e.name}」计划 ${e.time_window?.start} 到达，但周${wdLabel}不在其开放时段内（${od.text || `${od.periods.length} 个开放时段`}）——请调整该日的到访时间或改期`,
          ids: [e.event_id],
        });
      }
    }
  }
  // ---- Q4 出行方式一致性（建议级，0.5 e6）：mobility=self_drive 时同城段不应是公交/地铁 ----
  if (opts.mobility === "self_drive") {
    const LOCAL_TRANSIT = new Set(["公交", "地铁"]);
    for (const r of live.filter(isRoute)) {
      // 跨城段（火车/飞机/大巴）不受自驾约束；只查同城公共交通段
      if (LOCAL_TRANSIT.has(r.detail.mode)) {
        advisories.push({
          code: "Q4_MOBILITY",
          message: `「${r.name}」是${r.detail.mode}段，但出行方式槽位是自驾——建议改为驾车或向用户确认该段不开车`,
          ids: [r.event_id],
        });
      }
    }
  }
  return { hard, advisories };
}
