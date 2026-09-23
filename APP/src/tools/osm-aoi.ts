/** OSM AOI 边界异步获取器（SPEC/event-model-v2.md §7）。
 *
 * Fallback 链的第①级：Nominatim 查 relation id（轻量）→ Overpass 镜像轮询取 outer ways
 * → WGS84→GCJ02 转换 → Douglas-Peucker 抽稀（ε≈50m，≤200 点）→ 本地缓存（30 天）。
 * 探测结论（2026-09-23）：Overpass 主实例常 504、单 AOI 延迟实测 72s——
 * 所以镜像轮询 + 单 AOI 90s 预算 + 落盘缓存，调用方必须异步执行不阻塞落图。
 * ODbL：使用边界数据必须带 attribution（© OpenStreetMap contributors）。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
const NOMINATIM = "https://nominatim.openstreetmap.org";
const OVERPASS_MIRRORS = [
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];
const UA = "RiddleTripPlanner/0.4.1 (travel-planning demo; contact: project owner)";
const BUDGET_MS = 90_000;        // 单 AOI 总预算
const CACHE_TTL_MS = 30 * 24 * 3600_000; // 30 天
const MAX_POINTS = 200;

const CACHE_DIR = join(import.meta.dirname, "../../runs/_cache/aoi");

export interface AoiBoundary {
  polygon: [number, number][];   // GCJ02 [lng, lat]，DP 抽稀后 ≤200 点
  osm_relation_id: number;
  attribution: string;
}

// ---------------- 坐标转换：WGS84 → GCJ02（火星坐标，高德底图直接可用） ----------------
const A = 6378245.0, EE = 0.00669342162296594323;
function outOfChina(lng: number, lat: number) { return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271; }
function tLat(x: number, y: number) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return r;
}
function tLng(x: number, y: number) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return r;
}
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat];
  let dLat = tLat(lng - 105, lat - 35), dLng = tLng(lng - 105, lat - 35);
  const radLat = lat / 180 * Math.PI;
  let magic = Math.sin(radLat); magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180) / (A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}

// ---------------- Douglas-Peucker 抽稀（米制局部投影，ε≈50m） ----------------
export function douglasPeucker(pts: [number, number][], epsilonM = 50): [number, number][] {
  if (pts.length <= 2) return pts;
  const lat0 = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
  const m = pts.map(([lng, lat]): [number, number] => [lng * kx, lat * ky]);
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop()!;
    const [x0, y0] = m[i0], [x1, y1] = m[i1];
    const dx = x1 - x0, dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    let dMax = 0, iMax = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const t = len2 ? Math.max(0, Math.min(1, ((m[i][0] - x0) * dx + (m[i][1] - y0) * dy) / len2)) : 0;
      const d = Math.hypot(m[i][0] - (x0 + t * dx), m[i][1] - (y0 + t * dy));
      if (d > dMax) { dMax = d; iMax = i; }
    }
    if (dMax > epsilonM && iMax > 0) { keep[iMax] = true; stack.push([i0, iMax], [iMax, i1]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// ---------------- 凸包（包络兜底，SPEC §7 第②级） ----------------
/** Andrew monotone chain，输入 GCJ02 [lng,lat]，返回逆时针凸包（不闭合尾点） */
export function convexHull(pts: [number, number][]): [number, number][] {
  const p = [...new Set(pts.map(([x, y]) => `${x},${y}`))].map(s => s.split(",").map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length <= 2) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const pt of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop(); lower.push(pt); }
  const upper: [number, number][] = [];
  for (const pt of [...p].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop(); upper.push(pt); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

// ---------------- Nominatim：名称 → relation id ----------------
async function findRelationId(name: string, signal: AbortSignal): Promise<number | null> {
  const url = `${NOMINATIM}/search?${new URLSearchParams({ q: name, format: "json", limit: "5" })}`;
  const resp = await fetch(url, { headers: { "user-agent": UA }, signal });
  if (!resp.ok) return null;
  const rows: any[] = await resp.json();
  const rel = rows.find(r => r.osm_type === "relation") ?? rows.find(r => r.osm_type === "way");
  // way 也可取边界（小景区常是单 way），统一按 way/relation 取几何
  return rel ? +rel.osm_id * (rel.osm_type === "way" ? -1 : 1) : null; // 负数 = way（编码进返回值）
}

// ---------------- Overpass：relation/way → outer 几何 ----------------
async function fetchOverpass(id: number, signal: AbortSignal): Promise<[number, number][] | null> {
  const isWay = id < 0;
  const query = isWay
    ? `[out:json][timeout:60];way(${-id});out geom;`
    : `[out:json][timeout:60];relation(${id});out geom;`;
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const resp = await fetch(mirror, {
        method: "POST",
        headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        signal,
      });
      if (!resp.ok) continue; // 504/429 → 下一镜像
      const data = await resp.json();
      const el = data.elements?.[0];
      if (!el) return null;
      const rings = isWay
        ? [[...(el.geometry ?? []).map((g: any): [number, number] => [+g.lon, +g.lat])]]
        : stitchOuterRings(el.members ?? []);
      if (!rings.length || rings[0].length < 3) continue;
      return rings.reduce((best, r) => (r.length > best.length ? r : best), rings[0]); // 多外环取最大（主边界）
    } catch { /* 超时/网络错误 → 下一镜像 */ }
  }
  return null;
}

/** relation 的 outer ways 按端点贪心拼环（Overpass out geom 每个 way 自带 geometry） */
function stitchOuterRings(members: any[]): [number, number][][] {
  const ways = members
    .filter(m => m.type === "way" && m.role === "outer" && Array.isArray(m.geometry) && m.geometry.length >= 2)
    .map(m => m.geometry.map((g: any): [number, number] => [+g.lon, +g.lat]));
  const rings: [number, number][][] = [];
  const eq = (a: number[], b: number[]) => a[0] === b[0] && a[1] === b[1];
  while (ways.length) {
    let ring = ways.shift()!;
    let extended = true;
    while (extended) {
      extended = false;
      if (eq(ring[0], ring[ring.length - 1])) break; // 已闭合
      for (let i = 0; i < ways.length; i++) {
        const w = ways[i], head = ring[0], tail = ring[ring.length - 1];
        if (eq(tail, w[0])) { ring = ring.concat(w.slice(1)); }
        else if (eq(tail, w[w.length - 1])) { ring = ring.concat([...w].reverse().slice(1)); }
        else if (eq(head, w[w.length - 1])) { ring = w.slice(0, -1).concat(ring); }
        else if (eq(head, w[0])) { ring = [...w].reverse().slice(0, -1).concat(ring); }
        else continue;
        ways.splice(i, 1); extended = true; break;
      }
    }
    rings.push(ring);
  }
  return rings;
}

// ---------------- 缓存 ----------------
function cachePath(id: number) { return join(CACHE_DIR, `${id}.json`); }
function readCache(id: number): AoiBoundary | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(id), "utf8"));
    if (Date.now() - (raw.fetched_at ?? 0) > CACHE_TTL_MS) return null;
    return { polygon: raw.polygon, osm_relation_id: raw.osm_relation_id, attribution: OSM_ATTRIBUTION };
  } catch { return null; }
}
function writeCache(id: number, polygon: [number, number][]) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath(id), JSON.stringify({ fetched_at: Date.now(), osm_relation_id: Math.abs(id), polygon }));
  } catch { /* 缓存失败不致命 */ }
}

/** 主入口：按名称获取 AOI 真边界（GCJ02、抽稀 ≤200 点、带缓存）。超时/失败返回 null（调用方降级包络）。 */
export async function fetchAoiBoundary(name: string): Promise<AoiBoundary | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BUDGET_MS);
  try {
    const id = await findRelationId(name, ctrl.signal);
    if (id == null) return null;
    const cached = readCache(id);
    if (cached) return cached;
    const ring = await fetchOverpass(id, ctrl.signal);
    if (!ring) return null;
    let polygon = ring.map(([lng, lat]) => wgs84ToGcj02(lng, lat));
    if (polygon.length > MAX_POINTS) polygon = douglasPeucker(polygon);
    if (polygon.length > MAX_POINTS) { // DP 后仍超 → 均匀抽稀兜底
      const step = Math.ceil(polygon.length / MAX_POINTS);
      polygon = polygon.filter((_, i) => i % step === 0);
    }
    writeCache(id, polygon);
    return { polygon, osm_relation_id: Math.abs(id), attribution: OSM_ATTRIBUTION };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
