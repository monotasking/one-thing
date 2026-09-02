import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { TOC_FLASH_MS } from '../components/motion'
import { useSessionMarkers } from '../data/sessions-source'
import { useExposeStore } from '../expose/store'
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

export function useChatToc(scrollRef: RefObject<HTMLDivElement | null>): ChatToc {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [flashMessageId, setFlashMessageId] = useState<string | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 键与锚点同源:两边都是这条会话的用户消息锚点列(TocPanel 读的是同一份)。
  const sessionId = useExposeStore((st) => st.currentSessionId)
  const markerSource = useSessionMarkers(sessionId).data
  const anchorIds = useMemo(
    () => (markerSource ?? []).map((marker) => marker.id),
    [markerSource],
  )

  const syncFromScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const found = measureAnchors(el, anchorIds)
    // 判定只吃「量出来的坐标」;缺席的锚点先摘掉,再把结果映回锚点列的下标。
    const hit = currentTurnIndex(
      found.map((entry) => entry.top),
      el.scrollTop,
      el.clientHeight,
    )
    setCurrentIndex(hit < 0 ? -1 : (found[hit]?.index ?? -1))
  }, [scrollRef, anchorIds])

  // 首帧对一次,换会话 / 锚点变了也对一次:当前键该是算出来的,不是等用户滚一下。
  useEffect(() => {
    syncFromScroll()
  }, [syncFromScroll])

  useEffect(() => () => void (flashTimer.current && clearTimeout(flashTimer.current)), [])

  const pickTurn = useCallback(
    (index: number) => {
      const messageId = anchorIds[index]
      if (!messageId) return
      const el = scrollRef.current
      if (el) {
        const node = anchorNodes(el).get(messageId)
        // jsdom 里没有 scrollTo;守一手,免得测试环境把渲染层拖红。
        if (node && typeof el.scrollTo === 'function') {
          const top = node.getBoundingClientRect().top - (el.getBoundingClientRect().top - el.scrollTop)
          el.scrollTo({ top, behavior: 'smooth' })
        }
      }
      setCurrentIndex(index)
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
    },
    [scrollRef, anchorIds],
  )

  return { currentIndex, flashMessageId, syncFromScroll, pickTurn }
}
