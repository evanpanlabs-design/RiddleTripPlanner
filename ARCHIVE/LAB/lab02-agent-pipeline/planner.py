"""Planner：DeepSeek LLM 生成层（SPEC §4 生成职责）。

分工铁律：LLM 只做生成（L2 层）与自由文本抽取；所有判断/决策走 Jev。
OpenAI 兼容接口：POST {base}/chat/completions
"""
from __future__ import annotations

import json
import os
import re

import requests

SYSTEM_PLAN = """你是 Riddle 旅行规划引擎的 Planner。你只负责生成方案文本与结构化草案，所有判断由外部决策层完成。
输出必须是 JSON（不要 markdown 代码块之外的文字），schema：
{
  "days": [
    {"day": 1, "date": "YYYY-MM-DD 或 null", "theme": "当日主题",
     "items": [
       {"type": "poi|transit|lodging|terminal", "name": "名称",
        "start": "HH:mm 或 null", "end": "HH:mm 或 null",
        "mode": "flight|train|metro|drive|bus|cycle|walk 或 null",
        "from": "上一节点名(transit 时)", "to": "下一节点名(transit 时)",
        "note": "备注", "cost": 数字或null, "time_source": "inferred|user|blank"}
     ]}
  ],
  "checklist": [
    {"title": "事项", "category": "booking|item|info",
     "info_spec": {"what": "查什么", "expect": "预期查到什么", "impact": "对行程的指导"},
     "linked_name": "关联的点位/事件名 或 null", "due_offset_days": 相对出发日的天数 或 null}
  ]
}
规则：
- 天数必须严格等于旅行状态中给定的 days 值，不得自行加首尾缓冲日。
- 时间能根据常识/地理推理就推（time_source=inferred），推不出就 null（time_source=blank），绝不编造精确事实（如具体班次票价）。
- 每天以住宿或场站（机场/车站）收尾；第一天从场站或住宿开始。
- 跨日交通要成对出现（当天到下一站 或 次日早晨出发）。
- 海拔、路况等风险写进 note。"""

SYSTEM_PARSE = """你是 Riddle 的素材解析器。从用户粘贴的旅行素材中抽取结构化信息。
输出 JSON（不要额外文字）：
{"pois": [{"name": "点位名", "hint": "文中线索（游玩时长/门票/开放时间/交通）"}],
 "facts": [{"about": "点位名或行程", "fact": "事实内容", "kind": "time|price|traffic|ticket|other"}],
 "constraints": [{"slot": "date_range|origin|budget_band|party|pace|interests|stay_pref|destination",
                  "value": "抽取到的值"}]}
只抽文中明确出现的信息，没有就给空数组。"""


class Planner:
    def __init__(self, api_key: str | None = None, base_url: str | None = None,
                 model: str | None = None, timeout: int = 120):
        self.api_key = api_key or os.environ.get("DEEPSEEK_API_KEY", "")
        self.base_url = (base_url or os.environ.get("DEEPSEEK_BASE_URL")
                         or "https://api.deepseek.com").rstrip("/")
        self.model = model or os.environ.get("DEEPSEEK_MODEL") or "deepseek-chat"
        self.timeout = timeout

    @property
    def available(self) -> bool:
        return bool(self.api_key)

    def _chat(self, system: str, user: str, temperature: float = 0.3) -> str:
        if not self.available:
            raise RuntimeError("DEEPSEEK_API_KEY 未配置")
        resp = requests.post(
            f"{self.base_url}/chat/completions",
            headers={"Authorization": f"Bearer {self.api_key}",
                     "Content-Type": "application/json"},
            json={"model": self.model, "temperature": temperature,
                  "messages": [{"role": "system", "content": system},
                               {"role": "user", "content": user}]},
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]

    @staticmethod
    def _extract_json(text: str):
        m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
        raw = m.group(1) if m else text
        return json.loads(raw.strip())

    # ---------- 生成初版方案 ----------
    def gen_plan(self, trip_summary: dict, materials: str, feedback: str = "") -> dict:
        user = f"当前旅行状态：\n{json.dumps(trip_summary, ensure_ascii=False, indent=2)}\n\n"
        if materials:
            user += f"用户素材：\n{materials}\n\n"
        if feedback:
            user += f"上一版校验未通过的问题（必须修复）：\n{feedback}\n\n"
        user += "请生成完整方案 JSON。"
        return self._extract_json(self._chat(SYSTEM_PLAN, user))

    # ---------- 变更后修订 ----------
    def revise_plan(self, trip_summary: dict, op_desc: str, radius: str, feedback: str = "") -> dict:
        scope = {"R1": "只微调相邻 Event", "R2": "重排当天", "R3": "允许联动调整前后日"}[radius]
        user = (f"当前方案状态：\n{json.dumps(trip_summary, ensure_ascii=False, indent=2)}\n\n"
                f"用户要求的变更：{op_desc}\n修订范围约束：{scope}，其余部分保持不变。\n")
        if feedback:
            user += f"上一版校验问题（必须修复）：\n{feedback}\n"
        user += "请输出修订后的完整方案 JSON（同 schema）。"
        return self._extract_json(self._chat(SYSTEM_PLAN, user))

    # ---------- 素材解析 ----------
    def parse_material(self, text: str) -> dict:
        return self._extract_json(self._chat(SYSTEM_PARSE, text, temperature=0.1))

    # ---------- 面向用户的话术 ----------
    def phrase(self, instruction: str, context: dict) -> str:
        return self._chat("你是 Riddle 的口吻层：简洁、直接、像日记本回应主人。"
                          "只说该说的，不堆砌表情符号。",
                          f"{instruction}\n上下文：{json.dumps(context, ensure_ascii=False)}",
                          temperature=0.7).strip()

    # ---------- 自由槽位抽取（配合 Jev D2 复核） ----------
    def extract_free_slots(self, user_input: str) -> dict:
        from datetime import date
        year = date.today().year
        out = self._extract_json(self._chat(
            f"从用户输入中抽取旅行槽位，只抽明确表达的值。当前年份 {year}；"
            f"若只给出月日（如10月1日），推断为未来最近一次发生的日期并输出完整 ISO 日期。输出 JSON："
            '{"date_range": {"start":"YYYY-MM-DD","end":"YYYY-MM-DD"}或null, '
            '"duration_days": 数字或null（如"一共7天"）, '
            '"origin": "城市或null", "budget_band": "描述或null", '
            '"interests": [".."], "stay_pref": "或null", "destination": [".."]}',
            user_input, temperature=0.1))
        return {k: v for k, v in out.items() if v}
