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
                 ├─ ResilientJudge（jev/resilient-judge.ts）─ Jev API，失败退级 LLM（llm-judge.ts）
                 ├─ TripStore（memory/trip-store.ts）─────── runs/<trip_id>/ 持久化
                 └─ Scheduler（scheduler/scheduler.ts）───── runs/<trip_id>/pending.json
```

## 2. 核心模块职责（APP/src/）

| 文件 | 职责 | 关键导出 / 阅读锚点 |
|---|---|---|
| `agent.ts` | **装配核心**：SYSTEM prompt、7 个工具定义、Jev 三个注入点、applyDraft 落图、卡片 HITL | `createRiddleAgent()`；`transformContext`（D1 意图+pending 消费）、`beforeToolCall`（槽位复核/D4 清单指代/D6 半径门禁）、`decidePending()`（0.4.2 卡片结构化决定→消费+放行令牌）、`applyDraft()`（草案→图，地理解析+边补全） |
| `jev/client.ts` | Jev HTTP 客户端封装 | `JevClient.ask(state, questions)` 批量判断；`d7Verify()` |
| `jev/resilient-judge.ts` | **弹性判断器（Jev→LLM 退级）** | 继承 `JevClient.ask`：Jev 停用/无 key/请求失败→自动切 LLM 判断（60s 冷却避免反复白等超时），恢复自动切回；切换发 `jev` 引擎事件留痕 |
| `jev/llm-judge.ts` | LLM 判断器（Jev 的退级替身） | 与 `JevClient.ask` 同接口：同 state/questions 输入、同 answers schema（noul/choice）输出；schema 清洗（非法值 fail-closed）；429 分钟级退避 |
| `jev/questions.ts` | **全部判断问题与阈值定义**（判断系统的"法典"） | `TH` 阈值表（intentState 0.8 / slotAccept 0.6 / checklistMatch 0.7…）；`INTENTS` + `STATE_CHANGE_INTENTS`；`d1IntentQuestions`、`d4ChecklistMatchQuestions`、`d6RadiusQuestion`、`d7VerifyQuestions`、`pendingConsumeQuestion` |
| `memory/trip-store.ts` | 领域模型 + event sourcing 存储 | `Trip`（checklist/candidate_pool + **events_v2** 唯一事实源；0.4.3 起 legacy v1 三表仅作迁移输入）；`gateReport()`（D3 阶段门槛机械检查）；`tripSummary()/planDesc()`（0.4.3 起直读 v2 树）；`TripStore`（ops.jsonl 日志/快照/undo + `undoUntil(seq)` 快照配对连吃——防留痕 op 错 pop；构造时 v1→v2 惰性迁移后剥离 v1，save 落盘只存 v2） |
| `memory/event-v2.ts` | **v2 事件 Schema**（poi/route/aoi 判别联合 + 嵌套规则 + provenance） | `assembleDraft()`（扁平草案→树，结构校验打回）；`checkChainCompleteness()`（V8 嵌套感知链条硬校验：子树端点等价 + AOI 内部链条，0.4.2 起并入 D7 报告）；`checkPlanQuality()`（Q1–Q3 方案质量判断，0.4.3 起并入 D7：Q3 营业时段冲突=硬校验，Q1 折返/Q2 强度=建议级）；`walkTree/childrenOf` |
| `memory/migrate-v2.ts` | v1→v2 迁移器（SPEC/event-model-v2.md §9） | `migrateTripV1toV2()`：Node_→poi / Edge_→route / Event_合并上移；status 与 provenance 映射 |
| `memory/edits.ts` | **0.5 共创编辑器数据层**（SPEC/editor-schema-0.5.md） | 三层时间模型（派生/用户软值/钉住）；四编辑 op `editEvent/reorderEvents/insertPoiOnRoute/pinEvent`（全 snapshot 落 op、不触发 LLM 轮；改 mode/顺序→route `stale`）；`checkTimeConflicts()`（按 day_refs 分桶查倒挂/重叠，即时标红允许暂存非法态）；`mergeTimeSovereignty()`（apply_plan 重建时钉住免碰/软值留痕明说/派生重算）；`pushPlanBatch/clearPlanBatch()`（apply_plan 分批缓冲：按段号幂等存稿、齐后合并、打回保留局部重提——大行程撞输出上限截断的根治） |
| `memory/geo-checks.ts` | **0.6 地理校验 + 非常规通勤路由策略**（纯函数零 IO） | `checkGeoSanity()`（H1 AOI 子事件 50km 孤儿=同名异地 / H2 行政区划白名单=目的地行政市+出发地，证据不足 fail-open / H3 方式-距离常识：步行≤20km 骑行≤100km 公交≤300km；打回文案带坐标+白名单+重查词）；通勤方式词表（WALK/DRIVE/…agent 共用一份事实源）；`specialRouteKind/estimateSpecialRoute`（索道=直线×1.05、摆渡船=河道弧线×1.2、景交车=园区路弧线×1.35，零 API，data_source=estimated）；`cityMatch`（行政后缀归一）；`geoProblemSig`（按事件名签名——agent 层 geoStreak 防抱死：同一问题第 3 次打回降级 advisory 转人工） |
| `scripts/fix-lingyun.ts` | 0.6 存量修复（一次性，停 server 后跑） | `npx tsx --env-file=../.env scripts/fix-lingyun.ts [trip] [点名] [城市]`：searchPoi 带城市限定重查→更正 geo/city→重算端点含该点或其父 AOI 的 route→checkGeoSanity 复核（已修凌云寺辽宁→乐山、报国寺北京→乐山） |
| `memory/event-docs.ts` | 0.5 event wiki 双层文档（e5） | `runs/<trip>/docs/<event_id>.md`：`<!-- layer:llm -->`/`<!-- layer:user -->` 双标记分层；`readEventDoc/writeEventDocLayer`——写只动本层、另一层原样保留 |
| ~~`memory/project-v1.ts`~~ | 已删除（0.4.3） | v2→v1 投影兼容桥退役：前台/D7/摘要全部直读 v2 树 |
| `tools/baidu-place.ts` | 百度 Place 检索+详情（0.4.1 富化） | `enrichFromBaidu()`：opening_detail/price/rating/scope_grade/classified_poi_tag；0.4.4 起 30 天磁盘缓存（`runs/_cache/baidu-place/`，含负缓存；异常不写缓存） |
| `tools/limiter.ts` | 共享限速器（0.4.4） | `createMinInterval(getIntervalMs)`：串行 Promise 链，间隔调用时动态读取 → 设置保存即时热生效；baidu/amap/llm-judge 三方共用 |
| `tools/osm-aoi.ts` | OSM AOI 边界异步获取器（SPEC §7 第①级） | `fetchAoiBoundary()`（Nominatim→Overpass 镜像轮询→WGS84→GCJ02→DP 抽稀→30 天缓存）；`convexHull`（包络兜底） |
| `scheduler/scheduler.ts` | 阶段机 + pending 队列（持久化） | `Scheduler.enqueue/dequeue/remove(id)`；队列落盘 `pending.json`，重启恢复 |
| `tools/amap.ts` | 高德 Web 服务（POI/驾车/测地线；0.4.4 起主力数据源） | `searchPoi`、`drivingRoute`、`geodesicM`；限速走 `limiter.ts` 共享 throttle（v3/v4 共用一条队列，默认 2.5 QPS，设置可调） |
| `tools/baidu.ts` | 百度 Direction v2 跨城大交通（0.4.4 起只留铁路大交通+详情富化） | `intercityRoute(from, to, prefer)` → 真实车次/航班号+时刻+票价；限速同 amap（独立 `baiduQps`） |
| `settings.ts` | 设置中心：三级解析（设置文件 > 环境变量 > 预设） | `resolveLlm/resolveJev/resolveAmapWebKey/resolveBaiduWebKey/resolveLimits`——全部**调用时解析**（热生效）；`limits.llmRpm/amapQps/baiduQps`（null=默认：LLM 不限、地图 2.5 QPS）；`search`（0.5 e7 可选搜索占位，默认关未接入——Friday anthropic-messages 渠道不自带搜索）；`publicSettings`（脱敏快照，含 `limits.effective`） |
| `settings-test.ts` | 四路连通性测试 | `testConnection(kind)`：llm/jev/amap/baidu |
| `server.ts` | 多项目 HTTP 服务 | 项目注册表 `runs/projects.json`；SSE `broadcast`；`runTurn` 看门狗 + 0.4.4 网关故障留痕（`lastFailedTurn` → `failedTurn` 下发 + `/api/turn/retry` 重跑）；0.5 编辑 API（PATCH /api/events/:id、POST reorder/insert-on-route/:id/pin/slots/mobility、GET|PUT :id/doc，busy→409，响应带 `conflicts` 即时标红集合）；路由表见文件头注释 |

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
              <trip_id>/{trip.json, ops.jsonl, conv.json, pending.json, docs/（0.5 事件档案）}、
              _cache/（baidu-place 富化缓存，30 天 TTL，0.4.4 起）
```

## 4. 按问题找代码（推荐阅读路径）

| 想理解… | 路径 |
|---|---|
| 一轮对话怎么跑 | `server.ts` /api/input → `agent.ts agent.prompt` → `transformContext`（D1）→ LLM 工具循环 → `beforeToolCall` 门禁 → `prepareNextTurn` |
| 判断系统全貌 | `SPEC/SPEC.md`（D 表）→ `jev/questions.ts`（问题+阈值）→ `agent.ts` 三个注入点（搜"Jev 注入点"注释） |
| 意图分类 | `jev/questions.ts d1IntentQuestions` → `agent.ts transformContext`；意图分类法在 `ANALYSIS/02_intent_taxonomy_and_slots.md` |
| 清单实体级勾选（I6） | `agent.ts` 搜 `confirm_progress`：beforeToolCall 的 D4 逐项复核 + `approvedChecklist` 旁路 + `checklist_confirm` pending |
| pending 队列机制 | `scheduler/scheduler.ts` + `agent.ts transformContext`（挂起消费判定 0.6 阈值） |
| 方案落图与校验 | `agent.ts applyDraft`（地理/边补全）→ `d7Verify`（LLM V1–V7）+ `checkChainCompleteness`（V8）+ `checkPlanQuality`（Q1–Q3）→ 失败 `store.undo()` |
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
