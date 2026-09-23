/** LLM 退级判断器：Jev 不可用时的替身，与 JevClient.ask 同接口（state + questions → answers）。
 * 输入的 questions 原样转发给生成模型（schema 与 Jev 一致：noul → {noul}，choice → {choice, confidence}），
 * 输出做保守清洗：noul 缺失/非法 → 0（不通过阈值，fail-closed）；choice 非法 → 置信 0（转人工，fail-closed）。
 * 配置走设置中心 resolveLlm（与生成模型同渠道）；支持 anthropic-messages 与 openai-completions 两种 API。 */
import { resolveLlm } from "../settings.ts";

const SYSTEM = `你是旅行规划系统里的判断引擎（Jev 的退级替身）。给你 state 和一组 questions，逐题判断。
输出【严格 JSON、不要任何多余文字】：{"answers": {"<question_id>": {...}, ...}}
- type=noul 的题：{"noul": 0~1 之间的概率}，表示命题为真的置信度。
- type=choice 的题：{"choice": "<criteria 的 key>", "confidence": 0~1}。
判断标准：保守、讲证据；文本不支持的命题给低分。`;

const clamp01 = (v: any) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** 按 questions schema 清洗 LLM 输出，缺题/坏值一律 fail-closed */
function sanitize(questions: Record<string, any>, answers: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [qid, q] of Object.entries(questions)) {
    const a = answers?.[qid];
    if (q?.type === "choice") {
      const keys = Object.keys(q.criteria ?? {});
      const choice = keys.includes(a?.choice) ? a.choice : keys[0];
      out[qid] = { choice, confidence: keys.includes(a?.choice) ? clamp01(a?.confidence) : 0 };
    } else {
      out[qid] = { noul: clamp01(a?.noul) };
    }
  }
  return out;
}

export class LlmJudge {
  constructor(private timeoutMs = 30000) {}

  async ask(state: unknown, questions: Record<string, any>): Promise<Record<string, any>> {
    const c = resolveLlm();
    if (!c.apiKey) throw new Error("LLM 未配置 API Key，无法退级判断");
    const user = `state:\n${JSON.stringify(state, null, 2)}\n\nquestions:\n${JSON.stringify(questions, null, 2)}`;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const text = await this.call(c, user);
        const m = text.replace(/```(?:json)?/g, "").match(/\{[\s\S]*\}/);
        if (!m) throw new Error(`输出不含 JSON：${text.slice(0, 120)}`);
        const parsed = JSON.parse(m[0]);
        if (!parsed?.answers || typeof parsed.answers !== "object") throw new Error("输出缺少 answers 字段");
        return sanitize(questions, parsed.answers);
      } catch (e) {
        lastErr = e as Error;
        if ((e as any)?.status !== 429 && !String((e as Error).message).startsWith("HTTP 429")) break; // 只有 429 值得重试
        // Friday 网关按分钟限流：退避跨过当前限流窗
        await new Promise(r => setTimeout(r, [10_000, 20_000, 40_000][attempt] ?? 40_000));
      }
    }
    throw lastErr ?? new Error("LLM 判断失败");
  }

  private async call(c: ReturnType<typeof resolveLlm>, user: string): Promise<string> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      if (c.api === "anthropic-messages") {
        const headers: Record<string, string> = { "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
        if (c.bearer) headers.Authorization = `Bearer ${c.apiKey}`;
        else headers["x-api-key"] = c.apiKey;
        const resp = await fetch(`${c.baseUrl}/v1/messages`, {
          method: "POST", headers, signal: ctrl.signal,
          body: JSON.stringify({ model: c.model, max_tokens: 2048, system: SYSTEM, messages: [{ role: "user", content: user }] }),
        });
        if (!resp.ok) { const e: any = new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 140)}`); e.status = resp.status; throw e; }
        const d: any = await resp.json();
        return (d.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      }
      // openai-completions 系（deepseek/chatgpt/glm/custom）
      const resp = await fetch(`${c.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({ model: c.model, max_tokens: 2048, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }),
      });
      if (!resp.ok) { const e: any = new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 140)}`); e.status = resp.status; throw e; }
      const d: any = await resp.json();
      return d.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(t);
    }
  }
}
