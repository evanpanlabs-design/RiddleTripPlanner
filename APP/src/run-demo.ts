/** TS 版 Riddle 冒烟 demo：两轮输入验证 loop + Jev 注入点 + 工具系统。 */
import "dotenv/config";
import { config } from "dotenv";
config({ path: "../.env" });  // 工作区根目录密钥
import { createRiddleAgent } from "./agent.ts";
import { planDesc } from "./memory/trip-store.ts";

const INPUTS = [
  "我想国庆去四川玩，10月1日出发10月7日回，一共7天，从北京出发，想去成都和九寨沟，节奏紧凑点。",
  "好，帮我把这7天的行程排出来。",
];

async function main() {
  const { agent, store, scheduler } = createRiddleAgent();
  agent.subscribe((ev: any) => {
    if (ev.type === "tool_execution_start") console.log(`  [tool] ${ev.toolName ?? ev.toolCall?.name}`);
    if (ev.type === "tool_execution_end" && ev.isError) console.log(`  [tool-error]`, ev.result?.content?.[0]?.text?.slice(0, 120));
  });

  for (const text of INPUTS) {
    console.log(`\n=== 用户: ${text.slice(0, 40)}...`);
    await agent.prompt(text);
    const last: any = [...agent.state.messages].reverse().find((m: any) => m.role === "assistant");
    const reply = typeof last?.content === "string" ? last.content
      : (last?.content ?? []).map((c: any) => c.text ?? "").join("") || "(无回复)";
    console.log(`Riddle: ${reply.slice(0, 300)}`);
    console.log(`阶段: ${store.trip.stage} | events: ${Object.keys(store.trip.events_v2 ?? {}).length} | pending: ${scheduler.size}`);
  }

  console.log("\n--- 最终方案 ---");
  console.log(planDesc(store.trip).slice(0, 1500));
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
