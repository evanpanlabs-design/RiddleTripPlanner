/** 0.5 e5 event wiki：每个事件一份 Markdown 档案（runs/<trip>/docs/<event_id>.md）。
 * 双层结构（SPEC/editor-schema-0.5.md §5）：
 *   <!-- layer:llm -->  LLM 层——agent 用 write_event_doc 维护（攻略要点/判断依据/注意事项）
 *   <!-- layer:user --> 用户层——前台悬浮页可编辑（PUT /api/events/:id/doc），LOOP 只读不写
 * 写操作只动自己那一层，另一层原样保留；文件不存在时按骨架创建。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventV2 } from "./event-v2.ts";

export type DocLayer = "llm" | "user";
export interface EventDoc { event_id: string; name: string; llm: string; user: string; exists: boolean }

const LLM_MARK = "<!-- layer:llm -->";
const USER_MARK = "<!-- layer:user -->";

const docsDir = (tripDir: string) => join(tripDir, "docs");
const docPath = (tripDir: string, eventId: string) => join(docsDir(tripDir), `${eventId}.md`);

function skeleton(ev: Pick<EventV2, "event_id" | "name">): string {
  return `---\nevent: ${ev.event_id}\nname: ${ev.name}\n---\n${LLM_MARK}\n\n${USER_MARK}\n`;
}

function parse(content: string): { llm: string; user: string } {
  const li = content.indexOf(LLM_MARK), ui = content.indexOf(USER_MARK);
  if (li < 0 && ui < 0) return { llm: content.trim(), user: "" }; // 无标记的历史文件整体当 llm 层
  const llm = li < 0 ? "" : content.slice(li + LLM_MARK.length, ui < 0 ? undefined : ui).trim();
  const user = ui < 0 ? "" : content.slice(ui + USER_MARK.length).trim();
  return { llm, user };
}

/** 读事件文档（两层都回；不存在时 exists=false、两层空串） */
export function readEventDoc(tripDir: string, ev: Pick<EventV2, "event_id" | "name">): EventDoc {
  const p = docPath(tripDir, ev.event_id);
  if (!existsSync(p)) return { event_id: ev.event_id, name: ev.name, llm: "", user: "", exists: false };
  const { llm, user } = parse(readFileSync(p, "utf8"));
  return { event_id: ev.event_id, name: ev.name, llm, user, exists: true };
}

/** 只写指定层，另一层原样保留。返回写完后的完整文档。 */
export function writeEventDocLayer(tripDir: string, ev: Pick<EventV2, "event_id" | "name">, layer: DocLayer, text: string): EventDoc {
  mkdirSync(docsDir(tripDir), { recursive: true });
  const p = docPath(tripDir, ev.event_id);
  const cur = existsSync(p) ? parse(readFileSync(p, "utf8")) : { llm: "", user: "" };
  const next = layer === "llm" ? { ...cur, llm: text.trim() } : { ...cur, user: text.trim() };
  // 骨架头部跟随当前事件名（改名自动刷新）
  writeFileSync(p, `---\nevent: ${ev.event_id}\nname: ${ev.name}\n---\n${LLM_MARK}\n${next.llm}\n\n${USER_MARK}\n${next.user}\n`);
  return { event_id: ev.event_id, name: ev.name, ...next, exists: true };
}
