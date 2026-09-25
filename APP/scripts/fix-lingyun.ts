/** 0.6 存量修复（一次性）：凌云寺同名异地错位（辽宁→乐山）+ 关联 route 重算。
 * 用法：先停 dev server（防内存态覆盖写回），再 npx tsx scripts/fix-lingyun.ts [trip_id]。
 * 链路：searchPoi 带城市限定重查 → 更正 geo/city → resolveRouteDataV2 重算关联通勤段
 *      → checkGeoSanity 复核 → 快照+留痕落盘。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TripStore, type Trip } from "../src/memory/trip-store.ts";
import { isRoute, type PoiEvent } from "../src/memory/event-v2.ts";
import { resolveRouteDataV2 } from "../src/agent.ts";
import { searchPoi } from "../src/tools/amap.ts";
import { checkGeoSanity } from "../src/memory/geo-checks.ts";

const tripId = process.argv[2] ?? "trip_78e5a4b9";
const TARGET = process.argv[3] ?? "凌云寺";
const CITY = process.argv[4] ?? "乐山";
const runs = join(import.meta.dirname, "../runs");

const trip = JSON.parse(readFileSync(join(runs, tripId, "trip.json"), "utf8")) as Trip;
const store = new TripStore(trip);
const events = store.trip.events_v2 ?? {};

const target = Object.values(events).find((e): e is PoiEvent => e.kind === "poi" && e.name === TARGET);
if (!target) throw new Error(`找不到点位事件「${TARGET}」`);
console.log(`修复前：${target.name} geo=${JSON.stringify(target.detail.geo)} city=${target.detail.city ?? "?"}`);

const found = await searchPoi(TARGET, CITY);
if (!found?.geo) throw new Error(`searchPoi 未在「${CITY}」找到「${TARGET}」`);
console.log(`重查结果：${found.name} @ ${JSON.stringify(found.geo)} city=${found.city} amap=${found.amap_poi_id}`);

store.snapshot("fix_poi_geo");
const before = { geo: target.detail.geo ?? null, city: target.detail.city ?? null };
target.detail.geo = { ...found.geo, source: "api" };
target.detail.city = found.city ?? null;
target.detail.poi_ref = { ...target.detail.poi_ref, amap_poi_id: found.amap_poi_id };

// 关联 route 重算（端点含该点位或其父 AOI 的所有通勤段——子事件错位时 AOI 端点段同样受影响）
const related = new Set([target.event_id, target.parent_id].filter(Boolean) as string[]);
const affected = Object.values(events).filter(isRoute).filter(r => related.has(r.detail.from_ref) || related.has(r.detail.to_ref));
for (const r of affected) {
  const oldDist = r.detail.distance_m;
  await resolveRouteDataV2(r, events);
  console.log(`route 重算：${events[r.detail.from_ref]?.name}→${events[r.detail.to_ref]?.name}（${r.detail.mode}）${oldDist}m → ${r.detail.distance_m}m [${r.detail.data_source}]`);
}

store.log("repair_poi_geo", { event_id: target.event_id, name: TARGET, before, after: { geo: target.detail.geo, city: target.detail.city }, routes: affected.map(r => r.event_id) }, null, { actor: "user" });
store.save();

// 复核：地理硬校验应全绿（无白名单，只跑 H1/H3）
const geo = checkGeoSanity(events);
console.log(geo.hard.length ? `复核仍有地理问题：${geo.hard.map(p => p.message).join("；")}` : "复核通过：H1/H3 无地理硬问题");
