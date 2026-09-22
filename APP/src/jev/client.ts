/** Jev 判断引擎客户端（移植自 LAB/lab02 jev_client.py）。
 * 凭证每次请求前经设置中心动态解析（构造参数仅作显式覆盖），保存设置后即时生效。 */
import { MODEL, TH, STATE_CHANGE_INTENTS, d1IntentQuestions, d6RadiusQuestion, d7VerifyQuestions, pendingConsumeQuestion } from "./questions.ts";
import { resolveJev } from "../settings.ts";

export class JevClient {
  constructor(
    private apiKey?: string,
    private baseUrl?: string,
    private timeoutMs = 20000,
  ) {}

  async ask(state: unknown, questions: unknown): Promise<Record<string, any>> {
    const cfg = resolveJev();
    const apiKey = this.apiKey ?? cfg.apiKey;
    const baseUrl = (this.baseUrl ?? cfg.baseUrl).replace(/\/$/, "");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await fetch(`${baseUrl}/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ state, model: MODEL, questions }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`jev http ${resp.status}: ${await resp.text()}`);
      return (await resp.json()).answers;
    } finally {
      clearTimeout(t);
    }
  }

  /** D1 意图分类（多标签，分级阈值） */
  async d1Intents(userInput: string, tripSummary: unknown) {
    const answers = await this.ask({ user_input: userInput, trip_summary: tripSummary }, d1IntentQuestions());
    const hit: Record<string, number> = {};
    const raw: Record<string, number> = {};
    for (const [qid, ans] of Object.entries<any>(answers)) {
      const intent = qid.replace("intent_", "").toUpperCase();
      raw[intent] = ans.noul;
      const th = STATE_CHANGE_INTENTS.has(intent) ? TH.intentState : TH.intentInfo;
      if (ans.noul >= th) hit[intent] = ans.noul;
    }
    return { intents: hit, raw };
  }

  /** D6 传播半径 */
  async d6Radius(opDesc: string, tripSummary: unknown) {
    const answers = await this.ask({ operation: opDesc, trip_summary: tripSummary }, d6RadiusQuestion(opDesc));
    const ans = answers.propagation_radius;
    return { radius: ans.choice as "R1" | "R2" | "R3", confidence: ans.confidence, autoApply: ans.confidence >= TH.radiusAuto };
  }

  /** D7 语义闭环校验 */
  async d7Verify(planDesc: string) {
    const answers = await this.ask({ plan: planDesc }, d7VerifyQuestions(planDesc));
    const report: Record<string, any> = {};
    for (const [qid, ans] of Object.entries<any>(answers)) {
      const p = ans.noul;
      report[qid] = p >= TH.verifyPass ? "pass" : p >= 0.35 ? "warn" : "fail";
      report[`${qid}_prob`] = p;
    }
    return report;
  }

  /** pending 消费判定：输入是否在回应待决问题、以及是否为同意（调度系统用）。
   *  回应≠同意——「先不了，维持现状」是回应但不是同意。 */
  async consumesPending(userInput: string, pendingQuestion: string): Promise<{ answered: number; approved: number }> {
    const answers = await this.ask({ user_input: userInput }, pendingConsumeQuestion(pendingQuestion));
    return { answered: answers.consume_pending.noul, approved: answers.approve_pending.noul };
  }
}
