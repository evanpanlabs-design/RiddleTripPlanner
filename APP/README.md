# Riddle APP — 基于 pi-agent-core 的正式实现

LLM agent 为主体（DeepSeek），Jev 为嵌入 loop 的判断引擎。架构契约见 `SPEC/ARCH-pi.md`，领域逻辑事实源为 `LAB/lab02-agent-pipeline`（Python 原型）。

## 运行

```bash
npm install
npm run demo        # 冒烟：两轮输入（需求 → 生成方案）
npm run typecheck
```

密钥从工作区根目录 `.env` 读取（JEV_API_KEY / AMAP_WEB_SERVICE_KEY / DEEPSEEK_API_KEY）。

## 结构（三系统显式化）

| 模块 | 职责 | pi 原语 |
|------|------|---------|
| `src/agent.ts` | Agent 装配 + Jev 三注入点 | Agent / beforeToolCall / transformContext / prepareNextTurn |
| `src/jev/` | 判断引擎客户端 + 问题单文件（questions.ts 可审） | — |
| `src/memory/trip-store.ts` | 领域记忆（Trip 图）+ 审计记忆（event sourcing ops.jsonl + undo） | — |
| `src/scheduler/scheduler.ts` | 调度系统：阶段机 + pending-question 队列 | prepareNextTurn |
| `src/tools/amap.ts` | 高德 POI/驾车/测地线（QPS 节流+退避） | AgentTool |
| `src/run-demo.ts` | 冒烟 demo | agent.prompt / agent.subscribe |

## Jev 三注入点（"Jev 对 AI agent 影响"的可运行样本）

1. **transformContext（感知）**：每次 LLM 调用前执行 D1 意图分类，意图概率+当前阶段+pending 队首注入上下文——LLM 的生成被校准判断条件化。
2. **beforeToolCall（门禁）**：状态变更工具（update_slot/apply_plan/confirm_progress/rollback）执行前过 Jev 复核，证据不足 → block 并告知 LLM 澄清。LLM 不能绕过校准判断改变世界。
3. **prepareNextTurn（调度）**：D3 阶段门槛机械检查 + pending 队列消费判定。

## 冒烟结果（2026-09-22）

两轮输入跑通：①约束声明 → 4 槽位过 Jev 复核落库，explore→planning；②生成请求 → LLM 自主调 search_poi×11 + get_route + apply_plan，D7 七项校验通过，25 Event + 10 清单落图，航班时间正确留空待回填。

排障记录：beforeToolCall 的 ctx 结构是 `{assistantMessage, toolCall, args, context}`（消息在 `ctx.context.messages`），初版误读 `ctx.messages` 导致证据为空、Jev 全量误杀——副作用是意外验证了门禁的 fail-closed 特性（LLM 三次重试被拦后转而向用户诚实交代"本子还是空的"，未造假）。

## 四川 7 轮回放结果（2026-09-22，`npm run sichuan`，trip_34ef17fa）

**调度系统按设计工作，pending 队列修复了 Python 版的挂起无人消费缺陷。** 与 Python 版（轮轮硬推进）对比，TS 版展现了正确的 HITL 行为：

- **① 需求输入**：LLM 自主决策直接排了初版方案（21 Event/9 清单）——与 Python 版③才生成不同，这是"LLM 为主体"的自然表现，非缺陷
- **② 素材注入**：6 点位+6 事实入池；LLM 想用攻略知识改住宿锚点（山脚→雷洞坪看日出），**D6 判定低置信 → block + pending 挂起**，agent 转而向用户解释利弊请求确认
- **③ 生成请求**：pending 未消费，agent 正确拒绝推进，再次向用户解释待决问题
- **④ 调序变更**：pending 被消费（用户输入隐含确认），D6 判 R3 高置信自动执行，峨眉乐山前置 + 雷洞坪锚点变更一次落图成功
- **⑤ 返程约束**：D6 判定影响 10/6→10/7 整链 → pending 挂起
- **⑥⑦**：脚本输入未回答 pending（"酒店订好了"与待决问题无关），**系统正确保持挂起、拒绝状态变更**——最终阶段停 planning 是预期行为：真实用户回一句"按 1 改"即解锁

关键结论：Python 版的"轮轮推进"其实是过度执行（重庆案例暴露的缺陷），TS 版的 fail-closed + pending 消费判定（Jev 判 0.6）才是设计意图。对话质量也显著提升：agent 会主动解释 D6 拦截原因、给出备选方案（住川主寺/九黄机场/维持）让用户选。

修复记录：T3 槽覆盖检查初版把空数组 `[]` 误判为"已有值"导致全量死锁——空值判断需排除空串/空数组。

## 待办

- 四川 7 轮全量回放（对齐 Python 版 gold truth）+ 三泛化案例回放
- ~~修复 Python 版遗留：I6 checklist 实体级勾选（D4 指代入 beforeToolCall）~~ ✅ 已完成：confirm_progress 改 `items: item_id[]` 实体级参数，beforeToolCall 用 D4 批量 noul 逐项复核（state 带 open_checklist 供指代解析，阈值 TH.checklistMatch=0.7），未涵盖项跳过并入 checklist_confirm pending（部分确认不整体放弃，全同意发 chk: 令牌）；I3 的 D6 入门禁与 T3 槽覆盖确认此前已完成
- D6 半径判定接入 apply_plan 的修订路径（当前只在校验环节）
- UI 展示层（订阅 agent 事件流 → Notion 黑白风前端）
- 产出质量评测与阈值标定
