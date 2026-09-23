"""所有 Jev 问题定义与阈值常量 —— 单一可审文件（官方最佳实践 #7）。

review 原则：agent 生成的问题要人来改；阈值按动作风险分级。
阈值初值（S3）：信息型 0.6 / 状态变更型 0.8，lab02 四川案例回放后标定。
"""

MODEL = "jev-latest"

# ---------------- 阈值 ----------------
TH = {
    "intent_info": 0.6,      # I1/I2/I3/I7/I8 信息型意图命中阈值
    "intent_state": 0.8,     # I4/I5/I6 状态变更型意图命中阈值
    "slot_accept": 0.6,      # D2 槽位入库
    "disambiguate": 0.6,     # D4 指代消解直接采用
    "radius_auto": 0.6,      # D6 传播半径自动执行
    "verify_pass": 0.6,      # D7 校验项通过概率下限
}

INTENTS = {
    "I1": "素材注入：用户在提供外部材料（攻略文本/订单/链接/机酒信息），目的是让系统解析入库，而不是在闲聊",
    "I2": "探索咨询：用户在问开放式问题（去哪玩/怎么玩/值不值得去），不指向对当前方案的具体修改",
    "I3": "约束声明：用户在声明或修改旅行约束（预算/日期天数/出发地/同行人/节奏偏好/兴趣偏好/住宿偏好）",
    "I4": "方案变更：用户要求修改当前方案结构（增/删/换/移动某个景点、酒店、交通或调整天数顺序）",
    "I5": "确认决策：用户在确认某个选项或方案（就这么定/就住这家/方案可以），意图是锁定",
    "I6": "进度汇报：用户在汇报某项准备工作已完成（机票买好了/签证下来了/酒店已订）",
    "I7": "信息回填：用户在提供之前被留空的事实信息（如日出时间/班次/票价/营业时间）",
    "I8": "元操作：用户要求回滚、查看历史版本或重来",
}
STATE_CHANGE_INTENTS = {"I4", "I5", "I6"}


def d1_intent_questions() -> dict:
    """D1：8 个并行 Noul（多标签）。"""
    return {
        f"intent_{k.lower()}": {
            "type": "noul",
            "instructions": f"判断用户输入是否属于以下意图——{v}。只看 `user_input`，结合 `trip_summary.stage` 判断语境。",
        }
        for k, v in INTENTS.items()
    }


def d2_slot_questions() -> dict:
    """D2：枚举型槽位用 Choice；自由值槽位由 LLM 抽取后用 Noul 验证（planner 负责）。"""
    return {
        "slot_pace": {
            "type": "choice",
            "instructions": "用户在 `user_input` 中表达的节奏偏好是？没有明确表达选 none。",
            "criteria": {
                "relaxed": "休闲宽松，每天安排少，强调不赶",
                "tight": "紧凑高效，想多去地方，能接受早起赶路（特种兵式）",
                "deep": "深度体验，单个点停留久，重讲解与文化",
                "none": "未表达节奏偏好",
            },
        },
        "slot_party": {
            "type": "choice",
            "instructions": "用户在 `user_input` 中表达的同行人结构是？没有明确表达选 none。",
            "criteria": {
                "solo": "独自一人",
                "couple": "两人（情侣/夫妻/朋友双人）",
                "family_kids": "带孩子",
                "family_seniors": "带老人/父母",
                "group": "三人以上朋友团",
                "none": "未表达同行人信息",
            },
        },
    }


def d2_slot_verify_question(slot_name: str, value) -> dict:
    """自由值槽位：LLM 抽值后由 Noul 复核。"""
    return {
        f"slot_verify_{slot_name}": {
            "type": "noul",
            "instructions": f"`user_input` 是否明确表达了 {slot_name} 的取值就是 {value}？只有文本明确支持才判真。",
        }
    }


def d4_disambiguate_question(mention: str, candidates: list) -> dict:
    """D4：指代消解。 candidates: [{id, name, kind}]"""
    criteria = {c["id"]: f"{c['name']}（{c['kind']}）" for c in candidates}
    criteria["none_of_above"] = "以上都不是/无法确定指代对象"
    return {
        "disambiguate": {
            "type": "choice",
            "instructions": f"用户说的「{mention}」最可能指 `candidates` 中的哪一个实体？不确定就选 none_of_above。",
            "criteria": criteria,
        }
    }


def d5_next_question_question(missing: list) -> dict:
    """D5：下一个最值得问的槽位。 missing: [{slot, why_blocking}]"""
    criteria = {m["slot"]: m["why_blocking"] for m in missing}
    criteria["no_need"] = "都不急着问，当前信息已足够推进"
    return {
        "next_question": {
            "type": "choice",
            "instructions": "从缺失槽位中选出现在问用户对推进方案帮助最大的一个（阻塞度×信息增益）。",
            "criteria": criteria,
        }
    }


def d6_radius_question(op_desc: str) -> dict:
    """D6：传播半径（C7）。criteria 用对象结构写清三级定义（KB/jev 最佳实践）。"""
    return {
        "propagation_radius": {
            "type": "choice",
            "instructions": {
                "question": f"对方案图执行操作「{op_desc}」后，变更传播应覆盖多大范围？",
                "focus": "依据当日点位密度、路段耗时占比、是否为住宿/场站锚点、该点位在当日的不可替代性判断。",
            },
            "criteria": {
                "R1": {
                    "what": "局部影响：仅相邻 Event 微调（±2 个 Event、±30 分钟内）",
                    "examples": ["高密度 citywalk 删一个小景点", "同片区内换一个餐厅"],
                },
                "R2": {
                    "what": "当日影响：当天 Event 序列与时间窗需要整体重排",
                    "examples": ["更换同片区酒店锚点", "增删当日主要景点"],
                },
                "R3": {
                    "what": "跨日影响：前后日的安排需要联动调整",
                    "examples": ["单点日删掉唯一目的点（如青甘大环线型）", "变更机场/车站等场站锚点", "改动跨日交通 Event"],
                },
            },
        }
    }


def d7_verify_questions(plan_desc: str) -> dict:
    """D7：语义闭环校验 V1–V7，7 个并行 Noul（SPEC §5）。"""
    checks = {
        "V1_time_continuity": "日内 Event 时间窗不重叠且衔接合理；跨日 Event 时间链连续不断",
        "V2_spatial_coherence": "相邻 Event 在空间上可达；跨日的空间锚点衔接（前一日终点与次日起点一致或已交代交通）",
        "V3_opening_hours": "Event 时间安排与各点位营业/开放约束不冲突（未知营业时间不算冲突）",
        "V4_no_dangling": "每个 Event 都锚定在具体地点或路段上，没有无归属的活动",
        "V5_anchor_constraint": "每日起点和终点有住宿或场站锚点（或已明确说明不需要）",
        "V6_logistics_feasibility": "路段交通方式与耗时满足时间窗要求，不存在物理上来不及的衔接",
        "V7_checklist_coverage": "方案中需要预订/预约/查询的事项都已被识别出来（酒店/门票/抢票/限流查询等）",
    }
    return {
        k: {
            "type": "noul",
            "instructions": f"审查以下旅行方案描述，判断其是否满足该标准——{v}。方案：{plan_desc}",
        }
        for k, v in checks.items()
    }
