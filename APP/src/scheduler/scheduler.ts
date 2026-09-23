/** 调度系统：阶段机 + pending-question 队列。
 * 修复泛化测试缺陷①（重庆案例 D6 转人工后无人消费）：所有待决问题统一入队，
 * 新输入先经 Jev 判定是否在回答队首问题。
 * 队列持久化在 runs/<trip_id>/pending.json（构造时恢复，enqueue/dequeue 时落盘），
 * 服务重启后挂起问题不丢失。 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface PendingQuestion {
  id: string;
  question: string;      // 给用户看的问题
  kind: "d6_radius" | "slot_override" | "clarify" | "verify_warn" | "checklist_confirm";
  context: Record<string, unknown>;  // 恢复执行所需上下文（如被挂起的变更操作）
  createdAt: number;
}

export class Scheduler {
  private queue: PendingQuestion[] = [];

  constructor(private persistPath?: string) {
    if (persistPath && existsSync(persistPath)) {
      try {
        const data = JSON.parse(readFileSync(persistPath, "utf8"));
        if (Array.isArray(data)) this.queue = data;
      } catch { this.queue = []; }
    }
  }

  private persist() {
    if (!this.persistPath) return;
    try { writeFileSync(this.persistPath, JSON.stringify(this.queue, null, 2)); } catch { /* 目录未建时跳过 */ }
  }

  enqueue(q: Omit<PendingQuestion, "id" | "createdAt">): PendingQuestion {
    // 去重：同 kind 同问题的 pending 不重复入队（LLM 被 block 后会重试，防队列堆积）
    const dup = this.queue.find(i => i.kind === q.kind && i.question === q.question);
    if (dup) return dup;
    const item = { ...q, id: `pq_${Date.now()}_${this.queue.length}`, createdAt: Date.now() };
    this.queue.push(item);
    this.persist();
    return item;
  }

  peek(): PendingQuestion | undefined { return this.queue[0]; }

  dequeue(): PendingQuestion | undefined {
    const item = this.queue.shift();
    this.persist();
    return item;
  }

  /** 按 id 移除（0.4.2 卡片决策：用户点的卡片不一定是队首） */
  remove(id: string): PendingQuestion | undefined {
    const i = this.queue.findIndex(q => q.id === id);
    if (i < 0) return undefined;
    const [item] = this.queue.splice(i, 1);
    this.persist();
    return item;
  }

  get size() { return this.queue.length; }

  list(): readonly PendingQuestion[] { return this.queue; }
}
