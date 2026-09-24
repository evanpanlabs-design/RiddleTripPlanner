# 0.5 共创编辑器 Schema 草案（v0.1 讨论稿）

> 定位：0.4 把"看"做顺了（v2 树直读、视觉分层、双向联动），0.5 把"改"做通——
> 用户可以直接编辑事件（时间/交通方式/备注/重排/插入），每次编辑都是一条带
> provenance 的 op；LOOP 尊重用户锚点，调整用户软值必须明说留痕。
>
> 前置文档：SPEC/event-model-v2.md（事件 Schema 基座）、SPEC/SPEC.md（判断体系）。
> 本文只定义 0.5 新增/变更部分；未定稿处标【待对齐】。

## 1. 三层时间模型（已定稿）

`time_window` 扩展一个字段、一个语义：

```ts
interface TimeWindow {
  start: string | null;        // HH:MM
  end: string | null;
  pinned?: boolean;            // true = 用户钉住（锚点），缺省 false
  // 层级判定：pinned → 钉住层；否则看该字段的 provenance
  //   user           → 用户软值层
  //   api/llm_inference/缺省 → 派生层
}
```

| 层 | 判定 | LOOP 权限 |
|---|---|---|
| 派生层 | provenance ≠ user 且未钉 | 顺序变就重算，随便调 |
| 用户软值 | provenance = user 且未钉 | 可调，但**必须在回复中明说 + ops 留痕** |
| 钉住层 | `pinned = true` | **免碰**，只能用户拔钉 |

行为规则（讨论已定稿）：

- 拖拽只改 `seq`，不改时间；派生层时间随顺序自动重算
- 手动改时间**不自动钉**；钉/拔钉只走图钉按钮（`pin_event` op）
- LOOP 调整软值 → 回复中明说（"我把 xx 从 10:00 挪到了 14:00"）+ op payload 记录 old/new
- 钉住冲突（订好的班次 vs 新顺序/新时间）→ HITL 卡片，不静默绕过
- 机械冲突校验（时间倒挂/重叠）**即时标红**，允许暂存非法态；D7 前必须清零
- 预订完成（清单勾选 / 聊天说"订好了"）→ 对应事件自动落钉

## 2. 编辑操作（op 类型扩展）

全部走 ops.jsonl event sourcing，兼容既有快照 undo：

```ts
// 手动微调：时间/交通方式/备注；被改字段 provenance 置 user（不自动钉）
edit_event { event_id, patch: { time_window?, note?, mode? } }

// 拖拽重排：只动 seq；受影响 route 标 stale
reorder_events { day, ordered_ids: string[] }

// route 上插 POI：route 分裂为两段 + 新建 draft poi 节点；
// 下轮 LOOP 负责地理解析 + 时间重排
insert_poi_on_route { route_id, name, after: "from" | "to" }

// 图钉
pin_event { event_id, pinned: boolean }
```

**route stale**：`detail.stale = true` 表示"端点顺序已变，里程/耗时/几何待重算"。
下轮 LOOP 优先消费 stale route；D7 校验把未清 stale 计入 fails。

## 3. API（同步落 op，不触发 LLM 轮）

```
PATCH /api/events/:id?project=        { patch }                    → edit_event
POST  /api/events/reorder?project=    { day, ordered_ids }         → reorder_events
POST  /api/events/insert-on-route?project= { route_id, name }      → insert_poi_on_route
POST  /api/events/:id/pin?project=    { pinned }                   → pin_event
```

统一行为：校验 → 落 op → save → `state_dirty` 广播 → 返回 statePayload。
非法态（时间倒挂）允许保存但响应带 `conflicts: [...]`，前台即时标红。

## 4. Event Wiki（双层文档）

路径：`runs/<trip_id>/docs/<event_id>.md`，frontmatter 分区：

```md
---
event_id: evt_xxx
updated_at: 1735689600000
---
<!-- layer:llm -->
（LLM 可读层：结构化要点、注意事项、预订状态——只能由工具写）

<!-- layer:user -->
（用户随手记层：原样保留，LLM 只读不改）
```

- 新工具：`read_event_doc(event_id)`、`write_event_doc(event_id, content)`
  —— write 只写 llm 层；用户层只能前台编辑（`PUT /api/events/:id/doc`）
- 上下文节约：LOOP 只在事件被引用时读 llm 层，不进主 prompt
- UI：时间线行/详情面板出"文档"按钮 → 悬浮页（popover）双区展示

## 5. 交通模式偏好

`slots.mobility: "general" | "self_drive"`（缺省 general）：

- general：跨城能飞机/高铁/火车就不开车；市内能地铁公交就不开车；短距骑行优于步行
- self_drive：大交通到枢纽后全程驾车（如飞西宁 → 青甘环线自驾）

注入点：SYSTEM prompt 说明 + `applyDraft` 补边默认 mode + D7 模式一致性校验（建议级）。
UI：输入框左侧模式 chip（类 Coding Agent 的模型选择器），切换即写槽位。

## 6. Tavily 可选搜索（默认关）

`settings.search: { enabled: false, apiKey: "" }`

先服务两个场景：清单查证（营业状态/政策核实）+ apply_plan 前政策核实。
【待对齐】先确认 Friday 网关是否自带搜索能力，有则优先复用，不引新依赖。

## 7. 校验扩展

| 规则 | 级别 | 说明 |
|---|---|---|
| 钉住事件机械冲突 | 硬（fails） | 不静默绕过用户锚点 |
| stale route 未重算 | 硬（fails） | 顺序变了数据没跟上 |
| 模式不一致 | 建议级 | self_drive 却出现市内地铁段且无说明 |

## 8. 遗留配套（0.5 内消化）

- 阈值标定（S3 欠账）
- LLM D7 的 V2/V3 精简
- pi 开源项目（github.com/earendil-works/pi）模块参考 → 写进 CODEMAP 开发约定
