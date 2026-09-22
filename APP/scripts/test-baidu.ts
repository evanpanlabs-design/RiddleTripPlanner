/** 百度跨城大交通回归：真实 AK 验证 intercityRoute 结构（火车/飞机）。
 * 运行：npx tsx scripts/test-baidu.ts（从 APP 目录，读取 ../.env 的 BAIDU_WEB_SERVICE_AK） */
import { config } from "dotenv";
config({ path: "../.env" });
import { intercityRoute } from "../src/tools/baidu.ts";

let fail = 0;
const check = (cond: boolean, label: string) => { console.log(cond ? "  ✅" : "  ❌", label); if (!cond) fail++; };

// Case A：北京南 → 成都东，火车优先 → 应含真实车次段
console.log("A. 北京南→成都东 (train)");
const t = await intercityRoute({ lng: 116.3785, lat: 39.8650 }, { lng: 104.1406, lat: 30.6305 }, "train");
check(!!t?.main && t.main.type === "train", `主段为火车：${t?.main?.name} ${t?.main?.from_station}→${t?.main?.to_station}`);
check(/^G|^D|^C|^K|^T|^Z/.test(t?.main?.name ?? ""), `车次号格式合法：${t?.main?.name}`);
check(!!t?.main?.depart_at?.includes("-"), `含完整发车时刻：${t?.main?.depart_at}`);
check((t?.main?.price ?? 0) > 0, `含票价：¥${t?.main?.price}`);
check((t?.geometry.length ?? 0) > 10, `折线点数：${t?.geometry.length}`);
check((t?.geometry[0]?.[0] ?? 0) > 73 && (t?.geometry[0]?.[0] ?? 0) < 136, `坐标为 GCJ02 经度范围（lng 在前）：${t?.geometry[0]}`);

// Case B：成都 → 北京，飞机优先 → 应含真实航班段
console.log("B. 成都→北京 (flight)");
const f = await intercityRoute({ lng: 104.0668, lat: 30.5728 }, { lng: 116.3975, lat: 39.9087 }, "flight");
check(!!f?.main && f.main.type === "flight", `主段为航班：${f?.main?.name} ${f?.main?.airline}`);
check((f?.main?.price ?? 0) > 0, `含票价：¥${f?.main?.price}`);
check(!!f?.main?.airline, `含航司：${f?.main?.airline}`);

// Case C：站到站纯铁路（北京西→成都东）——百度不反轨道路程，distance 应降级为测地线 > 0
console.log("C. 北京西→成都东 (train, 站到站)");
const s = await intercityRoute({ lng: 116.3213, lat: 39.8952 }, { lng: 104.1406, lat: 30.6305 }, "train");
check(!!s?.main && s.main.type === "train", `主段为火车：${s?.main?.name}`);
check((s?.distance_m ?? 0) > 1000000, `distance 测地线兜底生效：${((s?.distance_m ?? 0) / 1000).toFixed(0)}km`);
check((s?.geometry.length ?? 0) >= 2, `折线点数：${s?.geometry.length}`);

console.log(fail ? `\n❌ ${fail} 项未过` : "\n✅ 百度大交通回归通过");
process.exit(fail ? 1 : 0);
