/** 带退级的判断引擎：Jev 优先，Jev 不可用（网络断/超时/5xx/未启用）时透明退级到 LLM 判断。
 * 与 JevClient 同接口（继承），agent 三个注入点零改动。
 * 退级策略：
 * - 设置里 jev.enabled=false → 直接用 LLM（用户显式关闭）；
 * - Jev 调用失败 → 记 60s 冷却，冷却期内所有判断直接走 LLM（避免每次白等 20s 超时），冷却结束自动重试 Jev；
 * - LLM 退级同样失败 → 异常照常抛出（调用方 transformContext 有 try/catch 兜底，beforeToolCall 会 fail-closed 打回）。
 * 每次引擎切换通过 onEngine 回调发事件（UI 动态流可见"判断引擎：LLM 退级"）。 */
import { JevClient } from "./client.ts";
import { LlmJudge } from "./llm-judge.ts";
import { resolveJev } from "../settings.ts";

export type JudgeEngine = "jev" | "llm";

export class ResilientJudge extends JevClient {
  private llm = new LlmJudge();
  private cooldownUntil = 0;
  private engine: JudgeEngine = "jev";
  onEngine?: (engine: JudgeEngine, reason: string) => void;

  private switchTo(engine: JudgeEngine, reason: string) {
    if (this.engine === engine) return;
    this.engine = engine;
    try { this.onEngine?.(engine, reason); } catch { /* 事件回调不阻断判断 */ }
  }

  async ask(state: unknown, questions: unknown): Promise<Record<string, any>> {
    const cfg = resolveJev();
    const q = questions as Record<string, any>;
    const jevEnabled = cfg.enabled && !!cfg.apiKey;
    if (!jevEnabled) {
      this.switchTo("llm", cfg.enabled ? "Jev 未配置 API Key" : "Jev 已在设置中停用");
      return this.llm.ask(state, q);
    }
    if (Date.now() < this.cooldownUntil) return this.llm.ask(state, q);
    try {
      const ans = await super.ask(state, questions);
      this.switchTo("jev", "Jev 恢复可用");
      return ans;
    } catch (e) {
      this.cooldownUntil = Date.now() + 60_000;
      this.switchTo("llm", `Jev 不可用（${(e as Error).message}），退级到 LLM 判断，60s 后自动重试`);
      return this.llm.ask(state, q);
    }
  }
}
