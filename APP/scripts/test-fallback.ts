/** 退级链路实测：Jev 不可达时 ResilientJudge 自动切 LLM，判断结果仍可用；引擎切换事件可追溯。
 * 运行：npx tsx scripts/test-fallback.ts（从 APP 目录，读取 ../.env） */
import { config } from "dotenv";
config({ path: "../.env" });
import { ResilientJudge } from "../src/jev/resilient-judge.ts";
import { d1IntentQuestions, d6RadiusQuestion } from "../src/jev/questions.ts";

const jev = new ResilientJudge();
const switches: string[] = [];
jev.onEngine = (engine, reason) => { switches.push(`${engine}: ${reason}`); console.log(`  [引擎切换] ${engine} — ${reason}`); };

let fail = 0;
const check = (cond: boolean, label: string) => { console.log(cond ? "  ✅" : "  ❌", label); if (!cond) fail++; };

console.log("A. Jev 不可达（本环境 typesafe.ai 被阻断）→ 应退级 LLM 并给出有效判断");
const d1 = await jev.d1Intents("把峨眉山调到第2天，乐山往后挪。", { stage: "plan", days: 7 });
check((d1.raw.I4 ?? 0) >= 0.8, `I4 命中（${d1.raw.I4?.toFixed(2)}）`);
check(switches.some(s => s.startsWith("llm")), "发生了 jev→llm 切换事件");

console.log("B. 冷却期内第二次调用直接走 LLM（不再等 Jev 超时）");
const t0 = Date.now();
const d6 = await jev.d6Radius("把返程从双流机场改成天府机场", { stage: "plan" });
const ms = Date.now() - t0;
check(["R1", "R2", "R3"].includes(d6.radius), `半径合法（${d6.radius}）`);
check(ms < 30000, `未白等 Jev 超时（${(ms / 1000).toFixed(1)}s）`);

console.log(fail ? `\n❌ ${fail} 项未过` : "\n✅ 退级链路通过");
process.exit(fail ? 1 : 0);
