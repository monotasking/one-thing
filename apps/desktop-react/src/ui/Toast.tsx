import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { create } from 'zustand'
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from '../components/icons'
import { announce } from './a11y/live-region'
import { IconButton } from './IconButton'
import s from './Toast.module.css'

/**
 * 规范画布「层级 · 浮层三件套」板的 Toast:r-2 · sh-2 · **状态色只上左侧图标,不换底**
 * (状态色不上底是全系统总律,在 Feedback 板的行内错误条那里也成立)。
 * 板上写的是底部居中停 2.6s;本批按拍板改**右上角堆叠**,时长按级别分档 ——
 * 位置和时长换了,配方一格没换。入场位移沿用板上的 8px:这是全系统唯一允许位移的入场,
 * 「无位移原则」约束的是 hover / active / 选中的**反馈**,不是浮层进出。
 *
 * ── 计时住在 hub 里,不住在行上(08-30 通知系统批改)────────────────────────
 * 从前每一行自己 setTimeout。加了「同屏最多 3 条」之后这条路走不通:被挤下去的
 * 那几条**不再渲染**,它们的计时器就跟着组件一起卸载了,于是它们永远不会到期,
 * 折叠丸上的数只增不减。所以计时上提到 hub —— 一条 toast 的寿命是它自己的事实,
 * 与「此刻画不画得下它」无关。
 *
 * 被挤下去的那几条是**当场退场**的(不是藏起来继续烧):它们已经进了通知中心存档,
 * 屏幕上只留一枚小丸说「还有 N 条更早的,去中心看」。代价记档:一条 error(本不
 * 自动消失)也可能被三条更新的挤走 —— 它没丢,只是从屏幕挪进了中心。
 *
 * 文案全部由调用方给(标题、正文、合并计数那句短注、「查看详情」那道门的字与去处、
 * ✕ 的 aria-label、小丸上那句话)—— 组件里不落字面,和不落字面色值同级。
 *
 * ── 一条 toast 上只有一件事可读到底(09-01 崩溃弹框整改)──────────────────
 * 栈、完整模块 URL、原样报文这一族**不铺在这里**:它们是给排障的人看的,
 * 铺开只会把一句人话变成一屏机器话。带 `action` 的那条在屏幕上只留一道门,
 * 门后是通知中心里那条可展开的记录(去哪儿由 services/notify.ts 给)。
 *
 * ── 播报(A11y 线 · A2)─────────────────────────────────────────────────
 * 一条 toast 出场时,把**它自己渲染出来的那句话**送进全应用唯一的播报口
 * (ui/a11y/live-region)。级别决定礼貌档:error → assertive(打断当前朗读,
 * 因为它本来就不自动消失、是要人处理的),其余三档 → polite。
 *
 * 播报的文本取的是 `row.textContent` 而不是把 title/body 再拼一遍 ——
 * **屏幕上写什么就念什么**,一个字都不会岔开。这就是 live region 纪律里
 * 「状态播报与视觉 toast 同源」的字面落实。
 *
 * 行本身因此**不再挂 role="status"**:那等于把这条行也变成一块 live region,
 * 一条 toast 会被念两遍。播报口只该有一个。
 *
 * 键盘表:✕ 是普通按钮(Tab 可达、Enter/Space 触发、aria-label 由调用方给)。
 * toast 本体不抢焦点 —— 它是通知,不是任务。
 * ──────────────────────────────────────────────────────────────────────
 */

/** toast 认得的四档。'silent' 不在其中:那一档根本不弹,连 hub 都进不来。 */
export type ToastLevel = 'success' | 'info' | 'warn' | 'error'

export interface ToastSpec {
  id: number
  level: ToastLevel
  title: ReactNode
  body?: ReactNode
  /**
   * 跟在标题后面的一句短注,由调用方给(组件不造文案)。
   * 今天唯一的用处:同一条又响了一次时的合并计数「×3」—— 见 services/notify.ts。
   */
  note?: ReactNode
  /**
   * 一个可选的去处。**它不是第二个关闭钮**:关闭是 ✕ 的事,这里是「这条说不完的话
   * 在别处有全文」。文案与去哪儿都由调用方给 —— 组件既不认识 i18n,也不认识
   * 通知中心是哪块瓦。
   */
  action?: { label: ReactNode; onClick: () => void }
  /** null = **不自动消失**(error 档),要点 ✕ 才走。 */
  lifeMs: number | null
}

/** 同屏最多几条。更早的折成一枚小丸。 */
export const MAX_VISIBLE_TOASTS = 3

interface ToastHub {
  toasts: ToastSpec[]
  /** 被挤出可见区、折进小丸的条数。可见区清空时归零 —— 丸没有可依附的东西了。 */
  folded: number
  push: (spec: Omit<ToastSpec, 'id'>) => number
  /**
   * 改一条**还在屏上**的 toast。不在屏上(已到期 / 已被折走)就什么都不做 ——
   * 「屏幕上那条」和「存档里那条」是两件东西,后者由通知中心自己管。
   * 存在的理由:同一个错又响了一次时,该做的是把已经在那儿的那条改成「×2」,
   * 而不是再弹一条(那正是错误风暴刷屏的样子)。
   */
  update: (id: number, patch: Partial<Omit<ToastSpec, 'id'>>) => void
  dismiss: (id: number) => void
  /** 悬停暂停:把已经烧掉的那一段从剩余里扣掉,离开时接着烧(不是重新计时)。 */
  pause: (id: number) => void
  resume: (id: number) => void
  clearFolded: () => void
}

let seq = 0

/** 每条的秒表。不进 store:它是 DOM 之外的定时器句柄,渲染一行都用不到它。 */
type Clock = { timer: ReturnType<typeof setTimeout> | null; left: number; startedAt: number }
const clocks = new Map<number, Clock>()

function arm(id: number): void {
  const clock = clocks.get(id)
  if (!clock || clock.timer) return
  clock.startedAt = Date.now()
  clock.timer = setTimeout(() => useToastHub.getState().dismiss(id), clock.left)
}

function hold(id: number): void {
  const clock = clocks.get(id)
  if (!clock?.timer) return
  clearTimeout(clock.timer)
  clock.timer = null
  clock.left = Math.max(0, clock.left - (Date.now() - clock.startedAt))
}

function forget(id: number): void {
  const clock = clocks.get(id)
  if (clock?.timer) clearTimeout(clock.timer)
  clocks.delete(id)
}

export const useToastHub = create<ToastHub>()((set) => ({
  toasts: [],
  folded: 0,

  push: (spec) => {
    const id = ++seq
    if (spec.lifeMs !== null) clocks.set(id, { timer: null, left: spec.lifeMs, startedAt: 0 })
    set((st) => {
      const next = [...st.toasts, { ...spec, id }]
      let folded = st.folded
      while (next.length > MAX_VISIBLE_TOASTS) {
        const out = next.shift()
        if (out) forget(out.id)
        folded += 1
      }
      return { toasts: next, folded }
    })
    arm(id)
    return id
  },

  update: (id, patch) =>
    set((st) =>
      st.toasts.some((x) => x.id === id)
        ? { toasts: st.toasts.map((x) => (x.id === id ? { ...x, ...patch } : x)) }
        : st,
    ),

  dismiss: (id) => {
    forget(id)
    set((st) => {
      const toasts = st.toasts.filter((x) => x.id !== id)
      return { toasts, folded: toasts.length === 0 ? 0 : st.folded }
    })
  },

  pause: (id) => hold(id),
  resume: (id) => arm(id),
  clearFolded: () => set({ folded: 0 }),
}))

/**
 * 入队一条 toast。**产品代码不该直接调它** —— 一切通知走 services/notify.ts 的单入口,
 * 那里才会同时进存档。这个口留给两种人:notify 自己,和 dev/Gallery 那种要单独
 * 演示这个组件的规格页。
 */
export function pushToast(spec: Omit<ToastSpec, 'id'>): number {
  return useToastHub.getState().push(spec)
}

const ICONS = {
  info: Info,
  success: CircleCheck,
  warn: TriangleAlert,
  error: CircleAlert,
} as const

function ToastRow({ spec, closeLabel }: { spec: ToastSpec; closeLabel?: string }) {
  const dismiss = useToastHub((st) => st.dismiss)
  const pause = useToastHub((st) => st.pause)
  const resume = useToastHub((st) => st.resume)
  // 悬停同时冻住两样东西:hub 里的秒表,和底缘那条线的动画。
  // 一份状态驱动两处,读数和实际剩余就不会各说各话。
  const [held, setHeld] = useState(false)
  const row = useRef<HTMLDivElement>(null)

  // 出场即播报一次。读的是这一行**已经渲染出来**的文字(见文件头「同源」那一节)。
  useEffect(() => {
    const text = row.current?.textContent?.trim()
    if (text) announce(text, { level: spec.level === 'error' ? 'assertive' : 'polite' })
  }, [spec.id, spec.level])

  const Icon = ICONS[spec.level]
  return (
    <div
      ref={row}
      // 行不再带 role="status"(见文件头「播报」那一节)。它从前**兼任**测试的抓手,
      // 所以抓手明写成 testid —— 一个用来定位的名字不该由一条 ARIA 语义兼职。
      data-testid="toast-row"
      className={`${s.toast} ${s[spec.level]}`}
      onMouseEnter={() => {
        setHeld(true)
        pause(spec.id)
      }}
      onMouseLeave={() => {
        setHeld(false)
        resume(spec.id)
      }}
    >
      <Icon className={s.icon} strokeWidth={1.75} aria-hidden="true" />
      <span className={s.message}>
        <span className={s.title}>
          {spec.title}
          {spec.note ? <span className={s.note}>{spec.note}</span> : null}
        </span>
        {spec.body ? <span className={s.body}>{spec.body}</span> : null}
        {spec.action ? (
          <button type="button" className={s.action} onClick={spec.action.onClick}>
            {spec.action.label}
          </button>
        ) : null}
      </span>
      {spec.lifeMs === null ? (
        <IconButton
          icon={X}
          label={closeLabel ?? ''}
          size="xs"
          className={s.close}
          onClick={() => dismiss(spec.id)}
        />
      ) : (
        <span
          className={s.life}
          aria-hidden="true"
          data-testid="toast-life"
          style={{ animationDuration: `${spec.lifeMs}ms`, animationPlayState: held ? 'paused' : 'running' }}
        />
      )}
    </div>
  )
}

interface ToastHostProps {
  /** ✕ 的 aria-label(只有不自动消失的那一档会画 ✕)。 */
  closeLabel?: string
  /** 折叠小丸上那句话。给了才画丸 —— 组件自己不造文案。 */
  moreText?: (count: number) => ReactNode
  /** 点小丸做什么。宿主给(它才知道通知中心是哪块瓦、按什么方式打开)。 */
  onMore?: () => void
}

/** 挂一次(壳的根上),toast 才有地方渲染。 */
export function ToastHost({ closeLabel, moreText, onMore }: ToastHostProps = {}) {
  const toasts = useToastHub((st) => st.toasts)
  const folded = useToastHub((st) => st.folded)
  const clearFolded = useToastHub((st) => st.clearFolded)
  if (toasts.length === 0) return null
  return createPortal(
    <div className={s.stack}>
      {folded > 0 && moreText ? (
        <button
          type="button"
          className={s.more}
          onClick={() => {
            clearFolded()
            onMore?.()
          }}
        >
          {moreText(folded)}
        </button>
      ) : null}
      {toasts.map((x) => (
        <ToastRow key={x.id} spec={x} closeLabel={closeLabel} />
      ))}
    </div>,
    document.body,
  )
}

/*
 * 热更退役(09-01 立法)。这个模块在作用域里养着 `clocks`,而每一条秒表就是一个
 * 活着的 setTimeout —— 换掉这个模块时它们不会跟着走,到点还会去戳**旧那一份** hub,
 * 于是屏幕上的 toast 与计时各说各话。寿命 = 这个模块实例,所以要 dispose。
 * 拆卸复用既有的那一口 `forget`(不写第二套);键先拷成数组再遍历,因为 forget 会
 * 删表。幂等:表空了跑一遍什么都不做。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const id of [...clocks.keys()]) forget(id)
  })
}
