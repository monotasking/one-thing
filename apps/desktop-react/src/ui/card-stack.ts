import { useCallback, useEffect, useRef } from 'react'
import type { FocusEvent, RefObject } from 'react'
import { ATT_GRACE_MS } from '../components/motion'

/**
 * **一摞卡:收拢是错角叠放,展开是一排横滚**(2026-09-16 从 composer 附件摞抽出)。
 *
 * 两个消费者:composer 上方那摞待发附件(`composer/components/AttachmentStack`)与
 * 聊天流里用户消息的图片(`content/user-attachments`,图多时折叠)。用户原话是
 * 「图片多的时候折叠,像 composer 的附件一样」—— 所以这是**同一种形**,不是
 * 两份长得像的代码:排布是一个纯函数,开合是一个 hook,皮各自住在消费方。
 *
 * 三条设计裁定(原样从 composer 那一版搬来):
 * 1. **展开是状态,不是 hover 的副作用** —— 开合由消费方持有(composer 放在 store,
 *    聊天流放在组件里),删一张卡其余就位,摞不塌;
 * 2. **收拢带宽限**(`ATT_GRACE_MS`)—— 卡缝与删卡瞬间的出界不塌摞,再进即取消;
 * 3. **两态同高** —— 只有横向排布变,纵向几何零变化,所以放在滚动流里也不推人。
 */

export interface CardStackItem {
  readonly id: string
  /** 这张卡此刻的宽(px)。CSS 里的同名 token 是它的另一处写法。 */
  readonly width: number
}

export interface CardStackGeometry {
  /** 收拢时画最上面几张。 */
  readonly visible: number
  /** 收拢摞的基础内衬:旋转的卡角不出容器。 */
  readonly inset: number
  /** 摞里每往上一张多探出多少。 */
  readonly offset: number
  /** 错角度数。 */
  readonly rotate: number
  /** 展开成排时的卡缝。 */
  readonly gap: number
  /** 收拢态实宽之外再留的旋转余量。 */
  readonly slack: number
}

export interface CardStackCard {
  id: string
  hidden: boolean
  left: number
  rotate: number
  zIndex: number
}

export interface CardStackLayout {
  cards: CardStackCard[]
  /** 内层排的总宽(展开态撑出横滚)。 */
  rowWidth: number
  /** 收拢态摞的实宽;展开态是 null = 交给容器封顶(CSS 里的 100%)。 */
  stackWidth: number | null
}

/**
 * 一次算完整摞的排布。两态是**同一个函数的两条分支**,不是两套代码:
 *   展开 = 从左往右累计 x,零旋转,总宽撑出横滚;
 *   收拢 = 只留最上 `visible` 张,逐张 offset + 错角,宽度按「最宽可见卡的右缘」。
 */
export function layoutCardStack(
  items: readonly CardStackItem[],
  open: boolean,
  g: CardStackGeometry,
): CardStackLayout {
  const cards: CardStackCard[] = []
  const first = Math.max(0, items.length - g.visible)
  let x = 0
  let stackW = 0

  items.forEach((item, i) => {
    if (open) {
      cards.push({ id: item.id, hidden: false, left: x, rotate: 0, zIndex: i })
      x += item.width + g.gap
      return
    }
    if (i < first) {
      cards.push({ id: item.id, hidden: true, left: 0, rotate: 0, zIndex: i })
      return
    }
    const k = i - first // 0..visible-1,顶卡 = 最后一张
    const off = g.inset + k * g.offset
    cards.push({ id: item.id, hidden: false, left: off, rotate: ((k % 3) - 1) * g.rotate, zIndex: i })
    stackW = Math.max(stackW, off + item.width)
  })

  return {
    cards,
    rowWidth: open ? Math.max(x - g.gap, 0) : stackW + g.slack,
    stackWidth: open ? null : stackW + g.slack,
  }
}

/**
 * 开合手势:指针进来(或焦点进来)即展开,离开后宽限 `ATT_GRACE_MS` 再收;
 * 展开时滚轮纵转横 —— 超长一排不该逼人按住 shift。
 *
 * 焦点那一半是键盘的等价路:Tab 走进摞里一张卡就展开,焦点离开整摞才收。
 * 判「离开整摞」看 `relatedTarget` 还在不在容器里,卡与卡之间 Tab 不收。
 */
export function useCardStackOpen(
  containerRef: RefObject<HTMLElement | null>,
  open: boolean,
  setOpen: (open: boolean) => void,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  useEffect(() => cancel, [cancel])

  // React 的 onWheel 是被动的,preventDefault 要非被动监听,所以这里手挂。
  useEffect(() => {
    const el = containerRef.current
    if (!el || !open) return
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        el.scrollLeft += e.deltaY
        e.preventDefault()
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [containerRef, open])

  const enter = useCallback(() => {
    cancel()
    if (!open) setOpen(true)
  }, [cancel, open, setOpen])

  const leave = useCallback(() => {
    cancel()
    timer.current = setTimeout(() => {
      timer.current = null
      setOpen(false)
    }, ATT_GRACE_MS)
  }, [cancel, setOpen])

  const onBlur = useCallback(
    (e: FocusEvent<HTMLElement>) => {
      const next = e.relatedTarget as Node | null
      if (next && e.currentTarget.contains(next)) return
      leave()
    },
    [leave],
  )

  return { onMouseEnter: enter, onMouseLeave: leave, onFocus: enter, onBlur }
}
