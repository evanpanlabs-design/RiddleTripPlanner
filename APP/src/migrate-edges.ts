/** 存量数据迁移（v0.3.3）：回填历史项目的边数据。
 *  1. 旧字段名 amap_driving → amap_drive
 *  2. data_source=empty 且有起讫坐标的边 → 按现行策略重解析（高德市内/百度跨城）
 *  3. 有坐标但缺几何的边 → 保底两点几何（地图不断线）
 *  4. v0.3.3 前落盘的 baidu_transit 几何是 BD09（偏 ~500m）→ 转 GCJ02，coord_type 标记幂等
 * 幂等：已合规的边不动。用法：npx tsx --env-file=../.env src/migrate-edges.ts */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveEdgeData } from "./agent.ts";
import { searchPoi, geodesicM } from "./tools/amap.ts";
import { bd09ToGcj02 } from "./tools/baidu.ts";
import { destList } from "./memory/trip-store.ts";

const RUNS = join(import.meta.dirname, "../runs");
let projects = 0, renamed = 0, resolved = 0, geomFilled = 0, failed = 0, nodeGeo = 0, coordFixed = 0;

for (const dir of readdirSync(RUNS)) {
  const fp = join(RUNS, dir, "trip.json");
  if (!existsSync(fp)) continue;
  const trip = JSON.parse(readFileSync(fp, "utf8"));
  let dirty = false;
  // 0. 节点坐标回填：历史版本 searchPoi 失败留下的无坐标节点重试。
  // 候选城市 = 目的地 + 同方案已解析节点的城市；结果须距已解析节点 ≤300km（防"黄龙→黄龙溪古镇"式误解析）
  const resolvedGeos = (Object.values(trip.nodes ?? {}) as any[]).map(n => n.geo).filter(Boolean);
  const candidates = [...new Set([...destList(trip), ...(Object.values(trip.nodes ?? {}) as any[]).map(n => n.city).filter(Boolean)])] as string[];
  const sane = (geo: { lng: number; lat: number }) =>
    !resolvedGeos.length || resolvedGeos.some(g => geodesicM(g, geo) <= 300_000);
  for (const n of Object.values(trip.nodes ?? {}) as any[]) {
    if (n.geo) continue;
    try {
      let r: any = null;
      for (const city of candidates) {
        r = await searchPoi(n.name, city);
        if (r?.geo && sane(r.geo)) break;
        r = null;
      }
      if (r?.geo) { n.geo = r.geo; n.amap_poi_id = r.amap_poi_id; n.category_tags = r.category_tags ?? []; n.city = r.city ?? null; nodeGeo++; dirty = true; }
    } catch { /* 单点失败跳过 */ }
  }
  for (const e of Object.values(trip.edges ?? {}) as any[]) {
    if (e.data_source === "amap_driving") { e.data_source = "amap_drive"; renamed++; dirty = true; }
    // 4. v0.3.3 前百度返回的是 BD09（ret_coordtype 缺失），转 GCJ02；coord_type 字段作幂等标记
    if (e.data_source === "baidu_transit" && e.coord_type !== "gcj02" && Array.isArray(e.geometry) && e.geometry.length) {
      e.geometry = e.geometry.map(([lng, lat]: [number, number]) => bd09ToGcj02(lng, lat));
      e.coord_type = "gcj02"; coordFixed++; dirty = true;
    }
    const a = trip.nodes?.[e.from_id]?.geo, b = trip.nodes?.[e.to_id]?.geo;
    if (!a || !b) continue;
    if (e.data_source === "empty") {
      const before = e.data_source;
      try { await resolveEdgeData(e, trip.nodes, trip.events); } catch { /* 单条失败不阻断 */ }
      if (e.data_source !== before) { resolved++; dirty = true; }
      else failed++;
    }
    if (!Array.isArray(e.geometry) || e.geometry.length < 2) {
      e.geometry = [[a.lng, a.lat], [b.lng, b.lat]];
      geomFilled++; dirty = true;
    }
  }
  if (dirty) { writeFileSync(fp, JSON.stringify(trip, null, 2)); projects++; }
}
console.log(`迁移完成：${projects} 个项目有变更；节点补坐标 ${nodeGeo} 个，改名 ${renamed} 条，重解析 ${resolved} 条，保底几何 ${geomFilled} 条，BD09→GCJ02 ${coordFixed} 条，重解析仍留空 ${failed} 条`);
