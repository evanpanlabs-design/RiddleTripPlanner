/** 高德 Web Service（移植自 LAB/lab02 amap_tools.py，含 QPS 节流+退避）。
 * key 每次请求前经设置中心动态解析，保存设置后即时生效。
 * Hybrid 能力路由：高德固定承担 POI 检索/同城算路/底图，跨城大交通走百度（baidu.ts）。 */
import { resolveAmapWebKey } from "../settings.ts";

const BASE = "https://restapi.amap.com";
const MIN_INTERVAL = 400;
let lastCall = 0;

async function amapGet(path: string, params: Record<string, string>, retries = 2): Promise<any> {
  const key = resolveAmapWebKey();
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = MIN_INTERVAL - (Date.now() - lastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
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
    category_tags: (p.type || "").split(";"),
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
  if (pts.length > 300) {
    const step = Math.ceil(pts.length / 300);
    pts = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  }
  return { distance_m: +p.distance, duration_s: +p.duration, geometry: pts };
}

export function geodesicM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = 6371000, rad = (d: number) => d * Math.PI / 180;
  const dlat = rad(b.lat - a.lat), dlon = rad(b.lng - a.lng);
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dlon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}
