/** 0.6 地理合理性校验 + 非常规通勤路由策略（纯函数，零 IO，可单测）。
 *
 * 设计原则（防抱死是一等约束）：
 *  - 硬校验只拦「铁证」级错误：坐标/距离/行政区划的确定性矛盾，打回文案必须带
 *    具体修复指引（错误坐标、白名单范围、建议的重查词），让模型一次改对；
 *  - 证据不足一律放行（fail-open）：坐标缺失、城市未解析、白名单解析失败都不拦；
 *  - 同一问题连续打回 N 次仍过不去，由 agent 层降级为 advisory 转人工（见 agent.ts
 *    geoStreak），绝不重演 V1/V6 式循环打回死局。
 *
 * 包含三块：
 *  1. checkGeoSanity：H1 父子地理包含 / H2 行政区划白名单 / H3 方式-距离常识；
 *  2. 非常规通勤（索道/摆渡船/景交车）路由策略推测——无 API 真实路径，零调用，
 *     距离乘绕行系数、耗时按典型速度、几何用直线/弧线，data_source=estimated；
 *  3. 通勤方式词表（从 agent.ts 收敛至此，agent 与校验共用一份事实源）。 */

import { isAoi, isPoi, isRoute, childrenOf, type EventV2, type RouteEvent, type QualityProblem } from "./event-v2.ts";

/* ================= 通勤方式词表（agent.ts 与校验共用的事实源） ================= */
export const DRIVE = new Set(["drive", "驾车", "自驾", "开车", "车程", "包车", "打车", "出租车", "网约车"]);
export const WALK = new Set(["walk", "walking", "步行", "走路", "徒步", "散步", "citywalk"]);
export const BIKE = new Set(["bike", "bicycle", "cycling", "骑行", "骑车", "自行车", "单车", "共享单车"]);
export const CITY = new Set(["metro", "subway", "公交", "地铁", "巴士", "公车", "电车", "公共交通", "bus"]);
export const GEO = new Set(["geodesic", "直线", "测地线"]);
export const TRAIN = new Set(["train", "rail", "railway", "火车", "高铁", "动车", "城际"]);
export const FLIGHT = new Set(["flight", "plane", "飞机", "航班"]);
export const COACH = new Set(["coach", "大巴", "客运", "班车"]);
// 0.6 非常规通勤：无 API 真实路径，走路由策略推测
export const CABLE = new Set(["索道", "缆车", "cable", "cableway", "ropeway"]);
export const FERRY = new Set(["摆渡", "摆渡船", "游船", "观光船", "轮渡", "ferry", "boat", "cruise"]);
export const SHUTTLE = new Set(["景交车", "观光车", "景区车", "景区巴士", "接驳车", "摆渡车", "环保车", "shuttle"]);

/* ================= 距离与几何 ================= */
export function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371000, rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** 二次贝塞尔弧线（摆渡船=河道弯曲 / 景交车=园区路弯）；bend 为弦长的垂直偏移比例 */
export function arcGeom(a: { lng: number; lat: number }, b: { lng: number; lat: number }, bend: number, n = 16): [number, number][] {
  const mx = (a.lng + b.lng) / 2, my = (a.lat + b.lat) / 2;
  const dx = b.lng - a.lng, dy = b.lat - a.lat;
  const len = Math.hypot(dx, dy) || 1e-9;
  const cx = mx + (-dy / len) * len * bend, cy = my + (dx / len) * len * bend;
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([
      +(u * u * a.lng + 2 * u * t * cx + t * t * b.lng).toFixed(6),
      +(u * u * a.lat + 2 * u * t * cy + t * t * b.lat).toFixed(6),
    ]);
  }
  return pts;
}

/* ================= 非常规通勤路由策略 ================= */
export type SpecialRouteKind = "cable" | "ferry" | "shuttle";
export function specialRouteKind(mode: string): SpecialRouteKind | null {
  return CABLE.has(mode) ? "cable" : FERRY.has(mode) ? "ferry" : SHUTTLE.has(mode) ? "shuttle" : null;
}

const STRATEGY: Record<SpecialRouteKind, { bend: number; detour: number; speedMs: number; label: string }> = {
  cable:   { bend: 0,    detour: 1.05, speedMs: 5,   label: "索道直线" },       // 索道基本直线，速度 3-7 m/s
  ferry:   { bend: 0.18, detour: 1.2,  speedMs: 3.5, label: "起止点+河道弧线" }, // 摆渡/观光船沿河走，有弯曲
  shuttle: { bend: 0.08, detour: 1.35, speedMs: 7,   label: "起止点+园区路推测" }, // 景交车沿园区主路，绕行明显
};

/** 非常规通勤段数据推测（原地修改 detail）。零 API 调用：距离=测地线×绕行系数，
 * 耗时=距离/典型速度，几何=直线（索道）或弧线（船/景交车），data_source=estimated。 */
export function estimateSpecialRoute(d: RouteEvent["detail"], a: { lng: number; lat: number }, b: { lng: number; lat: number }, kind: SpecialRouteKind) {
  const s = STRATEGY[kind];
  const dist = haversineM(a, b) * s.detour;
  d.distance_m = Math.round(dist);
  d.duration_s = Math.round(dist / s.speedMs);
  d.geometry = s.bend === 0 ? [[a.lng, a.lat], [b.lng, b.lat]] : arcGeom(a, b, s.bend);
  d.data_source = "estimated";
  d.estimate_strategy = `${s.label}（无 API 路径，策略推测）`;
}

/* ================= H1–H3 地理硬校验 ================= */
export type GeoProblem = { code: "H1_CHILD_OUTLIER" | "H2_CITY_WHITELIST" | "H3_MODE_DISTANCE"; message: string; ids: string[] };

/** 行政区划名归一：反复剥行政后缀，两侧同规则处理后做包含匹配（乐山市↔乐山、阿坝藏族羌族自治州↔阿坝） */
export function normalizeCity(name: string): string {
  let s = String(name ?? "").trim();
  const SUFFIX = ["特别行政区", "自治区", "自治州", "地区", "省", "市", "盟", "县", "区"];
  for (;;) {
    const hit = SUFFIX.find(x => s.length > x.length && s.endsWith(x));
    if (!hit) return s;
    s = s.slice(0, -hit.length);
  }
}
export const cityMatch = (a: string, b: string) => {
  const x = normalizeCity(a), y = normalizeCity(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

const fmtGeo = (g: { lng: number; lat: number }) => `(${g.lng.toFixed(2)},${g.lat.toFixed(2)})`;
const km = (m: number) => (m / 1000).toFixed(0);

/** H3 方式-距离常识上限（route 实际算路距离）：超出必是点位错位或方式乱标 */
const MODE_MAX_M: [Set<string>, number, string][] = [
  [WALK, 20_000, "步行"],
  [BIKE, 100_000, "骑行"],
  [CITY, 300_000, "公交/地铁"],
];

/** 地理合理性硬校验（机械，零 IO）。只吃落图后的事件树（geo/distance 已解析）。
 * whitelistCities：目的地各点名解析出的行政市 + 出发地（agent 层负责解析与缓存）；
 * 白名单为空 = 证据不足，H2 整体跳过（fail-open）。 */
export function checkGeoSanity(events: Record<string, EventV2>, opts: { whitelistCities?: string[] } = {}): { hard: GeoProblem[] } {
  const hard: GeoProblem[] = [];
  const live = Object.values(events).filter(e => e.status !== "dropped");

  // ---- H1 父子地理包含：AOI 子事件不得是远离所有兄弟 50km 的孤儿（同名异地典型特征） ----
  for (const aoi of live.filter(isAoi)) {
    const kids = childrenOf(events, aoi.event_id)
      .filter(k => k.status !== "dropped" && isPoi(k) && k.detail.geo) as (EventV2 & { detail: { geo: { lng: number; lat: number } } })[];
    if (kids.length < 2) continue; // 单子事件无法三角定位，交给 H2
    for (const k of kids) {
      const nearest = Math.min(...kids.filter(s => s !== k).map(s => haversineM(k.detail.geo, s.detail.geo)));
      if (nearest > 50_000) {
        const sib = kids.find(s => s !== k)!;
        hard.push({
          code: "H1_CHILD_OUTLIER",
          message: `景区「${aoi.name}」的子事件「${k.name}」坐标 ${fmtGeo(k.detail.geo)}，距最近的兄弟事件「${sib.name}」${fmtGeo(sib.detail.geo)} 达 ${km(nearest)}km——几乎肯定是同名异地错位（如把外省的同名点位当成了景区内点位）。修复：用 search_poi 以「目的地城市名+${k.name}」重查该点位后重提`,
          ids: [k.event_id, aoi.event_id],
        });
      }
    }
  }

  // ---- H2 行政区划白名单：POI 解析出的城市必须在 目的地行政市+出发地 之内 ----
  const wl = (opts.whitelistCities ?? []).filter(Boolean);
  if (wl.length) {
    for (const p of live.filter(isPoi)) {
      const city = p.detail.city;
      if (!city || !p.detail.geo) continue; // 证据不足放行
      if (!wl.some(w => cityMatch(w, city))) {
        hard.push({
          code: "H2_CITY_WHITELIST",
          message: `点位「${p.name}」解析落在「${city}」${fmtGeo(p.detail.geo)}，不在本行程的行政区划白名单（${wl.join("、")}）内——疑似同名异地错位。修复：用 search_poi 以「${wl[0]}+${p.name}」重查该点位后重提；若确为有意安排的途经点，请在 note 中说明`,
          ids: [p.event_id],
        });
      }
    }
  }

  // ---- H3 方式-距离常识：步行>20km / 骑行>100km / 公交>300km 必有鬼 ----
  for (const r of live.filter(isRoute)) {
    const d = r.detail;
    if (d.distance_m == null) continue;
    for (const [modes, maxM, label] of MODE_MAX_M) {
      if (modes.has(d.mode) && d.distance_m > maxM) {
        const from = events[d.from_ref]?.name ?? "?", to = events[d.to_ref]?.name ?? "?";
        hard.push({
          code: "H3_MODE_DISTANCE",
          message: `通勤段「${from}→${to}」方式为${label}但距离达 ${km(d.distance_m)}km（常识上限 ${km(maxM)}km）——几乎必是端点定错位或方式乱标。修复：先 search_poi 核实两端点坐标是否都在正确城市，再重提该段`,
          ids: [r.event_id],
        });
        break;
      }
    }
  }
  return { hard };
}

/** 防抱死降级的纯判定：同一问题（code+涉及事件名签名）第 N 次出现时应降级。
 * 签名用事件名不用 event_id——每次重提 event_id 都重新生成，名字才稳定。 */
export const geoProblemSig = (p: QualityProblem | GeoProblem, events: Record<string, EventV2>) =>
  `${p.code}:${p.ids.map(id => events[id]?.name ?? id).sort().join("|")}`;
