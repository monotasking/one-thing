import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  shell: {
    openExternal: vi.fn(),
  },
}))

describe('electron external link handling', () => {
  function createWebContents() {
    const handlers = new Map<string, (...args: any[]) => unknown>()
    return {
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler)
      }),
      setWindowOpenHandler: vi.fn((handler: (...args: any[]) => unknown) => {
        handlers.set('window-open', handler)
      }),
      emitWillNavigate: (url: string) => {
        const event = { preventDefault: vi.fn() }
        handlers.get('will-navigate')?.(event, url)
        return event
      },
      openWindow: (url: string) => handlers.get('window-open')?.({ url }),
    } as any
  }

  it('allows app navigation without opening the system browser', async () => {
    const { setupElectronExternalLinkHandling } = await import('../external-links.js')
    const webContents = createWebContents()
    const shell = { openExternal: vi.fn() }

    setupElectronExternalLinkHandling({
      webContents,
      shell,
      isAppUrl: url => url.startsWith('file://'),
      isAppFileUrl: url => url.startsWith('file:///app/index.html'),
    })

    const event = webContents.emitWillNavigate('file:///app/index.html')

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  // docs/design/message-references-2026-08.md §5 主进程兜底
  it('blocks any other file:// navigation and never hands it to the system', async () => {
    const { setupElectronExternalLinkHandling } = await import('../external-links.js')
    const webContents = createWebContents()
    const shell = { openExternal: vi.fn() }

    setupElectronExternalLinkHandling({
      webContents,
      shell,
      isAppUrl: url => url.startsWith('file://'),
      isAppFileUrl: url => url.startsWith('file:///app/index.html'),
    })

    const event = webContents.emitWillNavigate('file:///Users/me/secret.txt')

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('blocks file:// even when no app-index predicate is supplied', async () => {
    const { setupElectronExternalLinkHandling } = await import('../external-links.js')
    const webContents = createWebContents()
    const shell = { openExternal: vi.fn() }

    setupElectronExternalLinkHandling({
      webContents,
      shell,
      isAppUrl: () => true,
    })

    const event = webContents.emitWillNavigate('FILE:///Users/me/secret.txt')

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(shell.openExternal).not.toHaveBeenCalled()
  })

  it('blocks external navigation and opens it in the system browser', async () => {
    const { setupElectronExternalLinkHandling } = await import('../external-links.js')
    const webContents = createWebContents()
    const shell = { openExternal: vi.fn() }

    setupElectronExternalLinkHandling({
      webContents,
      shell,
      isAppUrl: url => url.startsWith('file://'),
    })

    const event = webContents.emitWillNavigate('https://example.com')

    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com')
  })

  it('denies window.open and opens the target externally', async () => {
    const { setupElectronExternalLinkHandling } = await import('../external-links.js')
    const webContents = createWebContents()
    const shell = { openExternal: vi.fn() }

    setupElectronExternalLinkHandling({
      webContents,
      shell,
      isAppUrl: () => true,
    })

    const result = webContents.openWindow('https://example.com/docs')

    expect(result).toEqual({ action: 'deny' })
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/docs')
  })
})
