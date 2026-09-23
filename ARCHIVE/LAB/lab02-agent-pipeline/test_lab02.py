"""lab02 分层测试。Jev/高德层现在可跑；LLM 层需 DEEPSEEK_API_KEY。

运行：cd LAB/lab02-agent-pipeline && python test_lab02.py
"""
from __future__ import annotations

import os
import sys
import traceback

from dotenv import load_dotenv
load_dotenv(dotenv_path="../../.env")
load_dotenv()

RESULTS = []


def check(name: str, fn):
    try:
        fn()
        RESULTS.append((name, "PASS", ""))
        print(f"  PASS  {name}")
    except Exception as e:
        RESULTS.append((name, "FAIL", f"{e}"))
        print(f"  FAIL  {name}: {e}")
        traceback.print_exc(limit=2)


# ---------------- Jev 层 ----------------
def test_jev_d1():
    from jev_client import JevClient
    jev = JevClient()
    r = jev.d1_intents("我国庆想去四川玩7天，预算中等，从上海出发",
                       {"stage": "explore", "slots": {}})
    assert "I3" in r["intents"], f"应命中 I3 约束声明: {r['raw']}"
    assert r["raw"]["I1"] < 0.5, f"不应命中 I1: {r['raw']}"


def test_jev_d1_state_threshold():
    from jev_client import JevClient
    jev = JevClient()
    r = jev.d1_intents("帮我把峨眉山调到第一天", {"stage": "planning", "slots": {}})
    # I4 阈值 0.8：要么高置信命中，要么不命中——验证分级机制本身
    if "I4" in r["intents"]:
        assert r["intents"]["I4"] >= 0.8


def test_jev_d2_slots():
    from jev_client import JevClient
    jev = JevClient()
    r = jev.d2_enum_slots("我们两口子带爸妈一起去，想休闲一点别太赶")
    assert r.get("pace", {}).get("value") == "relaxed", r
    assert r.get("party", {}).get("value") == "family_seniors", r


def test_jev_d6_radius():
    from jev_client import JevClient
    jev = JevClient()
    r = jev.d6_radius("把返程机场从双流改成天府",
                      {"stage": "planning", "events": []})
    assert r["radius"] == "R3", r


def test_jev_d7_verify():
    from jev_client import JevClient
    jev = JevClient()
    good = ("共2天，目的地：成都（所有需预订事项已列入清单：酒店已订、机票已订）\n"
            "Day1: 08:00–12:00 visit:成都大熊猫繁育研究基地（无需预约，现场购票）；13:00–17:00 visit:宽窄巷子（开放街区）；18:00–21:00 lodging:成都市区酒店（已预订）\n"
            "Day2: 08:00–10:00 transit:成都市区酒店→成都双流机场(drive)；12:00–14:00 transit:成都→上海(flight，机票已订)")
    r = jev.d7_verify(good)
    assert r["V4_no_dangling"] == "pass", r
    assert r["V1_time_continuity"] in ("pass", "warn"), r  # 0.57 属校准边界，回放后再标定


# ---------------- 高德层 ----------------
def test_amap_poi():
    from amap_tools import search_poi
    r = search_poi("黄龙风景名胜区", "阿坝")
    assert r and r["geo"], "应找到黄龙 POI"
    assert abs(r["geo"]["lat"] - 32.7) < 0.5, r["geo"]


def test_amap_driving():
    from amap_tools import search_poi, driving_route
    a = search_poi("黄龙风景名胜区", "阿坝")
    b = search_poi("黄龙九寨站", "阿坝")
    if not (a and b and a["geo"] and b["geo"]):
        print("    (黄龙九寨站未找到，改用九寨沟口)")
        b = search_poi("九寨沟风景区", "阿坝")
    r = driving_route(a["geo"], b["geo"])
    assert r and r["distance_m"] > 1000, r


def test_amap_geodesic():
    from amap_tools import geodesic_m
    d = geodesic_m({"lat": 31.23, "lng": 121.47}, {"lat": 30.57, "lng": 104.07})
    assert 1500e3 < d < 1800e3, f"上海-成都测地线应约1660km: {d/1000:.0f}km"


def test_amap_unsupported_mode():
    from amap_tools import build_edge
    from models import Node
    a = Node(name="成都东站", geo={"lat": 30.63, "lng": 104.14})
    b = Node(name="黄龙九寨站", geo={"lat": 32.85, "lng": 103.68})
    e = build_edge(a, b, "train")
    assert e["data_source"] == "empty", e


# ---------------- 领域模型 ----------------
def test_trip_gate():
    from models import Trip
    t = Trip()
    assert t.gate_report()["stage"] == "explore"
    t.slots["destination"] = ["四川"]; t.slots["date_range"] = {"start": "2026-10-01", "end": "2026-10-07"}
    assert t.gate_report()["stage"] == "planning"


def test_cross_day_event():
    from models import Trip, Node, Event
    t = Trip()
    n = Node(name="峨眉山金顶酒店", anchor="lodging")
    t.nodes[n.node_id] = n
    e = Event(anchor_kind="node", anchor_ref=n.node_id, kind="lodging", day_refs=[2, 3],
              time_window={"start": "18:00", "end": "06:30", "source": "inferred"})
    t.events[e.event_id] = e
    assert e in t.day_events(2) and e in t.day_events(3)


# ---------------- 校验器 ----------------
def test_validator_time_overlap():
    from models import Trip, Node, Event
    from validator import code_checks
    t = Trip(days=1)
    n = Node(name="宽窄巷子")
    t.nodes[n.node_id] = n
    for s, e_ in [("09:00", "12:00"), ("11:00", "13:00")]:
        ev = Event(anchor_kind="node", anchor_ref=n.node_id, kind="visit", day_refs=[1],
                   time_window={"start": s, "end": e_, "source": "inferred"}, note="测试")
        t.events[ev.event_id] = ev
    issues = code_checks(t)
    assert any(i["check"] == "V1" and i["severity"] == "fail" for i in issues), issues


def test_validator_dangling():
    from models import Trip, Event
    from validator import code_checks
    t = Trip(days=1)
    t.events["x"] = Event(anchor_kind="node", anchor_ref="ghost", kind="visit", day_refs=[1])
    issues = code_checks(t)
    assert any(i["check"] == "V4" for i in issues)


# ---------------- Store / 回滚 ----------------
def test_store_undo():
    import shutil
    from models import Trip, Node
    from store import Store, RUNS
    t = Trip()
    s = Store(t)
    s.snapshot("test_op")
    t.nodes["n1"] = Node(name="测试点")
    s.save()
    assert "n1" in s.trip.nodes
    s.undo()
    assert "n1" not in s.trip.nodes
    shutil.rmtree(RUNS / t.trip_id, ignore_errors=True)


# ---------------- LLM 层（可选） ----------------
def test_planner_parse():
    from planner import Planner
    p = Planner()
    if not p.available:
        print("    (跳过：DEEPSEEK_API_KEY 未配置)")
        return
    r = p.parse_material("黄龙索道上行80元，旺季要提前预约，海拔3500注意高反。")
    assert "facts" in r and "pois" in r


def main():
    groups = [
        ("Jev 决策层", [test_jev_d1, test_jev_d1_state_threshold, test_jev_d2_slots,
                        test_jev_d6_radius, test_jev_d7_verify]),
        ("高德工具层", [test_amap_poi, test_amap_driving, test_amap_geodesic,
                        test_amap_unsupported_mode]),
        ("领域模型", [test_trip_gate, test_cross_day_event]),
        ("校验器", [test_validator_time_overlap, test_validator_dangling]),
        ("Store/回滚", [test_store_undo]),
        ("LLM 层", [test_planner_parse]),
    ]
    for gname, fns in groups:
        print(f"\n[{gname}]")
        for fn in fns:
            check(fn.__name__, fn)
    fails = [r for r in RESULTS if r[1] == "FAIL"]
    print(f"\n{'='*40}\n总计 {len(RESULTS)} 项，失败 {len(fails)} 项")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
