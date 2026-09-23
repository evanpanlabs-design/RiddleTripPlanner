# Jev（TypeSafe System One）使用参考

> 整理自官方文档（docs.typesafe.ai：quickstart / primitives / how-to-build / use-case-map / agent-skill），2026-09-21。
> 工作区已安装官方 agent skill：`.catpaw/skills/typesafe-ai/SKILL.md`（写集成代码时给 coding agent 用）。

## 1. 调用方式

- **端点**：`POST https://api.typesafe.ai/v1/systemone`
- **鉴权**：`Authorization: Bearer $TYPESAFE_API_KEY`（key 在工作区根 `.env`）
- **模型**：`jev-latest`（当前实测版本 jev-1.13.0）
- **SDK**：Python `pip install typesafe-sdk`（`TypeSafeClient()` 自动读 `TYPESAFE_API_KEY`）；另有 JS SDK
- **请求体**：`{state, model, questions: {<qid>: {type, instructions, criteria}}}`
- **响应体**：`{model, answers: {<qid>: {...}}, usage}`

## 2. 三种原语（primitives）

| 原语 | 语义 | 返回 | 适用 |
|------|------|------|------|
| **Noul** | 是非判断 | `noul: 0~1` 概率 | 检测类（是否含某属性）、校验类 pass/fail |
| **Choice** | 固定集合单选（≤255 选项） | `choice` + `probabilities` 全分布 + `confidence` | 分类、路由、指代消解 |
| **Score** | 有序量表 | `score` + 各级概率 + `confidence` | 程度评估（满意度、风险等级） |

`confidence` 由概率分布形状导出：单峰=高置信，平坦=低置信。**每个答案都带全概率分布**，可直接当特征用。

## 3. 官方最佳实践（how-to-build 要点）

1. **能用代码就不用模型**：确定性规则留在代码里，Jev 只做模糊判断。
2. **一次调用问多个问题**：questions 并行评估，加问题几乎不增加延迟（只加 token）。投机性问题（可能用不上的）也可以一起问，代码忽略即可。
3. **问题要原子化**：宽问题藏判断，窄问题可检查可调阈值。这是官方强调的第一原则。
4. **state 用结构化 JSON**：只给当前问题需要的上下文（防 context rot）；可用反引号路径引用嵌套值（如 `` `trip.slots.date_range` ``）。
5. **criteria 描述要把选项区分开**；易混淆的选项用对象结构（what / not_for / examples）；选项名和描述模型都可见；列表可能不全时加 `other` 选项。
6. **按置信度路由**：confident→自动执行，unconfident→升级人工/更贵模型。阈值要按各动作的风险分别设定，并用真实数据画"置信度-准确率"曲线标定。
7. **所有问题定义和阈值常量放一个文件**，方便人审（agent 写的问题要人来改）。

## 4. Riddle 决策点 → 原语映射（SPEC §3 的工程落地）

| SPEC 决策点 | 原语设计 |
|-------------|----------|
| D1 意图分类（多标签 I1–I8） | **8 个 Noul 一次调用**：每个意图一个是非概率，>阈值即命中——多标签天然适配并行 Noul |
| D2 槽位抽取 | 枚举型槽位（S6 节奏/S7 兴趣）→ **Choice**；自由值槽位（日期/预算）→ LLM 抽取 + **Noul 验证**（"文本是否表达了预算为 X？"） |
| D3 完整性检查 | 代码机械检查为主；语义性门槛（如"用户是否真的确认了方案"）→ Noul |
| D4 指代消解 | **Choice**：候选实体 id 列表 + `none_of_above`；歧义（低置信）→ 候选点选 |
| D5 澄清选题 | **Choice**：缺失槽位列表中选"下一个最值得问的"；criteria 带阻塞度描述 |
| D6 传播半径 | **Choice**（R1/R2/R3），criteria 用对象结构写清各级定义与典型场景（citywalk 删点=R1、单点日删点=R3） |
| D7 语义闭环校验 V1–V7 | **7 个 Noul 一次调用**：每项校验一个是非概率——正是官方 "Universal Verification" 用例 |

state 建议结构：`{user_input, trip_summary（图摘要+槽位）, candidates（实体列表）, material（I1 时的原文）}`，各问题用反引号路径取所需片段。

## 5. 与 Riddle 架构哲学的呼应

官方"AI-powered software"架构（代码拥有控制流，模型只做原子判断）与我们"Orchestrator 主循环 + Jev 决策点"完全一致；官方 "Harness Engineering"（Jev 给 LLM 做路由/护栏/错误检测）即我们的 Verifier 角色。我们的 LLM（生成）+ Jev（判断）+ 高德（事实）三层分工是官方推荐架构的具体实例。
