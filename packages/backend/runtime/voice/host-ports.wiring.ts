/**
 * Host injection points for pushing voice/music payloads to renderer surfaces.
 * The Electron host wires these to BrowserWindow broadcasts and the voice
 * runtime window; headless hosts leave them unset (no-op).
 *
 * Late-bound: consulted per call, so wiring at host startup takes effect even
 * for modules that captured the helpers at import time.
 */

import type { VoiceRuntimeCommand } from '@shared/ipc.js'

export interface VoiceHostMessage {
  channel: string
  payload: unknown
  /** Skip the renderer that originated the message (echo suppression). */
  exceptWebContentsId?: number
}

export interface VoiceHostWebContents {
  id: number
  send(channel: string, payload: unknown): void
}

export interface VoiceHostWindow {
  isDestroyed(): boolean
  webContents: VoiceHostWebContents
}

/** Hidden audio-runtime surface (Electron: an offscreen BrowserWindow). */
export interface VoiceRuntimeWindowPorts {
  ensure?: () => void
  destroy?: () => void
  sendCommand?: (command: VoiceRuntimeCommand) => void
  markReady?: () => void
  isReady?: () => boolean
  flushCommands?: () => void
  /**
   * 运行时窗自己的 webContents(结构债 P4c 第十一批)。
   *
   * `voice.runtimeReady` 从前从手写 IPC 通道的 `event.sender` 取发起窗,用来在
   * `runtime-ready` 事件上做回声抑制(发起的那扇窗不收自己的回声)。十一条数据面
   * 迁到通用 RPC 之后信封里没有「谁在问」这一格 —— 于是改由宿主回答:语音运行时窗
   * 是**唯一**会调 `runtimeReady` 的窗口,宿主自己认得它,抑制口径逐字不变。
   * 未注入(headless / web)= 不抑制,与那些宿主上根本没有运行时窗一致。
   */
  getWebContents?: () => VoiceHostWebContents | null | undefined
}

export interface VoiceHostPorts {
  broadcastMessage?: (message: VoiceHostMessage) => void
  runtimeWindow?: VoiceRuntimeWindowPorts
  updateTray?: () => void
}

let hostPorts: VoiceHostPorts = {}
/**
 * 「宿主到底接没接语音」是**调过没调过 `configureVoiceHost`**,不是「端口对象里
 * 有几个方法」——`{}` 是一个合法的注入(宿主说「我有语音,但这三件推送我不需要」),
 * 而缺省值恰好也是 `{}`,两者只有这一个布尔分得开。
 *
 * 判据不能靠 `getVoiceHostPorts()` 的内容,是因为 `voice` 域要拿它替掉
 * `transport === 'http'`(方案 `docs/design/backend-transport-forks-2026-09.md` §2.2):
 * 那十一条问的是「这台机器上有没有麦克风与那扇运行时窗」,答案由宿主表的
 * `voice: null` 还是 `voice: {…}` 说了算。
 */
let hostConfigured = false

export function configureVoiceHost(ports: VoiceHostPorts): void {
  hostPorts = ports
  hostConfigured = true
}

export function getVoiceHostPorts(): VoiceHostPorts {
  return hostPorts
}

/** 这台宿主有没有语音(窗口 + 托盘)。未注入 = 没有。 */
export function hasVoiceHost(): boolean {
  return hostConfigured
}

/**
 * 还原到**未注入**态(C0 R6 把它从「测试专用」提成正式的还原口:
 * `applyHostPorts` 的还原函数在 `backend.dispose()` 时调它)。
 */
export function resetVoiceHost(): void {
  hostPorts = {}
  hostConfigured = false
}

/** @deprecated 改用 {@link resetVoiceHost}(同一个函数,C0 R6 改名)。 */
export const resetVoiceHostForTests = resetVoiceHost

/** Broadcast to every renderer surface; no-op until the host wires a port. */
export function broadcastVoiceHostMessage(message: VoiceHostMessage): void {
  hostPorts.broadcastMessage?.(message)
}

/** Pure helper: deliver to one window if it is still alive. */
export function sendVoiceHostMessageToWindow(
  window: VoiceHostWindow | null | undefined,
  channel: string,
  payload: unknown,
): boolean {
  if (!window || window.isDestroyed()) return false
  window.webContents.send(channel, payload)
  return true
}
