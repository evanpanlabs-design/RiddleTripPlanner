/** 诊断：Friday（或当前设置的 LLM）能否承接 Jev 判断任务——按 questions schema 输出结构化概率。
 * 运行：npx tsx scripts/test-llm-judge.ts（从 APP 目录，读取 ../.env） */
import { config } from "dotenv";
config({ path: "../.env" });
import { resolveLlm } from "../src/settings.ts";
import { d1IntentQuestions, d6RadiusQuestion, pendingConsumeQuestion } from "../src/jev/questions.ts";

const c = resolveLlm();
console.log(`LLM: ${c.label} · ${c.model} · ${c.baseUrl} · key=${c.apiKey ? "set" : "MISSING"}`);

const SYSTEM = `你是旅行规划系统里的判断引擎（Jev 的退级替身）。给你 state 和一组 questions，逐题判断。
输出【严格 JSON、不要任何多余文字】：{"answers": {"<question_id>": {...}, ...}}
- type=noul 的题：{"noul": 0~1 之间的概率}，表示命题为真的置信度，禁止输出 0 和 1 之外的解释文字。
- type=choice 的题：{"choice": "<criteria 的 key>", "confidence": 0~1}。
判断标准：保守、讲证据；文本不支持的命题给低分。`;

async function ask(state: unknown, questions: unknown): Promise<Record<string, any>> {
  const body = {
    model: c.model,
    max_tokens: 2048,
    system: SYSTEM,
    messages: [{ role: "user", content: `state:\n${JSON.stringify(state, null, 2)}\n\nquestions:\n${JSON.stringify(questions, null, 2)}` }],
  };
  let resp: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    resp = await fetch(`${c.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.apiKey}`, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (resp.status !== 429) break;
    const wait = 8000 * (attempt + 1);
    console.log(`  …429 限流，${wait / 1000}s 后重试`);
    await new Promise(r => setTimeout(r, wait));
  }
  if (!resp!.ok) throw new Error(`HTTP ${resp!.status}: ${(await resp!.text()).slice(0, 200)}`);
  const d: any = await resp!.json();
  const text = (d.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  // 容错解析：剥掉可能的 ```json 围栏
  const m = text.replace(/```(?:json)?/g, "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`输出不含 JSON：${text.slice(0, 200)}`);
  return JSON.parse(m[0]).answers;
}

let fail = 0;
const check = (cond: boolean, label: string) => { console.log(cond ? "  ✅" : "  ❌", label); if (!cond) fail++; };

// 1. D1 意图分类：明确的方案变更句，应命中 I4、不命中 I2
console.log("A. D1 意图分类（'把峨眉山调到第2天'）");
const d1 = await ask(
  { user_input: "把峨眉山调到第2天，乐山往后挪。", trip_summary: { stage: "plan", days: 7 } },
  d1IntentQuestions(),
);
console.log("  raw:", JSON.stringify(d1));
check(typeof d1.intent_i4?.noul === "number", "intent_i4 返回 noul 数值");
check((d1.intent_i4?.noul ?? 0) >= 0.8, `I4 高分命中（${d1.intent_i4?.noul?.toFixed?.(2)} ≥ 0.8）`);
check((d1.intent_i2?.noul ?? 1) < 0.6, `I2 低分（${d1.intent_i2?.noul?.toFixed?.(2)} < 0.6）`);

// 2. D6 半径判定：换机场锚点应判 R3
console.log("B. D6 半径判定（改返程机场）");
const d6 = await ask(
  { operation: "把返程从双流机场改成天府机场", trip_summary: { stage: "plan" } },
  d6RadiusQuestion("把返程从双流机场改成天府机场"),
);
console.log("  raw:", JSON.stringify(d6));
check(["R1", "R2", "R3"].includes(d6.propagation_radius?.choice), `choice 合法（${d6.propagation_radius?.choice}）`);
check(typeof d6.propagation_radius?.confidence === "number", "confidence 为数值");

// 3. pending 消费：「先不了」应是回应但不同意
console.log("C. pending 消费（'先不了，维持现状'）");
const pc = await ask(
  { user_input: "先不了，维持现状吧。" },
  pendingConsumeQuestion("确认把目的地从成都改为重庆吗？"),
);
console.log("  raw:", JSON.stringify(pc));
check((pc.consume_pending?.noul ?? 0) >= 0.6, `识别为回应（${pc.consume_pending?.noul?.toFixed?.(2)}）`);
check((pc.approve_pending?.noul ?? 1) < 0.5, `识别为不同意（${pc.approve_pending?.noul?.toFixed?.(2)}）`);

// 4. 一致性：同一输入连跑 3 次，概率漂移应 < 0.3
console.log("D. 稳定性（同输入 3 次漂移）");
const probs: number[] = [];
for (let i = 0; i < 3; i++) {
  const r = await ask({ user_input: "我国庆去四川，10月1日出发玩7天。" }, d1IntentQuestions());
  probs.push(r.intent_i3?.noul ?? -1);
}
const drift = Math.max(...probs) - Math.min(...probs);
console.log("  probs:", probs.map(p => p.toFixed(2)).join(", "));
check(probs.every(p => p >= 0.8), `I3 均高分（${probs.map(p => p.toFixed(2)).join("/")}）`);
check(drift < 0.3, `漂移 ${drift.toFixed(2)} < 0.3`);

console.log(fail ? `\n❌ ${fail} 项未过` : "\n✅ LLM 可承接 Jev 判断任务");
process.exit(fail ? 1 : 0);
