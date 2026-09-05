import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { TOC_FLASH_MS } from '../components/motion'
import { useChatSourceOf } from '../data/chat-source'
import { useSessionMarkers } from '../data/sessions-source'
import { useLocateMessage } from '../content/locate-message'
import { useT } from '../i18n'
import { notify } from '../services/notify'
import { currentTurnIndex } from './transitions'

/**
 * TOC 与聊天区之间**唯一**的 DOM 接缝:量坐标、滚过去、点亮落点。
 *
 * 分工是刻意的 —— 测量归这里,判定归 transitions.currentTurnIndex(纯函数、可测);
 * 状态机(toc/store)则完全不知道有 DOM 这回事,它只管展不展开。
 *
 * ── D3:两边说的是同一个 id ────────────────────────────────────────────
 * 锚点靠 `data-message-id` 找,而键来自 `sessions.getUserMarkers`(用户消息 id)——
 * **同一份事实的同一个字段**。D1 时键的下标(真锚点列)与页面上的锚点
 * (mock 的 `data-turn-index`)并不同源,点得到的滚过去、点不到的什么也不做;
 * 那条尾巴在这一批收掉了。
 *
 * 锚点在页面上**可能缺席**(账本里的那条消息还没折出来、或已被删)。缺席的那几枚
 * 键照旧点不动 —— 但现在这是一个可判定的事实(id 不在树上),不是两套下标的漂移。
 *
 * ── 09-02:同一条接缝上多了第二个入口 ────────────────────────────────────
 * 检索面搜到一条**消息正文**,点它要落到那条消息上。它与钢琴键说的是同一件事
 * (「滚到 `data-message-id=X` 那一条并点亮」),差别只在**怎么拿到那个 id**:
 * 键是锚点列的下标(只有用户消息),检索命中直接给 messageId(助手消息也在内)。
 *
 * 所以这里不新开第二条接缝,而是把「滚过去 + 点亮」抽成 `useScrollToMessage`
 * 让两个入口共用;跨组件的那一格待办住在 `content/locate-message.ts`
 * (点击处与办得成的地方之间隔着换会话与重折两层异步,理由写在那个文件头)。
 */
export interface ChatToc {
  /** 当前键:视口内最近一条用户消息在**锚点列**里的下标 */
  currentIndex: number
  /** 正在高亮淡出的那条消息 id;null = 没有 */
  flashMessageId: string | null
  /** 挂到聊天滚动容器的 onScroll 上 */
  syncFromScroll: () => void
  /** 点行 / 点键的落点动作(入参是锚点列下标,与键一一对应) */
  pickTurn: (index: number) => void
}

/** 页面上此刻在场的锚点:id → 节点。一次查询建表,免得逐个 id 拼选择器转义。 */
function anchorNodes(container: HTMLElement): Map<string, HTMLElement> {
  const map = new Map<string, HTMLElement>()
  for (const node of container.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const id = node.getAttribute('data-message-id')
    if (id) map.set(id, node)
  }
  return map
}

/**
 * 每条**在场**的锚点相对滚动内容顶部的偏移,连同它在锚点列里的下标。
 *
 * 用 getBoundingClientRect 而不是 offsetTop:后者依赖 offsetParent 是谁,
 * 聊天列包一层定位元素就会算错;前者只依赖当前渲染结果。
 */
function measureAnchors(
  container: HTMLElement,
  anchorIds: readonly string[],
): { index: number; top: number }[] {
  const nodes = anchorNodes(container)
  const base = container.getBoundingClientRect().top - container.scrollTop
  const found: { index: number; top: number }[] = []
  anchorIds.forEach((id, index) => {
    const node = nodes.get(id)
    if (node) found.push({ index, top: node.getBoundingClientRect().top - base })
  })
  return found
}

/**
 * 滚过去 + 点亮。**这一手在这只 hook 里只有一个产地** —— `pickTurn`(点键)与
 * 「落到某条消息」(检索面点一条正文命中)是同一件事的两个入口,只是**怎么找到
 * 那条消息**不同:一个按锚点列的下标,一个直接拿 messageId。
 *
 * 09-02 抽出来之前它长在 `pickTurn` 里,于是「落到消息」那一路只能抄一遍 ——
 * 抄的那一份迟早会漏掉「先清再点」那句(同一个类名不换,CSS 动画不会重放)。
 */
function useScrollToMessage(
  scrollRef: RefObject<HTMLDivElement | null>,
  setFlashMessageId: (id: string | null) => void,
  flashTimer: RefObject<ReturnType<typeof setTimeout> | null>,
): (messageId: string) => boolean {
  return useCallback(
    (messageId: string) => {
      const el = scrollRef.current
      const node = el ? anchorNodes(el).get(messageId) : undefined
      // 锚点不在树上 = 这一下办不成。**如实回 false**,不去滚一个最近的位置 ——
      // 滚到别的地方再点亮别人,比什么都不做更像在说谎。
      if (!el || !node) return false
      // jsdom 里没有 scrollTo;守一手,免得测试环境把渲染层拖红。
      if (typeof el.scrollTo === 'function') {
        const top = node.getBoundingClientRect().top - (el.getBoundingClientRect().top - el.scrollTop)
        el.scrollTo({ top, behavior: 'smooth' })
      }
      // 先清再点,连点同一条时 CSS 动画才会重放(同一个类名不换是不会重来的)。
      setFlashMessageId(null)
      if (flashTimer.current) clearTimeout(flashTimer.current)
      const raf =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : (fn: () => void) => setTimeout(fn, 0)
      raf(() => {
        setFlashMessageId(messageId)
        flashTimer.current = setTimeout(() => setFlashMessageId(null), TOC_FLASH_MS)
      })
      return true
    },
    [scrollRef, setFlashMessageId, flashTimer],
  )
}

/**
 * @param sessionId 这一片聊天看的那条会话(W5-a:由摆它的那片叶给,不再自己去
 *   `expose` 里取「当前会话」—— 目录与消息流必须说同一条会话,而「哪一条」是叶的事实)。
 */
export function useChatToc(
  sessionId: string,
  scrollRef: RefObject<HTMLDivElement | null>,
): ChatToc {
  const t = useT()
  const [currentIndex, setCurrentIndex] = useState(0)
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollToMessage = useScrollToMessage(scrollRef, setFlashMessageId, flashTimer)

  // 键与锚点同源:两边都是这条会话的用户消息锚点列(TocPanel 读的是同一份)。
  const markerSource = useSessionMarkers(sessionId).data
  const anchorIds = useMemo(
    () => (markerSource ?? []).map((marker) => marker.id),
    [markerSource],
  )

  /**
   * 真正的那一手量 —— **一次 commit 最多跑一次,并且合并到下一帧**(09-03)。
   *
   * 病历(`probe-hotspots` 的 dev profile):从前它直接挂在一条 passive effect 上
   * (依赖 = `syncFromScroll`,而那只闭包随 `anchorIds` 换身份),换一次会话就在
   * 那次巨型 commit 的收尾处同步跑一遍 —— 链是
   * `flushPassiveEffects → useChatToc → measureAnchors`,`getBoundingClientRect`
   * self **17.8ms**(刚改过 DOM ⇒ 第一发就是一次强制排版)。滚动那条路更密:
   * 滚轮一秒几十上百发,每一发都是一次同步量。
   *
   * 现在只有两个时刻会量:滚动同步、锚点列变了(换会话 / 目录素材到货);两者都
   * 经 `scheduleSync` 合并进**同一帧的一次** rAF。语义一格没动 ——
   * `currentTurnIndex` 那个纯函数一个字未改,判据仍是「量出来的坐标」。
   *
   * **没有锚点就不量**:锚点列空 = 钢琴键那条 rail 整个不在场(TocPanel 的空态),
   * 屏幕上没有任何东西消费这个下标。空表时 `currentTurnIndex` 本来就返回 -1,
   * 所以这里直接给 -1 与从前逐字等价,只是不再白读一遍 DOM。
   */
  const runSync = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    if (anchorIds.length === 0) {
      setCurrentIndex(-1)
      return
    }
    const found = measureAnchors(el, anchorIds)
    // 判定只吃「量出来的坐标」;缺席的锚点先摘掉,再把结果映回锚点列的下标。
    const hit = currentTurnIndex(
      found.map((entry) => entry.top),
      el.scrollTop,
      el.clientHeight,
    )
    setCurrentIndex(hit < 0 ? -1 : (found[hit]?.index ?? -1))
  }, [scrollRef, anchorIds])

  /** 这一帧排下的那一次量(0 = 没排)。ref 而不是 state:它不是可渲染状态。 */
  const scheduled = useRef(0)
  const runSyncRef = useRef(runSync)
  runSyncRef.current = runSync

  const syncFromScroll = useCallback(() => {
    if (scheduled.current) return
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (fn: () => void) => setTimeout(fn, 0) as unknown as number
    scheduled.current = raf(() => {
      scheduled.current = 0
      runSyncRef.current()
    })
  }, [])

  // 卸载时把排着的那一下撤掉 —— 换会话 / 关掉聊天面时,没人再要这个读数了。
  useEffect(
    () => () => {
      if (scheduled.current && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(scheduled.current)
      }
      scheduled.current = 0
    },
    [],
  )

  // 首帧对一次,换会话 / 锚点变了也对一次:当前键该是算出来的,不是等用户滚一下。
  useEffect(() => {
    syncFromScroll()
  }, [syncFromScroll, runSync])

  useEffect(() => () => void (flashTimer.current && clearTimeout(flashTimer.current)), [])

  const pickTurn = useCallback(
    (index: number) => {
      const messageId = anchorIds[index]
      if (!messageId) return
      /*
       * 当前键**照旧跟着走**,即使锚点此刻不在树上(账本里那条消息还没折出来 /
       * 已被删)。键是「用户点了第几个」,与「滚成功了没有」是两件事 ——
       * 这一条与 09-02 抽出 `scrollToMessage` 之前逐字相同。
       */
      setCurrentIndex(index)
      scrollToMessage(messageId)
    },
    [anchorIds, scrollToMessage],
  )

  /*
   * ── 落到某条消息(09-02 正文检索)────────────────────────────────────────
   * 检索面点一条正文命中 = 进那条会话 + 滚到那条消息。两件事之间隔着两层异步
   * (换会话要重开折叠、折出来的消息要渲染成 DOM),所以点击那一下只留一格待办
   * (`content/locate-message.ts`),由这里在锚点真的出现时把它消掉。
   *
   * **判据是「这条会话的折叠落地了没有」**,不是猜一个延迟:
   *  · 当前会话还不是待办那条 → 等(`enterSession` 刚发生,ChatStream 还没 open);
   *  · 折叠没落地(status !== 'ready') → 等;
   *  · 落地了、锚点在 → 滚过去点亮,待办消掉;
   *  · 落地了、锚点不在 → **如实说**:进是进来了,那条消息不在这棵树上
   *    (被删 / 被压缩掉)。走 notify(info 级,进通知中心存档),
   *    而不是静默地把待办丢掉 —— 用户按了一下,总得知道结果。
   *
   * 依赖表里的 `messages` 是**节拍**:它一变就说明树重画过一次,该再找一次锚点。
   */
  const locate = useLocateMessage((st) => st.request)
  const settleLocate = useLocateMessage((st) => st.settleLocate)
  const foldSessionId = useChatSourceOf(sessionId, (st) => st.sessionId)
  const foldStatus = useChatSourceOf(sessionId, (st) => st.status)
  const foldMessages = useChatSourceOf(sessionId, (st) => st.messages)
  useEffect(() => {
    if (!locate) return
    if (sessionId !== locate.sessionId) return
    if (foldSessionId !== locate.sessionId || foldStatus !== 'ready') return
    if (scrollToMessage(locate.messageId)) {
      settleLocate(locate.token)
      return
    }
    settleLocate(locate.token)
    notify({
      level: 'info',
      source: 'search.open',
      title: t('search.messageGone'),
    })
  }, [
    locate,
    sessionId,
    foldSessionId,
    foldStatus,
    foldMessages,
    scrollToMessage,
    settleLocate,
    t,
  ])

  return { currentIndex, flashMessageId, syncFromScroll, pickTurn }
}
