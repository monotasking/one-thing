import { cloneElement, useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactElement, ReactNode, Ref } from 'react'
import { TOOLTIP_DELAY_MS } from '../components/motion'
import { focusTree } from '../focus/registry'
import { useFloatPosition } from './float'
import s from './Tooltip.module.css'

/**
 * 规范画布「层级 · 浮层三件套」板的 Tooltip:反色墨底、r-1、无箭头、**无位移**入场,
 * 只淡入。板上写的是延迟 400ms 出现;仓里已经有一枚 --dur-tooltip-delay(300ms)
 * 和它在 JS 侧的镜像 TOOLTIP_DELAY_MS —— 一个数只该有一个出处,所以默认值取既有那枚,
 * 需要更慢的调用方自己传 delayMs。改延迟改 token,两处 tooltip 一起变。
 *
 * portal 到 body 不是洁癖(与 Menu 同一条判例):Dock 条上有 backdrop-filter,
 * 而 backdrop-filter 会给 position:fixed 的后代造包含块,留在原地会以 Dock 为原点定位。
 *
 * 定位:锚点正上方居中;顶不下时翻到下方 —— 这两件由 `ui/float` 的 above-center 档
 * 承担(它同时让提示**跟着锚点滚**:锚点长在滚动容器里,一次性坐标快照会当场脱开)。
 * 就这一次翻转,不引定位库 —— 引一个库进来是为了处理十种边界,而系统里的 tooltip
 * 只有这一种。
 * 退场直接消失(板上只给了入场,没给出场;不淡出是因为鼠标已经走了,留着才碍事)。
 *
 * 它不认识业务:content 是调用方经 i18n 给的字符串。
 * 不做「给禁用元素包一层代理」那套 —— 禁用元素本来就不该只靠 tooltip 说话。
 *
 * ── 键盘表(A11y 线 · A2)───────────────────────────────────────────────
 *   聚焦锚点(Tab 走到它)   与 hover 同一条路,同样延迟后出现
 *   Esc                    当场消失,**不关**锚点所在的任何浮层,也**不认领**
 *                          这一下(APG:tooltip 的 Esc 只消 tooltip)——
 *                          09-02 R1 起走响应链的瞬态口,见下面那段
 * 语义:提示体 role=tooltip,出现期间锚点带 aria-describedby 指着它 ——
 * 「这个控件还有一句补充说明」得说得出口,光画在屏幕上不算。
 * 它自己**永不进 Tab 序**:提示不是控件。
 * ──────────────────────────────────────────────────────────────────────
 */
interface TooltipProps {
  /** 提示文字。走 i18n,组件里不落字面。 */
  content: ReactNode
  /** 悬停/聚焦多久才出现。默认 = --dur-tooltip-delay 的 JS 镜像。 */
  delayMs?: number
  children: ReactElement<Record<string, unknown>>
}

/**
 * 把两个同名回调串起来:**先跑孩子自己的,再跑我们的**。
 * cloneElement 注入同名 prop 会**静默覆盖**孩子原有的那一个(这个模式的经典缺陷):
 * 一颗本来就有 onMouseEnter 的按钮包进 Tooltip,它自己那一手就再也不响了,
 * 而且不报错、不警告 —— 只能靠人肉发现。ref 同理,所以下面还有一个 composeRef。
 */
function chain<E>(theirs: unknown, ours: (e: E) => void): (e: E) => void {
  return (e: E) => {
    if (typeof theirs === 'function') (theirs as (ev: E) => void)(e)
    ours(e)
  }
}

/** 一个节点交给多个 ref。孩子自带 ref 时两个都要接到,不能只留我们这一个。 */
function composeRef<T>(...refs: (Ref<T> | undefined)[]): (node: T | null) => void {
  return (node: T | null) => {
    for (const r of refs) {
      if (typeof r === 'function') r(node)
      else if (r) (r as { current: T | null }).current = node
    }
  }
}

export function Tooltip({ content, delayMs = TOOLTIP_DELAY_MS, children }: TooltipProps) {
  const anchor = useRef<HTMLElement | null>(null)
  const tip = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [shown, setShown] = useState(false)
  const tipId = useId()

  const { left, top, flipped } = useFloatPosition(
    tip,
    {
      kind: 'rect',
      place: 'above-center',
      get: () => anchor.current?.getBoundingClientRect() ?? null,
    },
    { active: shown },
  )

  const hide = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    setShown(false)
  }, [])

  const show = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      // 锚点这会儿已经不在了(卸载 / 换了内容)就别出:提示没有可依附的东西。
      if (!anchor.current) return
      setShown(true)
    }, delayMs)
  }, [delayMs])

  useEffect(() => hide, [hide])

  /*
   * ── Esc 消提示:走响应链的**瞬态口**,不是一个作用域(09-02 R1)────────────
   *
   * 收编时的二选一,选的是 (b)。理由是这件组件**没有一个包着触发元素的根**:
   * 它用 `cloneElement` 把手接在消费方自己那颗按钮上,提示体则 portal 到 body。
   * 做成 `float` 作用域的话根只能铺在**锚点**上(提示体是 portal 出去的一小块,
   * 铺在它身上等于「提示自己是一块能接键盘的面」,而它连焦点都不占),于是
   * 「焦点在那颗按钮上」就会等于「tooltip 是第一响应者」—— 那是假的,而且这台上
   * 每一颗图标钮都包着 Tooltip,假的第一响应者会遍地都是。
   *
   * 所以它登记的是 `focusTree.registerTransient(onEscape)`:仍然住在 `src/focus/`、
   * 仍然只有那一个 window 监听,派发器在问活动路径**之前**先问这张表。
   * 只在提示**已经出现**时登记(不挂着不该属于自己的键),并且**答 false** ——
   * 消掉提示之后这一下 Esc 该继续传给谁就传给谁(APG 明说 tooltip 的 Esc
   * 不该拦别人,从前那条监听不 preventDefault 也不 stopPropagation,同一个意思)。
   */
  useEffect(() => {
    if (!shown) return
    return focusTree.registerTransient(() => {
      hide()
      return false
    })
  }, [shown, hide])

  const childProps = children.props
  const child = cloneElement(children, {
    ref: composeRef<HTMLElement>(childProps.ref as Ref<HTMLElement> | undefined, anchor),
    onMouseEnter: chain(childProps.onMouseEnter, show),
    onMouseLeave: chain(childProps.onMouseLeave, hide),
    onFocus: chain(childProps.onFocus, show),
    onBlur: chain(childProps.onBlur, hide),
    // 只在提示在场时指过去 —— 指一个还没渲染出来的 id 是一条断掉的引用。
    'aria-describedby': shown ? tipId : undefined,
  })

  return (
    <>
      {child}
      {shown &&
        createPortal(
          <div
            ref={tip}
            id={tipId}
            role="tooltip"
            className={flipped ? `${s.tip} ${s.below}` : s.tip}
            style={{ left: `${left}px`, top: `${top}px` }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  )
}
