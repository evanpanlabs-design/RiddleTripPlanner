"""Riddle 领域模型（SPEC §2 的 Python 实现）。

约定：
- 无悬挂约束只作用于 Trip.graph（方案图）；候选池 CandidateItem 不受约束（C5）。
- Edge.data_source: amap_drive / amap_geodesic / user_filled / empty（P2）。
- Event.status: candidate / tentative / locked。
- 阶段: explore / planning / preparing / ready（机械检查自动流转，T2）。
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import Optional

STAGES = ["explore", "planning", "preparing", "ready"]
EDGE_MODES = ["flight", "train", "metro", "drive", "bus", "cycle", "walk"]
# 高德无源的方式（P2）：留空待用户回填
AMAP_UNSUPPORTED_MODES = {"flight", "train"}


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


@dataclass
class Node:
    name: str
    type: str = "poi"                      # poi | aoi
    node_id: str = field(default_factory=lambda: new_id("node"))
    amap_poi_id: Optional[str] = None
    category_tags: list = field(default_factory=list)
    geo: Optional[dict] = None             # {"lat":..,"lng":..}
    opening_hours: Optional[dict] = None   # {"daily":..,"weekly":..,"source":..,"fetched_at":..}
    anchor: str = "none"                   # none | lodging | terminal（C6）


@dataclass
class Edge:
    from_id: str
    to_id: str
    mode: str                              # EDGE_MODES
    edge_id: str = field(default_factory=lambda: new_id("edge"))
    geometry: list = field(default_factory=list)
    distance_m: Optional[float] = None
    duration_s: Optional[float] = None
    data_source: str = "empty"             # amap_drive|amap_geodesic|user_filled|empty


@dataclass
class Event:
    anchor_kind: str                       # node | edge
    anchor_ref: str
    kind: str                              # visit|dine|consume|transit|lodging
    event_id: str = field(default_factory=lambda: new_id("evt"))
    day_refs: list = field(default_factory=list)   # [1] 或跨日 [t, t+1]（C11）
    time_window: Optional[dict] = None     # {"start":"HH:mm","end":"HH:mm","source":..}
    cost: Optional[float] = None           # C1
    status: str = "tentative"
    note: str = ""


@dataclass
class CandidateItem:
    name: str
    source_material: str = ""
    item_id: str = field(default_factory=lambda: new_id("cand"))
    amap_poi_id: Optional[str] = None
    status: str = "pooled"                 # pooled | promoted | discarded
    eval_score: Optional[float] = None


@dataclass
class ChecklistItem:
    title: str
    category: str                          # booking | item | info（M3）
    item_id: str = field(default_factory=lambda: new_id("chk"))
    due_offset_days: Optional[int] = None  # 相对出发日
    exec_mode: str = "manual"              # api | deeplink | manual
    info_spec: Optional[dict] = None       # info 类三要素 {what,expect,impact}
    linked_entity: Optional[str] = None
    done: bool = False


@dataclass
class Trip:
    destination: list = field(default_factory=list)
    trip_id: str = field(default_factory=lambda: new_id("trip"))
    stage: str = "explore"
    slots: dict = field(default_factory=lambda: {
        "destination": [], "date_range": None, "origin": None,
        "budget_band": None, "party": None, "pace": None,
        "interests": [], "stay_pref": None,
    })
    nodes: dict = field(default_factory=dict)      # node_id -> Node
    edges: dict = field(default_factory=dict)      # edge_id -> Edge
    events: dict = field(default_factory=dict)     # event_id -> Event
    candidate_pool: dict = field(default_factory=dict)
    checklist: dict = field(default_factory=dict)
    days: int = 0

    # ---------- 阶段门槛（D3 机械检查，T2 自动流转） ----------
    def gate_report(self) -> dict:
        missing = []
        if not self.slots.get("destination") and not self.destination:
            missing.append("S1_destination")
        if not self.slots.get("date_range") and not self.days:
            missing.append("S2_date_range")
        stage = "explore"
        if not missing:
            stage = "planning"
            # planning -> preparing：图完整（有事件、无 tentative 待定、每日有住宿锚点）
            tentatives = [e for e in self.events.values() if e.status == "tentative"]
            if self.events and not tentatives:
                stage = "preparing"
                # preparing -> ready：checklist 全勾（或为空）
                if all(c.done for c in self.checklist.values()) and self.checklist:
                    stage = "ready"
        return {"stage": stage, "gate_pass": stage != self.stage, "missing": missing}

    def apply_stage(self) -> str:
        self.stage = self.gate_report()["stage"]
        return self.stage

    def day_events(self, day: int) -> list:
        evs = [e for e in self.events.values() if day in e.day_refs]
        return sorted(evs, key=lambda e: (e.time_window or {}).get("start", "99:99"))

    def to_dict(self) -> dict:
        d = asdict(self)
        return d

    @staticmethod
    def from_dict(d: dict) -> "Trip":
        t = Trip()
        t.trip_id = d["trip_id"]; t.stage = d["stage"]; t.slots = d["slots"]
        t.destination = d.get("destination", []); t.days = d.get("days", 0)
        t.nodes = {k: Node(**v) for k, v in d.get("nodes", {}).items()}
        t.edges = {k: Edge(**v) for k, v in d.get("edges", {}).items()}
        t.events = {k: Event(**v) for k, v in d.get("events", {}).items()}
        t.candidate_pool = {k: CandidateItem(**v) for k, v in d.get("candidate_pool", {}).items()}
        t.checklist = {k: ChecklistItem(**v) for k, v in d.get("checklist", {}).items()}
        return t


def trip_summary(t: Trip) -> dict:
    """给 Jev / LLM 的紧凑状态摘要（KB/jev：state 只给所需上下文）。"""
    return {
        "stage": t.stage, "days": t.days,
        "slots": t.slots,
        "nodes": [{"id": n.node_id, "name": n.name, "anchor": n.anchor} for n in t.nodes.values()],
        "events": [{"id": e.event_id, "kind": e.kind, "days": e.day_refs,
                    "tw": e.time_window, "status": e.status,
                    "note": e.note[:80]} for e in t.events.values()],
        "candidate_pool": [{"id": c.item_id, "name": c.name, "status": c.status}
                           for c in t.candidate_pool.values()],
        "checklist_open": sum(1 for c in t.checklist.values() if not c.done),
    }
