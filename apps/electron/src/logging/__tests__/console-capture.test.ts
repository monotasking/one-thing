import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  app: {
    setAppLogsPath: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  app: mocks.app,
}))

function webContentsMock(id = 7, url = 'app://renderer') {
  const listeners = new Map<string, (...args: any[]) => void>()
  return {
    id,
    getURL: vi.fn(() => url),
    on: vi.fn((event: string, listener: (...args: any[]) => void) => {
      listeners.set(event, listener)
    }),
    emitConsole(event: unknown, legacyLevel = 1, legacyMessage = 'legacy', legacyLine = 12, legacySourceId = 'legacy.ts') {
      listeners.get('console-message')?.(event, legacyLevel, legacyMessage, legacyLine, legacySourceId)
    },
  }
}

describe('electron logging console capture', () => {
  beforeEach(() => {
    mocks.app.setAppLogsPath.mockReset()
    mocks.app.on.mockReset()
    mocks.app.off.mockReset()
  })

  it('sets the Electron app logs path', async () => {
    const { setElectronAppLogsPath } = await import('../console-capture.js')

    setElectronAppLogsPath('/tmp/onething-logs')

    expect(mocks.app.setAppLogsPath).toHaveBeenCalledWith('/tmp/onething-logs')
  })

  it('attaches and detaches the web-contents-created handler', async () => {
    const { createElectronRendererConsoleCapture } = await import('../console-capture.js')
    const log = vi.fn()
    const capture = createElectronRendererConsoleCapture({ log })

    capture.attach()
    capture.detach()

    expect(mocks.app.on).toHaveBeenCalledWith('web-contents-created', expect.any(Function))
    expect(mocks.app.off).toHaveBeenCalledWith('web-contents-created', mocks.app.on.mock.calls[0][1])
  })

  it('logs renderer console messages from modern Electron event details', async () => {
    const { createElectronRendererConsoleCapture } = await import('../console-capture.js')
    const log = vi.fn()
    const capture = createElectronRendererConsoleCapture({ log })
    const webContents = webContentsMock(42, 'app://renderer/#/chat')

    capture.attachWebContentsLogging(webContents)
    webContents.emitConsole({
      level: 'warning',
      message: 'renderer warning',
      lineNumber: 99,
      sourceId: 'Chat.vue',
    })

    expect(log).toHaveBeenCalledWith({
      level: 'warn',
      ns: 'renderer',
      source: 'renderer:42',
      msg: 'renderer warning',
      fields: {
        webContentsId: 42,
        sourceId: 'Chat.vue',
        lineNumber: 99,
        url: 'app://renderer/#/chat',
      },
    })
  })

  it('drops renderer info/debug noise — the fallback only captures warn+ (拍板 C②)', async () => {
    const { createElectronRendererConsoleCapture } = await import('../console-capture.js')
    const log = vi.fn()
    const capture = createElectronRendererConsoleCapture({ log })
    const webContents = webContentsMock(3)

    capture.attachWebContentsLogging(webContents)
    webContents.emitConsole({ level: 'info', message: 'chatty' })
    webContents.emitConsole({ level: 'debug', message: 'chattier' })
    webContents.emitConsole({}, 1, 'legacy info')

    expect(log).not.toHaveBeenCalled()
  })

  it('collapses a multi-line Vue warn into one record with the stack in fields', async () => {
    const { createElectronRendererConsoleCapture } = await import('../console-capture.js')
    const log = vi.fn()
    const capture = createElectronRendererConsoleCapture({ log })
    const webContents = webContentsMock(1)

    capture.attachWebContentsLogging(webContents)
    webContents.emitConsole({
      level: 'warning',
      message: '[Vue warn]: Invalid prop\n  at <Container>\n  at <SplitterPanel>',
    })

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toMatchObject({
      level: 'warn',
      msg: '[Vue warn]: Invalid prop',
      fields: { stack: 'at <Container>\n  at <SplitterPanel>' },
    })
  })

  it('falls back to legacy Electron console-message arguments', async () => {
    const { createElectronRendererConsoleCapture } = await import('../console-capture.js')
    const log = vi.fn()
    const capture = createElectronRendererConsoleCapture({ log })
    const webContents = webContentsMock(8)

    capture.attachWebContentsLogging(webContents)
    webContents.emitConsole({}, 3, 'legacy error', 11, 'legacy.js')

    expect(log).toHaveBeenCalledWith({
      level: 'error',
      ns: 'renderer',
      source: 'renderer:8',
      msg: 'legacy error',
      fields: {
        webContentsId: 8,
        sourceId: 'legacy.js',
        lineNumber: 11,
        url: 'app://renderer',
      },
    })
  })

  it('only attaches each web contents once', async () => {
    const { createElectronRendererConsoleCapture } = await import('../console-capture.js')
    const capture = createElectronRendererConsoleCapture({ log: vi.fn() })
    const webContents = webContentsMock()

    capture.attachWebContentsLogging(webContents)
    capture.attachWebContentsLogging(webContents)

    expect(webContents.on).toHaveBeenCalledTimes(1)
  })
})
