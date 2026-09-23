"""持久化 + event sourcing 操作日志（C8/Q8）。

- Trip 全量快照：runs/<trip_id>/trip.json
- 操作日志：runs/<trip_id>/ops.jsonl（每次 mutation 追加一条，含撤销所需的逆操作数据）
- undo()：按日志反向应用，实现回滚。
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from models import Trip

RUNS = Path(__file__).parent / "runs"


class Store:
    def __init__(self, trip: Trip):
        self.trip = trip
        self.dir = RUNS / trip.trip_id
        self.dir.mkdir(parents=True, exist_ok=True)
        self.ops_path = self.dir / "ops.jsonl"
        self._applied: list[dict] = []
        if self.ops_path.exists():
            self._applied = [json.loads(l) for l in self.ops_path.read_text().splitlines() if l.strip()]

    # ---------- 快照 ----------
    def save(self):
        (self.dir / "trip.json").write_text(
            json.dumps(self.trip.to_dict(), ensure_ascii=False, indent=2))

    @staticmethod
    def load(trip_id: str) -> "Store":
        d = RUNS / trip_id
        return Store(Trip.from_dict(json.loads((d / "trip.json").read_text())))

    # ---------- 操作日志 ----------
    def log(self, op: str, payload: dict, undo_payload: dict, meta: dict | None = None):
        rec = {"seq": len(self._applied) + 1, "ts": time.time(), "op": op,
               "payload": payload, "undo": undo_payload, "meta": meta or {}}
        with self.ops_path.open("a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        self._applied.append(rec)
        self.save()

    def undo(self) -> dict | None:
        """回滚最近一条操作。返回被回滚的记录。"""
        if not self._applied:
            return None
        rec = self._applied.pop()
        u = rec["undo"]
        kind = u.get("kind")
        if kind == "restore_slots":
            self.trip.slots = u["slots"]
        elif kind == "restore_trip":
            self.trip = Trip.from_dict(u["trip"])
        elif kind == "remove_entities":
            for coll, key in u.get("entities", []):
                getattr(self.trip, coll).pop(key, None)
        # 截断日志文件
        self.ops_path.write_text(
            "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in self._applied))
        self.trip.apply_stage()
        self.save()
        return rec

    # ---------- 便捷快照型 mutation（生成/大改前调用） ----------
    def snapshot(self, op: str, meta: dict | None = None):
        self.log(op, {}, {"kind": "restore_trip", "trip": self.trip.to_dict()}, meta)
