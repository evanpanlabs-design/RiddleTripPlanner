/** 四川 7 天 7 轮回放（对齐 LAB/lab02 run_sichuan.py 的 gold truth 脚本）。 */
import "dotenv/config";
import { config } from "dotenv";
config({ path: "../.env" });
import { writeFileSync } from "node:fs";
import { createRiddleAgent } from "./agent.ts";
import { planDesc } from "./memory/trip-store.ts";

const ROUNDS: [string, string][] = [
  ["① 需求输入",
   "我想国庆去四川玩，10月1日出发，10月7日回，一共7天。想去成都、都江堰、九寨沟、黄龙、峨眉山、乐山，特别想看熊猫。从北京出发，节奏紧凑一点没关系。"],
  ["② 素材注入",
   "看了一篇攻略：九寨沟要早点进沟，观光车先到长海再往回玩；门票旺季要提前在官方公众号预约。黄龙海拔3500多米，缆车上步行下比较省力，注意高反。峨眉山金顶看日出要住雷洞坪或金顶。乐山大佛可以坐船看全景。成都大熊猫基地要早上7点半开门就去，月亮产房的幼崽最可爱。"],
  ["③ 生成方案", "好，按这些帮我把7天的行程排出来吧。"],
  ["④ 调序变更", "把峨眉山和乐山调到前面去，先玩这两个再去九寨黄龙。"],
  ["⑤ 返程约束", "补充一下：返程是10月7日下午从成都双流机场飞北京，最后一晚要住成都。"],
  ["⑥ 订票汇报", "成都和九寨沟的酒店我都订好了。"],
  ["⑦ READY 确认", "其他准备事项我都处理完了，确认方案没问题。"],
];

async function main() {
  const { agent, store, scheduler } = createRiddleAgent();
  const transcript: any[] = [];
  agent.subscribe((ev: any) => {
    if (ev.type === "tool_execution_start") console.log(`  [tool→] ${ev.toolName ?? ev.toolCall?.name}`);
    if (ev.type === "tool_execution_end") {
      const t = ev.result?.content?.[0]?.text ?? "";
      console.log(`  [tool✓] ${ev.toolName ?? ""} ${t.slice(0, 100)}`);
    }
  });

  for (const [title, text] of ROUNDS) {
    console.log(`\n${"=".repeat(20)} ${title} ${"=".repeat(20)}\n用户: ${text.slice(0, 60)}`);
    const t0 = Date.now();
    try {
      await agent.prompt(text);
    } catch (e) {
      console.log(`!! 轮次异常: ${(e as Error).message}`);
      transcript.push({ round: title, error: (e as Error).message });
      continue;
    }
    const last: any = [...agent.state.messages].reverse().find((m: any) => m.role === "assistant");
    const reply = typeof last?.content === "string" ? last.content
      : (last?.content ?? []).map((c: any) => c.text ?? "").join("");
    console.log(`Riddle: ${reply.slice(0, 400)}`);
    console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] 阶段=${store.trip.stage} events=${Object.keys(store.trip.events).length} pending=${scheduler.size}`);
    transcript.push({ round: title, input: text, reply, stage: store.trip.stage, pending: scheduler.size });
  }

  console.log(`\n${"=".repeat(50)}\n最终方案：\n${planDesc(store.trip)}`);
  console.log(`\n最终阶段: ${store.trip.stage}`);
  writeFileSync(`${store.dir}/walkthrough_ts.json`, JSON.stringify(transcript, null, 2));
  console.log(`走查记录: ${store.dir}/walkthrough_ts.json`);
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
