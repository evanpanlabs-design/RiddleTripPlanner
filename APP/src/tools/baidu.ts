/** 百度 Web Service：跨城大交通（Direction v2 transit：火车/飞机/大巴）。
 * Hybrid 能力路由：百度只承担高德没有的大交通数据，POI/同城算路/底图仍在高德。
 * 坐标策略：请求带 coord_type=gcj02 直传，全系统统一 GCJ02（与高德底图一致，免转换层）。
 * 注意：请求 origin/destination 是 lat,lng（纬度在前，与高德相反）；
 *      返回 path 折线是 lng,lat（与高德 polyline 一致，直接可绘）。
 * 实测结构见 KB/baidu-webservice/INDEX.md（2026-09-22）。 */
import { resolveBaiduWebKey } from "../settings.ts";
import { geodesicM } from "./amap.ts";

const BASE = "https://api.map.baidu.com";
const MIN_INTERVAL = 400;
let lastCall = 0;

async function baiduGet(path: string, params: Record<string, string>): Promise<any> {
  const ak = resolveBaiduWebKey();
  if (!ak) throw new Error("未配置百度服务端 AK（设置 → 百度地图，或环境变量 BAIDU_MAP_AK / BAIDU_WEB_SERVICE_AK）");
  const wait = MIN_INTERVAL - (Date.now() - lastCall);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCall = Date.now();
  const resp = await fetch(`${BASE}${path}?${new URLSearchParams({ ...params, ak })}`);
  const data = await resp.json();
  if (data.status === 0) return data;
  throw new Error(`baidu error: ${data.message} (${data.status})`);
}

export type IntercityPrefer = "train" | "flight" | "coach";
/** trans_type_intercity：0 火车 / 1 飞机 / 2 大巴 */
const TRANS_TYPE: Record<IntercityPrefer, string> = { train: "0", flight: "1", coach: "2" };
/** vehicle_info.type：1 火车 / 2 飞机 / 3 公交·地铁·大巴 / 5 步行 */
const VEHICLE: Record<number, TransitSegment["type"]> = { 1: "train", 2: "flight", 3: "bus", 5: "walk" };

export interface TransitSegment {
  type: "train" | "flight" | "bus" | "walk" | "other";
  name: string | null;          // 车次/航班号/线路名（G321、KN6300、地铁1号线）
  instruction: string;          // 百度原生文案
  duration_s: number;
  distance_m: number;
  from_station?: string; to_station?: string;
  depart_at?: string; arrive_at?: string;  // "2026-09-23 07:00:00"（查询当日班次）
  price?: number | null;
  airline?: string;
  geometry: [number, number][];
}

export interface IntercityRoute {
  distance_m: number;
  duration_s: number;
  price: number | null;
  main: TransitSegment | null;  // 首个火车/飞机段（方案锚点信息）
  segments: TransitSegment[];
  geometry: [number, number][]; // 全部门到门段拼接、降采样 ≤300
  data_source: "baidu_transit";
}

function parsePath(path: unknown): [number, number][] {
  const pts: [number, number][] = [];
  for (const pair of String(path ?? "").split(";")) {
    const [lng, lat] = pair.split(",");
    if (lng && lat) pts.push([+lng, +lat]);
  }
  return pts;
}

/** 跨城路线查询：返回含真实班次（车次/航班号、时刻、票价）的门到门方案。
 * 时刻为查询当日班次，随出发日期变化——消费方应按"代表性班次"处理。 */
export async function intercityRoute(
  from: { lng: number; lat: number },
  to: { lng: number; lat: number },
  prefer: IntercityPrefer = "train",
): Promise<IntercityRoute | null> {
  const data = await baiduGet("/direction/v2/transit", {
    origin: `${from.lat},${from.lng}`,      // 百度请求侧纬度在前
    destination: `${to.lat},${to.lng}`,
    coord_type: "gcj02",
    trans_type_intercity: TRANS_TYPE[prefer],
  });
  const routes: any[] = data.result?.routes ?? [];
  if (!routes.length) return null;
  const flat = (r: any) => (r.steps ?? []).flatMap((g: any) => (Array.isArray(g) ? g : [g]));
  // 路线选择：火车/飞机优先模式下，有些路线全是接驳巴士——优先选真正含大交通段的
  const want = prefer === "flight" ? 2 : prefer === "coach" ? 3 : 1;
  const route = routes.find(r => flat(r).some((s: any) => s?.vehicle_info?.type === want))
           ?? routes.find(r => flat(r).some((s: any) => [1, 2].includes(s?.vehicle_info?.type)))
           ?? routes[0];
  const segments: TransitSegment[] = flat(route).map((s: any) => {
    const det = s?.vehicle_info?.detail ?? {};
    return {
      type: VEHICLE[s?.vehicle_info?.type] ?? "other",
      name: det.name ?? null,
      instruction: String(s?.instructions ?? "").replace(/<[^>]+>/g, ""),
      duration_s: +s?.duration || 0,
      distance_m: +s?.distance || 0,
      from_station: det.departure_station ?? det.start_info?.start_name,
      to_station: det.arrive_station ?? det.end_info?.end_name,
      depart_at: det.start_info?.start_time,
      arrive_at: det.end_info?.end_time,
      price: det.price ?? null,
      airline: det.airlines,
      geometry: parsePath(s?.path),
    } satisfies TransitSegment;
  });
  let geometry = segments.flatMap(s => s.geometry);
  if (geometry.length > 300) {
    const step = Math.ceil(geometry.length / 300);
    geometry = geometry.filter((_, i) => i % step === 0 || i === geometry.length - 1);
  }
  return {
    // 站到站纯铁路路线 distance 为 0（百度不反轨道路程）——降级为端点测地线
    distance_m: +route.distance || Math.round(geodesicM(from, to)),
    duration_s: +route.duration || 0,
    price: route.price != null && +route.price >= 0 ? +route.price : null,
    main: segments.find(s => s.type === "train" || s.type === "flight") ?? null,
    segments,
    geometry,
    data_source: "baidu_transit",
  };
}
