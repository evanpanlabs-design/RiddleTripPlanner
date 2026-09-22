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
import { TH, d4ChecklistMatchQuestions } from "./jev/questions.ts";
import { TripStore, tripSummary, planDesc, gateReport, type Trip } from "./memory/trip-store.ts";
import { Scheduler } from "./scheduler/scheduler.ts";
import { searchPoi, drivingRoute, geodesicM } from "./tools/amap.ts";
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
- 方案结构：每天由 Event 序列组成（visit/dine/transit/lodging），每天以住宿或场站收尾。
- 生成方案前先确认天数与目的地已记录（get_trip_state 可查），然后调 apply_plan 提交完整方案。
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
    maxTokens: 8192,
  };
}

/** streamSimple 包装：把设置里的 temperature 注入每次流式调用（未设置则交给 provider 默认） */
const streamWithSettings: any = (model: any, context: any, options: any) => {
  const t = resolveLlm().temperature;
  return (streamSimple as any)(model, context, { ...(options ?? {}), ...(t != null ? { temperature: t } : {}) });
};

/** UI/Server 可订阅的运行时事件（Jev 判断、pending 队列、地理解析、阶段门） */
export interface RiddleEvent {
  type: "jev" | "pending" | "geo" | "gate";
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
  const jev = new JevClient();
  const scheduler = new Scheduler(join(store.dir, "pending.json"));

  const listeners: ((ev: RiddleEvent) => void)[] = [];
  const emit = (ev: RiddleEvent) => { for (const fn of listeners) { try { fn(ev); } catch { /* listener 异常不阻断 loop */ } } };
  const onEvent = (fn: (ev: RiddleEvent) => void) => { listeners.push(fn); };

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
    description: "查询两点间路线。drive=驾车（高德）；transit=跨城火车/飞机/大巴（百度，返回真实车次/航班号+时刻+票价，为查询当日班次，随日期变化，应按代表性班次使用）；geodesic=测地线距离。",
    parameters: Type.Object({
      from_name: Type.String(), to_name: Type.String(),
      mode: Type.Union([Type.Literal("drive"), Type.Literal("transit"), Type.Literal("geodesic")]),
      prefer: Type.Optional(Type.Union([Type.Literal("train"), Type.Literal("flight"), Type.Literal("coach")])),
    }),
    execute: async (_id: string, params: any) => {
      const { from_name, to_name, mode } = params;
      const [a, b] = await Promise.all([searchPoi(from_name), searchPoi(to_name)]);
      if (!a?.geo || !b?.geo) return { content: [{ type: "text", text: JSON.stringify({ error: "POI 未找到", from: !!a?.geo, to: !!b?.geo }) }], details: {} };
      if (mode === "drive") {
        const r = await drivingRoute(a.geo, b.geo);
        return { content: [{ type: "text", text: JSON.stringify(r ?? { error: "无驾车路线" }) }], details: {} };
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
    description: "提交完整方案草案落图。会经过语义校验（V1-V7），不通过则返回失败原因需修复后重试。days 数组长度必须等于状态中的天数。",
    parameters: Type.Object({
      days: Type.Array(Type.Object({
        day: Type.Number(),
        items: Type.Array(Type.Object({
          type: Type.Union([Type.Literal("poi"), Type.Literal("transit"), Type.Literal("lodging"), Type.Literal("terminal")]),
          name: Type.String(),
          start: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          end: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          mode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
          from: Type.Optional(Type.String()), to: Type.Optional(Type.String()),
          note: Type.Optional(Type.String()),
        })),
      })),
      checklist: Type.Array(Type.Object({
        title: Type.String(),
        category: Type.Union([Type.Literal("booking"), Type.Literal("item"), Type.Literal("info")]),
        info_spec: Type.Optional(Type.Union([Type.Object({ what: Type.String(), expect: Type.String(), impact: Type.String() }), Type.Null()])),
      })),
    }),
    execute: async (_id, draft) => {
      store.snapshot("apply_plan");
      await applyDraft(store.trip, draft, emit);
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
      return { content: [{ type: "text", text: `方案已落图并通过校验：${Object.keys(store.trip.events).length} 个 Event，${Object.keys(store.trip.checklist).length} 项清单。当前阶段 ${store.trip.stage}` }], details: { verify } };
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
      if (lock) for (const e of Object.values(store.trip.events)) if (e.status === "tentative") { e.status = "locked"; locked++; }
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
    getApiKey: () => resolveLlm().apiKey || undefined,
    beforeToolCall,
    transformContext,
    prepareNextTurn,
  });

  return { agent, store, jev, scheduler, onEvent, emit };
}

/** 草案落图（事务式，移植自 orchestrator.py _apply_draft）。
 * 落图后做真实地理解析：节点经高德 searchPoi 补坐标，边按 mode 补距离/时长（失败降级留空）。 */
async function applyDraft(trip: Trip, draft: any, emit?: (ev: RiddleEvent) => void) {
  const nodes: Trip["nodes"] = {}, edges: Trip["edges"] = {}, events: Trip["events"] = {}, checklist: Trip["checklist"] = {};
  const name2node = new Map<string, any>();
  const nid = (p: string) => `${p}_${Math.random().toString(16).slice(2, 10)}`;
  const ensureNode = (name: string, anchor: "none" | "lodging" | "terminal" = "none") => {
    const existing = name2node.get(name);
    if (existing) { if (anchor !== "none") existing.anchor = anchor; return existing; }
    const n = { node_id: nid("node"), name, anchor, geo: null, amap_poi_id: null, category_tags: [], opening_hours: null };
    nodes[n.node_id] = n; name2node.set(name, n);
    return n;
  };
  for (const d of draft.days ?? []) {
    let prev: any = null;
    for (const it of d.items ?? []) {
      const tw = { start: it.start ?? null, end: it.end ?? null, source: it.start ? "inferred" : "blank" };
      if (it.type === "transit") {
        const fn = ensureNode(it.from || prev?.name || "未知");
        const tn = ensureNode(it.to || "未知");
        const e = { edge_id: nid("edge"), from_id: fn.node_id, to_id: tn.node_id, mode: it.mode || "drive", distance_m: null, duration_s: null, data_source: "empty", geometry: [] };
        edges[e.edge_id] = e;
        const ev = { event_id: nid("evt"), anchor_kind: "edge" as const, anchor_ref: e.edge_id, kind: "transit", day_refs: [d.day], time_window: tw, cost: null, status: "tentative" as const, note: `${fn.name}→${tn.name}（${e.mode}）` };
        events[ev.event_id] = ev;
      } else {
        const anchor = it.type === "lodging" ? "lodging" as const : it.type === "terminal" ? "terminal" as const : "none" as const;
        const n = ensureNode(it.name, anchor);
        const ev = { event_id: nid("evt"), anchor_kind: "node" as const, anchor_ref: n.node_id, kind: it.type === "lodging" ? "lodging" : it.type === "terminal" ? "transit" : "visit", day_refs: [d.day], time_window: tw, cost: null, status: "tentative" as const, note: it.note || "" };
        events[ev.event_id] = ev;
      }
      prev = it;
    }
  }
  for (const c of draft.checklist ?? []) {
    const item = { item_id: nid("chk"), title: c.title, category: c.category, info_spec: c.info_spec ?? null, done: false, due_offset_days: null };
    checklist[item.item_id] = item;
  }
  // 地理解析：节点坐标（真实地图渲染的前提）
  const nodeList = Object.values(nodes);
  let done = 0;
  for (const n of nodeList) {
    try {
      const r = await searchPoi(n.name);
      if (r?.geo) { n.geo = r.geo; n.amap_poi_id = r.amap_poi_id; n.category_tags = r.category_tags ?? []; }
    } catch { /* 单点失败降级为无坐标，不阻断落图 */ }
    emit?.({ type: "geo", done: ++done, total: nodeList.length });
  }
  // 边数据补全：驾车走高德真实路线，跨城火车/飞机/大巴走百度（真实班次），geodesic 测地线兜底
  // （mode 是 LLM 写的自由文本，中英都收：drive/驾车/自驾…）
  const DRIVE = new Set(["drive", "驾车", "自驾", "开车", "车程", "包车"]);
  const GEO = new Set(["geodesic", "直线", "测地线"]);
  const TRAIN = new Set(["train", "railway", "火车", "高铁", "动车", "城际"]);
  const FLIGHT = new Set(["flight", "plane", "飞机", "航班"]);
  const COACH = new Set(["coach", "bus", "大巴", "客运", "班车"]);
  const transitPrefer = (mode: string): IntercityPrefer | null =>
    TRAIN.has(mode) ? "train" : FLIGHT.has(mode) ? "flight" : COACH.has(mode) ? "coach" : null;
  for (const e of Object.values(edges)) {
    const a = nodes[e.from_id]?.geo, b = nodes[e.to_id]?.geo;
    if (!a || !b) continue;
    if (DRIVE.has(e.mode)) {
      try {
        const r = await drivingRoute(a, b);
        if (r) { e.distance_m = r.distance_m; e.duration_s = r.duration_s; e.data_source = "amap_driving"; e.geometry = r.geometry ?? []; continue; }
      } catch { /* 降级测地线 */ }
      e.distance_m = Math.round(geodesicM(a, b)); e.data_source = "geodesic";
    } else if (GEO.has(e.mode)) {
      e.distance_m = Math.round(geodesicM(a, b)); e.data_source = "geodesic";
    } else {
      const prefer = transitPrefer(e.mode);
      if (prefer) {
        try {
          const r = await intercityRoute(a, b, prefer);
          if (r) {
            e.distance_m = r.distance_m; e.duration_s = r.duration_s;
            e.data_source = "baidu_transit"; e.geometry = r.geometry;
            // 主班次信息回填事件（车次号/时刻/票价）——方案质量的关键事实
            if (r.main) {
              const ev = Object.values(events).find(x => x.anchor_kind === "edge" && x.anchor_ref === e.edge_id);
              if (ev) {
                ev.note = `${nodes[e.from_id].name}→${nodes[e.to_id].name}（${r.main.type === "flight" ? "航班" : r.main.type === "train" ? "车次" : "线路"} ${r.main.name ?? "?"}，${r.main.depart_at ?? "时刻待核"} 发）`;
                ev.cost = r.main.price ?? r.price;
              }
            }
            continue;
          }
        } catch { /* 百度未配置或查询失败：留空待回填 */ }
      }
    }
  }
  trip.nodes = nodes; trip.edges = edges; trip.events = events; trip.checklist = checklist;
  if (!trip.days) trip.days = (draft.days ?? []).length;
}
