"""泛化测试：三个新案例验证流水线通用性（非四川专属）。

案例设计意图：
- chongqing3d：双人休闲城市游，市内交通为主，测 I4 同片区合并（R2 传播）
- tianjin2d：带老人周末短途，日期是相对表述（"周六早上"无绝对日期），
  测 duration_days 兜底 + 跨城（天津市区↔滨海）调度
- huangshan4d：单人山岳+古村，测住宿锚点变更传播（山上→山下，取消日出）

运行：python3 run_cases.py [--case chongqing3d] 
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from dotenv import load_dotenv
load_dotenv(dotenv_path="../../.env")
load_dotenv()

from models import Trip
from orchestrator import Orchestrator, plan_desc

CASES = {
    "chongqing3d": {
        "title": "北京出发重庆3日游（双人·休闲·城市）",
        "rounds": [
            ("① 需求输入",
             "我想从北京去重庆玩3天，10月15号出发10月17号回，和对象两个人，"
             "想休闲一点别太赶，主要想吃火锅、看夜景、逛逛老街。"),
            ("② 素材注入",
             "收藏的攻略：洪崖洞晚上亮灯后最好看，千厮门大桥上拍全景最出片；"
             "长江索道建议从上新街往新华路方向坐，排队人少；磁器口早上9点前去没什么人；"
             "轻轨2号线李子坝站穿楼，车头视角最好；南山一棵树观景台看夜景要早点去占位置。"),
            ("③ 生成方案", "好，帮我把这3天排出来。"),
            ("④ 变更", "把磁器口和洪崖洞安排到同一天吧，顺路。"),
            ("⑤ 确认", "酒店订好了，其他准备事项也都搞定了。"),
        ],
    },
    "tianjin2d": {
        "title": "北京出发天津+塘沽2日游（带老人·周末短途·跨城）",
        "rounds": [
            ("① 需求输入",
             "周末想带爸妈从北京去天津玩两天，周六早上去周日晚上回，一共2天，"
             "节奏别太累。想去五大道、意式风情区，还想去塘沽那边看海。"),
            ("② 素材注入",
             "查了下：高铁北京南到天津站只要半小时，到滨海站差不多1小时；"
             "国家海洋博物馆在滨海新区，免费但要提前在公众号预约；"
             "滨海图书馆很有设计感，适合拍照；天津之眼晚上亮灯好看；"
             "带老人别排太满，中午最好有地方歇脚。"),
            ("③ 生成方案", "帮我们安排一下这两天。"),
            ("④ 变更", "国家海洋博物馆放第二天上午，看完下午直接回北京。"),
            ("⑤ 确认", "高铁票和海博的预约都弄好了。"),
        ],
    },
    "huangshan4d": {
        "title": "北京出发黄山+徽州4日游（单人·山岳+古村·锚点变更）",
        "rounds": [
            ("① 需求输入",
             "11月初想去黄山和徽州玩4天，11月1号出发11月4号回，北京出发，"
             "就我一个人。想看黄山日出，还想去宏村西递这些古村。"),
            ("② 素材注入",
             "攻略说：黄山看日出要住山上，光明顶或白云宾馆附近位置最好；"
             "前山玉屏索道上、后山云谷索道下比较省体力；宏村月沼清晨六七点拍照没什么人；"
             "西递比宏村游客少；黄山北站有旅游大巴直达宏村；11月山顶夜里接近零度要带羽绒服。"),
            ("③ 生成方案", "帮我安排一下这4天。"),
            ("④ 变更", "山上住宿太贵了，第二天改成当天下山住汤口镇，日出不看了。"),
            ("⑤ 确认", "住宿都重新订好了，准备完毕。"),
        ],
    },
}


def run_case(case_id: str, case: dict) -> dict:
    print(f"\n{'='*60}\n案例 {case_id}: {case['title']}\n{'='*60}")
    orch = Orchestrator(Trip())
    print(f"trip_id: {orch.trip.trip_id}")
    transcript = []
    t0 = time.time()
    for title, text in case["rounds"]:
        print(f"\n== {title} ==")
        try:
            resp = orch.on_user_input(text)
        except Exception as e:
            print(f"!! 轮次异常: {e}")
            transcript.append({"round": title, "error": str(e)})
            continue
        print(f"意图: {json.dumps(resp.get('intents'), ensure_ascii=False)}")
        for a in resp.get("actions", []):
            print(f"  - {a}")
        for q in resp.get("questions", []):
            print(f"  ? {q}")
        v = resp.get("verify")
        if v:
            print(f"  校验: {v['summary']} | pass={v['pass']}")
        print(f"阶段: {resp.get('stage')}")
        transcript.append({"round": title, "input": text,
                           "resp": {k: v for k, v in resp.items() if k != "raw_intents"}})

    desc = plan_desc(orch.trip)
    print(f"\n--- 最终方案（{time.time()-t0:.0f}s）---\n{desc}")
    print(f"最终阶段: {orch.trip.stage}")
    open_items = [c.title for c in orch.trip.checklist.values() if not c.done]
    print(f"checklist 未完成: {open_items or '无'}")

    result = {"case": case_id, "trip_id": orch.trip.trip_id,
              "final_stage": orch.trip.stage, "days": orch.trip.days,
              "events": len(orch.trip.events), "checklist": len(orch.trip.checklist),
              "open_items": open_items, "plan_desc": desc, "transcript": transcript}
    out = orch.store.dir / "case_result.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"结果已写入 {out}")
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", choices=list(CASES), help="只跑指定案例")
    args = ap.parse_args()
    selected = {args.case: CASES[args.case]} if args.case else CASES
    results = [run_case(cid, c) for cid, c in selected.items()]

    print(f"\n{'='*60}\n泛化测试汇总\n{'='*60}")
    for r in results:
        ok = "✓" if r["final_stage"] == "ready" else "✗"
        print(f"{ok} {r['case']}: 阶段={r['final_stage']} days={r['days']} "
              f"events={r['events']} checklist={r['checklist']}")
    summary = [{"case": r["case"], "stage": r["final_stage"], "days": r["days"],
                "events": r["events"], "checklist": r["checklist"],
                "open_items": r["open_items"]} for r in results]
    with open("runs/generalization_summary.json", "w") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    sys.exit(main())
