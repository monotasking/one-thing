import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { TOC_FLASH_MS } from '../components/motion'
import { currentTurnIndex } from './transitions'

/**
 * TOC 与聊天区之间**唯一**的 DOM 接缝:量坐标、滚过去、点亮落点。
 *
 * 分工是刻意的 —— 测量归这里,判定归 transitions.currentTurnIndex(纯函数、可测);
 * 状态机(toc/store)则完全不知道有 DOM 这回事,它只管展不展开。
 *
 * 锚点靠 data-turn-index 找:ChatMock 把它写在每一轮的外框上,
 * 键的 index 与它逐条对齐(两边都是 CHAT_TURNS 的下标,不存第二份映射)。
 */
export interface ChatToc {
  /** 当前键:视口内最近一条用户消息 */
  currentIndex: number
  /** 正在高亮淡出的那条;null = 没有 */
  flashIndex: number | null
  /** 挂到聊天滚动容器的 onScroll 上 */
  syncFromScroll: () => void
  /** 点行 / 点键的落点动作 */
  pickTurn: (index: number) => void
}

function turnNodes(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-turn-index]'))
}

/**
 * 每条用户消息相对**滚动内容顶部**的偏移。
 * 用 getBoundingClientRect 而不是 offsetTop:后者依赖 offsetParent 是谁,
 * 聊天列包一层定位元素就会算错;前者只依赖当前渲染结果。
 */
function measureTurnTops(container: HTMLElement): number[] {
  const base = container.getBoundingClientRect().top - container.scrollTop
  return turnNodes(container).map((node) => node.getBoundingClientRect().top - base)
}

export function useChatToc(scrollRef: RefObject<HTMLDivElement | null>): ChatToc {
  const [currentIndex, setCurrentIndex] = useState(0)
  const [flashIndex, setFlashIndex] = useState<number | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const syncFromScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    setCurrentIndex(currentTurnIndex(measureTurnTops(el), el.scrollTop, el.clientHeight))
  }, [scrollRef])

  // 首帧对一次:进来时当前键就该是第一条,而不是等用户滚一下才出现。
  useEffect(() => {
    syncFromScroll()
  }, [syncFromScroll])

  useEffect(() => () => void (flashTimer.current && clearTimeout(flashTimer.current)), [])

  const pickTurn = useCallback(
    (index: number) => {
      const el = scrollRef.current
      if (el) {
        const tops = measureTurnTops(el)
        const top = tops[index]
        // jsdom 里没有 scrollTo;守一手,免得测试环境把渲染层拖红。
        if (top !== undefined && typeof el.scrollTo === 'function') {
          el.scrollTo({ top, behavior: 'smooth' })
        }
      }
      setCurrentIndex(index)
      // 先清再点,连点同一条时 CSS 动画才会重放(同一个类名不换是不会重来的)。
      setFlashIndex(null)
      if (flashTimer.current) clearTimeout(flashTimer.current)
      const raf =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : (fn: () => void) => setTimeout(fn, 0)
      raf(() => {
        setFlashIndex(index)
        flashTimer.current = setTimeout(() => setFlashIndex(null), TOC_FLASH_MS)
      })
    },
    [scrollRef],
  )

  return { currentIndex, flashIndex, syncFromScroll, pickTurn }
}
