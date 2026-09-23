/** 0.4.1 新增链路实测：百度 place detail 富化 + OSM AOI 边界获取。
 * 运行：npx tsx scripts/test-place.ts（从 APP 目录，读取 ../.env） */
import { config } from "dotenv";
config({ path: "../.env" });
import { enrichFromBaidu } from "../src/tools/baidu-place.ts";
import { fetchAoiBoundary } from "../src/tools/osm-aoi.ts";

let fail = 0;
const check = (cond: boolean, label: string) => { console.log(cond ? "  ✅" : "  ❌", label); if (!cond) fail++; };

console.log("A. 百度富化：拙政园（苏州）");
const a = await enrichFromBaidu("拙政园", "苏州");
check(!!a?.baidu_uid, `拿到 baidu_uid：${a?.baidu_uid}`);
check(!!a?.detail, "detail 可取");
console.log("     opening:", JSON.stringify(a?.detail?.opening_detail ?? null).slice(0, 200));
console.log("     price:", JSON.stringify(a?.detail?.price ?? null), "rating:", JSON.stringify(a?.detail?.rating ?? null), "grade:", a?.detail?.scope_grade, "tags:", a?.detail?.category_tags?.join("/"));
check(!!(a?.detail?.opening_detail?.periods?.length || a?.detail?.opening_detail?.text), "营业时段（periods 或文本兜底）非空");
check((a?.detail?.price?.amount ?? 0) > 0, `门票价格：¥${a?.detail?.price?.amount}`);
check((a?.detail?.rating?.score ?? 0) > 0, `评分：${a?.detail?.rating?.score}`);

console.log("B. 百度富化：九寨沟（阿坝）");
const b = await enrichFromBaidu("九寨沟", "阿坝");
console.log("     opening:", JSON.stringify(b?.detail?.opening_detail ?? null).slice(0, 200));
console.log("     price:", JSON.stringify(b?.detail?.price ?? null), "grade:", b?.detail?.scope_grade, "tags:", b?.detail?.category_tags?.join("/"));
check(!!b?.baidu_uid, `拿到 baidu_uid：${b?.baidu_uid}`);
check(!!b?.detail?.scope_grade, `景区等级：${b?.detail?.scope_grade}`);

console.log("C. OSM 边界：九寨沟（SPEC §7 探测样例 relation 7516592）");
const t0 = Date.now();
const bd = await fetchAoiBoundary("九寨沟");
console.log(`     耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
check(!!bd, "边界获取成功");
if (bd) {
  check(bd.osm_relation_id === 7516592, `relation id = ${bd.osm_relation_id}`);
  check(bd.polygon.length >= 3 && bd.polygon.length <= 200, `抽稀后点数 ${bd.polygon.length}（≤200）`);
  check(bd.polygon.every(([lng, lat]) => lng > 73 && lng < 136 && lat > 3 && lat < 54), "坐标为 GCJ02 国内范围");
  check(bd.attribution.includes("OpenStreetMap"), "带 ODbL attribution");
}
console.log("D. 缓存命中（应秒回）");
const t1 = Date.now();
const bd2 = await fetchAoiBoundary("九寨沟");
console.log(`     耗时 ${((Date.now() - t1) / 1000).toFixed(2)}s`);
check(!!bd2 && Date.now() - t1 < 3000, "缓存命中秒回");

console.log(fail ? `\n❌ ${fail} 项未过` : "\n✅ 0.4.1 新链路实测通过");
process.exit(fail ? 1 : 0);
