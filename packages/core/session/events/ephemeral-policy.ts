/**
 * **短命事实策略表**(F4-c 定律三,`docs/design/session-event-sourcing-2026-08.md`
 * §16.19 / §17)。
 *
 * > 定律三:**短命事实必须被证明会被取代。**
 * > 一种事实允许不持久化,当且仅当后续某条**持久事件**使它冗余。
 *
 * 它住在词汇表旁边(`events/`)而不是判据旁边(`projection/canonical.ts`),
 * 因为它说的是**账本上有没有**这件事,不是"比较时算不算数"。判据只是它的
 * 第一个消费者:`canonicalChatMessage` 从这里读该丢哪几格,于是那张豁免表
 * 从此只剩**杂项**(坐标 / 派生量 / 时钟噪声 / `false ≡ 缺席` 的归一)。
 *
 * ## 这张表是**封闭**的
 *
 * 想让一格"不落账",唯一的路是在这里加一条,而加一条要交三样东西:
 *
 * 1. **取代它的持久事件**(`supersededBy`)—— 事件类型的名字,不是一句话;
 * 2. **收敛性质的形状**(`proofKind`)—— 下面两种之一,不许自创第三种;
 * 3. **证明指针**(`proofs`)—— 落到具体的 `it(...)` 名字上。
 *    `__tests__/ephemeral-policy.test.ts` 会**逐条把指针解析回磁盘**:
 *    文件不在、用例改了名,那道门当场红。指针因此不会烂。
 *
 * 反过来:**不是"被取代"的豁免不许写进这里**。坐标(`seq`)、派生量
 * (`thinkingTime`)、两次读表的时钟噪声(`startTime`/`endTime`)、
 * 渲染锚点(`data-steps`,G4)都留在 `canonical.ts` 的杂项表里,各带各的理由。
 * 两者分家的意义就在这里:策略表里的每一条都有一条机器能跑的收敛证明,
 * 杂项表里的每一条都只有一句人话。混在一起时没人分得清哪条是哪条。
 *
 * ## 两种收敛性质(`proofKind`)
 *
 * - **`strip-homomorphism`(抹掉即同态)**——折叠**会**产出这一格,取代事件
 *   一到它自己消失。性质:折到取代事件**之后**,把这一格从投影上抹掉,
 *   `canonical` 一字不变;折到取代事件**之前**抹掉,`canonical` 会变
 *   (那条反证证明这条登记不是空转)。
 * - **`substitute-derivable`(替身可算)**——折叠**从不**产出这一格(账本上
 *   没有它,或者有而投影不物化),它承载的信息由取代事件唯一算得出来。
 *   性质:取代事件在场时替身算得出来且逐格确定,取代事件缺席时替身**不出现**
 *   (不是补个 0 假装有)。
 *
 * ## 表外的一条纪律
 *
 * 登记一条短命事实**不等于**允许产品行为退化。判据仍然是 §9.4 那句话:
 * *拿投影那一份当真相,用户看到的东西会不会变?* 会变的一格不许进这张表 ——
 * 它该做的是补一个采集点(工具结局的 metadata 就是这么补上来的)。
 */

/** 登记在案的短命事实。**封闭枚举** —— 加一种就是加一条 union 成员。 */
export type SessionEphemeralFactId =
  | 'message.isStreaming'
  | 'message.thinking-activity'
  | 'step.partialResult'
  | 'toolCall.streamingArgs'
  | 'contentPart.placeholder'
  | 'contentPart.plugin-status.unsettled'
  | 'codec.unflushed-delta'

/** 两种收敛性质的形状,见文件头。 */
export type SessionEphemeralProofKind = 'strip-homomorphism' | 'substitute-derivable'

/** 一条证明指针:仓库相对路径 + `it(...)` 的名字(逐字)。 */
export interface SessionEphemeralProofPointer {
  readonly file: string
  readonly test: string
}

export interface SessionEphemeralFactPolicy {
  readonly id: SessionEphemeralFactId
  /** 它长在哪几格上(消息 / step / toolCall / contentPart / 编码器缓冲)。 */
  readonly cells: readonly string[]
  /** 这条短命事实说的是什么。 */
  readonly what: string
  /** 取代它的**持久**事件类型(事件词表里的名字)。 */
  readonly supersededBy: readonly string[]
  /** 取代之后它的信息去了哪(替身;`strip-homomorphism` 的那几条是"没了")。 */
  readonly substitute: string
  readonly proofKind: SessionEphemeralProofKind
  readonly proofs: readonly SessionEphemeralProofPointer[]
  /** 诚实注记:这条登记身上还挂着什么账(没有就不写)。 */
  readonly note?: string
}

const CONTRACT = 'packages/core/session/__tests__/projection-contract.test.ts'
const POLICY = 'packages/core/session/__tests__/ephemeral-policy.test.ts'
const CODEC = 'packages/core/session/__tests__/session-chunk-codec.test.ts'
const PLUGIN_STATUS = 'packages/renderer/stores/__tests__/plugin-status-parts.test.ts'
/** 结算态的产地(§17.8 前置批,留账 #10 结清)。 */
const PLUGIN_STATUS_LANDING = 'packages/backend/wiring/external-agents/__tests__/background-status.test.ts'

export const SESSION_EPHEMERAL_FACT_POLICY: readonly SessionEphemeralFactPolicy[] = [
  {
    id: 'message.isStreaming',
    cells: ['ChatMessage.isStreaming'],
    what: '"这条助手消息还在生成中"。它不是事件字段,是**状态** —— 折叠时由 run 的开闭推导'
      + '(`chat-messages.ts`:`node.ended ? {} : { isStreaming: true }`)。',
    supersededBy: ['run/end'],
    substitute: '没有替身:run 收场之后"还在生成"这件事不再为真,那一格随之消失。',
    proofKind: 'strip-homomorphism',
    proofs: [
      { file: POLICY, test: 'isStreaming: run/end 之后抹掉它 canonical 不变,run/end 之前会变' },
      { file: CONTRACT, test: 'c1: run/start alone materializes a complete streaming placeholder' },
    ],
  },
  {
    id: 'message.thinking-activity',
    cells: ['ChatMessage.isThinking', 'ChatMessage.thinkingStartTime'],
    what: '**UI 活跃态** —— "思考中"那个转圈,以及渲染侧自己走秒的起点。它只在一次流的'
      + '现场有意义,重放一遍历史时没有任何一格该被它改变。',
    supersededBy: ['assistant/chunks', 'assistant/part-end', 'request/start', 'assistant/first-token'],
    substitute: '`thinkingTime` —— 由推理段 chunks 的首末时刻差算出;没有推理段就退回'
      + '"首 token 减请求开始"(`deriveThinkingTime`)。**算不出来就没有这一格,不填 0**。',
    proofKind: 'substitute-derivable',
    proofs: [
      { file: POLICY, test: 'thinking-activity: 替身 thinkingTime 由推理段算出,算不出时不出现' },
      { file: CONTRACT, test: 'G5: skill/activated lands on the message, and thinkingTime is derived from the reasoning span' },
      { file: CONTRACT, test: 'G5: with no reasoning, thinkingTime falls back to the first-token wait' },
    ],
  },
  {
    id: 'step.partialResult',
    cells: ['Step.partialResult', 'Step.partialResultIsPartial'],
    what: '工具执行**途中**的结局缓存(边跑边刷的那一份)。判据不是谁定的,是持久化层自己'
      + '写的:落盘时结算过的 `partialResult` 被整格摘掉,冷加载再由 `toolResultToStructured'
      + '(toolCall.result)` 算回来 —— 同一条消息在重启前后本来就不是同一个值。',
    supersededBy: ['tool/result'],
    substitute: '`toolResultToStructured(tool/result.result)` —— 折叠用的是**同一条**派生规则'
      + '(`reducer.ts` 的 `materializeStep`),失败的调用照引擎的写法没有这一格。',
    proofKind: 'substitute-derivable',
    proofs: [
      { file: POLICY, test: 'partialResult: tool/result 之前折不出它,之后由结局唯一算出' },
      { file: CONTRACT, test: 'a failed-but-completed tool keeps its structured result and its self-reported title' },
    ],
  },
  {
    id: 'toolCall.streamingArgs',
    cells: ['ToolCall.streamingArgs'],
    what: '"这次调用的参数还在生成"。消息上那一格从建卡起就是空串'
      + '(`createCoreToolInputStartArtifacts`)—— 一个字一个字吐出来的原文只发给渲染层,'
      + '一格都没回写进消息;账本里它是 `assistant/chunks{kind:\'tool-input\'}`。',
    supersededBy: ['tool/call'],
    substitute: '`tool/call.argumentsRaw` —— **唯一**的参数真相(真正执行的那一份)。'
      + '`tool/call` 一到,折叠当场把 `streamingArgs` 撤下(`reducer.ts`:`tool.streamingArgs = undefined`),'
      + '`arguments` 从 `argumentsRaw` 解出。',
    proofKind: 'strip-homomorphism',
    proofs: [
      { file: POLICY, test: 'streamingArgs: tool/call 之后抹掉它 canonical 不变,tool/call 之前会变' },
      { file: CONTRACT, test: 'two-request tool loop including a denied permission' },
    ],
  },
  {
    id: 'contentPart.placeholder',
    cells: ["ContentPart{type:'waiting'}", "ContentPart{type:'image-loading'}"],
    what: '**占位型瞬态 part**:等第一个字的转圈、生图时的灰块。追加即撤 —— append-only'
      + '的账本表达不了"我刚才加了一格,现在把它拿掉"(§7.2 M3)。',
    supersededBy: ['assistant/chunks', 'assistant/part-end'],
    substitute: '同一个位置上真正的那一格正文 / 图片 part。占位被真内容顶掉,是渲染侧'
      + '(`isPlaceholderTransientPart`)与折叠侧共同的口径:折叠**从不**产出占位。',
    proofKind: 'substitute-derivable',
    proofs: [
      { file: POLICY, test: 'placeholder part: 折叠从不产出占位,真正文一到就是它该在的那一格' },
    ],
  },
  {
    id: 'contentPart.plugin-status.unsettled',
    cells: ["ContentPart{type:'plugin-status', durationMs: undefined}"],
    what: '插件"正在干活"的状态行。它是**流内型**瞬态:活到流结束,不被正文顶掉,'
      + '同 id 再来一次就地更新。',
    supersededBy: ['plugin/status'],
    substitute: '带 `durationMs` 的**结算态**(或 `cleared`)—— 词表里有它的落点'
      + '(`plugin/status`,带 `startedAt` / `durationMs` / `cleared`)。',
    proofKind: 'substitute-derivable',
    proofs: [
      { file: PLUGIN_STATUS, test: 'is stream-scoped transient, not placeholder transient' },
      { file: PLUGIN_STATUS, test: '已结算的那条不再是 transient —— 定格的总耗时活过回合收尾' },
      { file: PLUGIN_STATUS, test: '回合收尾:在跑的被扫掉,已结算的留下' },
      // 取代者**转真**:结算那一刻真的写下了一条 `plugin/status`。
      { file: PLUGIN_STATUS_LANDING, test: 'settled 写一条 plugin/status;running 一条都不写' },
    ],
    note: '**留账 #10 已结清(§17.8 前置批,2026-08-28)**:结算态从此有产地 —— '
      + '全仓唯一的结算态生产者(后台子代理指示器,`backend/wiring/external-agents/'
      + 'background-status.ts` 的 `recordSettledStatus`)在结算那一刻经单门写下 '
      + '`plugin/status`(带 `durationMs`),折叠侧把它物化成这一轮正文之后的一格 '
      + '(`materializeContentParts` 末尾)。**成对交付**:老账本没有这条事件 = 折叠侧'
      + '没有这一格 = 与从前"重开会话就没了"逐字相同,变化只发生在新写的会话上。'
      + '未结算的那一档仍然是短命的 —— 这条策略表条目说的正是它。'
  },
  {
    id: 'codec.unflushed-delta',
    cells: ['SessionChunkEncoder 的写缓冲'],
    what: '逻辑 delta 进了编码器、打包行还没刷出去的那一小段。它是定律二留下的**唯一**'
      + '"内存领先磁盘"窗口 —— 归存储层(fsync 检查点原管),不是语义例外。',
    supersededBy: ['assistant/chunks'],
    substitute: '刷出来的那条打包行。唯一合同:**decode(encode(x)) ≡ x** ——'
      + '缓冲里那几条 delta 与打包行解出来的那几条逐字相同。',
    proofKind: 'strip-homomorphism',
    proofs: [
      { file: CODEC, test: 'holds on a real-machine shaped script (四道闸各走一遍)' },
      { file: CODEC, test: 'holds on 200 random scripts' },
    ],
  },
]

// ---------------------------------------------------------------------------
// 判据消费的那几格(`canonicalChatMessage` 从这里读,不再自己抄一份)
// ---------------------------------------------------------------------------

/** `message.thinking-activity` 的两格。 */
export const EPHEMERAL_MESSAGE_KEYS: ReadonlySet<string> = new Set(['isThinking', 'thinkingStartTime'])

/** `step.partialResult` 的两格。 */
export const EPHEMERAL_STEP_KEYS: ReadonlySet<string> = new Set(['partialResult', 'partialResultIsPartial'])

/** `contentPart.placeholder` 的两种。 */
export const EPHEMERAL_PLACEHOLDER_PART_TYPES: ReadonlySet<string> = new Set(['waiting', 'image-loading'])

/**
 * 一格 contentPart 是不是**登记在案的短命事实**。
 *
 * 与 shared 层的 `isTransientPart` 同口径(core 不引 shared,判据抄在这里),
 * 但**只覆盖策略表里那两条** —— `data-steps` 不在这里:它是渲染锚点(G4),
 * 不是"会被取代的短命事实",理由留在 `canonical.ts` 的杂项表。
 */
export function isEphemeralContentPart(part: unknown): boolean {
  if (!part || typeof part !== 'object') return false
  const record = part as { type?: unknown; durationMs?: unknown }
  if (typeof record.type !== 'string') return false
  if (EPHEMERAL_PLACEHOLDER_PART_TYPES.has(record.type)) return true
  // 流内型:**未结算**的那一条(结算之后 `durationMs` 定格,它不再是短命事实)。
  return record.type === 'plugin-status' && record.durationMs === undefined
}

/** 按 id 取一条(测试与文档生成用;找不到就是 `undefined`,不猜)。 */
export function findSessionEphemeralFactPolicy(
  id: SessionEphemeralFactId,
): SessionEphemeralFactPolicy | undefined {
  return SESSION_EPHEMERAL_FACT_POLICY.find(entry => entry.id === id)
}
