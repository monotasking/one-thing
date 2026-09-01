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

/*
 * 尾巴的三条**车道**(名字见 `FoldLens` 的三格):`text` → 账本的 `message.content`;
 * `reasoningTop` → `message.reasoning`(只装 `placement:'top'` 那一段);
 * `reasoningInline` → `contentParts` 里的 reasoning 格。
 *
 * 从前只有 text / reasoning 两档,于是顶部推理与行内推理共用一把尺、共用一次裁剪
 * (先裁 top 再裁 inline)。两者物化时刻不同,合成一格就必然裁错人。
 */

/**
 * 一条消息在某份折叠产物上**此刻画得出来**的三个量 —— 交接的三把尺。
 *
 * 「画得出来」是这把尺的全部要害,也是 09-01 那条报障的病根所在:
 *
 *  - `content` = `message.content`。`appendTail` 有「parts 空就按 content 现搭一格」
 *    的兜底,所以正文**一进账本就画得出来**;
 *  - `reasoningTop` = `message.reasoning`。思考块的产地,同样一进账本就画得出来;
 *  - `reasoningInline` = `contentParts` 里 reasoning 格的长度和。**它要等 parts
 *    物化**(流式期间 `materializeChatMessages` 只给 content 与 top 推理,行内推理
 *    在账本投影里一个字都没有)。
 *
 * 三个量分开量,是因为它们物化的时刻不同 —— 把它们并成一格,就会拿「正文进账本了」
 * 当成「行内推理也进账本了」,于是把还没有第二个产地的思考段从尾巴上裁走。
 */
export interface FoldLens {
  content: number
  reasoningTop: number
  reasoningInline: number
}

/**
 * **尾巴交接的唯一一条规则**:账本这一刻多画得出来多少,尾巴就交出多少。
 *
 * 活路(打包行到达)与重折(整份换状态)共用它 —— 从前是两条:活路按**打包行
 * 自己的字符数**裁,重折按**长度差**裁。两条尺量的不是同一件事,而错的是活路那条。
 *
 * ── 病历:行内推理整块消失 2166ms(09-01 用户录屏报障)────────────────────
 * 打包行 `assistant/chunks` 只是「这一截进账本了」,**不等于「这一截画得出来」**。
 * 流式期间账本投影里根本没有行内推理(它要等 `contentParts` 物化),而旧的
 * `trimTailByChunks` 一见打包行就按它的字符数把那截从尾巴前端裁掉 —— 于是这一段
 * 思考在**尾巴里没有了、账本里画不出来**,屏幕上整块消失,直到下一次 parts 物化
 * 才跳回来。真机探针读数:t=7441ms 结构从 `[think,text,think]` 变成 `[think,text]`,
 * 消失同帧后面的正文还在继续长;t=9607ms 才回来。表现给用户就是「思考出现、消失、
 * 再出现」,而且第三段思考消失那一帧,它后面的新正文被串接进了上一段正文里。
 *
 * 换成长度差之后,判据回到一句话:**尾巴是「账本还画不出来的那一截」**。
 * 打包行进来但 parts 还没物化 → 三把尺一动不动 → 一个字都不裁 → 块留在屏上;
 * parts 物化那一刻 → `reasoningInline` 一次涨够 → 尾巴一次交清 → 不重影也不留空。
 *
 * 尺是**长度差**,不做字符串匹配:流是只追加的,尾巴与账本覆盖的是同一条流前后
 * 相接的两截 —— 账本量 + 尾长 = 目前收到的总长。新账本反而更短(`message/patched`
 * 剥字段这类)就什么都不裁;盖过总长就裁光。三条车道各裁各的,互不越界。
 */
export interface HandOver {
  tail: Tail | undefined
  /** 这一次**真交出去**了多少(各车道)。调用方拿它推进「账本画到哪儿了」。 */
  taken: FoldLens
}

export function handOverToLedger(tail: Tail | undefined, before: FoldLens, after: FoldLens): HandOver {
  const credit = {
    text: Math.max(0, after.content - before.content),
    reasoningTop: Math.max(0, after.reasoningTop - before.reasoningTop),
    reasoningInline: Math.max(0, after.reasoningInline - before.reasoningInline),
  }
  const taken: FoldLens = { content: 0, reasoningTop: 0, reasoningInline: 0 }
  if (!tail) return { tail: undefined, taken }

  /*
   * **从前往后走,一遇到交不干净的就停** —— 这一条不是保守,是顺序的唯一保障。
   *
   * 账本在流式期间只有一格扁平的 `message.content`(全部正文折在一起),它表达不了
   * 「正文、思考、正文」这种交替。所以一旦尾巴前面还压着一截账本画不出来的东西
   * (典型:行内推理),它**后面**的正文就不能交出去 —— 交了就会被账本那一格拉到
   * 前面去,屏幕上思考段整块搬家、还和下一段思考并成一块。修第一版时真机探针就
   * 抓到过这一形:t=4.8s 结构变成 `think|text|表|text|think(205)`,两段思考并了。
   */
  let reasoningTop = tail.reasoningTop
  let stopped = false
  if (reasoningTop) {
    const cut = Math.min(credit.reasoningTop, reasoningTop.length)
    taken.reasoningTop = cut
    reasoningTop = reasoningTop.slice(cut)
    if (reasoningTop) stopped = true
  }

  const segments: TailSegment[] = []
  for (const segment of tail.segments) {
    if (stopped) {
      segments.push(segment)
      continue
    }
    const isText = segment.kind === 'text'
    const left = isText ? credit.text - taken.content : credit.reasoningInline - taken.reasoningInline
    const cut = Math.min(Math.max(0, left), segment.text.length)
    if (isText) taken.content += cut
    else taken.reasoningInline += cut
    if (cut < segment.text.length) {
      stopped = true
      segments.push({ kind: segment.kind, text: segment.text.slice(cut) })
    }
  }

  if (segments.length === 0 && !reasoningTop) return { tail: undefined, taken }
  return { tail: { messageId: tail.messageId, segments, reasoningTop }, taken }
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
  /**
   * 账本的 `message.content` 里,**已经交接给账本**的那一截有多长。
   *
   * 兜底那一格只许画到这儿为止:交接是从前往后停的(见 `handOverToLedger`),
   * 尾巴前面压着账本画不出来的东西时,它后面的正文**还在尾巴里**——那一截同时
   * 也在账本的 `content` 里(打包行早把它送进去了)。整格画出来就是画两遍,而且
   * 画在了错的位置(账本那一格是扁平的,排在所有尾巴段之前)。
   *
   * 缺席 = 不设限(整格画完):重折/测试里的直接调用照旧,与从前逐字相同。
   */
  contentCoverage?: number,
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
    const covered =
      contentCoverage === undefined
        ? message.content
        : message.content.slice(0, Math.max(0, contentCoverage))
    if (covered) parts.push({ type: 'text', content: covered })
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
