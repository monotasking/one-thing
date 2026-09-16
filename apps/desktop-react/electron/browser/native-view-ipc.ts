/**
 * `host:native-view` 的**唯一**那一条 `ipcMain.on`。
 *
 * ## 为什么钉数从 1 变成 2,而且到此为止
 *
 * `transport:gate` 钉着「React 壳只许有一条手写 IPC」(今天是 `host:connection`)。
 * 这一条让它变成 2,基线文件那一行写明理由:**它是窗口系统的管道,不是数据面**
 * ——与 `host:connection` 同族。数据面(读 / 做 / 看)永远走 `POST /api/rpc`,
 * 浏览器的每一颗按钮也走那条路(`resources.do`),一条都不会落到这里。
 *
 * 钉数**不再涨**(方案 §7 演练乙):帧上带 `viewId`,主进程按 id 路由;第二种原生
 * 视图(PDF 阅读器)复用同一条通道与同一只占位格,只是多几个 id。一条通道一个
 * `verb`,不是四条通道。
 *
 * ## 为什么是 `on` 而不是 `handle`
 *
 * 这七个动词(B3-a 起;原来五个)**没有一个要回执**。`frame` 是每帧都在发的
 * (要回执就是每帧一次 Promise 往返);其余六条的答案是「屏幕上的事实」,而不是
 * 一个返回值 —— `occlude` 的回执就是那张 `snapshot` 推送,`find` 的回执就是那条
 * `find` 推送(而且一次查找会推**好几发**:Chromium 边扫边报,一个 Promise
 * 只接得住其中一发)。`handle` 会让每一发都背上一个没人读的 Promise。
 *
 * ## 载荷是不可信的
 *
 * 发帧的是渲染进程(本机、同一份代码),但**判据不该建立在那上面** —— 一次拼错的
 * 帧不该让主进程抛。所以每条动词自己校验形状,认不出来的静默丢掉(记一条 debug)。
 */

import type { AppMenuSpec, NativePopupItem, NativeViewRequest } from '../native-view-protocol.js'
import { NATIVE_VIEW_CHANNEL } from '../native-view-protocol.js'

/** `ipcMain` 上用到的那两口。真实现是 electron 的 `ipcMain`。 */
export interface NativeViewIpcMain {
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeAllListeners(channel: string): unknown
}

/** 七个动词各自的落点。装配方填。 */
export interface NativeViewHandlers {
  frame(request: Extract<NativeViewRequest, { verb: 'frame' }>): void
  occlude(viewId: string): void
  unocclude(viewId: string): void
  focus(viewId: string, revision?: number): void
  focusShell?(revision: number): void
  popup?(request: Extract<NativeViewRequest, { verb: 'popup' }>): void
  popupClose?(requestId: string): void
  /**
   * 键位表 + 菜单表(K4 起是两半)。`menu` 缺席 = 这一帧没说菜单(保留上一份),
   * **不是**「菜单是空的」—— 判词在协议那条动词上。
   */
  keymap(chords: readonly string[], menu?: AppMenuSpec): void
  /** 页内查找(B3-a)。判词在协议那两条上 —— 它是视图状态,不是数据面。 */
  find(request: Extract<NativeViewRequest, { verb: 'find' }>): void
  findStop(viewId: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function viewIdOf(message: Record<string, unknown>): string | undefined {
  const viewId = message.viewId
  return typeof viewId === 'string' && viewId.length > 0 ? viewId : undefined
}

function boundsOf(value: unknown): { x: number; y: number; width: number; height: number } | undefined {
  if (!isRecord(value)) return undefined
  const { x, y, width, height } = value
  if ([x, y, width, height].some(n => typeof n !== 'number' || !Number.isFinite(n))) return undefined
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

/**
 * 解一张菜单表。**载荷不可信**这条法在这里最要紧:这张表要被画成一台真的
 * `Menu`,一格形状不对的项会让 `Menu.buildFromTemplate` 当场抛 —— 抛在主进程里,
 * 而不是抛在发帧那一侧。所以逐格校验,认不出的**整张丢掉**(不是丢掉那一项):
 * 半张菜单比没有菜单更难排查,而「这一帧没说菜单」本来就是合法的一档。
 */
function parseAppMenuSpec(raw: unknown): AppMenuSpec | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.sections)) return undefined
  const sections: AppMenuSpec['sections'][number][] = []
  for (const rawSection of raw.sections) {
    if (!isRecord(rawSection) || typeof rawSection.label !== 'string') return undefined
    if (!Array.isArray(rawSection.items)) return undefined
    const items: AppMenuSpec['sections'][number]['items'][number][] = []
    for (const rawItem of rawSection.items) {
      if (!isRecord(rawItem)) return undefined
      const { id, label, chord } = rawItem
      if (typeof id !== 'string' || !id) return undefined
      if (typeof label !== 'string') return undefined
      if (chord !== null && typeof chord !== 'string') return undefined
      items.push({ id, label, chord, enabled: rawItem.enabled === true })
    }
    sections.push({ label: rawSection.label, items })
  }
  return { sections }
}

/**
 * 解一条帧。**纯函数** —— 于是「拼错的载荷不会让主进程抛」这一条在 vitest 里量得到,
 * 不必起 Electron。认不出来 = `undefined`。
 */
export function parseNativeViewRequest(raw: unknown): NativeViewRequest | undefined {
  if (!isRecord(raw)) return undefined
  switch (raw.verb) {
    case 'frame': {
      const viewId = viewIdOf(raw)
      const bounds = boundsOf(raw.bounds)
      if (!viewId || !bounds) return undefined
      const z = typeof raw.z === 'number' && Number.isFinite(raw.z) ? raw.z : 0
      return { verb: 'frame', viewId, bounds, visible: raw.visible === true, z }
    }
    case 'occlude':
    case 'unocclude':
    case 'findStop': {
      const viewId = viewIdOf(raw)
      return viewId ? { verb: raw.verb, viewId } : undefined
    }
    case 'focus': {
      const viewId = viewIdOf(raw)
      if (!viewId || (raw.revision !== undefined && !isRevision(raw.revision))) return undefined
      return { verb: 'focus', viewId, ...(raw.revision !== undefined ? { revision: raw.revision as number } : {}) }
    }
    case 'focus-shell':
      return isRevision(raw.revision) ? { verb: 'focus-shell', revision: raw.revision } : undefined
    case 'popup-close':
      return isPopupId(raw.requestId) ? { verb: 'popup-close', requestId: raw.requestId } : undefined
    case 'popup': {
      if (!isPopupId(raw.requestId) || typeof raw.x !== 'number' || !Number.isFinite(raw.x)
        || typeof raw.y !== 'number' || !Number.isFinite(raw.y)
        || !Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > 100) return undefined
      const items: NativePopupItem[] = []
      const ids = new Set<string>()
      for (const item of raw.items) {
        if (!isRecord(item)) return undefined
        if (item.type === 'separator') { items.push({ type: 'separator' }); continue }
        if (item.type !== 'item' || !isPopupId(item.id) || ids.has(item.id)
          || typeof item.label !== 'string' || item.label.length > 1024
          || typeof item.enabled !== 'boolean') return undefined
        ids.add(item.id)
        items.push({ type: 'item', id: item.id, label: item.label, enabled: item.enabled })
      }
      return { verb: 'popup', requestId: raw.requestId, x: Math.round(raw.x), y: Math.round(raw.y), items }
    }
    case 'find': {
      const viewId = viewIdOf(raw)
      // 词必须是串;**空串是合法的**(它的意思是「别找了」,由 tab 折成
      // `stopFindInPage`)—— 认不出来的只有「根本不是串」那一种。
      if (!viewId || typeof raw.text !== 'string') return undefined
      return { verb: 'find', viewId, text: raw.text, forward: raw.forward !== false }
    }
    case 'keymap': {
      if (!Array.isArray(raw.chords)) return undefined
      const chords = raw.chords.filter((c): c is string => typeof c === 'string')
      const menu = parseAppMenuSpec(raw.menu)
      return menu ? { verb: 'keymap', chords, menu } : { verb: 'keymap', chords }
    }
    default:
      return undefined
  }
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPopupId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
}

/** 挂上那一条监听。返回退订(`backend.own()` 收)。 */
export function installNativeViewIpc(
  ipcMain: NativeViewIpcMain,
  handlers: NativeViewHandlers,
  accepts: (event: unknown) => boolean = () => true,
): () => void {
  const listener = (_event: unknown, raw: unknown): void => {
    if (!accepts(_event)) return
    const request = parseNativeViewRequest(raw)
    if (!request) return
    switch (request.verb) {
      case 'frame': handlers.frame(request); return
      case 'occlude': handlers.occlude(request.viewId); return
      case 'unocclude': handlers.unocclude(request.viewId); return
      case 'focus':
        if (request.revision === undefined) handlers.focus(request.viewId)
        else handlers.focus(request.viewId, request.revision)
        return
      case 'focus-shell': handlers.focusShell?.(request.revision); return
      case 'popup': handlers.popup?.(request); return
      case 'popup-close': handlers.popupClose?.(request.requestId); return
      case 'keymap': handlers.keymap(request.chords, request.menu); return
      case 'find': handlers.find(request); return
      case 'findStop': handlers.findStop(request.viewId); return
    }
  }
  ipcMain.on(NATIVE_VIEW_CHANNEL, listener)
  // `removeAllListeners` 而不是 `removeListener`:这条通道全进程只有这一个监听
  // (那正是 `transport:gate` 钉着的事),所以「全摘」与「摘我那个」等价,而前者
  // 对「装了两次」也是对的。
  return () => { ipcMain.removeAllListeners(NATIVE_VIEW_CHANNEL) }
}
