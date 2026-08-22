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
      settings: {
        get: vi.fn(async () => ({ theme: 'dark' })),
        update: vi.fn(async settings => settings),
      },
      network: {
        testProxy: vi.fn(async proxy => ({ success: true, proxy })),
      },
      search: {
        query: vi.fn(async request => ({ success: true, results: [request] })),
        executeAction: vi.fn(async actionId => ({ success: true, actionId })),
      },
      tools: {
        getTools: vi.fn(async () => ({ success: true, tools: [] })),
        executeTool: vi.fn(async () => ({ success: false, error: 'disabled' })),
      },
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
      plugins: {
        list: vi.fn(async () => ({ success: true, plugins: [] })),
        enable: vi.fn(async pluginId => ({ success: true, pluginId })),
        commands: vi.fn(async () => ({ success: true, commands: [] })),
        executeCommand: vi.fn(async request => ({ success: true, request })),
      },
      // P4c 第七批:六条数据面已迁到 `oauthRouter`,facade 上只剩推送面。
      oauth: {
        subscribe: vi.fn((handler) => {
          handler({ type: 'oauth:token-refreshed', providerId: 'codex' })
          return unsubscribe
        }),
      },
      // P4c 第八批:`gateway` 这一格整只没了 —— 八条走 `gatewayRouter` + 宿主端口。
      voice: {
        getState: vi.fn(async () => ({ success: true, state: { status: 'disabled' } })),
        start: vi.fn(async request => ({ success: false, request, error: 'disabled' })),
        stop: vi.fn(async request => ({ success: true, request })),
        submitUtterance: vi.fn(async request => ({ success: false, request, error: 'disabled' })),
        submitTranscript: vi.fn(async request => ({ success: false, request, error: 'disabled' })),
        synthesize: vi.fn(async request => ({ success: false, request, error: 'disabled' })),
        testASR: vi.fn(async request => ({ success: false, request, error: 'disabled' })),
        testTTS: vi.fn(async request => ({ success: false, request, error: 'disabled' })),
        getTTSModels: vi.fn(async request => ({ success: true, request, models: [] })),
        runtimeReady: vi.fn(async () => ({ success: false, error: 'disabled' })),
        runtimeEvent: vi.fn(async event => ({ success: false, event, error: 'disabled' })),
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
    await expect(runtime.network?.testProxy({ enabled: true, url: 'http://127.0.0.1:7890' })).resolves.toEqual({
      success: true,
      proxy: { enabled: true, url: 'http://127.0.0.1:7890' },
    })
    await expect(runtime.search?.query({ query: 'notes', category: 'all' })).resolves.toEqual({
      success: true,
      results: [{ query: 'notes', category: 'all' }],
    })
    await expect(runtime.search?.executeAction('open-settings')).resolves.toEqual({
      success: true,
      actionId: 'open-settings',
    })
    await expect(runtime.tools?.getTools()).resolves.toEqual({ success: true, tools: [] })
    await expect(runtime.tools?.executeTool('bash', {}, 'message-1', 'session-1')).resolves.toEqual({
      success: false,
      error: 'disabled',
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
    await expect(runtime.plugins?.list?.()).resolves.toEqual({ success: true, plugins: [] })
    await expect(runtime.plugins?.enable?.('demo')).resolves.toEqual({ success: true, pluginId: 'demo' })
    await expect(runtime.plugins?.commands?.()).resolves.toEqual({ success: true, commands: [] })
    await expect(runtime.plugins?.executeCommand?.({ commandName: '/demo', args: 'now', sessionId: 'session-1' })).resolves.toEqual({
      success: true,
      request: { commandName: '/demo', args: 'now', sessionId: 'session-1' },
    })
    const oauthHandler = vi.fn()
    const offOAuth = runtime.oauth?.subscribe(oauthHandler)
    expect(oauthHandler).toHaveBeenCalledWith({ type: 'oauth:token-refreshed', providerId: 'codex' })
    offOAuth?.()
    await expect(runtime.voice?.getState()).resolves.toEqual({ success: true, state: { status: 'disabled' } })
    await expect(runtime.voice?.start({ sessionId: 'session-1' })).resolves.toEqual({
      success: false,
      request: { sessionId: 'session-1' },
      error: 'disabled',
    })
    await expect(runtime.voice?.stop({ reason: 'manual' })).resolves.toEqual({
      success: true,
      request: { reason: 'manual' },
    })
    await expect(runtime.voice?.submitUtterance({ audioBase64: 'a' })).resolves.toMatchObject({ success: false })
    await expect(runtime.voice?.submitTranscript({ text: 'hello' })).resolves.toMatchObject({ success: false })
    await expect(runtime.voice?.synthesize({ text: 'hello' })).resolves.toMatchObject({ success: false })
    await expect(runtime.voice?.testASR({ audioBase64: 'a' })).resolves.toMatchObject({ success: false })
    await expect(runtime.voice?.testTTS({ text: 'hello' })).resolves.toMatchObject({ success: false })
    await expect(runtime.voice?.getTTSModels({ force: true })).resolves.toEqual({
      success: true,
      request: { force: true },
      models: [],
    })
    await expect(runtime.voice?.runtimeReady()).resolves.toEqual({ success: false, error: 'disabled' })
    await expect(runtime.voice?.runtimeEvent({ type: 'runtime-ready' })).resolves.toEqual({
      success: false,
      event: { type: 'runtime-ready' },
      error: 'disabled',
    })
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
    expect(runtime.settings).toBeUndefined()
    expect(runtime.network).toBeUndefined()
    expect(runtime.search).toBeUndefined()
    expect(runtime.streams).toBeUndefined()
    expect(runtime.files).toBeUndefined()
    expect(runtime.media).toBeUndefined()
    expect(runtime.plugins).toBeUndefined()
    expect(runtime.oauth).toBeUndefined()
    expect(runtime.voice).toBeUndefined()
    expect(runtime.tools).toBeUndefined()
  })
})
