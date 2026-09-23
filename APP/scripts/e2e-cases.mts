/** E2E 场景批次（v0.3.4）：3 个目的地形态 × 3 种常见人机交互，全链路走真实 LLM+Jev+工具。
 * 用法：npx tsx scripts/e2e-cases.mts [caseNameFilter]（服务须已起在 :8787）
 * 产出：scripts/out/e2e-<ts>.json（每轮 reply 摘要 + trip 图统计），人工复核用。 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const BASE = "http://localhost:8787";
const TURN_TIMEOUT = 300_000;

interface Turn { label: string; text: string }
interface Case { name: string; theme: string; turns: Turn[] }

const CASES: Case[] = [
  {
    name: "qinggan-loop",
    theme: "青甘大环线 · 多城环线 · 自驾",
    turns: [
      { label: "初始需求", text: "帮我规划青甘大环线，8天7晚，西宁进出，自驾，想看青海湖、茶卡盐湖、敦煌莫高窟、鸣沙山月牙泉、张掖丹霞，节奏中等" },
      { label: "攻略参考", text: "给你个攻略做参考：黑马河看日出很值得早起一次；大柴旦翡翠湖比茶卡盐湖人少更出片；莫高窟门票要提前30天在官网预约，旺季当天买不到；鸣沙山月牙泉傍晚去最好，中午沙子烫脚" },
      { label: "微调", text: "到敦煌那天太赶了吧，莫高窟加鸣沙山一天跑完太累，把鸣沙山挪到第二天上午" },
      { label: "已订反馈", text: "对了，西宁头两晚的酒店我自己订好了，莫高窟的A类票也已经在官网约好了" },
    ],
  },
  {
    name: "suxichang",
    theme: "苏锡常 · 城市群 · 高铁",
    turns: [
      { label: "初始需求", text: "苏锡常4日游，10月1日出发，10月4日回，上海出发高铁往返，我和爸妈3个人，园林和美食为主，行程轻松一点" },
      { label: "攻略参考", text: "参考下这个攻略：苏州拙政园要赶早，8点半开门就进；无锡鼋头渚樱花季人特别多；常州恐龙园适合带娃，我们不带孩子可以跳过；无锡酱排骨、苏州松鼠桂鱼必吃；苏州博物馆免费但要提前预约" },
      { label: "微调", text: "看下来常州好像没啥特别想去的，能不能压缩成3天只玩苏州和无锡？" },
      { label: "已订反馈", text: "上海到苏州的高铁票我已经买好了，苏州观前街附近的酒店也订好了" },
    ],
  },
  {
    name: "shanghai-3d",
    theme: "上海 · 单城 3 日 · Citywalk",
    turns: [
      { label: "初始需求", text: "上海3日游，10月16日（周五）到18日（周日），从杭州出发，第一次来上海，经典景点加 Citywalk，住人民广场附近" },
      { label: "攻略参考", text: "攻略里说：外滩夜景比白天好看，建议晚上去；武康路适合上午慢慢逛；本帮菜推荐老吉士，要提前订位；上海博物馆东馆很不错而且免费" },
      { label: "微调", text: "第二天想多睡会儿，上午的安排整体往后挪，挪到下午和晚上" },
      { label: "已订反馈", text: "人民广场的酒店订好了，周六晚上外滩的游船票也买好了" },
    ],
  },
];

async function post(path: string, body?: unknown): Promise<any> {
  const resp = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TURN_TIMEOUT),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`${path} → ${resp.status}: ${JSON.stringify(data)}`);
  return data;
}

function tripStats(trip: any) {
  const edges = Object.values(trip?.edges ?? {}) as any[];
  const bySrc: Record<string, number> = {};
  for (const e of edges) bySrc[e.data_source ?? "?"] = (bySrc[e.data_source ?? "?"] ?? 0) + 1;
  const checklist = Object.values(trip?.checklist ?? {}) as any[];
  return {
    nodes: Object.keys(trip?.nodes ?? {}).length,
    edges: edges.length,
    edges_by_source: bySrc,
    edge_gaps: edges.filter(e => !e.geometry || e.geometry.length < 2).map(e => `${e.from_id}→${e.to_id}(${e.mode})`),
    checklist: `${checklist.filter(c => c.done).length}/${checklist.length}`,
    user_actions: (trip?.user_actions ?? []).map((a: any) => a.text),
  };
}

const filter = process.argv[2];
const results: any[] = [];
for (const c of CASES) {
  if (filter && !c.name.includes(filter)) continue;
  console.log(`\n=== ${c.name} · ${c.theme} ===`);
  const { meta } = await post("/api/projects");
  const rec: any = { case: c.name, theme: c.theme, project: meta.id, turns: [] };
  for (const t of c.turns) {
    const t0 = Date.now();
    try {
      // 网关限流（429 每分钟上限）：空回复或兑底文案时按 45s 退避重试，最多 2 次
      let r = await post(`/api/input?project=${meta.id}`, { text: t.text });
      for (let retry = 0; retry < 2; retry++) {
        const ok = String(r.reply ?? "").trim() && !String(r.reply).startsWith("（这轮模型网关没走通");
        if (ok) break;
        console.log(`  [${t.label}] 网关限流/空回复，45s 后重试（第 ${retry + 1} 次）…`);
        await new Promise(res => setTimeout(res, 45_000));
        r = await post(`/api/input?project=${meta.id}`, { text: t.text });
      }
      const row = {
        label: t.label, input: t.text, secs: Math.round((Date.now() - t0) / 1000),
        reply: String(r.reply ?? "").slice(0, 600), stats: tripStats(r.trip),
      };
      rec.turns.push(row);
      console.log(`  [${t.label}] ${row.secs}s | ${row.reply.replace(/\n/g, " ").slice(0, 100)}…`);
      console.log(`    stats: ${JSON.stringify(row.stats)}`);
    } catch (e) {
      rec.turns.push({ label: t.label, input: t.text, error: String(e) });
      console.error(`  [${t.label}] FAILED: ${e}`);
    }
  }
  results.push(rec);
  mkdirSync(join(import.meta.dirname, "out"), { recursive: true });
  writeFileSync(join(import.meta.dirname, `out/e2e-${Date.now()}.json`), JSON.stringify(results, null, 2));
}
console.log("\n全部完成，结果在 scripts/out/");
