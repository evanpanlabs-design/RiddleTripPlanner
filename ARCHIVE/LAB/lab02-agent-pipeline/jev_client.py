"""Jev 客户端：D1–D7 决策点（KB/jev/README.md 的工程实现）。"""
from __future__ import annotations

import os
import requests

import questions as Q


class JevClient:
    def __init__(self, api_key: str | None = None, base_url: str | None = None, timeout: int = 20):
        self.api_key = api_key or os.environ["JEV_API_KEY"]
        self.base_url = (base_url or os.environ.get("JEV_BASE_URL")
                         or "https://api.typesafe.ai/v1").rstrip("/")
        self.timeout = timeout

    def ask(self, state: dict, questions: dict) -> dict:
        """一次调用并行评估所有问题。返回 {qid: answer}。"""
        resp = requests.post(
            f"{self.base_url}/systemone",
            headers={"Authorization": f"Bearer {self.api_key}",
                     "Content-Type": "application/json"},
            json={"state": state, "model": Q.MODEL, "questions": questions},
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()["answers"]

    # ---------- D1 意图分类（多标签） ----------
    def d1_intents(self, user_input: str, trip_summary: dict) -> dict:
        answers = self.ask({"user_input": user_input, "trip_summary": trip_summary},
                           Q.d1_intent_questions())
        hit = {}
        for qid, ans in answers.items():
            intent = qid.replace("intent_", "").upper()
            th = Q.TH["intent_state"] if intent in Q.STATE_CHANGE_INTENTS else Q.TH["intent_info"]
            if ans["noul"] >= th:
                hit[intent] = ans["noul"]
        return {"intents": hit,
                "raw": {qid.replace("intent_", "").upper(): a["noul"] for qid, a in answers.items()}}

    # ---------- D2 枚举型槽位 ----------
    def d2_enum_slots(self, user_input: str) -> dict:
        answers = self.ask({"user_input": user_input}, Q.d2_slot_questions())
        out = {}
        for qid, ans in answers.items():
            slot = qid.replace("slot_", "")
            if ans["choice"] != "none" and ans["confidence"] >= Q.TH["slot_accept"]:
                out[slot] = {"value": ans["choice"], "confidence": ans["confidence"],
                             "probabilities": ans["probabilities"]}
        return out

    def d2_verify_free_slot(self, user_input: str, slot_name: str, value) -> float:
        answers = self.ask({"user_input": user_input},
                           Q.d2_slot_verify_question(slot_name, value))
        return answers[f"slot_verify_{slot_name}"]["noul"]

    # ---------- D4 指代消解 ----------
    def d4_disambiguate(self, mention: str, candidates: list, trip_summary: dict) -> dict:
        if not candidates:
            return {"entity_id": None, "confidence": 0.0}
        answers = self.ask({"user_input": mention, "candidates": candidates,
                            "trip_summary": trip_summary},
                           Q.d4_disambiguate_question(mention, candidates))
        ans = answers["disambiguate"]
        entity = None if ans["choice"] == "none_of_above" else ans["choice"]
        confident = ans["confidence"] >= Q.TH["disambiguate"]
        return {"entity_id": entity if confident else None,
                "confidence": ans["confidence"],
                "candidates": ans["probabilities"] if not confident else None}

    # ---------- D5 澄清选题 ----------
    def d5_next_question(self, missing: list, trip_summary: dict) -> str | None:
        if not missing:
            return None
        answers = self.ask({"trip_summary": trip_summary,
                            "missing_slots": missing},
                           Q.d5_next_question_question(missing))
        ans = answers["next_question"]
        return None if ans["choice"] == "no_need" else ans["choice"]

    # ---------- D6 传播半径 ----------
    def d6_radius(self, op_desc: str, trip_summary: dict) -> dict:
        answers = self.ask({"operation": op_desc, "trip_summary": trip_summary},
                           Q.d6_radius_question(op_desc))
        ans = answers["propagation_radius"]
        return {"radius": ans["choice"], "confidence": ans["confidence"],
                "auto_apply": ans["confidence"] >= Q.TH["radius_auto"],
                "probabilities": ans["probabilities"]}

    # ---------- D7 语义闭环校验 ----------
    def d7_verify(self, plan_desc: str) -> dict:
        answers = self.ask({"plan": plan_desc}, Q.d7_verify_questions(plan_desc))
        report = {}
        for qid, ans in answers.items():
            p = ans["noul"]
            report[qid] = "pass" if p >= Q.TH["verify_pass"] else ("warn" if p >= 0.35 else "fail")
            report[qid + "_prob"] = p
        return report
