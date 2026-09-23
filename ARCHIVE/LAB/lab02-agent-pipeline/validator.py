"""校验循环：代码规则（L0/L1 机械部分）+ Jev D7（语义部分）混合（SPEC §5）。

代码能判的用代码（时间重叠/锚点缺失/无悬挂/物理不可达），语义模糊的交 Jev。
"""
from __future__ import annotations

from models import Trip


def _to_min(hhmm: str | None) -> int | None:
    if not hhmm:
        return None
    try:
        h, m = hhmm.split(":")
        return int(h) * 60 + int(m)
    except ValueError:
        return None


def code_checks(trip: Trip) -> list[dict]:
    """返回问题列表 [{check, severity, msg, day?}]。"""
    issues = []

    # V1 时间连续性（日内重叠 / 顺序倒置）
    for day in range(1, trip.days + 1):
        evs = trip.day_events(day)
        prev_end = None
        prev_name = None
        for e in evs:
            tw = e.time_window or {}
            s, en = _to_min(tw.get("start")), _to_min(tw.get("end"))
            if s is not None and en is not None and en < s and len(e.day_refs) == 1:
                issues.append({"check": "V1", "severity": "fail", "day": day,
                               "msg": f"{e.note or e.kind}: 结束早于开始 ({tw.get('start')}–{tw.get('end')})"})
            if prev_end is not None and s is not None and s < prev_end:
                issues.append({"check": "V1", "severity": "fail", "day": day,
                               "msg": f"与上一项「{prev_name}」时间重叠"})
            if en is not None:
                prev_end, prev_name = en, e.note or e.kind

    # V4 无悬挂：Event 的 anchor_ref 必须存在
    for e in trip.events.values():
        pool = trip.nodes if e.anchor_kind == "node" else trip.edges
        if e.anchor_ref not in pool:
            issues.append({"check": "V4", "severity": "fail",
                           "msg": f"Event {e.event_id} 锚定到不存在的 {e.anchor_kind} {e.anchor_ref}"})

    # V5 锚点约束：每日最后一个 Event 应是 lodging/terminal 锚点
    for day in range(1, trip.days + 1):
        evs = trip.day_events(day)
        if not evs:
            continue
        last = evs[-1]
        node = trip.nodes.get(last.anchor_ref) if last.anchor_kind == "node" else None
        anchored = (last.kind == "lodging") or (node and node.anchor in ("lodging", "terminal"))
        if not anchored:
            issues.append({"check": "V5", "severity": "warn", "day": day,
                           "msg": f"Day{day} 收尾不是住宿/场站锚点（{last.note or last.kind}）"})

    # V6 物流可行性：transit Event 的 Edge 有耗时但超过当日剩余可用时间的极端情况
    for e in trip.events.values():
        if e.kind != "transit" or e.anchor_kind != "edge":
            continue
        edge = trip.edges.get(e.anchor_ref)
        if edge and edge.duration_s and edge.duration_s > 14 * 3600:
            issues.append({"check": "V6", "severity": "warn",
                           "msg": f"路段 {edge.from_id}->{edge.to_id} 驾车耗时 {edge.duration_s/3600:.1f}h，单日可行性存疑"})
        if edge and edge.data_source == "empty":
            issues.append({"check": "V6", "severity": "info",
                           "msg": f"路段 {edge.mode} 无数据源（{edge.from_id}->{edge.to_id}），已留空待回填"})

    # V7 checklist 覆盖：lodging 类 Event 是否有对应预订项
    lodging_events = [e for e in trip.events.values() if e.kind == "lodging"]
    booking_titles = " ".join(c.title for c in trip.checklist.values())
    for e in lodging_events:
        name = (trip.nodes.get(e.anchor_ref).name
                if e.anchor_kind == "node" and e.anchor_ref in trip.nodes else e.note)
        if name and name[:4] not in booking_titles and "酒店" not in booking_titles and "住宿" not in booking_titles:
            issues.append({"check": "V7", "severity": "warn",
                           "msg": f"住宿「{name}」可能缺少对应预订 checklist 项"})
    return issues


def merge_reports(code_issues: list[dict], jev_report: dict) -> dict:
    """合成最终校验报告。Jev 的 fail 与代码 fail 都阻断（需修复/确认）。"""
    blocking = [i for i in code_issues if i["severity"] == "fail"]
    jev_fails = [k for k, v in jev_report.items()
                 if not k.endswith("_prob") and v == "fail"]
    return {
        "pass": not blocking and not jev_fails,
        "code_issues": code_issues,
        "jev": jev_report,
        "jev_fails": jev_fails,
        "summary": f"代码 {len(blocking)} 个阻断 / Jev {len(jev_fails)} 个不通过",
    }
