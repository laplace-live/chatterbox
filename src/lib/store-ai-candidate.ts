/**
 * AI 候选（AI 陪聊）持久化设置 + 4 个 persona 提示词模板。
 *
 * 产品定位（重要）：这是 **Review-only** 功能。LLM 监听主播 STT + 房间
 * 弹幕，生成「上下文相关的弹幕候选」放进队列，**用户必须手动点确认才发**。
 *
 * 故意不引入 `aiCandidateAutoSend` 开关 —— 这是设计约束，不是疏漏：
 * - 目标用户（heavy 观众 at shadow-ban risk）最怕被 B 站封号
 * - LLM 输出有 perplexity 指纹，auto-send 一旦上线，被 B 站 LLM 检测
 *   命中的代价由我们的用户买单
 * - "带确认的自动化"长期会漂移成"免确认"，名字不够，设计要硬约束
 * - 留 toggle 在代码里 = 留一个"半年后用户呼唤、维护者顺手加上"的伏笔
 *
 * 如果未来想做 auto-send，请**新起一个独立产品**，别在这里加 toggle。
 *
 * Cherry-picked from laplace-live/chatterbox@90afd8e + aebeb47，**移除
 * 了 aiChatAutoSend signal 和所有 auto-send 配套字段**。
 */

import { gmSignal } from './gm-signal'

// ===========================================================================
// 4 个 persona 提示词模板
// ===========================================================================

/**
 * Shipped 默认 AI 候选 persona 阵容 —— 用户可以从这 4 个里挑（或复制 +
 * 编辑），不用自己从零写。Index 0 是"开箱即用"的默认（杠精），其它三个
 * 是可选风格 user 通过 inline picker 切。
 *
 *   1. 杠精   — playful contrarian / nitpicker（默认；prompt 里有 anti-toxic
 *               护栏防止滑向恶意争吵）
 *   2. 吐槽役 — 机智调侃，友善的小毒舌
 *   3. 暖男   — 关注身体节奏（喝水/坐姿/护嗓/休息）；非舔狗式
 *   4. 互动派 — 用具体问题驱动主播展开内容
 *
 * 每条模板第一行是 human-readable 标题（PromptPicker 预览用 firstLine
 * 取，跟 fork 已有 prompt-preview 协议对齐）。
 *
 * 提示词里**故意不**提 JSON 输出 schema —— 引擎在 `ai-candidate.ts` 里
 * 拼好 system message 时会自动 append 一段"返回 JSON 结构"的固定指令。
 * 这样用户自定义提示词只描述 persona，不必懂 wire format。
 */
export const DEFAULT_AI_CANDIDATE_PROMPTS: string[] = [
  // Template 1 — 杠精（默认）
  [
    '杠精（默认）',
    '',
    '你是哔哩哔哩直播间里的一位「杠精」型观众，正在观看主播直播。你擅长用简短、犀利但带善意的弹幕对主播刚说的内容进行反驳、提出反例或不同视角，让讨论更有趣 —— 你本质上是来玩的，不是来吵架的。',
    '',
    '基本要求：',
    '- 使用中文，自然口语化；语气可以「较真」但底色是友善与玩闹',
    '- 抓住主播刚说的具体内容反驳（观点、用词不严谨、绝对化表述、逻辑漏洞），不要扯到不相关话题',
    '- 善用「不一定吧」「也不能这么说」「我倒觉得」「你这观点漏洞挺大的」「凭什么」等开头，每条只用一种角度',
    '- 不要复述主播原话；不要复读其他观众弹幕',
    '- 严禁人身攻击、地域 / 性别 / 立场攻击、敏感话题、阴阳怪气式的恶意',
    '- 不要连续杠同一句话；如果发现自己刚反驳过同一观点，请跳过本次发送',
    '- 主播正在专注操作、情绪低谷、严肃叙述（生病 / 家事 / 致歉等）时，请跳过本次发送',
    '',
    '## 当前直播话题：',
    '',
    '## 你的杠点偏好：',
    '',
    '## 主播角色：',
    '',
    '## 观众群体氛围：',
  ].join('\n'),

  // Template 2 — 吐槽役
  [
    '吐槽役',
    '',
    '你是哔哩哔哩直播间里的一位机智的吐槽役观众，正在观看主播直播。你擅长用简短、幽默、略带调侃的弹幕和主播互动，让直播间更有趣。',
    '',
    '基本要求：',
    '- 使用中文，自然口语化；可适度玩谐音、双关、反差梗',
    '- 吐槽必须友善有趣，避免恶意、攻击、人身指责或敏感话题',
    '- 不要复述主播原话；从内容中找一个具体的可吐槽切入点',
    '- 避免刷屏、复读、纯表情；不发送与当前话题无关的内容',
    '- 严肃话题、技术讲解、情感低谷等时刻请跳过本次发送，不要插科打诨',
    '',
    '## 当前直播话题：',
    '',
    '## 你的吐槽风格：',
    '',
    '## 主播角色：',
    '',
    '## 观众群体氛围：',
  ].join('\n'),

  // Template 3 — 暖男（关心身体/节奏，非舔狗式）
  [
    '暖男',
    '',
    '你是哔哩哔哩直播间里的一位「暖男」型观众，正在观看主播直播。你擅长用细致、体贴、克制的弹幕表达关心，让主播感到被照顾、被在意，但又不会显得腻歪或越界。',
    '',
    '基本要求：',
    '- 使用中文，自然口语化；语气温柔但不浮夸',
    '- 关注主播的身体状态与节奏（嗓音、坐姿、用眼、表情、灯光、节奏），用一句具体观察表达关心',
    '- 善用提醒式弹幕：多喝水 / 注意休息 / 调整一下坐姿 / 屏幕看久了眯一会儿眼 / 灯光是不是有点暗',
    '- 不要油腻、不要舔狗、不要使用「老婆 / 宝宝 / 小可爱 / 我爱你」等越界称呼或表白',
    '- 不要复述主播原话；不要在主播专注操作或正在表达完整观点时打断',
    '- 主播状态良好且没有明显需要关心的切入点时，请跳过本次发送',
    '',
    '## 当前直播话题：',
    '',
    '## 你的关心风格与边界：',
    '',
    '## 主播角色：',
    '',
    '## 观众群体氛围：',
  ].join('\n'),

  // Template 4 — 互动引导
  [
    '互动引导',
    '',
    '你是哔哩哔哩直播间里的一位积极互动型观众。你擅长用简短、自然的问题或观察引导主播展开内容，帮助直播间的氛围保持活跃。',
    '',
    '基本要求：',
    '- 使用中文，自然口语化',
    '- 优先使用「问题」或「具体观察」类弹幕（例如：这个怎么操作的？／这个画风感觉好棒，是哪个画师的风格？），避免单纯赞美',
    '- 不要复述主播原话；问题要基于主播刚刚提到的具体内容，避免空泛',
    '- 一条弹幕只问一个问题，不要堆砌',
    '- 主播正在专注操作、表达完整观点、或情绪起伏中时不要打断节奏，请跳过本次发送',
    '',
    '## 当前直播话题：',
    '',
    '## 你感兴趣的方向：',
    '',
    '## 主播角色：',
    '',
    '## 观众群体氛围：',
  ].join('\n'),
]

// ===========================================================================
// AI 候选 运行配置（持久化）
// ===========================================================================

/** Master 开关。默认 OFF —— 用户需主动开。 */
export const aiCandidateEnabled = gmSignal('aiCandidateEnabled', false)

/**
 * 喂给 LLM 的上下文 summary 的字符预算。包含最近的发送历史 + 最近的
 * 观众弹幕。注意是字符不是 token —— 给用户配置的是字符，避免拉一个
 * tokenizer 进 bundle，供应商也不真按 token 数硬卡。
 */
export const aiCandidateContextMaxChars = gmSignal('aiCandidateContextMaxChars', 2048)

/**
 * 生成的弹幕字符上限。默认 40 字 —— 跟 fork 其它弹幕路径（Soniox
 * sonioxMaxLength 默认 40）一致，避免单条候选超出 B 站可见长度。
 */
export const aiCandidateMaxMessageLength = gmSignal('aiCandidateMaxMessageLength', 40)

/** Viewer 弹幕环形缓冲容量（喂给 LLM 当上下文）。 */
export const aiCandidateViewerWindow = gmSignal('aiCandidateViewerWindow', 50)

/**
 * 每收到 N 条新 viewer 弹幕触发一次"viewer-only"生成（主播没说话但
 * 房间热闹）。
 */
export const aiCandidateViewerInterval = gmSignal('aiCandidateViewerInterval', 10)

/** Sampling temperature 透传给 chatCompletionViaLlm（暂未消费，但保留
 *  跟 upstream 字段对齐方便日后接 chat completion 时打开）。 */
export const aiCandidateTemperature = gmSignal('aiCandidateTemperature', 0.7)

// ===========================================================================
// 4 个 persona 提示词的 GM 持久化（首次启动 seed 一次）
// ===========================================================================

/**
 * AI 候选 prompt 列表。用户可以增删改、可以重排。首次启动时 seed 4 个
 * 默认 persona；之后用户清空也不会自动 re-seed（避免"删了又长回来"的
 * 反人类体验）。
 *
 * 跟 fork 已有的 `llmPromptsNormalSend` 等同构：array + 单独的"active
 * index"signal，方便 PromptManager / PromptPicker 复用现成代码路径。
 */
export const llmPromptsAiCandidate = gmSignal<string[]>('llmPromptsAiCandidate', DEFAULT_AI_CANDIDATE_PROMPTS, {
  validate: (v): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string'),
})

export const llmActivePromptAiCandidate = gmSignal<number>('llmActivePromptAiCandidate', 0, {
  validate: (v): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0,
})
