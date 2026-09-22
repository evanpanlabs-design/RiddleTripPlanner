# Riddle × Pi 目标架构（v1，2026-09-22）

> 定位调整：LAB/lab02 的 Python 版降级为**逻辑验证原型**（领域模型、Jev 问题集、校验规则、走查案例继续作为事实源）；正式产品基于 **pi-agent-core**（TypeScript）重建——LLM agent 是主体，Jev 是嵌入 loop 的判断引擎。本文档是 pi 原语与 Riddle 系统的映射契约。

## 1. 总览：LLM agent 为主体，Jev 为判断引擎

pi 的 agent loop 是"LLM 在中心自主 steering"。Riddle 保留这个主体性（LLM 决定说什么、调什么工具），但在**所有状态变更的必经之路上嵌入 Jev 门禁**：LLM 可以自由生成，但不能绕过校准判断就改变世界。这就是"Jev 对 AI agent 的影响"这一讨论的可运行样本：

- 无 Jev 的 agent：LLM 说自己改了什么就改了什么（幻觉直达状态）
- 有 Jev 的 agent：状态变更 = LLM 提议 → Jev 裁决（校准概率+阈值）→ 执行或转人工

## 2. pi 原语 → Riddle 系统映射

| pi 原语（出处：learnPiAgent） | Riddle 用途 |
|---|---|
| `Agent` / `agentLoop`（agent-loop.ts:32） | agent 主体，LLM=DeepSeek（pi-ai 内置 provider，models.generated.ts:93） |
| `AgentTool`（types.ts:387） | 工具系统的载体（见 §4） |
| `beforeToolCall`（types.ts:278） | **Jev 门禁主注入点**：状态变更工具执行前过 Jev，低于阈值 → block 并返回"需用户确认" |
| `transformContext`（agent-loop.ts:288） | **Jev 感知注入点**：每次 LLM 调用前，把 D1 意图概率、当前阶段、pending 问题注入上下文 |
| `prepareNextTurn`（types.ts:138） | **调度系统主注入点**：每轮前做阶段门槛检查、压缩上下文、注入 trip_summary |
| `shouldStopAfterTurn` / `getSteeringMessages` | 调度：异步 HITL 确认到达时 steering 唤醒 agent |
| session-backends（sqlite） | 会话持久化（对话记忆） |
| `agent.subscribe`（agent.ts:250） | UI 展示层的事件源（九类 AgentEvent） |

## 3. 三大系统显式化

**记忆系统（三层）**：
① 工作记忆 = pi AgentContext 消息流（自带）；② 领域记忆 = Trip 图（nodes/edges/events/slots/checklist），只通过工具变更，JSON 持久化——直接迁移 lab02 models.py 的 schema；③ 审计记忆 = event sourcing 操作日志（迁移 lab02 store.py）+ pi sqlite session。`prepareNextTurn` 每轮把 trip_summary 注入，实现"领域记忆→工作记忆"的同步。

**工具系统**（AgentTool，typebox schema）：
只读工具：`search_poi`、`get_route`（高德，迁移 amap_tools 逻辑含 QPS 节流）、`get_trip_state`。
生成工具：`apply_plan_draft`、`revise_plan`（LLM 自己产出的草案落图——落图即校验，D7 不过则工具返回失败原因）。
状态变更工具（全部过 Jev 门禁）：`update_slot`（T3 覆盖需确认）、`confirm_checklist`（I5/I6 高阈值）、`rollback`（I8）、`resolve_pending`（回答待决问题）。

**调度系统**（新增，修复泛化测试三缺陷的核心）：
`SchedulerState` = 阶段机 + **pending-question 队列**（D6 低置信、T3 槽覆盖确认、D5 澄清统一入队）。规则：pending 非空时，新输入先经 Jev 判定是否在回答待决问题（是 → resolve；否 → 挂起新问题但保留队列）。这就是修复"重庆案例变更被挂起无人消费"的机制。

## 4. 判断引擎嵌入点（Jev 的七个决策点全部保留）

- D1 意图分类：`transformContext` 每轮执行，结果注入 LLM 上下文（概率可见 → 生成被校准判断条件化）
- D2 槽位抽取：`update_slot` 工具的 `beforeToolCall`
- D4 指代消解：`confirm_checklist` 等工具的 `beforeToolCall`
- D5 澄清选题：Scheduler 出队逻辑
- D6 传播半径：`revise_plan` 的 `beforeToolCall`
- D7 语义校验：`apply_plan_draft`/`revise_plan` 落图时执行（沿用代码+Jev 混合）
- D3 阶段门槛：纯代码，`prepareNextTurn`

阈值、问题定义继续以 lab02 `questions.py` 为事实源，TS 侧生成对应常量（单一可审文件原则保留）。

## 5. 目录规划

```
APP/                      # 正式产品（TS，基于 pi-agent-core）
  src/
    agent.ts              # Agent 装配（模型、工具、config 注入点）
    jev/                  # 判断引擎客户端 + questions 单文件
    memory/               # trip-store（领域记忆）+ oplog（审计记忆）
    tools/                # amap / trip 操作工具集
    scheduler/            # 阶段机 + pending 队列 + prepareNextTurn
    ui/                   # 后置：事件订阅 → Notion 风前端
  tests/
```

## 6. 路线（与用户排序一致）

① TS 骨架 + 三系统 + Jev 门禁跑通四川案例回放 → ② UI 展示层 → ③ 产出质量评测与迭代（gold truth 对比 + 阈值标定）。
