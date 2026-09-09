import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { chatSources, useChatSourceOf } from '../data/chat-source'
import { sessionRefIdOf } from './session-ref'
import type { OverlayEntry, ProjectedMessage } from '../data/chat-fold'
import { useT, type TFn } from '../i18n'
import { resolveIcon } from '../components/icons'
import { ButtonBase } from '../ui/ButtonBase'
import { assembleMessage, segmentKey } from './assemble'
import { ContextDeltaChip } from './ContextDeltaChip'
import type { SegmentModel } from './model/segments'
import { MessageActions } from './message/MessageActions'
import { StreamReadout } from './message/StreamReadout'
import { MessageSourceFoot } from './research/SourceFoot'
import { SegmentView } from './SegmentView'
import { FocusScope } from '../focus/FocusScope'
import { Dots } from '../ui/Dots'
import { FollowPill } from './FollowPill'
import {
  FOLLOW_PINNED,
  followShouldStick,
  reduceFollow,
  type FollowEvent,
  type FollowState,
} from './follow'
import s from './ChatStream.module.css'

const ClipIcon = resolveIcon('Paperclip')
const RetryIcon = resolveIcon('RotateCcw')

interface Props {
  /**
   * **这一片聊天画的是哪条会话**(W5-a)。
   *
   * 从前它自己去 `expose` 里取「当前会话」—— 那是「全应用只有一条会话在屏上」
   * 那个前提在组件里的形状。会话多开之后「看哪一条」是**这一片叶的事实**,
   * 由摆它的那一层给(`content/kinds/chat.tsx`;W5-b 换成叶自己的 `ref.key`),
   * 于是同一个组件可以并排开两片,各看各的。空串 = 还没有会话(空态)。
   */
  sessionId: string
  /** 滚动容器的 ref:TOC 要靠它量坐标、滚过去 */
  scrollRef?: RefObject<HTMLDivElement | null>
  onScroll?: () => void
  /** 正在高亮淡出的那条消息 id;null = 没有 */
  flashMessageId?: string | null
}

/**
 * 聊天区 —— **屏幕上画的就是 core 折叠器的输出**(D3,路线 A)。
 *
 * 这里是「怎么摆」,不是「摆什么」:一条消息长什么样由它自己的字段说了算,
 * 组件不推导任何结构(轮次、段落归属、工具卡挂在谁身上,全在折叠产物里)。
 *
 * ── 锚点约定 ──────────────────────────────────────────────────────────
 * 每条消息外框上挂 `data-message-id`。这是 TOC 与聊天区之间**唯一**的接缝:
 * 钢琴键的键来自 `sessions.getUserMarkers`(用户消息 id),落点就按这个属性找。
 * D1 时键的下标(真锚点列)与页面上的锚点(mock 轮次)并不同源,那条尾巴在
 * 这一批收掉了 —— 两边现在说的是**同一个 id**。
 *
 * ── 内容怎么画,不在这个文件里 ────────────────────────────────────────
 * assistant / system 那一支不再自己拼 JSX:一条消息经**装配管线**
 * (`assemble/`)算成一串段,这里只把段依次摆下去。ChatStream 因此不认识
 * 段落、代码块、工具卡里的任何一个 —— 加一种块 / 换一种工具展示,这个文件不动。
 *
 * 今天画出来的东西与从前逐字相同(纯文本正文 + 思考块 + 一行工具摘要):
 * P0 交付的是结构,markdown / 高亮 / diff / 工具三件套是后批(§9)。
 */
export function ChatStream({ sessionId, scrollRef, onScroll, flashMessageId }: Props) {
  const t = useT()
  /*
   * 七格全部经 `useChatSourceOf(sessionId, …)`:读的是**这条会话自己那台机器**,
   * 而不是「模块里的那一个」。租约也在那只 hook 里(渲染期保证有东西可读、挂载期
   * 持有一份引用),所以这一层不再有 `open()` 那只 effect —— 「换会话」这件事在
   * 组件这一端已经退化成「换一个 prop」。
   */
  const status = useChatSourceOf(sessionId, (st) => st.status)
  const error = useChatSourceOf(sessionId, (st) => st.error)
  const messages = useChatSourceOf(sessionId, (st) => st.messages)
  const activeMessageId = useChatSourceOf(sessionId, (st) => st.activeMessageId)
  const overlay = useChatSourceOf(sessionId, (st) => st.overlay)

  /*
   * **起底这条会话**(幂等)。W5-a 时这条 effect 还顺手宣布了一句「当前会话」——
   * **W5-b 把那一句撤了**:「当前」由焦点叶投影说了算(`content/session-projection.ts`),
   * 一片没获得焦点的会话叶不该替全局改那一格。
   *
   * 机器的**寿命**同样不再挂在这条 effect 上:它由那条投影按「树里 ∪ 隐藏表里
   * 还有没有这条会话」持有,所以隐藏起来的会话叶照样收流(裁定:hidden 的实例
   * 留着)。这里留下的只有一句「把它拉起来」—— 起底幂等,重复调不会再拉一次。
   */
  useEffect(() => {
    chatSources.acquire(sessionId)
    return () => chatSources.release(sessionId)
  }, [sessionId])

  /*
   * 跟随盯的是**数据源自己报的会话**。W5-a 之前这两者会差一拍(那台单例要等
   * effect 里的 `open()` 才掉头),现在一条会话一台机器,数据源那一格与 `messages`
   * 仍是**同一次 set** 写的 —— 判据一个字没改,只是不再有那一拍的差。
   */
  const foldedSessionId = useChatSourceOf(sessionId, (st) => st.sessionId)
  /*
   * 「自己刚发了一条」的那一拍。**不靠 `messages.length` 的差去猜** —— 重折、
   * 账本追上来、overlay 被认领,三条路都会让长度变,而它们一条都不是「我按了发送」。
   * 号的产地在 `chat-source.send()`,与那条 overlay 同一次 `set`。
   */
  const sentTick = useChatSourceOf(sessionId, (st) => st.sentTick)
  const lastDeltaAt = useChatSourceOf(sessionId, (st) => st.lastDeltaAt)
  /*
   * `lastDeltaAt` / `activeMessageId` 两格**传进 hook**,不在这一层派发。
   * 理由是产地唯一:跟随事件今天六种,六种全在 `useFollowBottom` 里发 —— 那只
   * hook 因此是「什么算一次跟随事件」的完整答案。把其中一种挪到组件里,读代码的人
   * 就得同时看两处才知道状态机被谁推过,而 `dispatch` / `followRef` 那对镜像也得
   * 跟着漏出去(它们是 hook 的内脏)。
   */
  const { follow, jumpToBottom, onScrollWithFollow } = useFollowBottom(
    scrollRef,
    foldedSessionId,
    messages,
    sentTick,
    lastDeltaAt,
    activeMessageId,
    onScroll,
  )

  /*
   * ── 消息流是响应链上的一格 `region`(09-03 R2)──────────────────────────────
   * 它自己**一条键都不认**:没有局部键表、不声明 `onEscape`(所以根本不进 Esc
   * 候选表)。接树买到的是另外两件:①它成了「焦点此刻在哪块面」的一个合法答案 ——
   * 点在消息正文的空白处、或者浮层关掉之后焦点回落,都有一格能接住,不会掉到
   * body 上(I1);②「打开什么焦点进什么」那条规则里,主内容区有一个说得出名字的
   * 落点(壳启动时输入面板还没到位就退到它,见 `AppShell` 的规则 1)。
   * 落点用缺省档(根本身,`tabIndex=-1` 由 `scopeProps` 铺)—— 消息流里没有
   * 一个「该落在这儿」的控件,落在这块面上正是「我在读这一段」的意思。
   */
  return (
    /*
     * **`chat` 是一族带 owner 的作用域**(W5-b 裁定 6,照 `scopes.ts` 的 `leaf`
     * 样板):会话多开之后同一个 scope id 会有好几份实例,而
     * `activateScope('chat', { owner })` 要精确取到**这一条会话**那一份 ——
     * 壳启动那条三级回落(`AppShell`:composer → chat(焦点叶的)→ root)问的
     * 正是它。owner 是这一格的 refId,翻译只有 `sessionRefIdOf` 一处。
     */
    <FocusScope scope="chat" owner={sessionRefIdOf(sessionId)} rootRef={scrollRef}>
      {({ scopeProps }) => (
        <>
        <div {...scopeProps} className={s.scroll} onScroll={onScrollWithFollow} data-testid="chat-stream">
          <div className={s.column}>
            {/* 三种空态各说各话,一种都不回退到假数据(与 D1 同一条纪律)。 */}
            {!sessionId && <p className={s.empty}>{t('chat.noSession')}</p>}
            {sessionId && status === 'loading' && <p className={s.empty}>{t('chat.loading')}</p>}
            {sessionId && status === 'error' && (
              <p className={s.empty}>
                {t('chat.error')}
                <span className={s.errorText}>{error}</span>
              </p>
            )}
            {sessionId && status === 'ready' && messages.length === 0 && overlay.length === 0 && (
              <p className={s.empty}>{t('chat.empty')}</p>
            )}

            {messages.map((message) => (
              <MessageRow
                key={message.id}
                t={t}
                sessionId={sessionId}
                message={message}
                streaming={message.id === activeMessageId}
                flash={message.id === flashMessageId}
                /*
                 * 活性读数只交给**正在跑的那一条**。其余每一行拿到的都是 `undefined`
                 * —— 一个恒定的值,所以 `memo` 的浅比照旧短路(流式期间除活消息外
                 * 全篇不重渲那条纪律一格没动)。
                 */
                lastDeltaAt={message.id === activeMessageId ? lastDeltaAt : undefined}
              />
            ))}

            {overlay.map((entry) => (
              <OverlayRow key={entry.id} t={t} entry={entry} sessionId={sessionId} />
            ))}
          </div>
        </div>
        {/*
          * 丸是**滚动容器的兄弟**,不是它的孩子 —— 装在滚动容器里的绝对定位件会
          * 跟着内容一起滚走。它落在 `.chatArea` 里(那是 AppShell 给的定位参考系),
          * 坐进输入框上方那段气口的正中(几何全在 FollowPill.module.css 里算)。
          */}
        <FollowPill
          follow={follow}
          streaming={activeMessageId !== undefined}
          onJump={jumpToBottom}
        />
        </>
      )}
    </FocusScope>
  )
}

/**
 * **聊天跟随**(C1 §5.1–§5.5)。进场落底、流式跟底、上翻交还、发送与回复的
 * 两张脸,四件事从此是同一个状态机的几格 —— 判据在纯函数 `content/follow.ts`,
 * 这只 hook 只做三件它做不了的:量几何、赋 `scrollTop`、把事件喂进去
 * (六种事件的产地全在这里,一个都没有漏到组件层去发)。
 *
 * ── 它取代了什么 ──────────────────────────────────────────────────────────
 * 08-31 的 `useEnterAtBottom`(进场落底)。那一版有一个**故意留的出口二**:
 * 「消息树换了引用就结束盯底」—— 理由写着「跟底是另一件事,本批不做」。
 * 本批做的正是那另一件事,所以出口二连同它的 `landedOnRef` 一起删了:
 * 「盯到什么时候为止」这个问题现在有了正经答案 —— 盯到人自己往上翻为止。
 *
 * ── 三条纪律,一条没变 ────────────────────────────────────────────────────
 * ① **首帧就在底,不许先画顶部再跳**。所以是 `useLayoutEffect` 而不是 `useEffect`:
 *    前者在浏览器绘制**之前**跑完;也因此是 `scrollTop = …` 直接赋值,不是
 *    `scrollTo({behavior:'smooth'})` —— 定位不是动效(动效档「无」下它照样得工作)。
 * ② **落底要熬过内容自己长高**。代码高亮(shiki)与图(mermaid)是异步渲染的,
 *    落完之后那些块会把页面撑高几百像素。所以盯着**内容那一层**的高度变化
 *    (ResizeObserver),长高一次就再落一次 —— 流式跟底吃的是同一只观察者。
 * ③ **没有计时器、没有「这一下是我自己滚的」标志位**(判据的全文写在 follow.ts
 *    的文件头)。我们自己落底那几下正正好在底,人往上翻才会离底。
 */
function useFollowBottom(
  scrollRef: RefObject<HTMLDivElement | null> | undefined,
  sessionId: string,
  messages: readonly ProjectedMessage[],
  sentTick: number,
  lastDeltaAt: number | undefined,
  activeMessageId: string | undefined,
  onScroll: (() => void) | undefined,
): { follow: FollowState; jumpToBottom: () => void; onScrollWithFollow: () => void } {
  const [follow, setFollow] = useState<FollowState>(FOLLOW_PINNED)
  /*
   * 状态的**镜像**。滚动回调与 ResizeObserver 都在 React 之外跑,它们要的是
   * 「此刻是哪一格」而不是「上一次渲染时是哪一格」—— 读 state 会慢一帧,而
   * 那一帧正好是流式期间每一帧都要判的那一次。写 ref 与写 state 在同一句里,
   * 两者不会分叉(唯一的写点是下面那只 `dispatch`)。
   */
  const followRef = useRef<FollowState>(FOLLOW_PINNED)

  const dispatch = useCallback((event: FollowEvent) => {
    const next = reduceFollow(followRef.current, event)
    // 纯函数在「什么都没改」时返回同一个对象 —— 流式每帧那一次 `grew` 于是白送。
    if (next === followRef.current) return
    followRef.current = next
    setFollow(next)
  }, [])

  /** 贴底。**唯一**一处写 `scrollTop`,三个调用点都经它。 */
  const stick = useCallback(() => {
    const el = scrollRef?.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [scrollRef])

  // 换会话 = 一次新的进场。写在 layout 阶段,好让同一次提交里下面那些 effect 看到它。
  useLayoutEffect(() => {
    dispatch({ type: 'enter' })
  }, [sessionId, dispatch])

  /*
   * 每一次提交:pinned 就贴底。
   *
   * **没有依赖数组**是有意的 —— 「内容变了」在 React 这一侧的全部表现就是「又提交了
   * 一次」,列个依赖数组等于挑几样东西代表它,而挑漏的那一样就是一次跟不住。
   * 空树时不落:此刻 `scrollHeight` 就是视口高,落了等于什么都没做。
   */
  useLayoutEffect(() => {
    if (messages.length === 0) return
    if (followShouldStick(followRef.current)) stick()
  })

  /*
   * 纪律 ② 的落点:内容自己长高(异步高亮 / 图 / 流式 delta 的重排)不一定经过
   * React 的提交,所以盯 DOM。**只认长高**:收起一段思考、删一条消息都会让高度变小,
   * 那不是「下面长出了没看见的东西」,不该点亮丸。
   */
  const lastHeightRef = useRef(0)
  useLayoutEffect(() => {
    const el = scrollRef?.current
    if (!el || typeof ResizeObserver !== 'function') return
    // 盯**内容那一层**:容器自己的高度是外壳给的,不随内容变。
    const column = el.firstElementChild
    if (!column) return
    lastHeightRef.current = column.getBoundingClientRect().height
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? column.getBoundingClientRect().height
      const grew = height > lastHeightRef.current
      lastHeightRef.current = height
      if (!grew) return
      dispatch({ type: 'grew' })
      if (followShouldStick(followRef.current)) stick()
    })
    observer.observe(column)
    return () => observer.disconnect()
  }, [scrollRef, sessionId, dispatch, stick])

  /*
   * 「发送了一条」那一拍。号从 `chat-source` 来(产地在 `send()`),这里只比对它变没变。
   * 首帧那一次不算:挂载时读到的号是这个进程此前发过的总数,不是刚刚发生的一次。
   *
   * **排在长高那只 effect 之后**是有意的,但正确性不靠它:`sent` 与 `grew` 谁先到
   * 都得出同一个答案,因为纯函数里那条「`grew` 不覆盖 `sent`」的规则本身就是次序无关的
   * (理由写在 follow.ts 的 `grew` 分支)。
   */
  const seenTick = useRef(sentTick)
  useEffect(() => {
    if (sentTick === seenTick.current) return
    seenTick.current = sentTick
    dispatch({ type: 'sent' })
  }, [sentTick, dispatch])

  /*
   * 「回复到了」那一拍。判据是 `lastDeltaAt` 变了**且此刻有一轮在跑** ——
   * 两个条件缺一不可:前者说「这一轮又收到一段」,后者把「收场时 `lastDeltaAt`
   * 归 undefined」那一次变化挡在外面(那是一轮结束,不是一段回复到达)。
   *
   * **不用 `grew` 代劳**的理由写在 follow.ts 的 `reply` 分支里:自己刚发的那条
   * 也是一次长高,几何分不出是谁长的;这一格拿的是数据源的事实,分得出来。
   *
   * 号的比对与 `sentTick` 同一手(ref 记上一次,不是每次渲染都派):流式期间
   * 每一段 delta 都会让这只 effect 跑一遍,而其中除第一次外每一次
   * `reduceFollow` 都返回同一个对象,`dispatch` 当场短路 —— 不推 state。
   * 首帧那一次不算:挂载时读到的是这一轮此前已经收过的时刻,不是刚刚发生的一次。
   */
  const seenDeltaAt = useRef(lastDeltaAt)
  useEffect(() => {
    if (lastDeltaAt === seenDeltaAt.current) return
    seenDeltaAt.current = lastDeltaAt
    if (activeMessageId === undefined) return
    dispatch({ type: 'reply' })
  }, [lastDeltaAt, activeMessageId, dispatch])

  /** 点丸 / 明确要求回底:先落、再翻状态(两句的次序无所谓,状态机不看几何)。 */
  const jumpToBottom = useCallback(() => {
    stick()
    dispatch({ type: 'jumpToBottom' })
  }, [stick, dispatch])

  /**
   * 滚动事件。判据就一句:**停下来的位置在不在底**。
   * 我们自己落底也会发滚动事件,而那几下正正好在底(误差 < `AT_BOTTOM_EPS`),
   * 所以不必维护一个「这一下是我自己滚的」标志位 —— 而标志位正是这类代码最容易
   * 漏掉一条路径的地方(wheel / 触控板 / 键盘 / 拖滚动条 / TOC 跳转 / scrollIntoView,
   * 每加一条来源就要多记一次)。
   */
  const onScrollWithFollow = useCallback(() => {
    const el = scrollRef?.current
    if (el) dispatch({ type: 'scrolled', gap: el.scrollHeight - el.clientHeight - el.scrollTop })
    onScroll?.()
  }, [scrollRef, onScroll, dispatch])

  return { follow, jumpToBottom, onScrollWithFollow }
}

/** 不装配的那两种角色共用同一个空数组 —— 每次新造一个会让下游的浅比全部落空。 */
const EMPTY_SEGMENTS: SegmentModel[] = []

interface RowProps {
  t: TFn
  /**
   * **这一行属于哪条会话**(W5-b)。它一路传到动作行上,因为「重跑这一条」
   * 要说得出发给谁 —— 会话多开之后「当前那台机器」不再是一个说得清的东西:
   * 一片没获得焦点的会话叶里那颗重试钮,发的必须是**它自己**那条会话。
   * 它是一个原始值、逐行恒定,所以 `memo` 的浅比照旧短路。
   */
  sessionId: string
  message: ProjectedMessage
  streaming: boolean
  flash: boolean
  /** 这一轮上一次收到 delta 的时刻;只有活消息拿得到(其余恒 undefined)。 */
  lastDeltaAt?: number
}

/**
 * 一条消息一行。
 *
 * ── 为什么包 `memo`(09-01 P0,60 万 token 长会话流式期 3–4fps)──────────
 * 流式期间 `chat-source` 每帧推一次屏,列表数组每帧是新的 —— 不包 memo,**整篇
 * 抄本的每一行每帧都重渲染一次**,代价 ∝ 会话长度。包上之后判据变成「这条消息的
 * 对象引用变了没有」:上游按 `(投影节点, node.rev)` 缓存物化(`data/chat-materialize`),
 * 没变的消息逐帧是**同一个对象**,于是活消息那一行重渲染,其余全部短路。
 *
 * 默认浅比就够:四个 prop 里 `t` 是 `useT()` 按 locale memo 的稳定函数,
 * `message` 是那份缓存过的对象,`streaming` / `flash` 是布尔。
 * **别在这里加自定义比较函数** —— 那等于把「什么算变了」从上游搬一份到这儿,
 * 两处判据迟早分叉;要短路就让上游把引用稳住。
 */
const MessageRow = memo(function MessageRow({
  t,
  sessionId,
  message,
  streaming,
  flash,
  lastDeltaAt,
}: RowProps) {
  const role = message.role
  const className = [s.row, flash && s.flash].filter(Boolean).join(' ')

  // 只有模型说的话要装配。用户消息是一个气泡、错误消息是一张卡,它们没有段 ——
  // 给它们也跑一遍管线不只是白跑,还会往 memo 里塞一份永远没人读的段序列。
  //
  // 装配是纯函数 + 按消息引用 memo,所以这一句在非活跃消息上是一次 WeakMap 命中。
  const prose = role === 'assistant' || role === 'system'
  const segments = prose ? assembleMessage(message) : EMPTY_SEGMENTS
  const ctx = useMemo(
    () => ({ messageId: message.id, streaming }),
    [message.id, streaming],
  )

  return (
    <article className={className} data-message-id={message.id} data-role={role}>
      {role === 'user' && <div className={s.user}>{message.content}</div>}
      {/*
        气泡底下那一行「上下文更新」(U3)。这一轮的 `<context-update>` 尾块变了
        哪些块,是**这条用户消息自己的字段**(`turnContext`),所以摆在它的气泡下面
        而不是流的别处。没有 delta 时组件自己返回 null —— 绝大多数消息走那一支,
        这里因此不写第二份判据(判据两处就会分叉)。
      */}
      {role === 'user' && <ContextDeltaChip turnContext={message.turnContext} />}

      {/* data-prose:节奏表的钩子 —— 错误卡是一件东西,按物件档留白(节奏表在
          ChatStream.module.css)。 */}
      {role === 'error' && (
        <div className={s.errorCard} role="alert" data-prose="object">
          <span className={s.errorTitle}>{t('chat.errorCard')}</span>
          {/* 后端说的那句话原样显示 —— 不改写、不总结。 */}
          <span className={s.errorBody}>{message.errorDetails || message.content}</span>
        </div>
      )}

      {prose && (
        <>
          {/*
            * ── 第一个字之前那段空档(§5.3 拍点 ⑫)────────────────────────────
            * 回复的槽位已经开出来(`run/start` 到了、活消息立着),但**此刻一个字
            * 都画不出来**:模型在思考、请求还在路上。今天那段是一片空白,与用户报的
            * 「不知道它是不是卡住了」同源。
            *
            * 判据是 `segments.length === 0` —— 装配管线对这条消息**此刻画得出什么**
            * 的完整答案。它不是拿 `content` 猜:一条只有工具活儿、正文还是空的消息
            * 段序列非空,那时候槽位里有东西可看,不该再画点。换句话说,判据问的是
            * 「屏幕上有没有东西」,而这正是这三颗点要回答的那个问题。
            * 第一个 delta 到达 → 段序列非空 → 点当场换成正文与尾部那枚光标。
            */}
          {streaming && segments.length === 0 && (
            <Dots className={s.firstToken} label={t('chat.streaming')} />
          )}
          {segments.map((segment, index) => {
            const key = segmentKey(message.id, index, segment)
            return <SegmentView key={key} segment={segment} segmentKey={key} ctx={ctx} />
          })}
          {/*
            消息尾来源条(§5.3 四件套之四):这条回复的依据在哪。它是**消息**的
            尾注,不是某个段的一部分 —— 所以由这一层摆,而不是 SegmentView。
            这个文件对检索一无所知:没有检索段时组件自己返回 null。
          */}
          <MessageSourceFoot segments={segments} messageId={message.id} />
          {/*
            光标是**数据源的事实**(activeMessageId),不是这条消息自己的事实,
            而装配管线只拿得到消息 —— 所以它留在这一层画,没有进段序列。
          */}
          {streaming && segments.length > 0 && (
            <span className={s.cursor} data-testid="chat-streaming" aria-label={t('chat.streaming')} />
          )}
          {/*
            消息外缘的那一行(台一「安静编辑器」定稿):**同一个位置,永远只有一个在**。
             · 流式中 = 读数行(还活着 / 跑了多久 / 停止)。起点取这条消息的
               `timestamp`,那是账本上 `run/start` 自己带的时刻(见 StreamReadout 的注);
             · 完成后 = 幽灵动作行(复制 / 重试),**悬停或焦点进来才浮现**。
            动作行常驻在 DOM 里(只动 opacity)—— 条件渲染会让它浮现时把下文推下去。
            只有 assistant 有动作:system(压缩卡)不是"一条回答",没有重跑一说;
            user 的动作是编辑重发,那是另一件事(留账)。
          */}
          {streaming && <StreamReadout startedAt={message.timestamp} lastDeltaAt={lastDeltaAt} />}
          {!streaming && role === 'assistant' && (
            <MessageActions
              sessionId={sessionId}
              messageId={message.id}
              text={message.content ?? ''}
            />
          )}
        </>
      )}
    </article>
  )
})

function OverlayRow({ t, entry, sessionId }: { t: TFn; entry: OverlayEntry; sessionId: string }) {
  // 两口动作也跟着这条会话走 —— overlay 是「这条会话的屏幕」上的车道。
  const retry = useChatSourceOf(sessionId, (st) => st.retry)
  const dismiss = useChatSourceOf(sessionId, (st) => st.dismiss)

  // 拒绝也进流:一次没回答**也是一次回答**,不该在记录里消失,只是说得轻一点。
  if (entry.kind === 'notice') {
    return <div className={`${s.user} ${s.declined}`}>{t('ask.rejected')}</div>
  }

  const failed = entry.status === 'failed'
  return (
    <div
      className={[s.user, s.pending, failed && s.pendingFailed].filter(Boolean).join(' ')}
      data-testid={`chat-pending-${entry.status}`}
    >
      {entry.text}
      {entry.attachments > 0 && (
        <span className={s.sentAtt}>
          <ClipIcon className={s.sentAttIcon} strokeWidth={1.8} aria-hidden="true" />
          {entry.attachments}
        </span>
      )}
      {failed && (
        <span className={s.pendingFoot}>
          {/* 失败的理由照抄后端说的 —— 渲染层不替它编一句更好听的。 */}
          <span className={s.pendingError}>{entry.error}</span>
          {/*
            * 三类判的第三类:脚注上的**微型静默文字动作**(fs-micro / 无边框无底 /
            * 长在一行错误说明的旁边),视觉本该定制 —— 与批 3 把「加载更多」判进
            * 基座同一形。换成 `ui/Button` 会在这一行里塞进两颗 28 高的描边钮,
            * 那不是等价替换而是改版。皮肤留本地,清 UA 归 `ui/ButtonBase`。
            */}
          <ButtonBase className={s.pendingAction} onClick={() => retry(entry.id)}>
            <RetryIcon className={s.pendingIcon} strokeWidth={1.9} aria-hidden="true" />
            {t('chat.retry')}
          </ButtonBase>
          <ButtonBase className={s.pendingAction} onClick={() => dismiss(entry.id)}>
            {t('chat.discard')}
          </ButtonBase>
        </span>
      )}
    </div>
  )
}
