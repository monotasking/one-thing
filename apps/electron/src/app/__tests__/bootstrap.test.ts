import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    on: vi.fn(),
    getPath: vi.fn(() => '/tmp/onething'),
    quit: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(() => null),
  },
  dialog: {
    showErrorBox: vi.fn(),
  },
  net: {
    fetch: vi.fn(),
  },
  powerMonitor: {
    on: vi.fn(),
  },
  protocol: {
    handle: vi.fn(),
    registerSchemesAsPrivileged: vi.fn(),
  },
  session: {
    defaultSession: { protocol: { handle: vi.fn() } },
  },
}))

import { registerElectronAppBootstrap } from '../bootstrap.js'

function createFakeApp() {
  const listeners = new Map<string, () => unknown>()
  return {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp/onething'),
    on: vi.fn((event: string, listener: () => unknown) => {
      listeners.set(event, listener)
    }),
    quit: vi.fn(),
    listeners,
  }
}

describe('electron app bootstrap', () => {
  it('centralizes Electron lifecycle registration and runs ready startup in order', async () => {
    const events: string[] = []
    const readyApp = createFakeApp()
    const activateApp = createFakeApp()
    const allClosedApp = createFakeApp()
    const didBecomeActiveApp = createFakeApp()
    const beforeQuitApp = createFakeApp()
    const powerMonitor = { on: vi.fn() }
    const handleProtocol = vi.fn()
    const handlePluginProtocol = vi.fn()
    const deliveredDeepLinks: string[] = []
    const deepLinkApp = {
      setAsDefaultProtocolClient: vi.fn(() => true),
      on: vi.fn(),
    }
    const mainWindow = {
      webContents: {},
      on: vi.fn(),
      isDestroyed: vi.fn(() => false),
    }

    registerElectronAppBootstrap({
      storePathHost: {
        app: readyApp,
        resourcesPath: '/resources',
        configureStorePathHost: host => {
          events.push(`store:${host.resourcesPath}`)
        },
      },
      ready: {
        app: readyApp,
        configureSandboxHost: () => {
          events.push('sandbox')
        },
        hydratePackagedEnvironment: async () => {
          events.push('hydrate')
        },
        acquireDesktopStoreLock: async () => {
          events.push('lock')
        },
        formatDesktopStoreLockError: error => String(error),
      },
      mediaProtocol: {
        getMediaImagesDir: () => '/images',
        handle: handleProtocol,
        fetch: vi.fn(),
      },
      pluginProtocol: {
        resolveStaticRoot: () => null,
        getSession: () => ({ protocol: { handle: handlePluginProtocol } }) as any,
        fetch: vi.fn(),
      },
      // 深链协议(H4)。假 app 只要有 setAsDefaultProtocolClient + on ——
      // 真正的时序断言在 deeplink 自己的测试里,这里只保证接线不漏。
      deepLinkProtocol: {
        deliver: deliveredDeepLinks.push.bind(deliveredDeepLinks),
        app: deepLinkApp,
        logger: { log: vi.fn(), warn: vi.fn() },
      },
      powerResume: {
        powerMonitor,
        getMainWindow: () => mainWindow as any,
        recoverMainWindow: vi.fn(),
      },
      windowAllClosed: {
        app: allClosedApp,
        isVoiceKeepAliveEnabled: () => false,
      },
      didBecomeActive: {
        app: didBecomeActiveApp,
        browserWindow: { getFocusedWindow: vi.fn(() => null) },
        getMainWindow: () => mainWindow as any,
        isTodoPlanWindow: () => false,
        activateMainWindow: vi.fn(),
      },
      beforeQuit: {
        app: beforeQuitApp,
        markVoiceQuitRequested: vi.fn(),
        shutdownVoiceService: vi.fn(),
        shutdownMusicService: vi.fn(),
        unregisterGlobalWindowShortcuts: vi.fn(),
        // A3:网关 / MCP / ACP 三格搬去了 `backend.own(...)`。
        killAllBrowserTabs: vi.fn(),
        disposeBackend: vi.fn(),
        shutdownAppLogging: vi.fn(),
        shutdownPlugins: vi.fn(),
        releaseDesktopStoreLock: vi.fn(),
      },
      createMainWindowOptions: () => ({
        app: activateApp,
        getMainWindow: () => null,
        setMainWindow: () => {
          events.push('set-window')
        },
        shouldSuppressMainWindowActivation: () => false,
        createWindow: () => {
          events.push('create-window')
          return mainWindow as any
        },
        attachVoiceTrayMainWindow: () => {
          events.push('tray')
        },
        registerGlobalWindowShortcuts: () => {
          events.push('shortcuts')
        },
        initializeIPCBridge: () => {
          events.push('ipc-bridge')
        },
        bindStreamEngine: () => {
          events.push('stream-bind')
        },
        shutdownIPCBridge: vi.fn(),
        abortActiveStreams: vi.fn(),
        attachVoiceMainWindow: () => {
          events.push('voice-window')
        },
        warmSearchWindow: vi.fn(),
        warmTodoPlanWindow: vi.fn(),
        activateMainWindow: vi.fn(),
        schedule: vi.fn(),
      }),
      onReady: async () => {
        events.push('on-ready')
      },
      afterMainWindowCreated: async () => {
        events.push('after-window')
      },
      startPostWindowServices: async () => {
        events.push('post-window')
      },
    })

    expect(readyApp.on).toHaveBeenCalledWith('ready', expect.any(Function))
    expect(allClosedApp.on).toHaveBeenCalledWith('window-all-closed', expect.any(Function))
    expect(activateApp.on).toHaveBeenCalledWith('activate', expect.any(Function))
    expect(didBecomeActiveApp.on).toHaveBeenCalledWith('did-become-active', expect.any(Function))
    expect(beforeQuitApp.on).toHaveBeenCalledWith('before-quit', expect.any(Function))

    await readyApp.listeners.get('ready')?.()

    expect(handleProtocol).toHaveBeenCalledWith('media', expect.any(Function))
    // 插件 webview 协议(C 期):handler 挂在 ready 段,scheme 登记在同步段。
    expect(handlePluginProtocol).toHaveBeenCalledWith('onething-plugin', expect.any(Function))
    expect(powerMonitor.on).toHaveBeenCalledWith('resume', expect.any(Function))
    expect(powerMonitor.on).toHaveBeenCalledWith('unlock-screen', expect.any(Function))
    expect(events).toEqual([
      'store:/resources',
      'sandbox',
      'lock',
      'on-ready',
      'create-window',
      'set-window',
      'tray',
      'shortcuts',
      'ipc-bridge',
      'stream-bind',
      'voice-window',
      'after-window',
      'post-window',
    ])
  })
})
