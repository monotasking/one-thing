import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react'
import { chatSources, loadOlderChatMessages, useChatSourceOf } from '../data/chat-source'
import {
  applyScrollAnchor,
  measureScrollAnchor,
  readSessionScrollAnchor,
  saveSessionScrollAnchor,
  type ScrollAnchor,
} from '../data/session-view-state'
import { CHAT_WINDOW_STEP, growChatWindow, useChatWindowStart } from './chat-window'
import { sessionRefIdOf } from './session-ref'
import type { ProjectedMessage } from '../data/chat-fold'
import type { ResolvedSegment } from '../references/segment'
import { useT, type TFn } from '../i18n'
import { resolveIcon } from '../components/icons'
import {
  EXPAND_HOLD_MS,
  SCROLL_ANCHOR_SETTLE_MS,
  currentMotionTier,
  sendLandMs,
} from '../components/motion'
import { ButtonBase } from '../ui/ButtonBase'
import { FrameCoalescer } from '../ui/frame-coalescer'
import { assembleMessage, segmentKey } from './assemble'
import { ContextDeltaSeam, hasContextDelta } from './ContextDeltaSeam'
import { seatHeight, type SeatGeometry } from './seat'
import { WaitingSeam } from './seam/WaitingSeam'
import { ExpandIntentContext } from './expand-intent'
import type { SegmentModel } from './model/segments'
import { MessageActions } from './message/MessageActions'
import { StopNotice } from './message/StopNotice'
import { StreamReadout } from './message/StreamReadout'
import { MessageSourceFoot } from './research/SourceFoot'
import { SegmentView } from './SegmentView'
import { UserMessageBody } from './user-message'
import type { UserContentPart } from './user-message'
import { FocusScope } from '../focus/FocusScope'
import { usePanelVisibility } from './visibility'
import { FollowPill } from './FollowPill'
import {
  AT_BOTTOM_EPS,
  FOLLOW_PINNED,
  followShouldStick,
  reduceFollow,
  type FollowEvent,
  type FollowState,
} from './follow'
import s from './ChatStream.module.css'

const ClipIcon = resolveIcon('Paperclip')
const RetryIcon = resolveIcon('RotateCcw')

/**
 * 进场落回锚点之后**最多再对几轮**(2026-09-10)。
 *
 * 它不是一段时长(所以不进 `components/motion.ts` 那张时长镜像表),是一个
 * **轮数上限**:一轮 = 一次尺寸变化回调,也就是「又有一批跳渲的行渲出了真高」。
 * 六轮是「有界」这件事的落点 —— 停不下来就说明有别的东西在改排版,那时候老实
 * 停手比跟着跑一辈子好。判词全文在下面那只 ResizeObserver 的落位分支里。
 */
const ANCHOR_RESETTLE_ROUNDS = 6

/**
 * 座位那一格的**属性名**(正本 `docs/send-flow-2026-09.md` §3)。
 *
 * 它**不带 `data-message-id`** —— 那个属性是 TOC / `locate-message` 找消息的唯一
 * 接缝,给一块空白挂上去,钢琴键就会落到一块空白上(与上下文更新那一行同一条判例)。
 * 量几何的那几处按这个名字把它剔出去:座位不是「这一轮长了多高」的一部分。
 */
const SEAT_ATTR = 'data-seat'

/**
 * 量座位时**从列尾往回数几格**。
 *
 * 它是一个**格数**不是一段长度,所以既不进 tokens 也不进 `components/motion.ts`
 * (与 `ANCHOR_RESETTLE_ROUNDS` / `CHAT_NEAR_TOP_SCREENS` 同一族)。
 * 这一轮在列尾最多占四格:自己那条气泡、上下文更新那一行、偶尔一张压缩折痕、
 * 助手那一行,再加列尾那块座位垫块 —— 六格留一格富余。数不到就是「这一刻没有
 * 座位可算」,答 `undefined`,不退回去扫全表(扫全表就是每帧按整份账本计价)。
 */
const SEAT_SCAN = 6

/**
 * **量这一刻的座位几何** —— 只读,一次读完(算在 `content/seat.ts` 里)。
 *
 * 读点两处:那只 ResizeObserver 的回调(排版之后,白拿)与发送那一拍的 layout
 * effect(那一次要逼一次排版,躲不掉 —— 座位必须在滑动之前就写到位)。
 * 拿不到就答 `undefined`,调用方当「没有座位」处理。
 *
 * 一次 `getComputedStyle` 取四格:置顶线、输入框那格内衬、字号与行高。
 * 自定义属性是**继承**的,所以从滚动容器上就取得到阅读轴那两格(三档各不相同)。
 */
function measureSeat(el: HTMLElement): SeatGeometry | undefined {
  const column = el.firstElementChild
  if (!(column instanceof HTMLElement)) return undefined
  /*
   * ── 从**列尾往回数**,不是 `querySelectorAll`(2026-09-15)────────────────
   * 这一句每一次尺寸变化都要跑一遍(流式期间约每秒 60 次),而
   * `column.querySelectorAll('[data-role="user"]')` 是一次**整棵子树**的前序遍历
   * ——400 条消息的会话上,那就是把 09-01 那笔「每帧按整份账本计价」的账又记一遍。
   * 这一轮就住在列尾:自己那条气泡与它后面那几行(上下文更新行 / 压缩折痕 /
   * 助手那一行),往回数几格就够。`SEAT_SCAN` 给的是上限 —— 数不到就答
   * `undefined`(没有座位),而不是退回去扫全表。
   */
  const kids = column.children
  let user: HTMLElement | undefined
  /** 这一轮最后一件内容 —— 座位垫块自己不算(它正是要算的那个数)。 */
  let last: Element | undefined
  for (let i = kids.length - 1; i >= 0 && i >= kids.length - SEAT_SCAN; i -= 1) {
    const node = kids[i]
    if (node.hasAttribute(SEAT_ATTR)) continue
    if (!last) last = node
    if (node.getAttribute('data-role') === 'user' && node instanceof HTMLElement) {
      user = node
      break
    }
  }
  if (!user || !last) return undefined
  const style = getComputedStyle(el)
  const px = (value: string) => Number.parseFloat(value)
  const userRect = user.getBoundingClientRect()
  return {
    viewportHeight: el.clientHeight,
    sendLine: px(style.getPropertyValue('--send-line')),
    reserveBelow: px(style.paddingBlockEnd),
    lineHeight: px(style.getPropertyValue('--pr-fs')) * px(style.getPropertyValue('--pr-lh')),
    userHeight: userRect.height,
    tailHeight: last.getBoundingClientRect().bottom - userRect.top,
  }
}

/**
 * 自己那条气泡该停在哪 —— **滑到置顶线**那一下的目标 `scrollTop`(规矩 ①)。
 *
 * 换算成内容坐标再减去置顶线,最后夹进 `[0, 最大可滚]`:座位写对了的时候这个夹子
 * 是一次恒等(座位的定义就是「让这个位置恰好滚得到」),写不对时它保证不会去
 * 要一个不存在的位置。
 */
function sendLineTarget(el: HTMLElement): number | undefined {
  const column = el.firstElementChild
  if (!(column instanceof HTMLElement)) return undefined
  /* 同一条:从列尾往回数,别在 400 条的树上做整树前序遍历(判词在 `SEAT_SCAN`)。 */
  const kids = column.children
  let user: HTMLElement | undefined
  for (let i = kids.length - 1; i >= 0 && i >= kids.length - SEAT_SCAN; i -= 1) {
    const node = kids[i]
    if (node.getAttribute('data-role') === 'user' && node instanceof HTMLElement) {
      user = node
      break
    }
  }
  if (!user) return undefined
  const sendLine = Number.parseFloat(getComputedStyle(el).getPropertyValue('--send-line')) || 0
  const top = user.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
  return Math.max(0, Math.min(top - sendLine, el.scrollHeight - el.clientHeight))
}

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
   * **这一帧真的摆出去的那几条**(= 消息数组的一个后缀)。
   *
   * 全量到齐(`windowStart === 0`)之后与从前逐字相同 —— 连数组对象都是原来那个,
   * 所以下游那些按引用短路的 memo 一格没动。
   */
  const visible = useMemo(
    () => (windowStart <= 0 ? messages : messages.slice(windowStart)),
    [messages, windowStart],
  )
  const expandOnScroll = useTailWindow(
    scrollRef,
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
   * 理由是产地唯一:跟随事件今天六种,六种全在 `useFollowBottom` 里发 —— 那只
   * hook 因此是「什么算一次跟随事件」的完整答案。把其中一种挪到组件里,读代码的人
   * 就得同时看两处才知道状态机被谁推过,而 `dispatch` / `followRef` 那对镜像也得
   * 跟着漏出去(它们是 hook 的内脏)。
   */
  /*
   * 滚动那一路上串着两件事:**扩窗**(翻到窗口顶部附近就当场补一批,不等空闲)
   * 与摆这片叶的人自己那口(目录同步)。串在这里而不是塞进 `useFollowBottom` ——
   * 那只 hook 的自述是「跟随事件的六种产地全在我这儿」,扩窗不是跟随事件。
   */
  const onScrollOutward = useCallback(() => {
    expandOnScroll()
    onScroll?.()
  }, [expandOnScroll, onScroll])

  /**
   * **座位垫块**(正本 `docs/send-flow-2026-09.md` §3)。
   *
   * ref 在这一层是因为**摆它的是这一层**(它是消息列的最后一格),而量它、写它的是
   * 下面那只 hook —— 与 `scrollRef` 由外面那一层给、hook 只管用同一条分工。
   */
  const seatRef = useRef<HTMLDivElement | null>(null)

  const { follow, jumpToBottom, onScrollWithFollow, noteUserExpand, seatActive } = useFollowBottom(
    scrollRef,
    seatRef,
    foldedSessionId,
    messages,
    sentTick,
    lastDeltaAt,
    activeMessageId,
    onScrollOutward,
  )

  /*
   * ── 这一轮此刻在等第一个字吗(规矩 ③)────────────────────────────────────
   * 判据是**既有那一句**:「这条活消息此刻画得出什么」= 装配管线的段序列空不空。
   * 它从前只在 `MessageRow` 里问(三颗点的判据),09-15 之后这一层也要问一次 ——
   * 等待折痕与上下文更新折痕**合成一行**,而「有没有上下文更新行」是这一层的事
   * (那一行由 `flatMap` 摆在用户消息后面)。
   *
   * **取的是列尾那一条,不是 `find`**:活消息按定义是账本最后一条(这一轮的回复),
   * 流式期间这一句每帧都要跑,`find` 就是每帧扫一遍整篇抄本。`assembleMessage` 是
   * 纯函数 + 按消息引用 memo,所以这一句与 `MessageRow` 里那一句里**只有一次**真算,
   * 另一次是 WeakMap 命中。
   */
  const tailMessage = messages[messages.length - 1]
  const awaitingFirstToken =
    tailMessage !== undefined
    && tailMessage.id === activeMessageId
    && assembleMessage(tailMessage).length === 0
  /**
   * 等着的这一轮**有没有**上下文更新行 —— 有就由它扫(`sweeping`),
   * `WaitingSeam` 不再单画一道空的。
   *
   * 那一行挂在**发起这一轮的那条用户消息**上,所以要从列尾**往回找最近的一条用户
   * 消息** —— 不是「倒数第二条」:两条之间夹得下别的东西(压缩折痕那条 `system`
   * 消息在 50MB 的会话上每轮都来一条,还有系统消息),倒数第二条一撞上它就答
   * `undefined`,于是 `WaitingSeam` 也画一道 —— 屏幕上并排两道折痕,而规矩 ③ 说的
   * 是**一轮只扫一道**。
   *
   * 往回数而不是扫全表,纪律与 `measureSeat` 同一条(上限同 `SEAT_SCAN`):
   * 这一句在流式期间每帧都跑,`findLast` 整份抄本就是每帧按整份账本计价。
   * 数不到就答 `undefined` —— 那时 `WaitingSeam` 画一道空的,是对的降级。
   */
  const sweepingContextOf = (() => {
    if (!awaitingFirstToken) return undefined
    for (let i = messages.length - 2; i >= 0 && i >= messages.length - 2 - SEAT_SCAN; i -= 1) {
      const owner = messages[i]
      if (owner?.role !== 'user') continue
      return hasContextDelta(owner.turnContext) ? owner.id : undefined
    }
    return undefined
  })()

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
        /*
         * ── 「是我点开的」那一条通道(2026-09-12 报障二)────────────────────────
         * 流里任何一件可展开的东西(折痕 / 思考段 / 工具卡)点开时报一句,跟随那只
         * 观察者据此在 `EXPAND_HOLD_MS` 内按兵不动 —— 几何分不出「模型又吐了一段」
         * 与「人点开了一段」,所以必须由动手的那一方自述(判词在 `expand-intent.ts`)。
         *
         * 值是 `useCallback` 出来的,**身份恒定** —— 所以 `MessageRow` / `ToolCard`
         * 那几层的 memo 短路一格没动(context 的值不变,消费者不会被推着重渲)。
         */
        <ExpandIntentContext.Provider value={noteUserExpand}>
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

            {/*
              * ── 顶端那一行读数(2026-09-10 工单 5 ⑥)────────────────────────────
              * 三档一句话:本地窗口还没摆完 **或** core 说上面还有 → 「还有更早的」;
              * 正在取 → 「正在取更早的…」;两样都没有 → 「已到开头」。
              *
              * 只在**有内容**时画:空态那三行自己会说话,再叠一句「已到开头」是废话。
              * 禁 spinner(规范禁令第一条:列表/卡的加载态用文字)。
              */}
            {sessionId && status === 'ready' && messages.length > 0 && (
              <p className={s.olderMark}>
                {loadingOlder
                  ? t('chat.olderLoading')
                  : windowStart > 0 || hasMoreBefore
                    ? t('chat.olderMore')
                    : t('chat.olderNone')}
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
                    attachments={0}
                    flash={message.id === flashMessageId}
                  />
                )
                return hasContextDelta(message.turnContext)
                  ? [row, contextSeamRow(message, message.id === sweepingContextOf)]
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
                   * 活性读数只交给**正在跑的那一条**。其余每一行拿到的都是 `undefined`
                   * —— 一个恒定的值,所以 `memo` 的浅比照旧短路(流式期间除活消息外
                   * 全篇不重渲那条纪律一格没动)。
                   */
                  lastActivityAt={message.id === activeMessageId ? lastActivityAt : undefined}
                  /*
                   * **这一行要不要自己画那道等待折痕**(规矩 ③)。活消息之外的每一行
                   * 拿到的都是 `false` —— 一个恒定的值,所以 `memo` 的浅比照旧短路。
                   * 上下文更新那一行接过这件事时它也是 `false`:一轮只扫一道折痕。
                   */
                  waitingSeam={message.id === activeMessageId && sweepingContextOf === undefined}
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
                        attachments={entry.attachments}
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
              ...(seatActive
                ? [
                    <div
                      key="seat"
                      ref={seatRef}
                      className={s.seat}
                      data-seat=""
                      aria-hidden="true"
                    />,
                  ]
                : []),
            ]}
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
        </ExpandIntentContext.Provider>
      )}
    </FocusScope>
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
   * 不会因为窗口变了就换一只,`useFollowBottom` 那边的监听也就不必重挂)。
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
      // 拿去写 `scrollTop`。位置由取回那一拍统一恢复(见 `useParkedScroll`)。
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
    el.scrollTop = captured.top + delta
    /*
     * `olderTick` 一起进依赖表:**取回一页也是一次 prepend**,补的是同一件事
     * (上面凭空长出一截),用的是同一手绝对赋值。差别只在捕获的时刻 ——
     * 扩窗那一下几何捕在写 state 之前(同步),取页那一下捕在**发请求**的时候
     * (`expandOnScroll` 里,那一刻本来就在读同一批几何)。中间这几十毫秒人还能
     * 再滚一点,那点漂移由「绝对赋值是幂等的」兜住:浏览器自己的滚动锚定补没补过
     * 都得同一个结果(它不改 `scrollHeight`)。
     */
  }, [windowStart, olderTick, scrollRef])

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
 *    **2026-09-10 起它是跟底的唯一产地**(从前还有一只「每一次提交都贴底」的
 *    无依赖 layout effect 在旁边顶着,那笔 834ms 的账见下面那段病历)。
 * ③ **没有计时器、没有「这一下是我自己滚的」标志位**(判据的全文写在 follow.ts
 *    的文件头)。我们自己落底那几下正正好在底,人往上翻才会离底。
 *
 * ── 它还管一件事:进场落在哪儿(C1 · §5.2)────────────────────────────────
 * 缺省落底照旧;记着锚点、而且那条消息此刻真在树上时改落回锚点,离场时把锚点
 * 交给 `data/session-view-state`。「哪一条 + 差多少」的量法与用法都在那只文件里,
 * 这里只说**什么时候**问它、什么时候交给它(判词见下面那只 layout effect)。
 */
function useFollowBottom(
  scrollRef: RefObject<HTMLDivElement | null> | undefined,
  seatRef: RefObject<HTMLDivElement | null>,
  sessionId: string,
  messages: readonly ProjectedMessage[],
  sentTick: number,
  lastDeltaAt: number | undefined,
  activeMessageId: string | undefined,
  onScroll: (() => void) | undefined,
): {
  follow: FollowState
  jumpToBottom: () => void
  onScrollWithFollow: () => void
  noteUserExpand: () => void
  /** 这条会话此刻有没有座位(= 这次进场之后自己发过话)。摆垫块的判据。 */
  seatActive: boolean
} {
  const [follow, setFollow] = useState<FollowState>(FOLLOW_PINNED)
  /*
   * 状态的**镜像**。滚动回调与 ResizeObserver 都在 React 之外跑,它们要的是
   * 「此刻是哪一格」而不是「上一次渲染时是哪一格」—— 读 state 会慢一帧,而
   * 那一帧正好是流式期间每一帧都要判的那一次。写 ref 与写 state 在同一句里,
   * 两者不会分叉(唯一的写点是下面那只 `dispatch`)。
   */
  const followRef = useRef<FollowState>(FOLLOW_PINNED)

  /*
   * 「此刻树上有没有东西」的镜像。**它只有一个读者**:进场那一下要不要落底
   * (空树时没有底可落)。写在渲染期而不是进依赖表 —— 进了依赖表就等于让
   * 「消息变了」重跑一次进场,而那正是本批拆掉的那种耦合。
   */
  const messageCountRef = useRef(0)
  messageCountRef.current = messages.length

  const dispatch = useCallback((event: FollowEvent) => {
    const next = reduceFollow(followRef.current, event)
    // 纯函数在「什么都没改」时返回同一个对象 —— 流式每帧那一次 `grew` 于是白送。
    if (next === followRef.current) return
    followRef.current = next
    setFollow(next)
  }, [])

  /**
   * **人此刻停在第几像素**(2026-09-10 组件级停靠立的,2026-09-12 多了一个读者)。
   * 写点两处:滚动回调(人滚的)与 `stick`(我们贴的)—— 两处写的是同一件事实。
   * 读点两处:取回那一拍(`useParkedScroll`),与滚动回调里「是谁离的底」那一句。
   * `undefined` = 这次挂载里一次都没量过 —— 那时缺省的 pinned 会去贴底,不需要它。
   * 声明在 `stick` 之前,因为 `stick` 要写它。
   */
  const lastTopRef = useRef<number | undefined>(undefined)

  /**
   * 贴底。**唯一**一处写 `scrollTop`,三个调用点(进场 / 长高 / 点丸)都经它。
   *
   * **停靠中不写**(2026-09-10 组件级停靠):`content-visibility: hidden` 的子树
   * 里没有盒子,`scrollHeight` 与 `clientHeight` 一律报 0,赋一次 `scrollTop = 0`
   * 就是把这条会话的位置抹掉 —— 而人只是切去看了别的会话。判据用几何
   * (`clientHeight === 0`)而不是「宿主说我看不见」:它对任何一种藏法都成立,
   * 与 `tools/card-heights` 那句 `height <= 0` / clamp-measurer 同一把尺子。
   */
  const stick = useCallback(() => {
    const el = scrollRef?.current
    if (!el) return
    if (el.clientHeight === 0) return
    el.scrollTop = el.scrollHeight
    /*
     * 贴完当场记下「人此刻在第几像素」,不等下一帧那个滚动事件来记(2026-09-12)。
     * `onScrollWithFollow` 拿它判「是谁离的底」(人往上翻 = `scrollTop` 变小):
     * 滚动事件比 RO 晚一帧,不在这里写的话,下一帧人往上翻的那一下会拿**贴底之前**
     * 的位置当参照 —— 内容一帧长的比他翻的多,这一下就被读成「没往回走」而吞掉,
     * 要等再翻一下才逃得出去。在这里写掉,参照永远是真的底,一下就认出来。
     */
    lastTopRef.current = el.scrollTop
  }, [scrollRef])

  /** 「下面还有多少没露脸」。判据与 `follow.ts` 的 `scrolled` 用的是同一个式子。 */
  const readGap = useCallback(() => {
    const el = scrollRef?.current
    if (!el) return 0
    return el.scrollHeight - el.clientHeight - el.scrollTop
  }, [scrollRef])

  /**
   * 上一次量到的 gap。**它的唯一用途是回答「刚长出来的那一截在不在视口下面」**
   * (判词全文在下面那只 ResizeObserver 的注里):长在视口**上面**的内容会被
   * 浏览器的滚动锚定(scroll anchoring)顶回去,gap 不变;长在下面的才让 gap 变大。
   * 三个写点:进场落定、滚动停下、RO 回调 —— 也就是 gap 会变的全部三条路。
   */
  const lastGapRef = useRef(0)

  /**
   * **人自己点开的那样东西还在长,到这一刻为止**(2026-09-12 报障二的「位」)。
   *
   * 0 = 没有这回事。写点只有一处(下面那只 `noteUserExpand`,由
   * `content/expand-intent.ts` 那条 context 交到每一件可展开的东西手里),
   * 读点也只有一处(RO 回调里那一格判据)。
   */
  const holdUntilRef = useRef(0)

  /**
   * 「这一下是用户点开的」。
   *
   * 记的是一个**截止时刻**而不是一个布尔闩:展开是一段过渡 / FLIP,尺寸变化会
   * **逐帧**来好几次,一次性闩被第一帧消费掉之后,后面那几帧照旧贴底(报障二
   * 仍在);而且短会话里第一帧往往还没溢出,gap 仍是 0,状态压根不会翻成 browsing。
   * 窗长的推导写在 `EXPAND_HOLD_MS` 上。
   *
   * **为什么不是 `transitionend`**:动效档「无」下它根本不发、被打断时也不发,
   * 而且四个消费者(折痕 / 压缩折痕 / 思考段 / 工具卡)各自的过渡挂在各自的元素上,
   * 要一一接线;截止时刻是一个数,谁报都一样。
   */
  const noteUserExpand = useCallback(() => {
    holdUntilRef.current = performance.now() + EXPAND_HOLD_MS
  }, [])

  /* ── 座位(正本 `docs/send-flow-2026-09.md` §3;算法在 `content/seat.ts`)─────
   *
   * 三格状态,写点各只有一处:
   *  · `sentBaseRef` —— **进场那一刻的发送号**。座位是「刚发送的这一轮」的产物,
   *    不落盘:换会话就没有(写在渲染期,与 `entryRef` / `messageCountRef` 同一手)。
   *    它顺带把一个旧毛病一起治了:`sentTick` 是**按会话读**的,换会话时那个号
   *    自己就变了,从前那只 effect 会因此派一次根本没发生过的 `sent`(pinned 下
   *    `reduceFollow` 恰好什么都不改,所以没人看见)—— 现在它还会顺手滑一次屏,
   *    那就看得见了,所以基准必须跟着会话走。
   *  · `seatHeightRef` —— 此刻算出来该多高。**算在观察器回调里(只读),写在下一帧**
   *    (`content/../ui/frame-coalescer.ts`:观察器回调只读不写)。
   *  · `seatWrittenRef` —— 已经写进 style 的那个数,省掉每帧一次同值写。
   */
  const sentBaseRef = useRef<{ sid: string; tick: number } | undefined>(undefined)
  if (!sentBaseRef.current || sentBaseRef.current.sid !== sessionId) {
    sentBaseRef.current = { sid: sessionId, tick: sentTick }
  }
  const seatActive = sentTick !== sentBaseRef.current.tick

  const seatHeightRef = useRef(0)
  const seatWrittenRef = useRef<number | undefined>(undefined)
  /**
   * **这一轮真的落到置顶线上了吗**。
   *
   * 座位与那一下滑动是**一件事**:座位的定义是「自己那条停在置顶线上之后,
   * 底下留给回复的那块地」。没滑过就没有那块地 —— 人在上面翻着的时候发送
   * (规矩 ⑦:那时视口不归这一轮)、或者那一拍量不到几何(停靠中 / jsdom),
   * 座位一律是 0,行为与 09-15 之前逐字相同。
   *
   * 垫块本身照旧挂着(`seatActive`):它是一个高度为 0 的空 div,而**留着它**
   * 意味着下一次发送由同一个节点原位接管 —— 上面那些旧内容一像素不动。
   */
  const seatLandedRef = useRef(false)

  /** 把算好的那个数写到垫块上。**只有这一处**碰它的 style。 */
  const writeSeat = useCallback(() => {
    const el = seatRef.current
    if (!el) return
    const next = seatHeightRef.current
    if (seatWrittenRef.current === next) return
    seatWrittenRef.current = next
    el.style.height = `${next}px`
  }, [seatRef])
  /**
   * 下一帧交出去那一格读数。**观察器回调只读不写** —— 座位的第一个读者是这条列
   * 自己的排版,在派发循环里改它正是 Chrome 判「同深度还有没派送的通知」的那一形
   * (09-14 `--composer-h` 那条判例的同族)。
   */
  const seatCoalescerRef = useRef<FrameCoalescer | undefined>(undefined)
  if (!seatCoalescerRef.current) seatCoalescerRef.current = new FrameCoalescer(() => writeSeat())

  /**
   * **量一次座位**(只读),把结果存进 `seatHeightRef` 并排下一帧写。返回算出来的高。
   *
   * 座位不存在(没发过话 / 量不到几何)时恒 0 —— 那正是「退化为今天的落底 + 跟随」。
   */
  const readSeat = useCallback((el: HTMLElement): number => {
    const geometry = seatActive && seatLandedRef.current ? measureSeat(el) : undefined
    const next = geometry ? seatHeight(geometry) : 0
    seatHeightRef.current = next
    /*
     * **只在数真的变了时才排那一帧**。流式期间这一句每秒跑几十遍,而绝大多数
     * 没有座位的会话上它算出来恒是 0 —— 照排的话就是白排一帧 rAF、白跑一次
     * `writeSeat`(与「观察器不许自伤」同一条账)。
     */
    if (next !== seatWrittenRef.current) seatCoalescerRef.current?.schedule()
    return next
  }, [seatActive])

  /* 垫块随会话卸载 / 座位退役时,那格「已写的数」也要归零 —— 不然下一条会话
   * 的第一次写会被一个属于上一棵树的数短路掉。 */
  useEffect(() => {
    if (seatActive) return
    seatWrittenRef.current = undefined
    seatHeightRef.current = 0
    seatLandedRef.current = false
  }, [seatActive, sessionId])
  useEffect(() => {
    const coalescer = seatCoalescerRef.current
    return () => coalescer?.cancel()
  }, [])

  /**
   * **取回那一拍要对的位**(在场 = 「刚被拿回来,还没对过」)。立它的是
   * `useParkedScroll`(零几何读),消它的是下面那只观察者 —— 判词在两处。
   */
  const unparkTopRef = useRef<number | undefined>(undefined)
  /** 宿主说这一份此刻在不在屏上(`content/visibility.ts`)。 */
  const { visible } = usePanelVisibility()

  /**
   * **进场落回锚点还没落稳的那一格**(2026-09-10)。在场 = 「这一批尺寸变化说的是
   * 跳渲的行渲出了真高,不是下面长出了东西」;`left` 是还能再对几轮(有界)。
   * 立它的是进场那只 layout effect,消它的是下面那只观察者(或者换会话)。
   */
  const restoreRef = useRef<{ anchor: ScrollAnchor; left: number } | undefined>(undefined)

  /*
   * 「看到哪儿」的写点 —— **尾随去抖**(C1 · §5.2;判词在下面那只进场 effect 里)。
   *
   * 每一次滚动重排计时器,停稳 `SCROLL_ANCHOR_SETTLE_MS` 之后量一次、记一笔。
   * 连滚一百下只在最后停下来那一次量,而量的是**还挂在文档上**的那个容器。
   *
   * 不设「这一下是不是我自己滚的」标志位 —— 与 `onScrollWithFollow` 同一条纪律
   * (理由全文在 follow.ts 文件头)。我们自己贴底那几下量出来就是 `'bottom'`,
   * 而那句话恰好是真的:此刻人就在最新处。代价是**冷载入那条路上**消息到齐后
   * 的自动贴底会把上一次记的锚点改写成 `'bottom'`(留账 ② 说的「锚点留着下次用」
   * 到此为止)—— 那不是说谎,是这一帧的事实;真要保住它得先治「冷载入不落锚点」
   * 那一格,那是另一单。
   *
   * `measureScrollAnchor` 的量法:在底当场答 `'bottom'`(不扫);不在底才从上往下
   * 扫 `[data-message-id]` 到第一条露脸的 —— 388 条的会话最坏扫满全表,但布局
   * 干净时 `getBoundingClientRect` 是微秒级,而去抖之后每次停手只量这一次。
   */
  const anchorTimer = useRef<number | undefined>(undefined)
  const scheduleAnchorSave = useCallback(() => {
    if (anchorTimer.current !== undefined) window.clearTimeout(anchorTimer.current)
    anchorTimer.current = window.setTimeout(() => {
      anchorTimer.current = undefined
      const el = scrollRef?.current
      // 去抖那一发可能落在**已经被停靠**之后:那时容器没有排版,量出来的
      // 「离底 0」是假的(判词在 `measureScrollAnchor` 的 0 高度那一句上)。
      if (el && el.clientHeight > 0) saveSessionScrollAnchor(sessionId, measureScrollAnchor(el))
    }, SCROLL_ANCHOR_SETTLE_MS)
  }, [scrollRef, sessionId])

  /*
   * 换会话 = 一次新的进场。写在 layout 阶段,好让同一次提交里下面那些 effect 看到它。
   *
   * ── 进场时先问一句「上次看到哪儿」(C1 · §5.2)────────────────────────────
   * 缺省仍旧是**落底**(`enter` → pinned),这一格只在两件事同时成立时改写它:
   * 记着一个消息锚点,**而且**那条消息此刻真的在树上。后半句正是停靠池命中
   * 的那条路 —— 机器没被扔掉,所以进场第一次提交树上就已经有消息了
   * (`chat-source` 那边 `open()` 撞上 `if (fold) return`,一发 `listRaw` 都没打)。
   * 冷载入时树是空的,`applyScrollAnchor` 如实回 false,于是老实落底 ——
   * 「先贴底再跳一次」与「首帧就在底,不许先画顶部再跳」相悖,留账写在
   * `data/session-view-state.ts` 末尾。
   *
   * 落成了之后**补一发 `scrolled`**:那是状态机认得的那句「滚动停下来了,此刻
   * 离底这么远」,它自己会把状态翻成 browsing。不新开一个 `restore` 事件 ——
   * 事件多一个,`follow.ts` 那张转移表就要多一行,而这一下与人自己滚上去
   * 在语义上逐字相同(判据只有位置与意图,见 follow.ts 文件头)。
   *
   * ── 锚点在**节点还活着**的时候量(2026-09-10 修正)──────────────────────
   * 这里从前写着「cleanup 跑在 React 的 mutation 相位、宿主节点摘下来**之前**,
   * 所以那时量到的还是活的排版」。**那句话对子树删除不成立** —— 换会话 /
   * 这片叶卸载走的是整棵子树的删除,React 先把宿主根从文档上摘掉再逐个跑
   * destroy,cleanup 里读到的容器 `isConnected === false`、几何全 0。于是
   * `measureScrollAnchor` 如实答 undefined、`saveSessionScrollAnchor` 不当一次写,
   * 表里**永远是空的**,进场缺省落底,`applyScrollAnchor` 全程一次没被调用过 ——
   * 「切回来滚动位丢」的真因不是量错了,是**根本没量到**。
   *
   * 所以写点搬到还活着的时候:滚动停稳一拍(`SCROLL_ANCHOR_SETTLE_MS`)记一笔,
   * 进场落回锚点成功之后也记一笔(此刻的就是真的)。离场那一拍的量**留着当兜底**
   * ——依赖变化(而不是子树删除)那条路上容器确实还连着,量得到就是白拿一笔;
   * 量不到照旧不写,不拿垃圾冲掉真读数。
   */
  useLayoutEffect(() => {
    dispatch({ type: 'enter' })
    // 换会话不带上一条会话的意图:那格截止时刻说的是「**那边**有人点开了一样东西」。
    holdUntilRef.current = 0
    const el = scrollRef?.current
    /** 落定一次:把「此刻离底多远」交给状态机、记进 gap 基准、把锚点记一笔。 */
    const settle = (container: HTMLElement) => {
      const gap = container.scrollHeight - container.clientHeight - container.scrollTop
      dispatch({ type: 'scrolled', gap })
      lastGapRef.current = gap
      // 落成了 —— 此刻量到的就是真的,当场记一笔,不等这条会话被人再滚一次。
      saveSessionScrollAnchor(sessionId, measureScrollAnchor(container))
    }
    const anchor = readSessionScrollAnchor(sessionId)
    if (el && anchor && anchor !== 'bottom' && applyScrollAnchor(el, anchor)) {
      settle(el)
      /*
       * ── 落完还要再对(2026-09-10,`content-visibility: auto` 的直接后果)──────
       * 消息行现在是**跳渲**的:没进过视口的那些行占的是 `--msg-intrinsic-h` 那个
       * 估高的位。于是这一下算出来的落点是「按估高摆出来的那张排版」里的落点 ——
       * 赋完 `scrollTop`,锚点那一行连同它周围几行当场渲出真高,那张排版就变了,
       * 锚点行跟着漂。真机读数:190 轮的会话上漂掉整整一条消息(切回来停在上一条
       * 回答的中间,离原位 188px)。
       *
       * 所以这里只**立一格「还没落稳」**,真正再对由下面那只 ResizeObserver 做 ——
       * 「跳渲的行渲出真高了」这件事在浏览器那一侧的唯一表现就是**尺寸变了**,
       * 而那正是观察者的定义。不排 `requestAnimationFrame`:帧不是判据(离屏窗口
       * 里它还可能压根不来),而「排一帧再看看」与「变了就再对一次」相比,前者
       * 既可能来早(还没渲完)也可能来晚。
       */
      restoreRef.current = { anchor, left: ANCHOR_RESETTLE_ROUNDS }
    } else if (el && messageCountRef.current > 0 && followShouldStick(followRef.current)) {
      /*
       * ── 进场落底(2026-09-10 从「每一次提交都贴底」那条 effect 手里接过来)──
       * 缺省进场就是 pinned,这里当场落一次底。**这一次是不可避免的**:树刚挂上,
       * 谁都还不知道它有多高,读 `scrollHeight` 必然逼出一次排版 —— 本单不治它,
       * 治的是「每一次提交都再逼一次」(见下面那段病历)。
       * **空树不落**:此刻 `scrollHeight` 就是视口高,落了等于什么都没做,而
       * 冷载入那条路上消息到齐会让内容列长高 —— 那一发由下面那只观察者接住。
       */
      stick()
      lastGapRef.current = readGap()
    }
    /*
     * 收在**进场那一刻的那个节点**上,不在 cleanup 里重读 `ref.current`。
     * 这不是为了让 lint 闭嘴 —— 它在这里恰好是对的:滚动容器是这片聊天自己的
     * 根,进场时它已经挂上(ref 在 layout effect 之前就绑好了),而它的寿命
     * 与这条 effect 逐字相同(换会话 = 这一格重挂,叶卸载 = 它一起走)。
     * 所以「进场那个」与「离场那个」是同一个节点,反倒是 cleanup 里重读会
     * 读到下一轮那一个(换 ref 时 React 先绑新的再跑旧的 cleanup)。
     */
    return () => {
      // 还没到点的那一发不能跨会话开火 —— 它闭包着**上一条**会话的 id,
      // 而此刻容器里已经是下一条会话的几何了。
      if (anchorTimer.current !== undefined) {
        window.clearTimeout(anchorTimer.current)
        anchorTimer.current = undefined
      }
      // 还没落稳的那一格同理:它闭包着上一条会话的锚点。
      restoreRef.current = undefined
      if (el) saveSessionScrollAnchor(sessionId, measureScrollAnchor(el))
    }
  }, [sessionId, dispatch, scrollRef, stick, readGap])

  /*
   * ── 贴底的产地只有两处(2026-09-10 换轨)──────────────────────────────────
   *
   * **这里从前还有第三处**:一只**没有依赖数组**的 layout effect,判词写着
   * 「每一次提交:pinned 就贴底 —— 『内容变了』在 React 这一侧的全部表现就是
   * 『又提交了一次』」。那句话作为**判据**没错,作为**做法**是这块壳最贵的一笔:
   * `stick()` 要读 `scrollHeight`,而 layout 相位刚改完 DOM,那一读就是一次
   * **整棵树的强制排版**。真机 CPU profile(388 条消息 / 37,470 节点 / 269,803px,
   * 隔离 store 两条真会话):
   *   · 切回一条已在池里的会话,click 同步 JS **1027ms**,其中 `stick()` 自调
   *     **834ms**,调用链 `commitLayoutEffects → ChatStream.tsx:392 → stick`;
   *   · 开一个文件把聊天栏挤窄:76ms,其中 64ms 是同一只 `stick`;
   *   · 流式期间**每一段 delta 一次提交 = 一次 stick = 一次全树排版**
   *     (09-03「切会话卡死」同族的病)。
   *
   * 换轨之后「跟底」照旧,只是判据从「React 又提交了一次」换成**几何自己变了**:
   *   ① **进场** —— 上面那只 layout effect,pinned 时落一次底(树刚挂上,这一次
   *      排版躲不掉);
   *   ② **长高 / 变矮** —— 下面这只 ResizeObserver。
   * 流式跟底走的是 ②:一段 delta 让内容列长高 → RO → pinned 就贴底。**它不经过
   * React**,所以「提交了几次」与「贴了几次底」从此是两个数 —— 这正是本单要的。
   */

  /*
   * 纪律 ② 的落点:内容自己长高(异步高亮 / 图 / 流式 delta 的重排)不一定经过
   * React 的提交,所以盯 DOM。**只认长高**:收起一段思考、删一条消息都会让高度变小,
   * 那不是「下面长出了没看见的东西」,不该点亮丸。
   *
   * ── 盯两只,各回答一个问题(2026-09-10)──────────────────────────────────
   * 「在底」这句话是 `scrollHeight − clientHeight − scrollTop ≤ EPS`,右边有**两个**
   * 会变的量,所以只盯内容列会漏掉一半:
   *   · **内容列**(`.column`)长高 → `scrollHeight` 变大 → 要跟。
   *   · **滚动容器**(`.scroll`)变矮 → `clientHeight` 变小,`scrollTop` 一动不动,
   *     于是**当场离底**,而且**不会发滚动事件**,谁都不知道。真机上它天天发生:
   *     输入框多打一行就长高一截(`--composer-h`),拼舞台 / 开查看器会把聊天栏
   *     挤矮。从前是那只「每次提交都贴底」的 effect 顺手盖住了它(容器变矮几乎
   *     总伴随一次 React 提交),它一走这一格就露出来 —— 所以补的不是一条新机制,
   *     是把它原本靠别人代劳的那一半接过来。
   * 不用 `window` 的 `resize` 事件:它只说得出「窗子变了」,而上面那三个产地
   * (输入框长高 / 拼舞台 / 开查看器)一个都不改窗子的尺寸。同一只观察者盯两个
   * 目标,浏览器把这一批变化攒成一次回调,代价与从前一只时相同。
   *
   * **容器变矮不派 `grew`**:什么都没长出来,只是能看见的少了。派了的话人在上面
   * 浏览时打一行字就会点亮丸,而下面并没有他没看过的东西。
   */
  const lastHeightRef = useRef(0)
  useLayoutEffect(() => {
    const el = scrollRef?.current
    if (!el || typeof ResizeObserver !== 'function') return
    // 盯**内容那一层**:容器自己的高度是外壳给的,不随内容变。
    const column = el.firstElementChild
    if (!column) return
    lastHeightRef.current = column.getBoundingClientRect().height
    lastGapRef.current = el.scrollHeight - el.clientHeight - el.scrollTop
    const observer = new ResizeObserver((entries) => {
      /*
       * ── 停靠中这一批不是读数(2026-09-10 组件级停靠)────────────────────────
       * 一格会话被切走时它那一层挂上 `content-visibility: hidden`,子树里的盒子
       * 当场消失 —— 观察者因此会收到一批「高度 0」的变化。那不是「内容变矮了」,
       * 是**这棵树此刻没有排版**;照常往下走的话:`lastHeightRef` 被 0 冲掉
       * (切回来第一次真高就成了「长高」)、`stick()` 把位置抹平、丸乱亮。
       * 一句判据管住整批 —— 与上面 `stick` 用的是同一把尺子。
       * RO 回调跑在排版之后,读 `clientHeight` 不会逼出第二次排版。
       */
      if (el.clientHeight === 0) return
      /*
       * ── 刚被拿回来那一批(2026-09-10 组件级停靠)────────────────────────────
       * 这一批尺寸变化说的是「这棵树重新有排版了」,不是「下面长出了东西」。
       * 兜底对位落在这儿而不是那只 layout effect 里,理由(与那 44ms 的读数)
       * 整段写在 `useParkedScroll` 上:RO 回调跑在排版之后,这里读几何是白拿的。
       * 真机上浏览器已经把位置留住了,所以这两句今天恒是一次恒等。
       */
      const wantTop = unparkTopRef.current
      if (wantTop !== undefined) {
        unparkTopRef.current = undefined
        const browsing = !followShouldStick(followRef.current)
        if (browsing && Math.abs(el.scrollTop - wantTop) > AT_BOTTOM_EPS) el.scrollTop = wantTop
        lastGapRef.current = el.scrollHeight - el.clientHeight - el.scrollTop
        // 跟底档照旧往下走(停靠期间长出来的那几段要跟);浏览档到此为止。
        if (browsing) return
      }
      /*
       * ── 座位:量在这儿,写在下一帧(正本 §3)────────────────────────────────
       * 排在最前面是因为**它与判不判跟底是同一帧的两句话**:回复长了一截 → 座位
       * 缩同样多 → `scrollHeight` 不变 → 视口本来就不必动。量在这里是白拿的
       * (RO 回调跑在排版之后);真正写 style 排在下一帧,那是观察器的纪律。
       *
       * 于是有**一帧的差**:内容先长了 Δ,座位下一帧才缩 Δ。那一帧里若照旧贴底,
       * 屏幕会先往下跳 Δ、下一帧又被缩回来的 `scrollHeight` 钳回去 —— 一次肉眼可见
       * 的抖,而且滚动写点从一次变成每段一次。所以下面那句「座位还没长满就不贴底」
       * 不是保险,是这条链成立的前提。
       */
      const seat = readSeat(el)
      let contentGrew = false
      let containerChanged = false
      for (const entry of entries) {
        if (entry.target === el) {
          containerChanged = true
          continue
        }
        const height = entry.contentRect.height || column.getBoundingClientRect().height
        if (height > lastHeightRef.current) contentGrew = true
        lastHeightRef.current = height
      }
      /*
       * ── 落位还没稳:这一批变化说的是「跳渲的行渲出真高了」──────────────────
       * 所以照 `applyScrollAnchor` 再对一次,而不是问「要不要跟底」「要不要点亮丸」
       * —— 那两个问题此刻问的都是一张还没定下来的排版。有界(`left`),而且
       * **位置不再动就当场收手**:再对一次没有把 `scrollTop` 挪动超过一个
       * `AT_BOTTOM_EPS`,说明这张排版已经稳了。
       */
      const restoring = restoreRef.current
      if (restoring) {
        restoring.left -= 1
        const before = el.scrollTop
        const landed =
          !applyScrollAnchor(el, restoring.anchor) ||
          Math.abs(el.scrollTop - before) <= AT_BOTTOM_EPS ||
          restoring.left <= 0
        if (landed) {
          restoreRef.current = undefined
          saveSessionScrollAnchor(sessionId, measureScrollAnchor(el))
        }
        lastGapRef.current = el.scrollHeight - el.clientHeight - el.scrollTop
        return
      }
      if (!contentGrew && !containerChanged) return
      /*
       * ── 长出来的那一截在视口下面吗(2026-09-10,`content-visibility` 的第二个
       *    后果)────────────────────────────────────────────────────────────
       * 消息行跳渲之后,**往上翻**这个动作本身就会让内容列的高度变来变去:
       * 一条没进过视口的消息第一次渲出来,高度从 `--msg-intrinsic-h` 那个估高
       * 换成真高。照旧无条件派 `grew` 的话,人在一条**早就收了场**的会话里往上
       * 翻两屏,丸就会跳出来说「回到最新」—— 下面根本没有他没看过的东西。
       *
       * 判据因此收窄一格:**gap 变大了才算**。长在视口上面的内容会被浏览器的
       * 滚动锚定顶回去(`scrollTop` 跟着加,gap 不变),长在下面的才让 gap 变大。
       * 这一格只管**丸**;贴底那一半一个字没动(pinned 时任何长高都跟)。
       * 顺带把从前那条「异步高亮把上面某段撑高 → 丸亮起来」也治了,那本来也是
       * 同一种谎。
       */
      const gap = el.scrollHeight - el.clientHeight - el.scrollTop
      const grewBelow = gap - lastGapRef.current > AT_BOTTOM_EPS
      /*
       * ── 人自己点开的东西还在长:位置一动不动(2026-09-12 报障二的「位」)──────
       * 展开一段折痕正文 / 一段思考 / 一张工具卡,在几何上与「模型又吐了一段」逐字
       * 相同(都让 gap 变大、`scrollTop` 不动),所以分不出来的那一半由动手的那一方
       * 自述(`content/expand-intent.ts`)。pinned 下不报的话,展开的那一瞬间屏幕
       * 当场滑到最底 —— 人点开是为了读它,结果它被推出了视野。
       *
       * **一动不动之后按此刻离底多远重新判档**:这一句与「滚动停下来了」逐字相同
       * (`gap > EPS` 就翻成 browsing),不另开一个事件 —— 事件多一个,`follow.ts`
       * 那张转移表就要多一行,而这一下与人自己往上翻在语义上没有区别:他此刻确实
       * 不在底,而且是他自己要求的。
       *
       * **窗口内的长高也不算「下面长出了没看见的东西」**:第一拍把状态翻成 browsing
       * 之后,展开的过渡还要再长几帧 —— 那几帧要是走下面 browsing 那一支的 `grew`,
       * 丸会亮起来说「回到最新」,而下面长出来的正是他自己点开的那一段。所以整个
       * 窗口内一律不派 `grew`;代价是窗口内(220ms)恰好到达的流式 delta 晚几帧才
       * 点亮丸 —— 下一拍长高照旧会点。
       */
      if (performance.now() < holdUntilRef.current) {
        if (followShouldStick(followRef.current)) dispatch({ type: 'scrolled', gap })
        lastGapRef.current = gap
        return
      }
      if (followShouldStick(followRef.current)) {
        /*
         * ── 座位还没长满:视口一像素不动(正本 §2 规矩 ②)──────────────────
         * 内容长进的是**座位里**,不是页面下面 —— 座位缩掉同样多,`scrollHeight`
         * 一格不变,「贴底」这件事此刻恰好什么都不必做。上面那段判词说的一帧差
         * 就靠这一句兜住。
         *
         * ── 第二格判据:**已经写进 style 的那个高还没归零就不贴** ──────────────
         * 座位是「量在这一帧、写在下一帧」的(观察器只读不写)。所以**归零那一帧**
         * 有一个缝:`readSeat` 已经算出 0,而垫块上挂着的还是上一次写进去的残高,
         * `scrollHeight` 里仍含着那一截。此刻照旧 `stick()`,视口会**多滚那一截**;
         * 下一帧垫块缩到 0、`scrollHeight` 变小,浏览器把 `scrollTop` 钳回来 ——
         * 先下后上,一帧可见的抖,量级正是最后一次长高的 Δ(一行到一个块那么多)。
         *
         * 所以两格都要归零才贴。**这不会把跟底卡死**:写到 0 那一帧垫块自己缩了高,
         * 那是一次尺寸变化,RO 会再来一次 —— 那一次 `seat` 与 `seatWrittenRef`
         * 都是 0,照旧 `stick()`。座位不存在时 `seatWrittenRef` 是 `undefined`,
         * `?? 0` 让它读作「没有残高」,所以没有座位的会话一格行为都没变。
         */
        if (seat > 0 || (seatWrittenRef.current ?? 0) > 0) {
          lastGapRef.current = gap
          return
        }
        stick()
        lastGapRef.current = el.scrollHeight - el.clientHeight - el.scrollTop
        return
      }
      lastGapRef.current = gap
      if (contentGrew && grewBelow) dispatch({ type: 'grew' })
    })
    observer.observe(column)
    observer.observe(el)
    return () => observer.disconnect()
  }, [scrollRef, sessionId, dispatch, stick, readSeat])

  /*
   * 「发送了一条」那一拍。号从 `chat-source` 来(产地在 `send()`),这里只比对它变没变。
   * 首帧那一次不算:挂载时读到的号是这个进程此前发过的总数,不是刚刚发生的一次。
   *
   * **排在长高那只 effect 之后**是有意的,但正确性不靠它:`sent` 与 `grew` 谁先到
   * 都得出同一个答案,因为纯函数里那条「`grew` 不覆盖 `sent`」的规则本身就是次序无关的
   * (理由写在 follow.ts 的 `grew` 分支)。
   */
  /**
   * **滑到置顶线**(正本 §2 规矩 ①)—— 这个文件的**第四处**写 `scrollTop`。
   *
   * 另外三处各答一个问题:`stick` 贴底、`applyScrollAnchor` 落回进场锚点、扩窗补位。
   * 这一处答的是**「刚发出去的那句话停在多高」**:自己那条的上缘落在视口上缘下
   * `--send-line`,底下整个视口(= 座位)留给回复。四处谁都不兼职。
   *
   * ── 为什么是 JS 插值,不是 `scrollTo({behavior:'smooth'})` ────────────────
   * 与那三处同一条:**定位不是动效**。`behavior: 'smooth'` 在动效档「无」下照样
   * 平滑(它听的是系统的 `prefers-reduced-motion`,不是壳自己那格档位),而这一下
   * 在那一档必须一步到位;它也交不出「此刻滑到哪了」这个读数,而下面那句
   * `lastTopRef` 的同步必须逐帧做。
   *
   * ── 滑动期间不许被读成「人往上翻」────────────────────────────────────────
   * `onScrollWithFollow` 判的是 `scrollTop` 比上一次小没小(2026-09-12 那条判例)。
   * 我们自己每帧写的那个数要**当场**记进 `lastTopRef` —— 与 `stick` 里那一句
   * 逐字同源(滚动事件比写点晚一帧,不在这里写就会拿滑动之前的位置当参照)。
   *
   * ── 人在滑动中间自己滚了 ──────────────────────────────────────────────────
   * 当场收手:下一帧读到的 `scrollTop` 不是我们上一帧写下去的那个数,就说明这台
   * 机器上有第二只手。判据仍然只有位置,没有标志位。
   */
  const landFrameRef = useRef(0)
  const landWroteRef = useRef<number | undefined>(undefined)
  const cancelLanding = useCallback(() => {
    if (landFrameRef.current && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(landFrameRef.current)
    }
    landFrameRef.current = 0
    landWroteRef.current = undefined
  }, [])

  const landOnSendLine = useCallback(() => {
    // 这一轮先当作「没落过」——下面每一条早退都让座位留在 0 上(判词在 `seatLandedRef`)。
    seatLandedRef.current = false
    const el = scrollRef?.current
    // 停靠中 / jsdom:没有排版,量出来的一切都是 0(与 `stick` 同一把尺子)。
    if (!el || el.clientHeight === 0) return
    /*
     * **人在上面翻着的时候发送:一像素不动**(规矩 ⑦「人往上翻就是浏览」)。
     * 座位也不留 —— 座位是「把视口让给这一轮」的意思,而此刻视口不归这一轮。
     * 这也正是 `gate:chat-follow` ⑥ 量的那一条:上翻时发送不滚。
     */
    if (!followShouldStick(followRef.current)) return
    seatLandedRef.current = true
    cancelLanding()
    // 先把座位写到位(同步,绘制之前):没有它,下面那个目标就是一个滚不到的位置。
    readSeat(el)
    writeSeat()
    const target = sendLineTarget(el)
    if (target === undefined) return
    const from = el.scrollTop
    const distance = Math.abs(target - from)
    const ms = currentMotionTier() === 'none' ? 0 : sendLandMs(distance)
    const settle = () => {
      lastGapRef.current = el.scrollHeight - el.clientHeight - el.scrollTop
    }
    if (ms === 0 || distance < 1) {
      el.scrollTop = target
      lastTopRef.current = el.scrollTop
      settle()
      return
    }
    const started = performance.now()
    const step = () => {
      landFrameRef.current = 0
      // 第二只手:我们上一帧写下去的那个数不在了,就是人自己滚了 —— 收手。
      if (landWroteRef.current !== undefined && Math.abs(el.scrollTop - landWroteRef.current) > 1) {
        landWroteRef.current = undefined
        return
      }
      const k = Math.min(1, (performance.now() - started) / ms)
      // 缓出(三次):起步快、落点轻,与 `--ease-out` 的形同族。
      const eased = 1 - (1 - k) ** 3
      el.scrollTop = from + (target - from) * eased
      lastTopRef.current = el.scrollTop
      landWroteRef.current = el.scrollTop
      if (k < 1) landFrameRef.current = requestAnimationFrame(step)
      else {
        landWroteRef.current = undefined
        settle()
      }
    }
    if (typeof requestAnimationFrame !== 'function') {
      el.scrollTop = target
      lastTopRef.current = el.scrollTop
      settle()
      return
    }
    landFrameRef.current = requestAnimationFrame(step)
  }, [scrollRef, cancelLanding, readSeat, writeSeat])

  /*
   * 「发送了一条」那一拍。号从 `chat-source` 来(产地在 `send()`),这里只比对它变没变。
   * 基准是 `sentBaseRef`(**按会话**记,见它自己那段判词)—— 所以首帧那一次与换会话
   * 那一次都不算:前者读到的是这个进程此前发过的总数,后者读到的是另一条会话的账。
   *
   * **排在长高那只 effect 之后**是有意的,但正确性不靠它:`sent` 与 `grew` 谁先到
   * 都得出同一个答案,因为纯函数里那条「`grew` 不覆盖 `sent`」的规则本身就是次序无关的
   * (理由写在 follow.ts 的 `grew` 分支)。
   *
   * **`useLayoutEffect` 而不是 `useEffect`**(09-15):座位要在这一帧**绘制之前**
   * 就位,不然人会先看见一屏没有座位的旧排版、下一帧才补上 —— 与「首帧就在底,
   * 不许先画顶部再跳」是同一条纪律。
   */
  const seenTick = useRef(sentTick)
  useLayoutEffect(() => {
    if (!seatActive) {
      // 换会话 / 还没发过话:把基准对齐,不派 `sent`、不滑屏。
      seenTick.current = sentTick
      return
    }
    if (sentTick === seenTick.current) return
    seenTick.current = sentTick
    dispatch({ type: 'sent' })
    landOnSendLine()
  }, [sentTick, seatActive, dispatch, landOnSendLine])

  /** 滑动那一帧属于已经不在的那棵树 —— 卸载 / 换会话时撤掉。 */
  useEffect(() => cancelLanding, [cancelLanding, sessionId])

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
   *
   * ── 「在不在底」不够,还要问「是谁离的底」(2026-09-12,真机探针抓到)────────
   * 上面那句话里藏着一个前提:**我们自己落底那几下正正好在底**。内容**一帧一帧
   * 地长**的时候它不成立 —— 浏览器一帧里先跑滚动事件、后跑 ResizeObserver,于是:
   *   RO(第 n 帧)贴底 → scrollTop = 那一刻的 scrollHeight − clientHeight
   *   → 滚动事件排到**第 n+1 帧**才派,而那一帧内容又长了几像素
   *   → 这只回调量到 gap = 4.5px > `AT_BOTTOM_EPS`(2)→ 判成「人往上翻了」。
   * 真机读数(`gate:chat-follow` ④ 上的探针,2026-09-12):
   *   `ro t=1175 gap=6 pinned → stick`、`scroll t=1183 st=10805.5 gap=4.5 → browsing`,
   * 此后每一条新消息都不再跟底(离底 38 → 263 → 431 → … 逐条累加)。
   * 病灶不是那条 2px 容差调小了,而是**一段跨帧的高度过渡每帧长 2–6px**,
   * 任何容差都挡不住;它是「上下文更新折痕出场软着陆」(`.rowLate`)一落地就撞上的
   * 那堵墙,也是从前任何「内容自己连续长高」都会踩、只是没人量过的那一格。
   *
   * 修法仍然**只用位置,不设标志位**(follow.ts 文件头那条纪律一个字没松):
   * **人往上翻 = `scrollTop` 变小**。gap 张开而 `scrollTop` 一点没往回走,那是
   * 下面长出来的,不是人走开了 —— 同一帧稍后的那次 RO 会把它贴回去。所以这一格
   * 只在「真的往回走了」或者「已经在浏览」时才把这次滚动交给状态机。
   * 它判的仍然是两个**位置**之差,不是「这一下是不是我发的」:后者要为每一种
   * 滚动来源各记一次,而这一句对所有来源同时成立。
   */
  const onScrollWithFollow = useCallback(() => {
    const el = scrollRef?.current
    if (el) {
      const gap = el.scrollHeight - el.clientHeight - el.scrollTop
      // gap 会变的三条路之一(另两条是进场落定与 RO)—— 基准跟着走,
      // 否则「往上翻两屏」会被下一次 RO 读成一次「下面长出了东西」。
      lastGapRef.current = gap
      /*
       * **人此刻停在第几像素**(2026-09-10 组件级停靠)。取回那一拍要用它把位置
       * 摆回去,而那一拍读不到它 —— 停靠期间容器没有排版,`scrollTop` 报 0。
       * 记在滚动这一头是白拿的:这只回调本来就在读同一批几何。
       * (与锚点表分工:锚点按**消息**记、跨挂载留着,给冷载入与被逐出那条路用;
       *  这一格按**像素**记、只活在这次挂载里,给「同一棵树藏起来再拿出来」用。)
       *
       * 2026-09-12 起它多了第二个读者:上面那条「是谁离的底」——**先读旧值再写新值**,
       * 两个读者要的是同一件事实(这只回调上一次看见人在第几像素),不必各记一份。
       */
      const previousTop = lastTopRef.current
      lastTopRef.current = el.scrollTop
      /*
       * 第一次(这次挂载里还没量过)按老办法交给状态机 —— 没有「上一次」可比,
       * 保守的缺省是照旧判,而不是替它猜。
       */
      const wentUp = previousTop === undefined || el.scrollTop < previousTop
      if (wentUp || !followShouldStick(followRef.current)) dispatch({ type: 'scrolled', gap })
    }
    // 停稳之后记一笔「看到哪儿」——这里只重排计时器,量在停下来那一下(见上)。
    scheduleAnchorSave()
    onScroll?.()
  }, [scrollRef, onScroll, dispatch, scheduleAnchorSave])

  /*
   * **拿回来那一拍**(2026-09-10 组件级停靠)。判词整段在 `useParkedScroll` 上;
   * 它要的那两格镜像是这只 hook 的内脏,所以调用点在这里,不在组件层。
   */
  useParkedScroll(visible, lastTopRef, unparkTopRef)

  return { follow, jumpToBottom, onScrollWithFollow, noteUserExpand, seatActive }
}

/**
 * **「这一拍被拿回来了」这件事本身**(2026-09-10 组件级停靠)。
 *
 * 它**一格几何都不读**,只在取回那一拍立一格待办;真正的对位由下面那只
 * ResizeObserver 顺手做掉 —— 判词见「为什么不在这里动手」。
 *
 * ── 判据用的是「宿主说我看不见」,不是几何 ──────────────────────────────
 * 与那三处守卫(`stick` / RO / 锚点去抖)分工:守卫问的是「此刻能不能量」,
 * 几何自己答得出;这里问的是「哪一拍**从**看不见变成看得见」,而那是一次
 * **变化**,几何答不出(停靠期间它恒为 0,取回之后恒不为 0,没有边沿)。
 * `usePanelVisibility` 正是宿主为这句话立的口子(`PaneLeaf` 每一层都在报它)。
 *
 * ── 为什么不在这里动手(2026-09-10 真机读数,官方夹具 50.9MB / 400 条)──────
 * 第一版在这只 layout effect 里当场读 `scrollTop` / `scrollHeight` 再对位。
 * 那一读**排在点击那一个同步任务里**,而此刻那棵树刚从 `content-visibility:
 * hidden` 里放出来 —— 一读就是一次 400 行 / 115,207px 的强制排版:
 * `gate:chat-layout --prod` 的 A#2(第一次切回一棵停靠着的大树)
 * **clickSync 68ms、首帧 77ms**;把这一读拆掉,同一档是 **24ms / 27ms**,
 * 而 ⑨(切回来停在离开时那一行)**两档都是 0px 漂移**。
 *
 * 后半句正是这一批要真机回答的那个问题:**`content-visibility: hidden` 在
 * Chromium 上确实把内层滚动容器的 `scrollTop` 留住了**(拆掉对位之后 ⑨ 仍旧
 * 逐字落回原行原位)。所以对位在今天是一次恒等 —— 但它不是规范承诺,
 * 所以这一格**留着当兜底**,只是搬到了不要钱的地方:RO 的回调**跑在排版之后**,
 * 那里读几何不逼第二次排版。
 *
 * 跟底档不必立待办:内容在停靠期间长高了多少,RO 那一头本来就要跟(它拿的是
 * 停靠前那一格 `lastHeightRef`,取回那一批变化于是如实读成一次长高)。
 */
function useParkedScroll(
  visible: boolean,
  lastTopRef: RefObject<number | undefined>,
  unparkTopRef: RefObject<number | undefined>,
): void {
  /** 上一拍是不是看得见。首挂那一次不算「取回」—— 进场那只 effect 管着它。 */
  const wasVisible = useRef(visible)
  useLayoutEffect(() => {
    const came = visible && !wasVisible.current
    wasVisible.current = visible
    if (came) unparkTopRef.current = lastTopRef.current
  }, [visible, lastTopRef, unparkTopRef])
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
  /**
   * 这一轮上一次**有东西到达**的时刻;只有活消息拿得到(其余恒 undefined)。
   *
   * 2026-09-09 从 `lastDeltaAt` 换成这一格:读数行问的是「还活着吗」,而工具跑着
   * 的那几秒里没有一条裸 delta。跟随状态机要的那一格不经这条 prop —— 它在
   * `ChatStream` 顶层直接读 store 喂给 `useFollowBottom`,所以这里不留一格死 prop。
   */
  lastActivityAt?: number
  /**
   * **这一行要不要自己画那道等待折痕**(09-15,正本 §2 规矩 ③)。
   *
   * 「在等第一个字」是这条消息自己的事(判据 `segments.length === 0` 就在这一层),
   * 但「这一轮有没有上下文更新行」不是 —— 那一行由 `ChatStream` 摆在上一条用户消息
   * 后面,所以由它说了算。有的话这一格是 `false`:一轮只扫一道折痕。
   * 活消息之外的每一行恒 `false`,`memo` 的浅比照旧短路。
   */
  waitingSeam?: boolean
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
  lastActivityAt,
  waitingSeam = false,
}: RowProps) {
  const role = message.role
  const className = [s.row, flash && s.flash].filter(Boolean).join(' ')

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
            * ── 第一个字之前那段空档(§5.3 拍点 ⑫;09-15 换成一道折痕)──────────
            * 回复的槽位已经开出来(`run/start` 到了、活消息立着),但**此刻一个字
            * 都画不出来**:模型在思考、请求还在路上。
            *
            * 判据一个字没改,仍是 `segments.length === 0` —— 装配管线对这条消息
            * **此刻画得出什么**的完整答案。它不是拿 `content` 猜:一条只有工具活儿、
            * 正文还是空的消息段序列非空,那时候槽位里有东西可看,不该再画。
            * 第一个 delta 到达 → 段序列非空 → 折痕当场换成正文与尾部那枚光标,
            * **同一次提交**(两边由同一份 `segments` 推出来,中间没有一帧两样都不在)。
            *
            * 换的是**形**:三颗点(`ui/Dots` + 退役的 `.firstToken`)变成一道在扫的
            * 折痕(正本 §2 规矩 ③)—— 它与上下文更新那一行说的是同一件事,所以两者
            * 合成一行,由 `waitingSeam` 那一格决定这一轮归谁扫。丸上那三个点不动。
            */}
          {streaming && segments.length === 0 && waitingSeam && (
            <WaitingSeam label={t('chat.streaming')} />
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
          {streaming && (
            <StreamReadout
              sessionId={sessionId}
              startedAt={message.timestamp}
              lastActivityAt={lastActivityAt}
            />
          )}
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
            <StopNotice stop={message.stop} hasVisibleText={hasVisibleProse(segments)} />
          )}
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
  attachments: number
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
      <div
        className={[s.user, !landed && s.pending, failed && s.pendingFailed]
          .filter(Boolean)
          .join(' ')}
        /* 门与用例按它找在飞那一格;落账之后它**不在了** —— 那正是「认领成了」。 */
        data-testid={landed ? undefined : `chat-pending-${failed ? 'failed' : 'sending'}`}
      >
        {/* 三个来源一条判据链:现成的段 ▷ 部件 ▷ 正文(判词在 user-message 文件头)。 */}
        <UserMessageBody text={text} parts={parts} segments={segments} />
        {attachments > 0 && (
          <span className={s.sentAtt}>
            <ClipIcon className={s.sentAttIcon} strokeWidth={1.8} aria-hidden="true" />
            {attachments}
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
function contextSeamRow(message: ProjectedMessage, sweeping: boolean) {
  return (
    <article
      key={`${message.id}#context`}
      className={`${s.row} ${s.rowLate}`}
      data-context-of={message.id}
    >
      {/* `sweeping` = 这一轮还在等第一个字:等待折痕与这一行**合成一行**,由它扫
          (判词在 `ContextDeltaSeam` 那格 prop 上)。首字一到它翻回 false:光停、
          线实,标签常驻 —— 它说的那件事已经发生完了。 */}
      <ContextDeltaSeam turnContext={message.turnContext} sweeping={sweeping} />
    </article>
  )
}
