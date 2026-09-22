import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { EXPAND_HOLD_MS, currentMotionTier, sendLandMs } from '../../components/motion'
import { FOLLOW_PINNED, type FollowState } from '../follow'
import type { UserToggle } from '../geometry-report'
import { usePanelVisibility } from '../visibility'
import { ViewportAnchor } from './anchor'
import type { ScrollPort } from './scroll-port'

/**
 * 折叠那一段的**余量**(单 B ④):报出来的时长之外再多钉这么久。
 *
 * 与 `EXPAND_HOLD_MS` 末尾那 40ms 同一条理由、同一个数量级:定时器与合成器不是
 * 同一个时钟,过渡的最后一帧尺寸变化常落在名义终点之后。它是**判据的余量**不是
 * 一段动画,所以不进 tokens、不进 `components/motion.ts` 的镜像表(那张表只收
 * 「JS 侧有一个计时器跟着走」的时长)。
 */
export const FOLD_HOLD_SLACK_MS = 40

/**
 * **把锚定器接到 React 上的那只薄 hook**(G 线 P2-a,正本 §13.2.7)。
 *
 * 它只做四件事:建实例、接 DOM 事件与生命周期、把状态推给渲染、卸载时 dispose。
 * **一句裁决都不在这里** —— 每一支 `if` 都在 `ViewportAnchor` 里,这只 hook 里
 * 剩下的判断全是「React 这一侧的边沿检测」(号变了没有、活消息由有变无没有),
 * 它们本来就属于 React(§13.1.2 那张表里的 `seen*` 四格)。
 */
export function useViewportAnchor(options: {
  scrollRef: RefObject<HTMLDivElement | null> | undefined
  port: ScrollPort
  sessionId: string
  messageCount: number
  sentTick: number
  lastDeltaAt: number | undefined
  activeMessageId: string | undefined
  retryingId: string | undefined
  onScroll: (() => void) | undefined
}): {
  follow: FollowState
  jumpToBottom: () => void
  onScrollWithFollow: () => void
  reportUserToggle: (change: UserToggle) => boolean
  seatActive: boolean
} {
  const { scrollRef, port, sessionId, messageCount, sentTick, lastDeltaAt, activeMessageId, retryingId, onScroll } =
    options

  const [follow, setFollow] = useState<FollowState>(FOLLOW_PINNED)

  const anchorRef = useRef<ViewportAnchor | undefined>(undefined)
  if (!anchorRef.current) {
    anchorRef.current = new ViewportAnchor(port, {
      onFollowChange: setFollow,
      expandHoldMs: EXPAND_HOLD_MS,
      foldSlackMs: FOLD_HOLD_SLACK_MS,
      slideDurationOf: (distance) => (currentMotionTier() === 'none' ? 0 : sendLandMs(distance)),
    })
  }
  const anchor = anchorRef.current

  /*
   * 「此刻树上有没有东西」的镜像。**它只有一个读者**:进场那一下要不要落底
   * (空树时没有底可落)。写在渲染期而不是进依赖表 —— 进了依赖表就等于让
   * 「消息变了」重跑一次进场。
   */
  const messageCountRef = useRef(0)
  messageCountRef.current = messageCount

  /* ── 座位:这条会话此刻有没有 ────────────────────────────────────────────
   *
   * `sentBaseRef` —— **进场那一刻的发送号**。座位是「刚发送的这一轮」的产物,
   * 不落盘:换会话就没有(写在渲染期,与 `messageCountRef` 同一手)。它顺带把一个
   * 旧毛病一起治了:`sentTick` 是**按会话读**的,换会话时那个号自己就变了,
   * 从前那只 effect 会因此派一次根本没发生过的 `sent`(pinned 下 `reduceFollow`
   * 恰好什么都不改,所以没人看见)—— 现在它还会顺手滑一次屏,那就看得见了,
   * 所以基准必须跟着会话走。
   */
  const sentBaseRef = useRef<{ sid: string; tick: number } | undefined>(undefined)
  if (!sentBaseRef.current || sentBaseRef.current.sid !== sessionId) {
    sentBaseRef.current = { sid: sessionId, tick: sentTick }
  }
  const seatActive = sentTick !== sentBaseRef.current.tick
  // 渲染期事实,推给锚定器(不进依赖表,理由同 `messageCountRef`)。
  anchor.seatActive = seatActive

  /* 垫块随会话卸载 / 座位退役时,那格「已写的数」也要归零 —— 不然下一条会话
   * 的第一次写会被一个属于上一棵树的数短路掉。 */
  useEffect(() => {
    if (seatActive) return
    anchor.retireSeat()
  }, [seatActive, sessionId, anchor])

  /*
   * 换会话 = 一次新的进场。写在 layout 阶段,好让同一次提交里下面那些 effect 看到它。
   *
   * 收在**进场那一刻的那个节点**上,不在 cleanup 里重读 `ref.current`:滚动容器是
   * 这片聊天自己的根,进场时它已经挂上,而它的寿命与这条 effect 逐字相同。反倒是
   * cleanup 里重读会读到下一轮那一个(换 ref 时 React 先绑新的再跑旧的 cleanup)。
   */
  useLayoutEffect(() => {
    const el = scrollRef?.current
    anchor.enter(sessionId, { hasElement: !!el, hasMessages: messageCountRef.current > 0 })
    return () => anchor.leave(sessionId, !!el)
  }, [sessionId, scrollRef, anchor])

  /*
   * 纪律 ② 的落点:内容自己长高(异步高亮 / 图 / 流式 delta 的重排)不一定经过
   * React 的提交,所以盯 DOM。
   *
   * ── 盯两只,各回答一个问题 ──────────────────────────────────────────────
   * 「在底」这句话是 `scrollHeight − clientHeight − scrollTop ≤ EPS`,右边有**两个**
   * 会变的量,所以只盯内容列会漏掉一半:
   *   · **内容列**(`.column`)长高 → `scrollHeight` 变大 → 要跟。
   *   · **滚动容器**(`.scroll`)变矮 → `clientHeight` 变小,`scrollTop` 一动不动,
   *     于是**当场离底**,而且**不会发滚动事件**,谁都不知道。真机上它天天发生:
   *     输入框多打一行就长高一截,拼舞台 / 开查看器会把聊天栏挤矮。
   * 不用 `window` 的 `resize` 事件:它只说得出「窗子变了」,而那三个产地一个都不改
   * 窗子的尺寸。同一只观察者盯两个目标,浏览器把这一批变化攒成一次回调。
   *
   * **`seatActive` 进依赖表**是有意的(G 线 P2-a):搬迁之前 `readSeat` 的身份跟着
   * 它变,而它在这条依赖表里 —— 于是**座位一出现 / 一退役,这只观察者就重挂一次**,
   * 连带把 `lastColumnHeight` / `lastGap` 两格基准重新量一遍。抽件之后那几只回调的
   * 身份恒定了,这条触发沿要显式写出来才不丢。
   */
  useLayoutEffect(() => {
    const el = scrollRef?.current
    if (!el || typeof ResizeObserver !== 'function') return
    // 盯**内容那一层**:容器自己的高度是外壳给的,不随内容变。
    const column = el.firstElementChild
    if (!column) return
    anchor.beginObserving()
    const observer = new ResizeObserver((entries) => {
      /*
       * 停靠中这一批不是读数 —— 这一句连同「把这一批归一成纯数字」一起住在
       * `ScrollPort.summarizeResize` 里,它**先答这一句再读任何矩形**。
       */
      const batch = port.summarizeResize(entries)
      if (!batch) return
      anchor.onResize(batch, sessionId)
    })
    observer.observe(column)
    observer.observe(el)
    return () => observer.disconnect()
  }, [scrollRef, port, anchor, sessionId, seatActive])

  /**
   * 「按下重试」那一拍。基准与 `sentTick` 同一手(ref 记上一次,不是每次渲染都派),
   * 首帧那一次不算 —— 挂载时读到的是「此刻有没有一发在飞」,不是刚刚按下。
   *
   * **落在「那一发回来了」那一拍,不是「按下去」那一拍**(2026-09-15 真机实测定的):
   * 按下那一拍旧回答才刚开始上折,此刻算出来的置顶线是**按旧高度算的**;而接下来
   * 那 180ms 里它一路缩到 0,`scrollHeight` 跟着塌,浏览器把 `scrollTop` 一路钳
   * 下来 —— 两个写点同时在写同一格,滑动落点当场作废(真机:气泡停在 471 而不是
   * 置顶线 24)。按下那一拍该有的回音已经有了,而且是**不动滚动条**的两件:折痕
   * 当场开始扫(实测 8ms),旧回答当场开始上折。
   */
  const seenRetryRef = useRef(retryingId)
  useLayoutEffect(() => {
    const was = seenRetryRef.current
    if (retryingId === was) return
    seenRetryRef.current = retryingId
    if (was === undefined || retryingId !== undefined) return
    anchor.landOnRetry()
  }, [retryingId, anchor])

  /*
   * 「发送了一条」那一拍。号从 `chat-source` 来(产地在 `send()`),这里只比对它变没变。
   * 基准是 `sentBaseRef`(**按会话**记)—— 所以首帧那一次与换会话那一次都不算。
   *
   * **排在长高那只 effect 之后**是有意的,但正确性不靠它:`sent` 与 `grew` 谁先到
   * 都得出同一个答案,因为纯函数里那条「`grew` 不覆盖 `sent`」的规则本身就是
   * 次序无关的(理由写在 follow.ts 的 `grew` 分支)。
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
    anchor.dispatch({ type: 'sent' })
    anchor.landOnSendLine()
  }, [sentTick, seatActive, anchor])

  /** 滑动那一帧属于已经不在的那棵树 —— 卸载 / 换会话时撤掉。 */
  useEffect(() => () => anchor.cancelLanding(), [anchor, sessionId])
  /** 排着的那一帧 / 还没到点的那一发同理。 */
  useEffect(() => () => anchor.dispose(), [anchor])

  /*
   * 「回复到了」那一拍。判据是 `lastDeltaAt` 变了**且此刻有一轮在跑** ——
   * 两个条件缺一不可:前者说「这一轮又收到一段」,后者把「收场时 `lastDeltaAt`
   * 归 undefined」那一次变化挡在外面(那是一轮结束,不是一段回复到达)。
   *
   * **不用 `grew` 代劳**的理由写在 follow.ts 的 `reply` 分支里:自己刚发的那条
   * 也是一次长高,几何分不出是谁长的;这一格拿的是数据源的事实,分得出来。
   */
  const seenDeltaAt = useRef(lastDeltaAt)
  useEffect(() => {
    if (lastDeltaAt === seenDeltaAt.current) return
    seenDeltaAt.current = lastDeltaAt
    if (activeMessageId === undefined) return
    anchor.dispatch({ type: 'reply' })
  }, [lastDeltaAt, activeMessageId, anchor])

  /** 开张 / 收场那两拍里,**只管收场**:座位同步补到位(判词在 `syncSeatOnSettle`)。 */
  const seenActiveRef = useRef(activeMessageId)
  useLayoutEffect(() => {
    const ended = seenActiveRef.current !== undefined && activeMessageId === undefined
    seenActiveRef.current = activeMessageId
    if (!ended) return
    anchor.syncSeatOnSettle()
  }, [activeMessageId, anchor])

  /*
   * ── 座位**同帧**跟上内容(G 线 P1)──────────────────────────────────────
   * 没有依赖数组 = 每一次 React 提交都跑。允许同步读几何的理由:layout effect
   * **不是观察器回调** —— 那条法禁的是「布局观察器在派发循环里改布局」,而这里是
   * React 提交之后、绘制之前的正常写点。三道闸让它只在「刚发出去这一轮、座位还
   * 没被吃光」那一段里付钱,而那一段本来就是屏幕上唯一在动的一段。
   */
  useLayoutEffect(() => {
    if (!seatActive || !anchor.pad.landed) return
    if ((anchor.pad.written ?? 0) <= 0) return
    anchor.syncSeatSameFrame()
  })

  const jumpToBottom = useCallback(() => anchor.jumpToBottom(), [anchor])
  /*
   * ── 人亲手开合了一块东西(G 线 P2-b,`content/geometry-report.ts`)─────────
   *
   * **量在这儿,不在裁决层**:那一层零 DOM(`FakeScrollPort` 就能把整张裁决表
   * 逐格测到),而薄 hook 本来就是 React 与 DOM 这一侧。
   *
   * **一次点击只逼一次排版**:三格(收缩上界 / 钉住的位置 / 接下来再问它)全从
   * 同一次 `getBoundingClientRect()` 来。这一读跑在**什么都还没变**的干净排版上,
   * 所以它不会触发那次钳位 —— 会钳的是垫块到位**之前**的收缩,而那是下一拍的事。
   *
   * 身份恒定(依赖只有 `anchor`):它一路传到折痕 / 思考段 / 工具卡上,身份一变
   * 那几层的 memo 就白短路了(与 `noteUserExpand` 同一条判词)。
   */
  const reportUserToggle = useCallback((change: UserToggle) => {
    const el = change.el
    let block
    if (el) {
      const rect = el.getBoundingClientRect()
      block = {
        height: rect.height,
        top: rect.top,
        anchor: { alive: () => el.isConnected, top: () => el.getBoundingClientRect().top },
      }
    }
    anchor.reportUserToggle({ open: change.open, durationMs: change.durationMs, block })
    return change.open
  }, [anchor])
  const onScrollWithFollow = useCallback(() => {
    // 容器不在手时**只重排那一发去抖**,判档那一段跳过 —— 与今天那句
    // `const el = scrollRef?.current; if (el) { … }` 之后照旧调
    // `scheduleAnchorSave()` 逐字同义。
    anchor.onScroll(sessionId, !!scrollRef?.current)
    onScroll?.()
  }, [scrollRef, anchor, sessionId, onScroll])

  /*
   * **拿回来那一拍**(2026-09-10 组件级停靠)。
   *
   * 判据用的是「宿主说我看不见」,不是几何:那三处守卫问的是「此刻能不能量」,
   * 几何自己答得出;这里问的是「哪一拍**从**看不见变成看得见」,而那是一次
   * **变化**,几何答不出(停靠期间它恒为 0,取回之后恒不为 0,没有边沿)。
   */
  const { visible } = usePanelVisibility()
  const wasVisible = useRef(visible)
  useLayoutEffect(() => {
    const came = visible && !wasVisible.current
    wasVisible.current = visible
    if (came) anchor.noteUnpark()
  }, [visible, anchor])

  return {
    follow,
    jumpToBottom,
    onScrollWithFollow,
    reportUserToggle,
    seatActive,
  }
}
