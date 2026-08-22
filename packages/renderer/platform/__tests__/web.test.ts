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
      collabRooms: true,
      music: true,
      interactionRespond: true,
      evals: true,
      // P4 终态批 C2(#16):插件写面在 web 上默认关。
      pluginsManage: false,
      clipboardWrite: false,
      desktopWindows: false,
      globalMenuEvents: false,
    })
  })

  // 方案 A(设计文档 §6)下「web 读得到、改不了」那三条已随 P4 终态批 C2 搬走:
  // 只读配置的派生进了 `backend/rpc/domains/plugins.ts` 的 http 分支
  // (`plugins-domain.test.ts` 覆盖),写面的拒绝进了 `platform/plugins-client.ts`
  // 的能力位分支(`plugins-client.test.ts` 覆盖)。web 壳上不再有它们。

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
      // 服务器这只响应里没有这四个键 —— 没表态就用渲染侧的默认(P4 终态批 B 起
      // 是 true)。`collabRooms` 是唯一真的会被宿主按下去的那一颗,见下方用例。
      collabRooms: true,
      music: true,
      interactionRespond: true,
      evals: true,
      pluginsManage: false,
      clipboardWrite: true,
      desktopWindows: false,
      globalMenuEvents: false,
    })
    expect(api.capabilities).toBe(capabilities)
  })

  /**
   * P4 终态批 B(拍板 #12):`collabRooms` 的静态默认翻成 true,但**服务器是权威**
   * —— 独立 `server:start` 进程里没有 collab v3 的 actor,它下发 false,浏览器那
   * 一侧就得跟着关。钉的是「宿主说了算」这条,不是某个具体值。
   */
  it('lets the server shut collabRooms back off when it has no room runtime', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      localFileSystem: false,
      workspaceFileSystem: true,
      nativeWindowControls: false,
      shellTools: false,
      clipboardWrite: false,
      desktopWindows: false,
      globalMenuEvents: false,
      collabRooms: false,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))

    const { createWebPlatformApi } = await import('../web.js')
    const capabilities = await createWebPlatformApi().getCapabilities()

    expect(capabilities.collabRooms).toBe(false)
    // 其余三颗这只响应没提,默认照旧
    expect(capabilities.music).toBe(true)
    expect(capabilities.interactionRespond).toBe(true)
    expect(capabilities.evals).toBe(true)
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
   * collab 域整只迁到通用 RPC 通道之后(P4a),web 上不再有那批说谎的桩 ——
   * 十五条走的是同一条 `POST /api/rpc`,拿到的就是桌面那台引擎的房间。
   *
   * P4 终态批 B(拍板 #12)把能力位一起放开:默认 true,由服务器按进程内跑没跑
   * collab v3 运行时决定关不关(上一条用例钉的就是那条否决权)。这里钉的是
   * **没有第二条通道**:名单里一条 collab 方法都不该再有,能力位是唯一的闸。
   */
  it('gates collab on web through the capability alone, with no stubs left', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi, WEB_DESKTOP_ONLY_PLATFORM_METHODS } = await import('../web.js')
    // 名单里一条 collab 方法都不该再有(它们随 platformApi 上的方法一起消失)。
    expect(WEB_DESKTOP_ONLY_PLATFORM_METHODS.filter(name => name.includes('Collab'))).toEqual([])

    const api = createWebPlatformApi()
    expect(api.capabilities.collabRooms).toBe(true)
  })

  /**
   * music / interaction / evals 迁到通用 RPC 通道之后(P4c 第九批 / 第十批),
   * web 上同样不再有桩 —— 十四条 + 两条 + 二十五条走的是同一条 `POST /api/rpc`,
   * 技术上真能驱动桌面那台后端。
   *
   * P4 终态批 B(拍板 #13 / #15 / #17)把三颗一起放开:谁在服务这个 store,谁的
   * 机器就是那台放音机(桌面就是本机);提问应答盖的章由宿主从内核活账里读、
   * 不从请求体里读;评估面按 wire 路径读盘的四条在 http 上夹进 evals 自己那两棵
   * 树。这里钉的是**闸只有能力位一道** —— 名单里一条桩都不该再有。
   */
  it('gates music, interaction and evals on web through capabilities alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi, WEB_DESKTOP_ONLY_PLATFORM_METHODS } = await import('../web.js')
    // 名单里一条都不该再有(它们随 platformApi 上的方法一起消失)。
    expect(
      WEB_DESKTOP_ONLY_PLATFORM_METHODS.filter(name => name.includes('Interaction')),
    ).toEqual([])
    expect(WEB_DESKTOP_ONLY_PLATFORM_METHODS.filter(name => name.startsWith('music'))).toEqual([])

    expect(WEB_DESKTOP_ONLY_PLATFORM_METHODS.filter(name => name.startsWith('evals'))).toEqual([])

    const api = createWebPlatformApi()
    expect(api.capabilities.music).toBe(true)
    expect(api.capabilities.interactionRespond).toBe(true)
    expect(api.capabilities.evals).toBe(true)
  })

  /**
   * terminal 的七条请求面迁到通用 RPC 通道之后(P4 终态批 D2),web 壳上不再有
   * 它们的「不支持」桩 —— 但**能力位按用户拍板保持默认关**,而且真正的闸落在
   * **服务端**:`backend/rpc/domains/terminal.ts` 在 `transport === 'http'` 上
   * 七条一律结构化拒绝(桌面自己也挂着同一份 HTTP 面,渲染侧的位挡不住拿到
   * Bearer 的浏览器)。这里钉三件事:名单里请求面清零、两条推送仍在名单里、
   * 能力位仍是 false。
   */
  it('drops the terminal request stubs but keeps the capability off on web', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('server unavailable')
    }))
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi, WEB_DESKTOP_ONLY_PLATFORM_METHODS } = await import('../web.js')
    expect(WEB_DESKTOP_ONLY_PLATFORM_METHODS.filter(name => name.includes('Terminal'))).toEqual([
      'onTerminalData',
      'onTerminalExit',
    ])

    const api = createWebPlatformApi()
    expect(api.capabilities.terminal).toBe(false)
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
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      return new Response(JSON.stringify({
        success: true,
        previewId: 'preview-1',
        url,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', {})

    const { createWebPlatformApi } = await import('../web.js')
    const api = createWebPlatformApi()
    const callback = vi.fn()
    const cleanup = api.onImagePreviewUpdate(callback)

    // P4c 第三批:开预览不再往 server 走一趟。旧线先 POST /api/media/preview/open
    // 把 src 存进 server 的登记簿、再把**同一个 src** 原样广播出去 —— 那趟往返
    // 从来没有人读(页内订阅拿到的就是 src 本身)。现在只留广播,用户看到的一格没变。
    await expect(api.openImagePreview('data:image/png;base64,aW1hZ2U=', 'Image')).resolves.toEqual({
      success: true,
    })
    expect(fetchMock).not.toHaveBeenCalledWith('/api/media/preview/open', expect.anything())

    expect(callback).toHaveBeenCalledWith({
      mode: 'single',
      src: 'data:image/png;base64,aW1hZ2U=',
      alt: 'Image',
    })
    // 「开画廊窗」在浏览器里同样是本地承认:旧的 server 路由实现就是
    // `return { success: true }`,一次不改变任何东西的往返。
    await expect(api.openImageGallery('asset-1')).resolves.toEqual({ success: true })
    expect(fetchMock).not.toHaveBeenCalledWith('/api/media/gallery/open', expect.anything())
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
    const sizeCallback = vi.fn()
    const cleanupSize = api.onContextSizeUpdated(sizeCallback)

    expect(events.map(event => event.url)).toEqual(['/api/events'])
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'context:size-updated', contextSize: 1234 },
    })
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'context:size-updated', contextSize: '1234' },
    })
    // P1:压缩事件不再有专属平台订阅 —— 它们走 onSessionEvent → ipc-hub。
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'context:compact-started' },
    })
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'context:compact-completed', success: false, error: 'too large' },
    })
    events[0]?.emit('session:event', {
      sessionId: 'session-1',
      event: { type: 'stream:start' },
    })

    expect(sizeCallback).toHaveBeenCalledTimes(1)
    expect(sizeCallback).toHaveBeenCalledWith({
      sessionId: 'session-1',
      contextSize: 1234,
    })
    expect('onContextCompactStarted' in api).toBe(false)
    expect('onContextCompactCompleted' in api).toBe(false)

    cleanupSize()
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

  // P4c 第八批:`maps workspace file platform methods to server REST endpoints`
  // 整条退休 —— 它断言的十四条 /api/files/* 与 /api/dirs/list 镜像已经不存在了
  // (数据面走 `filesRouter` + `@/platform/files-client`)。留在 web 壳上的
  // `onWorkspaceFileChanged` SSE 订阅由上面那条 EventSource 用例钉;
  // 十四条方法的行为(含 http 夹紧)由 `backend/rpc/__tests__/files-domain.test.ts`
  // 与 `backend/server/__tests__/http.test.ts` 那条端到端用例钉。

  // tools 的七条数据面已整只迁到通用 RPC 通道(P4c 第九批,`toolsRouter` +
  // `@/platform/tools-client`):web 壳上不再有 `/api/tools*` 的六条 REST 镜像,
  // server 那六条路由(含 background-jobs stop 的正则)也一并删了。
  // 方法的行为(含 http 侧逐方法的护栏)由 `backend/rpc/__tests__/tools-domain.test.ts` 钉。

  // music / interaction 从来没有 web REST 镜像(前者十四条硬桩、后者两条在
  // `WEB_DESKTOP_ONLY_PLATFORM_METHODS` 名单里)。迁到 router 之后挡在前面的是
  // **能力位**:`music` 与 `interactionRespond` 在 web 上默认 false,见下方用例。

  // evals / evalsWorkbench 的二十五条同样从来没有 web REST 镜像(它们是二十四条
  // `Evals is not supported in the web build` 硬桩 + 一条连壳都没有的 readSnapshot)。
  // 迁到 router 之后(P4c 第十批)挡在前面的也是**能力位** `evals`,web 默认 false;
  // 关着时 `platform/evals-client.ts` 就地返回与旧硬桩逐字相同的那句话。
  // 方法的行为(含 http 侧四条按 wire 路径读盘的拒绝)由
  // `backend/rpc/__tests__/evals-domain.test.ts` 钉。

  // permission(活询问)域的两条已整只迁到通用 RPC 通道(P4c,`permissionRouter` +
  // `@/platform/permission-client`):web 壳上不再有
  // `/api/sessions/:id/permissions/{pending,clear}` 的镜像,server 那条正则路由的
  // 两个分支也一并删了(`/api/permissions/:id/respond` 不动 —— 那是命令面)。

  // 会话域(sessions)的 26 条数据面已整只迁到通用 RPC 通道(P4c 第五批,
  // `sessionsRouter` + `@/platform/sessions-client`):web 壳上不再有
  // `/api/sessions/*`、`/api/session-messages/page`、`/api/chat/{messages,
  // token-usage,update-session-pin,add-system-message,remove-system-marker,
  // remove-message}` 的镜像,server 侧对应的路由也一并删了。留下的 REST 只有
  // mobile 仍在直接打的三条(list / create / messages page,拍板 #32)与
  // `max-tokens`(从来不在那 26 条里)。

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

    await expect(api.updateSessionMaxTokens('session-1', 200000)).resolves.toEqual({
      success: true,
      url: '/api/sessions/session-1/max-tokens',
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/session-1/max-tokens', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ maxTokens: 200000 }),
    }))
    // 第七条「工具审批后恢复流」于 2026-08-22(#21)整条删除:桌面那条 invoke
    // 和 web 这条命令总线壳方法一起没了(渲染层零调用者)。引擎的
    // `command:resume-after-confirm` 仍在总线上,只是没有壳方法打它。
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

    // P4c 第十一批:settings 四条数据面已迁到通用 RPC(settingsRouter);
    // web 壳上只剩「开设置窗」的 hash 等价物与三条 noop / 本地推送。
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

    // P4c 第七批:themes 五条已迁到通用 RPC(themesRouter),web 壳上不再有它们的镜像。
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
    // P4 终态批 C2:plugins 十九条数据面已迁到通用 RPC(`pluginsRouter`);
    // web 壳上不再有 /api/plugins* 的镜像,server 那六条 REST 路由与那条 501
    // 一起删了。客户端在 `@/platform/plugins-client`。
    // P4c 第七批:oauth 六条数据面已迁到通用 RPC(oauthRouter);web 壳上只剩
    // `/api/oauth/events` 那条 SSE 订阅(推送面,router 今天没有)。
    // P4c 第八批:gateway 八条数据面已迁到通用 RPC(`gatewayRouter`);本域零推送,
    // 所以 web 壳上一条不剩。
    // P4c 第十一批:voice 十一条数据面已迁到通用 RPC(voiceRouter);web 壳上只剩
    // `/api/voice/events` 与 `/api/voice/runtime-commands` 两条 SSE 订阅(推送面)。
    // scheduler 域的九条已整只迁到通用 RPC 通道(P4c,`@shared/ipc/scheduler.ts` 的
    // schedulerRouter + `@/platform/scheduler-client` 的 schedulerApi):web 壳上
    // 不再有 /api/scheduler/* 的镜像,server 的九条 REST 路由也一并删了。
    // agents / providers / models 已迁到通用 RPC 通道(主线 T1 第二批):
    // web 壳上不再有它们的方法,客户端在 platform/{agents,providers,models}-client.ts。
    // skills 十二条同样迁走了(结构债 P4c 第二批,`@/platform/skills-client`):
    // web 壳上不再有 /api/skills* 的镜像,server 的六条 REST 路由与那个正则块也删了。
    // 系统提示词快照(以及另外五条聊天面)迁 chatRouter(P4c 第五批,
    // `@/platform/chat-client`):`/api/sessions/:id/system-prompt-snapshot` 也删了。

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
