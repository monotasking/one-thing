import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class MockBrowserWindow {
    static instances: MockBrowserWindow[] = []

    handlers = new Map<string, (...args: any[]) => void>()
    loadURL = vi.fn()
    loadFile = vi.fn()
    setWindowButtonVisibility = vi.fn()

    constructor(public readonly options: Record<string, unknown>) {
      MockBrowserWindow.instances.push(this)
    }

    once(event: string, handler: (...args: any[]) => void) {
      this.handlers.set(event, handler)
    }

    on(event: string, handler: (...args: any[]) => void) {
      this.handlers.set(event, handler)
    }

    emit(event: string, ...args: any[]) {
      this.handlers.get(event)?.(...args)
    }
  }

  return { MockBrowserWindow }
})

vi.mock('electron', () => ({
  BrowserWindow: mocks.MockBrowserWindow,
  screen: {
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
  },
}))

describe('electron todo plan window', () => {
  beforeEach(() => {
    mocks.MockBrowserWindow.instances = []
  })

  function createOptions(overrides: Record<string, unknown> = {}) {
    return {
      windowState: { width: 460, height: 640, x: 20, y: 30 },
      isDevelopment: true,
      isMac: false,
      backgroundColor: '#181818',
      routeHash: '/todo-plan?theme=dark&colorTheme=blue',
      rendererDevUrl: 'http://127.0.0.1:5173',
      rendererIndexPath: '/dist/renderer/index.html',
      preloadPath: '/dist/preload/index.js',
      onCreated: vi.fn(),
      onReadyToShow: vi.fn(),
      onResize: vi.fn(),
      onMove: vi.fn(),
      onClose: vi.fn(),
      onClosed: vi.fn(),
      ...overrides,
    } as any
  }

  it('creates and loads a development todo plan window', async () => {
    const { createElectronTodoPlanWindow } = await import('../todo-plan-window.js')
    const options = createOptions()

    const todoWindow = createElectronTodoPlanWindow(options) as any

    expect(todoWindow.options).toMatchObject({
      width: 460,
      height: 640,
      x: 20,
      y: 30,
      minWidth: 320,
      minHeight: 280,
      show: false,
      type: undefined,
      focusable: true,
      skipTaskbar: false,
      transparent: false,
      backgroundColor: '#181818',
      titleBarStyle: 'default',
      resizable: true,
      alwaysOnTop: false,
      webPreferences: {
        preload: '/dist/preload/index.js',
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    expect(options.onCreated).toHaveBeenCalledWith(todoWindow)
    // 非 mac 走系统标题栏,交通灯是系统的事,一句都不该发。
    expect(todoWindow.setWindowButtonVisibility).not.toHaveBeenCalled()
    expect(todoWindow.loadURL).toHaveBeenCalledWith('http://127.0.0.1:5173/#/todo-plan?theme=dark&colorTheme=blue')
  })

  it('uses macOS panel window options and production route loading', async () => {
    const { createElectronTodoPlanWindow } = await import('../todo-plan-window.js')
    const options = createOptions({
      isDevelopment: false,
      isMac: true,
      routeHash: '/todo-plan?theme=light&colorTheme=green',
    })

    const todoWindow = createElectronTodoPlanWindow(options) as any

    expect(todoWindow.options).toMatchObject({
      type: 'panel',
      acceptFirstMouse: true,
      skipTaskbar: true,
      transparent: true,
      backgroundColor: undefined,
      titleBarStyle: 'hidden',
    })
    // non-activating NSPanel 永远成不了 main window,系统交通灯只会画成灰点 ——
    // 所以摆位没有意义(这一项已经整条删掉),按钮直接收起来,由渲染层在形态轨顶自绘三枚。
    expect(todoWindow.options).not.toHaveProperty('trafficLightPosition')
    expect(todoWindow.setWindowButtonVisibility).toHaveBeenCalledWith(false)
    expect(todoWindow.loadFile).toHaveBeenCalledWith('/dist/renderer/index.html', {
      hash: '/todo-plan?theme=light&colorTheme=green',
    })
  })

  it('forwards lifecycle events to injected callbacks', async () => {
    const { createElectronTodoPlanWindow } = await import('../todo-plan-window.js')
    const options = createOptions()

    const todoWindow = createElectronTodoPlanWindow(options) as any
    todoWindow.emit('ready-to-show')
    todoWindow.emit('resize')
    todoWindow.emit('move')
    todoWindow.emit('close')
    todoWindow.emit('closed')

    expect(options.onReadyToShow).toHaveBeenCalledWith(todoWindow)
    expect(options.onResize).toHaveBeenCalledWith(todoWindow)
    expect(options.onMove).toHaveBeenCalledWith(todoWindow)
    expect(options.onClose).toHaveBeenCalledWith(todoWindow)
    expect(options.onClosed).toHaveBeenCalledTimes(1)
  })
})
