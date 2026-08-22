import { describe, expect, it, vi } from 'vitest'
import { createOnethingRuntimeFacade } from '../runtime-facade.js'

describe('createOnethingRuntimeFacade', () => {
  it('routes host calls through the supplied adapters', async () => {
    const unsubscribe = vi.fn()
    const eventHandler = vi.fn()
    const shutdown = vi.fn()
    const runtime = createOnethingRuntimeFacade({
      capabilities: {
        get: vi.fn(async () => ({
          localFileSystem: false,
          workspaceFileSystem: false,
          nativeWindowControls: false,
          shellTools: false,
          clipboardWrite: false,
          desktopWindows: false,
          globalMenuEvents: false,
        })),
      },
      appState: {
        get: vi.fn(async () => ({ currentSessionId: 'session-1' })),
      },
      sessions: {
        list: vi.fn(async () => [{ id: 'session-1' }]),
        create: vi.fn(async (name: string) => ({ id: 'session-2', name })),
      },
      events: {
        subscribe: vi.fn((_sessionId, handler, _options) => {
          handler({
            sessionId: 'session-1',
            sequence: 4,
            event: { type: 'stream:start' },
          })
          return unsubscribe
        }),
      },
      permissions: {
        respond: vi.fn(async () => ({ success: true })),
      },
      // P4c 第十一批:`settings` / `network` 两格整只没了 —— 四条走 `settingsRouter`。
      search: {
        query: vi.fn(async request => ({ success: true, results: [request] })),
        executeAction: vi.fn(async actionId => ({ success: true, actionId })),
      },
      // P4c 第九批:七条数据面已迁 `toolsRouter`,facade 上不再有 tools 这一格。
      // P4c 第八批:十四条数据面已迁 `filesRouter`,facade 上只剩订阅面。
      files: {
        subscribeWorkspaceFileChanged: vi.fn((handler) => {
          handler({ root: '/workspace', path: '/workspace/a.txt', eventType: 'change' })
          return unsubscribe
        }),
      },
      media: {
        subscribeImageGenerated: vi.fn((handler) => {
          handler({ id: 'image-1' })
          return unsubscribe
        }),
      },
      // P4 终态批 C2:`plugins` adapter 整只没了 —— 六条读/开关面随 `pluginsRouter`
      // 走通用 RPC,server 那本只读镜像目录改由 `@onething/backend/server/plugin-catalog.ts`
      // 的单槽端口交给域。
      // P4c 第七批:六条数据面已迁到 `oauthRouter`,facade 上只剩推送面。
      oauth: {
        subscribe: vi.fn((handler) => {
          handler({ type: 'oauth:token-refreshed', providerId: 'codex' })
          return unsubscribe
        }),
      },
      // P4c 第八批:`gateway` 这一格整只没了 —— 八条走 `gatewayRouter` + 宿主端口。
      // P4c 第十一批:十一条数据面走 `voiceRouter`,adapter 上只剩两条推送的订阅面。
      voice: {
        subscribeEvents: vi.fn((handler) => {
          handler({ type: 'state' })
          return unsubscribe
        }),
        subscribeRuntimeCommands: vi.fn((handler) => {
          handler({ type: 'stop' })
          return unsubscribe
        }),
      },
      shutdown,
    })

    await expect(runtime.capabilities?.get()).resolves.toEqual({
      localFileSystem: false,
      workspaceFileSystem: false,
      nativeWindowControls: false,
      shellTools: false,
      clipboardWrite: false,
      desktopWindows: false,
      globalMenuEvents: false,
    })
    await expect(runtime.appState?.get()).resolves.toEqual({ currentSessionId: 'session-1' })
    await expect(runtime.sessions.list()).resolves.toEqual([{ id: 'session-1' }])
    await expect(runtime.sessions.create('New Chat')).resolves.toEqual({ id: 'session-2', name: 'New Chat' })
    await expect(runtime.search?.query({ query: 'notes', category: 'all' })).resolves.toEqual({
      success: true,
      results: [{ query: 'notes', category: 'all' }],
    })
    await expect(runtime.search?.executeAction('open-settings')).resolves.toEqual({
      success: true,
      actionId: 'open-settings',
    })
    const offWorkspace = runtime.files?.subscribeWorkspaceFileChanged?.(eventHandler)
    expect(eventHandler).toHaveBeenCalledWith({
      root: '/workspace',
      path: '/workspace/a.txt',
      eventType: 'change',
    })
    offWorkspace?.()
    const offMedia = runtime.media?.subscribeImageGenerated?.(eventHandler)
    expect(eventHandler).toHaveBeenCalledWith({ id: 'image-1' })
    offMedia?.()
    const oauthHandler = vi.fn()
    const offOAuth = runtime.oauth?.subscribe(oauthHandler)
    expect(oauthHandler).toHaveBeenCalledWith({ type: 'oauth:token-refreshed', providerId: 'codex' })
    offOAuth?.()
    const voiceEventHandler = vi.fn()
    const offVoice = runtime.voice?.subscribeEvents?.(voiceEventHandler)
    expect(voiceEventHandler).toHaveBeenCalledWith({ type: 'state' })
    offVoice?.()
    const voiceCommandHandler = vi.fn()
    const offVoiceCommand = runtime.voice?.subscribeRuntimeCommands?.(voiceCommandHandler)
    expect(voiceCommandHandler).toHaveBeenCalledWith({ type: 'stop' })
    offVoiceCommand?.()

    const off = runtime.events.subscribe('session-1', eventHandler, { afterSeq: 3 })
    expect(eventHandler).toHaveBeenCalledWith({
      sessionId: 'session-1',
      sequence: 4,
      event: { type: 'stream:start' },
    })
    off()
    expect(unsubscribe).toHaveBeenCalled()

    await runtime.shutdown()
    expect(shutdown).toHaveBeenCalled()
  })

  it('keeps optional host domains absent until an adapter is provided', () => {
    const runtime = createOnethingRuntimeFacade({
      sessions: {
        list: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: 'session-1' })),
      },
      events: {
        subscribe: vi.fn(() => () => {}),
      },
    })

    expect(runtime.capabilities).toBeUndefined()
    expect(runtime.appState).toBeUndefined()
    expect(runtime.permissions).toBeUndefined()
    expect(runtime.search).toBeUndefined()
    expect(runtime.streams).toBeUndefined()
    expect(runtime.files).toBeUndefined()
    expect(runtime.media).toBeUndefined()
    expect(runtime.oauth).toBeUndefined()
    expect(runtime.voice).toBeUndefined()
  })
})
