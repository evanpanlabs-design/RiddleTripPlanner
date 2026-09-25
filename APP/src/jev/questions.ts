/** 所有 Jev 问题定义与阈值 —— 单一可审文件（移植自 LAB/lab02 questions.py，保持事实源一致）。 */

export const MODEL = "jev-latest";

export const TH = {
  intentInfo: 0.6,
  intentState: 0.8,
  slotAccept: 0.6,
  disambiguate: 0.6,
  radiusAuto: 0.6,
  verifyPass: 0.6,
  checklistMatch: 0.7,   // D4 清单项实体级匹配：指代型陈述的边界分约 0.79，未涵盖项 ≤0.2，0.7 落在间隙中
} as const;

export const INTENTS: Record<string, string> = {
  I1: "素材注入：用户在提供外部材料（攻略文本/订单/链接/机酒信息），目的是让系统解析入库，而不是在闲聊",
  I2: "探索咨询：用户在问开放式问题（去哪玩/怎么玩/值不值得去），不指向对当前方案的具体修改",
  I3: "约束声明：用户在声明或修改旅行约束（预算/日期天数/出发地/同行人/节奏偏好/兴趣偏好/住宿偏好）",
  I4: "方案变更：用户要求修改当前方案结构（增/删/换/移动某个景点、酒店、交通或调整天数顺序，包括'把X放到第N天'这类句式）",
  I5: "确认决策：用户在确认某个选项或方案（就这么定/就住这家/方案可以），意图是锁定",
  I6: "进度汇报：用户在汇报某项准备工作已完成（机票买好了/签证下来了/酒店已订）",
  I7: "信息回填：用户在提供之前被留空的事实信息（如日出时间/班次/票价/营业时间）",
  I8: "元操作：用户要求回滚、查看历史版本或重来",
};

export const STATE_CHANGE_INTENTS = new Set(["I4", "I5", "I6"]);

export function d1IntentQuestions() {
  return Object.fromEntries(
    Object.entries(INTENTS).map(([k, v]) => [
      `intent_${k.toLowerCase()}`,
      { type: "noul", instructions: `判断用户输入是否属于以下意图——${v}。只看 \`user_input\`，结合 \`trip_summary.stage\` 判断语境。` },
    ])
  );
}

/** D4 进度汇报→清单项实体级匹配：每个候选清单项一个 noul 问题，一次 ask 批量判。
 * state 须带 open_checklist（全部未完成项）供指代解析：「剩下两样都弄好了」可对上；
 * 但只提及部分事项时未被提及的项判假（不猜）。 */
export function d4ChecklistMatchQuestions(items: { id: string; title: string; category: string }[]) {
  return Object.fromEntries(
    items.map((it) => [
      `chk_${it.id}`,
      {
        type: "noul",
        instructions: `\`user_input\` 是用户最新发言，\`open_checklist\` 是当前全部未完成准备事项。判断用户是否明确表示准备事项「${it.title}」（类别：${it.category}）已经完成（订好/买好/办好/备齐）。涵盖规则：① 用户说的"剩下的/那几样/都"等指代可结合 \`open_checklist\` 理解，用户明确表示剩余事项都完成了，则对 \`open_checklist\` 涵盖的该项判真；② 用户用类别词（如"酒店""门票""车票""签证"）说完成了，且该项是 \`open_checklist\` 中此类别唯一或明显对应的事项，也算明确涵盖。判假规则：只提及部分事项时未被涵盖的项、只是打算去办还没办、或用户所说与该项内容明显不符的，一律判假。`,
      },
    ])
  );
}

export function d6RadiusQuestion(opDesc: string) {
  return {
    propagation_radius: {
      type: "choice",
      instructions: {
        question: `对方案图执行操作「${opDesc}」后，变更传播应覆盖多大范围？`,
        focus: "依据当日点位密度、路段耗时占比、是否为住宿/场站锚点、该点位在当日的不可替代性判断。",
      },
      criteria: {
        R1: { what: "局部影响：仅相邻 Event 微调（±2 个 Event、±30 分钟内）", examples: ["高密度 citywalk 删一个小景点", "同片区内换一个餐厅"] },
        R2: { what: "当日影响：当天 Event 序列与时间窗需要整体重排", examples: ["更换同片区酒店锚点", "增删当日主要景点"] },
        R3: { what: "跨日影响：前后日的安排需要联动调整", examples: ["单点日删掉唯一目的点", "变更机场/车站等场站锚点", "改动跨日交通 Event"] },
      },
    },
  };
}

export function d7VerifyQuestions(planDesc: string) {
  const checks: Record<string, string> = {
    V1_time_continuity: "日内 Event 时间窗不重叠且衔接合理；跨日 Event 时间链连续不断",
    V2_spatial_coherence: "相邻 Event 在空间上可达；跨日的空间锚点衔接",
    V3_opening_hours: "Event 时间安排与各点位营业/开放约束不冲突（未知营业时间不算冲突）",
    V4_no_dangling: "每个 Event 都锚定在具体地点或路段上，没有无归属的活动",
    V5_anchor_constraint: "每日起点和终点有住宿或场站锚点（或已明确说明不需要）",
    V6_logistics_feasibility: "路段交通方式与耗时满足时间窗要求，不存在物理上来不及的衔接",
    V7_checklist_coverage: "方案中需要预订/预约/查询的事项都已被识别出来",
    V9_geo_intent: "各点位的落位（城市/坐标）与旅行目的地在语义上一致，不存在同名异地错位的可疑点（例如目的地在四川，点位落位清单里却出现外省城市或明显偏离的坐标）",
  };
  return Object.fromEntries(
    Object.entries(checks).map(([k, v]) => [
      k, { type: "noul", instructions: `审查以下旅行方案描述，判断其是否满足该标准——${v}。方案：${planDesc}` },
    ])
  );
}

/** pending 问题消费判定：用户新输入是否在回答待决问题 */
export function pendingConsumeQuestion(pendingQuestion: string) {
  return {
    consume_pending: {
      type: "noul",
      instructions: `系统此前向用户提了待确认问题「${pendingQuestion}」。判断 \`user_input\` 是否是对该问题的回应（肯定/否定/给出所问信息都算回应）。`,
    },
    approve_pending: {
      type: "noul",
      instructions: `针对同一待确认问题「${pendingQuestion}」，\`user_input\` 是否明确表示同意/确认（如"确认""可以""就按这个来"）。明确表示拒绝、反悔、维持现状，或只是答非所问时，必须判假。`,
    },
  };
}
