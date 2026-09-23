"""四川六日环线 gold truth 走查（SPEC §8）。

运行方式：
    cd LAB/lab02-agent-pipeline
    python run_sichuan.py            # 全量 7 轮（需要 DEEPSEEK_API_KEY）
    python run_sichuan.py --no-llm   # 只跑 Jev+高德可覆盖的部分

轮次：①需求 → ②素材 → ③生成 → ④调序(I4) → ⑤返程约束(I3/I7) → ⑥订票汇报(I6) → ⑦READY
"""
from __future__ import annotations

import argparse
import json
import sys

from dotenv import load_dotenv
load_dotenv(dotenv_path="../../.env")
load_dotenv()

from models import Trip
from orchestrator import Orchestrator, plan_desc

ROUNDS = [
    ("① 需求输入",
     "我想国庆去四川玩，10月1日出发，10月7日回，一共7天。想去成都、都江堰、九寨沟、黄龙、峨眉山、乐山，"
     "特别想看熊猫。从上海出发，节奏紧凑一点没关系。"),
    ("② 素材注入",
     "看了一篇攻略：九寨沟要早点进沟，观光车先到长海再往回玩；门票旺季要提前在官方公众号预约。"
     "黄龙海拔3500多米，缆车上步行下比较省力，注意高反。峨眉山金顶看日出要住雷洞坪或金顶。"
     "乐山大佛可以坐船看全景。成都大熊猫基地要早上7点半开门就去，月亮产房的幼崽最可爱。"),
    ("③ 生成方案", "好，按这些帮我把7天的行程排出来吧。"),
    ("④ 调序变更", "把峨眉山和乐山调到前面去，先玩这两个再去九寨黄龙。"),
    ("⑤ 返程约束", "补充一下：返程是10月7日下午从成都双流机场飞上海，最后一晚要住成都。"),
    ("⑥ 订票汇报", "成都和九寨沟的酒店我都订好了。"),
    ("⑦ READY 确认", "其他准备事项我都处理完了，确认方案没问题。"),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-llm", action="store_true", help="跳过依赖 LLM 的轮次")
    args = ap.parse_args()

    orch = Orchestrator(Trip())
    if args.no_llm:
        orch.planner.api_key = ""
    print(f"trip_id: {orch.trip.trip_id}")
    print(f"LLM: {'配置完成' if orch.planner.available else '未配置（生成/解析轮次将降级）'}\n")

    transcript = []
    for title, text in ROUNDS:
        if args.no_llm and title.startswith(("②", "③", "④")):
            print(f"== {title} ==  [跳过：需要 LLM]\n")
            continue
        print(f"== {title} ==")
        print(f"用户: {text[:60]}{'...' if len(text) > 60 else ''}")
        try:
            resp = orch.on_user_input(text)
        except Exception as e:
            print(f"!! 轮次异常: {e}\n")
            transcript.append({"round": title, "error": str(e)})
            continue
        print(f"意图: {json.dumps(resp.get('intents'), ensure_ascii=False)}")
        for a in resp.get("actions", []):
            print(f"  - {a}")
        for q in resp.get("questions", []):
            print(f"  ? {q}")
        if resp.get("reply"):
            print(f"  回复: {resp['reply'][:200]}")
        v = resp.get("verify")
        if v:
            print(f"  校验: {v['summary']} | pass={v['pass']}")
        print(f"阶段: {resp.get('stage')}  缺失: {resp.get('gate_missing')}\n")
        transcript.append({"round": title, "input": text, "resp": {
            k: v for k, v in resp.items() if k != "raw_intents"}})

    # 终态输出
    print("=" * 50)
    print("最终方案描述：")
    print(plan_desc(orch.trip))
    print(f"\n最终阶段: {orch.trip.stage}")
    print(f"checklist: {[(c.title, c.done) for c in orch.trip.checklist.values()]}")

    out = orch.store.dir / "walkthrough.json"
    out.write_text(json.dumps(transcript, ensure_ascii=False, indent=2))
    print(f"\n走查记录已写入 {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
