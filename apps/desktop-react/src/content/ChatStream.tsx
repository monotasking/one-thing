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
import { chatSources, useChatSourceOf } from '../data/chat-source'
import {
  applyScrollAnchor,
  measureScrollAnchor,
  readSessionScrollAnchor,
  saveSessionScrollAnchor,
  type ScrollAnchor,
} from '../data/session-view-state'
import { CHAT_WINDOW_STEP, growChatWindow, useChatWindowStart } from './chat-window'
import { sessionRefIdOf } from './session-ref'
import type { OverlayEntry, ProjectedMessage } from '../data/chat-fold'
import { useT, type TFn } from '../i18n'
import { resolveIcon } from '../components/icons'
import { SCROLL_ANCHOR_SETTLE_MS } from '../components/motion'
import { ButtonBase } from '../ui/ButtonBase'
import { assembleMessage, segmentKey } from './assemble'
import { ContextDeltaSeam, hasContextDelta } from './ContextDeltaSeam'
import type { SegmentModel } from './model/segments'
import { MessageActions } from './message/MessageActions'
import { StopNotice } from './message/StopNotice'
import { StreamReadout } from './message/StreamReadout'
import { MessageSourceFoot } from './research/SourceFoot'
import { SegmentView } from './SegmentView'
import { FocusScope } from '../focus/FocusScope'
import { usePanelVisibility } from './visibility'
import { Dots } from '../ui/Dots'
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
  const expandOnScroll = useTailWindow(scrollRef, sessionId, messages.length, windowStart)

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

  const { follow, jumpToBottom, onScrollWithFollow } = useFollowBottom(
    scrollRef,
    foldedSessionId,
    messages,
    sentTick,
    lastDeltaAt,
    activeMessageId,
    onScrollOutward,
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

            {/*
              * **摆的是窗口里那几条,不是整份**(2026-09-10)。窗口是消息数组的一个
              * 后缀,起点只减不增(判词在 `chat-window.ts`),所以这里一格特判都没有:
              * 全量到齐时 `visible === messages`,与从前逐字相同。
              */}
            {visible.flatMap((message) => {
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
              if (message.role !== 'user' || !hasContextDelta(message.turnContext)) return [row]
              return [
                row,
                <article key={`${message.id}#context`} className={s.row} data-context-of={message.id}>
                  <ContextDeltaSeam turnContext={message.turnContext} />
                </article>,
              ]
            })}

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
  }, [windowStart, scrollRef])

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

  /* ② 翻到窗口顶部附近:当场补一批,不等空闲。 */
  return useCallback(() => {
    const el = scrollRef?.current
    if (!el) return
    if (el.scrollTop > el.clientHeight * CHAT_NEAR_TOP_SCREENS) return
    const start = windowStartRef.current
    if (start <= 0) return
    grow(start - CHAT_WINDOW_STEP)
  }, [scrollRef, grow])
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
   * **停靠之前人停在第几像素**(2026-09-10 组件级停靠)。写点只有一处:滚动
   * 回调(判词在那儿)。读点只有一处:取回那一拍(`useParkedScroll`)。
   * `undefined` = 这次挂载里人一次都没滚过 —— 那时缺省的 pinned 会去贴底,
   * 不需要它。
   */
  const lastTopRef = useRef<number | undefined>(undefined)
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
      if (followShouldStick(followRef.current)) {
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
       */
      lastTopRef.current = el.scrollTop
      dispatch({ type: 'scrolled', gap })
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

  return { follow, jumpToBottom, onScrollWithFollow }
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
      {role === 'user' && <div className={s.user}>{message.content}</div>}

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
          {streaming && <StreamReadout startedAt={message.timestamp} lastActivityAt={lastActivityAt} />}
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
