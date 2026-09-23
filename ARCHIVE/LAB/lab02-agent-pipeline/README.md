# LAB02 — Agent 流水线（SPEC §4 的可运行实现）

单 Agent + 函数调用形态跑通 Riddle 主循环：**Jev 决策 + DeepSeek 生成 + 高德事实 + 校验闭环 + event sourcing 回滚**。

## 结构

| 文件 | 角色 | 说明 |
|------|------|------|
| `models.py` | 领域模型 | Node/Edge/Event/CandidateItem/ChecklistItem/Trip + D3 机械阶段门槛 |
| `questions.py` | Jev 问题单文件 | 全部 D1–D7 问题定义与阈值（可审） |
| `jev_client.py` | Perception/Verifier | Jev API 封装：意图/槽位/指代/澄清/半径/校验 |
| `planner.py` | Planner | DeepSeek（OpenAI 兼容）：方案生成/修订/素材解析/话术 |
| `amap_tools.py` | ToolExecutor | POI 搜索/驾车路线/测地线，磁盘缓存（新查询覆盖旧查询） |
| `validator.py` | 校验循环 | 代码规则（V1/V4/V5/V6/V7 机械部分）+ Jev D7 合并 |
| `store.py` | 数据层 | Trip 快照 + ops.jsonl 操作日志 + undo 回滚 |
| `orchestrator.py` | Orchestrator | SPEC §4 主循环 |
| `run_sichuan.py` | gold truth 走查 | 四川 7 天 7 轮对话脚本 |
| `test_lab02.py` | 分层测试 | 15 项 |

## 运行

```bash
pip install -r requirements.txt   # requests, python-dotenv
python test_lab02.py              # 分层测试（LLM 层在无 key 时自动跳过）
python run_sichuan.py             # 全量走查（需 DEEPSEEK_API_KEY）
python run_sichuan.py --no-llm    # 降级走查（仅 Jev+高德层）
```

环境变量从工作区根目录 `.env` 读取：`JEV_API_KEY`、`AMAP_WEB_SERVICE_KEY` 已配置；`DEEPSEEK_API_KEY` 待填。

## 当前测试结果（2026-09-21）

分层测试 15/15 通过。关键实测：

- **D1 意图分级阈值生效**：约束声明类输入 I3=0.89（信息型 ≥0.6 即命中）；"确认方案没问题"I5=0.81（状态变更型 ≥0.8 才命中，擦线通过——阈值分级确实在干活）。
- **D6 传播半径**："返程机场双流改天府" → R3（跨日影响），判定合理。
- **D7 语义校验的敏感性**（重要发现）：不含任何预订状态说明的方案描述，V7 checklist 覆盖概率仅 0.14（fail）；补充"已预订"说明后正常。说明 D7 对 plan_desc 的信息完整性敏感——orchestrator 生成 plan_desc 时应把 checklist 状态一并写入，否则会产生误报。已记入待标定项。
- **V1 边界**：良好方案 V1 概率 0.57 落在 warn 带（0.35–0.6），阈值标定需等四川全量回放数据。
- 高德层：黄龙 POI、黄龙→九寨驾车路线、上海-成都测地线（≈1660km）、train 方式正确降级 `empty` 留空。

## 端到端走查结果（2026-09-22，四川 7 天 7 轮，trip_9098fb9f）

**全链路跑通：explore → planning → ready，39 个 Event、12 项 checklist 全部闭环。** 完整日志在 `runs/sichuan_walkthrough.log`。

七轮逐轮表现：① 槽位全抽出（days=7/origin=上海/pace=tight/destination 七地）→ 阶段自动流转 planning；② 素材入池 9 候选点位 + 10 条事实；③ "帮我排出来"意图未分类 → 兜底按生成请求处理 → **第 2 次生成通过校验**（重生成循环在干活）；④ I4=0.98，D6 判 R3（0.99）自动执行，峨眉乐山成功前置，第 1 次即过校验；⑤ 返程约束入槽；⑥ I6=0.97 → 锁定 39 Event + 勾 12 项 → ready；⑦ 确认收官。

首轮走查暴露并已修复的 4 个缺陷：

1. **date_range 漏抽**：用户只说"10月1日"无年份，LLM 按"只抽明确值"返回 null → 阶段卡死。修复：抽取 prompt 注入当前年份 + 推断"未来最近一次"，并新增 `duration_days` 槽（"一共7天"直接可信免复核）。
2. **意图未命中无兜底**："帮我排出来"不匹配 I1-I8 → 空转一轮。修复：意图空且已有目的地且无方案 → 按生成请求处理。
3. **高德 QPS 限流 + 落图非事务**：连续查 POI 触发 10021 错误，且先清图再填充导致崩溃后留下 Day2-9 全空的残态。修复：amap 层 0.4s 节流 + 指数退避重试；`_apply_draft` 改事务式（临时图构建成功才一次性交换，单项失败降级不中断）。
4. **天数被草案撑大**：LLM 自行加首尾缓冲日（7 天变 9 天）。修复：SYSTEM_PLAN 强制 days 等于状态值 + 落图时 `trip.days` 只在未定时才取草案值。

遗留问题（下轮处理）：I6 的 checklist 勾选是"都/全部"兜底全勾（轮次⑥用户只说成都和九寨酒店订好了，实际勾了全部 12 项含机票门票——过度勾选，需 D4 指代到具体项）；I3 新约束（返程双流机场）未触发既有方案传播修订；plan_desc 已补 checklist 状态消除 V7 误报。

## 泛化测试结果（2026-09-22，三案例，`run_cases.py`）

**3/3 全部到达 ready**，证明流水线不依赖四川案例的特定结构。完整日志 `runs/generalization.log`，各案例结果 `runs/<trip_id>/case_result.json`。

| 案例 | 设计考点 | 结果 | 关键观察 |
|------|---------|------|---------|
| 重庆3日 | 双人休闲、市内交通、同片区合并 | ready，33 Event/9 项 | D6 置信度 0.40 低于 0.6 → **正确转入人工确认**（HITL 生效），但走查脚本没回答待决问题，变更未执行——需要 pending-question 状态管理 |
| 天津2日 | 带老人、相对日期（"周六早上"）、跨城 | ready，22 Event/7 项 | duration_days=2 兜底生效；但轮次④"海博放第二天上午"**I4 漏判**（意图空），方案恰好在初版就合理——意图分类有漏召回 |
| 黄山4日 | 单人、山岳+古村、住宿锚点变更 | ready，34 Event/11 项 | 锚点变更（山上→汤口）触发 R3（0.61 擦线自动执行），第 2 次修订通过，日出相关 Event 正确移除；**destination 槽被"汤口镇"污染**（变更请求中的地名不应覆盖目的地槽，违反 T3 需显式确认） |

新发现待办：①pending-question 状态（D6 转人工后，后续输入应先消费待决问题）；②I4 召回不足（"把X放第N天"句式未命中）；③destination 等核心槽覆盖需走 T3 显式确认路径。

## 已知待办

- 阈值标定（S3）：用走查回放数据校准 `questions.py::TH`（重点 V1 0.6 是否偏高）。
- I5/I6 的 checklist 勾选做实体级匹配（D4 指代到具体 checklist 项）。
- I3/I7 约束变更后触发 D6 传播评估 + 方案修订（当前只入槽不改图）。
- 与圆周旅迹保存页逐项对比产出质量（SPEC §8 对照点）。
