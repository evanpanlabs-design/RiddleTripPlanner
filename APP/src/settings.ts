/** 设置中心：runs/settings.json 持久化，三级解析 —— 设置文件 > 环境变量 > 内置预设。
 *
 * 关键设计：所有 resolve* 都在【调用时】读配置（不缓存进构造器/闭包），
 * 因此 POST /api/settings 保存后无需重启、无需重建 runtime 即生效：
 * - LLM：server 保存后把各项目 agent.state.model 热替换为 buildModel()；
 *   getApiKey / temperature 是每次流式调用前动态解析的
 * - Jev：JevClient.ask 每次请求前 resolveJev()
 * - 高德 Web 服务：amapGet 每次请求前 resolveAmapWebKey()
 * - 高德 JSAPI：GET /api/map-config 每次动态解析（前端刷新页面后生效）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const SETTINGS_PATH = join(import.meta.dirname, "../runs/settings.json");

export type LlmProvider = "deepseek" | "claude" | "chatgpt" | "glm" | "friday" | "custom";

export interface ProviderConf { apiKey: string; baseUrl: string; model: string }

export type MapProvider = "amap" | "baidu";

export interface AppSettings {
  llm: { provider: LlmProvider; temperature: number | null; conf: Partial<Record<LlmProvider, ProviderConf>> };
  jev: { apiKey: string; baseUrl: string };
  amap: { webServiceKey: string; jsapiKey: string; securityJsCode: string };
  baidu: { webServiceKey: string; jsapiKey: string };   // 预留：下一版地图迁移用
  map: { active: MapProvider };                          // 实际启用哪个地图数据源（互斥）
  agent: { watchdogSeconds: number | null };
}

interface LlmPreset {
  label: string; api: string; provider: string;
  baseUrl: string; model: string;
  envKey: string; envBase?: string; envModel?: string;
  bearer?: boolean; // true = 该渠道强制 Authorization: Bearer（如美团 AIGC 网关拒绝 x-api-key）
  maxTokens?: number; // 输出上限，缺省 8192（DeepSeek 上限）；大草案（强约束通勤边后）容易超 8k，按渠道调大
}

export const LLM_PRESETS: Record<LlmProvider, LlmPreset> = {
  deepseek: { label: "DeepSeek", api: "openai-completions", provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", envKey: "DEEPSEEK_API_KEY", envBase: "DEEPSEEK_BASE_URL", envModel: "DEEPSEEK_MODEL" },
  claude: { label: "Claude（Anthropic）", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5", envKey: "ANTHROPIC_API_KEY" },
  chatgpt: { label: "ChatGPT（OpenAI）", api: "openai-completions", provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", envKey: "OPENAI_API_KEY" },
  glm: { label: "GLM（智谱）", api: "openai-completions", provider: "zhipu", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.5-flash", envKey: "GLM_API_KEY" },
  friday: { label: "Friday（美团 AIGC）", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://aigc.sankuai.com/v1/anthropic", model: "glm-52-meituan", envKey: "ANTHROPIC_AUTH_TOKEN", bearer: true, maxTokens: 32768 },
  custom: { label: "自定义（OpenAI 兼容）", api: "openai-completions", provider: "custom", baseUrl: "", model: "", envKey: "LLM_API_KEY", envBase: "LLM_BASE_URL", envModel: "LLM_MODEL" },
};

const BLANK: AppSettings = {
  llm: { provider: "deepseek", temperature: null, conf: {} },
  jev: { apiKey: "", baseUrl: "" },
  amap: { webServiceKey: "", jsapiKey: "", securityJsCode: "" },
  baidu: { webServiceKey: "", jsapiKey: "" },
  map: { active: "amap" },
  agent: { watchdogSeconds: null },
};

let cache: AppSettings | null = null;

function mergeDeep(dst: any, src: any) {
  for (const [k, v] of Object.entries<any>(src ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && dst[k] && typeof dst[k] === "object" && !Array.isArray(dst[k])) mergeDeep(dst[k], v);
    else dst[k] = v;
  }
}

export function loadSettings(): AppSettings {
  if (cache) return cache;
  const s: AppSettings = JSON.parse(JSON.stringify(BLANK));
  try { if (existsSync(SETTINGS_PATH)) mergeDeep(s, JSON.parse(readFileSync(SETTINGS_PATH, "utf8"))); } catch { /* 损坏则用默认 */ }
  cache = s;
  return s;
}

export function saveSettings(patch: Partial<AppSettings>) {
  const s = loadSettings();
  mergeDeep(s, patch);
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

// ---------------- 运行时解析（调用时读，保证热生效） ----------------

export function resolveLlm() {
  const s = loadSettings().llm;
  const preset = LLM_PRESETS[s.provider] ?? LLM_PRESETS.deepseek;
  const c = s.conf[s.provider] ?? { apiKey: "", baseUrl: "", model: "" };
  return {
    provider: s.provider, label: preset.label, api: preset.api, apiProvider: preset.provider,
    bearer: !!preset.bearer,
    maxTokens: preset.maxTokens ?? 8192,
    baseUrl: (c.baseUrl || (preset.envBase ? process.env[preset.envBase] : "") || preset.baseUrl).replace(/\/$/, ""),
    model: c.model || (preset.envModel ? process.env[preset.envModel] : "") || preset.model,
    apiKey: c.apiKey || process.env[preset.envKey] || "",
    temperature: s.temperature,
  };
}

export function resolveJev() {
  const j = loadSettings().jev;
  return {
    apiKey: j.apiKey || process.env.JEV_API_KEY || "",
    baseUrl: (j.baseUrl || process.env.JEV_BASE_URL || "https://api.typesafe.ai/v1").replace(/\/$/, ""),
  };
}

export function resolveAmapWebKey() {
  return loadSettings().amap.webServiceKey || process.env.AMAP_WEB_SERVICE_KEY || "";
}

export function resolveBaiduWebKey() {
  return loadSettings().baidu.webServiceKey || process.env.BAIDU_MAP_AK || process.env.BAIDU_WEB_SERVICE_AK || "";
}

/** 前端 JSAPI 配置：设置文件优先，缺省回落到 lab01 env.js（由 server 解析传入） */
export function resolveMapConfig(fallback: { key: string; securityJsCode: string }) {
  const a = loadSettings().amap;
  return { key: a.jsapiKey || fallback.key, securityJsCode: a.securityJsCode || fallback.securityJsCode };
}

export function resolveWatchdogMs() {
  const w = loadSettings().agent.watchdogSeconds;
  return (w && w > 0 ? w : 240) * 1000;
}

/** 当前启用的地图数据源（POI/路线解析走哪一家） */
export function resolveMapProvider(): MapProvider {
  return loadSettings().map.active;
}

// ---------------- 对外快照（脱敏） ----------------

const mask = (v: string) => (!v ? "" : v.length <= 8 ? "••••••" : `${v.slice(0, 3)}••••${v.slice(-4)}`);

type SecretSource = "settings" | "env" | "lab01" | "none";
function secretInfo(saved: string, envVal: string, labVal = "") {
  const v = saved || envVal || labVal;
  const source: SecretSource = saved ? "settings" : envVal ? "env" : labVal ? "lab01" : "none";
  return { set: !!v, masked: mask(v), source };
}

export function publicSettings(lab01Fallback: { key: string; securityJsCode: string }) {
  const s = loadSettings();
  const llm = resolveLlm();
  const conf = Object.fromEntries((Object.keys(LLM_PRESETS) as LlmProvider[]).map(pid => {
    const c = s.llm.conf[pid] ?? { apiKey: "", baseUrl: "", model: "" };
    const k = secretInfo(c.apiKey, process.env[LLM_PRESETS[pid].envKey] ?? "");
    return [pid, { keySet: k.set, keyMasked: k.masked, keySource: k.source, baseUrl: c.baseUrl, model: c.model }];
  }));
  return {
    llm: {
      provider: s.llm.provider, temperature: s.llm.temperature, conf,
      effective: { label: llm.label, baseUrl: llm.baseUrl, model: llm.model, api: llm.api, keySet: !!llm.apiKey },
    },
    jev: {
      baseUrl: s.jev.baseUrl, effectiveBaseUrl: resolveJev().baseUrl,
      key: secretInfo(s.jev.apiKey, process.env.JEV_API_KEY ?? ""),
    },
    amap: {
      web: secretInfo(s.amap.webServiceKey, process.env.AMAP_WEB_SERVICE_KEY ?? ""),
      jsapi: secretInfo(s.amap.jsapiKey, "", lab01Fallback.key),
      code: secretInfo(s.amap.securityJsCode, "", lab01Fallback.securityJsCode),
    },
    baidu: {
      web: secretInfo(s.baidu.webServiceKey, process.env.BAIDU_MAP_AK ?? process.env.BAIDU_WEB_SERVICE_AK ?? ""),
      jsapi: secretInfo(s.baidu.jsapiKey, ""),
    },
    map: { active: s.map.active },
    agent: { watchdogSeconds: s.agent.watchdogSeconds, effectiveWatchdogSeconds: resolveWatchdogMs() / 1000 },
    presets: Object.entries(LLM_PRESETS).map(([id, p]) => ({ id, label: p.label, baseUrl: p.baseUrl, model: p.model })),
  };
}
