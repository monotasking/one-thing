// @vitest-environment happy-dom
/**
 * web 壳的派发表与八个域 —— 结构债 P4 终态批 A1-a。
 *
 * 两件事:表本身的语义(白名单 / never-reject / 未注册回 `no-host-shell`),以及
 * **每个域的答复与迁移前 `platform/web.ts` 里那批桩逐字相同** —— 这批只搬路,
 * 不改行为,文案是那条纪律唯一可验证的抓手。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineRouter } from '@onething/core/ipc'
import { deeplinkRouter } from '@shared/ipc/deeplink.js'
import { dialogRouter } from '@shared/ipc/dialog.js'
import { mediaWindowRouter } from '@shared/ipc/media.js'
import { notifyRouter } from '@shared/ipc/notify.js'
import { searchWindowRouter } from '@shared/ipc/search.js'
import { settingsWindowRouter } from '@shared/ipc/settings.js'
import { todoPlanWindowRouter } from '@shared/ipc/todo-plan.js'
import { windowRouter } from '@shared/ipc/window.js'
import {
  dispatchWebShell,
  hasWebShellDomain,
  registerWebShellDomain,
  registerWebShellDomains,
  resetWebShellRegistryForTests,
  TODO_PLAN_WEB_WINDOW_EVENT,
  WEB_SHELL_MISSING_CODE,
} from '../shell-web'

afterEach(() => {
  resetWebShellRegistryForTests()
})

function call(domain: string, method: string, payload: unknown) {
  return dispatchWebShell({ domain, method, payload })
}

describe('web shell registry', () => {
  it('answers an unregistered domain / method structurally instead of throwing', async () => {
    await expect(call('nope', 'x', {})).resolves.toEqual({
      ok: false,
      error: {
        code: WEB_SHELL_MISSING_CODE,
        message: '"nope" is available on the desktop host only',
      },
    })

    const probe = defineRouter<{ ping: { input: Record<string, never>, output: null } }>('probe', ['ping'])
    registerWebShellDomain(probe, { ping: async () => null })
    await expect(call('probe', 'pong', {})).resolves.toEqual({
      ok: false,
      error: {
        code: WEB_SHELL_MISSING_CODE,
        message: '"probe.pong" is available on the desktop host only',
      },
    })
  })

  it('never rejects: a throwing handler becomes { ok:false } with the message', async () => {
    const probe = defineRouter<{ ping: { input: Record<string, never>, output: null } }>('probe', ['ping'])
    registerWebShellDomain(probe, {
      ping: async () => {
        throw new Error('web handler exploded')
      },
    })
    await expect(call('probe', 'ping', {})).resolves.toEqual({
      ok: false,
      error: { message: 'web handler exploded' },
    })
  })

  it('refuses a duplicate registration', () => {
    const probe = defineRouter<{ ping: { input: Record<string, never>, output: null } }>('probe', ['ping'])
    registerWebShellDomain(probe, { ping: async () => null })
    expect(() => registerWebShellDomain(probe, { ping: async () => null })).toThrow(/already registered/)
  })
})

describe('web shell domains', () => {
  const postJson = vi.fn()
  const emitSearchAction = vi.fn()
  const emitImagePreviewUpdate = vi.fn()

  beforeEach(() => {
    postJson.mockReset()
    emitSearchAction.mockReset()
    emitImagePreviewUpdate.mockReset()
    registerWebShellDomains({ postJson, emitSearchAction, emitImagePreviewUpdate })
  })

  it('registers all eight window domains', () => {
    for (const router of [
      todoPlanWindowRouter,
      searchWindowRouter,
      settingsWindowRouter,
      windowRouter,
      dialogRouter,
      mediaWindowRouter,
      notifyRouter,
      deeplinkRouter,
    ]) {
      expect(hasWebShellDomain(router.domain)).toBe(true)
    }
  })

  it('todo-plan window: open/hide/toggle/pin dispatch the in-page event; the三 window-only verbs report false', async () => {
    const events: Array<{ type: string, detail: unknown }> = []
    const listener = (event: Event) => events.push({
      type: event.type,
      detail: (event as CustomEvent).detail,
    })
    window.addEventListener(TODO_PLAN_WEB_WINDOW_EVENT, listener)

    const request = { activation: 'preserve-current-app' as const }
    await expect(call('todo-plan-window', 'open', request)).resolves.toEqual({ ok: true, data: { success: true } })
    await expect(call('todo-plan-window', 'hide', request)).resolves.toEqual({ ok: true, data: { success: true } })
    await expect(call('todo-plan-window', 'toggle', request)).resolves.toEqual({ ok: true, data: { success: true } })
    await expect(call('todo-plan-window', 'setPinned', { pinned: true }))
      .resolves.toEqual({ ok: true, data: { success: true, pinned: true } })

    window.removeEventListener(TODO_PLAN_WEB_WINDOW_EVENT, listener)
    expect(events.map(event => event.type)).toEqual(Array(4).fill(TODO_PLAN_WEB_WINDOW_EVENT))
    expect(events.map(event => (event.detail as { action: string }).action))
      .toEqual(['open', 'hide', 'toggle', 'pin'])

    for (const method of ['minimize', 'zoom', 'drag']) {
      await expect(call('todo-plan-window', method, {})).resolves.toEqual({ ok: true, data: { success: false } })
    }
  })

  it('search window: the three window verbs answer with the pre-migration sentence, verbatim', async () => {
    for (const [method, legacyName] of [
      ['toggle', 'toggleSearchWindow'],
      ['close', 'closeSearchWindow'],
      ['setAnchor', 'setSearchWindowAnchor'],
    ]) {
      await expect(call('search-window', method, {})).resolves.toEqual({
        ok: true,
        data: {
          success: false,
          error: `Platform method "${legacyName}" is not available in the web host yet.`,
        },
      })
    }
  })

  it('search window: executeAction really posts, and broadcasts the resolved action id', async () => {
    postJson.mockResolvedValue({ success: true, actionId: 'open-file:/tmp/today.md' })
    await expect(call('search-window', 'executeAction', { actionId: 'create-daily-note:x' })).resolves.toEqual({
      ok: true,
      data: { success: true, actionId: 'open-file:/tmp/today.md' },
    })
    expect(postJson).toHaveBeenCalledWith('/api/search/actions', { actionId: 'create-daily-note:x' })
    expect(emitSearchAction).toHaveBeenCalledWith('open-file:/tmp/today.md')
  })

  it('search window: a failed action is not broadcast', async () => {
    postJson.mockResolvedValue({ success: false, error: 'nope' })
    await expect(call('search-window', 'executeAction', { actionId: 'x' })).resolves.toEqual({
      ok: true,
      data: { success: false, error: 'nope' },
    })
    expect(emitSearchAction).not.toHaveBeenCalled()
  })

  it('settings window: opens the in-page settings route instead of a second window', async () => {
    await expect(call('settings-window', 'open', { tab: 'music' })).resolves.toEqual({ ok: true, data: { success: true } })
    expect(window.location.hash).toBe('#/settings?tab=music')
    await call('settings-window', 'open', {})
    expect(window.location.hash).toBe('#/settings')
  })

  it('window / dialog / notify / deeplink answer exactly like the pre-migration stubs', async () => {
    await expect(call('window', 'close', {})).resolves.toEqual({ ok: true, data: { success: false } })
    await expect(call('dialog', 'showOpen', {}))
      .resolves.toEqual({ ok: true, data: { canceled: true, filePaths: [] } })
    await expect(call('notify', 'show', { title: 'a', body: 'b', sessionId: 's' }))
      .resolves.toEqual({ ok: true, data: { success: true } })
    await expect(call('notify', 'setBadge', { hasUnread: true }))
      .resolves.toEqual({ ok: true, data: { success: true } })
    await expect(call('deeplink', 'ready', {})).resolves.toEqual({ ok: true, data: { success: true } })
    await expect(call('deeplink', 'respond', { requestId: 'r1', approved: true })).resolves.toEqual({
      ok: true,
      data: { success: false, error: 'deep links are desktop-only' },
    })
  })

  it('media window: save-as admits it cannot, preview broadcasts in-page, gallery is a local success', async () => {
    await expect(call('media-window', 'saveAs', { filePath: '/a.png' })).resolves.toEqual({
      ok: true,
      data: { success: false, error: 'Saving a copy is not available in the browser.' },
    })
    await expect(call('media-window', 'openPreview', { src: 'blob:x', alt: 'a' }))
      .resolves.toEqual({ ok: true, data: { success: true } })
    expect(emitImagePreviewUpdate).toHaveBeenCalledWith({ mode: 'single', src: 'blob:x', alt: 'a' })
    await expect(call('media-window', 'openGallery', { mediaId: 'm1' }))
      .resolves.toEqual({ ok: true, data: { success: true } })
  })
})
