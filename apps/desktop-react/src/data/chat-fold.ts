import type { materializeChatMessages } from '@onething/core/session/projection/chat-messages'

/**
 * ⚠️ **这个文件的一大半在退役途中**(R 线 R2,`docs/stream-render-2026-09.md`)。
 *
 * R2 把「活尾巴 + 交接对账」整套换成了**水位表 + 每 part 取 max**(`stream-water.ts`
 * 与 `chat-materialize` 的 `mergeWater`):活流与账本从此是同一个字符串的两个前缀,
 * 对账这件事不存在了。开关 `onething.streamR2` 默认走新路,旧路留到 R3 真机浸泡
 * 结束 —— **一翻即回**,回滚不用改代码。
 *
 * R3 删这一批(以及它们在 `chat-source` 里的那几格状态与 `chat-source.test.ts`
 * 里对应的用例):`Tail` / `TailSegment` / `TailToolCall` / `FoldLens` /
 * `feedTail` / `startTailTool` / `feedTailToolArgs` / `handOverToLedger` /
 * `appendTail` / `tailTextLength` / `tailHostIndex` / `liveToolCall`。
 * **留下的**是与那套机器无关的两件:`ProjectedMessage` 类型别名与 overlay 车道
 * (`reconcileOverlay` / `userMessageIds` / `PendingSend` / `LocalNotice`)——
 * 它们说的是「还没进账本的出站消息」,与流式拼装无关。
 *
 * ── 以下是旧路的原始文件注,原样保留到删除那一天 ──────────────────────
 *
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
  /**
   * 这一截属于**第几轮**(`turnIndex`,流自己盖的号,1 起)。
   *
   * 与 `placement` 同一条理由:它不是尾巴的结构决策,是引擎开这一段时就定下的
   * 事实(`text-delta` / `reasoning-delta` 自带这一格,真机读数见 §「多轮工具」)。
   * 尾巴要它只为一件事 —— **落点**:账本的工具锚点是按 `turnIndex` 就位的
   * (core `synthesizeCoreToolAnchors` → `insertDataStepsByTurn`),尾巴那一格不带
   * 轮次号,锚点就会从它头上跨过去,把新一轮的正文摆到上一轮的工具**上面**。
   *
   * 缺席 = 流没说(老路径 / 测试直调),按第 0 轮处理,与从前逐字相同。
   */
  turnIndex?: number
}

/**
 * 一次**参数还在逐片到达**的调用。
 *
 * 它与文本那两条车道是同一件事的三种形:**账本此刻画不出来的那一截**。
 * 账本要等参数收齐(`tool/call`)才有这次调用,而参数是逐片流的 —— 真机读数:
 * 说完一句话之后屏幕上 **309ms 什么都没有**,真实工具的参数长得多,这个空窗按
 * 比例放大到数秒(用户看到的是"卡住了")。
 *
 * 名字与身份从 `tool:input-start` 事件来(引擎在开这一段时就说了 `toolName`),
 * 参数正文从 `tool-input-delta` 裸 delta 来 —— 两者都是流上的事实,尾巴一个
 * 结构决策都不做:它不判这次调用画在哪(那是锚点的事)、也不判它成没成功。
 */
export interface TailToolCall {
  id: string
  toolName: string
  /** 建卡那一刻(照抄事件里占位调用的时刻,没有就是收到那一刻)。 */
  timestamp: number
  /** 已经到达的参数原文(半截的 JSON 就是半截的 —— 那是事实)。 */
  argsText: string
  /**
   * **上一次收到这次调用的数据是什么时候**(纪元毫秒),活性读数的判据(§6.6)。
   *
   * 建卡那一刻起表,之后每收到一片参数就推到此刻。用的是**收到那一端**的钟
   * (`Date.now()`),不是事件里那个 `timestamp`:要与它相减的是本机的「此刻」,
   * 两个钟相减会在有偏差时读出负数或凭空一分钟的静默。
   *
   * 它随尾巴一起退役,不进账本 —— 「多久没收到数据」是这一台此刻的读数,
   * 不是会话的事实。
   */
  lastDeltaAt: number
}

/**
 * 一次调用**执行中**的过程读数(C2-b)。快照:后一条整条替换前一条,不追加。
 *
 * 与账本那一份的关系写在 `packages/core/session/projection/types.ts` 的
 * `ProjectedToolProgress` 上 —— 一句话:它不进账本,是壳把活流那一份盖上去的。
 */
export type ToolProgress = NonNullable<ProjectedCall['progress']>

/** 尾巴手里那一条:摆给卡看的三格 + 收到它的**本机时刻**(§6.6 活性读数的写点)。 */
export interface TailToolProgress {
  value: ToolProgress
  at: number
}

export interface Tail {
  messageId: string
  /** 按到达顺序的段(**只有文本**,段界来自流本身)。 */
  segments: TailSegment[]
  /** 顶部推理(渲染成思考块;它落在 `message.reasoning`,**不是** part)。 */
  reasoningTop: string
  /** 参数还在流的调用,按到达序。账本一认领(`tool/call` 落账)就退役。 */
  tools: TailToolCall[]
  /**
   * 每次调用此刻的进度读数(键 = `toolCallId`,C2-b)。
   *
   * ── 为什么它**不挂在 `tools` 上** ────────────────────────────────────
   * `tools` 是「参数还在流的调用」,账本一认领(`tool/call` 落账)就退役 ——
   * 而进度恰恰在那之后才开始(参数收齐才轮到执行)。挂上去的那一格会在进度
   * 到达前一刻被删掉,屏幕上一条都看不到。所以它是一张**与退役无关**的表,
   * 随尾巴整条一起丢(这一轮收尾 = 账本是全的,过程读数按定义没用了)。
   */
  progress: Record<string, TailToolProgress>
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
  turnIndex?: number,
): Tail | undefined {
  if (!messageId || !text) return current
  const tail = openTail(current, messageId)

  if (kind === 'reasoning') {
    const resolved = placement ?? (messageHasContent ? 'inline' : 'top')
    if (resolved === 'top') return { ...tail, reasoningTop: tail.reasoningTop + text }
  }

  const last = tail.segments[tail.segments.length - 1]
  // **换了轮次也是新的一段** —— 与"换了种"同一条判据。上一轮的正文与这一轮的正文
  // 中间隔着那一轮的工具锚点,并进一格就等于说它们之间什么都没发生过。
  if (last?.kind === kind && last.turnIndex === turnIndex) {
    tail.segments[tail.segments.length - 1] = { ...last, text: last.text + text }
  } else {
    tail.segments.push({ kind, text, ...(turnIndex !== undefined ? { turnIndex } : {}) })
  }
  return tail
}

/**
 * 尾巴手里**还剩多少正文**(只数正文那条车道;推理不进 `message.content`)。
 *
 * 交接线由它和"这条消息一共收到多少正文"两个数现算:**交接线 = 收到多少 − 还剩多少**。
 * 见 `chat-source` 的 `tailCoverage` —— 两个数都是活的,算出来的线因此不会漂。
 */
export function tailTextLength(tail: Tail | undefined): number {
  if (!tail) return 0
  let total = 0
  for (const segment of tail.segments) if (segment.kind === 'text') total += segment.text.length
  return total
}

/** 换了消息就换一条尾巴 —— 三条车道一起换,上一条的字一格都不许跟过来。 */
function openTail(current: Tail | undefined, messageId: string): Tail {
  return current?.messageId === messageId
    ? { ...current, segments: [...current.segments], tools: [...current.tools] }
    : { messageId, segments: [], reasoningTop: '', tools: [], progress: {} }
}

/**
 * 一次调用开始收参数(`tool:input-start`)。
 *
 * **只记身份与名字**,不判落点、不判状态:落点由锚点说(这次调用还没有锚点,
 * 于是它落在 `anchorMessage` 末尾那句兜底里 —— 而"刚开始的这一次"本来就该在
 * 最后),状态由账本说(尾巴这一份永远是 `input-streaming`,账本一认领就退役)。
 *
 * 幂等:同一个 id 再来一次不重复建卡(重连回放会把同一条事件送两遍)。
 */
export function startTailTool(
  current: Tail | undefined,
  messageId: string,
  toolCallId: string,
  toolName: string,
  timestamp: number,
  /** 建卡的**本机时刻**(活性读数的起表点)。默认此刻;测试传一个数就能钉住。 */
  at: number = Date.now(),
): Tail | undefined {
  if (!messageId || !toolCallId) return current
  const tail = openTail(current, messageId)
  if (tail.tools.some((tool) => tool.id === toolCallId)) return tail
  tail.tools.push({ id: toolCallId, toolName, timestamp, argsText: '', lastDeltaAt: at })
  return tail
}

/**
 * 参数又到一片(`tool-input-delta`)。
 *
 * **没建过卡的 id 一律不认**:名字只有 `tool:input-start` 说得出,没有名字的一行
 * 是编出来的。丢掉这一片的代价是参数区少几个字,而那次调用照旧由账本摆出来。
 */
export function feedTailToolArgs(
  current: Tail | undefined,
  messageId: string,
  toolCallId: string,
  argsTextDelta: string,
  /** 收到这一片的**本机时刻**。默认此刻;测试传一个数就能钉住静默读数。 */
  at: number = Date.now(),
): Tail | undefined {
  if (!current || current.messageId !== messageId || !argsTextDelta) return current
  const index = current.tools.findIndex((tool) => tool.id === toolCallId)
  if (index < 0) return current
  const tools = [...current.tools]
  // 收到就推:活性读数的整条链子就这一句写点(§6.6)。
  tools[index] = {
    ...tools[index],
    argsText: tools[index].argsText + argsTextDelta,
    lastDeltaAt: at,
  }
  return { ...current, tools }
}

/**
 * 一条进度到了(`tool-progress`,C2-b)。
 *
 * 三条纪律,与 `feedTailToolArgs` 逐条对照着看:
 *
 *  · **替换不拼接**:进度是快照,后一条整条盖掉前一条(`outputTail` 是「此刻的
 *    尾几行」,拼起来就成了整段输出的一份复制品,而那是结果不是读数);
 *  · **不必先建过卡**:与参数流那条相反 —— 进度在**执行中**到达,那时账本早就
 *    认领了这次调用、尾巴里那张卡已经退役。要求先建卡等于一条进度都收不到;
 *  · **顺带推 `liveAt`**:活性读数的判据是「上一次收到这次调用的数据是什么时候」
 *    (§6.6),而一条进度正是收到了数据。`card.ts` 的 `stepLiveAt` 因此一个字
 *    都不用改 —— 它早就写着「会报进度的工具接进来之后由进度流继续往前推」。
 *
 * 尾巴不在场(账本已经收尾 / 换了消息)时**不新开一条**:开一条只装进度的尾巴
 * 会让 `tailHostIndex` 把它认成「这条消息还在流」,那是说谎。
 */
export function applyToolProgress(
  current: Tail | undefined,
  messageId: string,
  toolCallId: string,
  progress: ToolProgress,
  /** 收到这一条的**本机时刻**。默认此刻;测试传一个数就能钉住静默读数。 */
  at: number = Date.now(),
): Tail | undefined {
  if (!messageId || !toolCallId) return current
  const tail = openTail(current, messageId)
  const index = tail.tools.findIndex((tool) => tool.id === toolCallId)
  return {
    ...tail,
    progress: { ...tail.progress, [toolCallId]: { value: progress, at } },
    // 参数还在流的那一段里也可能来进度(工具自己先报了一句),那时把这张卡的
    // `lastDeltaAt` 一并推到此刻;卡已经退役就只剩上面那张表,由画的那一层盖。
    tools: index < 0
      ? tail.tools
      : tail.tools.map((tool, i) => (i === index ? { ...tool, lastDeltaAt: at } : tool)),
  }
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
  /**
   * **锚点维**(09-01 P0,真机读数见下)。正文那条**扁平车道**此刻摆得对吗?
   *
   * 账本画正文有两条车道:① `contentParts` 里的 text 格 —— 它们带 `turnIndex`,
   * 工具锚点按轮次插在它们中间,落点永远对;② `message.content` 那一整格扁平正文
   * —— `appendTail` 在 parts 还没物化时按它现搭一格,**这一格是 turn 盲的**,
   * 合成出来的锚点会一路跨到它后面去。
   *
   * 于是:消息一旦有工具活儿而 parts 还一格没物化,车道②就摆不对**新一轮**的正文
   * —— 交给它就是画在工具组**上面**,而 parts 一物化(它只画 parts)那一截当场
   * 从屏幕上消失。真机逐帧(工具素材 6 字/帧):
   *
   * ```
   * t=6647 think | text(14) | text(5)  | tool-group   ← 第二轮正文长在工具组**上面**
   * t=6839 think | text(14) | text(28) | tool-group   ← 错位可见 191ms
   * t=6864 think | text(14) | tool-group | think(6)   ← parts 物化,整段 28 字消失
   *   …… 992ms 屏幕上没有这段字 ……
   * t=7856 think | text(14) | tool-group | text(28) | think(83) | tool
   * ```
   *
   * 这一格 `false` 时正文那条尺**一个字都不给** —— 尾巴留着它,由尾巴带着轮次号
   * 画在锚点之后。缺席 = `true`(没有工具活儿的消息永远是这样,与从前逐字相同)。
   */
  contentPlaceable?: boolean
  /**
   * 账本此刻画得出来的调用 id。活调用**按身份退役**,不按长度 —— 一次调用是不是
   * "账本有了"是个是非题,没有"交出去一半"这回事。
   */
  ledgerToolCallIds?: ReadonlySet<string>
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

export function handOverToLedger(tail: Tail | undefined, covered: FoldLens, capacity: FoldLens): HandOver {
  const credit = {
    // 锚点维:扁平车道摆不对这一轮的正文时,额度是 0(见 `FoldLens.contentPlaceable`)。
    text: capacity.contentPlaceable === false ? 0 : Math.max(0, capacity.content - covered.content),
    reasoningTop: Math.max(0, capacity.reasoningTop - covered.reasoningTop),
    reasoningInline: Math.max(0, capacity.reasoningInline - covered.reasoningInline),
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
      segments.push({ ...segment, text: segment.text.slice(cut) })
    }
  }

  /*
   * 活调用**按身份退役**:账本认领了这个 id(`tool/call` 落账 → `toolCalls[]` 里
   * 有它),尾巴这一份当场丢掉。不按长度、也不排顺序闸 —— 它与文本那两条车道不
   * 共用额度,一次调用要么账本有、要么没有。
   */
  const ledgerIds = capacity.ledgerToolCallIds
  const tools = ledgerIds ? tail.tools.filter((tool) => !ledgerIds.has(tool.id)) : tail.tools

  /*
   * 进度那张表**跟着尾巴走,不随交接退役**(C2-b):账本认领这次调用之后它才开始
   * 报,`tools` 里那一格没了不代表进度该没。整条丢发生在这一轮收尾(chat-source
   * 收到 stream-complete 就把尾巴丢掉)—— 那时账本是全的,过程读数按定义没用了。
   *
   * 三条车道都空、且**一条进度都没有**才算尾巴退场:剩一条进度就还有东西要画。
   */
  const progress = tail.progress
  const hasProgress = Object.keys(progress).length > 0
  if (segments.length === 0 && !reasoningTop && tools.length === 0 && !hasProgress) {
    return { tail: undefined, taken }
  }
  return { tail: { messageId: tail.messageId, segments, reasoningTop, tools, progress }, taken }
}

type AnyPart = { type?: string; content?: string; turnIndex?: number }

/**
 * 尾巴接到**最后那一段**上。
 *
 * 三条纪律(真机回归换来的,与 Vue 壳同源):
 *
 * 1. **只看最后一段,不回头找**。从前是"从尾往前找第一段同类的",于是一段新的
 *    行内推理会被追加进**上一个**推理块里(它前面隔着正文),屏幕上就成了
 *    "两个思考块 + 文字跑错块"。段的开合是账本的事,尾巴只延长**当前那一段**。
 * 2. **顶部推理不进 contentParts**。它的落点是 `message.reasoning`(思考块)。
 *    从前一律当行内挂进 parts,于是同一段思考既进思考块又以正文渲染。
 * 3. **跨轮不合并、尾巴那几格带轮次号**(09-01 P0)。合并判据从"末段同种"改成
 *    "末段同种**且同轮**":工具锚点是按 `turnIndex` 插进 parts 的,把第二轮的正文
 *    并进第一轮那一段,锚点就会从整段头上跨过去 —— 屏幕上第二轮的正文画在第一轮的
 *    工具组**上面**(真机 191ms),而 parts 一物化它当场消失 992ms。详见 `FoldLens`
 *    的 `contentPlaceable`。
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
   *
   * **这条缺省是脚手架,不是生产路径**(09-01 记一笔):生产上尾巴与交接线同生共死
   * (`chat-source` 的 `tail` / `tailLens`),所以有尾巴就一定有这个数。缺省那一支
   * 假设的是「尾巴整段都在账本之外」—— 假设一旦不成立,账本画一遍、尾巴再画一遍,
   * 屏幕上就是用户 09-01 报的那一形(表画出来了,原始字符串还在)。本批施工中途
   * 恰好造过这个状态(交接线改名的那一瞬,`compose` 递进来的是 undefined),
   * 用户的 dev 实例热更吃到了它 —— 记在这里,别再把这两格拆开传。
   */
  contentCoverage?: number,
): ProjectedMessage[] {
  const list = [...messages]
  /*
   * **补那一截的活儿不归尾巴管**(09-01 自查帧证:`t=3659` 一帧里块数 2→0、
   * 正文 786→371,下一帧原样回来)。
   *
   * 病根是这一句从前写成 `if (!tail) return list`:尾巴刚把手里的字**交清**的那
   * 一瞬(`handOverToLedger` 全部裁完就返回 undefined),整个函数直接掉头 ——
   * 于是「账本 parts 还画不到的那一截」也没人画。那一截正是多轮消息里**还没结算
   * 的这一轮**的全部正文,屏幕上当场少掉一大块,下一条 delta 把尾巴重新造出来
   * 才回来。~17ms 肉眼难见,但它是数据层真丢了一次。
   *
   * 判据回到本来的样子:**账本的正文比 parts 长,那一截就要画**,与尾巴在不在无关。
   * 尾巴只决定两件事:画到哪儿为止(交接线)、后面再接哪几段。
   */
  const index = tailHostIndex(list, tail)
  if (index < 0) return list

  const message = list[index]
  const ledgerParts = (message.contentParts ?? []) as AnyPart[]
  const parts = [...ledgerParts]

  /*
   * ── ① 账本的正文里,parts 还画不到的那一截 ────────────────────────────
   *
   * `message.content` 是**全部**正文(投影的 `materializePartText` 不看这一轮收没
   * 收齐),而 `contentParts` 只有**已结算那几轮**(`requestSettled` 那道闸)。
   * 两者在多轮工具的中间态必然不等,差出来的就是这一截。
   *
   * parts 为空时它就是从前那句"按 content 现搭一格"的兜底,一字不差 —— 少了它
   * 就是真机上那条「打包行一到正文回缩」的病(打包行把尾巴收走,那段正文只活在
   * content 里,屏幕上只剩重攒的新尾巴)。
   *
   * parts 非空时它是**这一轮还没结算**的正文,所以带上尾巴那一轮的轮次号:不带
   * 的话它算第 0 轮,上一轮的工具锚点会插到它**后面**去(见文件注纪律 3)。
   */
  let coveredByParts = 0
  for (const part of ledgerParts) {
    if (part.type === 'text') coveredByParts += part.content?.length ?? 0
  }
  const content = message.content ?? ''
  // 没有尾巴 = 账本手里就是全部,这一截整段都归它画(没有第二个人会再画一遍)。
  const limit = tail === undefined || contentCoverage === undefined
    ? content.length
    : Math.max(0, contentCoverage)
  const pending = content.slice(coveredByParts, Math.max(coveredByParts, limit))

  /*
   * **账本已经画过的字,尾巴不许再画一遍**(09-01,用户真机证词:「markdown 的渲染
   * 很奇怪,它会显示原始字符串,其实 table 已经画出来了」——同一截内容被画了两遍,
   * 一份成了表、一份还是原始 markdown)。
   *
   * 两个数是这一层自己就知道的:账本这一帧画了 `ledgerDrawn` 个字的正文(parts 里
   * 那些 + 上面补出来的那一截),而尾巴的正文从 `content` 的第 `tailStart` 个字起
   * (交接线,`contentCoverage`)。账本画过了头 —— parts 一次物化就可能比交接线跑得
   * 远 —— 中间这一段就是**两边都会画**的那一截,在这里剪掉。
   *
   * 为什么剪在画的这一层而不是交接那一层:交接决定的是**归属**(这一截该谁负责),
   * 它有自己的顺序闸,一帧交不出去是正常的;而"屏幕上不许出现两遍"是**显示的
   * 不变量**,任何一帧都必须成立。两件事分开,少了哪一个都不对。
   *
   * `contentCoverage` 缺席(重折 / 测试直调 / 尾巴不在场)时按"尾巴整段都在账本
   * 之外"处理 —— 与从前逐字相同,剪 0 个字。
   *
   * ── 这把尺靠不靠得住,全看那条交接线准不准(09-01 自查续)─────────────
   * 交接线从前是**累加** `taken.content` 攒出来的,而累加会漂。漂在表格上的代价
   * 不是"少几个字":分隔行多一格或少几个字,表头 8 列对不上分隔行的格数,GFM
   * 当场判它不是表 —— 整张表退回裸文本 350ms+(自查 3 轮 2 复现)。
   * 所以交接线改成**现算**:`收到多少 − 尾巴手里还剩多少`(见 chat-source 的
   * `tailCoverage` 与本文件的 `tailTextLength`),两个活数,不累加、不会漂。
   */
  const ledgerDrawn = Math.max(coveredByParts, Math.min(content.length, limit))
  const tailStart = tail === undefined || contentCoverage === undefined
    ? ledgerDrawn
    : Math.max(0, contentCoverage)
  let overlap = Math.max(0, ledgerDrawn - tailStart)
  // 这一截与尾巴**第一段**是同一轮:它就是那一轮里已经打包、但还没结算成 part 的
  // 前半截。尾巴一段都没有(只有顶部推理 / 只有活调用)时不猜,留空。
  const pendingTurn = ledgerParts.length > 0 ? tail?.segments[0]?.turnIndex : undefined
  if (pending) {
    parts.push({
      type: 'text',
      content: pending,
      ...(pendingTurn !== undefined ? { turnIndex: pendingTurn } : {}),
    })
  }

  /*
   * ── ② 尾巴那几段 ───────────────────────────────────────────────────
   *
   * 延长末格的判据是「同种 **且** 同轮」。同种是从前那一条(段的开合听账本的);
   * 同轮是这一批补的锚点维 —— 尾巴的段自带轮次号(流说的),账本的 text part 也
   * 自带轮次号(投影给的),两者对得上才是同一段话的前后半截。
   */
  const drawn: TailSegment[] = []
  for (const segment of tail?.segments ?? []) {
    // 重叠只从**正文**那几段里剪:推理不进 `message.content`,账本画它的是另一条
    // 车道(`reasoningInline`),拿正文的账去剪推理是串仓。
    let text = segment.text
    if (segment.kind === 'text' && overlap > 0) {
      const cut = Math.min(overlap, text.length)
      overlap -= cut
      text = text.slice(cut)
    }
    if (!text) continue
    drawn.push({ ...segment, text })
    const last = parts[parts.length - 1]
    if (last?.type === segment.kind && last.turnIndex === segment.turnIndex) {
      parts[parts.length - 1] = { ...last, content: `${last.content ?? ''}${text}` }
    } else {
      parts.push({
        type: segment.kind,
        content: text,
        ...(segment.turnIndex !== undefined ? { turnIndex: segment.turnIndex } : {}),
      })
    }
  }

  const tailText = drawn
    .filter((segment) => segment.kind === 'text')
    .map((segment) => segment.text)
    .join('')

  /*
   * ── ③ 参数还在流的那几次调用 ────────────────────────────────────────
   *
   * 挂在 `toolCalls` 上而不是自己造一个锚点 part:锚点是账本的坐标系
   * (`synthesizeCoreToolAnchors` 见了 `tool-call`/`data-steps` 就整条不动手),
   * 往 parts 里塞一个假锚点会把**真**锚点的合成一起关掉。挂在 `toolCalls` 上,
   * `anchorMessage` 末尾那句"锚点没认领到的调用摆出来"自然把它排在最后 ——
   * 而"刚刚开始的这一次"本来就该在最后。
   *
   * 账本已经有的 id 一律不画(交接那一步已经退役过一轮,这里是第二道闸:
   * 少一张卡是说谎,多一张是重影)。
   */
  const liveCalls = (tail?.tools ?? []).filter(
    (tool) => !(message.toolCalls ?? []).some((call) => call.id === tool.id),
  )

  /*
   * ── ④ 进度那一层(C2-b)────────────────────────────────────────────
   *
   * 进度**盖在账本那份调用上**,不是另画一张卡:一次调用开始执行时账本早就
   * 认领了它(`tool/call` 已落账),尾巴里那张卡也已退役 —— 屏幕上就是那一行。
   * 所以这一层做的是「按 id 把三格盖上去」,`liveAt` 顺带推到收到进度的时刻
   * (§6.6 静默读数因此在有进度的工具上永不误报)。
   *
   * 只盖**还在跑**的那几次:收场了的调用再挂一份过程读数是给屏幕留下一句
   * 关于过去的现在时(而且那一行的摘要该是成果,不是最后一行输出)。
   */
  const progressMap = tail?.progress
  const ledgerCalls = message.toolCalls ?? []
  const paintedCalls = progressMap && Object.keys(progressMap).length > 0
    ? applyProgressToCalls(ledgerCalls, progressMap)
    : ledgerCalls

  // 什么都没多画 = 一个字段都别动:下游按**引用**判「这一帧变没变」(chat-materialize
  // 的 memo 与 assemble 的 WeakMap 都认它),换个长得一样的新对象等于全体重装配。
  // 进度也算「多画了」—— 少了这一条,一行工具的摘要逐帧在变而屏幕一动不动。
  if (
    !pending
    && drawn.length === 0
    && !tail?.reasoningTop
    && liveCalls.length === 0
    && paintedCalls === ledgerCalls
  ) return list

  const tailCalls = liveCalls.map((tool) => liveToolCall(tool, progressMap?.[tool.id]))

  list[index] = {
    ...message,
    content: `${content}${tailText}`,
    ...(tail?.reasoningTop
      ? { reasoning: `${message.reasoning ?? ''}${tail.reasoningTop}` }
      : {}),
    contentParts: parts,
    ...(tailCalls.length > 0 || paintedCalls !== ledgerCalls
      ? { toolCalls: [...paintedCalls, ...tailCalls] }
      : {}),
  } as ProjectedMessage
  return list
}

/**
 * 把进度盖到账本那几次调用上(C2-b)。
 *
 * **一格没盖就原样交回原数组**(引用相等):上面那句短路与下游的 memo 全靠它 ——
 * 每帧造一个长得一样的新数组等于把整条消息重装配一遍。
 */
function applyProgressToCalls(
  calls: readonly ProjectedCall[],
  progress: Record<string, TailToolProgress>,
): readonly ProjectedCall[] {
  let next: ProjectedCall[] | undefined
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]
    const found = progress[call.id]
    // 只盖还在跑的那几次(执行中 / 参数还在流)。
    if (!found || !LIVE_CALL_STATUSES.has(call.status)) continue
    if (!next) next = [...calls]
    next[i] = { ...call, progress: found.value, liveAt: Math.max(found.at, call.liveAt ?? 0) }
  }
  return next ?? calls
}

/**
 * 「这次调用还在跑」的那两档。
 *
 * 与 `content/tools/status.ts` 的 `toolTone` busy 档同一张表,但**不 import 它** ——
 * 数据层不吃渲染层(反过来才对)。两处各一行,变了要一起改。
 */
const LIVE_CALL_STATUSES: ReadonlySet<string> = new Set(['executing', 'input-streaming'])

/**
 * 一次还在收参数的调用**长成账本那份调用的样子**。
 *
 * 三格是编出来的、且必须是这三格:`arguments` 空(参数还没定稿,解半截 JSON 就是
 * 猜)、`status` 是 `input-streaming`(后端自己那份占位调用写的正是这一档,见
 * core `createCoreToolInputStartArtifacts`)、`streamingArgs` 是收到的原文。
 * 与投影给"孤儿参数流"造的那份逐格同形 —— 屏幕上因此认不出这一份是壳造的。
 */
/**
 * 这一帧要补的是哪一条消息。
 *
 * 有尾巴就认尾巴的主人;**没有尾巴时认「还在流的那一条」** —— 只有它可能出现
 * 「账本正文比 parts 长」(parts 要等 `request/end` 才结算)。认它而不是遍历全表,
 * 是因为这一步每帧都跑:遍历会把 `chat-materialize` 那份按节点缓存的便宜重新赔掉。
 */
function tailHostIndex(list: readonly ProjectedMessage[], tail: Tail | undefined): number {
  if (tail) return list.findIndex((message) => message.id === tail.messageId)
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if ((list[i] as { isStreaming?: boolean }).isStreaming) return i
  }
  return -1
}

type ProjectedCall = NonNullable<ProjectedMessage['toolCalls']>[number]

function liveToolCall(tool: TailToolCall, progress?: TailToolProgress): ProjectedCall {
  return {
    id: tool.id,
    toolId: tool.toolName,
    toolName: tool.toolName,
    arguments: {},
    status: 'input-streaming',
    timestamp: tool.timestamp,
    streamingArgs: tool.argsText,
    // 活性读数(§6.6):与 streamingArgs 同生共死,账本一认领两格一起没。
    liveAt: tool.lastDeltaAt,
    // 参数还在流的那一段里工具就报了进度(少见但合法):照样摆出来。
    ...(progress ? { progress: progress.value } : {}),
  } as ProjectedCall
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
