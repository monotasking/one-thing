import type { materializeChatMessages } from '@onething/core/session/projection/chat-messages'

/**
 * 屏幕上那棵消息树的**纯函数半边**(D3,路线 A)。
 *
 * ## 三条来源,各管一段(与 Vue 壳 `stores/fold-tree.ts` 逐条同判例)
 *
 * | 来源 | 管什么 | 词汇 |
 * | --- | --- | --- |
 * | **折叠**(core 归约器) | 全部结构与已结算事实:身份、顺序、正文、工具卡、轮次 | `SessionLogEventRecord` |
 * | **活尾巴** | 当前那一段**还没被打包行刷出来**的文本 | `session:stream` 的 delta |
 * | **overlay** | 按定义进不了账本的两类:待送出的消息、本地提示 | 本文件的 `OverlayEntry` |
 *
 * ## 活尾巴为什么不是"第二份拼装"
 *
 * 判据是**它不做任何结构决策**:开段 / 闭段 / 这段属于哪条消息,全部听折叠与
 * 账本词汇 —— 尾巴只是"这条消息最后那段文本的、还没进打包行的那一截",一个纯
 * 文本追加缓冲。打包行(`assistant/chunks`)一到,尾巴**整段丢掉**,由账本那份
 * 接管:两者逐字节相同,依据是 `core/session/events/chunk-codec.ts` 的编解码器
 * 合同 `decode∘encode ≡ id`,所以换装在屏幕上不可见。
 *
 * 为什么必须有它:打包器有两个出口 —— UI 流(每条 delta 立刻)与打包行
 * (段收尾 / 64 条 / 2000ms 三者先到)。只读打包行的话,打字上屏会从 ~16ms 掉到
 * 最坏 2s 一蹦。尾巴补的正是这一段差,而不是补"折叠器算不出来的东西"。
 */

/**
 * 折叠物化出来的一条消息。
 *
 * 类型从 `materializeChatMessages` 的**返回值**上取,而不是去 import
 * `core/session/projection/types` —— 那个文件不在 `@onething/core` 的 exports 表里,
 * 而本批的硬规矩是 `packages/*` 只 import 不改。返回值推导出来的是同一个类型。
 */
export type ProjectedMessage = ReturnType<typeof materializeChatMessages>['messages'][number]

/* ── 活尾巴 ───────────────────────────────────────────────────────────── */

/**
 * 尾巴里的一截:**同一种、连续到达**的文本。
 *
 * 分截的判据不是尾巴自己想出来的 —— 它与打包器开段的判据是同一条(core 的
 * part-boundary 状态机:同类连续的 delta 归同一段,换了种就是新的一段)。
 */
export interface TailSegment {
  kind: 'text' | 'reasoning'
  text: string
}

export interface Tail {
  messageId: string
  /** 按到达顺序的段(**只有文本**,段界来自流本身)。 */
  segments: TailSegment[]
  /** 顶部推理(渲染成思考块;它落在 `message.reasoning`,**不是** part)。 */
  reasoningTop: string
}

/**
 * 一条 delta 进尾巴。**只追加文本**:段是谁开的、属于哪条消息,由折叠说了算 ——
 * 这里只认 `messageId`(流自己盖的号),换了消息就换一条尾巴。
 *
 * `placement` 是推理的**落点**,由流自己说(`reasoning-delta` 带着它)。这不是
 * 尾巴自己的结构决策:`top` / `inline` 是引擎在开这一段时就定下的事实。缺席时按
 * "这条消息还没有正文 = top" 兜底 —— 与 Vue 壳那条逐字相同。
 *
 * **少了它就是真机上那两条回归**(8d72e236):top 推理被当成行内推理挂进
 * contentParts,于是同一段思考既进思考块又以正文渲染,而且多出一个思考块。
 */
export function feedTail(
  current: Tail | undefined,
  messageId: string,
  kind: 'text' | 'reasoning',
  text: string,
  placement?: 'top' | 'inline',
  messageHasContent?: boolean,
): Tail | undefined {
  if (!messageId || !text) return current
  const tail: Tail =
    current?.messageId === messageId
      ? { ...current, segments: [...current.segments] }
      : { messageId, segments: [], reasoningTop: '' }

  if (kind === 'reasoning') {
    const resolved = placement ?? (messageHasContent ? 'inline' : 'top')
    if (resolved === 'top') return { ...tail, reasoningTop: tail.reasoningTop + text }
  }

  const last = tail.segments[tail.segments.length - 1]
  if (last?.kind === kind) {
    tail.segments[tail.segments.length - 1] = { kind, text: last.text + text }
  } else {
    tail.segments.push({ kind, text })
  }
  return tail
}

/**
 * 从尾巴**前端**裁掉 `chars` 个某一种的字符(打包行 / 重折已经覆盖的那一截)。
 *
 * text 走 segments 里的 text 截;reasoning 先裁 reasoningTop(顶部推理开在最前),
 * 再裁 segments 里的 reasoning 截。裁空的截整格移除;全裁光了就没有尾巴。
 * `chars` 超出实有长度时裁到空为止 —— 上限就是从前"整段丢掉"的旧行为。
 */
function trimTailFront(tail: Tail, kind: 'text' | 'reasoning', chars: number): Tail | undefined {
  let left = chars
  let reasoningTop = tail.reasoningTop
  if (kind === 'reasoning' && left > 0 && reasoningTop) {
    const cut = Math.min(left, reasoningTop.length)
    reasoningTop = reasoningTop.slice(cut)
    left -= cut
  }
  const segments: TailSegment[] = []
  for (const segment of tail.segments) {
    if (left > 0 && segment.kind === kind) {
      const cut = Math.min(left, segment.text.length)
      left -= cut
      if (cut < segment.text.length) segments.push({ kind: segment.kind, text: segment.text.slice(cut) })
    } else {
      segments.push(segment)
    }
  }
  if (segments.length === 0 && !reasoningTop) return undefined
  return { messageId: tail.messageId, segments, reasoningTop }
}

/**
 * 打包行(`assistant/chunks`)到了:它装的那一截**离开尾巴**,由账本那份接管。
 *
 * 从前这里是「尾巴整段丢掉」—— 那句话隐含的前提是「打包行覆盖了尾巴的全部」,
 * 在活路上(打包行紧跟着它的最后一条 delta 到达)它几乎总成立。但重折排空攒下的
 * 打包行、或尾巴里已经攒进了打包窗之后的 delta 时,整段丢就把没被打包的那几截
 * 一起丢了 —— 屏幕回缩,等下一条打包行才长回来。所以规则收敛成一条:
 * **一条打包行只带走它自己那么长的一截**(它的 delta 与尾巴前端逐字节相同,
 * `decode∘encode ≡ id`),两者等长时与旧行为逐字相同。
 *
 * 别的消息的打包行不碰这条尾巴(尾巴只有一条,认 `messageId`)。
 */
export function trimTailByChunks(
  tail: Tail | undefined,
  messageId: string | undefined,
  kind: string | undefined,
  chars: number,
): Tail | undefined {
  if (!tail) return undefined
  if (!messageId || tail.messageId !== messageId) return tail
  if (kind !== 'text' && kind !== 'reasoning') return tail
  if (chars <= 0) return tail
  return trimTailFront(tail, kind, chars)
}

/** 一条消息在某份折叠产物上的正文 / 顶部推理长度 —— 重折调解的两把尺。 */
export interface FoldLens {
  content: number
  reasoning: number
}

/**
 * 整份重折完成:把尾巴里**已被新账本覆盖**的前缀裁掉。
 *
 * 重折不经过打包行那条裁剪(它直接换掉整个折叠状态),而尾巴可能从上一条打包行
 * 之后一直攒到现在 —— 新折叠已经装下了其中前面那一截。不裁就是**重影**:同一段
 * 文字折叠里一份、尾巴里一份;素材里带引用块时更坏 —— 折叠正文以 `> …\n` 收尾、
 * 尾巴又从头再来一遍时,两份接起来会让后一份整段变成引用的懒续行,块结构都错了
 * (真机探针抓到的那个多出来的 blockquote)。
 *
 * 尺是**长度差**,不做字符串匹配:流是只追加的,尾巴与折叠覆盖的是同一条流的
 * 两截前后相接的区间 —— 旧折长 + 尾长 = 目前收到的总长,新折长盖过旧折长的部分
 * 就是尾巴该交出去的前缀。夹在 [0, 尾长] 里:新折反而更短(不该发生)就什么都
 * 不裁,新折盖过总长就裁光。
 */
export function reconcileTailAfterRefold(
  tail: Tail | undefined,
  before: FoldLens,
  after: FoldLens,
): Tail | undefined {
  if (!tail) return undefined
  let next: Tail | undefined = tail
  const contentCovered = after.content - before.content
  if (next && contentCovered > 0) next = trimTailFront(next, 'text', contentCovered)
  const reasoningCovered = after.reasoning - before.reasoning
  if (next && reasoningCovered > 0) next = trimTailFront(next, 'reasoning', reasoningCovered)
  return next
}

type AnyPart = { type?: string; content?: string }

/**
 * 尾巴接到**最后那一段**上。
 *
 * 两条纪律(真机回归换来的,与 Vue 壳同源):
 *
 * 1. **只看最后一段,不回头找**。从前是"从尾往前找第一段同类的",于是一段新的
 *    行内推理会被追加进**上一个**推理块里(它前面隔着正文),屏幕上就成了
 *    "两个思考块 + 文字跑错块"。段的开合是账本的事,尾巴只延长**当前那一段**。
 * 2. **顶部推理不进 contentParts**。它的落点是 `message.reasoning`(思考块)。
 *    从前一律当行内挂进 parts,于是同一段思考既进思考块又以正文渲染。
 */
export function appendTail(
  messages: readonly ProjectedMessage[],
  tail: Tail | undefined,
): ProjectedMessage[] {
  const list = [...messages]
  if (!tail) return list
  if (tail.segments.length === 0 && !tail.reasoningTop) return list
  const index = list.findIndex((message) => message.id === tail.messageId)
  if (index < 0) return list

  const message = list[index]
  const parts = [...((message.contentParts ?? []) as AnyPart[])]

  // 账本正文还没物化成 parts(流式中 parts 到 request/end 才出现)时,先按
  // `message.content` 现搭一格 —— 与 anchor 步的兜底同款判据。少了这一格就是
  // 真机上那条「打包行一到正文回缩」的病:尾巴挂上去之后 parts 非空,anchor
  // 不再按 content 兜底,而打包行(2s / 64 条闸)把尾巴收走的那一刻,被打包的
  // 那段正文只活在 content 里 —— 屏幕上就只剩重攒的新尾巴,整段正文消失,
  // 直到 run 收尾 parts 物化才跳回来。
  if (parts.length === 0 && message.content) {
    parts.push({ type: 'text', content: message.content })
  }

  // 只有**第一截**可以延长账本那一段(它就是那一段还没打包的尾巴);其后每一截
  // 都是流上新的一段,各自起一格 —— 用一个局部标记表达,不留任何模块级状态。
  let extendedLedgerPart = false
  for (const segment of tail.segments) {
    if (!segment.text) continue
    const last = parts[parts.length - 1]
    if (!extendedLedgerPart && last?.type === segment.kind) {
      parts[parts.length - 1] = { ...last, content: `${last.content ?? ''}${segment.text}` }
    } else {
      // 账本还没开出这一段(第一条打包行之前):在**末尾**挂一格显示用的尾巴。
      // 它没有 turnIndex 之类的结构信息 —— 那些等账本说话。
      parts.push({ type: segment.kind, content: segment.text })
    }
    extendedLedgerPart = true
  }

  const tailText = tail.segments
    .filter((segment) => segment.kind === 'text')
    .map((segment) => segment.text)
    .join('')

  list[index] = {
    ...message,
    content: `${message.content ?? ''}${tailText}`,
    ...(tail.reasoningTop
      ? { reasoning: `${message.reasoning ?? ''}${tail.reasoningTop}` }
      : {}),
    contentParts: parts,
  } as ProjectedMessage
  return list
}

/* ── overlay 车道 ─────────────────────────────────────────────────────── */

/**
 * 一条**还没进账本**的出站消息。
 *
 * 它按定义不在折叠树上:账本记的是引擎接下了什么,而这一条此刻只存在于
 * 这台渲染层里。所以它是 overlay,不是"折叠少算了一条"。
 */
export interface PendingSend {
  id: string
  kind: 'pending'
  text: string
  /** 随这条消息一起离开输入框的附件数(D3 不传附件,只如实显示计数)。 */
  attachments: number
  status: 'sending' | 'failed'
  /** 失败时那句人话(照抄后端说的,不改写)。 */
  error?: string
  /**
   * 发出那一刻折叠树上**已有的**用户消息 id。
   *
   * 认领靠它:同一句话被连发两遍时,第二条的快照里已经有第一条了,所以两条
   * pending 各自认领各自那一条,不会互相顶掉。
   */
  seenUserIds: readonly string[]
}

/** 本地提示 —— 说的正是"这件事没有进账本",所以账本上永远没有它。 */
export interface LocalNotice {
  id: string
  kind: 'notice'
  /** 文案键由渲染层查字典,这里只记是哪一种。 */
  notice: 'ask-rejected'
}

export type OverlayEntry = PendingSend | LocalNotice

/**
 * 折叠树接管了哪几条 pending —— **以折叠为准**,认领到就丢掉那一格 overlay。
 *
 * 认领判据两条同时成立:正文逐字相同,且那条用户消息的 id **不在**这条 pending
 * 发出时的快照里(= 它是这次发送之后才出现的)。一条真消息只认领一条 pending
 * (按 pending 的先后序贪心),所以连发同一句话不会一次消掉两格。
 *
 * `failed` 的那些**不认领** —— 它们说的是"这条没能到达账本",留着让人重试。
 */
export function reconcileOverlay(
  entries: readonly OverlayEntry[],
  messages: readonly ProjectedMessage[],
): OverlayEntry[] {
  if (entries.length === 0) return []
  const claimed = new Set<string>()
  return entries.filter((entry) => {
    if (entry.kind !== 'pending' || entry.status !== 'sending') return true
    const seen = new Set(entry.seenUserIds)
    const hit = messages.find(
      (message) =>
        message.role === 'user' &&
        message.content === entry.text &&
        !seen.has(message.id) &&
        !claimed.has(message.id),
    )
    if (!hit) return true
    claimed.add(hit.id)
    return false
  })
}

/** 折叠树上的用户消息 id —— 建 pending 时拍的那张快照。 */
export function userMessageIds(messages: readonly ProjectedMessage[]): string[] {
  return messages.filter((message) => message.role === 'user').map((message) => message.id)
}
