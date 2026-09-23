# Riddle 事件模型 v2 Schema

> 版本：v0.2（2026-09-23） | 状态：**已审过，0.4.1 已落地**
> 上游依据：0.4.x 设计讨论共识（事件分类建模 / 事件图管理 / 数据层百度+OSM Hybrid）
> 读者：工程、Agent 开发。与 SPEC.md 的关系：SPEC 描述 v1 现行模型，本文档是 v2 的迁移目标。
> 0.4.1 实现位置：`APP/src/memory/event-v2.ts`（Schema + 组装 + V8）、`migrate-v2.ts`（惰性迁移）、
> `project-v1.ts`（v2→v1 投影兼容桥，0.4.3 前台切换后退役）、`tools/baidu-place.ts`（place detail 富化）、
> `tools/osm-aoi.ts`（OSM 边界获取器）；纯逻辑单测 `APP/scripts/test-v2.ts`（`npm run test:v2`）。
> 落地偏差说明：v1 投影是 0.4.1 的兼容策略——v2 树为唯一事实源，UI/D7/摘要暂消费投影，与本文件不冲突。

---

## 1. 为什么需要 v2

v1 模型（`Node_ / Edge_ / Event_` 三层扁平结构）在 0.3.x 跑通了"生成→校验→落图"主循环，但暴露出四个结构性短板：

1. **无嵌套能力**。「九寨沟三日」在 v1 里是三个平铺的日级 Event，无法表达"九寨沟（AOI）⊃ 则查洼沟/日则沟（子 POI）"这种包含关系，导致 AOI 级的营业时间、门票、内部动线无处安放。
2. **字段稀薄**。节点只有 name/geo/anchor，没有价格、评分、营业时段、景区等级——而这些恰恰是 Jev 做方案质量判断（0.4.3）和用户决策最需要的素材。
3. **来源不可追溯**。v1 字段是 LLM 写的还是 API 查的无法区分，违反了"凡有 event 必有地信数据支持"的图管理准则——我们需要知道哪些字段可以信、哪些是推断、哪些必须找用户共创。
4. **语义链条脆弱**。v1 的"走得通"靠 D7 校验在落图后把关，但模型层面没有强制"相邻活动之间必须有通勤段"的结构约束，0.3.5 只能用 prompt 强约束 + 工程兜底补边。

v2 的目标：在不推翻 pi-agent-core 编排和 Jev 判别体系的前提下，把事件图升级为**有类型、可嵌套、字段带来源、结构自洽**的领域模型。

## 2. 事件分类与嵌套规则

### 2.1 三类事件

| 类型 | 含义 | 例子 |
|------|------|------|
| `poi` | 点状事件：发生在单个点位上的活动 | 拙政园游览、全季酒店住宿、苏州站乘降 |
| `route` | 线状事件：发生在一段位移上的活动 | 步行 800m、驾车 90km、G7002 次高铁 |
| `aoi` | 面状事件：发生在一个区域内部、有明确边界 | 九寨沟景区、西湖、故宫 |

### 2.2 嵌套规则（形式化）

```
children(poi)   = ∅                                   -- POI 不可嵌套，叶子
children(route) = route | poi                         -- 大交通段可含中转段/经停点
children(aoi)   = poi | route                         -- 景区可含景点与内部通勤
children(aoi)   ∌ aoi                                 -- AOI 不套 AOI
```

约束补充：

- **AOI 不到行政区级**：市/区/县不作为 aoi 事件（"苏州市"不是事件，是上下文）；aoi 的最小语义是"可作为一个活动单元被游览/经过的区域"。
- **嵌套深度 ≤ 3**：aoi ⊃ route ⊃ poi 是合法最深链（九寨沟 ⊃ 景区观光车段 ⊃ 五花海下车点）。再深一律拍平为同级 seq。
- **父事件的时间窗 ⊇ 所有子事件时间窗的并集**（服务端组装时强制校验）。
- **父事件的费用可以 = 子事件费用之和，也可以独立存在**（如门票含观光车），由 provenance 标记是 api 查的还是 llm 推断的。

### 2.3 与 v1 概念的对应

| v1 | v2 | 说明 |
|----|----|----|
| `Node_`（anchor=lodging/terminal/none） | `poi` 事件的 `detail.role` | 锚点不再是节点属性，而是 poi 事件的角色：lodging（住宿锚点）/ terminal（场站锚点）/ activity（普通活动） |
| `Edge_`（mode/distance/geometry） | `route` 事件 | 通勤边升格为一等公民事件，可以有子事件（中转）、可以挂清单项（取票） |
| `Event_`（anchor_kind=node/edge） | 废弃 | v2 事件即节点，不再有"锚定到节点/边"的间接层 |
| —（无对应） | `aoi` 事件 | 新增，承接景区级信息与内部结构 |

## 3. Schema 定义

### 3.1 基座 + 判别联合

所有事件共享基座字段，类型专属字段放在 `detail` 里（discriminated union，`kind` 是判别字段）：

```jsonc
// EventV2（基座）
{
  "event_id": "evt_a1b2c3d4",
  "kind": "poi | route | aoi",           // 判别字段
  "name": "则查洼沟",
  "parent_id": "evt_9z8y7x6w | null",    // 嵌套父事件；null = 顶层
  "seq": 2,                              // 同级事件内的顺序（从 1 开始）
  "day_refs": [2],                       // 所属行程日（可跨日，如夜班火车）
  "time_window": {
    "start": "09:30",                    // 日 + HH:MM，不存绝对时间戳（见 §4）
    "end": "12:00",
    "source": "api | user | llm_inference"  // 时间窗本身的来源
  },
  "cost": { "amount": 169.0, "currency": "CNY", "source": "api" } | null,
  "status": "draft | active | dropped",  // 草案 / 生效 / 已放弃（保留痕迹供回滚对照）
  "provenance": "api | user | llm_inference",  // 该事件整体的权威来源（字段级覆盖见 §5）
  "note": "LLM 或用户补充的自由文本，≤200 字",
  "detail": { /* 按 kind 判别，见 §3.2–3.4 */ }
}
```

`status` 语义：LLM 每轮提交的新草案里的事件初始为 `draft`；落图校验通过后整树转 `active`；用户删改时被替换的事件转 `dropped`（不物理删除，支撑"回滚到之前的状态"与面试 demo 的变更追溯叙事）。

### 3.2 poi detail

```jsonc
"detail": {
  "role": "activity | lodging | terminal",
  "geo": { "lat": 33.16, "lng": 103.91, "source": "api" },   // GCJ02（高德渲染直接可用）
  "poi_ref": {                                  // 数据源回指，便于复核与刷新
    "baidu_uid": "8e3b... | null",
    "amap_poi_id": "B0FF... | null"
  },
  "category_tags": ["旅游景点", "5A景区"],        // 百度 classified_poi_tag 拆分
  "scope_grade": "AAAAA | null",                // 景区等级（百度 scope_grade）
  "opening_detail": { /* 见 §4.2，可空 */ },
  "price": { "amount": 70.0, "desc": "旺季门票", "source": "api" } | null,
  "rating": { "score": 4.6, "votes": 200, "source": "api" } | null,
  "city": "苏州 | null"                          // 在线 POI 校验的同城 sanity 用
}
```

### 3.3 route detail

```jsonc
"detail": {
  "mode": "步行 | 骑行 | 公交 | 地铁 | 驾车 | 火车 | 飞机 | 大巴",
  "from_ref": "evt_...", "to_ref": "evt_...",     // 两端事件 id（必须是 poi 或 terminal 角色的 route 端点）
  "distance_m": 1500 | null,
  "duration_s": 1200 | null,
  "geometry": [[lng, lat], ...],                  // GCJ02 折线，已抽稀；空数组 = 待回填（推测弧线）
  "data_source": "amap_walk | amap_drive | amap_ride | baidu_transit | estimated | empty",
  "schedule": {                                   // 大交通真实班次（baidu_transit 才有）
    "line": "G7002",
    "depart": "08:15", "arrive": "08:55",
    "price": 39.5,
    "disclaimer": "查询当日代表性班次，出行前需复核"
  } | null,
  "is_entry_exit": false                          // true = AOI 的进出段（如景区大门→内部第一个点）
}
```

### 3.4 aoi detail

```jsonc
"detail": {
  "boundary": {
    "polygon": [[lng, lat], ...],                 // GCJ02，Douglas-Peucker 抽稀后 ≤200 点
    "source": "osm | envelope | user_confirmed",  // OSM 真边界 / 子事件外包络 / 用户确认
    "osm_relation_id": 7516592 | null,
    "attribution": "© OpenStreetMap contributors"  // ODbL 要求，source=osm 时必有
  } | null,
  "opening_detail": { /* 同 poi，景区级开放时段 */ },
  "ticket": { "amount": 169.0, "desc": "门票+观光车", "source": "api" } | null,
  "envelope_fallback": false                      // true = 边界是子事件外包络，UI 用虚线面渲染
}
```

## 4. 两个横切约定

### 4.1 时间表示：day + "HH:MM"

存 `day_refs`（行程第几天）+ `"HH:MM"` 字符串，**不存绝对时间戳**。理由：草案阶段用户反复改日期，绝对时间戳会导致全树级联重写；日程合理性判断（V1 时间衔接、V3 营业时间）只需要"第几天 + 几点"。唯一例外是 `route.detail.schedule`（真实班次带查询当日日期语义，但班次本身用 HH:MM 表述 + disclaimer 说明）。

### 4.2 opening_detail 结构（对齐百度 regular_open_hour）

百度 place/v2/detail?scope=2 返回的 `regular_open_hour.periods` 是结构化的按星期开放时段，直接作为我们的存储格式，零转换成本：

```jsonc
"opening_detail": {
  "periods": [
    { "open":  { "day": 1, "hour": 6, "minute": 45 },
      "close": { "day": 1, "hour": 17, "minute": 30 } }
    // day: 1–7 = 周一到周日；多个 period 覆盖整周
  ],
  "text": "06:45-17:30",              // 百度 shop_hours 原文，展示兜底
  "source": "api | user | llm_inference",
  "fetched_at": 1790158436615          // 数据新鲜度，缓存失效判断用
}
```

百度查不到的（小众点位），按共创哲学留 `null` 并进清单（category=info，info_spec.what="营业时间"），用户查到后回填，`source` 转 `user`。

## 5. Provenance：三级来源标记

每个关键字段（geo / time_window / cost / opening_detail / price / rating / boundary）都带 `source`：

| source | 含义 | 信任策略 |
|--------|------|----------|
| `api` | 百度/高德/OSM 真实返回 | 可信，直接参与 Jev 校验与 UI 展示 |
| `user` | 用户明确提供（对话或清单补记） | 可信，优先级高于 api（用户说改了就是改了） |
| `llm_inference` | LLM 推断 | **不可作为校验依据**，UI 展示必须带"推测"标记，D7 校验遇到它按"未知"处理（不算冲突，但要提示） |

事件级 `provenance` 是"该事件是谁提出的"：LLM 草案 = `llm_inference`，用户手动加 = `user`，API 数据直接落图（如未来酒旅订单导入）= `api`。字段级 `source` 可以比事件级更强（LLM 提的事件，坐标是高德解析的 → 事件 `llm_inference`，geo `api`）。

## 6. LLM 提交格式：扁平事件列表 + 服务端组装

LLM 不提交嵌套 JSON（嵌套结构在 0.3.x 已验证是幻觉与 token 重灾区），改为提交**扁平事件列表**，用 `parent_id + seq + entry/exit 标记` 表达结构，服务端组装成树：

```jsonc
// apply_plan v2 的草案格式（LLM 输出）
{
  "days": 8,
  "events": [
    { "tmp_id": "e1", "kind": "poi",  "name": "成都东站", "detail": {"role":"terminal"}, "day_refs":[1], "time_window":{"start":"07:30"} },
    { "tmp_id": "e2", "kind": "route","name": "成都→九寨沟", "detail": {"mode":"大巴","from":"e1","to":"e3"}, "day_refs":[1] },
    { "tmp_id": "e3", "kind": "aoi",  "name": "九寨沟", "day_refs":[1,2,3] },
    { "tmp_id": "e4", "kind": "poi",  "name": "则查洼沟", "parent_id":"e3", "seq":1, "day_refs":[2] },
    { "tmp_id": "e5", "kind": "route","name": "观光车 则查洼沟→日则沟", "parent_id":"e3", "seq":2, "day_refs":[2],
      "detail": {"mode":"公交","is_entry_exit":false} }
  ],
  "checklist": [ /* 同 v1 */ ]
}
```

服务端组装职责（applyDraft v2）：

1. `tmp_id → event_id` 映射，建父子引用（parent_id 悬空 → 校验失败打回）。
2. 同级按 `seq` 排序，检查 seq 连续性；AOI 的第一个/最后一个子事件若不是 route 且未标 `is_entry_exit`，自动补进出段标记推断。
3. 父事件时间窗 ⊇ 子事件并集校验（不满足 →  widen 父窗并记 `llm_inference`，或打回，由 D7 判）。
4. 地理解析与 v1 相同管线（POI 坐标、路线 distance/geometry），AOI 边界走 §7 的 fallback 链。
5. **结构性"走得通"保证**：同一天内相邻顶层活动事件之间必须有 route 事件连接——v2 把它从 0.3.5 的 prompt 约束 + 兜底补边，升级为 schema 层校验规则（V8，见 §8），LLM 漏了就是校验失败打回，不再悄悄补。

## 7. AOI 边界数据：百度 + OSM Hybrid 获取链

探测结论（2026-09-23）：百度 place/detail **无 AOI 面数据**（api_region_search 只到行政区级）；OSM 有真实边界（九寨沟 relation 7516592，4 条 outer way 236 点），但 Overpass 延迟高（实测 72s）且主实例常 504。

**Fallback 链**（逐级降级，异步执行不阻塞落图）：

```
① OSM 异步获取器：Nominatim 查 relation id（轻量）→ Overpass 镜像轮询
   （overpass.private.coffee 优先，主实例兜底；单 AOI 预算 90s 超时）
   → WGS84→GCJ02 坐标转换 → Douglas-Peucker 抽稀（ε≈50m，目标 ≤200 点）
   → 本地缓存（runs/_cache/aoi/<osm_relation_id>.json，30 天有效）
② 子事件外包络：AOI 内子事件 geo 的凸包，envelope_fallback=true，UI 虚线面渲染
③ 清单共创：清单加 info 项"确认 XX 景区大致范围"，用户确认后 source=user_confirmed
```

边界获取是**后台任务**：落图时 AOI 先以 ② 包络上线，① 成功后热替换（SSE 推 state_dirty 前端重绘），③ 只在前两条都失败时触发。

## 8. 校验规则演进（D7 → V1–V8）

| 规则 | 内容 | v1→v2 变化 |
|------|------|-----------|
| V1 时间衔接 | 同级事件时间窗不重叠、衔接合理；父窗 ⊇ 子窗并集 | 新增父子窗约束 |
| V2 空间可达 | 相邻事件空间可达；route 两端必须是 poi/terminal | 新增 route 端点类型约束 |
| V3 营业时间 | 事件时间与 opening_detail 不冲突（未知不算冲突） | 从自由文本升级为 periods 结构化判断 |
| V4 活动归属 | 每个事件要么顶层、要么 parent_id 有效且嵌套规则合法 | 从"无悬空"升级为嵌套合法性 |
| V5 每日锚点 | 每日首尾有 lodging/terminal 角色事件（或明确豁免） | 角色从节点属性改为 poi.role |
| V6 交通耗时 | route 的 duration 与时间窗匹配 | 不变 |
| V7 待办识别 | 需预订/查证的事项已入清单 | 新增：AOI 无边界且包络不可得 → 自动入清单 |
| **V8 链条完整（新）** | 同日相邻顶层活动事件之间必须存在 route 事件连接 | "走得通"从 prompt 约束升级为 schema 校验 |

## 9. 迁移映射（v1 → v2）

现有 runs/ 下的 trip.json 不丢，启动时惰性迁移：

```
v1 Node_  (anchor=lodging)  → poi { role:"lodging",  geo, city, amap_poi_id }
v1 Node_  (anchor=terminal) → poi { role:"terminal", ... }
v1 Node_  (anchor=none)     → poi { role:"activity", ... }
v1 Edge_                    → route { mode, from_ref, to_ref, distance_m, duration_s, geometry, data_source }
v1 Event_ (anchor_kind=node)→ 合并进对应 poi（day_refs/time_window/cost/status/note 上移）
v1 Event_ (anchor_kind=edge)→ 合并进对应 route
status 映射：candidate→draft, tentative→draft, locked→active
provenance：迁移数据的事件级 = llm_inference，geo/geometry 字段级 = api（它们本来就是解析来的）
```

迁移后 `auto` 补边（0.3.5 产物）转 `route { data_source: <原值>, note:"v1 工程兜底补边" }`，provenance=llm_inference。

## 10. 落地范围切分

| 版本 | 内容 |
|------|------|
| **0.4.1**（本文档审过后动工） | Schema v2 落地（类型定义 + 迁移器 + applyDraft v2 组装）；百度 place detail 接入（opening_detail/price/rating/scope_grade/classified_poi_tag 填充）；OSM AOI 异步获取器 + 缓存 + 包络兜底 |
| 0.4.2 | V8 嵌套感知图完整性校验进 D7；聊天卡片真阻塞 HITL |
| 0.4.3 | 时间线结构化展示（消费 v2 树）；Jev 方案质量判断（动线折返/强度均匀，吃 price/rating/opening_detail 字段） |

## 11. 明确不做（本版）

- AOI 套 AOI（行政区级区域建模）——需求不存在，复杂度翻倍。
- 绝对时间戳存储——改日期级联重写，收益为零。
- route 的实时路况/动态耗时——demo 范围外，data_source=estimated 已够表达不确定性。
- 边界数据的用户手绘编辑——共创到"确认/否定"粒度为止，不做地图编辑器。
