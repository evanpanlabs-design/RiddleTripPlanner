/** 0.4.2 卡片真阻塞 HITL 纯逻辑单测（不依赖外部 API）。
 * 覆盖：decidePending 消费队列 / 事件留痕 / 双决定幂等 / 拒绝不发令牌。
 * 用法：npm run test:hitl */
import { createRiddleAgent } from "../src/agent.ts";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
};

const rt = createRiddleAgent();
const events: any[] = [];
rt.onEvent(ev => events.push(ev));

// 1. 入队一个 slot_override pending（模拟 beforeToolCall 挂起）
const q1 = rt.scheduler.enqueue({
  question: "确认把 destination 从 [\"成都\"] 改为 [\"九寨沟\"] 吗？",
  kind: "slot_override",
  context: { slot: "destination", value: ["九寨沟"] },
});
const q2 = rt.scheduler.enqueue({
  question: "这次变更可能影响 R2 范围，确认按此调整吗？",
  kind: "d6_radius",
  context: { op: "换酒店", radius: "R2", confidence: 0.42 },
});
ok(rt.scheduler.size === 2, "两个 pending 入队");

// 2. 卡片确认非队首元素（点卡片不一定是队首 → remove by id）
const consumed = rt.decidePending(q2.id, true);
ok(consumed?.id === q2.id, "卡片决定返回被消费的 pending");
ok(rt.scheduler.size === 1 && rt.scheduler.peek()?.id === q1.id, "非队首 pending 被按 id 移除");
const consumeEv = events.find(e => e.type === "pending" && e.action === "consume");
ok(consumeEv?.source === "card" && consumeEv?.approved === true && consumeEv?.id === q2.id, "consume 事件留痕（source=card, approved）");

// 3. 幂等：同一 pending 二次决定返回 null（防双击/重放）
ok(rt.decidePending(q2.id, true) === null, "同一 pending 二次决定返回 null");
ok(rt.scheduler.size === 1, "二次决定不影响队列");

// 4. 拒绝：出队且不发令牌（事件 approved=false）
const rejected = rt.decidePending(q1.id, false);
ok(rejected?.id === q1.id, "拒绝路径返回 pending");
ok(rt.scheduler.size === 0, "拒绝后队列清空");
const rejectEv = events.filter(e => e.type === "pending" && e.action === "consume").pop();
ok(rejectEv?.approved === false && rejectEv?.source === "card", "拒绝事件 approved=false");

// 5. 不存在的 id
ok(rt.decidePending("pq_ghost", true) === null, "幽灵 id 返回 null");

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
