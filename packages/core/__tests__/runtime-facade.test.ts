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
        createBranch: vi.fn(async (parentSessionId: string, branchFromMessageId: string) => ({
          id: 'session-branch',
          parentSessionId,
          branchFromMessageId,
        })),
      },
      chat: {
        generateTitle: vi.fn(async message => ({ success: true, title: message })),
      },
      commands: {
        emit: vi.fn(async (sessionId: string, command: unknown) => ({
          success: true,
          result: { sessionId, command },
        })),
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
      files: {
        listFiles: vi.fn(async request => ({ success: true, request })),
        rollback: vi.fn(async request => ({ success: true, request })),
        watchWorkspace: vi.fn(async root => ({ success: true, root })),
        unwatchWorkspace: vi.fn(async root => ({ success: true, root })),
        subscribeWorkspaceFileChanged: vi.fn((handler) => {
          handler({ root: '/workspace', path: '/workspace/a.txt', eventType: 'change' })
          return unsubscribe
        }),
      },
      projectDirs: {
        list: vi.fn(async () => ({ success: true, entries: [] })),
      },
      variables: {
        list: vi.fn(async request => ({ success: true, variables: [], request })),
      },
      media: {
        listAssets: vi.fn(async () => []),
        subscribeImageGenerated: vi.fn((handler) => {
          handler({ id: 'image-1' })
          return unsubscribe
        }),
      },
      scheduler: {
        listTasks: vi.fn(async () => ({ success: true, tasks: [] })),
      },
      plugins: {
        list: vi.fn(async () => ({ success: true, plugins: [] })),
        enable: vi.fn(async pluginId => ({ success: true, pluginId })),
        commands: vi.fn(async () => ({ success: true, commands: [] })),
        executeCommand: vi.fn(async request => ({ success: true, request })),
      },
      oauth: {
        start: vi.fn(async providerId => ({ success: true, providerId })),
        callback: vi.fn(async request => ({ success: true, request })),
        devicePoll: vi.fn(async request => ({ success: true, completed: false, request })),
        refresh: vi.fn(async providerId => ({ success: true, providerId })),
        status: vi.fn(async providerId => ({ success: true, providerId, isLoggedIn: false })),
        logout: vi.fn(async providerId => ({ success: true, providerId })),
        subscribe: vi.fn((handler) => {
          handler({ type: 'oauth:token-refreshed', providerId: 'codex' })
          return unsubscribe
        }),
      },
      gateway: {
        getStatus: vi.fn(async () => ({ success: true, status: { running: false } })),
        start: vi.fn(async request => ({ success: false, request, error: 'disabled' })),
        stop: vi.fn(async () => ({ success: true, status: { running: false } })),
        wechatLogout: vi.fn(async () => ({ success: false, error: 'disabled' })),
      },
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
      acp: {
        getAgents: vi.fn(async () => ({ success: true, agents: [] })),
        addAgent: vi.fn(async config => ({ success: true, agent: { config } })),
        updateAgent: vi.fn(async config => ({ success: true, agent: { config } })),
        removeAgent: vi.fn(async agentId => ({ success: true, agentId })),
        connectAgent: vi.fn(async agentId => ({ success: false, agentId, error: 'disabled' })),
        disconnectAgent: vi.fn(async agentId => ({ success: true, agentId })),
        refreshAgent: vi.fn(async agentId => ({ success: true, agent: { id: agentId } })),
        cancelSession: vi.fn(async (sessionId, agentId) => ({ success: true, sessionId, agentId })),
      },
      mcp: {
        getServers: vi.fn(async () => ({ success: true, servers: [] })),
        addServer: vi.fn(async () => ({ success: true })),
        updateServer: vi.fn(async () => ({ success: true })),
        removeServer: vi.fn(async () => ({ success: true })),
        connectServer: vi.fn(async () => ({ success: true })),
        disconnectServer: vi.fn(async () => ({ success: true })),
        refreshServer: vi.fn(async () => ({ success: true })),
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
    await expect(runtime.sessions.createBranch?.('session-1', 'message-1')).resolves.toEqual({
      id: 'session-branch',
      parentSessionId: 'session-1',
      branchFromMessageId: 'message-1',
    })
    await expect(runtime.chat?.generateTitle?.('Hello world')).resolves.toEqual({
      success: true,
      title: 'Hello world',
    })
    await expect(runtime.commands.emit('session-1', { type: 'command:send-message' })).resolves.toMatchObject({
      success: true,
    })
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
    await expect(runtime.files?.listFiles?.({ cwd: '/workspace' })).resolves.toEqual({
      success: true,
      request: { cwd: '/workspace' },
    })
    await expect(runtime.files?.rollback?.({ filePath: '/workspace/a.txt' })).resolves.toEqual({
      success: true,
      request: { filePath: '/workspace/a.txt' },
    })
    await expect(runtime.files?.watchWorkspace?.('/workspace')).resolves.toEqual({
      success: true,
      root: '/workspace',
    })
    await expect(runtime.files?.unwatchWorkspace?.('/workspace')).resolves.toEqual({
      success: true,
      root: '/workspace',
    })
    const offWorkspace = runtime.files?.subscribeWorkspaceFileChanged?.(eventHandler)
    expect(eventHandler).toHaveBeenCalledWith({
      root: '/workspace',
      path: '/workspace/a.txt',
      eventType: 'change',
    })
    offWorkspace?.()
    await expect(runtime.projectDirs?.list?.()).resolves.toEqual({ success: true, entries: [] })
    await expect(runtime.variables?.list({ sessionId: 'session-1' })).resolves.toEqual({
      success: true,
      variables: [],
      request: { sessionId: 'session-1' },
    })
    await expect(runtime.media?.listAssets?.()).resolves.toEqual([])
    const offMedia = runtime.media?.subscribeImageGenerated?.(eventHandler)
    expect(eventHandler).toHaveBeenCalledWith({ id: 'image-1' })
    offMedia?.()
    await expect(runtime.scheduler?.listTasks()).resolves.toEqual({ success: true, tasks: [] })
    await expect(runtime.plugins?.list?.()).resolves.toEqual({ success: true, plugins: [] })
    await expect(runtime.plugins?.enable?.('demo')).resolves.toEqual({ success: true, pluginId: 'demo' })
    await expect(runtime.plugins?.commands?.()).resolves.toEqual({ success: true, commands: [] })
    await expect(runtime.plugins?.executeCommand?.({ commandName: '/demo', args: 'now', sessionId: 'session-1' })).resolves.toEqual({
      success: true,
      request: { commandName: '/demo', args: 'now', sessionId: 'session-1' },
    })
    await expect(runtime.oauth?.start('codex')).resolves.toEqual({ success: true, providerId: 'codex' })
    await expect(runtime.oauth?.callback({ providerId: 'codex', code: 'code', state: 'state' })).resolves.toEqual({
      success: true,
      request: { providerId: 'codex', code: 'code', state: 'state' },
    })
    await expect(runtime.oauth?.devicePoll({ providerId: 'github-copilot', flowId: 'flow-1' })).resolves.toEqual({
      success: true,
      completed: false,
      request: { providerId: 'github-copilot', flowId: 'flow-1' },
    })
    await expect(runtime.oauth?.refresh('codex')).resolves.toEqual({ success: true, providerId: 'codex' })
    await expect(runtime.oauth?.status('codex')).resolves.toEqual({ success: true, providerId: 'codex', isLoggedIn: false })
    await expect(runtime.oauth?.logout('codex')).resolves.toEqual({ success: true, providerId: 'codex' })
    const oauthHandler = vi.fn()
    const offOAuth = runtime.oauth?.subscribe?.(oauthHandler)
    expect(oauthHandler).toHaveBeenCalledWith({ type: 'oauth:token-refreshed', providerId: 'codex' })
    offOAuth?.()
    await expect(runtime.gateway?.getStatus()).resolves.toEqual({ success: true, status: { running: false } })
    await expect(runtime.gateway?.start({ channel: 'wechat' })).resolves.toEqual({
      success: false,
      request: { channel: 'wechat' },
      error: 'disabled',
    })
    await expect(runtime.gateway?.stop()).resolves.toEqual({ success: true, status: { running: false } })
    await expect(runtime.gateway?.wechatLogout()).resolves.toEqual({ success: false, error: 'disabled' })
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
    await expect(runtime.acp?.getAgents()).resolves.toEqual({ success: true, agents: [] })
    await expect(runtime.acp?.addAgent({ id: 'agent-1' })).resolves.toEqual({
      success: true,
      agent: { config: { id: 'agent-1' } },
    })
    await expect(runtime.acp?.updateAgent({ id: 'agent-1', name: 'Updated' })).resolves.toEqual({
      success: true,
      agent: { config: { id: 'agent-1', name: 'Updated' } },
    })
    await expect(runtime.acp?.removeAgent('agent-1')).resolves.toEqual({ success: true, agentId: 'agent-1' })
    await expect(runtime.acp?.connectAgent('agent-1')).resolves.toEqual({
      success: false,
      agentId: 'agent-1',
      error: 'disabled',
    })
    await expect(runtime.acp?.disconnectAgent('agent-1')).resolves.toEqual({ success: true, agentId: 'agent-1' })
    await expect(runtime.acp?.refreshAgent('agent-1')).resolves.toEqual({ success: true, agent: { id: 'agent-1' } })
    await expect(runtime.acp?.cancelSession('session-1', 'agent-1')).resolves.toEqual({
      success: true,
      sessionId: 'session-1',
      agentId: 'agent-1',
    })
    await expect(runtime.mcp?.getServers()).resolves.toEqual({ success: true, servers: [] })

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
      commands: {
        emit: vi.fn(async () => ({ success: true })),
      },
      events: {
        subscribe: vi.fn(() => () => {}),
      },
    })

    expect(runtime.capabilities).toBeUndefined()
    expect(runtime.appState).toBeUndefined()
    expect(runtime.chat).toBeUndefined()
    expect(runtime.permissions).toBeUndefined()
    expect(runtime.settings).toBeUndefined()
    expect(runtime.network).toBeUndefined()
    expect(runtime.search).toBeUndefined()
    expect(runtime.streams).toBeUndefined()
    expect(runtime.files).toBeUndefined()
    expect(runtime.projectDirs).toBeUndefined()
    expect(runtime.variables).toBeUndefined()
    expect(runtime.media).toBeUndefined()
    expect(runtime.scheduler).toBeUndefined()
    expect(runtime.plugins).toBeUndefined()
    expect(runtime.oauth).toBeUndefined()
    expect(runtime.gateway).toBeUndefined()
    expect(runtime.voice).toBeUndefined()
    expect(runtime.acp).toBeUndefined()
    expect(runtime.tools).toBeUndefined()
    expect(runtime.mcp).toBeUndefined()
  })
})
