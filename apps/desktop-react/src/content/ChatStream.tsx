import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type RefObject,
} from 'react'
import { chatSources, loadOlderChatMessages, useChatSourceOf } from '../data/chat-source'
import { readSessionScrollAnchor, type ScrollAnchor } from '../data/session-view-state'
import { CHAT_WINDOW_STEP, growChatWindow, useChatWindowStart } from './chat-window'
import { sessionRefIdOf } from './session-ref'
import type { ProjectedMessage } from '../data/chat-fold'
import { ReferenceHost } from '../references/host-context'
import type { ResolvedSegment } from '../references/segment'
import { useT, type TFn } from '../i18n'
import { resolveIcon } from '../components/icons'
import { CARD_FLIP_MS, currentMotionTier } from '../components/motion'
import { ButtonBase } from '../ui/ButtonBase'
import { assembleMessage, segmentKey } from './assemble'
import { ContextDeltaSeam, hasContextDelta } from './ContextDeltaSeam'
import { DomScrollPort, type ScrollPort } from './viewport/scroll-port'
import { useViewportAnchor } from './viewport/use-viewport-anchor'
import { GeometryReportContext, useGeometryReport } from './geometry-report'
import type { SegmentModel } from './model/segments'
import { MessageActions } from './message/MessageActions'
import { MessageChrome } from './message/MessageChrome'
import { StopNotice } from './message/StopNotice'
import { TailSlot, TailSpacer } from './message/TailSlot'
import { MessageSourceFoot } from './research/SourceFoot'
import { SegmentView } from './SegmentView'
import { UserMessageBody } from './user-message'
import { UserFiles, UserImages, isImageAttachment } from './user-attachments'
import u from './user-attachments.module.css'
import { messageAttachmentMetadata } from '../data/message-attachments'
import type { MessageAttachmentMetadata } from '../data/message-attachments'
import type { UserContentPart } from './user-message'
import { FocusScope } from '../focus/FocusScope'
import { FollowPill } from './FollowPill'
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
   * ── 上翻取页那两格(2026-09-10 工单 5 ⑥)────────────────────────────────
   * 本地那个窗口(`chat-window.ts`)管的是「这一帧摆几条 DOM」;这两格管的是
   * 「手里这几条之上还有没有」。两件事,所以两张表:窗口用完了才轮到取页。
   */
  const hasMoreBefore = useChatSourceOf(sessionId, (st) => st.hasMoreBefore)
  const loadingOlder = useChatSourceOf(sessionId, (st) => st.loadingOlder)
  const olderTick = useChatSourceOf(sessionId, (st) => st.olderTick)

  /*
   * ── 进场那一格窗口的两个入参(2026-09-10「响应先行」)────────────────────
   *
   * `anchor` 只在**进场第一帧树上就有消息**时给 —— 那正是停靠池命中那条路,
   * 也正是下面那只 layout effect 会真的落回锚点的那一次,所以窗口必须一次性
   * 扩到包含那一行(判词全文在 `chat-window.ts` 的 `seedWindowStart` 上)。
   * 冷载入第一帧树是空的,锚点这一次用不上,给 `undefined` = 老实尾窗。
   *
   * 写在渲染期而不是进 effect:它要在**第一次渲染**就说得出话(effect 跑的时候
   * 那一帧已经画出去了)。守着会话 id 重算,所以「换会话不重挂」那条路也对 ——
   * 与下面 `messageCountRef` 那一手同源。
   */
  const entryRef = useRef<{ sid: string; anchor: ScrollAnchor | undefined } | undefined>(undefined)
  if (!entryRef.current || entryRef.current.sid !== sessionId) {
    entryRef.current = {
      sid: sessionId,
      anchor: messages.length > 0 ? readSessionScrollAnchor(sessionId) : undefined,
    }
  }
  const windowStart = useChatWindowStart(sessionId, messages, entryRef.current.anchor)
  /**
   * **顶端那一格此刻说什么**(空串 = 不说话,那一格照旧在场)。
   *
   * 三档的判据都是**确知**:`loadingOlder` 是一件正在发生的事;「还有更早的」要么
   * 本地窗口还没摆完(`windowStart > 0`),要么 core 那一页明说了上面还有
   * (`hasMoreBefore`)。**「到头了」与「还不知道」合成同一档 = 空** —— 这两件事在
   * 数据层本来就分不开:`hasMoreBefore` 是一格布尔,起底那一刻写的就是 `false`
   * (`chat-source.ts` 的 `load`,注为「底稿还没到手 —— 『上面还有更早的』此刻是一句
   * 说不出口的话」),页回来之后才可能翻成真。所以**空会话起手不会先闪一句
   * 「还有更早的」**,这一条是查过数据层才这么写的,不是猜的。
   */
  const olderMarkText = loadingOlder
    ? t('chat.olderLoading')
    : windowStart > 0 || hasMoreBefore
      ? t('chat.olderMore')
      : ''
  /**
   * **这一帧真的摆出去的那几条**(= 消息数组的一个后缀)。
   *
   * 全量到齐(`windowStart === 0`)之后与从前逐字相同 —— 连数组对象都是原来那个,
   * 所以下游那些按引用短路的 memo 一格没动。
   */
  const visible = useMemo(
    () => (windowStart <= 0 ? messages : messages.slice(windowStart)),
    [messages, windowStart],
  )
  /**
   * **座位垫块**(正本 `docs/send-flow-2026-09.md` §3)。
   *
   * ref 在这一层是因为**摆它的是这一层**(它是消息列的最后一格),而量它、写它的是
   * 下面那只 hook —— 与 `scrollRef` 由外面那一层给、hook 只管用同一条分工。
   *
   * **G 线 P2-a 把它提前到了这里**:两格 ref 合起来才造得出那只 `ScrollPort`,
   * 而扩窗补位(`useTailWindow`)也要经那个口写 —— 口必须先于它的第一个用户。
   */
  const seatRef = useRef<HTMLDivElement | null>(null)

  /**
   * **量与写的唯一那个口**(G 线 P2-a,`content/viewport/scroll-port.ts`)。
   *
   * 一次挂载一只,身份恒定 —— 下游那一串 `useCallback` 把它进依赖表,身份稳住
   * 才不会每次渲染都换一批回调(`MessageRow` / `ToolCard` 的 memo 短路靠的正是
   * 那几只回调身份恒定)。
   *
   * 两格 ref 都**现读**不持有:`scrollRef` 是外面那一层给的 prop(换一片叶就换
   * 一个 ref 对象),垫块随 `seatActive` 生生灭灭 —— 持有就会拿着一个已经摘掉的
   * 节点。中间那格 `scrollRefBox` 是为了「prop 换了新的 ref 对象」那一下:闭包
   * 捕的是盒子,不是那一刻的 ref。
   */
  const scrollRefBox = useRef(scrollRef)
  scrollRefBox.current = scrollRef
  const portRef = useRef<DomScrollPort | undefined>(undefined)
  if (!portRef.current) {
    portRef.current = new DomScrollPort(
      () => scrollRefBox.current?.current ?? null,
      () => seatRef.current,
    )
  }
  const port = portRef.current

  const expandOnScroll = useTailWindow(
    scrollRef,
    port,
    sessionId,
    messages.length,
    windowStart,
    hasMoreBefore,
    olderTick,
  )

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
  /*
   * **两格事实,两个消费者**(2026-09-09):`lastDeltaAt` 说「模型又吐了一段」,
   * 只喂下面那只跟随 hook 的「回复到了」;`lastActivityAt` 说「这一轮最近一次有
   * 东西到达」(delta ∪ 工具进度 ∪ 活 run 的工具账本行 ∪ `tool:input-start`),
   * 只喂读数行。工具跑着不该点亮跟随丸那张脸,所以这两格不许合并回一格。
   */
  const lastDeltaAt = useChatSourceOf(sessionId, (st) => st.lastDeltaAt)
  const lastActivityAt = useChatSourceOf(sessionId, (st) => st.lastActivityAt)
  /*
   * `lastDeltaAt` / `activeMessageId` 两格**传进 hook**,不在这一层派发。
   * 理由是产地唯一:跟随事件今天六种,六种全在锚定器那一侧发 —— `ViewportAnchor`
   * 与它的薄 hook 合起来因此是「什么算一次跟随事件」的完整答案。把其中一种挪到
   * 组件里,读代码的人就得同时看两处才知道状态机被谁推过,而 `dispatch` / 那格
   * 跟随镜像也得跟着漏出去(它们是锚定器的内脏)。
   */
  /*
   * 滚动那一路上串着两件事:**扩窗**(翻到窗口顶部附近就当场补一批,不等空闲)
   * 与摆这片叶的人自己那口(目录同步)。串在这里而不是塞进锚定器 ——
   * 它的自述是「跟随事件的六种产地全在我这儿」,扩窗不是跟随事件。
   */
  const onScrollOutward = useCallback(() => {
    expandOnScroll()
    onScroll?.()
  }, [expandOnScroll, onScroll])

  /**
   * **按下重试那一刻,这一轮就算开张了**(单 B ⑥,正本 §2 规矩 ⑥「按下即开槽」)。
   *
   * `retryPending` 是数据源自己记的那一格账(它说的正是「账本上还什么都没有」——
   * core 要先删掉这条回复、截断其后消息、再开新 run,那段真空按定义推导不出来,
   * 判词在 `ChatSourceState.retryPending` 上)。从前壳在那段真空里**一动不动**:
   * 按下去屏幕没有任何回音,等账本删完旧回复才从头画。现在那一格一在场:
   *  · 旧回答当场开始**上折**(`.rowRetiring`,锚是自己那条气泡);
   *  · 这一轮的折痕**同一次提交**就开始扫(下面 `awaitingFirstToken` 把它算进去)。
   * 两道闸(`busy` / `retryPending`)一个字没动 —— 这里只读它,不新立判据。
   */
  const retryingId = useChatSourceOf(sessionId, (st) => st.retryPending?.messageId)

  const {
    follow,
    jumpToBottom,
    onScrollWithFollow,
    report: geometryReport,
    seatActive,
  } = useViewportAnchor({
    scrollRef,
    port,
    sessionId: foldedSessionId,
    messageCount: messages.length,
    sentTick,
    lastDeltaAt,
    activeMessageId,
    retryingId,
    onScroll: onScrollOutward,
  })

  /*
   * **取的是列尾那一条,不是 `find`**:活消息按定义是账本最后一条(这一轮的回复),
   * 流式期间这一句每帧都要跑,`find` 就是每帧扫一遍整篇抄本。
   */
  const tailMessage = messages[messages.length - 1]
  /** 这一轮那条活消息(= 账本最后一条,且它就是在跑的那一条)。 */
  const activeMessage = tailMessage !== undefined && tailMessage.id === activeMessageId
    ? tailMessage
    : undefined
  /**
   * ── 尾槽此刻在跑没在跑(G 线 P1 立,P1b 裁定 B 收成一格布尔)──────────────
   * 「在跑」= 有一条活消息,**或者**重试那一发还在飞(那段真空里账本上一个字都还
   * 没变,判词在 `retryingId` 上)。
   *
   * **「在等第一个字」不再是一格事实**:P1 那版还按它把尾槽分成两张脸(扫光 / 光标),
   * P1b 用户裁定「生成中的这块样式布局应保持不变」,于是等待那张脸退役,这一层
   * 连带不必再问「这条活消息此刻画得出什么」—— 那一句(`assembleMessage(...).length`)
   * 从这里删掉了,流式期间每帧少一次装配查表。
   */
  const tailRunning = activeMessageId !== undefined || retryingId !== undefined

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
     * **这一片消息流是哪条会话的**(B2)。一枚长在助手正文里的引用 chip 点开时
     * 要知道收件人是谁(命令那一种要把 `/name` 填进**这条**会话的输入框),而它
     * 长在 markdown 行内树的最里面 —— 中间每一层都不认识引用。判词整段在
     * `references/host-context.tsx`。
     */
    <ReferenceHost sessionId={sessionId}>
    {/*
     * **`chat` 是一族带 owner 的作用域**(W5-b 裁定 6,照 `scopes.ts` 的 `leaf`
     * 样板):会话多开之后同一个 scope id 会有好几份实例,而
     * `activateScope('chat', { owner })` 要精确取到**这一条会话**那一份 ——
     * 壳启动那条三级回落(`AppShell`:composer → chat(焦点叶的)→ root)问的
     * 正是它。owner 是这一格的 refId,翻译只有 `sessionRefIdOf` 一处。
     */}
    <FocusScope scope="chat" owner={sessionRefIdOf(sessionId)} rootRef={scrollRef}>
      {({ scopeProps }) => (
        /*
         * ── 流里「人动了手」的**唯一**通道(G 线 P2-c 合一)────────────────────
         * 几何分不出「模型又吐了一段」与「人点开了一段」:两者都让 gap 变大、
         * `scrollTop` 不动,量多少遍都一样,而它俩要的结果正好相反。所以这件事
         * 只能由**动手的那一方自述**。开与合走同一个口,方向由 `open` 说 ——
         * 收起那一侧先把卷尾垫块加长(页面总高不变)、再把被点的那一块钉住;
         * 展开那一侧钉住顶边并按此刻离底多远重判跟随档。
         *
         * 合一之前这儿是**三条** context 并排:`expand-intent`(只报展开,P2-b 之后
         * 零生产者)、`fold-intent`(只报收起,只剩重试那一路)与这一条。两条老的
         * 随 P2-c 整件退役,重试那一路改报到这儿(`el: null` = 点不出被点的那一块,
         * 锚由第一帧现选)。
         *
         * 值是 `useCallback` 出来的,**身份恒定** —— 所以 `MessageRow` / `ToolCard`
         * 那几层的 memo 短路一格没动(context 的值不变,消费者不会被推着重渲)。
         */
        <GeometryReportContext.Provider value={geometryReport}>
        <>
        {/*
          * `data-follow` 是**跟随状态机的一格自述**(P1c,2026-09-21):列尾那一格
          * 只在 `pinned` 时由合成器钉在滚动口底边(判词在 `TailSlot.module.css`
          * 的 `.slot` 上)。人往上翻历史时它必须回到普通流里 —— 否则它会浮在屏底
          * 盖住正文,那是另一个产品决定,这一单不做。
          */}
        <div
          {...scopeProps}
          className={s.scroll}
          onScroll={onScrollWithFollow}
          data-testid="chat-stream"
          data-follow={follow.mode}
        >
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

            {/*
              * ── 顶端那一行读数(2026-09-10 工单 5 ⑥;09-21 P1e 改一档)───────────
              * 三档一句话:正在取 → 「正在取更早的…」;本地窗口还没摆完 **或**
              * core 说上面还有 → 「还有更早的」;**其余(到头了 / 还不知道)= 空**。
              *
              * 「已到开头」那句话 09-21 被用户点名去掉(原话:「还有一个事情,
              * 『已到开头』,不需要」)。**去掉的是那句话,不是那一格地** —— 这一格
              * 从有内容那一刻起就永远在场、高度恒为一行(`.olderMark` 的
              * `min-block-size: 1lh`),空着的时候只是不说话(`aria-hidden`)。
              * 判例写在这儿,别再改回「条件不成立就不渲染」:P1e 那一版把整行摘掉,
              * `gate:stream-geometry` 当场判红 —— `short:text` 的首字帧尾槽位移
              * 0.1 → 12.2px、整轮 0.1 → 57.2px(单帧 22.5px ≈ 一整行),因为那一行
              * 的在场与否会在**一轮正在跑的时候**翻,而 G 线 G4 正是冲着这种东西立的。
              *
              * 只在**有内容**时画:空态那三行自己会说话(那三行与这一行永不同屏)。
              * 禁 spinner(规范禁令第一条:列表/卡的加载态用文字)。
              */}
            {sessionId && status === 'ready' && messages.length > 0 && (
              <p className={s.olderMark} aria-hidden={!olderMarkText || undefined}>
                {olderMarkText}
              </p>
            )}

            {/*
              * **摆的是窗口里那几条,不是整份**(2026-09-10)。窗口是消息数组的一个
              * 后缀,起点只减不增(判词在 `chat-window.ts`),所以这里一格特判都没有:
              * 全量到齐时 `visible === messages`,与从前逐字相同。
              */}
            {/*
              * ── 账本行与在飞行是**一张有序表**(09-14,所见即所发;正本 §6.2)──
              * 从前它们是两句 JSX(`{visible.flatMap(…)}{overlay.map(…)}`)。两句
              * 表达式在 React 眼里是 `.column` 的**两格孩子**,key 各管各的 ——
              * 所以一条消息落账那一刻,在飞那一格从第二格里消失、账本那一行在第一格
              * 里出现:**两个 DOM 节点**,中间必然有一次挂载与一次卸载,用户看见的
              * 就是气泡闪一下重画一遍。
              *
              * 合成一张之后,乐观行的 key 是 `entry.messageId`、账本用户行的 key 是
              * `message.id` —— **同一个字符串**,元素类型又同为 `UserBubble`,于是
              * React 在同一个父数组里按 key 认出「还是它」,DOM 节点原样留着,落账
              * 那一拍只改 `data-pending` 与那一格不透明度。
              *
              * `flatMap` 那一层保留:上下文更新那道折痕是**跟在某条消息后面的一行**,
              * 它与消息同属这张表。
              */}
            {[
              ...visible.flatMap((message) => {
              if (message.role === 'user') {
                const row = (
                  <UserBubble
                    key={message.id}
                    t={t}
                    sessionId={sessionId}
                    messageId={message.id}
                    text={message.content}
                    parts={message.contentParts}
                    status="landed"
                    attachments={messageAttachmentMetadata(message)}
                    flash={message.id === flashMessageId}
                  />
                )
                return hasContextDelta(message.turnContext)
                  ? [row, contextSeamRow(message)]
                  : [row]
              }
              const row = (
                <MessageRow
                  key={message.id}
                  t={t}
                  sessionId={sessionId}
                  message={message}
                  streaming={message.id === activeMessageId}
                  flash={message.id === flashMessageId}
                  /*
                   * 重试那一路:这一条正在上折(单 B ⑥)。传的是**被重试的那一条**
                   * 的身份,所以其余每一行拿到的都是 `false` —— memo 的浅比照旧短路。
                   */
                  retiring={message.id === retryingId}
                />
              )
              /*
               * ── 上下文更新那一道折痕(U5,09-09 裁定)────────────────────────
               * `turnContext` 是**宿主在这一回合开始时补给模型的上下文** —— 是回合的事,
               * 不是用户说的话。数据照旧存在用户消息上(它是发给模型的那条消息的一部分,
               * 账本一个字不动),**呈现**却不该挂在气泡下面:挂在那里读起来像
               * 「用户还说了这些」。所以它是用户那一行**之后**、下一行**之前**的独立一行,
               * 与压缩折痕同属「系统在两回合之间做的事」这一族。
               *
               * 它**不带 `data-message-id`** —— 那个属性是 TOC / `locate-message` 找消息的
               * 唯一接缝,多一个不是消息的元素挂上去,钢琴键就会落到一行折痕上。
               * 它报的是 `data-context-of`:这道折痕说的是**哪条消息**那一回合的事。
               *
               * `flatMap` 而不是包一层 `<Fragment key>`:后者会把 MessageRow 挪进一层新的
               * 键空间,而这一行的整篇 memo 短路(60 万 token 会话 3–4fps 那笔账)
               * 全靠它的 key 与位置一格不动。
               */
              return [row]
              }),
              /*
               * 在飞那几格**紧跟在账本末尾**(顺序按 entry 先后)。它们与上面那几行
               * 在同一张表里 —— 判词见这张表开头那一段。
               */
              ...overlay.map((entry) => (
                entry.kind === 'notice'
                  ? <NoticeRow key={entry.id} t={t} />
                  : (
                      <UserBubble
                        /*
                         * key = 这条消息**将来在账本上的 id**(发送前就铸好了,
                         * `chat-source.send`)。账本那一行用的是同一个字符串,所以
                         * 落账那一拍 React 认出「还是它」,DOM 节点原样留着。
                         * 没有 `messageId` 的旧形 entry(steering 降级那条路自己铸 id)
                         * 退回 `entry.id` —— 那一条落账时仍会换节点,**留账**:
                         * 要根治得改 `steerMessage` 的签名(正本 §6.2 末)。
                         */
                        key={entry.messageId ?? entry.id}
                        t={t}
                        sessionId={sessionId}
                        text={entry.text}
                        segments={entry.segments}
                        status={entry.status === 'failed' ? 'failed' : 'pending'}
                        attachments={messageAttachmentMetadata({
                          id: entry.id,
                          attachments: entry.files?.map((file) => ({ file, fileName: file.name, mimeType: file.type, size: file.size })),
                        })}
                        attachmentCount={entry.attachments}
                        error={entry.error}
                        entryId={entry.id}
                      />
                    )
              )),
              /*
               * ── 座位垫块(正本 §3;几何在 `content/seat.ts`)──────────────────
               * **列尾一块让位给内容的空白**:发送那一帧自己的话滑到置顶线,底下
               * 整个视口留给回复,回复长一截它缩一截,`scrollHeight` 一格不变 ——
               * 于是「跟底」在座位长满之前什么都不用做,视口一像素不动。
               *
               * 它是消息列的孩子,却**不是一条消息**:不带 `data-message-id`(不进
               * TOC / `locate-message`)、`aria-hidden`(它不是一件要念的东西)、
               * 不吃指针。高度写在 `style.height` 上而不是一个 React prop:那是一个
               * **量出来的数**,每一帧都可能不同,过 React 就是每一帧一次提交。
               *
               * key 恒为 `'seat'`:上一轮的座位由这一轮**原位接管**(同一个 DOM 节点
               * 换一个高度),上面那些旧内容因此一像素不动 —— 与在飞那一格落账时
               * 按 key 认出「还是它」是同一条纪律。
               */
              /*
               * ── **它常驻,不随座位生灭**(G 线 P2-b,2026-09-21)────────────────
               * 从前这一格只在 `seatActive`(这次进场之后自己发过话)时挂上来。
               * P2-b 之后垫块还要接**第二个量** —— 手动收起一块东西时吸收掉缩掉的高
               * (正本 §13.6 第 1 条),而那一下要在**事件处理函数里同步写进去**
               * (G2「收缩先申请后执行」)。节点不在树上就写不了:`writePadHeight`
               * 答 false,垫块一格都长不出来,收起照旧钳。
               *
               * **它是视觉上的恒等**:高 0,而 `.seat` 的 `margin-block-start` 正是
               * `calc(-1 * var(--sp-6))` = 抵掉这条列自己那一格 `gap` —— 一个高 0、
               * 前边距为负一格 gap 的孩子,排出来与它不在逐像素相同
               * (`send-seat.test.tsx` 把这一条钉成断言)。
               * `key` 恒为 `'seat'` 那条判词照旧成立,而且从此更强:同一个 DOM 节点
               * 从会话进场活到离场,上一轮的座位由下一轮原位接管。
               */
              <div key="seat" ref={seatRef} className={s.seat} data-seat="" aria-hidden="true" />,
              /*
               * ── 尾槽在列里剩下的那一半:一格**空位**(G 线 P1h,正本 §12)──────
               * 排在卷尾垫块**之后**,所以它是这条列真正的最后一格。它常驻、高度恒为
               * `--tail-slot-h`、**一个像素都不画** —— 画的那一份搬去了滚动口上那一层
               * (下面 `<TailSlot>`,判词在 `TailSlot.module.css` 的 `.overlay`)。
               *
               * **只在真的有会话、而且账本读出来了的时候画**:空会话 / loading /
               * error 那三态各自有一句话要说(上面那三行),再压一格空槽只是多一段
               * 空白。`key` 恒定,所以它跨轮、跨发送都是同一个 DOM 节点 —— 与座位
               * 垫块「上一轮的座位由这一轮原位接管」同一条纪律。
               */
              ...(sessionId && status === 'ready' ? [<TailSpacer key="tail" />] : []),
            ]}
          </div>
        </div>
        {/*
          * ── 尾槽那一层:**滚动容器的兄弟**(G 线 P1h)────────────────────────
          * 与下面那颗丸同一个位置、同一个参考系(`.chatArea`)。搬出来的理由整段
          * 写在 `TailSlot.module.css` 的 `.overlay` 上,一句话:那一行的字从前在
          * 滚动内容层里按层内坐标栅格化,而层内坐标跟着列的分数高一直走。
          *
          * DOM 顺序 **消息流 → 这一层 → 丸**,于是 Tab 顺序是 消息列 → 停止 →
          * composer;`browsing` 时这一层 `inert`、丸在场,两者永不同时可达。
          */}
        {sessionId && status === 'ready' && (
          <TailSlot
            sessionId={sessionId}
            running={tailRunning}
            /*
             * 起点 = 这条助手消息的 `timestamp`(账本上 `run/start` 自己带的时刻)。
             * 重试那段真空里没有活消息 → `undefined` → 那一层只画那枚光标,
             * 不画一个编出来的读数(判词在 `TailSlot` 的 prop 上)。
             */
            startedAt={activeMessage?.timestamp}
            lastActivityAt={lastActivityAt}
            pinned={follow.mode === 'pinned'}
          />
        )}
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
        </GeometryReportContext.Provider>
      )}
    </FocusScope>
    </ReferenceHost>
  )
}

/**
 * 「人翻到窗口顶部附近了」的判据 —— **离顶不足这么多屏**就当场补一批,不等空闲。
 *
 * 它是一个**倍数**(乘的是视口高),不是时长也不是像素,所以既不进
 * `components/motion.ts` 也不进 tokens —— 与 `ANCHOR_RESETTLE_ROUNDS` 同一族。
 * 两屏:一次惯性滚动大约能吃掉一屏多,留两屏才来得及在人撞到顶之前补上。
 */
const CHAT_NEAR_TOP_SCREENS = 2

/**
 * **消息按屏进**(2026-09-10「响应先行」,规范第 5 轴)。
 *
 * 这只 hook 只做三件事,窗口那一格本身住在 `content/chat-window.ts`:
 *  ① **空闲往前补** —— 每批 `CHAT_WINDOW_STEP` 条,`requestIdleCallback`(没有就
 *     `setTimeout 0`)里排,包在 `startTransition` 里所以可被打断;窗口一变这条
 *     effect 重跑,于是自己接着排下一批,直到 `windowStart === 0`(全量到齐);
 *  ② **翻到窗口顶部附近就当场补** —— 不等空闲(空闲可能一直不来,而人已经翻到顶了);
 *  ③ **扩窗不许让视口跳** —— 见下面那只布局 effect。
 *
 * ── 为什么不给 `requestIdleCallback` 加 timeout ──────────────────────────
 * 「一直没有空闲」在这台上基本只有一种情况:**正在流**。而流式期间本来就不该
 * 抢主线程去补历史 —— 人此刻在看的是最新那一条。所以没有 timeout 不是漏掉,
 * 是这一格的语义:**闲下来再补**。人真要往前看,走的是 ② 那条路,不必等空闲。
 */
function useTailWindow(
  scrollRef: RefObject<HTMLDivElement | null> | undefined,
  /** 唯一那个写滚动位的口(G 线 P2-a):补位那一手也走它,不再自己赋 `scrollTop`。 */
  port: ScrollPort,
  sessionId: string,
  total: number,
  windowStart: number,
  /** 手里这几条之上还有没有(页那条读法说的,不是「本地够不够」)。 */
  hasMoreBefore: boolean,
  /** 又往前接了一页 —— 补偿那一格的触发沿(判词在 `ChatSourceState.olderTick`)。 */
  olderTick: number,
): () => void {
  /**
   * **扩窗之前那一刻的位置与总高**。扩窗是 prepend —— 上面凭空长出一截,
   * `scrollTop` 一动不动,于是人正在看的内容当场往下掉一截。
   *
   * 浏览器自己的滚动锚定(`overflow-anchor`,Chromium 缺省开,这条链上没有
   * 任何一处把它关掉)本来该接住这一下,但**跳渲的行**(`content-visibility: auto`)
   * 让它变得不可靠:新 prepend 的行报的是估高,锚定按估高补一次,行渲出真高
   * 之后又差一截。所以这里**绝对赋值**而不是 `+=`:`scrollTop = 原位 + 长高了多少`
   * —— 浏览器补没补过都不影响结果(它不改 `scrollHeight`),这一手是幂等的。
   */
  const pending = useRef<{ top: number; height: number } | undefined>(undefined)
  /**
   * 窗口起点的**镜像**。滚动回调在 React 之外跑,它要的是「此刻摆在哪」而不是
   * 「上一次渲染时摆在哪」—— 与 `followRef` 同一条理由(而且身份稳定,滚动回调
   * 不会因为窗口变了就换一只,锚定器那边的监听也就不必重挂)。
   */
  const windowStartRef = useRef(windowStart)
  windowStartRef.current = windowStart
  /** 同一条理由的第二格镜像:滚动回调在 React 之外跑,要的是「此刻还有没有」。 */
  const hasMoreBeforeRef = useRef(hasMoreBefore)
  hasMoreBeforeRef.current = hasMoreBefore

  /** 扩一批。**捕获在写 state 之前** —— 那一刻的几何才是「扩窗之前」。 */
  const grow = useCallback(
    (nextStart: number) => {
      const el = scrollRef?.current
      // 停靠中照旧扩窗(后台把窗补全,切回来就是全量),但**不留补偿**:
      // 那时几何全是 0,记下来的「原位 + 长高了多少」是一份假账,下一拍会被
      // 拿去写 `scrollTop`。位置由取回那一拍统一恢复(见 `ViewportAnchor.noteUnpark`)。
      pending.current = el && el.clientHeight > 0
        ? { top: el.scrollTop, height: el.scrollHeight }
        : undefined
      const changed = growChatWindow(sessionId, nextStart)
      if (!changed) pending.current = undefined
    },
    [scrollRef, sessionId],
  )

  /**
   * 扩窗提交之后把视口补回原处。**这是这个文件第三处写 `scrollTop`**
   * (另两处:`stick` 贴底、`applyScrollAnchor` 落锚点),写点纪律照旧 ——
   * 三处各自答一个问题,谁都不兼职。
   *
   * 排在布局阶段(绘制之前)所以人看不见中间那一帧;读一次 `scrollHeight` 要付
   * 一次排版,但那是**一批扩窗一次**,不是从前那种「每次提交一次」。
   */
  useLayoutEffect(() => {
    const captured = pending.current
    pending.current = undefined
    const el = scrollRef?.current
    if (!captured || !el) return
    // 捕获之后、提交之前被切走了 —— 那一格补偿此刻算不出来,也不需要算。
    if (el.clientHeight === 0) return
    const delta = el.scrollHeight - captured.height
    if (delta === 0) return
    port.setTop(captured.top + delta, 'late-insert')
    /*
     * `olderTick` 一起进依赖表:**取回一页也是一次 prepend**,补的是同一件事
     * (上面凭空长出一截),用的是同一手绝对赋值。差别只在捕获的时刻 ——
     * 扩窗那一下几何捕在写 state 之前(同步),取页那一下捕在**发请求**的时候
     * (`expandOnScroll` 里,那一刻本来就在读同一批几何)。中间这几十毫秒人还能
     * 再滚一点,那点漂移由「绝对赋值是幂等的」兜住:浏览器自己的滚动锚定补没补过
     * 都得同一个结果(它不改 `scrollHeight`)。
     */
  }, [windowStart, olderTick, scrollRef, port])

  /* ① 空闲往前补一批。窗口一变这条 effect 重跑 —— 于是它自己排下一批。 */
  useEffect(() => {
    if (windowStart <= 0 || total === 0) return
    let cancelled = false
    const run = () => {
      if (cancelled) return
      // 可打断:补历史永远让位给人此刻的输入与正在流的那一条。
      startTransition(() => grow(windowStart - CHAT_WINDOW_STEP))
    }
    const idle = (window as IdleWindow).requestIdleCallback
    if (typeof idle === 'function') {
      const handle = idle(run)
      return () => {
        cancelled = true
        ;(window as IdleWindow).cancelIdleCallback?.(handle)
      }
    }
    const handle = window.setTimeout(run, 0)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [windowStart, total, grow])

  /**
   * ② 翻到窗口顶部附近:当场补一批,不等空闲。
   *
   * **本地那一批用完了(`start <= 0`)才轮到取页**(工单 5 ⑥):窗口是本地数据的
   * 后缀,窗口到 0 说的正是「手里这几条全摆出来了」。此时上面还有,就去 core
   * 要上一页 —— 几何捕在这里,理由与补偿那只 layout effect 的注逐字同源。
   */
  return useCallback(() => {
    const el = scrollRef?.current
    if (!el) return
    if (el.scrollTop > el.clientHeight * CHAT_NEAR_TOP_SCREENS) return
    const start = windowStartRef.current
    if (start > 0) {
      grow(start - CHAT_WINDOW_STEP)
      return
    }
    if (!hasMoreBeforeRef.current) return
    pending.current = el.clientHeight > 0 ? { top: el.scrollTop, height: el.scrollHeight } : undefined
    // 发不出去(在飞 / 上面没有了)就把那格补偿撤掉 —— 与 `grow` 那一句同判。
    if (!loadOlderChatMessages(sessionId)) pending.current = undefined
  }, [scrollRef, grow, sessionId])
}

/** `requestIdleCallback` 在 TS 的 DOM 库里是可选的(jsdom / 老 Safari 没有)。 */
type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void) => number
  cancelIdleCallback?: (handle: number) => void
}

/*
 * ── `useFollowBottom` 整件退役了(G 线 P2-a,2026-09-21;正本 §13.2)────────────
 *
 * 它曾经是这只文件里最长的一段:**1039 行、49 次 hook 调用、22 格 ref**,
 * 22 格 ref 上 43 次读 / 62 次写。它不是「写得乱」—— 每一格都有判词、每一格都有
 * 事故背书 —— 它是**一个类被写成了一只 hook**。
 *
 * 今天它住在 `content/viewport/`:裁决在 `ViewportAnchor`,量与写在 `ScrollPort`
 * (**唯一**碰 DOM 的那一层),五个协作者各拿走一族 ref ——
 * `TailPad`(座位四格)/ `Slide`(插值三格)/ `IntentWindow`(两格时限窗口)/
 * `EntryRestore`(落锚点那一格)/ `AnchorRecorder`(去抖那一格);
 * React 这一侧只剩 `viewport/use-viewport-anchor.ts` 那只薄 hook,里面一句裁决
 * 都没有,剩下的全是边沿检测(`seen*` 那四格,§13.1.2 的表里本来就归 React)。
 *
 * **一行裁决都没改** —— 那是 P2-a 的自述,证据是写入序列快照
 * (`__tests__/scroll-writes.test.tsx`)与五道真机门的逐格对照(正本 §14)。
 */

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
  /**
   * 这一条还在跑吗。G 线 P1 之后它**只剩一个读者**:外缘那一行的动作格该不该暗着
   * (`MessageChrome`)。读数行、等待折痕、那枚光标三件都搬去了列尾的尾槽 ——
   * 判词在 `message/TailSlot.tsx` 与正本 §1 的 G4。
   */
  streaming: boolean
  flash: boolean
  /**
   * **这一条正在被重试,已经开始上折**(单 B ⑥)。`retryPending` 一在场就为真,
   * 不等账本把它删掉 —— 「按下即开槽」说的就是这段真空里屏幕也要有回音。
   */
  retiring?: boolean
}

/**
 * **这条消息此刻画得出正文吗** —— 收场通知挑句子要问的那一句(见 StopNotice)。
 *
 * 判据是**装配管线的产物**,不是 `message.content`:同一个问题在这个文件里已经
 * 有一个答案(第一个字之前那三颗点用的 `segments.length === 0`),那个答案问的是
 * 「屏幕上有没有东西」。这里问得更窄一格 —— 有没有**正文**:一条只有工具活儿的
 * 消息段序列非空,但它确实一个字都没回。
 *
 * 图片算正文:它是这一轮真的产出的东西。思考段不算 —— 「想完了但没回话」正是
 * 收场通知要区分的那一种。
 */
function hasVisibleProse(segments: readonly SegmentModel[]): boolean {
  return segments.some(segment =>
    (segment.kind === 'rich-text' && segment.blocks.length > 0) || segment.kind === 'image')
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
  retiring = false,
}: RowProps) {
  const role = message.role
  const className = [s.row, flash && s.flash, retiring && s.rowRetiring]
    .filter(Boolean)
    .join(' ')
  /*
   * 开始折的那一帧报一句「钉住视口」(与四族可折叠的东西同一条通道、同一个理由;
   * G 线 P2-c 之前它走的是已退役的 `content/fold-intent.ts`)。
   *
   * **`el: null` 是有意的**:旧回答整块在折,「被点的那一块」这句话在这儿没有主语
   * —— 人按的是重试键,不是这条气泡。锚因此由聊天流自己在下一帧现选:它上面第一件
   * 还看得见的东西正是自己那条气泡(判词在 `pickFoldAnchor`)。返回值也不要:
   * 这一路的开合态由 `retiring` 那格 prop 说,不由这里写。
   */
  const report = useGeometryReport()
  const wasRetiring = useRef(retiring)
  useLayoutEffect(() => {
    const started = retiring && !wasRetiring.current
    wasRetiring.current = retiring
    if (!started) return
    if (currentMotionTier() === 'none') return
    report.toggle({ el: null, open: false, durationMs: CARD_FLIP_MS })
  }, [retiring, report])

  // 只有模型说的话要装配。用户消息是一个气泡、错误消息是一张卡,它们没有段 ——
  // 给它们也跑一遍管线不只是白跑,还会往 memo 里塞一份永远没人读的段序列。
  //
  // 装配是纯函数 + 按消息引用 memo,所以这一句在非活跃消息上是一次 WeakMap 命中。
  const prose = role === 'assistant' || role === 'system'
  const segments = prose ? assembleMessage(message) : EMPTY_SEGMENTS
  // `sessionId` 进 ctx(U2):段里唯一按会话动手的那件事(压缩折痕失败态的重试)
  // 要知道打给谁,而「当前会话」在会话多开时说不清这件事 —— 判据与 MessageActions
  // 收 sessionId 逐字同源。它对其余每一种段都是一格没人读的字段,零行为变化。
  const ctx = useMemo(
    () => ({ messageId: message.id, streaming, sessionId }),
    [message.id, streaming, sessionId],
  )

  return (
    <article className={className} data-message-id={message.id} data-role={role}>
      {/* 用户那一条**不走这一行**了(09-14):它与在飞那几格同为 `UserBubble`,
          否则落账那一拍元素类型一换,同 key 也保不住那个 DOM 节点。 */}

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
            * ── 第一个字之前那段空档:**这一行里不画了**(G 线 P1,2026-09-20)──────
            * 从前这里是一道在扫的等待折痕(09-15 单 A ③;再往前是三颗点)。它与那枚
            * 流式光标一起搬去了整列末尾的尾槽,判词在正本
            * `docs/stream-geometry-2026-09.md` §0 的 ③④ 与 §1 的 G4:**只在流式期
            * 存在的东西不许住在流里** —— 它一卸载就带走一个行盒(收尾那一帧整屏下移
            * 23.8px),而排在它下面的读数行被每一段正文推一次(整轮 303 次)。
            * 「这一轮在等第一个字」今天由 `ChatStream` 顶层判一次、交给尾槽画一次,
            * 这一行因此对它没有话要说。
            */}
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
            光标从前画在这里(`streaming && segments.length > 0`),而它**独占一行**:
            收尾那一帧条件渲染把它卸掉,带走一个行盒,贴着底的页面被浏览器钳一下
            —— §0 的病 ③,真机 23.8px。G 线 P1 起它住在列尾那一格尾槽里,换的只有
            `opacity`。这里不留第二份。
          */}
          {/*
            消息外缘的那一行:**一格常驻的动作格**(复制 / 重试),悬停或焦点进来
            才浮现。动作行常驻在 DOM 里(只动 opacity)—— 条件渲染会让它浮现时把
            下文推下去。只有 assistant 有动作:system(压缩卡)不是"一条回答",
            没有重跑一说;user 的动作是编辑重发,那是另一件事(留账)。
          */}
          {/*
            收场通知(2026-09-09):这一轮**为什么提前结束**。它与动作行同时在场 ——
            读数行那条「同一个位置只有一个」说的是「生成中 vs 生成完」这两态,而这
            一行属于生成完的那一态,是动作行上面的一句陈述,不是第三态。
            判据只有一个 `message.stop`:投影已经把「哪些收场值得说」与「结局成没
            成立」两道闸都判完了(`core/session/projection/stop-reasons.ts` +
            `materializeStop`),壳这边**不再抄第二份判据**。`!streaming` 这一问是
            防御(活消息按定义拿不到这一格),留着是因为壳上还有尾巴合成那条路。
          */}
          {!streaming && message.stop && (
            /* 事后出现的那一件:收尾那一帧才知道,所以软着陆(判词在 `.lateRow`)。 */
            <div className={s.lateRow}>
              <StopNotice stop={message.stop} hasVisibleText={hasVisibleProse(segments)} />
            </div>
          )}
          {/*
            * ── 外缘那一行:一格常驻、高度不随内容变(单 B ⑤ 立,G 线 P1 只剩一张脸)──
            * 从前这里是两句条件渲染,收尾那一帧卸掉读数行、挂上动作行 —— 两者高度
            * 不同,内容因此缩一截,贴着底的页面被浏览器钳一下 `scrollTop`(单 A 的门
            * 量到 12px)。单 B ⑤ 把它们收进一格 grid;G 线 P1 又把读数那张整个搬去
            * 列尾的尾槽,所以今天这一格只剩动作行 —— 而「它常驻、只动 opacity」
            * 那条 08-31 的纪律一个字没动。判词整段在 `MessageChrome.tsx`。
            */}
          <MessageChrome
            streaming={streaming}
            actions={
              role === 'assistant' ? (
                <MessageActions
                  sessionId={sessionId}
                  messageId={message.id}
                  text={message.content ?? ''}
                />
              ) : undefined
            }
          />
        </>
      )}
    </article>
  )
})

/**
 * **一条用户发言 —— 不论它此刻在账本上还是还在飞**(09-14,所见即所发;正本 §6.2)。
 *
 * ── 它为什么是一只组件而不是两只 ──────────────────────────────────────────
 * 从前在飞与落账是两只(`OverlayRow` 与 `MessageRow` 的 user 分支),画法也不同:
 * 在飞画 `{entry.text}` 纯文本(一整串 `@/绝对路径`),落账画 `contentParts` 切出来
 * 的 chip。于是用户按下回车看见的是 **chip → 整串路径 → 另一种 chip**,两次换形。
 *
 * 合成一只之后,落账那一拍 React 在同一张表里按 key 认出「还是它」——
 * **DOM 节点原样留着**,变的只有 `data-pending` 与那一格不透明度。这就是样例页
 * 「屏上读数:气泡 DOM 前后逐字相同」在真壳里的实现。
 *
 * ── 三张状态表 ────────────────────────────────────────────────────────────
 * ① **生命周期**:乐观建(`chat-source.send` 那一次 `set`)→ 落账,同节点翻成
 *    `landed` → 发不出去翻 `failed` → 重试翻回 `pending` → 「不发了」卸载。
 *    没有挂载 / 卸载动作要做:两口动作是 store 上的,没有订阅也没有计时器。
 *    **换宿主**不适用(它长在消息列里,不进浮窗 / 架子)。
 *    **留账**:steering 降级那条路自己铸 id,乐观那一格没有 `messageId`,
 *    落账时 key 从 `entry.id` 换成 `message.id` —— 那一条仍会换节点。
 * ② **UI 生命状态**:`pending`(淡一档)/ `failed`(危险底 + 脚注两钮)/
 *    `landed`(常态)。没有 empty / loading:一条发言要么在,要么不在。
 *    **超量**:一条消息 60 枚引用 + 2000 字 —— 段序列按引用数线性,chip 自己
 *    `max-width` 截断(`--refchip-name-max`),气泡按 `.user` 的 80% 宽折行;
 *    这一行整体走 `.row` 的 `content-visibility: auto`,没进视口不排版。
 * ③ **UI 交互状态**:chip 的 rest / hover / focus / pending 归 `ReferenceChip`
 *    (全壳一份皮);失败脚注那两颗微型文字动作 rest / hover 归 `.pendingAction`。
 *    气泡本身没有 hover / 选中态 —— 它不是一个可操作的东西。
 *
 * `memo`:与 `MessageRow` 同一条理由(流式期间列表数组每帧是新的)。props 里
 * `segments` / `parts` 按消息或 entry 的引用稳住,其余是原始值,默认浅比就够。
 */
const UserBubble = memo(function UserBubble({
  t,
  sessionId,
  messageId,
  text,
  parts,
  segments,
  status,
  attachments,
  attachmentCount = 0,
  error,
  entryId,
  flash,
}: {
  t: TFn
  sessionId: string
  /** 账本上那条的 id。在飞时缺席 —— 它还不是账本上的一条。 */
  messageId?: string
  text?: string
  parts?: readonly UserContentPart[]
  segments?: readonly ResolvedSegment[]
  status: 'pending' | 'failed' | 'landed'
  attachments?: readonly MessageAttachmentMetadata[]
  attachmentCount?: number
  error?: string
  /** overlay 那一格的号(两口动作按它认)。落账之后缺席。 */
  entryId?: string
  flash?: boolean
}) {
  // 两口动作也跟着这条会话走 —— overlay 是「这条会话的屏幕」上的车道。
  const retry = useChatSourceOf(sessionId, (st) => st.retry)
  const dismiss = useChatSourceOf(sessionId, (st) => st.dismiss)
  const landed = status === 'landed'
  const failed = status === 'failed'
  const images = attachments?.filter(isImageAttachment) ?? []
  const files = attachments?.filter((a) => !isImageAttachment(a)) ?? []
  const hasBody = Boolean(segments?.length || parts?.length || text?.trim())
  const showBubble = hasBody || files.length > 0 || failed
  const bubble = (
    <div
      className={[s.user, !landed && s.pending, failed && s.pendingFailed]
        .filter(Boolean)
        .join(' ')}
      /* 门与用例按它找在飞那一格;落账之后它**不在了** —— 那正是「认领成了」。 */
      data-testid={landed ? undefined : `chat-pending-${failed ? 'failed' : 'sending'}`}
    >
      {/* 三个来源一条判据链:现成的段 ▷ 部件 ▷ 正文(判词在 user-message 文件头)。 */}
      <UserMessageBody text={text} parts={parts} segments={segments} />
      <UserFiles attachments={files} />
      {!attachments?.length && attachmentCount > 0 && (
        <span className={s.sentAtt}>
          <ClipIcon className={s.sentAttIcon} strokeWidth={1.8} aria-hidden="true" />
          {attachmentCount}
        </span>
      )}
      {failed && entryId !== undefined && (
        <span className={s.pendingFoot}>
          {/* 失败的理由照抄后端说的 —— 渲染层不替它编一句更好听的。 */}
          <span className={s.pendingError}>{error}</span>
          {/*
            * 三类判的第三类:脚注上的**微型静默文字动作**(fs-micro / 无边框无底 /
            * 长在一行错误说明的旁边),视觉本该定制 —— 与批 3 把「加载更多」判进
            * 基座同一形。换成 `ui/Button` 会在这一行里塞进两颗 28 高的描边钮,
            * 那不是等价替换而是改版。皮肤留本地,清 UA 归 `ui/ButtonBase`。
            */}
          <ButtonBase className={s.pendingAction} onClick={() => retry(entryId)}>
            <RetryIcon className={s.pendingIcon} strokeWidth={1.9} aria-hidden="true" />
            {t('chat.retry')}
          </ButtonBase>
          <ButtonBase className={s.pendingAction} onClick={() => dismiss(entryId)}>
            {t('chat.discard')}
          </ButtonBase>
        </span>
      )}
    </div>
  )

  return (
    /*
     * `article[data-role="user"]` 是 DOM 契约(门在数它、TOC 按 `data-message-id`
     * 找它)。在飞那一格**也是它** —— 不然落账那一拍元素形一换,同 key 也保不住
     * 那个节点。`data-pending` 是「此刻是哪一档」的产地(落账之后它就不在了)。
     */
    <article
      className={[s.row, flash && s.flash].filter(Boolean).join(' ')}
      data-message-id={messageId}
      data-role="user"
      data-pending={landed ? undefined : status}
    >
      {/*
        * 图站在气泡**外面**(2026-09-16 比稿 A):图在上、气泡在下。只有图、又没有要说的话
        * (没有正文、没有别的文件、也没失败要挂重试)时,气泡整个不画。判词在 user-attachments。
        */}
      {images.length > 0 ? (
        <div className={u.withImages}>
          <UserImages sessionId={sessionId} images={images} pending={!landed && !failed} />
          {showBubble && bubble}
        </div>
      ) : (
        bubble
      )}
    </article>
  )
})

/** 拒绝也进流:一次没回答**也是一次回答**,不该在记录里消失,只是说得轻一点。 */
function NoticeRow({ t }: { t: TFn }) {
  return <div className={`${s.user} ${s.declined}`}>{t('ask.rejected')}</div>
}

/**
 * ── 上下文更新那一道折痕(U5,09-09 裁定)────────────────────────────────
 * `turnContext` 是**宿主在这一回合开始时补给模型的上下文** —— 是回合的事,
 * 不是用户说的话。数据照旧存在用户消息上(它是发给模型的那条消息的一部分,
 * 账本一个字不动),**呈现**却不该挂在气泡下面:挂在那里读起来像
 * 「用户还说了这些」。所以它是用户那一行**之后**、下一行**之前**的独立一行,
 * 与压缩折痕同属「系统在两回合之间做的事」这一族。
 *
 * 它**不带 `data-message-id`** —— 那个属性是 TOC / `locate-message` 找消息的
 * 唯一接缝,多一个不是消息的元素挂上去,钢琴键就会落到一行折痕上。
 * 它报的是 `data-context-of`:这道折痕说的是**哪条消息**那一回合的事。
 *
 * `.rowLate` = **事后出现的行**(判词在 `ChatStream.module.css`):这一行不是随
 * 消息一起来的,它在回合开张之后才补上,所以高度 / 行距 / 不透明度三量一起软着陆。
 */
/**
 * ── 重试那一路的空折痕:**G 线 P1 删了**(2026-09-20)────────────────────────
 *
 * 09-15 单 B ⑥ 给重试那一路单开了一行 `article[data-retry-of]`,里面画一道在扫的
 * `WaitingSeam`(那一件已随 P1b 裁定 B 删除)。理由是「按下即开槽:那段真空里屏幕上
 * 要有回音」。**回音这件事没有变,变的是它画在哪** —— 今天「这一轮在跑」由列尾那一格尾槽统一画一次
 * (`retryingId` 在场就算在跑,见上面 `tailRunning`),所以这一行连同它那条
 * `data-retry-of` 一起退役:同一句话不许在屏幕上说两遍,而且这一行是**事后插进
 * 列里的一行**,插与拔各推一次下文,正是 §1 的 G4 要拆掉的那一种。
 *
 * 旧回答的上折(`.rowRetiring`)一个字没动 —— 那是「按下即开槽」在**几何上**的
 * 那一半,与折痕画在哪无关。
 */

function contextSeamRow(message: ProjectedMessage) {
  return (
    <article
      key={`${message.id}#context`}
      className={`${s.row} ${s.rowLate}`}
      data-context-of={message.id}
    >
      {/*
        * **这一行不扫了**(G 线 P1,正本 §2 拍点 2:「等待指示只留一处:尾部」;
        * P1b 之后连尾部那一处也不扫了 —— 扫光那张脸整件退役,见 §8 裁定 B)。
        * 09-15 那版让它在等第一个字时翻成 `running` 替 `WaitingSeam` 扫一道,
        * 于是屏上有两处在等 —— 用户 09-20 报的第一件就是「发送后屏上有两处在等的
        * 动画」。上下文更新本身是**已经发生完**的事,它恒 `settled`。
        */}
      <ContextDeltaSeam turnContext={message.turnContext} />
    </article>
  )
}
