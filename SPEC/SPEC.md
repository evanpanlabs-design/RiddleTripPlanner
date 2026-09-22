# Riddle 技术规格说明书（SPEC）

> 版本：v0.1（2026-09-21） | 状态：草案待审
> 上游依据：`PRD/PRD.md` v0.2（已审议）、`ANALYSIS/` 全部共识
> 读者：工程、Agent 开发。与 PRD 的关系：PRD 稳定（what/why），本文档常变（how）。

---

## 1. 系统架构总览

```
┌─────────────────────────────────────────────────────┐
│ 交互层  对话 IO / 方案渲染（UI 线后置，验证期用文本）    │
├─────────────────────────────────────────────────────┤
│ 决策层  Jev（真实 API）                                │
│   意图分类 · 槽位抽取 · 完整性检查 · 指代消解            │
│   澄清选题 · 传播半径 · 语义闭环校验                     │
├─────────────────────────────────────────────────────┤
│ 生成层  LLM                                           │
│   素材理解 · 文案生成 · 工具调用参数构造 · 澄清措辞       │
├─────────────────────────────────────────────────────┤
│ 工具层  高德 MCP/API（地理唯一底座）· WebSearch（L2）   │
├─────────────────────────────────────────────────────┤
│ 数据层  方案图存储 + event sourcing 操作日志 + 候选池    │
└─────────────────────────────────────────────────────┘
```

核心纪律（承 C/T/W 共识）：**L0 事实只走工具层，LLM 不生成地名/时间/距离；Jev 只做封闭 schema 决策，不生成文本；LLM 产出必须过 Jev 校验循环才可入图。**

### 1.1 Agent 拓扑（PiAgent 载体）

| 角色 | 模型 | 职责 |
|------|------|------|
| Orchestrator | 规则/代码 | 主循环调度：输入→感知→（澄清）→规划→校验→落图→传播→输出 |
| Perception | Jev | 意图分类、槽位抽取、指代消解、阶段判定 |
| Planner | LLM | 素材理解、方案生成/修改、工具调用、澄清与理由措辞 |
| Verifier | Jev | 语义闭环校验（§5）、传播半径判定、I5/I6 高阈值把关 |
| ToolExecutor | 代码 | 高德 MCP 调用、结果结构化、缓存 |

验证期先以**单 Agent + 函数调用**形态跑通（Orchestrator 主循环内依次调用各角色），拓扑预留多 Agent 拆分点：Perception/Verifier 可独立为常驻服务（Jev 延迟 70–500ms，适合同步调用）。

## 2. 领域模型 Schema

```jsonc
// Trip（方案根）
{
  "trip_id": "uuid",
  "stage": "explore|planning|preparing|ready",   // 四阶段，机械检查自动流转
  "slots": {                    // 行程级槽位 S1–S8
    "destination": ["AOI..."],  // S1 多级多目的地
    "date_range": {"start":"2026-10-01","end":"2026-10-07","fuzzy":false}, // S2 允许 fuzzy
    "origin": "AOI",            // S3
    "budget_band": "int|null",  // S4 可选
    "party": {"adults":2,"seniors":0,"children":0}, // S5
    "pace": "relaxed|tight|deep|null",  // S6
    "interests": ["..."],       // S7
    "stay_pref": "..."          // S8
  },
  "graph": {"nodes":[],"edges":[]},
  "candidate_pool": ["CandidateItem..."],
  "checklist": ["ChecklistItem..."]
}

// Node（共识 C9）
{
  "node_id":"uuid","amap_poi_id":"string|null",
  "name":"string","type":"poi|aoi","category_tags":["..."],
  "geo":{"lat":0,"lng":0},
  "opening_hours":{"weekly":"...","daily":"...","source":"amap|user|null"},
  "anchor":"none|lodging|terminal"   // 锚点类型（共识 C6）
}

// Edge（共识 C9）
{
  "edge_id":"uuid","from":"node_id","to":"node_id",
  "mode":"flight|train|metro|drive|bus|cycle|walk",
  "geometry":[[lat,lng],...],"distance_m":0,"duration_s":0,
  "data_source":"amap_drive|amap_geodesic|user_filled|empty"  // 跨城非驾车=empty/user_filled（P2）
}

// Event（锚定 Node 或 Edge，禁悬挂；跨日 Event 双日引用，共识 C11）
{
  "event_id":"uuid","anchor":{"kind":"node|edge","ref":"uuid"},
  "day_refs":[1,2],             // 跨日 Event 引用多日
  "kind":"visit|dine|consume|transit|lodging",
  "time_window":{"start":"HH:mm","end":"HH:mm","source":"amap|llm_inferred|user|empty"},
  "cost":"number|null",         // C1 开销记录
  "status":"candidate|tentative|locked"
}

// CandidateItem（池内不受无悬挂约束，共识 C5）
{"item_id":"uuid","name":"...","source_material":"...","amap_poi_id":"...|null",
 "status":"pooled|promoted|discarded","eval":{"by":"jev","score":0.0}}

// ChecklistItem（共识 M3）
{"item_id":"uuid","category":"booking|item|info","title":"...",
 "due_offset_days":-14,"exec_mode":"api|deeplink|manual",
 "info_spec":{"what":"...","expect":"...","impact":"..."},  // 仅 info 类：三要素
 "linked_entity":"node|edge|event id|null","done":false}

// PropagationRecord（共识 C7，已确认模板 v1）——见 ANALYSIS/01 §6
```

## 3. Jev 决策点契约（7 个，真实 API）

通用原则：封闭枚举输出 + 置信度；低置信 → 异步 HITL（挂起，不阻塞，下轮统一处理）；状态变更型阈值 > 信息型阈值（T1 补充共识，具体数值待 lab02 标定）。

**API 事实（2026-09-21 官方文档 + 冒烟测试验证）**：端点 `POST https://api.typesafe.ai/v1/systemone`；模型 `jev-latest`（实测 jev-1.13.0）；原语三种——Noul（是非概率）/Choice（≤255 选项单选+全概率分布）/Score（有序量表）；多问题一次调用并行评估。决策点到原语的完整映射与最佳实践见 `KB/jev/README.md`；集成代码遵循官方 agent skill（`.catpaw/skills/typesafe-ai/`）。冒烟测试结论：多标签意图用并行 Noul 可行，中间概率真实存在（探索类 0.56 案例）→ 阈值分级与 HITL 确有必要。

| # | 决策点 | 输入 | 输出 schema | 阈值策略 |
|---|--------|------|-------------|----------|
| D1 | 意图分类（多标签） | 用户输入+方案状态摘要 | `{I1..I8: prob}` | 信息型 0.6 / 状态变更型(I4-I6) 0.8（初值） |
| D2 | 槽位抽取 | 用户输入 | `[{slot, value, prob}]` | 低置信槽位不入库→转澄清 |
| D3 | 完整性检查 | 图+槽位 | `{stage, missing:[], gate_pass:bool}` | 机械检查，无阈值；达标自动流转（T2） |
| D4 | 指代消解 | 输入+图实体列表 | `{entity_id, prob}|{candidates:[...]}` | 歧义→候选点选，不猜 |
| D5 | 澄清选题 | missing 槽位+阻塞度 | `{next_slot_id, max_ask:1-2}` | —— |
| D6 | 传播半径 | 图操作+当日密度/耗时占比/锚点属性 | `{radius:"R1|R2|R3", prob, affected:[...]}` | 低置信→异步 HITL（C7） |
| D7 | 语义闭环校验 | 待入图方案 | `{V1..V7: pass|fail|warn, prob}` | fail→打回重生成；warn→标注用户确认 |

## 4. 主循环（Orchestrator）

```
on_user_input(text/material):
  1. D1 意图分类 → 多标签集合
  2. 按标签分发：
     I1 → Planner 解析素材 → D6/D7 前置评估 → 候选池入池
     I2 → 池状态路由（M1）→ 池内问答 or 降级引导
     I3 → D2 槽位抽取 → 冲突? 显式确认(T3) : 覆盖
     I4 → D4 指代消解 → 图操作 → D6 传播 → D7 校验 → 落图
     I5/I6 → 高阈值确认 → 锁定/checklist 勾选
     I7 → L0 字段回填 → 触发受影响 Event 重算
     I8 → event sourcing 回滚/查询
  3. D3 完整性检查 → 阶段流转（自动）
  4. D5 澄清选题（若缺槽且有必要）→ Planner 措辞
  5. 输出：方案变更摘要 + 理由 + （可选）澄清问题 + 建议 chips
```

## 5. 语义闭环校验项（D7 检查清单，"语义闭环核验"叙事的工程实体）

| 编号 | 检查项 | 判定 |
|------|--------|------|
| V1 | 时间连续 | 日内 Event 时间窗不重叠、衔接可行；跨日 Event 时间链不断（C11） |
| V2 | 空间衔接 | 相邻 Event 的 Node/Edge 地理可达；跨日空间锚点匹配（T 日终点=T+1 起点） |
| V3 | 营业/开放约束 | Event 时间窗 ⊂ Node 营业时段（含周一闭馆类周规则）；数据源缺失→warn |
| V4 | 无悬挂 | 图内每个 Event 有锚点；每个图元素承载 Event（仅方案图，池豁免） |
| V5 | 锚点约束 | 每日起终点为住宿/场站锚点；锚点迁移已触发重排（C6） |
| V6 | 物流可行性 | Edge 耗时×交通方式满足时间窗（含缓冲建议，如"宁可早到站"类） |
| V7 | checklist 覆盖 | 图中需预订/预约/查询的实体均有对应 checklist 项 |

fail → 附原因打回 Planner 重生成（最多 2 次，仍 fail 转用户）；warn → 标注展示，用户确认。

## 6. 数据层

- **方案图**：JSON 文档存储（验证期本地文件即可），按 trip_id 组织
- **event sourcing**：每次图操作追加 `{op_id, ts, op_type, payload, propagation_ref, undo_ref}`；回滚=反向重放（I8）
- **候选池/清单**：随 Trip 文档内嵌
- **高德缓存**：POI/路线结果按 `amap_poi_id+query_hash` 缓存，营业信息标记 `fetched_at`（过期策略待定，见开放问题 S2）

## 7. 工具层契约（高德）

| 能力 | 接口 | 用途 | 已知约束（LAB01/KB） |
|------|------|------|----------------------|
| POI 搜索/详情 | Web Service / MCP | Node 落图、营业信息 | 类别差异字段按 C9 |
| 驾车路线 | direction/driving | 跨城/城区 Edge | 跨城可用 |
| 测地线 | distance（geodesic） | 无路线时的 Edge 兜底 | 仅直线距离，无耗时——Edge 标 `amap_geodesic` |
| 骑行/步行/公交 | JSAPI v2.0 / V4 | 城区 Edge | v2.0 骑行返回无 `.rides`（LAB01 坑）；Transfer 不支持跨城 |
| 火车/飞机 | **无源** | —— | Edge 标 `empty`，走留空回填（P2/C10） |

## 8. 四川六日环线验证走查（gold truth #1 概要）

输入序列（模拟真实多轮）：①需求文本（六地六天+看熊猫）→ ②攻略文本若干（I1 入池）→ ③生成初版 → ④"峨眉乐山调前面"（I4 传播 R3）→ ⑤补充返程航班约束（I3/I7）→ ⑥订好酒店汇报（I5/I6）→ ⑦READY 判定。

预期产出对照点（与圆周旅迹保存页逐项对比）：地理可行性判断、每日动线、交通耗时与班次留空、缓冲建议、片区住宿建议、抢票/预约 checklist、信息类三要素（如"九寨沟国庆是否限流"→查什么/预期/流程指导）。对比维度与评分表在 lab02 中实现。

## 9. 错误处理与降级

- 高德调用失败 → Edge 降级 `amap_geodesic` 或 `empty`+留空；Node 信息缺失字段标 `source:null`（V3 转 warn）
- Jev 超时/失败 → 该决策点转 LLM structured output 单次替补 + 标记 `degraded:true`（校验类 D7 不替补，直接 fail-safe 转用户确认）
- LLM 生成 2 次不过 D7 → 输出当前最优草稿+未通过项清单，交用户裁决
- 所有降级事件写入操作日志

## 10. 性能与成本（验证期目标值）

- 单轮交互端到端 < 15s（Jev 调用 ≤3 次/轮，高德调用并行）
- gold truth 全跑通 LLM token 成本记录留档（为 PRD 商业测算供数）

## 11. 开放问题（2026-09-21 用户裁决）

- S1（PiAgent 多 Agent 消息协议）：**延期**。验证期单 Agent + 函数调用形态下无此问题；仅当 Perception/Verifier 拆分为独立进程时才需评估 chord 包的通信能力，拆分时再读码确认。
- S2 ✅ **高德数据过期刷新策略（已确认）**：①**新查询覆盖旧查询**（last-write-wins，以查询时间为准，字段记 `fetched_at`）；②**用户回填 > API 数据**（C10 哲学：用户自己查到的最信，API 与用户值冲突时以用户值为准并提示）；③**惰性刷新**：不做主动轮询，实体被规划/校验触及时若 `fetched_at` 超过 N 天则重新查询（N 初值 7，lab02 后调）。
- S3 ✅ **阈值标定（已确认）**：Jev 首日接入，阈值用暂定值（信息型 0.6/状态变更型 0.8），lab02 跑完四川案例后回放操作日志标定。不采用纯 LLM 先行方案（双实现迁移成本+LLM 置信度未校准）。
- S4 ✅ **Jev 配额无限流问题**（个人使用实测）；API key 已建文件：工作区根目录 `.env`（JEV_API_KEY 已粘贴，JEV_BASE_URL=https://api.typesafe.ai/v1，另配 SDK 默认变量 TYPESAFE_API_KEY；`.env.example` 为模板，`.gitignore` 已屏蔽）。2026-09-21 冒烟测试通过。

## 修订记录

- v0.1 (2026-09-21): 首版，基于 PRD v0.2 与全部分析共识。
- v0.2 (2026-09-21): 开放问题裁决——S1 延期（单 Agent 形态无需协议）；S2 确认为新查覆盖旧查+用户回填优先+惰性刷新；S3 建议 Jev 首日接入+暂定阈值+lab02 回放标定（待确认）；S4 无限流，key 文件 `.env` 已建。
