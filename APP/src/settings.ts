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
  jev: { enabled: boolean; apiKey: string; baseUrl: string };   // enabled=false → 判断全部退级到 LLM
  amap: { webServiceKey: string; jsapiKey: string; securityJsCode: string };
  baidu: { webServiceKey: string; jsapiKey: string };   // 预留：下一版地图迁移用
  map: { active: MapProvider; style: string };            // 实际启用哪个地图数据源（互斥）；style = 内置预设名或高德自定义样式 ID
  agent: { watchdogSeconds: number | null };
  /** 速率限制（0.4.4）：null = 默认/不限。llmRpm 作用于后台判断器（llm-judge）的密集调用；主对话流天然低速不限制 */
  limits: { llmRpm: number | null; amapQps: number | null; baiduQps: number | null };
  /** 可选搜索（0.5 e7，默认关）。调研结论：Friday anthropic-messages 渠道不自带搜索；
   * Friday 通用搜索（内部基建，需应用工厂 MCP 鉴权+按千次计费）与 Tavily（外部 key）都未接入，
   * 这里只占位设置项——enabled=true 目前不产生任何效果，实现前需先过合规与鉴权接入。 */
  search: { enabled: boolean; provider: "friday-search" | "tavily" | null };
}

/** 高德 JSAPI 内置样式预设（无需自定义平台）；自定义样式 ID 走高德「自定义地图平台」发布后填入 */
export const MAP_STYLE_PRESETS: Record<string, string> = {
  light: "浅色（默认）",
  whitesmoke: "白烟",
  fresh: "清新",
  macaron: "马卡龙",
  grey: "雅士灰",
  darkblue: "极夜蓝",
  normal: "标准",
};

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
  friday: { label: "Friday（美团 AIGC）", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://aigc.sankuai.com/v1/anthropic", model: "glm-52-meituan", envKey: "ANTHROPIC_AUTH_TOKEN", bearer: true, maxTokens: 65536 },
  custom: { label: "自定义（OpenAI 兼容）", api: "openai-completions", provider: "custom", baseUrl: "", model: "", envKey: "LLM_API_KEY", envBase: "LLM_BASE_URL", envModel: "LLM_MODEL" },
};

const BLANK: AppSettings = {
  llm: { provider: "deepseek", temperature: null, conf: {} },
  jev: { enabled: true, apiKey: "", baseUrl: "" },
  amap: { webServiceKey: "", jsapiKey: "", securityJsCode: "" },
  baidu: { webServiceKey: "", jsapiKey: "" },
  map: { active: "amap", style: "light" },
  agent: { watchdogSeconds: null },
  limits: { llmRpm: null, amapQps: null, baiduQps: null },
  search: { enabled: false, provider: null },
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
    enabled: j.enabled !== false,   // 缺省启用；显式 false 才停用
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

/** 前端 JSAPI 配置：设置文件优先，缺省回落到 lab01 env.js（由 server 解析传入）。mapStyle 原样给 JSAPI 的 mapStyle 参数 */
export function resolveMapConfig(fallback: { key: string; securityJsCode: string }) {
const a = loadSettings().amap;
const style = (loadSettings().map.style || "light").trim();
// style 是内置预设名（light/whitesmoke/…）或高德自定义平台发布的样式 ID，统一拼成 amap://styles/<值>
return { key: a.jsapiKey || fallback.key, securityJsCode: a.securityJsCode || fallback.securityJsCode, mapStyle: `amap://styles/${style}`, styleId: style };
}

export function resolveWatchdogMs() {
  const w = loadSettings().agent.watchdogSeconds;
  return (w && w > 0 ? w : 240) * 1000;
}

/** 速率限制解析（调用时读，热生效）：qps 默认 2.5（对应原写死 400ms 间隔）；llmRpm null = 不限 */
export function resolveLimits() {
  const l = loadSettings().limits ?? { llmRpm: null, amapQps: null, baiduQps: null };
  return {
    llmRpm: l.llmRpm && l.llmRpm > 0 ? l.llmRpm : null,
    amapQps: l.amapQps && l.amapQps > 0 ? l.amapQps : 2.5,
    baiduQps: l.baiduQps && l.baiduQps > 0 ? l.baiduQps : 2.5,
  };
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
      enabled: s.jev.enabled !== false,
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
    map: { active: s.map.active, style: s.map.style || "light", stylePresets: MAP_STYLE_PRESETS },
    agent: { watchdogSeconds: s.agent.watchdogSeconds, effectiveWatchdogSeconds: resolveWatchdogMs() / 1000 },
    limits: { ...s.limits, effective: resolveLimits() },
    search: { ...s.search, implemented: false }, // 0.5 e7：占位，未接入实现
    presets: Object.entries(LLM_PRESETS).map(([id, p]) => ({ id, label: p.label, baseUrl: p.baseUrl, model: p.model })),
  };
}
