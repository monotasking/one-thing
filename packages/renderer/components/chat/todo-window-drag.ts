/**
 * 独立 Todo 窗的**手动拖窗**判据与算术。
 *
 * 为什么需要手写一套:那扇窗在 macOS 上是 non-activating `NSPanel`
 * (`type: 'panel'` + native `NSWindowStyleMaskNonactivatingPanel`),原生
 * `-webkit-app-region: drag` 在它身上不生效 —— 同一份 CSS 在主窗
 * (`titleBarStyle: 'hidden'`)和搜索窗(`frame: false`)上都拖得动,唯独这扇不动。
 * CSS 声明保留(将来窗型变了它自然接管),这里是兜底的那条路。
 *
 * 这个文件只放**纯函数**:拖拽里唯一会算错的地方是位移,唯一会误触的地方是判据,
 * 两样都在这里,于是两样都能测。指针捕获、rAF 节流、IPC 发送留在组件里。
 */

/**
 * 拖动面里**不该起拖**的东西。判据是「这一点是不是可交互件」,不是「它在哪一层」——
 * 所以用 `closest` 往上找,而不是比对某一个具体容器。
 *
 * `[contenteditable]` 覆盖编辑器;`.no-window-drag` 是给没有语义标签、但确实要接
 * 指针的那种面留的手动出口。
 */
export const WINDOW_DRAG_EXCLUDED_SELECTOR = [
  'button',
  'a',
  'input',
  'textarea',
  'select',
  'label',
  '[contenteditable]',
  '[role="button"]',
  '[role="textbox"]',
  '[role="menuitem"]',
  '.no-window-drag',
].join(', ')

/**
 * 目标形状故意收在 `unknown`:`PointerEvent.target` 的静态类型是 `EventTarget`,
 * 上面并没有 `closest` —— 在这里做一次运行时收窄,比让每个调用点都断言一次干净。
 */
export interface WindowDragPointerLike {
  /** `pointerdown` 里 0 = 主键。触控 / 笔按下时也是 0。 */
  button?: number
  /** mac 上 ctrl + 主键 = 右键菜单,不能当拖拽起手。 */
  ctrlKey?: boolean
  target?: unknown
  screenX: number
  screenY: number
}

export interface WindowDragOrigin {
  screenX: number
  screenY: number
}

export interface WindowDragOffset {
  dx: number
  dy: number
}

export function isWindowDragExcludedTarget(target: unknown): boolean {
  const node = target as { closest?: (selector: string) => unknown } | null | undefined
  if (!node || typeof node.closest !== 'function') return false
  return Boolean(node.closest(WINDOW_DRAG_EXCLUDED_SELECTOR))
}

/**
 * 这一次 `pointerdown` 该不该起拖。
 *
 * 三个否决项:非主键(右键 / 中键)、mac 的 ctrl + 主键(那是右键菜单)、落点在
 * 可交互件里(按钮不该顺手把窗拖走)。
 */
export function shouldStartWindowDrag(event: WindowDragPointerLike): boolean {
  if ((event.button ?? 0) !== 0) return false
  if (event.ctrlKey === true) return false
  return !isWindowDragExcludedTarget(event.target)
}

/**
 * 相对拖起点的**累计**位移。
 *
 * 用累计而不是帧间增量:`screenX/Y` 是指针的屏幕坐标,和窗口位置无关,窗跟着走也
 * 不会自我参照;累计量对丢帧免疫,也不会把每帧的舍入误差攒成漂移。多显示器下屏幕
 * 坐标可以是负的 —— 这里只做减法,不夹取。
 */
export function windowDragOffset(origin: WindowDragOrigin, point: WindowDragOrigin): WindowDragOffset {
  return {
    dx: point.screenX - origin.screenX,
    dy: point.screenY - origin.screenY,
  }
}
