/** 设置连通性测试：POST /api/settings/test 的实现。
 * 表单里【未保存】的值优先参与测试（overrides），留空的字段回落到 设置文件 > 环境变量 > 预设。
 * 所有测试只读、不动配额敏感的接口：LLM 用 models 列表，地图用一次轻量查询，Jev 用一次最小判断。 */
import { loadSettings, resolveJev, LLM_PRESETS, type LlmProvider } from "./settings.ts";
import { MODEL } from "./jev/questions.ts";

const TIMEOUT_MS = 12000;

type TestResult = { ok: true; ms: number; detail: string } | { ok: false; ms: number; error: string };
const ok = (ms: number, detail: string): TestResult => ({ ok: true, ms, detail });
const bad = (ms: number, error: string): TestResult => ({ ok: false, ms, error });
const str = (v: any) => (typeof v === "string" ? v.trim() : "");
const errMsg = (e: any, ms: number) => bad(ms, e?.name === "AbortError" ? `连接超时（>${TIMEOUT_MS / 1000}s）` : String(e?.message ?? e));

async function timedFetch(url: string, init: RequestInit = {}) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    return { resp, ms: Date.now() - t0 };
  } finally {
    clearTimeout(t);
  }
}

/** LLM：用 models 列表接口验证 key + baseUrl（不产生生成费用） */
export async function testLlm(ov: any = {}): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const s = loadSettings().llm;
    const pid = (str(ov.provider) in LLM_PRESETS ? str(ov.provider) : s.provider) as LlmProvider;
    const preset = LLM_PRESETS[pid];
    const conf = s.conf[pid] ?? { apiKey: "", baseUrl: "", model: "" };
    const apiKey = str(ov.apiKey) || conf.apiKey || process.env[preset.envKey] || "";
    const baseUrl = (str(ov.baseUrl) || conf.baseUrl || (preset.envBase ? process.env[preset.envBase] ?? "" : "") || preset.baseUrl).replace(/\/$/, "");
    const model = str(ov.model) || conf.model || (preset.envModel ? process.env[preset.envModel] ?? "" : "") || preset.model;
    if (!apiKey) return bad(0, "未配置 API Key");
    if (!baseUrl) return bad(0, "未配置 Base URL（自定义服务商必填）");
    if (preset.api === "anthropic-messages") {
      const { resp, ms } = await timedFetch(`${baseUrl}/v1/models`, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } });
      if (!resp.ok) return bad(ms, `HTTP ${resp.status}：${(await resp.text()).slice(0, 140)}`);
      const d: any = await resp.json();
      return ok(ms, `${preset.label} 可用 · ${d.data?.length ?? "?"} 个模型`);
    }
    const { resp, ms } = await timedFetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!resp.ok) return bad(ms, `HTTP ${resp.status}：${(await resp.text()).slice(0, 140)}`);
    const d: any = await resp.json();
    const n = d.data?.length;
    const has = model && Array.isArray(d.data) && d.data.some((m: any) => m?.id === model);
    return ok(ms, `${preset.label} 可用${n != null ? ` · ${n} 个模型` : ""}${has ? ` · 含 ${model}` : model ? ` · 当前模型 ${model}` : ""}`);
  } catch (e: any) {
    return errMsg(e, Date.now() - t0);
  }
}

/** Jev：发一次最小判断请求（验证 key + 服务在线；成本可忽略） */
export async function testJev(ov: any = {}): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const cfg = resolveJev();
    const apiKey = str(ov.apiKey) || cfg.apiKey;
    const baseUrl = (str(ov.baseUrl) || cfg.baseUrl).replace(/\/$/, "");
    if (!apiKey) return bad(0, "未配置 API Key");
    const { resp, ms } = await timedFetch(`${baseUrl}/systemone`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        state: { ping: "connectivity test" },
        model: MODEL,
        questions: { echo: { type: "noul", instructions: "这是一次连通性测试，无需判断任何内容，直接返回 1。" } },
      }),
    });
    if (!resp.ok) return bad(ms, `HTTP ${resp.status}：${(await resp.text()).slice(0, 140)}`);
    const d: any = await resp.json();
    return ok(ms, d?.answers ? "判断引擎在线（完成一次最小判断）" : "已连通，但响应缺少 answers 字段");
  } catch (e: any) {
    return errMsg(e, Date.now() - t0);
  }
}

/** 高德 Web 服务：一次行政区查询验证 key（免费配额） */
export async function testAmap(ov: any = {}): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const key = str(ov.webServiceKey) || loadSettings().amap.webServiceKey || process.env.AMAP_WEB_SERVICE_KEY || "";
    if (!key) return bad(0, "未配置 Web 服务 Key");
    const qs = new URLSearchParams({ keywords: "北京", subdistrict: "0", key });
    const { resp, ms } = await timedFetch(`https://restapi.amap.com/v3/config/district?${qs}`);
    const d: any = await resp.json();
    if (String(d.status) === "1") return ok(ms, "Web 服务可用（行政区查询通过）");
    return bad(ms, `${d.info ?? "鉴权失败"}（infocode ${d.infocode ?? "?"}）`);
  } catch (e: any) {
    return errMsg(e, Date.now() - t0);
  }
}

/** 百度 Web 服务：一次地点检索验证 AK（免费配额） */
export async function testBaidu(ov: any = {}): Promise<TestResult> {
  const t0 = Date.now();
  try {
    const key = str(ov.webServiceKey) || loadSettings().baidu.webServiceKey || process.env.BAIDU_MAP_AK || process.env.BAIDU_WEB_SERVICE_AK || "";
    if (!key) return bad(0, "未配置服务端 AK");
    const qs = new URLSearchParams({ query: "天安门", region: "北京", output: "json", ak: key });
    const { resp, ms } = await timedFetch(`https://api.map.baidu.com/place/v2/search?${qs}`);
    const d: any = await resp.json();
    if (d.status === 0) return ok(ms, "Web 服务可用（地点检索通过）");
    return bad(ms, `${d.message ?? "鉴权失败"}（status ${d.status}）`);
  } catch (e: any) {
    return errMsg(e, Date.now() - t0);
  }
}

export async function testConnection(kind: string, body: any): Promise<TestResult> {
  switch (kind) {
    case "llm": return testLlm(body);
    case "jev": return testJev(body);
    case "amap": return testAmap(body);
    case "baidu": return testBaidu(body);
    default: return bad(0, `未知测试类型：${kind}`);
  }
}
