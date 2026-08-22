/**
 * 八个宿主壳域的处理者表 —— 结构债 P4 终态批 A1-a。
 *
 * 每个域钉两件事:**方法集合就是 router 上那几条**(多一条少一条都红),以及
 * 每条**打到注入的操作、回的形状与迁移前那条手写 `ipcMain.handle` 逐字相同**。
 *
 * 这些工厂一行 electron 都不 import,所以这只文件不需要跑起一个 Electron。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deeplinkRouter } from '@shared/ipc/deeplink.js'
import { dialogRouter } from '@shared/ipc/dialog.js'
import { mediaWindowRouter } from '@shared/ipc/media.js'
import { notifyRouter } from '@shared/ipc/notify.js'
import { searchWindowRouter } from '@shared/ipc/search.js'
import { settingsWindowRouter } from '@shared/ipc/settings.js'
import { todoPlanWindowRouter } from '@shared/ipc/todo-plan.js'
import { windowRouter } from '@shared/ipc/window.js'
import { dispatchShell, resetShellRegistryForTests } from '../shell-registry.js'
import { registerTodoPlanWindowShellDomain } from '../shell/todo-plan-window.js'
import { registerSearchWindowShellDomain } from '../shell/search-window.js'
import { registerSettingsWindowShellDomain } from '../shell/settings-window.js'
import { registerWindowShellDomain } from '../shell/window.js'
import { registerDialogShellDomain } from '../shell/dialog.js'
import { registerMediaWindowShellDomain } from '../shell/media-window.js'
import { registerNotifyShellDomain } from '../shell/notify.js'
import { registerDeeplinkShellDomain } from '../shell/deeplink.js'

afterEach(() => {
  resetShellRegistryForTests()
})

function call(domain: string, method: string, payload: unknown, callerId?: number) {
  return dispatchShell({ domain, method, payload }, callerId === undefined ? {} : { callerId })
}

describe('todo-plan-window shell domain', () => {
  const operations = () => ({
    open: vi.fn(() => ({ success: true })),
    hide: vi.fn(() => ({ success: true })),
    toggle: vi.fn(() => ({ success: true })),
    setPinned: vi.fn(() => ({ success: true, pinned: true })),
    minimize: vi.fn(() => ({ success: true })),
    zoom: vi.fn(() => ({ success: true })),
    drag: vi.fn(() => ({ success: true })),
  })

  it('exposes exactly the seven window verbs — the data plane stays on rpc:invoke', () => {
    expect([...todoPlanWindowRouter.methods]).toEqual([
      'open', 'hide', 'toggle', 'setPinned', 'minimize', 'zoom', 'drag',
    ])
  })

  it('forwards each verb to its window action with the request verbatim', async () => {
    const ops = operations()
    registerTodoPlanWindowShellDomain(ops)
    const request = { activation: 'preserve-current-app' as const }

    await expect(call('todo-plan-window', 'open', request)).resolves.toEqual({ ok: true, data: { success: true } })
    await expect(call('todo-plan-window', 'hide', request)).resolves.toEqual({ ok: true, data: { success: true } })
    await expect(call('todo-plan-window', 'toggle', request)).resolves.toEqual({ ok: true, data: { success: true } })
    await expect(call('todo-plan-window', 'setPinned', { pinned: true }))
      .resolves.toEqual({ ok: true, data: { success: true, pinned: true } })
    await expect(call('todo-plan-window', 'minimize', {})).resolves.toEqual({ ok: true, data: { success: true } })
    await expect(call('todo-plan-window', 'zoom', {})).resolves.toEqual({ ok: true, data: { success: true } })
    await expect(call('todo-plan-window', 'drag', { phase: 'move', dx: 12, dy: -4 }))
      .resolves.toEqual({ ok: true, data: { success: true } })

    expect(ops.open).toHaveBeenCalledWith(request)
    expect(ops.hide).toHaveBeenCalledWith(request)
    expect(ops.toggle).toHaveBeenCalledWith(request)
    expect(ops.setPinned).toHaveBeenCalledWith({ pinned: true })
    expect(ops.drag).toHaveBeenCalledWith({ phase: 'move', dx: 12, dy: -4 })
  })

  it('treats a missing action request as the empty one (旧 handler 的 `request?` 语义)', async () => {
    const ops = operations()
    registerTodoPlanWindowShellDomain(ops)
    await call('todo-plan-window', 'open', undefined)
    expect(ops.open).toHaveBeenCalledWith({})
  })
})

describe('search-window shell domain', () => {
  it('exposes the four window verbs — `search:query` is data plane and is not here', () => {
    expect([...searchWindowRouter.methods]).toEqual(['toggle', 'close', 'setAnchor', 'executeAction'])
  })

  it('resolves the source window from callerId, never from the payload', async () => {
    const sourceWindow = { id: 'main' }
    const resolveWindow = vi.fn(() => sourceWindow)
    const toggle = vi.fn(() => ({ success: true }))
    const executeAction = vi.fn(async () => ({ success: true, actionId: 'open-file:/tmp/a.md' }))
    registerSearchWindowShellDomain<typeof sourceWindow>({
      resolveWindow,
      toggle,
      close: () => ({ success: true }),
      setAnchor: () => ({ success: true }),
      executeAction,
    })

    const openOptions = { intent: { type: 'split-panel' as const, panelId: 'main' } }
    await expect(call('search-window', 'toggle', openOptions, 7))
      .resolves.toEqual({ ok: true, data: { success: true } })
    expect(resolveWindow).toHaveBeenCalledWith({ callerId: 7 })
    expect(toggle).toHaveBeenCalledWith(sourceWindow, openOptions)

    await expect(call('search-window', 'executeAction', { actionId: 'open-settings' }, 7))
      .resolves.toEqual({ ok: true, data: { success: true, actionId: 'open-file:/tmp/a.md' } })
    expect(executeAction).toHaveBeenCalledWith(sourceWindow, 'open-settings')
  })

  it('passes the anchor through, including the explicit null that means "no anchor"', async () => {
    const setAnchor = vi.fn(() => ({ success: true }))
    registerSearchWindowShellDomain({
      resolveWindow: () => null,
      toggle: () => ({ success: true }),
      close: () => ({ success: true }),
      setAnchor,
      executeAction: () => ({ success: true }),
    })
    const anchor = { x: 240, y: 0, width: 960, height: 800 }
    await call('search-window', 'setAnchor', { anchor })
    expect(setAnchor).toHaveBeenCalledWith({ anchor })
    await call('search-window', 'setAnchor', { anchor: null })
    expect(setAnchor).toHaveBeenLastCalledWith({ anchor: null })
  })
})

describe('settings-window shell domain', () => {
  it('opens the settings window with the requested tab, and with none when unspecified', async () => {
    const open = vi.fn(() => ({ success: true }))
    registerSettingsWindowShellDomain({ open })
    expect([...settingsWindowRouter.methods]).toEqual(['open'])

    await expect(call('settings-window', 'open', { tab: 'music' }))
      .resolves.toEqual({ ok: true, data: { success: true } })
    expect(open).toHaveBeenCalledWith({ tab: 'music' })

    await call('settings-window', 'open', undefined)
    expect(open).toHaveBeenLastCalledWith({})
  })
})

describe('window shell domain', () => {
  it('closes the caller window by the host-minted callerId', async () => {
    const closeCallerWindow = vi.fn(() => true)
    registerWindowShellDomain({ closeCallerWindow })
    expect([...windowRouter.methods]).toEqual(['close'])

    await expect(call('window', 'close', {}, 12)).resolves.toEqual({ ok: true, data: { success: true } })
    expect(closeCallerWindow).toHaveBeenCalledWith(12)
  })

  it('reports failure when there is no caller window (旧 handler 的 `{ success:false }`)', async () => {
    registerWindowShellDomain({ closeCallerWindow: () => false })
    await expect(call('window', 'close', {})).resolves.toEqual({ ok: true, data: { success: false } })
  })
})

describe('dialog shell domain', () => {
  it('passes the dialog options through unchanged and returns the native result', async () => {
    const showOpen = vi.fn(async () => ({ canceled: false, filePaths: ['/tmp'] }))
    registerDialogShellDomain({ showOpen })
    expect([...dialogRouter.methods]).toEqual(['showOpen'])

    const options = { properties: ['openDirectory' as const], title: '选择保存位置' }
    await expect(call('dialog', 'showOpen', options))
      .resolves.toEqual({ ok: true, data: { canceled: false, filePaths: ['/tmp'] } })
    expect(showOpen).toHaveBeenCalledWith(options)
  })
})

describe('media-window shell domain', () => {
  it('forwards the three host-residual media calls verbatim', async () => {
    const saveAs = vi.fn(async () => ({ success: true, path: '/tmp/copy.png' }))
    const openPreview = vi.fn(async () => ({ success: true, previewId: 'preview-1' }))
    const openGallery = vi.fn(async () => ({ success: true }))
    registerMediaWindowShellDomain({ saveAs, openPreview, openGallery })
    expect([...mediaWindowRouter.methods]).toEqual(['saveAs', 'openPreview', 'openGallery'])

    const saveAsRequest = { filePath: '/tmp/a.png', fileName: 'a.png' }
    await expect(call('media-window', 'saveAs', saveAsRequest))
      .resolves.toEqual({ ok: true, data: { success: true, path: '/tmp/copy.png' } })
    await expect(call('media-window', 'openPreview', { src: 'media://asset-1', alt: 'asset' }))
      .resolves.toEqual({ ok: true, data: { success: true, previewId: 'preview-1' } })
    await expect(call('media-window', 'openGallery', { mediaId: 'asset-1' }))
      .resolves.toEqual({ ok: true, data: { success: true } })

    expect(saveAs).toHaveBeenCalledWith(saveAsRequest)
    expect(openPreview).toHaveBeenCalledWith({ src: 'media://asset-1', alt: 'asset' })
    expect(openGallery).toHaveBeenCalledWith({ mediaId: 'asset-1' })
  })
})

describe('notify shell domain', () => {
  it('hands the caller window id to `show` so the click can wake the right window', async () => {
    const show = vi.fn(async () => ({ success: true }))
    const setBadge = vi.fn(async () => ({ success: true }))
    registerNotifyShellDomain({ show, setBadge })
    expect([...notifyRouter.methods]).toEqual(['show', 'setBadge'])

    const request = { title: '小李', body: 'hi', sessionId: 's1' }
    await expect(call('notify', 'show', request, 3)).resolves.toEqual({ ok: true, data: { success: true } })
    expect(show).toHaveBeenCalledWith(request, 3)

    await expect(call('notify', 'setBadge', { hasUnread: true }))
      .resolves.toEqual({ ok: true, data: { success: true } })
    expect(setBadge).toHaveBeenCalledWith({ hasUnread: true })
  })
})

describe('deeplink shell domain', () => {
  it('releases the cold-start queue and dispatches a response', async () => {
    const markReady = vi.fn()
    const respond = vi.fn(async () => ({ success: true, dispatched: true }))
    registerDeeplinkShellDomain({ markReady, respond })
    expect([...deeplinkRouter.methods]).toEqual(['ready', 'respond'])

    await expect(call('deeplink', 'ready', {})).resolves.toEqual({ ok: true, data: { success: true } })
    expect(markReady).toHaveBeenCalledTimes(1)

    const request = { requestId: 'r1', approved: true }
    await expect(call('deeplink', 'respond', request))
      .resolves.toEqual({ ok: true, data: { success: true, dispatched: true } })
    expect(respond).toHaveBeenCalledWith(request)
  })

  it('turns an unexpected dispatch throw into a sentence the card can show', async () => {
    registerDeeplinkShellDomain({
      markReady: vi.fn(),
      respond: async () => {
        throw new Error('dispatcher blew up')
      },
    })
    await expect(call('deeplink', 'respond', { requestId: 'r1', approved: true })).resolves.toEqual({
      ok: true,
      data: { success: false, error: 'dispatcher blew up' },
    })
  })
})
