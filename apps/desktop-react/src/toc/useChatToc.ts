import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { TOC_FLASH_MS } from '../components/motion'
import { useChatSourceOf } from '../data/chat-source'
import { useSessionMarkers } from '../data/sessions-source'
import { reachChatWindow, useChatWindowVersion } from '../content/chat-window'
import { geometryPortOf } from '../content/viewport/geometry-port'
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
 *
 * ── 跳渲的行报的是估高(2026-09-10)────────────────────────────────────────
 * 消息行挂上 `content-visibility: auto` 之后,**没进过视口的行**占的是
 * `--msg-intrinsic-h` 那个估高的位,矩形因此不是它将来的真高。这一格**不受影响**,
 * 而且是结构上的:`currentTurnIndex` 问的是「视口里最近的那一条是谁」,而视口里
 * 那几条按定义都渲过了、报的都是真高。屏幕外那些的坐标偏一点,改不了这个答案。
 * (会被它影响的是「按坐标落到某一条」那条路 —— 那一条走
 * `scrollIntoView` / `applyScrollAnchor`,由它们各自负责落完再对一次。)
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
 * 落点这一下的结局。**「够不到」与「没有这条消息」是两回事** —— 前者只是它此刻
 * 还没渲出来(消息按屏进,见 `content/chat-window.ts`),等窗口扩过去就落得下;
 * 后者是这棵树上真的没有它(被删 / 被压缩折进去了),那一句得说给人听。
 */
type LandOutcome =
  /** 落成了 */
  | 'done'
  /** 那条消息在,但此刻还没渲出来 —— 已经为它扩了窗,下一次提交再落 */
  | 'pending'
  /** 这棵树上没有这条消息 */
  | 'absent'

/**
 * 滚过去 + 点亮。**这一手在这只 hook 里只有一个产地** —— `pickTurn`(点键)与
 * 「落到某条消息」(检索面点一条正文命中)是同一件事的两个入口,只是**怎么找到
 * 那条消息**不同:一个按锚点列的下标,一个直接拿 messageId。
 *
 * 09-02 抽出来之前它长在 `pickTurn` 里,于是「落到消息」那一路只能抄一遍 ——
 * 抄的那一份迟早会漏掉「先清再点」那句(同一个类名不换,CSS 动画不会重放)。
 *
 * ── 消息按屏进之后多了一格(2026-09-10)──────────────────────────────────
 * 聊天区只渲染消息数组的一个后缀(尾窗 + 空闲往前补),所以「锚点不在树上」从此
 * 有两个意思。判据搬到**数据**那一侧:`reachChatWindow` 问的是「这份消息里有没有
 * 这条」—— 有就一定渲得出来(窗口是数据的后缀,够过去就有),于是记一格待办,
 * 等窗口扩过去 / 树重画之后再落一次;没有才是 `absent`,与从前那句「如实回 false,
 * 不去滚一个最近的位置」逐字同一条纪律。
 */
function useScrollToMessage(
  scrollRef: RefObject<HTMLDivElement | null>,
  setFlashMessageId: (id: string | null) => void,
  flashTimer: RefObject<ReturnType<typeof setTimeout> | null>,
  sessionId: string,
  messages: readonly { readonly id: string }[],
  windowVersion: number,
): (messageId: string) => LandOutcome {
  /** 真正那一手:此刻树上有就落,没有就答 false。它一个字没改。 */
  const land = useCallback(
    (messageId: string) => {
      const el = scrollRef.current
      const node = el ? anchorNodes(el).get(messageId) : undefined
      if (!el || !node) return false
      /*
       * ── 滚过去那一发经**那唯一的口**(G 线 P2-c)──────────────────────────
       * 从前这里直接 `el.scrollTo({ behavior: 'smooth' })`:它**不经过跟随状态机**,
       * 而那一支的判据是「`scrollTop` 比上一次小没小」—— 往下跳到一条离底还有半屏的
       * 消息上时它读成「没往回走」于是不翻档,状态机仍是 `pinned`,下一段 delta 到达
       * 时 RO 把人一把拽回底(正本 §13.1.1 末、§18.2)。收编之后由锚定器落位并
       * **当场重判一次档**;`behavior: 'smooth'` 一个字没变(平滑不许变瞬移)。
       *
       * 落点仍然由这里算 —— 这一句是「元素在文档里的位置」,与从前逐字相同;
       * 口够不着的地方(样例页 / 单测)缺省退回浏览器自己那一发,行为恒等。
       */
      const top = node.getBoundingClientRect().top - (el.getBoundingClientRect().top - el.scrollTop)
      geometryPortOf(sessionId).jump({ top, behavior: 'smooth' })
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
    [scrollRef, setFlashMessageId, flashTimer, sessionId],
  )

  /** 还没落成的那一条(至多一格 —— 后一次点击顶掉前一次,与人的意思一致)。 */
  const pending = useRef<string | null>(null)

  const request = useCallback(
    (messageId: string): LandOutcome => {
      if (land(messageId)) {
        pending.current = null
        return 'done'
      }
      if (reachChatWindow(sessionId, messages, messageId) === 'absent') {
        pending.current = null
        return 'absent'
      }
      pending.current = messageId
      return 'pending'
    },
    [land, sessionId, messages],
  )

  /*
   * 窗口又扩了一次 / 树重画过一次 —— 该再试一次那格待办了。
   * 两个依赖各说一件事:`windowVersion` 说「按屏进那一侧摆出来的更多了」,
   * `messages` 说「折叠器那一侧又推了一次屏」。
   */
  useEffect(() => {
    const id = pending.current
    if (!id) return
    if (land(id)) pending.current = null
  }, [windowVersion, messages, land])

  // 换会话 = 那格待办作废(它说的是上一条会话里的某一行)。
  useEffect(() => () => void (pending.current = null), [sessionId])

  return request
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
  /*
   * 落点那一手要的两格事实:**这条会话的消息**(判「有没有这条」)与**窗口版本**
   * (「按屏进那一侧又摆出来一批了」)。它们读在这里而不是在下面那条 locate
   * effect 旁边,因为 `useScrollToMessage` 是两个入口共用的那一只。
   */
  const foldMessages = useChatSourceOf(sessionId, (st) => st.messages)
  const windowVersion = useChatWindowVersion(sessionId)
  const scrollToMessage = useScrollToMessage(
    scrollRef,
    setFlashMessageId,
    flashTimer,
    sessionId,
    foldMessages,
    windowVersion,
  )

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
  useEffect(() => {
    if (!locate) return
    if (sessionId !== locate.sessionId) return
    if (foldSessionId !== locate.sessionId || foldStatus !== 'ready') return
    /*
     * 待办这一格**当场消掉**,三种结局都一样:落成了自不必说;`pending` 是
     * 「那条消息在,窗口正在够过去」—— 落点那一手自己记着,一定会落下去,
     * 不该把跨组件那格待办也留着(留着的话下一次树重画会再跑一遍整条判断)。
     * 只有 `absent` 才多说一句:进是进来了,那条消息不在这棵树上。
     */
    const outcome = scrollToMessage(locate.messageId)
    settleLocate(locate.token)
    if (outcome !== 'absent') return
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
