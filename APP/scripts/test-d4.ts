/** D4 指代上下文回归测试：直接打 Jev，验证 open_checklist 语境下的两类输入。
 * A「剩下两样我也都弄好了」→ 两项都应 pass（指代可解析）
 * B「酒店我订好了」→ 酒店 pass、机票 block（部分提及不泛化） */
import { config } from "dotenv";
config({ path: "../.env" });
import { JevClient } from "../src/jev/client.ts";
import { d4ChecklistMatchQuestions } from "../src/jev/questions.ts";

const jev = new JevClient();

const itemsA = [
  { id: "a1", title: "老人备防滑步行鞋、护膝与常备药", category: "item" },
  { id: "a2", title: "查洪崖洞/索道/博物馆的限流与预约规则", category: "info" },
];
const rA = await jev.ask(
  { user_input: "剩下两样我也都弄好了。", open_checklist: itemsA.map(i => i.title) },
  d4ChecklistMatchQuestions(itemsA),
);
console.log("A 指代型全完成（期望两项 ≥0.7）:");
for (const it of itemsA) console.log(`  ${it.title} → ${rA[`chk_${it.id}`]?.noul}`);

const itemsB = [
  { id: "b1", title: "订解放碑附近酒店", category: "booking" },
  { id: "b2", title: "购买返程机票", category: "booking" },
];
const rB = await jev.ask(
  { user_input: "酒店我订好了。", open_checklist: itemsB.map(i => i.title) },
  d4ChecklistMatchQuestions(itemsB),
);
console.log("B 部分提及（期望 酒店 ≥0.7 / 机票 <0.8）:");
for (const it of itemsB) console.log(`  ${it.title} → ${rB[`chk_${it.id}`]?.noul}`);

const passA = itemsA.every(it => (rA[`chk_${it.id}`]?.noul ?? 0) >= 0.7);
const passB = (rB.chk_b1?.noul ?? 0) >= 0.7 && (rB.chk_b2?.noul ?? 0) < 0.7;
console.log(passA && passB ? "✅ D4 回归通过" : "❌ 未达预期");
