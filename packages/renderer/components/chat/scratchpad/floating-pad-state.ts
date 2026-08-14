/**
 * 悬浮草稿垫的**几何**——纯函数 + 一份 localStorage 账。
 *
 * 为什么位置不进 scratchpad store:纸(内容)是**每会话**的事实,存在主进程的
 * 文件里;垫子摆在屏幕哪儿是**每窗口**的偏好,跟哪张纸在上面没有关系。两件事
 * 混在一起,换会话垫子就会跳位置——那是最烦人的那种"记忆"。
 *
 * 容错照 `workspace/ui-anchor-registry.ts` 的写法:存不下不是错误,只是不持久;
 * 读到脏数据一律退回缺省,不让一条坏记录把垫子甩出屏幕。
 */

export interface PadRect {
  x: number
  y: number
  width: number
  height: number
}

export interface PadPoint {
  x: number
  y: number
}

export interface Viewport {
  width: number
  height: number
}

export interface FloatingPadState {
  rect: PadRect
  bubble: PadPoint
  collapsed: boolean
}

export const PAD_STORAGE_KEY = 'onething:scratchpad-pad:v1'

export const PAD_MIN_WIDTH = 260
export const PAD_MIN_HEIGHT = 200
export const PAD_DEFAULT_WIDTH = 380
export const PAD_DEFAULT_HEIGHT = 480
export const BUBBLE_SIZE = 40

/** 缺省停靠时离视口右/下边留的空当:下边多留一截,让开输入框。 */
const DEFAULT_MARGIN_RIGHT = 24
const DEFAULT_MARGIN_BOTTOM = 132
/** 拖出屏幕的下界:再怎么甩,至少留这么宽一条还能抓回来。 */
const KEEP_VISIBLE = 48

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clampNumber(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * localStorage 在测试 / 无浏览器环境可能缺席。判据卡在**方法在不在**而不是
 * "全局有没有":Node 22 起 globalThis 上有一个方法全 undefined 的空壳
 * (与 stores/scratchpad.ts 同一条判例)。
 */
function safeStorage(): Storage | null {
  try {
    const storage = typeof localStorage === 'undefined' ? null : localStorage
    return typeof storage?.getItem === 'function' ? storage : null
  } catch {
    return null
  }
}

export function viewportSize(): Viewport {
  if (typeof window === 'undefined') return { width: 1280, height: 800 }
  return {
    width: Math.max(window.innerWidth || 0, PAD_MIN_WIDTH),
    height: Math.max(window.innerHeight || 0, PAD_MIN_HEIGHT),
  }
}

/** 首次的落点:右下角、让开输入框那一截。 */
export function defaultRect(viewport: Viewport): PadRect {
  const width = Math.min(PAD_DEFAULT_WIDTH, Math.max(viewport.width - 2 * DEFAULT_MARGIN_RIGHT, PAD_MIN_WIDTH))
  const height = Math.min(PAD_DEFAULT_HEIGHT, Math.max(viewport.height - DEFAULT_MARGIN_BOTTOM - 24, PAD_MIN_HEIGHT))
  return clampRect({
    x: viewport.width - width - DEFAULT_MARGIN_RIGHT,
    y: viewport.height - height - DEFAULT_MARGIN_BOTTOM,
    width,
    height,
  }, viewport)
}

export function defaultBubble(viewport: Viewport): PadPoint {
  return clampBubble({
    x: viewport.width - BUBBLE_SIZE - DEFAULT_MARGIN_RIGHT,
    y: viewport.height - BUBBLE_SIZE - DEFAULT_MARGIN_BOTTOM,
  }, viewport)
}

/**
 * 尺寸先夹到视口容得下的范围,再夹位置。
 *
 * 位置的下界刻意**不是 0**:允许垫子探出视口左/上,只要还留 `KEEP_VISIBLE`
 * 宽的一条能抓——否则窄窗口下一张大垫子会被强行按在 (0,0),用户拖到哪都弹回来。
 */
export function clampRect(rect: PadRect, viewport: Viewport): PadRect {
  const width = clampNumber(finite(rect.width, PAD_DEFAULT_WIDTH), PAD_MIN_WIDTH, Math.max(viewport.width, PAD_MIN_WIDTH))
  const height = clampNumber(finite(rect.height, PAD_DEFAULT_HEIGHT), PAD_MIN_HEIGHT, Math.max(viewport.height, PAD_MIN_HEIGHT))
  return {
    width,
    height,
    x: Math.round(clampNumber(finite(rect.x, 0), KEEP_VISIBLE - width, viewport.width - KEEP_VISIBLE)),
    y: Math.round(clampNumber(finite(rect.y, 0), 0, Math.max(viewport.height - KEEP_VISIBLE, 0))),
  }
}

export function clampBubble(point: PadPoint, viewport: Viewport): PadPoint {
  return {
    x: Math.round(clampNumber(finite(point.x, 0), 0, Math.max(viewport.width - BUBBLE_SIZE, 0))),
    y: Math.round(clampNumber(finite(point.y, 0), 0, Math.max(viewport.height - BUBBLE_SIZE, 0))),
  }
}

/**
 * 八向拉伸的一次求解。`dir` 的两个字符分别是纵/横方向上抓住的边
 * (`n`/`s`/`''` + `w`/`e`/`''`),抓住的边跟着指针走,对边钉死。
 *
 * 最小尺寸不是"停在最小值",而是**钉住对边**:从左边往右拖过头时,右沿必须
 * 原地不动(否则整块会跟着指针一起平移,手感像在拖动而不是缩放)。
 */
export function resizeRect(
  start: PadRect,
  dir: string,
  dx: number,
  dy: number,
  viewport: Viewport,
): PadRect {
  const right = start.x + start.width
  const bottom = start.y + start.height
  let { x, y, width, height } = start

  if (dir.includes('w')) {
    width = Math.max(start.width - dx, PAD_MIN_WIDTH)
    x = right - width
  } else if (dir.includes('e')) {
    width = Math.max(start.width + dx, PAD_MIN_WIDTH)
  }

  if (dir.includes('n')) {
    height = Math.max(start.height - dy, PAD_MIN_HEIGHT)
    y = bottom - height
  } else if (dir.includes('s')) {
    height = Math.max(start.height + dy, PAD_MIN_HEIGHT)
  }

  return clampRect({ x, y, width, height }, viewport)
}

export function defaultPadState(viewport: Viewport = viewportSize()): FloatingPadState {
  return {
    rect: defaultRect(viewport),
    bubble: defaultBubble(viewport),
    collapsed: false,
  }
}

/** 一条坏记录不该让整份账作废——逐字段回退到缺省。 */
export function parsePadState(raw: string | null, viewport: Viewport = viewportSize()): FloatingPadState {
  const fallback = defaultPadState(viewport)
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw) as Partial<FloatingPadState> | null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback
    return {
      rect: clampRect({ ...fallback.rect, ...(parsed.rect ?? {}) }, viewport),
      bubble: clampBubble({ ...fallback.bubble, ...(parsed.bubble ?? {}) }, viewport),
      collapsed: parsed.collapsed === true,
    }
  } catch {
    return fallback
  }
}

export function loadPadState(viewport: Viewport = viewportSize()): FloatingPadState {
  return parsePadState(safeStorage()?.getItem(PAD_STORAGE_KEY) ?? null, viewport)
}

export function savePadState(state: FloatingPadState): void {
  const storage = safeStorage()
  if (!storage) return
  try {
    storage.setItem(PAD_STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 存不下不是错误,只是不持久。
  }
}
