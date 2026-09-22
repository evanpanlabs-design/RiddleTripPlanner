# Riddle 代码地图（CODEMAP）

> 给代码探测 Agent（如 Graphify）的指路文档：从哪里进、每个文件管什么、按问题怎么读。
> 最后更新：2026-09-22（v0.2.0，Hybrid 高德+百度）。

## 0. 一句话定位

Riddle 是**三系统**旅行规划 Copilot：**LLM 只生成**（对话/方案/工具调用），**Jev（TypeSafe System One）做全部判断**（意图/复核/指代/半径/校验，均带概率阈值），**pi-agent-core 做主循环编排**。地图事实层 = 高德（底图/POI/同城驾车）+ 百度（跨城火车/飞机）。

**成型产品 = `APP/` + `UI/` + `SPEC/`**，其余目录是研究过程留档（见 §3）。

## 1. 运行入口与拓扑

| 入口 | 命令 | 说明 |
|---|---|---|
| `APP/src/server.ts` | `npm run serve`（:8787） | **主入口**：多项目 HTTP 服务（无框架 node:http）+ UI 静态服务 + SSE 事件流 + 设置 API |
| `APP/src/run-demo.ts` | `npm run demo` | 无 UI 的命令行 demo |
| `APP/src/run-sichuan.ts` | `npm run sichuan` | 四川 7 轮回放（对齐 Python 版 gold truth） |
| `APP/scripts/test-d4.ts` | `npm run test:d4` | Jev 清单指代回归（真实 API） |
| `APP/scripts/test-baidu.ts` | `npm run test:baidu` | 百度大交通回归（真实 API） |

```
浏览器 UI（UI/app.html，单文件无构建）
   │  HTTP + SSE
   ▼
server.ts ──► 每项目一个 RiddleRuntime（agent.ts createRiddleAgent）
                 ├─ Agent（@earendil-works/pi-agent-core）── LLM（设置中心解析）
                 ├─ JevClient（jev/client.ts）────────────── Jev HTTP API
                 ├─ TripStore（memory/trip-store.ts）─────── runs/<trip_id>/ 持久化
                 └─ Scheduler（scheduler/scheduler.ts）───── runs/<trip_id>/pending.json
```

## 2. 核心模块职责（APP/src/）

| 文件 | 职责 | 关键导出 / 阅读锚点 |
|---|---|---|
| `agent.ts` | **装配核心**：SYSTEM prompt、7 个工具定义、Jev 三个注入点、applyDraft 落图 | `createRiddleAgent()`；`transformContext`（D1 意图+pending 消费）、`beforeToolCall`（槽位复核/D4 清单指代/D6 半径门禁）、`applyDraft()`（草案→图，地理解析+边补全） |
| `jev/client.ts` | Jev HTTP 客户端封装 | `JevClient.ask(state, questions)` 批量判断；`d7Verify()` |
| `jev/questions.ts` | **全部判断问题与阈值定义**（判断系统的"法典"） | `TH` 阈值表（intentState 0.8 / slotAccept 0.6 / checklistMatch 0.7…）；`INTENTS` + `STATE_CHANGE_INTENTS`；`d1IntentQuestions`、`d4ChecklistMatchQuestions`、`d6RadiusQuestion`、`d7VerifyQuestions`、`pendingConsumeQuestion` |
| `memory/trip-store.ts` | 领域模型 + event sourcing 存储 | `Trip` 图（nodes/edges/events/checklist/candidate_pool）；`gateReport()`（D3 阶段门槛机械检查）；`TripStore`（ops.jsonl 日志/快照/undo） |
| `scheduler/scheduler.ts` | 阶段机 + pending 队列（持久化） | `Scheduler.enqueue/dequeue`；队列落盘 `pending.json`，重启恢复 |
| `tools/amap.ts` | 高德 Web 服务（POI/驾车/测地线） | `searchPoi`、`drivingRoute`、`geodesicM`；QPS 节流+退避 |
| `tools/baidu.ts` | 百度 Direction v2 跨城大交通 | `intercityRoute(from, to, prefer)` → 真实车次/航班号+时刻+票价；GCJ02 直传免转换 |
| `settings.ts` | 设置中心：三级解析（设置文件 > 环境变量 > 预设） | `resolveLlm/resolveJev/resolveAmapWebKey/resolveBaiduWebKey`——全部**调用时解析**（热生效）；`publicSettings`（脱敏快照） |
| `settings-test.ts` | 四路连通性测试 | `testConnection(kind)`：llm/jev/amap/baidu |
| `server.ts` | 多项目 HTTP 服务 | 项目注册表 `runs/projects.json`；SSE `broadcast`；路由表见文件头注释 |

## 3. 仓库全景（含研究留档）

```
APP/          ★ 产品本体（TypeScript，npm 工程）
UI/           ★ app.html 单文件前端（+ demo-shots 截图、hifi/lofi 原型）
SPEC/         ★ 设计文档：SPEC.md（判断体系 D 表/意图表）、ARCH-pi.md（pi-agent 架构）
PRD/          产品需求文档
ANALYSIS/     前期分析（信息架构/意图分类法/竞品）
KB/           外部 API 能力调研（amap-webservice/、baidu-webservice/ 实测索引）
LAB/          实验场：lab01 高德路线放大镜、lab02 Python 版 agent 管线（TS 版原型）、
              lab03 百度 transit 绘制验证、lab04 百度地图风格（结论：用标准底图）
amap-skills/  高德 JSAPI 官方 skill 留档
download/     竞品页面留档（圆周旅迹）
runs/（APP/runs/）   运行时数据：projects.json 注册表、settings.json、
              <trip_id>/{trip.json, ops.jsonl, conv.json, pending.json}
```

## 4. 按问题找代码（推荐阅读路径）

| 想理解… | 路径 |
|---|---|
| 一轮对话怎么跑 | `server.ts` /api/input → `agent.ts agent.prompt` → `transformContext`（D1）→ LLM 工具循环 → `beforeToolCall` 门禁 → `prepareNextTurn` |
| 判断系统全貌 | `SPEC/SPEC.md`（D 表）→ `jev/questions.ts`（问题+阈值）→ `agent.ts` 三个注入点（搜"Jev 注入点"注释） |
| 意图分类 | `jev/questions.ts d1IntentQuestions` → `agent.ts transformContext`；意图分类法在 `ANALYSIS/02_intent_taxonomy_and_slots.md` |
| 清单实体级勾选（I6） | `agent.ts` 搜 `confirm_progress`：beforeToolCall 的 D4 逐项复核 + `approvedChecklist` 旁路 + `checklist_confirm` pending |
| pending 队列机制 | `scheduler/scheduler.ts` + `agent.ts transformContext`（挂起消费判定 0.6 阈值） |
| 方案落图与校验 | `agent.ts applyDraft`（地理/边补全）→ `d7Verify`（V1–V7）→ 失败 `store.undo()` |
| 地图双源 Hybrid | `tools/amap.ts` vs `tools/baidu.ts`；能力调研结论在 `KB/baidu-webservice/INDEX.md` |
| 设置热生效原理 | `settings.ts` 文件头注释（所有 resolve* 调用时解析） |
| 历史原型对照 | `LAB/lab02-agent-pipeline/`（Python 版，questions.py 是 jev/questions.ts 的原型） |

## 5. 核心概念词汇表

- **Trip 图**：`nodes`（点位，带 geo/anchor）→ `edges`（段，带 mode/distance/geometry）→ `events`（每天的时间线项，锚定 node 或 edge）+ `checklist`（准备事项）+ `candidate_pool`（素材候选池）
- **D1–D7 判断**：D1 意图分类 / D2 槽位复核 / D3 阶段门槛（机械）/ D4 指代消解 / D5 下一问选择 / D6 传播半径（R1–R3）/ D7 方案校验（V1–V7）
- **意图 I1–I8**：I1 素材倒入 / I2 约束陈述 / I3 约束变更 / I4 方案确认 / I5 方案变更 / I6 进度汇报 / I7 询问 / I8 闲聊；I4/I5/I6 是状态变更意图（阈值 0.8）
- **pending 队列**：Jev 门禁拦截 → 显式问题入队（持久化）→ 用户回复语义回答时消费（Jev 判 0.6）
- **approval token**：`approvals` Set 里的一次性令牌（`slot:…` / `chk:…` / `d6:apply_plan`），pending 全员确认后发放，用一次即删
- **fail-closed**：概率不过阈值 = 不执行，转人工；宁挂起不猜

## 6. 外部依赖

| 依赖 | 用途 |
|---|---|
| `@earendil-works/pi-agent-core` + `pi-ai` | agent 主循环与 LLM 流式抽象（npm） |
| TypeSafe System One（Jev） | 判断引擎 HTTP API（`JEV_API_KEY`） |
| DeepSeek/Claude/OpenAI/GLM | LLM 生成层（设置可切） |
| 高德开放平台 | Web 服务 key（POI/驾车）+ JSAPI key+安全密钥（底图） |
| 百度地图开放平台 | 服务端 AK（跨城 transit） |
