import type { BrowserWindow, WebContents } from 'electron'
import { getLogger } from '@onething/backend/logging/index.js'

const log = getLogger('window')

export type ElectronThemeMode = 'dark' | 'light'

export interface ElectronRendererTargetOptions {
  rendererDevUrl?: string
}

export interface ElectronAppWebContentsOptions extends ElectronRendererTargetOptions {
  isDevelopment: boolean
  rendererIndexPath: string
}

export interface LoadElectronMainWindowContentOptions extends ElectronAppWebContentsOptions {
  mainWindow: BrowserWindow
  themeMode: ElectronThemeMode
  reason?: string
}

const AUXILIARY_HASH_PREFIXES = [
  '#/search',
  '#/settings',
  '#/todo-plan',
  '#/image-preview',
]

export function getElectronRendererDevUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.ELECTRON_RENDERER_URL || 'http://127.0.0.1:5173'
}

export function isElectronRendererWindowUrl(
  url: string,
  options: ElectronRendererTargetOptions = {},
): boolean {
  const devUrl = options.rendererDevUrl || getElectronRendererDevUrl()
  return url.startsWith('file://') || url.startsWith(devUrl)
}

/**
 * 精确判定"这个 `file://` 就是渲染器自己的 index"。
 *
 * `isElectronRendererWindowUrl` 用的是 `startsWith('file://')` —— 那是**窗口
 * 归属**的判据(所有 app 窗口都从同一个 index 加载),拿来当导航放行判据就太宽了:
 * 消息里任何一个 `file://` 锚点都会被当成 app URL 而把整窗导航走。
 * 见 docs/design/message-references-2026-08.md §5。
 */
export function isElectronRendererIndexFileUrl(
  url: string,
  rendererIndexPath: string,
): boolean {
  if (!rendererIndexPath || !url.startsWith('file://')) return false
  let pathname = ''
  try {
    pathname = decodeURIComponent(new URL(url).pathname)
  } catch {
    return false
  }
  // Windows: `file:///C:/…` 的 pathname 带一道多余的前导斜杠。
  if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1)
  const normalize = (value: string) => value.replace(/\\/g, '/')
  return normalize(pathname) === normalize(rendererIndexPath)
}

export function isElectronMainAppWindowUrl(
  url: string,
  options: ElectronRendererTargetOptions = {},
): boolean {
  if (!isElectronRendererWindowUrl(url, options)) return false

  let hash = ''
  try {
    hash = new URL(url).hash
  } catch {
    return false
  }

  return !AUXILIARY_HASH_PREFIXES.some(prefix => hash.startsWith(prefix))
}

export function isElectronAppWebContents(
  webContents: WebContents | null,
  options: ElectronAppWebContentsOptions,
): boolean {
  if (!webContents) return false

  const url = webContents.getURL()
  return options.isDevelopment
    ? url.startsWith(options.rendererDevUrl || getElectronRendererDevUrl())
    : url.startsWith(`file://${options.rendererIndexPath}`)
}

export function loadElectronMainWindowContent(options: LoadElectronMainWindowContentOptions): void {
  const loadPromise = options.isDevelopment
    ? options.mainWindow.loadURL(`${options.rendererDevUrl || getElectronRendererDevUrl()}#theme=${options.themeMode}`)
    : options.mainWindow.loadFile(options.rendererIndexPath, {
      hash: `theme=${options.themeMode}`,
    })

  Promise.resolve(loadPromise).catch((error) => {
    log.error('main window content load failed', { reason: options.reason || 'initial' }, error)
  })
}
