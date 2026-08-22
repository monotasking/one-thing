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

export function configureVoiceHost(ports: VoiceHostPorts): void {
  hostPorts = ports
}

export function getVoiceHostPorts(): VoiceHostPorts {
  return hostPorts
}

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
