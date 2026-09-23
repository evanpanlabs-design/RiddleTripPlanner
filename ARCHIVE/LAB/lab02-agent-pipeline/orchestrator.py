"""Orchestrator：SPEC §4 主循环的单 Agent 实现。

输入一轮用户文本 → D1 意图 → 分发处理 → D3 阶段流转 → D5 澄清 → 输出响应。
生成类动作前自动 store.snapshot()，支持 I8 回滚。
"""
from __future__ import annotations

import json

import questions as Q
from amap_tools import search_poi, build_edge
from jev_client import JevClient
from models import (Trip, Node, Edge, Event, CandidateItem, ChecklistItem,
                    trip_summary)
from planner import Planner
from store import Store
from validator import code_checks, merge_reports


def plan_desc(trip: Trip) -> str:
    """把 Trip 转成给 Jev D7 审阅的自然语言描述。"""
    lines = [f"共{trip.days}天，目的地：{'、'.join(trip.destination) or '未定'}"]
    for day in range(1, trip.days + 1):
        evs = trip.day_events(day)
        parts = []
        for e in evs:
            tw = e.time_window or {}
            span = f"{tw.get('start','?')}–{tw.get('end','?')}" if tw else "时间未定"
            name = e.note
            if e.anchor_kind == "node" and e.anchor_ref in trip.nodes:
                name = trip.nodes[e.anchor_ref].name
            elif e.anchor_kind == "edge" and e.anchor_ref in trip.edges:
                ed = trip.edges[e.anchor_ref]
                fn = trip.nodes.get(ed.from_id); tn = trip.nodes.get(ed.to_id)
                name = f"{fn.name if fn else '?'}→{tn.name if tn else '?'}({ed.mode})"
            parts.append(f"{span} {e.kind}:{name}")
        lines.append(f"Day{day}: " + "；".join(parts))
    if trip.checklist:
        items = "、".join(f"{c.title}({'已办' if c.done else '待办'})"
                          for c in trip.checklist.values())
        lines.append(f"准备清单：{items}")
    return "\n".join(lines)


class Orchestrator:
    def __init__(self, trip: Trip | None = None):
        self.trip = trip or Trip()
        self.store = Store(self.trip)
        self.jev = JevClient()
        self.planner = Planner()
        self.materials: list[str] = []

    # ================= 主入口 =================
    def on_user_input(self, text: str) -> dict:
        summary = trip_summary(self.trip)
        d1 = self.jev.d1_intents(text, summary)
        intents = d1["intents"]
        resp = {"intents": intents, "raw_intents": d1["raw"],
                "actions": [], "questions": [], "stage": None}

        # 按优先级分发（I8 元操作最优先，I4 变更次之）
        if "I8" in intents:
            self._handle_i8(resp)
        if "I3" in intents or "I7" in intents:
            self._handle_slots(text, resp)
        if "I1" in intents:
            self._handle_material(text, resp)
        if "I4" in intents:
            self._handle_change(text, resp)
        if "I5" in intents or "I6" in intents:
            self._handle_confirm(text, resp)
        if "I2" in intents and not resp["actions"]:
            self._handle_explore(text, resp)
        # 兜底：意图未命中且无任何动作——若已有目的地槽位但尚无方案，视为生成请求
        if not resp["actions"] and not intents:
            if self.planner.available and not self.trip.events and (
                    self.trip.destination or self.trip.slots.get("destination")):
                resp["actions"].append("意图未分类，按生成方案请求处理")
                self.generate_plan(resp)

        # D3 阶段流转（机械）
        gate = self.trip.gate_report()
        old_stage, self.trip.stage = self.trip.stage, gate["stage"]
        if gate["gate_pass"]:
            resp["actions"].append(f"阶段流转：{old_stage} → {self.trip.stage}")
        resp["stage"] = self.trip.stage
        resp["gate_missing"] = gate["missing"]

        # D5 澄清选题
        missing = [{"slot": s, "why_blocking": w} for s, w in self._missing_slots()]
        if missing and self.trip.stage == "explore":
            nxt = self.jev.d5_next_question(missing, trip_summary(self.trip))
            if nxt:
                resp["questions"].append(self._slot_question(nxt))

        self.store.save()
        return resp

    # ================= 各意图处理 =================
    def _handle_slots(self, text: str, resp: dict):
        old = json.loads(json.dumps(self.trip.slots))
        # 枚举槽位走 Jev Choice
        for slot, r in self.jev.d2_enum_slots(text).items():
            self.trip.slots[slot] = r["value"]
            resp["actions"].append(f"槽位 {slot} = {r['value']}（Jev {r['confidence']:.2f}）")
        # 自由槽位：LLM 抽 + Jev Noul 复核（L1 双保险）
        if self.planner.available:
            for slot, value in self.planner.extract_free_slots(text).items():
                if slot == "duration_days":   # 天数无歧义，直接采纳
                    try:
                        self.trip.days = max(self.trip.days, int(value))
                        resp["actions"].append(f"天数 = {value}")
                    except (TypeError, ValueError):
                        pass
                    continue
                p = self.jev.d2_verify_free_slot(text, slot, value)
                if p >= Q.TH["slot_accept"]:
                    if slot == "destination" and isinstance(value, list):
                        self.trip.destination = value
                    self.trip.slots[slot] = value
                    if slot == "date_range" and isinstance(value, dict):
                        self._apply_days(value)
                    resp["actions"].append(f"槽位 {slot} = {value}（复核 {p:.2f}）")
        if old != self.trip.slots:
            self.store.log("slot_update", {"slots": self.trip.slots},
                           {"kind": "restore_slots", "slots": old})
        # T3：关键槽位冲突需显式确认（demo 里记录提示）
        resp.setdefault("notices", [])

    def _handle_material(self, text: str, resp: dict):
        self.materials.append(text)
        if self.planner.available:
            parsed = self.planner.parse_material(text)
            for poi in parsed.get("pois", []):
                item = CandidateItem(name=poi["name"], source_material=poi.get("hint", ""))
                self.trip.candidate_pool[item.item_id] = item
            resp["actions"].append(
                f"素材入池：{len(parsed.get('pois', []))} 个候选点位，"
                f"{len(parsed.get('facts', []))} 条事实，{len(parsed.get('constraints', []))} 条约束")
            # 素材里的约束也走槽位
            for c in parsed.get("constraints", []):
                if c.get("value") and c.get("slot") in self.trip.slots:
                    self.trip.slots[c["slot"]] = c["value"]
            self.store.log("material_ingest", {"parsed": parsed},
                           {"kind": "remove_entities",
                            "entities": [("candidate_pool", k) for k in
                                         list(self.trip.candidate_pool)[-len(parsed.get('pois', [])):]]},
                           {"intent": "I1"})
        else:
            resp["actions"].append("素材已记录（LLM 未配置，跳过解析）")

    def _handle_change(self, text: str, resp: dict):
        if not self.planner.available:
            resp["actions"].append("变更已收到（LLM 未配置，无法自动修订）")
            return
        if not self.trip.events:
            # 尚无方案 → 视为生成请求
            self.generate_plan(resp)
            return
        # D6 传播半径
        d6 = self.jev.d6_radius(text, trip_summary(self.trip))
        resp["actions"].append(f"传播半径 {d6['radius']}（Jev {d6['confidence']:.2f}"
                               f"{'，自动执行' if d6['auto_apply'] else '，低置信→需用户确认'}）")
        if not d6["auto_apply"]:
            resp["questions"].append(f"这次变更可能影响{d6['radius']}范围，确认按此调整吗？")
            return
        self.store.snapshot("revise", {"op": text, "radius": d6["radius"]})
        feedback = ""
        for attempt in range(2):
            draft = self.planner.revise_plan(trip_summary(self.trip), text, d6["radius"], feedback)
            report = self._apply_and_validate(draft)
            if report["pass"]:
                resp["actions"].append(f"方案已修订（第 {attempt+1} 次通过校验）")
                break
            feedback = self._feedback_of(report)
        else:
            resp["actions"].append("修订两次未通过校验，输出草稿与问题清单交用户裁决")
        resp["verify"] = report

    def _handle_confirm(self, text: str, resp: dict):
        # I5/I6 已过 0.8 高阈值（D1 内完成），直接执行锁定/勾选
        locked = 0
        for e in self.trip.events.values():
            if e.status == "tentative":
                e.status = "locked"; locked += 1
        done = 0
        for c in self.trip.checklist.values():
            if not c.done and any(k in text for k in c.title[:6].split()):
                c.done = True; done += 1
        if "都" in text or "全部" in text or not done:
            for c in self.trip.checklist.values():
                if not c.done:
                    c.done = True; done += 1
        resp["actions"].append(f"锁定 {locked} 个 Event，勾选 {done} 项 checklist")
        self.store.log("confirm", {"text": text},
                       {"kind": "restore_trip", "trip": json.loads(json.dumps(self.trip.to_dict()))},
                       {"intent": "I5/I6"})

    def _handle_explore(self, text: str, resp: dict):
        if self.planner.available:
            ans = self.planner.phrase("回答用户的探索性问题，结合当前旅行状态。"
                                      "如果候选池有相关点位就推荐，没有就给方向性建议并说明可以贴素材。",
                                      {"question": text, "trip": trip_summary(self.trip)})
            resp["actions"].append("explore 答复")
            resp["reply"] = ans
        else:
            resp["actions"].append("探索问题已收到（LLM 未配置）")

    def _handle_i8(self, resp: dict):
        rec = self.store.undo()
        resp["actions"].append(f"已回滚操作 #{rec['seq']}（{rec['op']}）" if rec else "无可回滚操作")

    # ================= 方案生成 =================
    def generate_plan(self, resp: dict | None = None) -> dict:
        resp = resp or {"actions": [], "questions": []}
        if not self.planner.available:
            resp["actions"].append("LLM 未配置，无法生成方案")
            return resp
        self.store.snapshot("gen_plan")
        materials = "\n\n---\n\n".join(self.materials[-5:])
        feedback = ""
        report = None
        for attempt in range(2):
            draft = self.planner.gen_plan(trip_summary(self.trip), materials, feedback)
            report = self._apply_and_validate(draft)
            if report["pass"]:
                resp["actions"].append(f"方案已生成（第 {attempt+1} 次通过校验）")
                break
            feedback = self._feedback_of(report)
        else:
            resp["actions"].append("生成两次未完全通过校验，保留草稿并列出问题")
        resp["verify"] = report
        self.trip.apply_stage()
        self.store.save()
        return resp

    # ================= 草案落图 =================
    def _apply_and_validate(self, draft: dict) -> dict:
        self._apply_draft(draft)
        issues = code_checks(self.trip)
        jev_report = self.jev.d7_verify(plan_desc(self.trip))
        return merge_reports(issues, jev_report)

    def _apply_draft(self, draft: dict):
        """把 Planner 的 JSON 草案落到 Trip 图。事务式：先建临时图，全部成功才交换，失败保留旧图。"""
        days = draft.get("days", [])
        new_nodes, new_edges, new_events, new_checklist = {}, {}, {}, {}
        name2node: dict[str, Node] = {}

        def ensure_node(name: str, anchor: str = "none") -> Node:
            if name in name2node:
                n = name2node[name]
                if anchor != "none":
                    n.anchor = anchor
                return n
            n = Node(name=name, anchor=anchor)
            try:
                info = search_poi(name, (self.trip.destination or [None])[0])
            except Exception:
                info = None  # 高德失败 → 降级：Node 无 geo，后续 Edge 走 empty（SPEC §9）
            if info:
                n.amap_poi_id = info["amap_poi_id"]; n.geo = info["geo"]
                n.category_tags = info["category_tags"]; n.opening_hours = info["opening_hours"]
            new_nodes[n.node_id] = n
            name2node[name] = n
            return n

        for d in days:
            day = d.get("day", 0)
            prev_item = None
            for it in d.get("items", []):
                tw = {"start": it.get("start"), "end": it.get("end"),
                      "source": it.get("time_source", "blank")}
                if it.get("type") == "transit":
                    fn = ensure_node(it.get("from") or (prev_item or {}).get("name", "未知"))
                    tn = ensure_node(it.get("to") or "未知")
                    mode = it.get("mode") or "drive"
                    e = Edge(from_id=fn.node_id, to_id=tn.node_id, mode=mode)
                    try:
                        e.__dict__.update({k: v for k, v in build_edge(fn, tn, mode).items()
                                           if k in ("distance_m", "duration_s", "data_source", "geometry")})
                    except Exception:
                        e.data_source = "empty"  # 降级留空
                    new_edges[e.edge_id] = e
                    ev = Event(anchor_kind="edge", anchor_ref=e.edge_id, kind="transit",
                               day_refs=[day], time_window=tw,
                               note=f"{fn.name}→{tn.name}（{mode}）", cost=it.get("cost"))
                    new_events[ev.event_id] = ev
                else:
                    anchor = {"lodging": "lodging", "terminal": "terminal"}.get(it.get("type"), "none")
                    n = ensure_node(it["name"], anchor)
                    kind = {"lodging": "lodging", "terminal": "transit"}.get(it.get("type"), "visit")
                    ev = Event(anchor_kind="node", anchor_ref=n.node_id, kind=kind,
                               day_refs=[day], time_window=tw,
                               note=it.get("note", ""), cost=it.get("cost"))
                    new_events[ev.event_id] = ev
                prev_item = it
            # 跨日 lodging：若当天 lodging 的 end 为次日早晨，标记跨日（C11）——demo 简化为当日即可
        for c in draft.get("checklist", []):
            item = ChecklistItem(title=c["title"], category=c.get("category", "item"),
                                 info_spec=c.get("info_spec"),
                                 due_offset_days=c.get("due_offset_days"))
            new_checklist[item.item_id] = item
        # 全部构建成功 → 一次性交换（事务提交）；天数若已定（date_range）不被草案撑大
        self.trip.nodes, self.trip.edges = new_nodes, new_edges
        self.trip.events, self.trip.checklist = new_events, new_checklist
        if not self.trip.days:
            self.trip.days = len(days)

    # ================= 辅助 =================
    def _apply_days(self, date_range: dict):
        from datetime import date
        try:
            s = date.fromisoformat(date_range["start"]); e = date.fromisoformat(date_range["end"])
            self.trip.days = max(self.trip.days, (e - s).days + 1)
        except (KeyError, ValueError):
            pass

    def _missing_slots(self) -> list[tuple[str, str]]:
        out = []
        if not self.trip.destination and not self.trip.slots.get("destination"):
            out.append(("destination", "没有目的地无法生成任何方案"))
        if not self.trip.slots.get("date_range") and not self.trip.days:
            out.append(("date_range", "没有日期/天数无法排日程"))
        if not self.trip.slots.get("origin"):
            out.append(("origin", "不知道出发地，首日大交通无法安排"))
        if not self.trip.slots.get("pace"):
            out.append(("pace", "节奏影响每日点位密度"))
        return out

    @staticmethod
    def _slot_question(slot: str) -> str:
        return {"destination": "这次想去哪里？（可以是城市、景区或一个方向）",
                "date_range": "大概什么时候出发、玩几天？",
                "origin": "从哪里出发？",
                "pace": "想要休闲一点还是紧凑一点？"}.get(slot, f"能说说 {slot} 吗？")

    @staticmethod
    def _feedback_of(report: dict) -> str:
        lines = [i["msg"] for i in report["code_issues"] if i["severity"] == "fail"]
        lines += [f"{k} 未通过" for k in report["jev_fails"]]
        return "\n".join(lines) or json.dumps(report["jev"], ensure_ascii=False)
