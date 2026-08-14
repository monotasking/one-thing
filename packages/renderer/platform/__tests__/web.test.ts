import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

describe('createWebPlatformApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('starts with conservative browser-safe capabilities', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()

    expect(api.capabilities).toEqual({
      localFileSystem: false,
      workspaceFileSystem: false,
      nativeWindowControls: false,
      shellTools: false,
      terminal: false,
      embeddedBrowser: false,
      collabRooms: false,
      clipboardWrite: false,
      desktopWindows: false,
      globalMenuEvents: false,
    })
  })

  /**
   * 方案 A(设计文档 §6):插件只在 Electron 桌面宿主执行,配置也只在桌面可编辑。
   * web 端要**读得到、改不了**,而且改不了的时候要说人话。
   */
  it('serves plugin config read-only from the plugin catalog', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      plugins: [{
        id: 'log-monitor',
        configTitle: 'Log monitor',
        configFields: [{
          key: 'retentionDays',
          control: 'number',
          label: 'Log retention (days)',
          required: false,
          defaultValue: 7,
        }],
        configValues: { retentionDays: 7 },
        configUnsupportedReasons: [],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()

    const result = await api.getPluginConfig('log-monitor')
    expect(result).toMatchObject({
      success: true,
      declared: true,
      title: 'Log monitor',
      config: { retentionDays: 7 },
      editable: false,
    })
    expect(result.fields?.[0]).toMatchObject({ key: 'retentionDays', control: 'number' })
    expect(result.readOnlyReason).toContain('desktop host only')
  })

  it('refuses plugin config writes with a readable reason instead of forking the file', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('fetch', vi.fn())

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()

    const result = await api.setPluginConfig('log-monitor', { retentionDays: 1 })
    expect(result.success).toBe(false)
    // server 写 plugin-settings 会与桌面那份文件分叉 —— 那比"不能编辑"糟得多。
    expect(result.error).toContain('desktop host only')
  })

  it('reports an unknown plugin instead of pretending the config is empty', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: true,
      plugins: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })))

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()

    await expect(api.getPluginConfig('ghost')).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('Unknown plugin'),
    })
  })

  it('refreshes capabilities from the server while preserving browser clipboard detection', async () => {
    const writeText = vi.fn()
    vi.stubGlobal('navigator', {
      clipboard: { writeText },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      localFileSystem: false,
      workspaceFileSystem: true,
      nativeWindowControls: false,
      shellTools: false,
      clipboardWrite: false,
      desktopWindows: false,
      globalMenuEvents: false,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()
    const capabilities = await api.getCapabilities()

    expect(fetch).toHaveBeenCalledWith('/api/capabilities', expect.any(Object))
    expect(capabilities).toEqual({
      localFileSystem: false,
      workspaceFileSystem: true,
      nativeWindowControls: false,
      shellTools: false,
      terminal: false,
      embeddedBrowser: false,
      collabRooms: false,
      clipboardWrite: true,
      desktopWindows: false,
      globalMenuEvents: false,
    })
    expect(api.capabilities).toBe(capabilities)
  })

  it('degrades unsupported event hooks to no-op subscriptions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi() as any
    const cleanup = api.onMenuNewChat(() => {})

    expect(cleanup).toEqual(expect.any(Function))
    expect(() => cleanup()).not.toThrow()
  })

  /**
   * Agent 活动快照(D8 观测体系 §3.1)在 web 上是 desktop-only —— 供数在主进程的
   * v3 运行时里,与协调器那扇门同一条边界。
   *
   * 钉的是「**降级成一句明确的失败**」而不是 `undefined`:后者会让调用方在
   * `response.success` 上炸掉,而那个栈离成因很远(渲染层不该知道自己跑在哪个宿主
   * 上,它只该读得懂回答)。
   */
  it('degrades getCollabAgentActivity to an explicit refusal on web', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi, WEB_DESKTOP_ONLY_PLATFORM_METHODS } = await import('../web.js')
    expect(WEB_DESKTOP_ONLY_PLATFORM_METHODS).toContain('getCollabAgentActivity')

    const api = createWebPlatformApi()
    await expect(api.getCollabAgentActivity(['iris'])).resolves.toEqual({
      success: false,
      error: 'Platform method "getCollabAgentActivity" is not available in the web host yet.',
    })
  })

  it('opens settings in the current browser tab', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('window', { location: { hash: '' } })

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()

    await expect(api.openSettingsWindow()).resolves.toEqual({ success: true })
    expect((window as unknown as { location: { hash: string } }).location.hash).toBe('#/settings')
  })

  it('subscribes to generated image media events over SSE', async () => {
    const events: FakeEventSource[] = []
    class FakeEventSource {
      closed = false
      private listeners = new Map<string, Set<(event: { data: string }) => void>>()

      constructor(readonly url: string) {
        events.push(this)
      }

      addEventListener(name: string, listener: (event: { data: string }) => void) {
        const listeners = this.listeners.get(name) ?? new Set()
        listeners.add(listener)
        this.listeners.set(name, listeners)
      }

      removeEventListener(name: string, listener: (event: { data: string }) => void) {
        this.listeners.get(name)?.delete(listener)
      }

      close() {
        this.closed = true
      }

      emit(name: string, payload: unknown) {
        for (const listener of this.listeners.get(name) ?? []) {
          listener({ data: JSON.stringify(payload) })
        }
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()
    const callback = vi.fn()
    const cleanup = api.onImageGenerated(callback)

    expect(events[0]?.url).toBe('/api/media/events')
    events[0]?.emit('media:image-generated', {
      id: 'image-1',
      url: '/api/media/file/image-1.png',
      prompt: 'Image',
    })

    expect(callback).toHaveBeenCalledWith({
      id: 'image-1',
      url: '/api/media/file/image-1.png',
      prompt: 'Image',
    })
    cleanup()
    expect(events[0]?.closed).toBe(true)
  })

  it('subscribes to OAuth token events over SSE', async () => {
    const events: FakeEventSource[] = []
    class FakeEventSource {
      closed = false
      private listeners = new Map<string, Set<(event: { data: string }) => void>>()

      constructor(readonly url: string) {
        events.push(this)
      }

      addEventListener(name: string, listener: (event: { data: string }) => void) {
        const listeners = this.listeners.get(name) ?? new Set()
        listeners.add(listener)
        this.listeners.set(name, listeners)
      }

      removeEventListener(name: string, listener: (event: { data: string }) => void) {
        this.listeners.get(name)?.delete(listener)
      }

      close() {
        this.closed = true
      }

      emit(name: string, payload: unknown) {
        for (const listener of this.listeners.get(name) ?? []) {
          listener({ data: JSON.stringify(payload) })
        }
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()
    const refreshed = vi.fn()
    const expired = vi.fn()
    const offRefreshed = api.onOAuthTokenRefreshed(refreshed)
    const offExpired = api.onOAuthTokenExpired(expired)

    expect(events.map(event => event.url)).toEqual(['/api/oauth/events'])
    events[0]?.emit('oauth:token-refreshed', { providerId: 'codex' })
    events[0]?.emit('oauth:token-expired', { providerId: 'codex', error: 'expired' })

    expect(refreshed).toHaveBeenCalledWith({ providerId: 'codex' })
    expect(expired).toHaveBeenCalledWith({ providerId: 'codex', error: 'expired' })
    offRefreshed()
    expect(events[0]?.closed).toBe(false)
    offExpired()
    expect(events[0]?.closed).toBe(true)
  })

  it('subscribes to voice host events over SSE', async () => {
    const events: FakeEventSource[] = []
    class FakeEventSource {
      closed = false
      private listeners = new Map<string, Set<(event: { data: string }) => void>>()

      constructor(readonly url: string) {
        events.push(this)
      }

      addEventListener(name: string, listener: (event: { data: string }) => void) {
        const listeners = this.listeners.get(name) ?? new Set()
        listeners.add(listener)
        this.listeners.set(name, listeners)
      }

      removeEventListener(name: string, listener: (event: { data: string }) => void) {
        this.listeners.get(name)?.delete(listener)
      }

      close() {
        this.closed = true
      }

      emit(name: string, payload: unknown) {
        for (const listener of this.listeners.get(name) ?? []) {
          listener({ data: JSON.stringify(payload) })
        }
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()
    const voiceEvent = vi.fn()
    const runtimeCommand = vi.fn()
    const offVoiceEvent = api.onVoiceEvent(voiceEvent)
    const offRuntimeCommand = api.onVoiceRuntimeCommand(runtimeCommand)

    expect(events[0]?.url).toBe('/api/voice/events')
    expect(events[1]?.url).toBe('/api/voice/runtime-commands')
    events[0]?.emit('voice:event', { type: 'error', error: 'disabled' })
    events[1]?.emit('voice:runtime-command', { type: 'stop' })

    expect(voiceEvent).toHaveBeenCalledWith({ type: 'error', error: 'disabled' })
    expect(runtimeCommand).toHaveBeenCalledWith({ type: 'stop' })
    offVoiceEvent()
    offRuntimeCommand()
    expect(events[0]?.closed).toBe(true)
    expect(events[1]?.closed).toBe(true)
  })

  it('emits image preview updates after opening a web preview', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      return new Response(JSON.stringify({
        success: true,
        previewId: 'preview-1',
        url,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()
    const callback = vi.fn()
    const cleanup = api.onImagePreviewUpdate(callback)

    await expect(api.openImagePreview('data:image/png;base64,aW1hZ2U=', 'Image')).resolves.toEqual({
      success: true,
      previewId: 'preview-1',
      url: '/api/media/preview/open',
    })

    expect(callback).toHaveBeenCalledWith({
      mode: 'single',
      previewId: 'preview-1',
      src: 'data:image/png;base64,aW1hZ2U=',
      alt: 'Image',
    })
    cleanup()
  })

  it('subscribes to workspace file change events over SSE', async () => {
    const events: FakeEventSource[] = []
    class FakeEventSource {
      closed = false
      private listeners = new Map<string, Set<(event: { data: string }) => void>>()

      constructor(readonly url: string) {
        events.push(this)
      }

      addEventListener(name: string, listener: (event: { data: string }) => void) {
        const listeners = this.listeners.get(name) ?? new Set()
        listeners.add(listener)
        this.listeners.set(name, listeners)
      }

      removeEventListener(name: string, listener: (event: { data: string }) => void) {
        this.listeners.get(name)?.delete(listener)
      }

      close() {
        this.closed = true
      }

      emit(name: string, payload: unknown) {
        for (const listener of this.listeners.get(name) ?? []) {
          listener({ data: JSON.stringify(payload) })
        }
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()
    const callback = vi.fn()
    const cleanup = api.onWorkspaceFileChanged(callback)

    expect(events[0]?.url).toBe('/api/files/watch/events')
    events[0]?.emit('workspace:file-changed', {
      root: '/workspace',
      path: '/workspace/src/a.ts',
      eventType: 'change',
    })

    expect(callback).toHaveBeenCalledWith({
      root: '/workspace',
      path: '/workspace/src/a.ts',
      eventType: 'change',
    })
    cleanup()
    expect(events[0]?.closed).toBe(true)
  })

  it('derives session message change subscriptions from SSE session events', async () => {
    const events: FakeEventSource[] = []
    class FakeEventSource {
      closed = false
      private listeners = new Map<string, Set<(event: { data: string }) => void>>()

      constructor(readonly url: string) {
        events.push(this)
      }

      addEventListener(name: string, listener: (event: { data: string }) => void) {
        const listeners = this.listeners.get(name) ?? new Set()
        listeners.add(listener)
        this.listeners.set(name, listeners)
      }

      removeEventListener(name: string, listener: (event: { data: string }) => void) {
        this.listeners.get(name)?.delete(listener)
      }

      close() {
        this.closed = true
      }

      emit(name: string, payload: unknown) {
        for (const listener of this.listeners.get(name) ?? []) {
          listener({ data: JSON.stringify(payload) })
        }
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()
    const callback = vi.fn()
    const cleanup = api.onSessionMessagesChanged(callback)

    expect(events[0]?.url).toBe('/api/events')
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'message:user-created', message: { id: 'message-1' } },
    })
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'message:updated', messageId: 'message-1' },
    })
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'message:deleted', messageId: 'message-1' },
    })
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'stream:start', messageId: 'message-2' },
    })

    expect(callback).toHaveBeenCalledTimes(3)
    expect(callback).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      action: 'added',
      messageId: 'message-1',
    })
    expect(callback).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      action: 'updated',
      messageId: 'message-1',
    })
    expect(callback).toHaveBeenNthCalledWith(3, {
      sessionId: 'session-1',
      action: 'deleted',
      messageId: 'message-1',
    })

    cleanup()
    expect(events[0]?.closed).toBe(true)
  })

  it('derives step and skill subscriptions from SSE session events', async () => {
    const events: FakeEventSource[] = []
    class FakeEventSource {
      closed = false
      private listeners = new Map<string, Set<(event: { data: string }) => void>>()

      constructor(readonly url: string) {
        events.push(this)
      }

      addEventListener(name: string, listener: (event: { data: string }) => void) {
        const listeners = this.listeners.get(name) ?? new Set()
        listeners.add(listener)
        this.listeners.set(name, listeners)
      }

      removeEventListener(name: string, listener: (event: { data: string }) => void) {
        this.listeners.get(name)?.delete(listener)
      }

      close() {
        this.closed = true
      }

      emit(name: string, payload: unknown) {
        for (const listener of this.listeners.get(name) ?? []) {
          listener({ data: JSON.stringify(payload) })
        }
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()
    const stepAdded = vi.fn()
    const stepUpdated = vi.fn()
    const skillActivated = vi.fn()
    const cleanupStepAdded = api.onStepAdded(stepAdded)
    const cleanupStepUpdated = api.onStepUpdated(stepUpdated)
    const cleanupSkill = api.onSkillActivated(skillActivated)

    expect(events.map(event => event.url)).toEqual(['/api/events'])
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'step:added', step: { id: 'step-1', title: 'Read files', messageId: 'message-1' } },
    })
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'step:updated', stepId: 'step-1', updates: { status: 'completed' } },
    })
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'step:updated', stepId: 123, updates: { status: 'ignored' } },
    })
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'skill:activated', skillName: 'review' },
    })

    expect(stepAdded).toHaveBeenCalledWith({
      sessionId: 'session-1',
      messageId: 'message-1',
      step: { id: 'step-1', title: 'Read files', messageId: 'message-1' },
    })
    expect(stepUpdated).toHaveBeenCalledTimes(1)
    expect(stepUpdated).toHaveBeenCalledWith({
      sessionId: 'session-1',
      messageId: '',
      stepId: 'step-1',
      updates: { status: 'completed' },
    })
    expect(skillActivated).toHaveBeenCalledWith({
      sessionId: 'session-1',
      messageId: '',
      skillName: 'review',
    })

    cleanupStepAdded()
    cleanupStepUpdated()
    cleanupSkill()
    expect(events.every(event => event.closed)).toBe(true)
  })

  it('derives context subscriptions from SSE session events', async () => {
    const events: FakeEventSource[] = []
    class FakeEventSource {
      closed = false
      private listeners = new Map<string, Set<(event: { data: string }) => void>>()

      constructor(readonly url: string) {
        events.push(this)
      }

      addEventListener(name: string, listener: (event: { data: string }) => void) {
        const listeners = this.listeners.get(name) ?? new Set()
        listeners.add(listener)
        this.listeners.set(name, listeners)
      }

      removeEventListener(name: string, listener: (event: { data: string }) => void) {
        this.listeners.get(name)?.delete(listener)
      }

      close() {
        this.closed = true
      }

      emit(name: string, payload: unknown) {
        for (const listener of this.listeners.get(name) ?? []) {
          listener({ data: JSON.stringify(payload) })
        }
      }
    }
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()
    const startedCallback = vi.fn()
    const sizeCallback = vi.fn()
    const compactCallback = vi.fn()
    const cleanupStarted = api.onContextCompactStarted(startedCallback)
    const cleanupSize = api.onContextSizeUpdated(sizeCallback)
    const cleanupCompact = api.onContextCompactCompleted(compactCallback)

    expect(events.map(event => event.url)).toEqual(['/api/events'])
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: {
        type: 'message:created',
        message: {
          content: JSON.stringify({
            type: 'context-compact',
            status: 'compacting',
            compactedMessageCount: 4,
          }),
        },
      },
    })
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: {
        type: 'message:created',
        message: { content: JSON.stringify({ type: 'context-compact', status: 'completed' }) },
      },
    })
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'context:size-updated', contextSize: 1234 },
    })
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'context:size-updated', contextSize: '1234' },
    })
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'context:compact-completed', success: false, error: 'too large' },
    })
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'stream:start' },
    })

    expect(startedCallback).toHaveBeenCalledTimes(1)
    expect(startedCallback).toHaveBeenCalledWith({
      sessionId: 'session-1',
    })
    expect(sizeCallback).toHaveBeenCalledTimes(1)
    expect(sizeCallback).toHaveBeenCalledWith({
      sessionId: 'session-1',
      contextSize: 1234,
    })
    expect(compactCallback).toHaveBeenCalledTimes(1)
    expect(compactCallback).toHaveBeenCalledWith({
      sessionId: 'session-1',
      success: false,
      error: 'too large',
    })

    cleanupStarted()
    cleanupSize()
    expect(events[0]?.closed).toBe(false)
    cleanupCompact()
    expect(events[0]?.closed).toBe(true)
  })

  it('reports unsupported command-style platform methods explicitly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi() as any

    await expect(api.openPath('/tmp/example.txt')).resolves.toEqual({
      success: false,
      error: 'Platform method "openPath" is not available in the web host yet.',
    })
  })

  it('classifies every ElectronAPI method for the web host', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const {
      WEB_UNSUPPORTED_PLATFORM_METHODS,
      createWebPlatformApi,
    } = await import('../web.js')
    const api = createWebPlatformApi() as unknown as Record<string, unknown>
    const electronApiMethods = readElectronApiMethodNames()

    expect(electronApiMethods.filter(method => !(method in api))).toEqual([])
    expect(WEB_UNSUPPORTED_PLATFORM_METHODS.filter(method => !electronApiMethods.includes(method))).toEqual([])
    for (const method of WEB_UNSUPPORTED_PLATFORM_METHODS) {
      expect(api[method]).toEqual(expect.any(Function))
    }
  })

  it('maps todo plan window APIs to web workspace panel events', async () => {
    const dispatchEvent = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('window', { dispatchEvent })

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()

    await expect(api.openTodoPlanWindow({ activation: 'preserve-current-app' })).resolves.toEqual({ success: true })
    await expect(api.hideTodoPlanWindow()).resolves.toEqual({ success: true })
    await expect(api.toggleTodoPlanWindow()).resolves.toEqual({ success: true })
    await expect(api.setTodoPlanWindowPinned(true)).resolves.toEqual({ success: true, pinned: true })

    const events = dispatchEvent.mock.calls.map(([event]) => event as CustomEvent)
    expect(events.map(event => event.type)).toEqual([
      'todo-plan:web-window-action',
      'todo-plan:web-window-action',
      'todo-plan:web-window-action',
      'todo-plan:web-window-action',
    ])
    expect(events.map(event => event.detail)).toEqual([
      { action: 'open', request: { activation: 'preserve-current-app' } },
      { action: 'hide', request: undefined },
      { action: 'toggle', request: undefined },
      { action: 'pin', pinned: true },
    ])
  })

  it('opens external URLs through browser navigation primitives', async () => {
    const open = vi.fn()
    vi.stubGlobal('window', { open })
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()

    await expect(api.openExternal('https://example.com')).resolves.toEqual({ success: true })
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
  })

  it('returns an Electron-compatible canceled result for native file dialogs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()

    await expect(api.showOpenDialog({ properties: ['openDirectory'] })).resolves.toEqual({
      canceled: true,
      filePaths: [],
    })
  })

  it('maps workspace file platform methods to server REST endpoints', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/capabilities') {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ success: true, url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()

    await expect(api.listFiles({ cwd: '/workspace', query: 'src', limit: 5 })).resolves.toEqual({
      success: true,
      url: '/api/files/list',
    })
    await expect(api.listDirs({ basePath: '/workspace', query: 's' })).resolves.toEqual({
      success: true,
      url: '/api/dirs/list',
    })
    await expect(api.readFileContent('/workspace/a.txt', 1024)).resolves.toEqual({
      success: true,
      url: '/api/files/read',
    })
    await expect(api.saveFileContent('/workspace/a.txt', 'hello', 123)).resolves.toEqual({
      success: true,
      url: '/api/files/save',
    })
    await expect(api.rollbackFile({
      filePath: '/workspace/a.txt',
      originalContent: 'before',
      isNew: false,
    })).resolves.toEqual({
      success: true,
      url: '/api/files/rollback',
    })
    await expect(api.watchWorkspace('/workspace')).resolves.toEqual({
      success: true,
      url: '/api/files/watch/start',
    })
    await expect(api.unwatchWorkspace('/workspace')).resolves.toEqual({
      success: true,
      url: '/api/files/watch/stop',
    })
    await expect(api.listDirectory('/workspace')).resolves.toEqual({
      success: true,
      url: '/api/files/list-directory',
    })
    await expect(api.statPath('/workspace/a.txt')).resolves.toEqual({
      success: true,
      url: '/api/files/stat',
    })
    await expect(api.createFile('/workspace/b.txt', 'new')).resolves.toEqual({
      success: true,
      url: '/api/files/create',
    })
    await expect(api.createDirectory('/workspace/src')).resolves.toEqual({
      success: true,
      url: '/api/files/create-directory',
    })
    await expect(api.renamePath('/workspace/b.txt', '/workspace/c.txt')).resolves.toEqual({
      success: true,
      url: '/api/files/rename',
    })
    await expect(api.deletePath('/workspace/c.txt')).resolves.toEqual({
      success: true,
      url: '/api/files/delete',
    })
    await expect(api.listVariables('session-1')).resolves.toEqual({
      success: true,
      url: '/api/variables/list',
    })
    await expect(api.setVariable('session-1', 'topic', 'web runtime', 'Current topic', 'session')).resolves.toEqual({
      success: true,
      url: '/api/variables/set',
    })
    await expect(api.deleteVariable('session-1', 'topic')).resolves.toEqual({
      success: true,
      url: '/api/variables/delete',
    })
    await expect(api.projectDirsList()).resolves.toEqual({
      success: true,
      url: '/api/project-dirs',
    })
    await expect(api.projectDirsGet('/workspace')).resolves.toEqual({
      success: true,
      url: '/api/project-dirs/get',
    })
    await expect(api.projectDirsAdd('/workspace', 'Main project')).resolves.toEqual({
      success: true,
      url: '/api/project-dirs',
    })
    await expect(api.projectDirsUpdate('/workspace', { description: 'Updated' })).resolves.toEqual({
      success: true,
      url: '/api/project-dirs/update',
    })
    await expect(
      api.projectDirsUpdate('/workspace', { paths: ['/workspace', '/workspace-docs'] }),
    ).resolves.toEqual({
      success: true,
      url: '/api/project-dirs/update',
    })
    await expect(api.projectDirsRemove('/workspace')).resolves.toEqual({
      success: true,
      url: '/api/project-dirs/remove',
    })
    await expect(api.saveImage({
      base64: 'aW1hZ2U=',
      prompt: 'Image',
      model: 'local',
      sessionId: 'session-1',
      messageId: 'message-1',
    })).resolves.toEqual({
      success: true,
      url: '/api/media/save-image',
    })
    await expect(api.listMediaAssets({ kind: 'image', search: 'cat' })).resolves.toEqual({
      success: true,
      url: '/api/media/assets?kind=image&search=cat',
    })
    await expect(api.getMediaGallery('asset-1', { kind: 'image' })).resolves.toEqual({
      success: true,
      url: '/api/media/gallery',
    })
    await expect(api.hideMediaAsset('asset-1')).resolves.toEqual({
      success: true,
      url: '/api/media/assets/hide',
    })
    await expect(api.openImagePreview('data:image/png;base64,aW1hZ2U=', 'Image')).resolves.toEqual({
      success: true,
      url: '/api/media/preview/open',
    })
    await expect(api.getImagePreview('preview-1')).resolves.toEqual({
      success: true,
      url: '/api/media/preview/get',
    })
    await expect(api.getActiveStreams()).resolves.toEqual({
      success: true,
      url: '/api/streams/active',
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/files/list', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/files/save', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/files/rollback', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        filePath: '/workspace/a.txt',
        originalContent: 'before',
        isNew: false,
      }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/files/watch/start', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ root: '/workspace' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/files/watch/stop', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ root: '/workspace' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/files/rename', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/variables/set', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/project-dirs/get', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/project-dirs/update', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/media/gallery', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/media/preview/open', expect.objectContaining({
      method: 'POST',
    }))
  })

  it('maps MCP platform methods to server REST endpoints', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/capabilities') {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ success: true, url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()

    await expect(api.mcpGetServers()).resolves.toEqual({ success: true, url: '/api/mcp/servers' })
    await expect(api.mcpAddServer({
      id: 'server-1',
      name: 'Server',
      transport: 'sse',
      enabled: true,
    })).resolves.toEqual({ success: true, url: '/api/mcp/servers' })
    await expect(api.mcpUpdateServer({
      id: 'server-1',
      name: 'Server',
      transport: 'sse',
      enabled: true,
    })).resolves.toEqual({ success: true, url: '/api/mcp/servers/server-1/update' })
    await expect(api.mcpRemoveServer('server-1')).resolves.toEqual({ success: true, url: '/api/mcp/servers/server-1' })
    await expect(api.mcpConnectServer('server-1')).resolves.toEqual({ success: true, url: '/api/mcp/servers/server-1/connect' })
    await expect(api.mcpGetTools()).resolves.toEqual({ success: true, url: '/api/mcp/tools' })

    expect(fetchMock).toHaveBeenCalledWith('/api/mcp/servers/server-1/update', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/mcp/servers/server-1', expect.objectContaining({
      method: 'DELETE',
    }))
  })

  it('maps tool platform methods to server REST endpoints', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/capabilities') {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ success: true, url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()

    await expect(api.getTools()).resolves.toEqual({ success: true, url: '/api/tools' })
    await expect(api.executeTool('bash', { command: 'pwd' }, 'message-1', 'session-1')).resolves.toEqual({
      success: true,
      url: '/api/tools/execute',
    })
    await expect(api.cancelTool('tool-1')).resolves.toEqual({ success: true, url: '/api/tools/cancel' })
    await expect(api.updateToolCall('session-1', 'message-1', 'tool-1', { status: 'cancelled' })).resolves.toEqual({
      success: true,
      url: '/api/tools/update-call',
    })
    await expect(api.listBackgroundJobs({ includeInactive: true })).resolves.toEqual({
      success: true,
      url: '/api/tools/background-jobs?includeInactive=true',
    })
    await expect(api.stopBackgroundJob('job-1')).resolves.toEqual({
      success: true,
      url: '/api/tools/background-jobs/job-1/stop',
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/tools/execute', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/tools/background-jobs?includeInactive=true', expect.any(Object))
  })

  it('maps permission platform methods to server REST endpoints', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/capabilities') {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ success: true, url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()

    await expect(api.getPendingPermissions('session-1')).resolves.toEqual({
      success: true,
      url: '/api/sessions/session-1/permissions/pending',
    })
    await expect(api.clearSessionPermissions('session-1')).resolves.toEqual({
      success: true,
      url: '/api/sessions/session-1/permissions/clear',
    })
  })

  it('maps chat and session message platform methods to server REST endpoints', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/capabilities') {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ success: true, url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()

    await expect(api.getChatHistory('session-1')).resolves.toEqual({
      success: true,
      url: '/api/chat/history',
    })
    await expect(api.generateTitle('Hello from web')).resolves.toEqual({
      success: true,
      url: '/api/chat/title',
    })
    await expect(api.getSessionMessages('session-1')).resolves.toEqual({
      success: true,
      url: '/api/chat/messages',
    })
    await expect(api.getSessionTokenUsage('session-1')).resolves.toEqual({
      success: true,
      url: '/api/chat/token-usage',
    })
    await expect(api.createBranch('session-1', 'message-1')).resolves.toEqual({
      success: true,
      url: '/api/sessions/branch',
    })
    await expect(api.updateSessionPin('session-1', true)).resolves.toEqual({
      success: true,
      url: '/api/chat/update-session-pin',
    })
    await expect(api.updateSessionMaxTokens('session-1', 200000)).resolves.toEqual({
      success: true,
      url: '/api/sessions/session-1/max-tokens',
    })
    await expect(api.addSystemMessage('session-1', {
      id: 'system-1',
      role: 'system',
      content: '{"type":"files-changed"}',
      timestamp: 1,
    })).resolves.toEqual({
      success: true,
      url: '/api/chat/add-system-message',
    })
    await expect(api.removeFilesChangedMessage('session-1')).resolves.toEqual({
      success: true,
      url: '/api/chat/remove-system-marker',
    })
    await expect(api.removeGitStatusMessage('session-1')).resolves.toEqual({
      success: true,
      url: '/api/chat/remove-system-marker',
    })
    await expect(api.removeMessage('session-1', 'message-1')).resolves.toEqual({
      success: true,
      url: '/api/chat/remove-message',
    })
    await expect(api.updateMessageThinkingTime('session-1', 'message-1', 3.5)).resolves.toEqual({
      success: true,
      url: '/api/chat/update-thinking-time',
    })
    await expect(api.resumeAfterToolConfirm('session-1', 'message-1')).resolves.toEqual({
      success: true,
      url: '/api/sessions/session-1/commands',
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/chat/update-session-pin', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/max-tokens', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ maxTokens: 200000 }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/remove-system-marker', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-1', markerType: 'files-changed' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/chat/update-thinking-time', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/commands', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        type: 'command:resume-after-confirm',
        messageId: 'message-1',
      }),
    }))
  })

  it('maps settings and network platform methods to server REST endpoints', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/capabilities') {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ success: true, url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()

    await expect(api.getSettings()).resolves.toEqual({ success: true, url: '/api/settings' })
    await expect(api.saveSettings({ theme: 'dark' } as any)).resolves.toEqual({
      success: true,
      url: '/api/settings',
    })
    await expect(api.testProxy({
      enabled: true,
      url: 'http://127.0.0.1:7890',
      bypassRules: 'localhost',
    })).resolves.toEqual({
      success: true,
      url: '/api/network/test-proxy',
    })

    await expect(api.searchQuery({
      query: 'hello',
      category: 'all',
      limit: 10,
    })).resolves.toEqual({
      success: true,
      url: '/api/search/query',
    })

    const searchAction = vi.fn()
    const unsubscribeSearchAction = api.onSearchAction(searchAction)
    await expect(api.searchExecuteAction('open-settings')).resolves.toEqual({
      success: true,
      url: '/api/search/actions',
    })
    expect(searchAction).toHaveBeenCalledWith('open-settings')
    unsubscribeSearchAction()

    expect(fetchMock).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/network/test-proxy', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        proxy: {
          enabled: true,
          url: 'http://127.0.0.1:7890',
          bypassRules: 'localhost',
        },
      }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/search/query', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        query: 'hello',
        category: 'all',
        limit: 10,
      }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/search/actions', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ actionId: 'open-settings' }),
    }))
  })

  it('maps theme platform methods to server REST endpoints', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === '/api/capabilities') {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ success: true, url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()

    await expect(api.getThemes()).resolves.toEqual({ success: true, url: '/api/themes' })
    await expect(api.getTheme('flexoki')).resolves.toEqual({ success: true, url: '/api/themes/flexoki' })
    await expect(api.applyTheme('flexoki', 'dark')).resolves.toEqual({
      success: true,
      url: '/api/themes/flexoki/apply',
    })
    await expect(api.refreshThemes('/workspace')).resolves.toEqual({
      success: true,
      url: '/api/themes/refresh',
    })
    await expect(api.openThemesFolder()).resolves.toEqual({
      success: true,
      url: '/api/themes/open-folder',
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/themes/flexoki/apply', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/themes/refresh', expect.objectContaining({
      method: 'POST',
    }))
  })

  it('maps prompt and todo-plan platform methods to server REST endpoints', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      // 走了通用 RPC 的域(prompts / goal / todo-plan 数据面)命中这一支:
      // 回的是 RpcResponse 信封,把域名与方法原样送回,好断言路由对不对。
      if (url === '/api/rpc') {
        const request = JSON.parse(String(init?.body ?? '{}'))
        return new Response(JSON.stringify({ ok: true, data: { success: true, rpc: request } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (url === '/api/capabilities') {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ success: true, url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()

    await expect(api.getSystemPromptSnapshot('session-1')).resolves.toEqual({
      success: true,
      url: '/api/sessions/session-1/system-prompt-snapshot',
    })
    // 片段 CRUD 已经不再是五条 REST 路径,而是一条通道上的五个方法。
    await expect(api.listPrompts()).resolves.toEqual({
      success: true,
      rpc: { domain: 'prompts', method: 'list', payload: {} },
    })
    await expect(api.getPrompt({ id: 'prompt-1' })).resolves.toEqual({
      success: true,
      rpc: { domain: 'prompts', method: 'get', payload: { id: 'prompt-1' } },
    })
    await expect(api.createPrompt({ title: 'Reusable', body: 'Use this' })).resolves.toEqual({
      success: true,
      rpc: { domain: 'prompts', method: 'create', payload: { title: 'Reusable', body: 'Use this' } },
    })
    await expect(api.updatePrompt({ id: 'prompt-1', title: 'Updated' })).resolves.toEqual({
      success: true,
      rpc: { domain: 'prompts', method: 'update', payload: { id: 'prompt-1', title: 'Updated' } },
    })
    await expect(api.deletePrompt({ id: 'prompt-1' })).resolves.toEqual({
      success: true,
      rpc: { domain: 'prompts', method: 'delete', payload: { id: 'prompt-1' } },
    })
    // 目标以前在 web 是三个写死的错误桩,现在是真调用。
    await expect(api.goalGet('session-1')).resolves.toEqual({
      success: true,
      rpc: { domain: 'goal', method: 'get', payload: { sessionId: 'session-1' } },
    })
    // todo/plan 只有数据面上了通道;窗口面仍是本地 DOM 事件,不发请求。
    await expect(api.getTodoPlan({ sessionId: 'session-1' })).resolves.toEqual({
      success: true,
      rpc: { domain: 'todo-plan', method: 'get', payload: { sessionId: 'session-1' } },
    })
    await expect(api.revealTodoPlanDirectory()).resolves.toEqual({
      success: true,
      rpc: { domain: 'todo-plan', method: 'revealDirectory', payload: {} },
    })
    await expect(api.getSkills('/workspace')).resolves.toEqual({
      success: true,
      url: '/api/skills?workingDirectory=%2Fworkspace',
    })
    await expect(api.refreshSkills()).resolves.toEqual({
      success: true,
      url: '/api/skills/refresh',
    })
    await expect(api.readSkillFile('user:demo', 'SKILL.md')).resolves.toEqual({
      success: true,
      url: '/api/skills/read-file',
    })
    await expect(api.openSkillDirectory('user:demo')).resolves.toEqual({
      success: true,
      url: '/api/skills/open-directory',
    })
    await expect(api.createSkill('demo', 'Demo skill', 'Use demo.', 'user')).resolves.toEqual({
      success: true,
      url: '/api/skills',
    })
    await expect(api.toggleSkillEnabled('user:demo', false)).resolves.toEqual({
      success: true,
      url: '/api/skills/user%3Ademo/toggle',
    })
    await expect(api.deleteSkill('user:demo')).resolves.toEqual({
      success: true,
      url: '/api/skills/user%3Ademo',
    })
    await expect(api.executeSkill('user:demo', { sessionId: 'session-1', input: 'hi' })).resolves.toEqual({
      success: true,
      url: '/api/skills/execute',
    })
    await expect(api.getPlugins()).resolves.toEqual({
      success: true,
      url: '/api/plugins',
    })
    await expect(api.enablePlugin('note-skills')).resolves.toEqual({
      success: true,
      url: '/api/plugins/enable',
    })
    await expect(api.disablePlugin('note-skills')).resolves.toEqual({
      success: true,
      url: '/api/plugins/disable',
    })
    await expect(api.refreshPlugins()).resolves.toEqual({
      success: true,
      url: '/api/plugins/refresh',
    })
    await expect(api.getPluginCommands()).resolves.toEqual({
      success: true,
      url: '/api/plugins/commands',
    })
    await expect(api.executePluginCommand('/demo', '--fast', 'session-1')).resolves.toEqual({
      success: true,
      url: '/api/plugins/execute-command',
    })
    await expect(api.oauthStart('github-copilot')).resolves.toEqual({
      success: true,
      url: '/api/oauth/start',
    })
    await expect(api.oauthCallback('claude-code', 'code', 'state')).resolves.toEqual({
      success: true,
      url: '/api/oauth/callback',
    })
    await expect(api.oauthDevicePoll('github-copilot', 'flow-1')).resolves.toEqual({
      success: true,
      url: '/api/oauth/device-poll',
    })
    await expect(api.oauthRefresh('github-copilot')).resolves.toEqual({
      success: true,
      url: '/api/oauth/refresh',
    })
    await expect(api.oauthGetStatus('github-copilot')).resolves.toEqual({
      success: true,
      url: '/api/oauth/status',
    })
    await expect(api.oauthLogout('github-copilot')).resolves.toEqual({
      success: true,
      url: '/api/oauth/logout',
    })
    await expect(api.gatewayGetStatus()).resolves.toEqual({
      success: true,
      url: '/api/gateway/status',
    })
    await expect(api.gatewayStart({ channel: 'wechat' })).resolves.toEqual({
      success: true,
      url: '/api/gateway/start',
    })
    await expect(api.gatewayStop()).resolves.toEqual({
      success: true,
      url: '/api/gateway/stop',
    })
    await expect(api.gatewayWechatLogout()).resolves.toEqual({
      success: true,
      url: '/api/gateway/wechat/logout',
    })
    await expect(api.voiceGetState()).resolves.toEqual({
      success: true,
      url: '/api/voice/state',
    })
    await expect(api.voiceStart({ sessionId: 'session-1', reason: 'manual' })).resolves.toEqual({
      success: true,
      url: '/api/voice/start',
    })
    await expect(api.voiceStop({ reason: 'manual', submit: false })).resolves.toEqual({
      success: true,
      url: '/api/voice/stop',
    })
    await expect(api.voiceSubmitUtterance({
      sessionId: 'session-1',
      audioBase64: 'audio',
      mimeType: 'audio/webm',
    })).resolves.toEqual({
      success: true,
      url: '/api/voice/submit-utterance',
    })
    await expect(api.voiceSubmitTranscript({
      sessionId: 'session-1',
      text: 'hello',
      asrProvider: 'openai-transcribe',
      asrModel: 'whisper-1',
    })).resolves.toEqual({
      success: true,
      url: '/api/voice/submit-transcript',
    })
    await expect(api.voiceSynthesize({ text: 'hello' })).resolves.toEqual({
      success: true,
      url: '/api/voice/synthesize',
    })
    await expect(api.voiceTestASR({ audioBase64: 'audio', mimeType: 'audio/webm' })).resolves.toEqual({
      success: true,
      url: '/api/voice/test-asr',
    })
    await expect(api.voiceTestTTS({ text: 'hello' })).resolves.toEqual({
      success: true,
      url: '/api/voice/test-tts',
    })
    await expect(api.voiceGetTTSModels({ force: true })).resolves.toEqual({
      success: true,
      url: '/api/voice/tts-models',
    })
    await expect(api.voiceRuntimeReady()).resolves.toEqual({
      success: true,
      url: '/api/voice/runtime-ready',
    })
    await expect(api.voiceRuntimeEvent({ type: 'runtime-ready' })).resolves.toEqual({
      success: true,
      url: '/api/voice/runtime-event',
    })
    await expect(api.acpGetAgents()).resolves.toEqual({
      success: true,
      url: '/api/acp/agents',
    })
    await expect(api.acpAddAgent({
      id: 'web-acp',
      name: 'Web ACP',
      command: 'web-acp',
      enabled: true,
    })).resolves.toEqual({
      success: true,
      url: '/api/acp/agents',
    })
    await expect(api.acpUpdateAgent({
      id: 'web-acp',
      name: 'Updated ACP',
      command: 'web-acp',
      enabled: true,
    })).resolves.toEqual({
      success: true,
      url: '/api/acp/agents/update',
    })
    await expect(api.acpRemoveAgent('web-acp')).resolves.toEqual({
      success: true,
      url: '/api/acp/agents/remove',
    })
    await expect(api.acpConnectAgent('web-acp')).resolves.toEqual({
      success: true,
      url: '/api/acp/agents/connect',
    })
    await expect(api.acpDisconnectAgent('web-acp')).resolves.toEqual({
      success: true,
      url: '/api/acp/agents/disconnect',
    })
    await expect(api.acpRefreshAgent('web-acp')).resolves.toEqual({
      success: true,
      url: '/api/acp/agents/refresh',
    })
    await expect(api.acpCancelSession('session-1', 'web-acp')).resolves.toEqual({
      success: true,
      url: '/api/acp/sessions/cancel',
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/plugins/execute-command', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ commandName: '/demo', args: '--fast', sessionId: 'session-1' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/oauth/callback', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ providerId: 'claude-code', code: 'code', state: 'state' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/oauth/device-poll', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ providerId: 'github-copilot', flowId: 'flow-1' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/gateway/start', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ channel: 'wechat' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/gateway/stop', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/voice/start', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-1', reason: 'manual' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/voice/submit-transcript', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        sessionId: 'session-1',
        text: 'hello',
        asrProvider: 'openai-transcribe',
        asrModel: 'whisper-1',
      }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/voice/tts-models', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ force: true }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/acp/agents', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        config: {
          id: 'web-acp',
          name: 'Web ACP',
          command: 'web-acp',
          enabled: true,
        },
      }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/acp/agents/update', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        config: {
          id: 'web-acp',
          name: 'Updated ACP',
          command: 'web-acp',
          enabled: true,
        },
      }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/acp/agents/connect', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ agentId: 'web-acp' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/acp/sessions/cancel', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sessionId: 'session-1', agentId: 'web-acp' }),
    }))
    await expect(api.listSchedulerTasks()).resolves.toEqual({
      success: true,
      url: '/api/scheduler/tasks',
    })
    await expect(api.getSchedulerTask({ id: 'task-1' })).resolves.toEqual({
      success: true,
      url: '/api/scheduler/tasks/get',
    })
    await expect(api.runSchedulerTaskNow({ id: 'task-1', force: true })).resolves.toEqual({
      success: true,
      url: '/api/scheduler/tasks/run-now',
    })
    await expect(api.setSchedulerTaskEnabled({ id: 'task-1', enabled: false })).resolves.toEqual({
      success: true,
      url: '/api/scheduler/tasks/enabled',
    })
    await expect(api.createSchedulerTask({
      name: 'Daily check',
      prompt: 'Summarize today',
      agentId: 'default',
      schedule: { kind: 'interval', everyMs: 60000 },
    })).resolves.toEqual({
      success: true,
      url: '/api/scheduler/tasks',
    })
    await expect(api.updateSchedulerTask({ id: 'task-1', name: 'Updated' })).resolves.toEqual({
      success: true,
      url: '/api/scheduler/tasks/update',
    })
    await expect(api.deleteSchedulerTask({ id: 'task-1' })).resolves.toEqual({
      success: true,
      url: '/api/scheduler/tasks/delete',
    })
    await expect(api.listSchedulerRuns({ taskId: 'task-1', limit: 10 })).resolves.toEqual({
      success: true,
      url: '/api/scheduler/runs',
    })
    await expect(api.getSchedulerRun({ taskId: 'task-1', runId: 'run-1' })).resolves.toEqual({
      success: true,
      url: '/api/scheduler/runs/get',
    })
    // agents / providers / models 已迁到通用 RPC 通道(主线 T1 第二批):
    // web 壳上不再有它们的方法,客户端在 platform/{agents,providers,models}-client.ts。

    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/system-prompt-snapshot', expect.any(Object))
    expect(fetchMock).toHaveBeenCalledWith('/api/skills/read-file', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/skills/user%3Ademo', expect.objectContaining({
      method: 'DELETE',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/plugins/enable', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ pluginId: 'note-skills' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/plugins/disable', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ pluginId: 'note-skills' }),
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/plugins/commands', expect.any(Object))
    expect(fetchMock).toHaveBeenCalledWith('/api/scheduler/tasks/update', expect.objectContaining({
      method: 'POST',
    }))
    expect(fetchMock).toHaveBeenCalledWith('/api/scheduler/runs/get', expect.objectContaining({
      method: 'POST',
    }))
  })
})

function readElectronApiMethodNames(): string[] {
  const source = readFileSync(new URL('../../types/index.ts', import.meta.url), 'utf8')
  const interfaceStart = source.indexOf('export interface ElectronAPI')
  if (interfaceStart === -1) throw new Error('ElectronAPI interface not found')

  let depth = 0
  let interfaceEnd = interfaceStart
  for (let index = interfaceStart; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        interfaceEnd = index
        break
      }
    }
  }

  // Top-level members sit at exactly one indent level (one tab or two
  // spaces); deeper-indented lines are parameters of multi-line signatures
  // and must not be picked up as method names.
  return Array.from(
    source.slice(interfaceStart, interfaceEnd).matchAll(/^(?:\t| {2})([A-Za-z_$][\w$]*):/gm),
    match => match[1],
  )
}
