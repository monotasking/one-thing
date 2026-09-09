import { createContext, useContext, useEffect, useId, useState } from 'react'
import type { HTMLAttributes, KeyboardEvent, MouseEvent, ReactNode } from 'react'

/**
 * **折叠基座**(09-09 立件,起因:压缩折痕的摘要、上下文更新 chip、思考段
 * 三处都要「一块可点的东西 + 一段跟着开合的正文」,而思考段那一份是全壳唯一
 * 写过的,再写第二份就是「各写各的」的下一个案发现场)。
 *
 * 照 `ui/ButtonBase` 的哲学:**只管行为与 a11y,一个像素都不画**。没有
 * `.module.css`,没有三角,没有动效 —— 皮肤(收起态怎么钳、展开态怎么排、
 * hover/focus 什么样)整份归消费方,因为「折叠」这件事在思考段是「同一段字的
 * 两个读法」、在折痕上是「摘要藏在线下面」,两者的形没有一个像素是共用的。
 *
 * ── API 形状:复合 children,不收 items 表 ──────────────────────────────
 * 判据是 09-01 库自审那条:**项里装什么由消费方决定 → 复合 children**
 * (与 `ui/Menu` 族同一条)。这里连「项」都不存在,只有「按哪儿」和「开什么」。
 * 命名照仓里既有的复合件写成并列具名导出(`Menu` / `MenuItem` / `MenuSection`),
 * 不挂 `Fold.Trigger` 静态属性 —— 全仓一种写法,少一个要记的例外。
 *
 * ── 两种落法,不是两套 API ───────────────────────────────────────────────
 * `FoldBody` 是**可选**的。给了它 = 「关起来就看不见」那一族(折痕的摘要、
 * chip 的块列表),关闭态用 `hidden` 属性(不是 `display` 内联,更不是卸载 ——
 * 「树/面常驻铁律」),`FoldTrigger` 这时才吐 `aria-controls` 指过去;
 * 不给它 = 「整块就是它自己的开关、正文两态都在」那一族(思考段:收起是原文
 * 钳成一行,展开是原位继续读 —— 同一段字,藏起来就没有收起态可看了)。
 * 后一族的正文直接摆进 `FoldTrigger` 里,DOM 上一个元素,交互面也只有一个。
 * **`aria-controls` 靠 `FoldBody` 挂载时登记**,不靠消费方递一格 prop:递
 * prop 就是「记得填」,忘了填的那次会指向一个不存在的 id(比不写更糟)。
 *
 * ── 三张状态表(库件规格)──────────────────────────────────────────────
 * ① 生命周期:一个 `useState`(自持态)+ 一个 `useState`(body 在不在)+
 *    `FoldBody` 的一发登记 effect。**无订阅 / 无计时器 / 无监听 / 无模块级
 *    副作用 → 不需要 HMR dispose**(判据:这东西的寿命不是「这个模块实例」)。
 *    受控(传了 `open`)与自持(`defaultOpen`)两档,切换宿主对它没有意义 ——
 *    它没有宿主,它就是消费方 DOM 里的两个标签。
 * ② UI 生命状态:不取数,没有 empty / loading / error / 超量。正文长什么样、
 *    多长、要不要滚,归消费方。
 * ③ UI 交互状态:rest / hover / focus / active 的**皮肤**全归消费方
 *    (焦点仍走全局 `:focus-visible` 环,本件不碰 outline)。本件自己只有
 *    开 / 合两态,以及一条行为:**圈选守卫** —— 展开态下选区非空(用户在圈字)
 *    时点一下不收。键盘 Enter / Space 不受这条约束:按键不可能是在圈字,
 *    而「圈着字按回车却关不上」才是真的怪。这条判例的原产地是思考段
 *    (不判选区,用户每次复制到一半这段就自己关了)。
 *    没有 disabled 档 —— 需要它的时候再加,今天没有消费方。
 *
 * ── 响应链(I2)──────────────────────────────────────────────────────
 * `onKeyDown` 挂在**触发元素自身**上,不是 window / document:结构键
 * (↵ / Space)是这套形态语法本身,不进任何表,也不该经派发器。
 */

interface FoldCtx {
  open: boolean
  toggle: (fromPointer: boolean) => void
  bodyId: string
  registerBody: (present: boolean) => void
}

const Ctx = createContext<FoldCtx | null>(null)

function useFold(who: string): FoldCtx {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error(`<${who}> 必须放在 <Fold> 里`)
  return ctx
}

/** 单独一格,免得 body 一挂载就把整份 ctx 的身份换掉(触发器会跟着白重渲)。 */
const HasBodyCtx = createContext(false)

export interface FoldProps {
  /** 传了它就是**受控**档:开合由消费方的状态说了算(思考段跟着 `live` 走的那一份)。 */
  open?: boolean
  /** 自持档的初值。受控档下忽略。 */
  defaultOpen?: boolean
  /** 每次开合都叫一次(受控档下这是唯一的写路)。 */
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}

/**
 * 不渲染任何 DOM —— 它只是一格 context。布局(触发器和正文谁在谁上面、
 * 中间隔多远)整份归消费方,多包一层 `<div>` 会当场污染消费方的 flex/grid。
 */
export function Fold({ open, defaultOpen = false, onOpenChange, children }: FoldProps) {
  const [selfOpen, setSelfOpen] = useState(defaultOpen)
  const [hasBody, setHasBody] = useState(false)
  const bodyId = useId()
  const controlled = open !== undefined
  const isOpen = controlled ? open : selfOpen

  const toggle = (fromPointer: boolean) => {
    // 展开态下,选区非空 = 用户在圈字,不是在点这块 —— 什么都不做。
    // 只挡指针那一路(见文件头 ③)。
    if (fromPointer && isOpen && !selectionIsEmpty()) return
    const next = !isOpen
    if (!controlled) setSelfOpen(next)
    onOpenChange?.(next)
  }

  return (
    <Ctx.Provider value={{ open: isOpen, toggle, bodyId, registerBody: setHasBody }}>
      <HasBodyCtx.Provider value={hasBody}>{children}</HasBodyCtx.Provider>
    </Ctx.Provider>
  )
}

type TriggerTag = 'div' | 'span'

export interface FoldTriggerProps extends HTMLAttributes<HTMLElement> {
  /**
   * 缺省 `div`。**故意不开 `button`**:这一族的正文常常就摆在触发器里
   * (思考段的 `<p>`),而 `<p>` 放进 `<button>` 是非法嵌套、浏览器会把它拆出去。
   * 需要一颗真按钮形的折叠钮时,消费 `ui/ButtonBase` 自己接 `toggleFold`,
   * 别把这件掰成两套。
   */
  as?: TriggerTag
  children?: ReactNode
}

/**
 * 可点的那一块。`role="button"` + `tabIndex=0` + `aria-expanded`,
 * 键鼠两路都通向同一次 `toggle`。
 */
export function FoldTrigger({ as = 'div', onClick, onKeyDown, children, ...rest }: FoldTriggerProps) {
  const { open, toggle, bodyId } = useFold('FoldTrigger')
  const hasBody = useContext(HasBodyCtx)
  const Tag = as

  const handleClick = (event: MouseEvent<HTMLElement>) => {
    onClick?.(event)
    if (event.defaultPrevented) return
    toggle(true)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    // Space 不 preventDefault 的话页面会跟着滚一屏 —— 这一块本来就常在长流里。
    event.preventDefault()
    toggle(false)
  }

  return (
    <Tag
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-controls={hasBody ? bodyId : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      {...rest}
    >
      {children}
    </Tag>
  )
}

type BodyTag = 'div' | 'p' | 'section' | 'span' | 'ul'

export interface FoldBodyProps extends HTMLAttributes<HTMLElement> {
  as?: BodyTag
  children?: ReactNode
}

/**
 * 跟着开合的正文。关闭态加 `hidden` 属性 **并且** 内联 `display: none`;不卸载
 * (常驻铁律 —— 再展开时里面的滚动位置、选区、子组件状态都还在)。
 *
 * 为什么还要内联那一句(2026-09-09 真机报障「收缩不了、默认就是展开」):
 * 浏览器给 `[hidden]` 的 `display: none` 只是 UA 样式,消费方皮肤里一句
 * `.body { display: flex }` 就把它盖掉了 —— 折痕摘要与上下文更新 chip 两处正文
 * 皮肤都写了 display,于是 `hidden` 挂着、东西照样在屏上,点标签只换了
 * `aria-expanded`。第一版这里刻意不写内联,理由是「藏起来应归属性不归样式」;
 * 那条理由成立,读数被真机推翻:属性说了不算,只有内联样式任何皮肤都盖不过。
 * 只在关闭态写,展开态把消费方自己的 `style` 原样交回去。
 */
export function FoldBody({ as = 'div', children, style, ...rest }: FoldBodyProps) {
  const { open, bodyId, registerBody } = useFold('FoldBody')
  const Tag = as

  useEffect(() => {
    registerBody(true)
    return () => registerBody(false)
  }, [registerBody])

  return (
    <Tag id={bodyId} hidden={!open} style={open ? style : { ...style, display: 'none' }} {...rest}>
      {children}
    </Tag>
  )
}

/**
 * 选区是不是空的。
 *
 * 拿不到 selection(非浏览器环境)按「空」算:这条判据只用来**否决**收起,
 * 拿不到时的正确行为是让点击照常生效,而不是让这块再也关不上。
 */
function selectionIsEmpty(): boolean {
  if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return true
  return window.getSelection()?.isCollapsed !== false
}
