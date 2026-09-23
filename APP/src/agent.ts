/** Riddle Agent 装配：pi-agent-core 为主体，Jev 判断引擎嵌入 loop 三个注入点。
 *
 * 注入点（SPEC/ARCH-pi.md §2）：
 * - transformContext：每次 LLM 调用前执行 D1 意图分类，概率+阶段+pending 队首注入上下文
 * - beforeToolCall：状态变更工具过 Jev 门禁（槽位复核/半径判定/确认阈值），低置信 → 转 pending 队列
 * - prepareNextTurn：阶段门槛机械检查（D3），调度 pending 队列
 */
import { Agent, type AgentTool, type AgentMessage } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";
import { join } from "node:path";
import { JevClient } from "./jev/client.ts";
import { ResilientJudge } from "./jev/resilient-judge.ts";
import { TH, d4ChecklistMatchQuestions } from "./jev/questions.ts";
import { TripStore, tripSummary, planDesc, gateReport, destList, type Trip } from "./memory/trip-store.ts";
import { assembleDraft, checkChainCompleteness, isAoi, isPoi, isRoute, childrenOf, type DraftV2, type EventV2, type RouteEvent, type AoiEvent, type PoiEvent } from "./memory/event-v2.ts";
import { syncProjection } from "./memory/project-v1.ts";
import { enrichFromBaidu } from "./tools/baidu-place.ts";
import { fetchAoiBoundary, convexHull } from "./tools/osm-aoi.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import { searchPoi, drivingRoute, walkingRoute, bicyclingRoute, cityTransitRoute, geodesicM } from "./tools/amap.ts";
import { intercityRoute, type IntercityPrefer } from "./tools/baidu.ts";
import { resolveLlm } from "./settings.ts";

const SYSTEM = `你是 Riddle，一个旅行规划 Copilot（像一本会回应的日记本）。
用户可以随时倒入任何旅行素材与需求。你的工作方式：
- 用工具改变世界，用话语回应用户。所有状态变更必须通过工具，不要只在文字里"声称"改了什么。
- 用户陈述任何旅行约束（目的地/日期/天数/出发地/同行人/节奏/兴趣/住宿偏好）时，先调 update_slot 逐条记录（系统会复核，文本明确支持才会生效），然后再回应。
- 用户汇报准备事项完成时，调 confirm_progress 勾选清单项：items 传 item_id（get_trip_state 可查清单），Jev 会逐项与用户原话复核，只勾被明确提及的项；用户确认方案整体时传 lock_events: true 锁定全部 Event。
- 你能推断的时间/安排就推断，推断不了的如实留空请用户补充，绝不编造精确事实（班次/票价/营业时间）。
- 跨城火车/飞机/大巴有真实数据源：用 get_route 的 transit 模式查询（返回真实车次/航班号、时刻、票价，为查询当日班次，会随出发日期变化——方案中应表述为"代表性班次"，出行前需复核）。
- 判断由系统中的 Jev 引擎做出：你每次说话前会看到它对你上一输入的意图概率分析和当前阶段，请尊重这些判断。
- 方案结构（v2 事件树）：事件分三类——poi（点：游览/住宿/场站）、route（线：通勤段，用 detail.from/to 引用两端事件的 tmp_id）、aoi（面：景区，可用 parent_id 嵌套子事件）。同一天内相邻两个活动之间必须有一个 route 事件连接，漏了会被结构校验（V8）直接打回。每天以住宿或场站收尾。
- 生成方案前先确认天数与目的地已记录（get_trip_state 可查），然后调 apply_plan 提交完整方案（扁平事件列表，tmp_id + parent_id + seq 表达嵌套）。
- 如果系统告诉你有待确认问题（pending），先处理它。`;

/** 由设置中心解析当前 LLM（provider 预设 + 用户覆盖 + 环境变量兜底）。
 * server 保存设置后用 buildModel() 热替换各运行时的 agent.state.model。 */
export function buildModel(): Model<any> {
  const c = resolveLlm();
  return {
    id: c.model,
    name: c.label,
    api: c.api,
    provider: c.apiProvider,
    baseUrl: c.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: c.maxTokens ?? 8192, // 渠道级输出上限（Friday 32k：强约束后草案体积大，8k 会截断 apply_plan 参数）
    // Bearer 渠道（预设 bearer=true，如 Friday/美团 AIGC 网关拒绝 x-api-key）：用解析后的 apiKey 注入
    // Authorization 头——设置文件、UI 手填、环境变量三级解析都生效；env ANTHROPIC_AUTH_TOKEN 兜底兼容旧配置。
    // pi-ai 的 defaultHeaders 合并链包含 model.headers，与 x-api-key 并存不冲突
    ...(() => {
      if (c.api !== "anthropic-messages") return {};
      const token = (c.bearer && c.apiKey) || process.env.ANTHROPIC_AUTH_TOKEN;
      return token ? { headers: { Authorization: `Bearer ${token}` } } : {};
    })(),
  } as Model<any>;
}

/** streamSimple 包装：把设置里的 temperature 注入每次流式调用（未设置则交给 provider 默认）。
 * maxRetries=8：429/5xx 由 pi-ai 按 provider 策略退避重试（指数 0.5→8s/次，累计 ~40s，跨过 Friday 的分钟级限流窗；比整轮 stop=error 好） */
const streamWithSettings: any = (model: any, context: any, options: any) => {
  const t = resolveLlm().temperature;
  return (streamSimple as any)(model, context, { maxRetries: 8, maxRetryDelayMs: 65_000, ...(options ?? {}), ...(t != null ? { temperature: t } : {}) });
};

/** UI/Server 可订阅的运行时事件（Jev 判断、pending 队列、地理解析、阶段门） */
export interface RiddleEvent {
  type: "jev" | "pending" | "geo" | "gate" | "aoi" | "state_dirty";
  sub?: string;            // jev: 意图/槽位复核/半径判定/校验/挂起消费
  [k: string]: unknown;
}

export interface RiddleRuntime {
  agent: Agent;
  store: TripStore;
  jev: JevClient;
  scheduler: Scheduler;
  onEvent: (fn: (ev: RiddleEvent) => void) => void;
  emit: (ev: RiddleEvent) => void;
}

function textOf(msg: any): string {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  return (msg.content ?? []).map((c: any) => c.text ?? "").join(" ");
}

export function createRiddleAgent(existingStore?: TripStore): RiddleRuntime {
  const store = existingStore ?? new TripStore();
  const jev = new ResilientJudge();
  const scheduler = new Scheduler(join(store.dir, "pending.json"));

  const listeners: ((ev: RiddleEvent) => void)[] = [];
  const emit = (ev: RiddleEvent) => { for (const fn of listeners) { try { fn(ev); } catch { /* listener 异常不阻断 loop */ } } };
  const onEvent = (fn: (ev: RiddleEvent) => void) => { listeners.push(fn); };
  // 判断引擎切换（Jev ↔ LLM 退级）对 UI 可见
  jev.onEngine = (engine, reason) => emit({ type: "jev", sub: "引擎", engine, note: reason });

  const summary = () => tripSummary(store.trip);

  // ---------------- 工具系统 ----------------
  const getTripState: AgentTool = {
    name: "get_trip_state",
    label: "查看旅行状态",
    description: "获取当前 Trip 的完整状态摘要（阶段/槽位/事件/清单）。生成或修改方案前先调用。",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: JSON.stringify(summary(), null, 2) }], details: {} }),
  };

  const planDescTool: AgentTool = {
    name: "get_plan_desc",
    label: "查看方案全文",
    description: "获取当前方案的逐日自然语言描述。",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: planDesc(store.trip) }], details: {} }),
  };

  const searchPoiTool: AgentTool = {
    name: "search_poi",
    label: "搜索 POI",
    description: "用高德搜索点位，返回坐标/类别/城市。落图前确认点位真实存在。",
    parameters: Type.Object({ name: Type.String(), city: Type.Optional(Type.String()) }),
    execute: async (_id: string, params: any) => {
      const r = await searchPoi(params.name, params.city);
      return { content: [{ type: "text", text: JSON.stringify(r ?? { found: false, name }) }], details: {} };
    },
  };

  const routeTool: AgentTool = {
    name: "get_route",
    label: "查询路线",
    description: "查询两点间路线。walk=步行 / bike=骑行 / drive=驾车（均高德真实路径+耗时）；transit=跨城火车/飞机/大巴（百度，返回真实车次/航班号+时刻+票价，为查询当日班次，随日期变化，应按代表性班次使用）；geodesic=测地线距离。",
    parameters: Type.Object({
      from_name: Type.String(), to_name: Type.String(),
      mode: Type.Union([Type.Literal("walk"), Type.Literal("bike"), Type.Literal("drive"), Type.Literal("transit"), Type.Literal("geodesic")]),
      prefer: Type.Optional(Type.Union([Type.Literal("train"), Type.Literal("flight"), Type.Literal("coach")])),
    }),
    execute: async (_id: string, params: any) => {
      const { from_name, to_name, mode } = params;
      const [a, b] = await Promise.all([searchPoi(from_name), searchPoi(to_name)]);
      if (!a?.geo || !b?.geo) return { content: [{ type: "text", text: JSON.stringify({ error: "POI 未找到", from: !!a?.geo, to: !!b?.geo }) }], details: {} };
      if (mode === "walk" || mode === "bike" || mode === "drive") {
        const fn = mode === "walk" ? walkingRoute : mode === "bike" ? bicyclingRoute : drivingRoute;
        const r = await fn(a.geo, b.geo);
        return { content: [{ type: "text", text: JSON.stringify(r ?? { error: `无${mode}路线` }) }], details: {} };
      }
      if (mode === "transit") {
        const r = await intercityRoute(a.geo, b.geo, (params.prefer ?? "train") as IntercityPrefer);
        return { content: [{ type: "text", text: JSON.stringify(r ?? { error: "无跨城公共交通方案" }) }], details: {} };
      }
      return { content: [{ type: "text", text: JSON.stringify({ distance_m: geodesicM(a.geo, b.geo), source: "geodesic" }) }], details: {} };
    },
  };

  const updateSlot: AgentTool = {
    name: "update_slot",
    label: "更新槽位",
    description: "更新旅行约束槽位（destination/date_range/days/origin/party/pace/interests/stay_pref）。Jev 会复核后生效。",
    parameters: Type.Object({
      slot: Type.String(),
      value: Type.Unknown(),
      evidence: Type.String({ description: "用户原话中支持该取值的片段" }),
    }),
    execute: async (_id: string, params: any) => {
      const { slot } = params;
      let { value } = params;
      // LLM 有时把数组/对象序列化成 JSON 字符串传进来，归一化还原
      if (typeof value === "string") { const t = value.trim(); if (/^[\[{]/.test(t)) { try { value = JSON.parse(t); } catch { /* 保留原串 */ } } }
      // destination 归一化为数组：LLM 常传裸字符串（"天津"）或分隔串（"天津、北京"），不落数组会导致读取侧 .join 崩溃
      if (slot === "destination" && typeof value === "string") {
        value = value.split(/[、，,;/]/).map((s: string) => s.trim()).filter(Boolean);
      }
      const old = JSON.parse(JSON.stringify(store.trip.slots));
      if (slot === "destination" && Array.isArray(value)) store.trip.destination = value as string[];
      if (slot === "days") store.trip.days = Number(value) || store.trip.days;
      store.trip.slots[slot] = value;
      store.log("slot_update", { slot, value }, { kind: "restore_slots", slots: old });
      return { content: [{ type: "text", text: `槽位 ${slot} 已更新为 ${JSON.stringify(value)}` }], details: {} };
    },
  };

  const applyPlan: AgentTool = {
    name: "apply_plan",
    label: "生成/重写方案",
    description: `提交完整方案草案落图（v2 扁平事件列表，SPEC/event-model-v2.md §6）。
事件分三类：poi（点：游览/住宿/场站，detail.role 标 lodging/terminal，默认 activity）、route（线：通勤段，detail.from/to 填两端事件的 tmp_id，detail.mode 写真实通勤方式——同城步行/骑行/公交/地铁/驾车，跨城火车/飞机/大巴）、aoi（面：景区，子事件用 parent_id 指它，AOI 不套 AOI，深度 ≤3）。
硬性要求（V8 结构校验，违反直接打回重提）：同一天内相邻两个顶层活动事件（poi/aoi）之间必须有一个 route 事件连接，不允许只罗列活动而省略通勤环节。
时间用 "HH:MM"（day_refs 标第几天，可跨日）；推断不了的留 null，绝不编造班次/票价/营业时间（系统会调真实 API 回填）。events 数组较大，工具参数请输出紧凑 JSON（无缩进无换行），note 控制在 20 字以内。
示例：{"days":3,"events":[{"tmp_id":"e1","kind":"poi","name":"成都东站","day_refs":[1],"detail":{"role":"terminal"},"time_window":{"start":"07:30"}},{"tmp_id":"e2","kind":"route","name":"成都→九寨沟","day_refs":[1],"detail":{"mode":"大巴","from":"e1","to":"e3"}},{"tmp_id":"e3","kind":"aoi","name":"九寨沟","day_refs":[1,2,3]},{"tmp_id":"e4","kind":"poi","name":"则查洼沟","parent_id":"e3","seq":1,"day_refs":[2]}],"checklist":[...]}`,
    parameters: Type.Object({
      days: Type.Number(),
      events: Type.Array(Type.Object({
        tmp_id: Type.String(),
        kind: Type.Union([Type.Literal("poi"), Type.Literal("route"), Type.Literal("aoi")]),
        name: Type.String(),
        parent_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        seq: Type.Optional(Type.Number()),
        day_refs: Type.Array(Type.Number()),
        time_window: Type.Optional(Type.Union([Type.Object({
          start: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          end: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        }), Type.Null()])),
        cost: Type.Optional(Type.Union([Type.Object({ amount: Type.Number(), currency: Type.Optional(Type.String()) }), Type.Null()])),
        note: Type.Optional(Type.String()),
        detail: Type.Optional(Type.Record(Type.String(), Type.Any())),
      })),
      checklist: Type.Array(Type.Object({
        title: Type.String(),
        category: Type.Union([Type.Literal("booking"), Type.Literal("item"), Type.Literal("info")]),
        info_spec: Type.Optional(Type.Union([Type.Object({ what: Type.String(), expect: Type.String(), impact: Type.String() }), Type.Null()])),
      })),
    }),
    execute: async (_id, draft) => {
      // 结构校验（组装 + V8 链条完整）在落图前：失败直接打回，不产生任何状态变更
      const pre = await applyDraftV2(store, draft as DraftV2, emit, /*dryRun*/ true);
      if (!pre.ok) {
        return { content: [{ type: "text", text: `草案结构校验未通过，未落图。你必须在本轮内按下列修复指引修正后，重新调用 apply_plan 提交完整草案（不要只回复文字，也不要放弃提交）：\n${pre.errors.map(e => `- [${e.code}] ${e.message}`).join("\n")}` }], details: { errors: pre.errors } };
      }
      store.snapshot("apply_plan");
      const applied = await applyDraftV2(store, draft as DraftV2, emit);
      if (!applied.ok) { // 与 dryRun 之间无并发变更，理论不可达；防御
        store.undo();
        return { content: [{ type: "text", text: `草案结构校验未通过：${applied.errors.map(e => e.message).join("；")}` }], details: {} };
      }
      store.save(); // 落图后立即落盘：校验或系统异常崩溃不丢方案（校验失败路径 undo 会再纠正）
      const verify = await jev.d7Verify(planDesc(store.trip));
      const fails = Object.keys(verify).filter(k => !k.endsWith("_prob") && verify[k] === "fail");
      const probs: Record<string, number> = {};
      for (const k of Object.keys(verify)) if (k.endsWith("_prob")) probs[k.replace(/_prob$/, "")] = verify[k];
      emit({ type: "jev", sub: "校验", fails, probs, pass: !fails.length });
      store.trip.stage = gateReport(store.trip).stage;
      store.save();
      if (fails.length) {
        store.undo();
        return { content: [{ type: "text", text: `校验未通过（${fails.join(", ")}），请修复后重新提交。概率：${fails.map(f => `${f}=${verify[f + "_prob"].toFixed(2)}`).join(", ")}` }], details: { verify } };
      }
      // 落图校验通过：整树 draft → active（SPEC §3.1 status 语义），投影同步为 locked
      for (const ev of Object.values(store.trip.events_v2 ?? {})) if (ev.status === "draft") ev.status = "active";
      syncProjection(store.trip);
      store.save();
      const { warnings, gaps, aoiAsync } = applied;
      const warnNote = warnings.length ? `。提示：${warnings.join("；")}` : "";
      const gapNote = gaps.length
        ? `。注意：${gaps.length} 条通勤段未获得真实路径——${gaps.map(g => `${g.from}→${g.to}（${g.mode}：${g.reason}）`).join("，")}。可用 search_poi 核实点位名后重新 apply_plan 修复，或在回复中向用户说明`
        : "";
      const aoiNote = aoiAsync ? `。${aoiAsync} 个景区的边界正在后台获取（OSM），成功后会自动热替换包络` : "";
      return { content: [{ type: "text", text: `方案已落图并通过校验：${Object.keys(store.trip.events_v2 ?? {}).length} 个事件（含嵌套），${Object.keys(store.trip.checklist).length} 项清单。当前阶段 ${store.trip.stage}${aoiNote}${gapNote}${warnNote}` }], details: { verify, route_gaps: gaps, warnings } };
    },
  };

  const confirmProgress: AgentTool = {
    name: "confirm_progress",
    label: "确认完成",
    description: "用户汇报准备事项完成或确认方案时调用。items 传用户明确说已完成的清单项 item_id（从 get_trip_state 的 checklist 获取；Jev 会逐项与用户原话复核，未明确提及的项不会生效并转入待确认）；lock_events=true 用于用户确认方案整体、锁定全部 Event。",
    parameters: Type.Object({
      items: Type.Optional(Type.Array(Type.String(), { description: "已完成清单项的 item_id 列表（实体级勾选）" })),
      lock_events: Type.Optional(Type.Boolean({ description: "用户确认方案整体时锁定全部 tentative Event" })),
    }),
    execute: async (id: string, params: any) => {
      const requested: string[] = (Array.isArray(params.items) ? params.items : []).filter((s: any) => typeof s === "string");
      // 门禁只放过 D4 复核通过的项；无门禁记录 = 未被过滤（令牌放行或纯锁定调用）
      const approved = approvedChecklist.get(id) ?? requested;
      approvedChecklist.delete(id);
      const lock = !!params.lock_events;
      if (!requested.length && !lock) {
        return { content: [{ type: "text", text: "未指定任何清单项或锁定操作，未做变更。勾选清单请传 items（item_id 列表，可从 get_trip_state 获取）；确认方案整体请传 lock_events: true。" }], details: {} };
      }
      store.snapshot("confirm_progress");
      let locked = 0;
      const done: string[] = [], skipped: string[] = [];
      // 锁定走 v2 事实源：draft → active，投影同步为 v1 的 locked（SPEC §3.1 status 语义）
      if (lock) {
        for (const e of Object.values(store.trip.events_v2 ?? {})) if (e.status === "draft") { e.status = "active"; locked++; }
        syncProjection(store.trip);
      }
      for (const itemId of requested) {
        const c = store.trip.checklist[itemId];
        if (!c || c.done) continue;
        if (approved.includes(itemId)) { c.done = true; done.push(c.title); } else skipped.push(c.title);
      }
      store.trip.stage = gateReport(store.trip).stage;
      store.save();
      const parts: string[] = [];
      if (locked) parts.push(`锁定 ${locked} 个 Event`);
      if (done.length) parts.push(`勾选 ${done.length} 项清单：${done.join("、")}`);
      if (skipped.length) parts.push(`${skipped.length} 项未能从用户原话中确认（已跳过并转入待确认队列）：${skipped.join("、")}`);
      if (!done.length && !skipped.length && requested.length) parts.push("指定的清单项不存在或已完成");
      return { content: [{ type: "text", text: `${parts.join("；") || "无变更"}。当前阶段 ${store.trip.stage}` }], details: {} };
    },
  };

  const rollback: AgentTool = {
    name: "rollback",
    label: "回滚",
    description: "撤销最近一次状态变更操作。",
    parameters: Type.Object({}),
    execute: async () => {
      const rec = store.undo();
      return { content: [{ type: "text", text: rec ? `已回滚 #${rec.seq}（${rec.op}）` : "无可回滚操作" }], details: {} };
    },
  };

  const ingestMaterial: AgentTool = {
    name: "ingest_material",
    label: "素材入池",
    description: "用户粘贴攻略/订单等素材时调用：把解析出的候选点位和关键事实存入候选池，供后续排方案引用。",
    parameters: Type.Object({
      pois: Type.Array(Type.Object({ name: Type.String(), hint: Type.Optional(Type.String()) })),
      facts: Type.Array(Type.Object({ about: Type.String(), fact: Type.String() })),
    }),
    execute: async (_id: string, params: any) => {
      const old = JSON.stringify(Object.keys(store.trip.candidate_pool));
      for (const p of params.pois ?? []) {
        const id = `cand_${Math.random().toString(16).slice(2, 10)}`;
        store.trip.candidate_pool[id] = { item_id: id, name: p.name, source_material: p.hint ?? "", status: "pooled" };
      }
      const facts = (params.facts ?? []).map((f: any) => `${f.about}: ${f.fact}`);
      store.log("material_ingest", { pois: params.pois, facts }, { kind: "restore_pool", keys: old });
      return { content: [{ type: "text", text: `已入池 ${(params.pois ?? []).length} 个候选点位、${facts.length} 条事实。` }], details: {} };
    },
  };

  const tools = [getTripState, planDescTool, searchPoiTool, routeTool, updateSlot, ingestMaterial, applyPlan, confirmProgress, rollback];

  // ---------------- Jev 注入点 1：beforeToolCall 门禁 ----------------
  const STATE_CHANGING = new Set(["update_slot", "apply_plan", "confirm_progress", "rollback"]);
  // 规范化比较：标量/数组统一包成数组再比（"九寨沟" 与 ["九寨沟"] 语义相同，不算覆盖）
  const canon = (v: any): string => JSON.stringify((Array.isArray(v) ? v : [v]).map((i: any) => (typeof i === "string" ? i.trim() : i)));
  // 一次性放行令牌：pending 被用户确认后颁发，恢复执行时门禁不再重复拦截同一操作
  const approvals = new Set<string>();
  // D4 复核通过的清单项（key: toolCall id）——execute 只勾这些，其余跳过
  const approvedChecklist = new Map<string, string[]>();

  async function beforeToolCall(ctx: any) {
    const name: string = ctx.toolCall?.name;
    if (!STATE_CHANGING.has(name)) return undefined;
    // 槽位证据可能散布在任意历史轮次（用户先说需求、后说"帮我排"），拼接全部 user 消息
    const messages = ctx.context?.messages ?? [];
    const userText = messages
      .filter((m: any) => m.role === "user")
      .map((m: any) => textOf(m))
      .join("\n");
    if (name === "update_slot") {
      const args = ctx.args ?? {};
      // 与 execute 同一归一化：JSON 字符串化的数组/对象还原后再比对
      if (typeof args.value === "string") { const t = args.value.trim(); if (/^[\[{]/.test(t)) { try { args.value = JSON.parse(t); } catch { /* 保留原串 */ } } }
      const p = await jev.ask({ user_input: userText }, {
        slot_verify: { type: "noul", instructions: `\`user_input\` 是用户全部发言按时间顺序的拼接，越靠后越代表当前意图；早期发言与最新发言矛盾的，以最新为准。判断用户是否明确表达了 ${args.slot} 的取值就是 ${JSON.stringify(args.value)}？只有文本明确支持才判真。` },
      });
      const prob = p.slot_verify.noul;
      emit({ type: "jev", sub: "槽位复核", prob, pass: prob >= TH.slotAccept, slot: args.slot, value: args.value });
      if (prob < TH.slotAccept) {
        return { block: true, reason: `Jev 复核未通过（${prob.toFixed(2)} < ${TH.slotAccept}）：用户没有明确表达这个取值。请向用户澄清而不是臆测，不要重复提交相同取值。` };
      }
      // T3：核心槽覆盖需显式确认（修复泛化测试缺陷③）
      const CORE_SLOTS = new Set(["destination", "date_range", "days"]);
      const cur = (store.trip.slots as any)[args.slot];
      const hasValue = cur !== null && cur !== undefined && cur !== "" && !(Array.isArray(cur) && cur.length === 0);
      const token = `slot:${args.slot}:${canon(args.value)}`;
      if (approvals.has(token)) {
        approvals.delete(token); // 用户已确认过这次覆盖，一次性放行
      } else if (CORE_SLOTS.has(args.slot) && hasValue && canon(cur) !== canon(args.value)) {
        const q = scheduler.enqueue({
          question: `确认把 ${args.slot} 从 ${JSON.stringify(cur)} 改为 ${JSON.stringify(args.value)} 吗？`,
          kind: "slot_override",
          context: { slot: args.slot, value: args.value },
        });
        emit({ type: "pending", action: "enqueue", kind: q.kind, question: q.question });
        return { block: true, reason: `该槽位已有值 ${JSON.stringify(cur)}，覆盖需用户显式确认。已向用户发出确认问题（pending）。请勿重试本工具——直接结束本轮，向用户复述这个确认问题，等用户回答后再恢复执行。` };
      }
    }
    if (name === "apply_plan" && Object.keys(store.trip.events).length > 0 && !approvals.delete("d6:apply_plan")) {
      // 已有方案时的 apply_plan = 变更（I4），先过 D6 半径判定（有放行令牌则跳过）
      const lastUser = messages.filter((m: any) => m.role === "user").map((m: any) => textOf(m)).pop() ?? "";
      const d6 = await jev.d6Radius(lastUser, summary());
      emit({ type: "jev", sub: "半径判定", radius: d6.radius, confidence: d6.confidence, autoApply: d6.autoApply });
      if (!d6.autoApply) {
        const q = scheduler.enqueue({
          question: `这次变更可能影响 ${d6.radius} 范围，确认按此调整吗？`,
          kind: "d6_radius",
          context: { op: lastUser, radius: d6.radius, confidence: d6.confidence },
        });
        emit({ type: "pending", action: "enqueue", kind: q.kind, question: q.question });
        return { block: true, reason: `D6 传播半径判定为 ${d6.radius}，置信度 ${d6.confidence.toFixed(2)} 低于自动执行阈值。已转入人工确认（pending）。请勿重试本工具——直接结束本轮，向用户复述这个确认问题，等用户确认后再恢复执行。` };
      }
    }
    if (name === "confirm_progress") {
      const args = ctx.args ?? {};
      // D4 指代/实体匹配入 beforeToolCall（ARCH-pi §2）：LLM 提的每个清单项都要与用户原话对得上
      const open = new Map(Object.values(store.trip.checklist).filter(c => !c.done).map(c => [c.item_id, c]));
      const requested: string[] = (Array.isArray(args.items) ? args.items : []).filter((id: any) => typeof id === "string" && open.has(id));
      const needCheck = requested.filter(id => !approvals.delete(`chk:${id}`));   // 有令牌（用户已在 pending 中确认）免复核
      const preApproved = requested.filter(id => !needCheck.includes(id));
      if (needCheck.length) {
        const lastUser = messages.filter((m: any) => m.role === "user").map((m: any) => textOf(m)).pop() ?? "";
        const items = needCheck.map(id => ({ id, title: open.get(id)!.title, category: open.get(id)!.category }));
        const answers = await jev.ask(
          { user_input: lastUser, open_checklist: [...open.values()].map(c => c.title) },
          d4ChecklistMatchQuestions(items),
        );
        const passed: string[] = [], blocked: string[] = [];
        for (const it of items) {
          const prob = answers[`chk_${it.id}`]?.noul ?? 0;
          const pass = prob >= TH.checklistMatch;
          emit({ type: "jev", sub: "清单勾选", item: it.title, prob, pass });
          (pass ? passed : blocked).push(it.id);
        }
        if (blocked.length) {
          const titles = blocked.map(id => open.get(id)!.title);
          const q = scheduler.enqueue({
            question: `这些准备事项也完成了吗：${titles.join("、")}？`,
            kind: "checklist_confirm",
            context: { item_ids: blocked },
          });
          emit({ type: "pending", action: "enqueue", kind: q.kind, question: q.question });
        }
        const approvedHere = preApproved.concat(passed);
        if (!approvedHere.length && !args.lock_events) {
          return { block: true, reason: `Jev 逐项复核：没有清单项能从用户原话中明确确认完成（阈值 ${TH.checklistMatch}）。已向用户发出确认问题（pending）。请勿重试本工具——向用户复述这个确认问题，等用户回答后再恢复执行。` };
        }
        approvedChecklist.set(String(ctx.toolCall?.id ?? ""), approvedHere);
      }
    }
    return undefined;
  }

  // ---------------- Jev 注入点 2：transformContext 感知 ----------------
  // D1 意图 + 挂起消费按用户输入缓存：同一条 user 消息的工具迭代期间不重判
  // （否则一轮 N 次模型调用 = N 次雷同判断刷屏 + N 倍 Jev API 开销）
  let senseCache: { userText: string; injection: string } | null = null;
  async function transformContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
    const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
    const userText = textOf(lastUser);
    let injection = "";
    if (userText) {
      if (senseCache?.userText === userText) {
        injection += senseCache.injection;
      } else {
        let sensed = "";
        try {
          const d1 = await jev.d1Intents(userText, summary());
          sensed += `[Jev 意图分析] ${JSON.stringify(d1.raw)}（命中：${Object.keys(d1.intents).join(",") || "无"}）\n`;
          emit({ type: "jev", sub: "意图", probs: d1.raw, hits: Object.keys(d1.intents) });
          // pending 消费判定（调度系统）：回应 ≠ 同意，两个概率分开判。
          // 用户一句话可能同时回应多个待决问题（「确认，两个都改」）→ 循环消费直到队首未被回应
          let pending = scheduler.peek();
          while (pending) {
            const { answered, approved } = await jev.consumesPending(userText, pending.question);
            emit({ type: "jev", sub: "挂起消费", prob: answered, approved, consumed: answered >= 0.6, question: pending.question });
            if (answered < 0.6) {
              sensed += `[调度] 待决问题「${pending.question}」尚未被回应（回应概率 ${answered.toFixed(2)}），请提醒用户先确认，不要推进其他状态变更。\n`;
              break;
            }
            scheduler.dequeue();
            emit({ type: "pending", action: "consume", kind: pending.kind, question: pending.question });
            const needsApproval = pending.kind === "slot_override" || pending.kind === "d6_radius" || pending.kind === "checklist_confirm";
            if (needsApproval && approved < 0.6) {
              if (pending.kind === "checklist_confirm") {
                // 部分确认（「A、B 完成了，C、D 还没」）：不整体放弃——D4 按用户原话重判，明确提及的照常可勾
                sensed += `[调度] 用户回应了清单确认问题「${pending.question}」，但未全部同意（同意概率 ${approved.toFixed(2)}）。请根据用户原话调用 confirm_progress，只勾其明确表示已完成的清单项（Jev 会逐项复核，未明确提及的不会生效）。\n`;
              } else {
                // 用户回应了但不同意（如「先不了，维持现状」）→ 放弃挂起操作，禁止恢复
                sensed += `[调度] 用户回应了待决问题「${pending.question}」，但未表示同意（同意概率 ${approved.toFixed(2)}）。视为放弃该挂起操作：不要恢复执行、维持现状，可与用户确认后续意图。\n`;
              }
            } else {
              // 颁发一次性放行令牌：恢复执行时 beforeToolCall 不再重复拦截同一操作
              if (pending.kind === "slot_override") approvals.add(`slot:${(pending.context as any).slot}:${canon((pending.context as any).value)}`);
              if (pending.kind === "d6_radius") approvals.add("d6:apply_plan");
              if (pending.kind === "checklist_confirm") for (const cid of (pending.context as any).item_ids ?? []) approvals.add(`chk:${cid}`);
              sensed += `[调度] 待决问题「${pending.question}」已被用户确认（同意概率 ${approved.toFixed(2)}）。请恢复执行被挂起的操作，上下文：${JSON.stringify(pending.context)}。该操作已获放行授权，门禁不会再次拦截。\n`;
            }
            pending = scheduler.peek();
          }
        } catch (e) {
          sensed += `[Jev 暂不可用：${(e as Error).message}]\n`;
        }
        senseCache = { userText, injection: sensed };
        injection += sensed;
      }
    }
    injection += `[当前阶段] ${store.trip.stage}；[状态摘要] ${JSON.stringify(summary())}`;
    return [...messages, { role: "user", content: [{ type: "text", text: injection }], timestamp: Date.now() } as unknown as AgentMessage];
  }

  // ---------------- Jev 注入点 3：prepareNextTurn 调度 ----------------
  function prepareNextTurn() {
    const gate = gateReport(store.trip);
    if (gate.stage !== store.trip.stage) {
      store.trip.stage = gate.stage;
      emit({ type: "gate", stage: gate.stage });
    }
    return undefined;
  }

  const agent = new Agent({
    initialState: { systemPrompt: SYSTEM, tools, messages: [], model: buildModel() },
    streamFn: streamWithSettings,
    // anthropic-messages 且走 Bearer 网关时，用 AUTH_TOKEN 充当 apiKey 通过 pi 的非空检查（实际鉴权靠 model.headers 的 Authorization）
    getApiKey: () => resolveLlm().apiKey
      || (resolveLlm().api === "anthropic-messages" ? process.env.ANTHROPIC_AUTH_TOKEN : "")
      || undefined,
    beforeToolCall,
    transformContext,
    prepareNextTurn,
  });

  return { agent, store, jev, scheduler, onEvent, emit };
}

/** 草案落图 v2（SPEC/event-model-v2.md §6 服务端组装职责 + §7 边界 fallback 链）。
 * 管线：组装（结构校验）→ V8 链条完整（schema 层硬校验，漏 route 直接打回，不再工程兜底补边）
 *      → 地理解析（高德坐标）→ 百度 place detail 富化（opening/price/rating/scope_grade）
 *      → route 数据补全（高德市内 / 百度跨城班次）→ AOI 包络上线 + OSM 边界后台获取。
 * dryRun=true 时只做结构校验（apply_plan execute 的前置打回检查），不落地、不发起任何 IO。 */
type ApplyV2Result =
  | { ok: true; warnings: string[]; gaps: { from: string; to: string; mode: string; reason: string }[]; aoiAsync: number }
  | { ok: false; errors: { code: string; message: string }[] };

async function applyDraftV2(store: TripStore, draft: DraftV2, emit?: (ev: RiddleEvent) => void, dryRun = false): Promise<ApplyV2Result> {
  const asm = assembleDraft(draft);
  if (!asm.ok) return { ok: false, errors: asm.errors };
  const v8 = checkChainCompleteness(asm.events);
  if (v8.length) return { ok: false, errors: v8 };
  if (dryRun) return { ok: true, warnings: asm.warnings, gaps: [], aoiAsync: 0 };

  const trip = store.trip;
  const events = asm.events;
  const cityHint = destList(trip)[0];

  // 1. poi/aoi 地理解析 + 百度富化（SPEC §10：place detail 接入）
  const places = Object.values(events).filter(e => isPoi(e) || isAoi(e));
  let done = 0;
  for (const ev of places) {
    if (isPoi(ev)) {
      try {
        const r = await searchPoi(ev.name);
        if (r?.geo) {
          ev.detail.geo = { ...r.geo, source: "api" }; // 字段级 source 比事件级更强（SPEC §5）
          ev.detail.poi_ref = { ...ev.detail.poi_ref, amap_poi_id: r.amap_poi_id };
          if (!ev.detail.category_tags?.length) ev.detail.category_tags = r.category_tags ?? [];
          ev.detail.city = r.city ?? null;
        }
      } catch { /* 单点失败降级为无坐标，不阻断落图 */ }
    }
    // 百度富化：opening_detail / price / rating / scope_grade / classified_poi_tag（best-effort）
    try {
      const en = await enrichFromBaidu(ev.name, cityHint);
      if (en) {
        if (isPoi(ev)) {
          ev.detail.poi_ref = { ...ev.detail.poi_ref, baidu_uid: en.baidu_uid };
          if (en.detail?.opening_detail) ev.detail.opening_detail = en.detail.opening_detail;
          if (en.detail?.price) ev.detail.price = { ...en.detail.price, source: "api" };
          if (en.detail?.rating) ev.detail.rating = { ...en.detail.rating, source: "api" };
          if (en.detail?.scope_grade) ev.detail.scope_grade = en.detail.scope_grade;
          if (en.detail?.category_tags.length) ev.detail.category_tags = en.detail.category_tags;
        } else {
          if (en.detail?.opening_detail) ev.detail.opening_detail = en.detail.opening_detail;
          if (en.detail?.price) ev.detail.ticket = { ...en.detail.price, source: "api" };
        }
      }
    } catch { /* 富化失败留 null，共创补 */ }
    emit?.({ type: "geo", done: ++done, total: places.length });
  }

  // 2. route 数据补全（高德市内真实路径 / 百度跨城真实班次）
  const routes = Object.values(events).filter(isRoute);
  for (const r of routes) await resolveRouteDataV2(r, events);

  // 3. 通勤路径完备性收尾 + 缺口收集
  const gaps: { from: string; to: string; mode: string; reason: string }[] = [];
  const geoOf = (id: string) => {
    const e = events[id];
    if (!e) return null;
    if (isPoi(e)) return e.detail.geo;
    const kid = childrenOf(events, id).map(k => isPoi(k) ? k.detail.geo : null).find(Boolean);
    return kid ?? null; // aoi 端点取首个有坐标子事件
  };
  for (const r of routes) {
    const a = geoOf(r.detail.from_ref), b = geoOf(r.detail.to_ref);
    if (a && b && r.detail.geometry.length < 2) r.detail.geometry = [[a.lng, a.lat], [b.lng, b.lat]];
    if (r.detail.data_source === "empty") {
      const missing = !a ? events[r.detail.from_ref]?.name : events[r.detail.to_ref]?.name;
      gaps.push({ from: events[r.detail.from_ref]?.name ?? "?", to: events[r.detail.to_ref]?.name ?? "?", mode: r.detail.mode, reason: `端点「${missing}」坐标未解析` });
    } else if (r.detail.data_source === "geodesic" && !GEO.has(r.detail.mode)) {
      gaps.push({ from: events[r.detail.from_ref]?.name ?? "?", to: events[r.detail.to_ref]?.name ?? "?", mode: r.detail.mode, reason: "算路失败，降级为直线估算" });
    }
  }

  // 4. AOI 边界 fallback 链（SPEC §7）：先包络上线 → OSM 异步获取成功后热替换 → 都失败入清单共创
  const nid = (p: string) => `${p}_${Math.random().toString(16).slice(2, 10)}`;
  const checklist: Trip["checklist"] = {};
  let aoiAsync = 0;
  for (const aoi of Object.values(events).filter(isAoi)) {
    const kidGeos = childrenOf(events, aoi.event_id)
      .flatMap(k => isPoi(k) && k.detail.geo ? [[k.detail.geo.lng, k.detail.geo.lat] as [number, number]] : []);
    if (kidGeos.length >= 3) {
      aoi.detail.boundary = { polygon: convexHull(kidGeos), source: "envelope" };
      aoi.detail.envelope_fallback = true;   // UI 虚线面渲染
      aoi.detail.boundary_status = "done";
    }
    aoiAsync++;
    void (async () => {
      const b = await fetchAoiBoundary(aoi.name);
      const cur = store.trip.events_v2?.[aoi.event_id]; // 校验失败 undo 后旧对象作废，防御性检查
      if (!cur || !isAoi(cur) || cur.status === "dropped") return;
      if (b) {
        cur.detail.boundary = { polygon: b.polygon, source: "osm", osm_relation_id: b.osm_relation_id, attribution: b.attribution };
        cur.detail.envelope_fallback = false;
        cur.detail.boundary_status = "done";
        emit?.({ type: "aoi", sub: "boundary", name: aoi.name, source: "osm", points: b.polygon.length });
      } else if (!cur.detail.boundary) {
        // ① OSM 失败 且 ② 包络不可得 → ③ 清单共创（SPEC §7）
        cur.detail.boundary_status = "failed";
        const item = { item_id: nid("chk"), title: `确认「${aoi.name}」景区大致范围`, category: "info" as const, info_spec: { what: `${aoi.name} 的景区边界/大致范围`, expect: "用户确认大致范围后边界标记为 user_confirmed", impact: "地图无法渲染景区面，内部动线缺少空间参照" }, done: false, due_offset_days: null };
        store.trip.checklist[item.item_id] = item;
        emit?.({ type: "aoi", sub: "boundary_failed", name: aoi.name });
      } else {
        cur.detail.boundary_status = "done"; // 包络即终态（OSM 未拿到真边界）
        emit?.({ type: "aoi", sub: "boundary", name: aoi.name, source: "envelope" });
      }
      syncProjection(store.trip);
      store.save();
      emit?.({ type: "state_dirty" }); // SSE 推前端重绘（热替换）
    })();
  }

  // 5. 清单（同 v1 管线）
  for (const c of draft.checklist ?? []) {
    const item = { item_id: nid("chk"), title: c.title, category: c.category, info_spec: c.info_spec ?? null, done: false, due_offset_days: null };
    checklist[item.item_id] = item;
  }

  trip.events_v2 = events;
  trip.checklist = checklist;
  if (!trip.days) trip.days = draft.days || 0;
  syncProjection(trip); // v2 → v1 投影（UI/D7 继续消费，0.4.3 再切）
  return { ok: true, warnings: asm.warnings, gaps, aoiAsync };
}

/** 单条 route 事件的数据源解析（原地修改）。策略与 v1 resolveEdgeData 一致：
 * 市内通勤必须有真实路径与耗时（高德）；跨城走百度真实班次并回填 detail.schedule；
 * 未识别 mode 按直线距离推断；解析失败降级测地线距离。 */
async function resolveRouteDataV2(ev: RouteEvent, events: Record<string, EventV2>) {
  const geoOf = (id: string): { lat: number; lng: number } | null => {
    const e = events[id];
    if (!e) return null;
    if (isPoi(e)) return e.detail.geo ?? null;
    const kid = childrenOf(events, id).map(k => isPoi(k) ? k.detail.geo : null).find(Boolean);
    return kid ?? null;
  };
  const a = geoOf(ev.detail.from_ref), b = geoOf(ev.detail.to_ref);
  if (!a || !b) return;
  const d = ev.detail;
  const prefer = transitPrefer(d.mode);
  if (prefer) {
    try {
      const r = await intercityRoute(a, b, prefer);
      if (r) {
        d.distance_m = r.distance_m; d.duration_s = r.duration_s;
        d.data_source = "baidu_transit"; d.geometry = r.geometry;
        if (r.main) {
          const hm = (s?: string) => s ? String(s).slice(11, 16) : undefined; // "2026-09-23 07:00:00" → "07:00"
          d.schedule = {
            line: r.main.name ?? "?",
            depart: hm(r.main.depart_at), arrive: hm(r.main.arrive_at),
            price: r.main.price ?? r.price,
            disclaimer: "查询当日代表性班次，出行前需复核",
          };
          ev.cost = d.schedule.price != null ? { amount: d.schedule.price, currency: "CNY", source: "api" } : ev.cost;
          if (!ev.note) ev.note = `${events[d.from_ref]?.name ?? "?"}→${events[d.to_ref]?.name ?? "?"}（${r.main.type === "flight" ? "航班" : r.main.type === "train" ? "车次" : "线路"} ${d.schedule.line}，${d.schedule.depart ?? "时刻待核"} 发）`;
        }
      }
    } catch { /* 百度未配置或查询失败：留空待回填 */ }
    return;
  }
  if (GEO.has(d.mode)) { d.distance_m = Math.round(geodesicM(a, b)); d.data_source = "geodesic"; return; }
  let kind: "walk" | "bike" | "drive" | "transit" | null =
    WALK.has(d.mode) ? "walk" : BIKE.has(d.mode) ? "bike" : CITY.has(d.mode) ? "transit" : DRIVE.has(d.mode) ? "drive" : null;
  if (!kind) {
    kind = geodesicM(a, b) <= 1500 ? "walk" : "drive";
    d.mode = kind === "walk" ? "步行" : "驾车"; // 推断结果写回，展示与数据源一致
  }
  try {
    const fromEv = events[d.from_ref], toEv = events[d.to_ref];
    const cityHint = (fromEv && isPoi(fromEv) ? fromEv.detail.city : null)
      ?? (toEv && isPoi(toEv) ? toEv.detail.city : null) ?? "";
    const r = kind === "walk" ? await walkingRoute(a, b)
      : kind === "bike" ? await bicyclingRoute(a, b)
      : kind === "transit" ? await cityTransitRoute(a, b, cityHint)
      : await drivingRoute(a, b);
    if (r) {
      d.distance_m = r.distance_m ?? Math.round(geodesicM(a, b));
      d.duration_s = r.duration_s ?? null;
      d.data_source = `amap_${kind}` as RouteEvent["detail"]["data_source"];
      d.geometry = r.geometry ?? [];
      return;
    }
  } catch { /* 降级测地线 */ }
  d.distance_m = Math.round(geodesicM(a, b)); d.data_source = "geodesic";
}

/* ================= 边数据补全（applyDraft 与迁移脚本共用） =================
 * 策略：市内通勤（步行/骑行/驾车/公交地铁）必须有真实路径与耗时（高德）；
 * 跨城火车/飞机/大巴走百度真实班次，失败留空待回填（跨城大交通可推测，不强制真实）；
 * 未识别的 mode 按直线距离推断（≤1.5km 步行，否则驾车）；市内解析失败降级测地线距离。
 * （mode 是 LLM 写的自由文本，中英都收：walk/步行…） */
const DRIVE = new Set(["drive", "驾车", "自驾", "开车", "车程", "包车", "打车", "出租车", "网约车"]);
const WALK = new Set(["walk", "walking", "步行", "走路", "徒步", "散步", "citywalk"]);
const BIKE = new Set(["bike", "bicycle", "cycling", "骑行", "骑车", "自行车", "单车", "共享单车"]);
const CITY = new Set(["metro", "subway", "公交", "地铁", "巴士", "公车", "电车", "公共交通", "bus"]);
const GEO = new Set(["geodesic", "直线", "测地线"]);
const TRAIN = new Set(["train", "rail", "railway", "火车", "高铁", "动车", "城际"]);
const FLIGHT = new Set(["flight", "plane", "飞机", "航班"]);
const COACH = new Set(["coach", "大巴", "客运", "班车"]);
const transitPrefer = (mode: string): IntercityPrefer | null =>
  TRAIN.has(mode) ? "train" : FLIGHT.has(mode) ? "flight" : COACH.has(mode) ? "coach" : null;

/** 单条边的数据源解析（原地修改 e）。events 可选：传入时回填主班次信息到通勤事件。 */
export async function resolveEdgeData(e: any, nodes: Record<string, any>, events?: Record<string, any>) {
  const a = nodes[e.from_id]?.geo, b = nodes[e.to_id]?.geo;
  if (!a || !b) return;
  const prefer = transitPrefer(e.mode);
  if (prefer) {
    try {
      const r = await intercityRoute(a, b, prefer);
      if (r) {
        e.distance_m = r.distance_m; e.duration_s = r.duration_s;
        e.data_source = "baidu_transit"; e.geometry = r.geometry;
        e.coord_type = "gcj02"; // v0.3.3 起请求带 ret_coordtype=gcj02，标记免迁移
        // 主班次信息回填事件（车次号/时刻/票价）——方案质量的关键事实
        if (r.main && events) {
          const ev = Object.values(events).find((x: any) => x.anchor_kind === "edge" && x.anchor_ref === e.edge_id) as any;
          if (ev) {
            ev.note = `${nodes[e.from_id].name}→${nodes[e.to_id].name}（${r.main.type === "flight" ? "航班" : r.main.type === "train" ? "车次" : "线路"} ${r.main.name ?? "?"}，${r.main.depart_at ?? "时刻待核"} 发）`;
            ev.cost = r.main.price ?? r.price;
          }
        }
      }
    } catch { /* 百度未配置或查询失败：留空待回填 */ }
    return;
  }
  if (GEO.has(e.mode)) {
    e.distance_m = Math.round(geodesicM(a, b)); e.data_source = "geodesic"; return;
  }
  // 市内段：按 mode 选数据源；未识别 mode 按距离推断
  let kind: "walk" | "bike" | "drive" | "transit" | null =
    WALK.has(e.mode) ? "walk" : BIKE.has(e.mode) ? "bike" : CITY.has(e.mode) ? "transit" : DRIVE.has(e.mode) ? "drive" : null;
  if (!kind) {
    kind = geodesicM(a, b) <= 1500 ? "walk" : "drive";
    e.mode = kind === "walk" ? "步行" : "驾车"; // 推断结果写回，展示与数据源一致
  }
  try {
    const r = kind === "walk" ? await walkingRoute(a, b)
      : kind === "bike" ? await bicyclingRoute(a, b)
      : kind === "transit" ? await cityTransitRoute(a, b, nodes[e.from_id].city ?? nodes[e.to_id].city ?? "")
      : await drivingRoute(a, b);
    if (r) {
      e.distance_m = r.distance_m ?? Math.round(geodesicM(a, b));
      e.duration_s = r.duration_s ?? null;
      e.data_source = `amap_${kind}`;
      e.geometry = r.geometry ?? [];
      return;
    }
  } catch { /* 降级测地线 */ }
  e.distance_m = Math.round(geodesicM(a, b)); e.data_source = "geodesic";
}
