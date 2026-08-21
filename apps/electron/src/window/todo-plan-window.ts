import { BrowserWindow, screen } from 'electron'
import { clampElectronWindowStateToDisplays } from './window-state'
import { getLogger } from '@onething/backend/wiring/logging/index.js'

const log = getLogger('window.todo-plan')

export interface ElectronTodoPlanWindowState {
  width: number
  height: number
  x?: number
  y?: number
}

export interface ElectronTodoPlanWindowOptions {
  windowState: ElectronTodoPlanWindowState
  isDevelopment: boolean
  isMac: boolean
  backgroundColor: string
  routeHash: string
  rendererDevUrl: string
  rendererIndexPath: string
  preloadPath: string
  onCreated?(window: BrowserWindow): void
  onReadyToShow?(window: BrowserWindow): void
  onResize?(window: BrowserWindow): void
  onMove?(window: BrowserWindow): void
  onClose?(window: BrowserWindow): void
  onClosed?(): void
}

export function createElectronTodoPlanWindow(options: ElectronTodoPlanWindowOptions): BrowserWindow {
  const windowState = clampElectronWindowStateToDisplays(
    options.windowState,
    screen.getAllDisplays().map(display => display.workArea),
  )
  const todoPlanWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 320,
    minHeight: 280,
    show: false,
    type: options.isMac ? 'panel' : undefined,
    focusable: true,
    acceptFirstMouse: options.isMac ? true : undefined,
    skipTaskbar: options.isMac,
    transparent: options.isMac,
    backgroundColor: options.isMac ? undefined : options.backgroundColor,
    titleBarStyle: options.isMac ? 'hidden' : 'default',
    resizable: true,
    alwaysOnTop: false,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // macOS:把系统交通灯**收起来**,由渲染层在形态轨顶自绘三枚竖排彩点。
  //
  // 不是审美偏好,是这扇窗的窗型决定的:它是 non-activating NSPanel(见
  // `native/macos-panel/macos_panel.mm` 加的 `NSWindowStyleMaskNonactivatingPanel`
  // 与 `_setPreventsActivation:`),永远不会成为 main window —— 系统交通灯因此
  // 恒定画成失活的灰点,再怎么摆 `trafficLightPosition` 也不会上色。留着一排灰点
  // 比没有更糟,所以隐藏,让设计稿里那三枚点成为真的控件。
  //
  // `setWindowButtonVisibility` 只有 macOS 有,且在 `titleBarStyle: 'customButtonsOnHover'`
  // 下会抛;这里是 `'hidden'`,合法。仍然包一层 —— 这一步失败不该连累开窗。
  if (options.isMac && typeof todoPlanWindow.setWindowButtonVisibility === 'function') {
    try {
      todoPlanWindow.setWindowButtonVisibility(false)
    } catch (error) {
      log.warn('hide native window buttons failed', undefined, error)
    }
  }

  options.onCreated?.(todoPlanWindow)

  todoPlanWindow.once('ready-to-show', () => {
    options.onReadyToShow?.(todoPlanWindow)
  })

  todoPlanWindow.on('resize', () => {
    options.onResize?.(todoPlanWindow)
  })
  todoPlanWindow.on('move', () => {
    options.onMove?.(todoPlanWindow)
  })
  todoPlanWindow.on('close', () => {
    options.onClose?.(todoPlanWindow)
  })
  todoPlanWindow.on('closed', () => {
    options.onClosed?.()
  })

  if (options.isDevelopment) {
    todoPlanWindow.loadURL(`${options.rendererDevUrl}/#${options.routeHash}`)
  } else {
    todoPlanWindow.loadFile(options.rendererIndexPath, {
      hash: options.routeHash,
    })
  }

  return todoPlanWindow
}
