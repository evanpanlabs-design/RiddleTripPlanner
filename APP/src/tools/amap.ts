/** 高德 Web Service（移植自 LAB/lab02 amap_tools.py，含 QPS 节流+退避）。
 * key 每次请求前经设置中心动态解析，保存设置后即时生效。
 * Hybrid 能力路由：高德固定承担 POI 检索/同城算路/底图，跨城大交通走百度（baidu.ts）。 */
import { resolveAmapWebKey, resolveLimits } from "../settings.ts";
import { createMinInterval } from "./limiter.ts";

const BASE = "https://restapi.amap.com";
/** QPS 限速（0.4.4 起可在设置中心调，默认 2.5 qps = 400ms 间隔，热生效）；v3/v4 共用一条队列 */
const throttle = createMinInterval(() => 1000 / resolveLimits().amapQps);

async function amapGet(path: string, params: Record<string, string>, retries = 2): Promise<any> {
  const key = resolveAmapWebKey();
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle();
    const qs = new URLSearchParams({ ...params, key });
    const resp = await fetch(`${BASE}${path}?${qs}`);
    const data = await resp.json();
    if (String(data.status) === "1") return data;
    if (data.infocode === "10021" && attempt < retries) {
      await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
      continue;
    }
    throw new Error(`amap error: ${data.info} (${data.infocode})`);
  }
}

export async function searchPoi(name: string, city?: string) {
  const params: Record<string, string> = { keywords: name, offset: "3", page: "1", extensions: "all" };
  if (city) { params.city = city; params.citylimit = "true"; }
  const data = await amapGet("/v3/place/text", params);
  const p = data.pois?.[0];
  if (!p) return null;
  const [lng, lat] = (p.location || ",").split(",");
  return {
    amap_poi_id: p.id, name: p.name,
    category_tags: Array.isArray(p.type) ? p.type : (p.type || "").split(";"),
    geo: lat ? { lng: +lng, lat: +lat } : null,
    city: p.cityname, opening_hours: null,
  };
}

export async function drivingRoute(from: { lng: number; lat: number }, to: { lng: number; lat: number }) {
  const data = await amapGet("/v3/direction/driving", {
    origin: `${from.lng},${from.lat}`, destination: `${to.lng},${to.lat}`, strategy: "0",
  });
  const p = data.route?.paths?.[0];
  if (!p) return null;
  // 真实路径折线：steps[].polyline = "lng,lat;lng,lat;…"，降采样到 ≤300 点控制体积
  let pts: [number, number][] = [];
  for (const s of p.steps ?? []) {
    for (const pair of String(s.polyline ?? "").split(";")) {
      const [lng, lat] = pair.split(",");
      if (lng && lat) pts.push([+lng, +lat]);
    }
  }
  pts = downsample(pts);
  return { distance_m: +p.distance, duration_s: +p.duration, geometry: pts };
}

/** 折线点降采样到 ≤300 点，控制 SSE/落盘体积 */
function downsample(pts: [number, number][]): [number, number][] {
  if (pts.length <= 300) return pts;
  const step = Math.ceil(pts.length / 300);
  return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
}

/** 解析 "lng,lat;lng,lat;…" 折线串 */
function parsePolyline(s: unknown): [number, number][] {
  const pts: [number, number][] = [];
  for (const pair of String(s ?? "").split(";")) {
    const [lng, lat] = pair.split(",");
    if (lng && lat) pts.push([+lng, +lat]);
  }
  return pts;
}

/** 步行路径（v3，响应结构与驾车同构） */
export async function walkingRoute(from: { lng: number; lat: number }, to: { lng: number; lat: number }) {
  const data = await amapGet("/v3/direction/walking", {
    origin: `${from.lng},${from.lat}`, destination: `${to.lng},${to.lat}`,
  });
  const p = data.route?.paths?.[0];
  if (!p) return null;
  let pts: [number, number][] = [];
  for (const s of p.steps ?? []) pts.push(...parsePolyline(s.polyline));
  return { distance_m: +p.distance, duration_s: +p.duration, geometry: downsample(pts) };
}

/** v4 接口（骑行）响应结构不同：errcode/errmsg + data.paths[].polyline 单串 */
async function amapGetV4(path: string, params: Record<string, string>, retries = 2): Promise<any> {
  const key = resolveAmapWebKey();
  for (let attempt = 0; attempt <= retries; attempt++) {
    await throttle();
    const qs = new URLSearchParams({ ...params, key });
    const resp = await fetch(`${BASE}${path}?${qs}`);
    const data = await resp.json();
    if (Number(data.errcode) === 0) return data;
    if (attempt < retries) { await new Promise(r => setTimeout(r, 1200 * (attempt + 1))); continue; }
    throw new Error(`amap v4 error: ${data.errmsg} (${data.errcode})`);
  }
}

/** 骑行路径（v4） */
export async function bicyclingRoute(from: { lng: number; lat: number }, to: { lng: number; lat: number }) {
  const data = await amapGetV4("/v4/direction/bicycling", {
    origin: `${from.lng},${from.lat}`, destination: `${to.lng},${to.lat}`,
  });
  const p = data.data?.paths?.[0];
  if (!p) return null;
  let pts: [number, number][] = [];
  for (const s of p.steps ?? []) pts.push(...parsePolyline(s.polyline));
  return { distance_m: +p.distance, duration_s: +p.duration, geometry: downsample(pts) };
}

/** 同城公交/地铁换乘（v3 transit/integrated，需 city 参数）。 */
export async function cityTransitRoute(from: { lng: number; lat: number }, to: { lng: number; lat: number }, city: string) {
  const data = await amapGet("/v3/direction/transit/integrated", {
    origin: `${from.lng},${from.lat}`, destination: `${to.lng},${to.lat}`,
    city, cityd: city, strategy: "0",
  });
  const t = data.route?.transits?.[0];
  if (!t) return null;
  // 折线拼接：各 segment 的步行 steps + 公交线 + 地铁段
  let pts: [number, number][] = [];
  for (const seg of t.segments ?? []) {
    for (const w of seg.walking?.steps ?? []) pts.push(...parsePolyline(w.polyline));
    for (const b of seg.bus?.buslines ?? []) pts.push(...parsePolyline(b.polyline));
    if (seg.railway?.polyline) pts.push(...parsePolyline(seg.railway.polyline));
  }
  const distance = +t.distance || null;
  return { distance_m: distance, duration_s: +t.duration || null, geometry: downsample(pts) };
}

export function geodesicM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = 6371000, rad = (d: number) => d * Math.PI / 180;
  const dlat = rad(b.lat - a.lat), dlon = rad(b.lng - a.lng);
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dlon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}
