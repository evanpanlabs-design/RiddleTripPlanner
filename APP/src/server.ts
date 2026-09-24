/** Riddle Demo Server（多项目版）：UI 静态服务 + 项目清单 + agent 事件流（SSE）+ 状态 API。
 * 无框架 node:http；启动：npm run serve（默认 :8787）。
 *
 * 项目 = 一份独立 runtime（trip store / 对话 / 事件缓冲 / busy 锁）。
 * 注册表持久化在 runs/projects.json；trip 图状态由 TripStore 自持久化在 runs/<trip_id>/。
 *
 * 路由：
 *   GET  /                     → UI/app.html
 *   GET  /api/projects         → 项目清单（含置顶/归档/排序）
 *   POST /api/projects         → 新建项目 → { meta }
 *   POST /api/projects/:id/meta     { pinned?, archived? } → 更新元数据
 *   POST /api/projects/reorder      { ids: [...] } → 按数组顺序写入 order
 *   GET  /api/state?project=   → { trip, pending, ops, conv }
 *   POST /api/input?project=   → { text } → 跑一轮 agent.prompt
 *   POST /api/turn/retry?project=     → 0.4.4 网关故障重试卡：带 lastFailedTurn 原输入重跑
 *   PATCH  /api/events/:id?project=        → 0.5 手动微调（时间/备注/交通方式）→ edit_event
 *   POST   /api/events/reorder?project=    { day, ordered_ids } → 拖拽重排（只动 seq，route 标 stale）
 *   POST   /api/events/insert-on-route?project= { route_id, name } → route 分裂 + draft POI
 *   POST   /api/events/:id/pin?project=    { pinned } → 图钉钉住/拔钉
 *   POST /api/pending/decide?project= → { id, approve } → 卡片结构化决定：消费 pending + 恢复/放弃挂起操作（0.4.2）
 *   POST /api/reset?project=   → 该项目的 trip 推倒重来
 *   GET  /api/events?project=  → SSE：jev/pending/geo/gate/tool/turn_* 事件流（按项目隔离）
 *   GET  /api/map-config       → 高德 JSAPI key + securityJsCode
 *   （project 参数缺省 → 最近更新的未归档项目；一个都没有则新建）
 */
import { config } from "dotenv";
import { join } from "node:path";
config({ path: join(import.meta.dirname, "../../.env") });
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRiddleAgent, buildModel, type RiddleRuntime } from "./agent.ts";
import { TripStore, emptyTrip, destList, recordUserAction, type Trip } from "./memory/trip-store.ts";
import { editEvent, reorderEvents, insertPoiOnRoute, pinEvent, checkTimeConflicts } from "./memory/edits.ts";
import { LLM_PRESETS, loadSettings, saveSettings, publicSettings, resolveMapConfig, resolveWatchdogMs, type LlmProvider } from "./settings.ts";
import { testConnection } from "./settings-test.ts";

const UI_DIR = join(import.meta.dirname, "../../UI");
const RUNS_DIR = join(import.meta.dirname, "../runs");  // 与 TripStore 默认 runsRoot 一致（APP/runs）
mkdirSync(RUNS_DIR, { recursive: true });
const REGISTRY_PATH = join(RUNS_DIR, "projects.json");
const LAB_ENV = join(import.meta.dirname, "../../LAB/lab01-amap-route-magnifier/env.js");
const PORT = Number(process.env.RIDDLE_PORT || 8787);

/** JSAPI 凭证兜底链：环境变量（AMAP_JSAPI_KEY / AMAP_SECURITY_JSCODE）→ 内部 lab01 env.js（外部分发包无此文件，自动跳过） */
function mapConfigFallback() {
  const envKey = process.env.AMAP_JSAPI_KEY ?? "";
  const envCode = process.env.AMAP_SECURITY_JSCODE ?? "";
  if (envKey || envCode) return { key: envKey, securityJsCode: envCode };
  try {
    const src = readFileSync(LAB_ENV, "utf8");
    return {
      key: /key:\s*'([^']+)'/.exec(src)?.[1] ?? "",
      securityJsCode: /securityJsCode:\s*'([^']+)'/.exec(src)?.[1] ?? "",
    };
  } catch {
    return { key: "", securityJsCode: "" };
  }
}

// ---------------- 项目注册表 ----------------
interface ProjectMeta {
  id: string;            // = tripId
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  archived: boolean;
  order: number;
  stage: string;         // 清单卡片展示用，touch 时同步
}
interface Project {
meta: ProjectMeta;
rt?: RiddleRuntime;
conv: { role: "user" | "agent"; text: string; ts: number }[];
eventLog: Record<string, unknown>[];
busy: boolean;
sse: Set<ServerResponse>;
/** 0.4.4 网关故障重试卡：turn 异常终止时记下原输入，UI 弹卡片一键重跑（进度已在 trip.json） */
lastFailedTurn?: { text: string; error: string; ts: number } | null;
}

const projects = new Map<string, Project>();
// delta/delta_reset 是流式打字机噪声：不入重放日志（会挤掉 300 条的容量、撑爆磁盘文件）
const REPLAY_SKIP = new Set(["turn_start", "turn_end", "turn_error", "geo", "hello", "reset", "delta", "delta_reset"]);

function saveRegistry() {
  const metas = [...projects.values()].map(p => p.meta);
  writeFileSync(REGISTRY_PATH, JSON.stringify(metas, null, 2));
}

function broadcast(p: Project, ev: Record<string, unknown>) {
  const stamped = { ...ev, ts: Date.now() };
  if (!REPLAY_SKIP.has(ev.type as string)) {
    p.eventLog.push(stamped); if (p.eventLog.length > 300) p.eventLog.shift();
    // 持久化到磁盘：服务重启后 SSE 订阅仍能重放 Jev 决策流（修复 eventLog 仅内存、重启即丢）
    try { appendFileSync(join(RUNS_DIR, p.meta.id, "events.jsonl"), JSON.stringify(stamped) + "\n"); } catch { /* 目录未建时跳过 */ }
  }
  const line = `data: ${JSON.stringify(stamped)}\n\n`;
  for (const res of p.sse) { try { res.write(line); } catch { /* 客户端断开由 close 清理 */ } }
}

/** 项目显示名：目的地·天数 > 首句用户输入 > 新旅程 */
function deriveTitle(p: Project): string {
  if (p.rt) {
    const t = p.rt.store.trip;
    const dest = destList(t);
    if (dest.length) return `${dest.join("·")}${t.days ? ` · ${t.days}日` : ""}`;
  }
  const first = p.conv.find(m => m.role === "user")?.text;
  if (first) return first.slice(0, 14) + (first.length > 14 ? "…" : "");
  return "新旅程";
}

function touch(p: Project) {
  p.meta.updatedAt = Date.now();
  p.meta.title = deriveTitle(p);
  if (p.rt) p.meta.stage = p.rt.store.trip.stage;
  saveRegistry();
}

function persistConv(p: Project) {
  try { writeFileSync(join(RUNS_DIR, p.meta.id, "conv.json"), JSON.stringify(p.conv)); } catch { /* 目录未建时跳过 */ }
}

/** 懒加载 runtime：registry 里有 tripId 且磁盘有 trip.json → 恢复；否则新开 */
function getRt(p: Project): RiddleRuntime {
  if (p.rt) return p.rt;
  let store: TripStore;
  try {
    const trip = JSON.parse(readFileSync(join(RUNS_DIR, p.meta.id, "trip.json"), "utf8"));
    store = new TripStore(trip);
    try { p.conv.push(...JSON.parse(readFileSync(join(RUNS_DIR, p.meta.id, "conv.json"), "utf8"))); } catch { /* 无对话记录 */ }
  } catch {
    // trip.json 缺失（如新建项目从未落盘）：按 registry 的 id 重建空 trip，项目身份保持稳定
    const t = emptyTrip();
    t.trip_id = p.meta.id;
    store = new TripStore(t);
    store.save();
  }
  const rt = createRiddleAgent(store);
  rt.onEvent(ev => broadcast(p, ev as unknown as Record<string, unknown>));
  rt.agent.subscribe((ev: any) => {
    // 流式文本：assistant 消息开始 → 通知前端清空；text_delta → 推送已累积文本（直接读 partial message，不自己拼 delta）
    if (ev.type === "message_start") broadcast(p, { type: "delta_reset" });
    if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
      const text = (ev.message?.content ?? []).map((c: any) => c.text ?? "").join("");
      if (text) broadcast(p, { type: "delta", text });
    }
    if (ev.type === "tool_execution_start") {
      broadcast(p, { type: "tool", phase: "start", name: ev.toolName ?? ev.toolCall?.name, args: JSON.stringify(ev.args ?? ev.toolCall?.arguments ?? {}).slice(0, 90) });
    }
    if (ev.type === "tool_execution_end") {
      const t = ev.result?.content?.[0]?.text ?? "";
      broadcast(p, { type: "tool", phase: "end", name: ev.toolName ?? ev.toolCall?.name, text: String(t).slice(0, 300) });
    }
  });
  p.rt = rt;
  return rt;
}

function createProject(): Project {
  const p: Project = {
    meta: { id: "", title: "新旅程", createdAt: Date.now(), updatedAt: Date.now(), pinned: false, archived: false, order: projects.size, stage: "explore" },
    conv: [], eventLog: [], busy: false, sse: new Set(),
  };
  // 全新项目：先建 store 拿到随机 tripId 并立即落盘，再交给 getRt 装配（否则 catch 分支会把 id 钉成 ""）
  const store = new TripStore();
  store.save();
  p.meta.id = store.trip.trip_id;
  projects.set(p.meta.id, p);
  getRt(p);
  saveRegistry();
  return p;
}

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return;
  try {
    for (const meta of JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as ProjectMeta[]) {
      meta.stage ??= "explore";
      const p: Project = { meta, conv: [], eventLog: [], busy: false, sse: new Set() };
      // 恢复磁盘上的事件日志（jev/pending/gate/tool），控制台决策流跨重启可见
      try {
        const lines = readFileSync(join(RUNS_DIR, meta.id, "events.jsonl"), "utf8").trim().split("\n").filter(Boolean);
        p.eventLog.push(...lines.slice(-300).map(l => JSON.parse(l)));
      } catch { /* 无事件日志 */ }
      projects.set(meta.id, p);
    }
  } catch { /* 注册表损坏则从空开始 */ }
}

/** project 参数缺省时的兜底：最近更新的未归档项目，没有则新建 */
function defaultProject(): Project {
  const live = [...projects.values()].filter(p => !p.meta.archived)
    .sort((a, b) => b.meta.updatedAt - a.meta.updatedAt);
  return live[0] ?? createProject();
}

function resolveProject(url: URL): Project | undefined {
  const id = url.searchParams.get("project");
  if (id) return projects.get(id);
  return defaultProject();
}

function statePayload(p: Project) {
  const rt = getRt(p);
  // 0.4.3：v1 投影桥退役——payload 只下发 v2 事实源，legacy nodes/edges/events 一律剥离
  const { nodes: _n, edges: _e, events: _v, ...tripV2 } = rt.store.trip;
  return {
    project: p.meta,
    trip: tripV2,
    pending: rt.scheduler.list(),
    ops: rt.store.ops.map((r: any) => ({ seq: r.seq, ts: r.ts, op: r.op, undo_kind: r.undo?.kind ?? null, payload: r.payload })),
    conv: p.conv,
    failedTurn: p.lastFailedTurn ?? null,
    // 0.5：即时机械冲突（时间倒挂/重叠）随状态下发，前台标红；允许暂存，D7 前必须清
    conflicts: checkTimeConflicts(tripV2.events_v2 ?? {}),
  };
}

function sendJson(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}

/** 跑一轮 agent turn（/api/input 与 /api/pending/decide 共用）：
 * busy 锁 + 看门狗 + 空回复兜底 + agent 回复入 conv + turn 事件。调用前需自行 busy 检查与 conv 记入用户消息。 */
async function runTurn(p: Project, text: string, res: ServerResponse) {
  const rt = getRt(p);
  p.busy = true;
  broadcast(p, { type: "turn_start", input: text });
  // 看门狗：pi 的 agent-loop 是 while(true) 无迭代上限，模型固执重试被 block 的工具时会死循环。
  // 超时强制 abort（默认 240s，可在设置中心调整），保证 demo 不挂死。
  const wdMs = resolveWatchdogMs();
  const wd = setTimeout(() => { console.error(`[watchdog] prompt 超时 ${wdMs / 1000}s，强制 abort`); rt.agent.abort(); }, wdMs);
  try {
    await rt.agent.prompt(text);
    const last: any = [...rt.agent.state.messages].reverse().find((m: any) => m.role === "assistant");
    const reply = typeof last?.content === "string" ? last.content
      : (last?.content ?? []).map((c: any) => c.text ?? "").join("");
    // 空回复诊断：模型返回空内容时记录 stopReason/errorMessage（网关限流、schema 失败放弃等场景的指纹）
    let finalReply = reply;
    if (!reply.trim()) {
      const errMsg = String((last as any)?.errorMessage ?? "");
      console.warn(`[empty-reply] project=${p.meta.id} stopReason=${last?.stopReason ?? "?"} err=${errMsg.slice(0, 200)} messages=${rt.agent.state.messages.length}`);
      // 对用户不展示空气泡：把模型层错误翻成可操作的兜底文案（demo 体验兜底）
      finalReply = `（这轮模型网关没走通${/429|限制|rate/i.test(errMsg) ? "——触发了每分钟请求上限" : ""}，稍等十几秒把刚才的话再发一次就好，上下文都在）`;
    }
    p.conv.push({ role: "agent", text: finalReply, ts: Date.now() });
    persistConv(p);
    touch(p);
    p.lastFailedTurn = null;
    broadcast(p, { type: "turn_end", reply: finalReply });
    return sendJson(res, 200, { reply: finalReply, ...statePayload(p) });
  } catch (e) {
    // 0.4.4：异常终止（看门狗 abort / 网关熔断等）记 failedTurn，UI 出重试卡；进度不丢（trip.json 逐 op 落盘）
    p.lastFailedTurn = { text, error: (e as Error).message, ts: Date.now() };
    broadcast(p, { type: "turn_error", error: (e as Error).message });
    return sendJson(res, 500, { error: (e as Error).message });
  } finally { clearTimeout(wd); p.busy = false; }
}

loadRegistry();
if (!projects.size) createProject();

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  // ---------- 项目清单 ----------
  if (path === "/api/projects" && req.method === "GET") {
    for (const p of projects.values()) if (p.rt) p.meta.title = deriveTitle(p);
    const metas = [...projects.values()].map(p => p.meta)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.order - b.order || b.updatedAt - a.updatedAt);
    return sendJson(res, 200, { projects: metas });
  }
  if (path === "/api/projects" && req.method === "POST") {
    const p = createProject();
    return sendJson(res, 200, { meta: p.meta });
  }
  const metaMatch = /^\/api\/projects\/([^/]+)\/meta$/.exec(path);
  if (metaMatch && req.method === "POST") {
    const p = projects.get(metaMatch[1]);
    if (!p) return sendJson(res, 404, { error: "project not found" });
    const body = await readBody(req);
    if (typeof body.pinned === "boolean") p.meta.pinned = body.pinned;
    if (typeof body.archived === "boolean") p.meta.archived = body.archived;
    touch(p);
    return sendJson(res, 200, { meta: p.meta });
  }
  if (path === "/api/projects/reorder" && req.method === "POST") {
    const body = await readBody(req);
    const ids: string[] = Array.isArray(body.ids) ? body.ids : [];
    ids.forEach((id, i) => { const p = projects.get(id); if (p) p.meta.order = i; });
    saveRegistry();
    return sendJson(res, 200, { ok: true });
  }

  // ---------- 项目作用域 API ----------
  if (path === "/api/events") {
    const p = resolveProject(url);
    if (!p) return sendJson(res, 404, { error: "project not found" });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "replay_start", ts: Date.now() })}\n\n`);
    for (const ev of p.eventLog) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "hello", ts: Date.now() })}\n\n`);
    p.sse.add(res);
    req.on("close", () => p.sse.delete(res));
    return;
  }
  if (path === "/api/state" && req.method === "GET") {
    const p = resolveProject(url);
    if (!p) return sendJson(res, 404, { error: "project not found" });
    return sendJson(res, 200, statePayload(p));
  }
  if (path === "/api/map-config" && req.method === "GET") return sendJson(res, 200, resolveMapConfig(mapConfigFallback()));

  // ---------- 设置中心 ----------
  if (path === "/api/settings" && req.method === "GET") return sendJson(res, 200, publicSettings(mapConfigFallback()));
  if (path === "/api/settings" && req.method === "POST") {
    const body = await readBody(req);
    const patch: any = {};
    if (body.llm && typeof body.llm === "object") {
      patch.llm = {};
      if (typeof body.llm.provider === "string" && body.llm.provider in LLM_PRESETS) patch.llm.provider = body.llm.provider as LlmProvider;
      if (body.llm.temperature === null) patch.llm.temperature = null;
      else if (typeof body.llm.temperature === "number" && body.llm.temperature >= 0 && body.llm.temperature <= 2) patch.llm.temperature = body.llm.temperature;
      if (body.llm.conf && typeof body.llm.conf === "object") {
        patch.llm.conf = {};
        for (const [pid, c] of Object.entries<any>(body.llm.conf)) {
          if (!(pid in LLM_PRESETS) || !c || typeof c !== "object") continue;
          const cc: any = {};
          if (typeof c.apiKey === "string" && c.apiKey.trim()) cc.apiKey = c.apiKey.trim();   // key 只增改、不清空
          if (typeof c.baseUrl === "string") cc.baseUrl = c.baseUrl.trim();                  // 置空 = 回落预设
          if (typeof c.model === "string") cc.model = c.model.trim();
          patch.llm.conf[pid] = cc;
        }
      }
    }
    for (const sec of ["jev", "amap", "baidu"] as const) {
      if (!body[sec] || typeof body[sec] !== "object") continue;
      patch[sec] = {};
      for (const [k, v] of Object.entries<any>(body[sec])) {
        if (sec === "jev" && k === "enabled" && typeof v === "boolean") { patch[sec][k] = v; continue; }  // Jev 启停开关
        if (typeof v !== "string") continue;
        if (k === "baseUrl") patch[sec][k] = v.trim();          // baseUrl 可置空回落默认
        else if (v.trim()) patch[sec][k] = v.trim();            // key 类只增改
      }
    }
    if (body.agent && typeof body.agent === "object") {
      patch.agent = {};
      if (body.agent.watchdogSeconds === null) patch.agent.watchdogSeconds = null;
      else if (typeof body.agent.watchdogSeconds === "number" && body.agent.watchdogSeconds > 0 && body.agent.watchdogSeconds <= 3600) patch.agent.watchdogSeconds = body.agent.watchdogSeconds;
    }
    if (body.map && typeof body.map === "object") {
      patch.map = {};
      if (body.map.active === "amap" || body.map.active === "baidu") patch.map.active = body.map.active;   // 地图数据源互斥切换
      if (typeof body.map.style === "string") patch.map.style = body.map.style.trim().replace(/^amap:\/\/styles\//, "") || "light";  // 容忍粘贴完整 amap://styles/<id>
    }
    saveSettings(patch);
    // 热生效：各运行时的模型对象即时替换（getApiKey/temperature 本就动态解析；Jev/高德 key 每次调用时解析）
    for (const p of projects.values()) { try { if (p.rt) (p.rt.agent.state as any).model = buildModel(); } catch { /* 单项目失败不影响其他 */ } }
    return sendJson(res, 200, { ok: true, settings: publicSettings(mapConfigFallback()) });
  }
  // 连通性测试：用表单中未保存的值或已解析的配置试连 LLM/Jev/高德/百度
  if (path === "/api/settings/test" && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, await testConnection(String(body.kind ?? ""), body));
  }
  if (path === "/api/reset" && req.method === "POST") {
    const p = resolveProject(url);
    if (!p) return sendJson(res, 404, { error: "project not found" });
    if (p.busy) return sendJson(res, 409, { error: "agent busy" });
    p.rt = undefined;
    p.conv.length = 0;
    p.eventLog.length = 0;
    // 清掉磁盘状态，getRt 会以同一项目 id 重建空 trip（项目身份不变）
    for (const f of ["trip.json", "ops.jsonl", "conv.json", "events.jsonl"]) { try { rmSync(join(RUNS_DIR, p.meta.id, f)); } catch { /* 不存在则跳过 */ } }
    getRt(p);
    touch(p);
    broadcast(p, { type: "reset" });
    return sendJson(res, 200, statePayload(p));
  }
  // 用户手动勾选/取消清单项：绕过对话直接改状态，并记录 user_action 让 LLM 下轮知晓
  if (path === "/api/checklist/toggle" && req.method === "POST") {
    const p = resolveProject(url);
    if (!p) return sendJson(res, 404, { error: "project not found" });
    const body = await readBody(req);
    const rt = getRt(p);
    const item = rt.store.trip.checklist[String(body.item_id ?? "")];
    if (!item) return sendJson(res, 404, { error: "checklist item not found" });
    const undo = { kind: "restore_trip", trip: JSON.parse(JSON.stringify(rt.store.trip)) }; // 变更前快照
    item.done = !!body.done;
    recordUserAction(rt.store.trip, `用户手动${item.done ? "勾选" : "取消勾选"}了清单「${item.title}」`);
    rt.store.log("checklist_toggle", { item_id: item.item_id, title: item.title, done: item.done, source: "user" }, undo);
    rt.store.save();
    touch(p);
    broadcast(p, { type: "state_dirty" });
    return sendJson(res, 200, statePayload(p));
  }
  // 用户为清单项补记完成细节（如"酒店订在观前街全季"）：异步 HITL，注入状态摘要让 LLM 下轮感知
  if (path === "/api/checklist/note" && req.method === "POST") {
    const p = resolveProject(url);
    if (!p) return sendJson(res, 404, { error: "project not found" });
    const body = await readBody(req);
    const rt = getRt(p);
    const item = rt.store.trip.checklist[String(body.item_id ?? "")];
    if (!item) return sendJson(res, 404, { error: "checklist item not found" });
    const note = String(body.note ?? "").trim().slice(0, 200);
    const undo = { kind: "restore_trip", trip: JSON.parse(JSON.stringify(rt.store.trip)) }; // 变更前快照
    item.note = note || null;
    recordUserAction(rt.store.trip, note ? `用户为清单「${item.title}」补记：${note}` : `用户清空了清单「${item.title}」的补记`);
    rt.store.log("checklist_note", { item_id: item.item_id, title: item.title, note: item.note, source: "user" }, undo);
    rt.store.save();
    touch(p);
    broadcast(p, { type: "state_dirty" });
    return sendJson(res, 200, statePayload(p));
  }
  if (path === "/api/input" && req.method === "POST") {
    const p = resolveProject(url);
    if (!p) return sendJson(res, 404, { error: "project not found" });
    if (p.busy) return sendJson(res, 409, { error: "agent busy" });
    const body = await readBody(req);
    const text = String(body.text ?? "").trim();
    if (!text) return sendJson(res, 400, { error: "empty input" });
    p.conv.push({ role: "user", text, ts: Date.now() });
    persistConv(p);
    return runTurn(p, text, res);
  }
  // 0.4.4 网关故障重试卡：带原输入重跑失败的那一轮（用户消息已入 conv，不重复记）
  if (path === "/api/turn/retry" && req.method === "POST") {
    const p = resolveProject(url);
    if (!p) return sendJson(res, 404, { error: "project not found" });
    if (p.busy) return sendJson(res, 409, { error: "agent busy" });
    const failed = p.lastFailedTurn;
    if (!failed) return sendJson(res, 400, { error: "没有可重试的失败轮次" });
    p.lastFailedTurn = null;
    p.conv.push({ role: "user", text: `↻ 重试上一轮 —— ${failed.text}`, ts: Date.now() });
    persistConv(p);
    return runTurn(p, failed.text, res);
  }
  // ---------- 0.5 共创编辑器：同步编辑 API（落 op 不触发 LLM 轮；busy 时拒绝防并发改图） ----------
  const evMatch = /^\/api\/events\/([^/]+)(\/pin)?$/.exec(path);
  if (evMatch && (req.method === "PATCH" || (evMatch[2] && req.method === "POST"))) {
    const p = resolveProject(url);
    if (!p) return sendJson(res, 404, { error: "project not found" });
    if (p.busy) return sendJson(res, 409, { error: "agent busy，等这轮跑完再改" });
    const rt = getRt(p);
    const body = await readBody(req);
    try {
      if (evMatch[2]) pinEvent(rt.store, evMatch[1], !!body.pinned);
      else editEvent(rt.store, evMatch[1], body.patch ?? {});
    } catch (e) { return sendJson(res, 400, { error: (e as Error).message }); }
    touch(p);
    broadcast(p, { type: "state_dirty" });
    return sendJson(res, 200, statePayload(p));
  }
  if (path === "/api/events/reorder" && req.method === "POST") {
    const p = resolveProject(url);
    if (!p) return sendJson(res, 404, { error: "project not found" });
    if (p.busy) return sendJson(res, 409, { error: "agent busy，等这轮跑完再改" });
    const body = await readBody(req);
    const rt = getRt(p);
    try { reorderEvents(rt.store, Number(body.day), Array.isArray(body.ordered_ids) ? body.ordered_ids.map(String) : []); }
    catch (e) { return sendJson(res, 400, { error: (e as Error).message }); }
    touch(p);
    broadcast(p, { type: "state_dirty" });
    return sendJson(res, 200, statePayload(p));
  }
  if (path === "/api/events/insert-on-route" && req.method === "POST") {
    const p = resolveProject(url);
    if (!p) return sendJson(res, 404, { error: "project not found" });
    if (p.busy) return sendJson(res, 409, { error: "agent busy，等这轮跑完再改" });
    const body = await readBody(req);
    const rt = getRt(p);
    const name = String(body.name ?? "").trim();
    if (!name) return sendJson(res, 400, { error: "empty name" });
    try { insertPoiOnRoute(rt.store, String(body.route_id ?? ""), name); }
    catch (e) { return sendJson(res, 400, { error: (e as Error).message }); }
    touch(p);
    broadcast(p, { type: "state_dirty" });
    return sendJson(res, 200, statePayload(p));
  }
  // 0.5 e6：出行方式槽位直改（UI 模式 chip 用）。白名单仅 mobility——其余槽位必须走对话 + Jev 复核
  if (path === "/api/slots/mobility" && req.method === "POST") {
    const p = resolveProject(url);
    if (!p) return sendJson(res, 404, { error: "project not found" });
    if (p.busy) return sendJson(res, 409, { error: "agent busy，等这轮跑完再改" });
    const body = await readBody(req);
    const v = String(body.value ?? "");
    if (!["general", "self_drive"].includes(v)) return sendJson(res, 400, { error: "value 须为 general | self_drive" });
    const rt = getRt(p);
    const old = JSON.parse(JSON.stringify(rt.store.trip.slots));
    rt.store.trip.slots.mobility = v;
    rt.store.log("slot_update", { slot: "mobility", value: v }, { kind: "restore_slots", slots: old }, { actor: "user" });
    touch(p);
    broadcast(p, { type: "state_dirty" });
    return sendJson(res, 200, statePayload(p));
  }
  // dev-only：整树恢复（数据抢救/调试用；不落 op、不触发 LLM 轮，直接替换事实源并落盘）
  if (path === "/api/dev/restore-trip" && req.method === "POST") {
    const p = resolveProject(url);
    if (!p) return sendJson(res, 404, { error: "project not found" });
    if (p.busy) return sendJson(res, 409, { error: "agent busy" });
    const body = await readBody(req);
    if (!body.trip || typeof body.trip !== "object") return sendJson(res, 400, { error: "trip required" });
    const rt = getRt(p);
    rt.store.trip = body.trip as Trip;
    rt.store.save();
    touch(p);
    broadcast(p, { type: "state_dirty" });
    return sendJson(res, 200, statePayload(p));
  }
  // 0.4.2 卡片真阻塞 HITL：结构化决定（聊天卡片/待确认面板按钮）→ 直接消费 pending（不经 Jev 意图判断），
  // 同意则颁发一次性放行令牌并驱动 agent 恢复被挂起的操作；拒绝则放弃。自然语言回答是兜底路径（transformContext）。
  if (path === "/api/pending/decide" && req.method === "POST") {
    const p = resolveProject(url);
    if (!p) return sendJson(res, 404, { error: "project not found" });
    if (p.busy) return sendJson(res, 409, { error: "agent busy" });
    const body = await readBody(req);
    const rt = getRt(p);
    const approve = !!body.approve;
    const pending = rt.decidePending(String(body.id ?? ""), approve);
    if (!pending) return sendJson(res, 404, { error: "pending 不存在或已被回答" });
    p.conv.push({ role: "user", text: `${approve ? "✓ 确认" : "✗ 先不了"} —— ${pending.question}`, ts: Date.now() });
    persistConv(p);
    const promptText = approve
      ? `我在确认卡片中明确同意了待决问题「${pending.question}」。这是结构化决定（不需要再判断我的意图）；系统已颁发放行令牌，请直接恢复执行被挂起的操作（上下文：${JSON.stringify(pending.context)}），不要重复询问确认。`
      : `我在确认卡片中明确拒绝了待决问题「${pending.question}」。这是结构化决定：视为放弃该挂起操作——不要恢复执行、维持现状，简要确认即可，无需再追问这个问题。`;
    return runTurn(p, promptText, res);
  }

  // 静态文件（仅限 UI 目录）
  const file = path === "/" ? "app.html" : decodeURIComponent(path.replace(/^\//, ""));
  const fp = join(UI_DIR, file);
  if (!fp.startsWith(UI_DIR) || !existsSync(fp)) { res.writeHead(404); res.end("not found"); return; }
  res.writeHead(200, { "content-type": file.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
  res.end(readFileSync(fp));
});

server.listen(PORT, () => console.log(`Riddle demo → http://localhost:${PORT}（${projects.size} 个项目）`));
