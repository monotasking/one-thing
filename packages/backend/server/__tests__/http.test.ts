import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOnethingRuntimeFacade } from '@onething/core'
import { defineRouter } from '@onething/core/ipc'
import type { CorePluginCommandContext } from '@onething/core/plugins'
import { registerRouterHandlers, resetRpcRegistryForTests } from '@onething/backend/rpc/registry.js'
import { registerMarkdownRpcDomain } from '@onething/backend/rpc/domains/markdown.js'
import { registerPermissionGrantsRpcDomain } from '@onething/backend/rpc/domains/permission-grants.js'
import { resetPermissionGrantsForTests } from '@onething/core/permission'
import { createDefaultSettings } from '@shared/defaults/settings.js'
import { chatRouter } from '@shared/ipc/chat.js'
import type { AppSettings } from '@shared/ipc/settings.js'
import { createOnethingHttpServer } from '../http.js'
import {
  SERVER_REDACTED_SECRET,
  createAppBackedServerSessionStore,
  mergeServerSettingsUpdate,
  sanitizeSettingsForClient,
  type OnethingServerRuntime,
} from '../runtime.js'
import { createEchoServerBackend, createTestServerRuntime } from './test-helpers.js'

const servers: Server[] = []
const runtimes: OnethingServerRuntime[] = []
const tempDirs: string[] = []
const originalOnethingStorePath = process.env.ONETHING_STORE_PATH

const TEST_SERVER_AUTH_TOKEN = 'test-server-token'

type SettingsResponse = { success: boolean; settings?: AppSettings; error?: string }

beforeEach(async () => {
  process.env.ONETHING_STORE_PATH = await createTempDir('onething-test-store-')
})

afterEach(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (error) reject(error)
      else resolve()
    })
  })))
  servers.length = 0
  await Promise.all(runtimes.map(runtime => runtime.shutdown()))
  runtimes.length = 0
  resetPermissionGrantsForTests()
  await Promise.all(tempDirs.map(path => rm(path, { recursive: true, force: true })))
  tempDirs.length = 0
  if (originalOnethingStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = originalOnethingStorePath
})

describe('createOnethingHttpServer', () => {
  it('exposes web-safe runtime capabilities', async () => {
    const serverRuntime = await createTestServerRuntime()
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      runtime: serverRuntime.runtime,
    }))

    const response = await fetch(`${baseUrl(server)}/api/capabilities`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      localFileSystem: false,
      workspaceFileSystem: true,
      nativeWindowControls: false,
      shellTools: false,
      clipboardWrite: false,
      desktopWindows: false,
      globalMenuEvents: false,
    })
  })

  it('replays session events after Last-Event-ID and stamps SSE id fields', async () => {
    let backendBus: { emit(sessionId: string, event: unknown): Promise<unknown> } | undefined
    const serverRuntime = await createTestServerRuntime({
      createBackend: async () => {
        const backend = await createEchoServerBackend()
        backendBus = backend.eventBus as unknown as typeof backendBus
        return backend
      },
    })
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      runtime: serverRuntime.runtime,
    }))

    const created = await fetchJson(`${baseUrl(server)}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'sse resume target' }),
    }) as { session?: { id?: string } }
    const sessionId = created.session?.id
    expect(sessionId).toBeTruthy()

    // Commit two events before any client connects; replay must serve the gap.
    await backendBus!.emit(sessionId!, {
      type: 'stream:start',
      assistantMessageId: 'assistant-1',
      userMessageId: 'user-1',
    })
    await backendBus!.emit(sessionId!, { type: 'stream:aborted' })

    // Learn the committed sequences via a full replay (?after=0).
    const full = await fetch(`${baseUrl(server)}/api/sessions/${sessionId}/events?after=0`)
    const fullReplay = await readUntil(full, text => text.includes('stream:aborted'))
    const startSeq = sseIdFor(fullReplay, 'stream:start')
    const abortedSeq = sseIdFor(fullReplay, 'stream:aborted')
    expect(abortedSeq).toBeGreaterThan(startSeq)

    // (a) Last-Event-ID alone resumes strictly after it → replay yields the next event.
    const headerOnly = await fetch(`${baseUrl(server)}/api/sessions/${sessionId}/events`, {
      headers: { 'last-event-id': String(startSeq) },
    })
    expect(headerOnly.headers.get('content-type')).toContain('text/event-stream')
    const headerReplay = await readUntil(headerOnly, text => text.includes('event: session:event'))
    expect(headerReplay).toContain(`id: ${abortedSeq}\n`)
    expect(headerReplay).toContain('stream:aborted')
    expect(headerReplay).not.toContain(`id: ${startSeq}\n`)

    // (b) Explicit ?after= beats a stale Last-Event-ID header.
    const queryWins = await fetch(
      `${baseUrl(server)}/api/sessions/${sessionId}/events?after=${startSeq}`,
      { headers: { 'last-event-id': String(abortedSeq) } },
    )
    const queryReplay = await readUntil(queryWins, text => text.includes('event: session:event'))
    expect(queryReplay).toContain(`id: ${abortedSeq}\n`)
  })

  it('routes proxy tests through the network runtime facade with owner context', async () => {
    const testProxy = vi.fn(async () => ({ success: false, error: 'Proxy is disabled.' }))
    const runtime = createOnethingRuntimeFacade({
      sessions: {
        list: async () => ({ success: true, sessions: [] }),
        create: async (name: string) => ({ id: 'session-1', name }),
      },
      events: {
        subscribe: () => () => {},
      },
      network: {
        testProxy,
      },
    })
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN, runtime }))
    const headers = contextHeaders('alice', 'network-workspace')

    await expect(fetchJson(`${baseUrl(server)}/api/network/test-proxy`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        proxy: {
          enabled: false,
          url: '',
        },
      }),
    })).resolves.toEqual({
      success: false,
      error: 'Proxy is disabled.',
    })

    expect(testProxy).toHaveBeenCalledWith({
      enabled: false,
      url: '',
    }, expect.objectContaining({
      userId: 'alice',
      workspaceId: 'network-workspace',
    }))
  })

  it('routes search requests through the search runtime facade with owner context', async () => {
    const query = vi.fn(async request => ({ success: true, results: [{ id: 'action:1', request }] }))
    const executeAction = vi.fn(async actionId => ({ success: true, actionId }))
    const runtime = createOnethingRuntimeFacade({
      sessions: {
        list: async () => ({ success: true, sessions: [] }),
        create: async (name: string) => ({ id: 'session-1', name }),
      },
      events: {
        subscribe: () => () => {},
      },
      search: {
        query,
        executeAction,
      },
    })
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN, runtime }))
    const headers = contextHeaders('alice', 'search-workspace')

    await expect(fetchJson(`${baseUrl(server)}/api/search/query`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'settings',
        category: 'actions',
        limit: 5,
      }),
    })).resolves.toEqual({
      success: true,
      results: [{
        id: 'action:1',
        request: {
          query: 'settings',
          category: 'actions',
          limit: 5,
        },
      }],
    })

    await expect(fetchJson(`${baseUrl(server)}/api/search/actions`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ actionId: 'open-settings' }),
    })).resolves.toEqual({
      success: true,
      actionId: 'open-settings',
    })

    expect(query).toHaveBeenCalledWith({
      query: 'settings',
      category: 'actions',
      limit: 5,
    }, expect.objectContaining({
      userId: 'alice',
      workspaceId: 'search-workspace',
    }))
    expect(executeAction).toHaveBeenCalledWith('open-settings', expect.objectContaining({
      userId: 'alice',
      workspaceId: 'search-workspace',
    }))
  })

  it('executes web-safe plugin commands through the development runtime with session ownership checks', async () => {
    const dataRoot = await createTempDir('onething-plugin-data-')
    const workspaceRoot = await createTempDir('onething-plugin-workspace-')
    const handler = vi.fn(async (args: string, ctx: CorePluginCommandContext) => {
      ctx.notify(`demo:${args}`)
      ctx.followUp('follow up from plugin')
      const execResult = await ctx.exec('echo', ['blocked'])
      ctx.notify(`exec:${execResult.exitCode}`, 'warn')
    })
    const serverRuntime = await createTestServerRuntime({
      dataRoot,
      workspaceRoot,
      pluginCommands: [{
        name: '/demo',
        description: 'Run demo',
        usage: '/demo <arg>',
        handler,
      }],
    })
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
    }))
    const baseUrlValue = baseUrl(server)
    const aliceHeaders = contextHeaders('alice', 'plugin-workspace')
    const bobHeaders = contextHeaders('bob', 'plugin-workspace')
    const created = await createSession(baseUrlValue, 'Plugin session', aliceHeaders)
    const sessionId = created.session?.id
    expect(sessionId).toBeTruthy()

    await expect(fetchJson(`${baseUrlValue}/api/plugins/commands`, {
      headers: aliceHeaders,
    })).resolves.toEqual({
      success: true,
      commands: [{
        id: 'demo',
        name: '/demo',
        description: 'Run demo',
        usage: '/demo <arg>',
      }],
    })

    const executed = await fetchJson(`${baseUrlValue}/api/plugins/execute-command`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        commandName: 'demo',
        args: '--fast',
        sessionId,
      }),
    })
    expect(executed).toEqual({
      success: true,
      message: 'exec:126',
    })
    expect(handler).toHaveBeenCalledWith('--fast', expect.objectContaining({
      sessionId,
      cwd: expect.stringContaining('plugin-workspace'),
    }))

    const bobAttempt = await fetchJson(`${baseUrlValue}/api/plugins/execute-command`, {
      method: 'POST',
      headers: { ...bobHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        commandName: 'demo',
        args: '--fast',
        sessionId,
      }),
    })
    expect(bobAttempt).toEqual({
      success: false,
      error: 'Session not found',
    })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('serves owner-scoped OAuth device flow through the development runtime', async () => {
    const dataRoot = await createTempDir('onething-oauth-data-')
    const workspaceRoot = await createTempDir('onething-oauth-workspace-')
    const oauthFetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      if (body.includes('device_code=device-1')) {
        return new Response(JSON.stringify({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          token_type: 'Bearer',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (body.includes('grant_type=refresh_token')) {
        return new Response(JSON.stringify({
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          expires_in: 3600,
          token_type: 'Bearer',
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({
        device_code: 'device-1',
        user_code: 'USER-CODE',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 1,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const serverRuntime = await createTestServerRuntime({
      dataRoot,
      workspaceRoot,
      oauthFetch,
    })
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
    }))
    const baseUrlValue = baseUrl(server)
    const aliceHeaders = contextHeaders('alice', 'oauth-workspace')
    const bobHeaders = contextHeaders('bob', 'oauth-workspace')

    const started = await fetchJson(`${baseUrlValue}/api/oauth/start`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'github-copilot' }),
    })
    expect(started).toMatchObject({
      success: true,
      flowKind: 'device-code',
      flowId: expect.any(String),
      userCode: 'USER-CODE',
      verificationUri: 'https://github.com/login/device',
      pollIntervalMs: 1000,
    })

    const pendingStatus = await fetchJson(`${baseUrlValue}/api/oauth/status`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'github-copilot' }),
    })
    expect(pendingStatus).toMatchObject({
      success: true,
      providerId: 'github-copilot',
      isLoggedIn: false,
    })

    const polled = await fetchJson(`${baseUrlValue}/api/oauth/device-poll`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'github-copilot', flowId: started.flowId }),
    })
    expect(polled).toEqual({ success: true, completed: true })

    const aliceStatus = await fetchJson(`${baseUrlValue}/api/oauth/status`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'github-copilot' }),
    })
    expect(aliceStatus).toMatchObject({
      success: true,
      providerId: 'github-copilot',
      isLoggedIn: true,
      isExpired: false,
      canRefresh: true,
    })

    const bobStatus = await fetchJson(`${baseUrlValue}/api/oauth/status`, {
      method: 'POST',
      headers: { ...bobHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'github-copilot' }),
    })
    expect(bobStatus).toMatchObject({
      success: true,
      providerId: 'github-copilot',
      isLoggedIn: false,
    })

    await expect(fetchJson(`${baseUrlValue}/api/oauth/refresh`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'github-copilot' }),
    })).resolves.toEqual({ success: true })

    await expect(fetchJson(`${baseUrlValue}/api/oauth/logout`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'github-copilot' }),
    })).resolves.toEqual({ success: true })

    const afterLogout = await fetchJson(`${baseUrlValue}/api/oauth/status`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'github-copilot' }),
    })
    expect(afterLogout).toMatchObject({
      success: true,
      providerId: 'github-copilot',
      isLoggedIn: false,
    })
  })

  it('serves owner-scoped gateway status while refusing server-side channel starts', async () => {
    const dataRoot = await createTempDir('onething-gateway-data-')
    const workspaceRoot = await createTempDir('onething-gateway-workspace-')
    const serverRuntime = await createTestServerRuntime({
      dataRoot,
      workspaceRoot,
    })
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
    }))
    const baseUrlValue = baseUrl(server)
    const aliceHeaders = contextHeaders('alice', 'gateway-workspace')
    const bobHeaders = contextHeaders('bob', 'gateway-workspace')
    const aliceJsonHeaders = { ...aliceHeaders, 'content-type': 'application/json' }

    const initial = await fetchJson(`${baseUrlValue}/api/gateway/status`, {
      headers: aliceHeaders,
    })
    expect(initial).toMatchObject({
      success: true,
      status: {
        running: false,
        enabled: false,
        wechat: {
          enabled: false,
          running: false,
          loggedIn: false,
          loginStatus: 'idle',
        },
      },
    })

    await fetchJson(`${baseUrlValue}/api/settings`, {
      method: 'POST',
      headers: aliceJsonHeaders,
      body: JSON.stringify({ channels: { wechat: { enabled: true } } }),
    })

    const aliceEnabled = await fetchJson(`${baseUrlValue}/api/gateway/status`, {
      headers: aliceHeaders,
    })
    expect(aliceEnabled).toMatchObject({
      success: true,
      status: {
        running: false,
        enabled: true,
        wechat: {
          enabled: true,
          running: false,
          loggedIn: false,
        },
      },
    })

    const bobStatus = await fetchJson(`${baseUrlValue}/api/gateway/status`, {
      headers: bobHeaders,
    })
    expect(bobStatus).toMatchObject({
      success: true,
      status: {
        enabled: false,
        wechat: { enabled: false },
      },
    })

    await expect(fetchJson(`${baseUrlValue}/api/gateway/start`, {
      method: 'POST',
      headers: aliceJsonHeaders,
      body: JSON.stringify({ channel: 'wechat' }),
    })).resolves.toMatchObject({
      success: false,
      error: 'Gateway channels are disabled in the web server runtime.',
      status: {
        enabled: true,
        running: false,
        wechat: {
          enabled: true,
          running: false,
          loginStatus: 'error',
          lastError: 'Gateway channels are disabled in the web server runtime.',
        },
      },
    })

    await expect(fetchJson(`${baseUrlValue}/api/gateway/stop`, {
      method: 'POST',
      headers: aliceJsonHeaders,
    })).resolves.toMatchObject({
      success: true,
      status: {
        enabled: true,
        running: false,
        wechat: { enabled: true, running: false },
      },
    })

    await expect(fetchJson(`${baseUrlValue}/api/gateway/wechat/logout`, {
      method: 'POST',
      headers: aliceJsonHeaders,
    })).resolves.toMatchObject({
      success: false,
      error: 'Gateway channels are disabled in the web server runtime.',
    })
  })

  it('serves web-safe voice endpoints with explicit unavailable responses', async () => {
    const dataRoot = await createTempDir('onething-voice-data-')
    const workspaceRoot = await createTempDir('onething-voice-workspace-')
    const serverRuntime = await createTestServerRuntime({
      dataRoot,
      workspaceRoot,
    })
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
    }))
    const baseUrlValue = baseUrl(server)
    const headers = contextHeaders('alice', 'voice-workspace')
    const jsonHeaders = { ...headers, 'content-type': 'application/json' }

    await expect(fetchJson(`${baseUrlValue}/api/voice/state`, {
      headers,
    })).resolves.toMatchObject({
      success: true,
      state: {
        status: 'disabled',
        enabled: false,
        runtimeReady: false,
      },
    })

    await expect(fetchJson(`${baseUrlValue}/api/voice/start`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sessionId: 'session-1', reason: 'manual' }),
    })).resolves.toMatchObject({
      success: false,
      error: 'Voice runtime is not available in the web server runtime.',
      state: {
        status: 'error',
        enabled: false,
        runtimeReady: false,
        lastError: 'Voice runtime is not available in the web server runtime.',
      },
    })

    await expect(fetchJson(`${baseUrlValue}/api/voice/stop`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ reason: 'manual' }),
    })).resolves.toEqual({ success: true })

    await expect(fetchJson(`${baseUrlValue}/api/voice/submit-utterance`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ audioBase64: 'audio', mimeType: 'audio/webm' }),
    })).resolves.toEqual({
      success: false,
      error: 'Voice runtime is not available in the web server runtime.',
    })

    await expect(fetchJson(`${baseUrlValue}/api/voice/submit-transcript`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        text: 'hello',
        asrProvider: 'openai-transcribe',
        asrModel: 'whisper-1',
      }),
    })).resolves.toEqual({
      success: false,
      error: 'Voice runtime is not available in the web server runtime.',
    })

    await expect(fetchJson(`${baseUrlValue}/api/voice/synthesize`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ text: 'hello' }),
    })).resolves.toEqual({
      success: false,
      error: 'Voice runtime is not available in the web server runtime.',
    })

    await expect(fetchJson(`${baseUrlValue}/api/voice/test-asr`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ audioBase64: 'audio', mimeType: 'audio/webm' }),
    })).resolves.toEqual({
      success: false,
      error: 'Voice runtime is not available in the web server runtime.',
    })

    await expect(fetchJson(`${baseUrlValue}/api/voice/test-tts`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ text: 'hello' }),
    })).resolves.toEqual({
      success: false,
      error: 'Voice runtime is not available in the web server runtime.',
    })

    await expect(fetchJson(`${baseUrlValue}/api/voice/tts-models`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ force: true }),
    })).resolves.toMatchObject({
      success: true,
      models: [],
      fetchedAt: expect.any(Number),
    })

    await expect(fetchJson(`${baseUrlValue}/api/voice/runtime-ready`, {
      method: 'POST',
      headers: jsonHeaders,
    })).resolves.toEqual({
      success: false,
      error: 'Voice runtime is not available in the web server runtime.',
    })

    await expect(fetchJson(`${baseUrlValue}/api/voice/runtime-event`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ type: 'runtime-ready' }),
    })).resolves.toEqual({
      success: false,
      error: 'Voice runtime is not available in the web server runtime.',
    })

    const voiceEvents = await fetch(`${baseUrlValue}/api/voice/events`, { headers })
    expect(voiceEvents.headers.get('content-type')).toContain('text/event-stream')
    await expect(readFirstChunk(voiceEvents)).resolves.toBe('\n')

    const runtimeCommands = await fetch(`${baseUrlValue}/api/voice/runtime-commands`, { headers })
    expect(runtimeCommands.headers.get('content-type')).toContain('text/event-stream')
    await expect(readFirstChunk(runtimeCommands)).resolves.toBe('\n')
  })

  it('serves owner-scoped plugin catalog state through the development runtime', async () => {
    const dataRoot = await createTempDir('onething-plugin-data-')
    const workspaceRoot = await createTempDir('onething-plugin-workspace-')
    const serverRuntime = await createTestServerRuntime({
      dataRoot,
      workspaceRoot,
    })
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
    }))
    const baseUrlValue = baseUrl(server)
    const aliceHeaders = contextHeaders('alice', 'plugin-workspace')
    const bobHeaders = contextHeaders('bob', 'plugin-workspace')
    const aliceJsonHeaders = { ...aliceHeaders, 'content-type': 'application/json' }

    const alicePlugins = await fetchJson(`${baseUrlValue}/api/plugins`, {
      headers: aliceHeaders,
    })
    expect(alicePlugins.success).toBe(true)
    expect(alicePlugins.plugins.map((plugin: { id: string }) => plugin.id)).toEqual(
      expect.arrayContaining(['log-monitor', 'note-skills']),
    )
    expect(alicePlugins.plugins.find((plugin: { id: string }) => plugin.id === 'note-skills')).toEqual(
      expect.objectContaining({
        enabled: true,
        loaded: false,
        commands: [],
      }),
    )

    await expect(fetchJson(`${baseUrlValue}/api/plugins/disable`, {
      method: 'POST',
      headers: aliceJsonHeaders,
      body: JSON.stringify({ pluginId: 'note-skills' }),
    })).resolves.toEqual({ success: true })

    const aliceAfterDisable = await fetchJson(`${baseUrlValue}/api/plugins`, {
      headers: aliceHeaders,
    })
    expect(aliceAfterDisable.plugins.find((plugin: { id: string }) => plugin.id === 'note-skills')).toEqual(
      expect.objectContaining({ enabled: false }),
    )

    const bobPlugins = await fetchJson(`${baseUrlValue}/api/plugins`, {
      headers: bobHeaders,
    })
    expect(bobPlugins.plugins.find((plugin: { id: string }) => plugin.id === 'note-skills')).toEqual(
      expect.objectContaining({ enabled: true }),
    )

    await expect(fetchJson(`${baseUrlValue}/api/plugins/enable`, {
      method: 'POST',
      headers: aliceJsonHeaders,
      body: JSON.stringify({ pluginId: 'note-skills' }),
    })).resolves.toEqual({ success: true })

    const aliceAfterEnable = await fetchJson(`${baseUrlValue}/api/plugins`, {
      headers: aliceHeaders,
    })
    expect(aliceAfterEnable.plugins.find((plugin: { id: string }) => plugin.id === 'note-skills')).toEqual(
      expect.objectContaining({ enabled: true }),
    )

    await expect(fetchJson(`${baseUrlValue}/api/plugins/refresh`, {
      method: 'POST',
      headers: aliceJsonHeaders,
    })).resolves.toEqual({ success: true })
    await expect(fetchJson(`${baseUrlValue}/api/plugins/commands`, {
      headers: aliceHeaders,
    })).resolves.toEqual({
      success: true,
      commands: [],
    })
  })

  /**
   * 方案 A(设计文档 §6):插件只在 Electron 桌面宿主执行,server 的插件目录是
   * 只读镜像。带参路由存在的意义就是**不静默** —— 调用方要拿到一条说明了原因的
   * 501,而不是 404 或者一个永远 pending 的请求。
   */
  it('answers the parameterized plugin request route with a readable 501', async () => {
    const dataRoot = await createTempDir('onething-plugin-request-data-')
    const workspaceRoot = await createTempDir('onething-plugin-request-workspace-')
    const serverRuntime = await createTestServerRuntime({ dataRoot, workspaceRoot })
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
    }))
    const baseUrlValue = baseUrl(server)
    const headers = { ...contextHeaders('alice', 'plugin-workspace'), 'content-type': 'application/json' }

    const response = await fetch(`${baseUrlValue}/api/plugins/note-skills/search`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ payload: { q: 'hello' }, requestId: 'req-1' }),
    })
    expect(response.status).toBe(501)
    const body = await response.json() as {
      success: boolean
      error: string
      pluginId: string
      action: string
      host: string
    }
    expect(body.success).toBe(false)
    expect(body.error).toContain('desktop host only')
    expect(body).toMatchObject({ pluginId: 'note-skills', action: 'search', host: 'server' })

    // 参数化不能吃掉既有的精确路由 —— /api/plugins/enable 长得就像 :id。
    await expect(fetchJson(`${baseUrlValue}/api/plugins/enable`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ pluginId: 'note-skills' }),
    })).resolves.toEqual({ success: true })
    await expect(fetchJson(`${baseUrlValue}/api/plugins/refresh`, {
      method: 'POST',
      headers,
    })).resolves.toEqual({ success: true })
    const commands = await fetchJson(`${baseUrlValue}/api/plugins/commands`, {
      headers: contextHeaders('alice', 'plugin-workspace'),
    })
    expect(commands.success).toBe(true)
  })

  it('exposes the one surviving session REST write over HTTP with owner isolation', async () => {
    // P4c 第五批:会话域的 REST 面迁 `sessionsRouter`,聊天面的三条(标题生成 /
    // 思考时长补写 / 提示词快照)迁 `chatRouter`。这里只剩 `max-tokens` ——
    // 它桌面侧从来没有处理者,不属于任何一个已迁的域。
    const serverRuntime = await createTestServerRuntime()
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
    }))
    const baseUrlValue = baseUrl(server)
    const aliceHeaders = contextHeaders('alice', 'chat-dev-workspace')
    const bobHeaders = contextHeaders('bob', 'chat-dev-workspace')
    const jsonHeaders = { ...aliceHeaders, 'content-type': 'application/json' }
    const created = await createSession(baseUrlValue, 'Chat ops', aliceHeaders)
    const sessionId = created.session?.id
    expect(sessionId).toBeTruthy()

    await expect(fetchJson(`${baseUrlValue}/api/sessions/${encodeURIComponent(sessionId!)}/max-tokens`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ maxTokens: 200000 }),
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      session: expect.objectContaining({
        id: sessionId,
        maxTokens: 200000,
      }),
    }))
    await expect(fetchJson(`${baseUrlValue}/api/sessions/${encodeURIComponent(sessionId!)}/max-tokens`, {
      method: 'POST',
      headers: { ...bobHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ maxTokens: 300000 }),
    })).resolves.toEqual({
      success: false,
      error: 'Session not found',
    })
    await expect(fetchJson(`${baseUrlValue}/api/sessions/${encodeURIComponent(sessionId!)}/max-tokens`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ maxTokens: 0 }),
    })).resolves.toEqual({
      success: false,
      error: 'Max tokens must be a positive number.',
    })
  })

  it('searches owner-scoped server runtime data and resolves web search actions', async () => {
    const workspaceRoot = await createTempDir('onething-server-search-')
    const serverRuntime = await createTestServerRuntime({ workspaceRoot })
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
    }))
    const baseUrlValue = baseUrl(server)
    const aliceHeaders = contextHeaders('alice', 'search-dev-workspace')
    const bobHeaders = contextHeaders('bob', 'search-dev-workspace')
    const created = await createSession(baseUrlValue, 'Searchable Alpha', aliceHeaders)
    const sessionId = created.session?.id
    expect(sessionId).toBeTruthy()

    await expect(fetchJson(`${baseUrlValue}/api/search/query`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'Searchable',
        category: 'chats',
        limit: 5,
      }),
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      results: expect.arrayContaining([
        expect.objectContaining({
          type: 'chat',
          sessionId,
          title: 'Searchable Alpha',
        }),
      ]),
    }))

    await expect(fetchJson(`${baseUrlValue}/api/search/query`, {
      method: 'POST',
      headers: { ...bobHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'Searchable',
        category: 'chats',
        limit: 5,
      }),
    })).resolves.toEqual({
      success: true,
      results: [],
    })

    const notePath = join(workspaceRoot, 'alice', 'search-dev-workspace', 'notes', 'today.md')
    await expect(fetchJson(`${baseUrlValue}/api/search/actions`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        actionId: `create-daily-note:${encodeURIComponent(notePath)}`,
      }),
    })).resolves.toEqual({
      success: true,
      actionId: `open-file:${notePath}`,
    })
    await expect(readFile(notePath, 'utf8')).resolves.toContain('# ')
  })

  it('exposes workspace-scoped file routes for the web runtime', async () => {
    const workspaceRoot = await createTempDir('onething-server-files-')
    const serverRuntime = await createTestServerRuntime({ workspaceRoot })
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
    }))
    const baseUrlValue = baseUrl(server)
    const aliceHeaders = contextHeaders('alice', 'files-workspace')
    const bobHeaders = contextHeaders('bob', 'files-workspace')
    const created = await createSession(baseUrlValue, 'Files session', aliceHeaders)
    const workspaceDir = created.session?.workingDirectory
    expect(workspaceDir).toBeTruthy()

    const srcDir = join(workspaceDir!, 'src')
    const draftPath = join(srcDir, 'demo.txt')
    const renamedPath = join(srcDir, 'main.txt')

    const fileEvents = await fetch(`${baseUrlValue}/api/files/watch/events`, { headers: aliceHeaders })
    expect(fileEvents.status).toBe(200)
    await expect(fetchJson(`${baseUrlValue}/api/files/watch/start`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ root: workspaceDir }),
    })).resolves.toEqual({ success: true })
    await expect(fetchJson(`${baseUrlValue}/api/files/watch/start`, {
      method: 'POST',
      headers: { ...bobHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ root: workspaceDir }),
    })).resolves.toEqual({
      success: false,
      error: 'Workspace watch root must stay inside the workspace sandbox root.',
    })
    const watchedPath = join(workspaceDir!, 'watched.txt')
    await writeFile(watchedPath, 'watch me\n', 'utf8')
    const watchEventText = await readUntil(
      fileEvents,
      text => text.includes('workspace:file-changed') && text.includes('watched.txt'),
    )
    expect(watchEventText).toContain('workspace:file-changed')
    expect(watchEventText).toContain(watchedPath)
    await expect(fetchJson(`${baseUrlValue}/api/files/watch/stop`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ root: workspaceDir }),
    })).resolves.toEqual({ success: true })

    await expect(fetchJson(`${baseUrlValue}/api/files/create-directory`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ path: srcDir }),
    })).resolves.toEqual({ success: true })
    await expect(fetchJson(`${baseUrlValue}/api/files/create`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ path: draftPath, content: 'hello web\n' }),
    })).resolves.toEqual({ success: true })

    const readResult = await fetchJson(`${baseUrlValue}/api/files/read`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ path: draftPath }),
    })
    expect(readResult).toEqual(expect.objectContaining({
      success: true,
      content: 'hello web\n',
      encoding: 'utf-8',
      isBinary: false,
    }))

    await expect(fetchJson(`${baseUrlValue}/api/files/save`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        path: draftPath,
        content: 'updated web\n',
        expectedMtimeMs: readResult.mtimeMs,
      }),
    })).resolves.toEqual(expect.objectContaining({ success: true }))
    await expect(fetchJson(`${baseUrlValue}/api/files/rollback`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        filePath: draftPath,
        originalContent: 'hello web\n',
        isNew: false,
      }),
    })).resolves.toEqual({
      success: true,
      filePath: draftPath,
      restoredExists: true,
    })
    await expect(readFile(draftPath, 'utf8')).resolves.toBe('hello web\n')
    await expect(fetchJson(`${baseUrlValue}/api/files/rollback`, {
      method: 'POST',
      headers: { ...bobHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        filePath: draftPath,
        originalContent: 'bob should not write\n',
      }),
    })).resolves.toEqual({
      success: false,
      error: 'Rollback file path must stay inside the workspace sandbox root.',
    })
    await expect(fetchJson(`${baseUrlValue}/api/files/stat`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ path: draftPath }),
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      type: 'file',
    }))
    await expect(fetchJson(`${baseUrlValue}/api/files/list-directory`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ path: workspaceDir }),
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      entries: expect.arrayContaining([
        expect.objectContaining({ name: 'src', path: srcDir, type: 'directory' }),
      ]),
    }))
    await expect(fetchJson(`${baseUrlValue}/api/files/list`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: workspaceDir, query: 'demo', limit: 10 }),
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      files: expect.arrayContaining([draftPath]),
    }))
    await expect(fetchJson(`${baseUrlValue}/api/dirs/list`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ basePath: workspaceDir, query: 's', limit: 10 }),
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      dirs: expect.arrayContaining([srcDir]),
    }))

    await expect(fetchJson(`${baseUrlValue}/api/files/read`, {
      method: 'POST',
      headers: { ...bobHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ path: draftPath }),
    })).resolves.toEqual({
      success: false,
      error: 'File path must stay inside the workspace sandbox root.',
    })
    await expect(fetchJson(`${baseUrlValue}/api/files/read`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '../escape.txt' }),
    })).resolves.toEqual({
      success: false,
      error: 'File path must stay inside the workspace sandbox root.',
    })

    await expect(fetchJson(`${baseUrlValue}/api/files/rename`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ oldPath: draftPath, newPath: renamedPath }),
    })).resolves.toEqual({ success: true })
    await expect(fetchJson(`${baseUrlValue}/api/files/delete`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ path: renamedPath }),
    })).resolves.toEqual({ success: true })
    await expect(fetchJson(`${baseUrlValue}/api/files/reveal`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ path: srcDir }),
    })).resolves.toEqual({
      success: false,
      error: 'Revealing local files is not available in the web server runtime.',
    })
  })

  /**
   * 主线 T 批 3：markdown 迁到通用 RPC 通道，这条端到端断言跟着改走
   * `POST /api/rpc` —— **断言本身一条没减**。它证的是护栏从 `apps/server`
   * 搬进 `@onething/backend` 之后，经过真实 HTTP 层（含身份头 → dispatch context）
   * 的行为一字未变，含跨 owner 隔离。
   */
  it('serves sandboxed Markdown asset methods over the generic RPC route', async () => {
    const workspaceRoot = await createTempDir('onething-server-markdown-')
    const serverRuntime = await createTestServerRuntime({ workspaceRoot })
    runtimes.push(serverRuntime)
    // 装配层在 echo backend 下不跑,域要自己挂上(与上面 http-probe 同款)。
    const disposeDomain = registerMarkdownRpcDomain()
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
      workspaceRoot: serverRuntime.workspaceRoot,
    }))
    const baseUrlValue = baseUrl(server)
    const rpc = (headers: Record<string, string>, method: string, payload: unknown) =>
      fetchJson(`${baseUrlValue}/api/rpc`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ domain: 'markdown', method, payload }),
      })
    const aliceHeaders = contextHeaders('alice', 'markdown-workspace')
    const bobHeaders = contextHeaders('bob', 'markdown-workspace')
    const created = await createSession(baseUrlValue, 'Markdown session', aliceHeaders)
    const workspaceDir = created.session?.workingDirectory
    expect(workspaceDir).toBeTruthy()

    const documentPath = join(workspaceDir!, 'docs', 'readme.md')
    const imagePath = join(workspaceDir!, 'image.png')
    await mkdir(join(workspaceDir!, 'docs'), { recursive: true })
    await writeFile(documentPath, '# Readme\n![image](image.png)\n', 'utf8')
    await writeFile(imagePath, Buffer.from('image-bytes'))

    await expect(rpc(aliceHeaders, 'resolveAsset', {
      documentPath,
      workspaceRoot: workspaceDir,
      rawTarget: 'image.png',
    })).resolves.toEqual({
      ok: true,
      data: expect.objectContaining({
        success: true,
        asset: expect.objectContaining({
          kind: 'image',
          absolutePath: imagePath,
          fileName: 'image.png',
          dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
        }),
      }),
    })

    await expect(rpc(aliceHeaders, 'saveAttachments', {
      documentPath,
      workspaceRoot: workspaceDir,
      files: [{
        fileName: 'clip.png',
        mimeType: 'image/png',
        base64Data: Buffer.from('clip-bytes').toString('base64'),
      }],
    })).resolves.toEqual({
      ok: true,
      data: expect.objectContaining({
        success: true,
        insertText: '![clip](../clip.png)',
        attachments: [
          expect.objectContaining({
            fileName: 'clip.png',
            absolutePath: join(workspaceDir!, 'clip.png'),
          }),
        ],
      }),
    })

    await expect(rpc(aliceHeaders, 'resolveAsset', {
      documentPath,
      workspaceRoot: workspaceDir,
      rawTarget: '../escape.png',
    })).resolves.toEqual({
      ok: true,
      data: {
        success: false,
        error: 'Markdown asset target must stay inside the workspace sandbox root.',
      },
    })
    // 跨 owner:bob 的 dispatch context 指向 bob 的沙箱,alice 的文档在它之外。
    await expect(rpc(bobHeaders, 'resolveAsset', {
      documentPath,
      workspaceRoot: workspaceDir,
      rawTarget: 'image.png',
    })).resolves.toEqual({
      ok: true,
      data: {
        success: false,
        error: 'Markdown document path must stay inside the workspace sandbox root.',
      },
    })
    disposeDomain()
  })

  /**
   * 结构债 P4c:project-dirs 的五条 REST 路由与 server 自己那套 per-owner
   * `ServerProjectDirsStore`(`owners/<uid>/<wid>/project-dirs.json`)一起删了,名册从此
   * 是 app 层那一份(per-**space**,不是 per-owner)。这条断言因此改了两处:
   *  - 走 `POST /api/rpc`(与授权账页同一条判例),不再走 REST;
   *  - 「bob 看不见 alice 的名册」这一句退役 —— 分家的维度从 owner 换成了
   *    `workspaceId`(信封里的键),而不是请求头里的身份。
   * **没退役的是沙箱护栏**:联网宿主上路径仍要夹进 `<workspaceRoot>/<uid>/<wid>`,
   * 夹不住照旧回 `{ success:false, code:'WORKSPACE_PATH' }` —— 实现从 server adapter
   * 搬到了 `app/rpc/sandbox.ts`,桌面(transport:'ipc')不夹,与迁移前逐字同义。
   */
  it('clamps project directories to the web workspace sandbox over the generic RPC route', async () => {
    const workspaceRoot = await createTempDir('onething-server-project-dirs-')
    const dataRoot = await createTempDir('onething-server-project-dirs-data-')
    // 名册落在 app store 上,所以这条用例必须把 store 根指到临时目录 ——
    // 否则它会写进跑测试那台机器的 `~/.onething`。
    const storeRoot = await createTempDir('onething-server-project-dirs-store-')
    const originalStorePath = process.env.ONETHING_STORE_PATH
    process.env.ONETHING_STORE_PATH = storeRoot
    const serverRuntime = await createTestServerRuntime({ workspaceRoot, dataRoot })
    runtimes.push(serverRuntime)
    const { registerProjectDirsRpcDomain } = await import('../../rpc/domains/project-dirs.js')
    const disposeDomain = registerProjectDirsRpcDomain()
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
      workspaceRoot: serverRuntime.workspaceRoot,
    }))
    const baseUrlValue = baseUrl(server)
    const aliceHeaders = contextHeaders('alice', 'project-workspace')
    // 名册按 space 分家(批 B4);这条用例用一个自己的 space,免得撞上别人。
    const workspaceId = 'project-rpc'
    const projectDirsRpc = async (method: string, payload: unknown) => {
      const response = await fetchJson(`${baseUrlValue}/api/rpc`, {
        method: 'POST',
        headers: { ...aliceHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ domain: 'projectDirs', method, payload }),
      })
      expect(response.ok).toBe(true)
      return response.data
    }

    try {
      const created = await createSession(baseUrlValue, 'Project dirs session', aliceHeaders)
      const workspaceDir = created.session?.workingDirectory
      expect(workspaceDir).toBeTruthy()
      const projectPath = join(workspaceDir!, 'project-a')
      await mkdir(projectPath, { recursive: true })

      await expect(projectDirsRpc('add', {
        path: projectPath,
        description: 'Alpha project',
        workspaceId,
      })).resolves.toEqual(expect.objectContaining({
        success: true,
        project: expect.objectContaining({ path: projectPath, description: 'Alpha project' }),
      }))

      await expect(projectDirsRpc('list', { workspaceId })).resolves.toEqual(expect.objectContaining({
        success: true,
        entries: [expect.objectContaining({ path: projectPath, description: 'Alpha project' })],
      }))

      // 越界的那一条:护栏搬家之后答案一个字没变。
      await expect(projectDirsRpc('add', {
        path: '../outside',
        description: 'Outside',
        workspaceId,
      })).resolves.toEqual({
        success: false,
        error: 'Project directory path must stay inside the workspace sandbox root.',
        code: 'WORKSPACE_PATH',
      })

      await expect(projectDirsRpc('remove', { path: projectPath, workspaceId }))
        .resolves.toEqual(expect.objectContaining({ success: true }))
      await expect(projectDirsRpc('list', { workspaceId }))
        .resolves.toEqual(expect.objectContaining({ success: true, entries: [] }))
    } finally {
      disposeDomain()
      if (originalStorePath === undefined) delete process.env.ONETHING_STORE_PATH
      else process.env.ONETHING_STORE_PATH = originalStorePath
    }
  })

  /**
   * 媒体域的**数据面**已迁到通用 `POST /api/rpc`(P4c 第三批,`mediaRouter` 十一条,
   * 由 `packages/backend/rpc/__tests__/media-domain.test.ts` 钉)。server 壳上只剩两条
   * **不是 RPC 形状**的:按文件名交出字节的那条,和一条 SSE。这条用例守的正是它们 ——
   * 尤其是**按 owner 隔离**:一个 owner 不该能拿到另一个 owner 的媒体文件。
   */
  it('serves owner-scoped media file bytes and keeps the media SSE face', async () => {
    const dataRoot = await createTempDir('onething-server-media-')
    const serverRuntime = await createTestServerRuntime({ dataRoot })
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
    }))
    const baseUrlValue = baseUrl(server)
    const aliceHeaders = contextHeaders('alice', 'media-workspace')
    const bobHeaders = contextHeaders('bob', 'media-workspace')

    const mediaEvents = await fetch(`${baseUrlValue}/api/media/events`, { headers: aliceHeaders })
    expect(mediaEvents.status).toBe(200)

    // 直接往 alice 那份 owner 媒体库里存一张图 —— 从前这一步走
    // `POST /api/media/save-image`,那条路由随数据面一起迁走了,而它写的是
    // 同一台 `MediaLibraryService`、同一个目录布局。
    const { MediaLibraryService } = await import('@onething/runtime/media')
    const aliceMediaRoot = join(dataRoot, 'owners', 'alice', 'media-workspace', 'media')
    const aliceLibrary = new MediaLibraryService({
      indexPath: join(aliceMediaRoot, 'index.json'),
      imagesDir: join(aliceMediaRoot, 'images'),
      filesDir: join(aliceMediaRoot, 'files'),
    })
    const saved = await aliceLibrary.saveGeneratedImageAsLegacyItem({
      base64: Buffer.from('image-bytes').toString('base64'),
      prompt: 'A saved image',
      model: 'local-image',
      sessionId: 'session-1',
      messageId: 'message-1',
    })
    const fileUrl = `/api/media/file/${encodeURIComponent(saved.filePath.split('/').pop() ?? '')}`

    const mediaFileResponse = await fetch(`${baseUrlValue}${fileUrl}`, { headers: aliceHeaders })
    expect(mediaFileResponse.status).toBe(200)
    expect(mediaFileResponse.headers.get('content-type')).toBe('image/png')
    expect(await mediaFileResponse.text()).toBe('image-bytes')

    // 换一个 owner 就查无此文件 —— 这条隔离是这条路由存在的全部理由。
    const bobFileResponse = await fetch(`${baseUrlValue}${fileUrl}`, { headers: bobHeaders })
    expect(bobFileResponse.status).toBe(404)
  })

  it('streams runtime events as SSE session:event messages', async () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((_sessionId, handler) => {
      handler({
        sessionId: 'session-1',
        sequence: 8,
        event: { type: 'stream:start' },
      })
      return unsubscribe
    })
    const server = await listen(createOnethingHttpServer({
      runtime: createOnethingRuntimeFacade({
        sessions: {
          list: vi.fn(async () => []),
          create: vi.fn(async () => ({ id: 'session-1' })),
        },
        events: { subscribe },
      }),
    }))

    const response = await fetch(`${baseUrl(server)}/api/events?sessionId=session-1&after=7`)
    expect(response.status).toBe(200)
    const chunk = await readFirstChunk(response)

    expect(chunk).toContain('event: session:event')
    expect(chunk).toContain('"sequence":8')
    expect(subscribe).toHaveBeenCalledWith('session-1', expect.any(Function), { afterSeq: 7 }, expect.objectContaining({
      userId: 'local-user',
      workspaceId: 'default',
    }))
  })

  it('supports per-session SSE routes with replay cursors', async () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn((_sessionId, handler) => {
      handler({
        sessionId: 'session-1',
        sequence: 12,
        event: { type: 'content:part', data: { text: 'replayed' } },
      })
      return unsubscribe
    })
    const server = await listen(createOnethingHttpServer({
      runtime: createOnethingRuntimeFacade({
        sessions: {
          list: vi.fn(async () => []),
          create: vi.fn(async () => ({ id: 'session-1' })),
        },
        events: { subscribe },
      }),
    }))

    const response = await fetch(`${baseUrl(server)}/api/sessions/session-1/events?after=11`)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-accel-buffering')).toBe('no')
    const chunk = await readFirstChunk(response)

    expect(chunk).toContain('event: session:event')
    expect(chunk).toContain('"sequence":12')
    expect(chunk).toContain('replayed')
    expect(subscribe).toHaveBeenCalledWith('session-1', expect.any(Function), { afterSeq: 11 }, expect.objectContaining({
      userId: 'local-user',
      workspaceId: 'default',
    }))
  })

  it('allows browser auth and workspace headers in CORS preflight responses', async () => {
    const server = await listen(createOnethingHttpServer({
      corsOrigin: 'http://localhost:5173',
      runtime: createOnethingRuntimeFacade({
        sessions: {
          list: vi.fn(async () => []),
          create: vi.fn(async () => ({ id: 'session-1' })),
        },
        events: {
          subscribe: vi.fn(() => () => {}),
        },
      }),
    }))

    const response = await fetch(`${baseUrl(server)}/api/sessions`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-headers': 'authorization,x-onething-user-id,x-onething-workspace-id',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(response.headers.get('access-control-allow-headers')).toContain('authorization')
    expect(response.headers.get('access-control-allow-headers')).toContain('x-onething-user-id')
    expect(response.headers.get('access-control-allow-headers')).toContain('x-onething-workspace-id')
  })

  it('routes theme REST calls through the runtime facade', async () => {
    const getThemes = vi.fn(async () => ({ success: true, themes: [{ id: 'flexoki' }] }))
    const getTheme = vi.fn(async (themeId: string) => ({ success: true, theme: { id: themeId } }))
    const applyTheme = vi.fn(async (themeId: string, mode: 'dark' | 'light') => ({
      success: true,
      cssVariables: { '--theme-id': themeId, '--theme-mode': mode },
    }))
    const refreshThemes = vi.fn(async (projectPath?: string) => ({ success: true, themes: [], projectPath }))
    const openThemesFolder = vi.fn(async () => ({ success: false, error: 'not available' }))
    const server = await listen(createOnethingHttpServer({
      runtime: createOnethingRuntimeFacade({
        sessions: {
          list: vi.fn(async () => []),
          create: vi.fn(async () => ({ id: 'session-1' })),
        },
        events: {
          subscribe: vi.fn(() => () => {}),
        },
        themes: {
          getThemes,
          getTheme,
          applyTheme,
          refreshThemes,
          openThemesFolder,
        },
      }),
    }))

    await expect(fetchJson(`${baseUrl(server)}/api/themes`)).resolves.toEqual({
      success: true,
      themes: [{ id: 'flexoki' }],
    })
    await expect(fetchJson(`${baseUrl(server)}/api/themes/flexoki`)).resolves.toEqual({
      success: true,
      theme: { id: 'flexoki' },
    })
    await expect(fetchJson(`${baseUrl(server)}/api/themes/flexoki/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'light' }),
    })).resolves.toEqual({
      success: true,
      cssVariables: {
        '--theme-id': 'flexoki',
        '--theme-mode': 'light',
      },
    })
    await expect(fetchJson(`${baseUrl(server)}/api/themes/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectPath: '/workspace' }),
    })).resolves.toEqual({
      success: true,
      themes: [],
      projectPath: '/workspace',
    })
    await expect(fetchJson(`${baseUrl(server)}/api/themes/open-folder`, {
      method: 'POST',
    })).resolves.toEqual({
      success: false,
      error: 'not available',
    })

    expect(getTheme).toHaveBeenCalledWith('flexoki', expect.objectContaining({
      userId: 'local-user',
      workspaceId: 'default',
    }))
    expect(applyTheme).toHaveBeenCalledWith('flexoki', 'light', expect.any(Object))
    expect(refreshThemes).toHaveBeenCalledWith('/workspace', expect.any(Object))
    expect(openThemesFolder).toHaveBeenCalledWith(expect.any(Object))
  })

  it('exposes sandboxed read-only tool routes for the web runtime', async () => {
    const workspaceRoot = await createTempDir('onething-server-tools-')
    const serverRuntime = await createTestServerRuntime({ workspaceRoot })
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
    }))
    const aliceHeaders = contextHeaders('alice', 'tool-workspace')
    const bobHeaders = contextHeaders('bob', 'tool-workspace')
    const created = await createSession(baseUrl(server), 'Tool session', aliceHeaders)
    const sessionId = created.session?.id
    expect(sessionId).toBeTruthy()

    const aliceWorkspaceRoot = join(workspaceRoot, 'alice', 'tool-workspace')
    const bobWorkspaceRoot = join(workspaceRoot, 'bob', 'tool-workspace')
    await mkdir(join(aliceWorkspaceRoot, 'notes'), { recursive: true })
    await mkdir(bobWorkspaceRoot, { recursive: true })
    await writeFile(join(aliceWorkspaceRoot, 'notes', 'a.txt'), 'alpha\nneedle here\n', 'utf8')
    await writeFile(join(aliceWorkspaceRoot, 'notes', 'b.ts'), 'const value = "needle";\n', 'utf8')
    await writeFile(join(bobWorkspaceRoot, 'secret.txt'), 'bob secret\n', 'utf8')

    const tools = await fetchJson(`${baseUrl(server)}/api/tools`, { headers: aliceHeaders })
    expect(tools.success).toBe(true)
    /*
     * R4b(§15.6 ⑧):假路那份本地注册表(只装一只 read)换成了
     * `createReadonlyCatalog()` —— 只读档的真实内容是四只零本地副作用的工具。
     * **执行面没有变宽**:`serverReadOnlyToolIds` 白名单仍然只有 `read`,下面
     * 那几条断言逐条钉着这件事。
     */
    expect(tools.tools.map((tool: { id: string }) => tool.id).sort())
      .toEqual(['read', 'time', 'web_open', 'web_search'])

    const readResult = await fetchJson(`${baseUrl(server)}/api/tools/execute`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        toolId: 'read',
        arguments: { path: 'notes/a.txt' },
        messageId: 'message-1',
        sessionId,
      }),
    })
    expect(readResult.success).toBe(true)
    expect(readResult.result.output).toContain('needle here')

    for (const retired of ['glob', 'grep']) {
      const retiredResult = await fetchJson(`${baseUrl(server)}/api/tools/execute`, {
        method: 'POST',
        headers: { ...aliceHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          toolId: retired,
          arguments: { pattern: '**/*.txt' },
          messageId: 'message-1',
          sessionId,
        }),
      })
      expect(retiredResult.success).toBe(false)
    }

    await expect(fetchJson(`${baseUrl(server)}/api/tools/execute`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        toolId: 'bash',
        arguments: { command: 'pwd' },
        messageId: 'message-1',
        sessionId,
      }),
    })).resolves.toEqual({
      success: false,
      error: 'Tool execution for "bash" is disabled in the web server runtime.',
    })

    await expect(fetchJson(`${baseUrl(server)}/api/tools/execute`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        toolId: 'read',
        arguments: { path: join(bobWorkspaceRoot, 'secret.txt') },
        messageId: 'message-1',
        sessionId,
      }),
    })).resolves.toEqual({
      success: false,
      error: 'Tool "read" can only access paths inside the session workspace.',
    })

    await expect(fetchJson(`${baseUrl(server)}/api/tools/execute`, {
      method: 'POST',
      headers: { ...bobHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        toolId: 'read',
        arguments: { path: 'notes/a.txt' },
        messageId: 'message-1',
        sessionId,
      }),
    })).resolves.toEqual({
      success: false,
      error: 'Session not found',
    })

    await expect(fetchJson(`${baseUrl(server)}/api/tools/cancel`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ toolCallId: 'tool-1' }),
    })).resolves.toEqual({ success: true })
    await expect(fetchJson(`${baseUrl(server)}/api/tools/background-jobs?includeInactive=true`, {
      headers: aliceHeaders,
    })).resolves.toEqual({
      success: true,
      jobs: [],
    })
    await expect(fetchJson(`${baseUrl(server)}/api/tools/background-jobs/job-1/stop`, {
      method: 'POST',
      headers: aliceHeaders,
    })).resolves.toEqual({
      success: false,
      error: 'Background jobs are not available in the web server runtime.',
    })
  })

  it('runs the development runtime through session commands and SSE streams', async () => {
    const serverRuntime = await createTestServerRuntime()
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      runtime: serverRuntime.runtime,
    }))

    const createResponse = await fetch(`${baseUrl(server)}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Web smoke' }),
    })
    const created = await createResponse.json() as { success: boolean; session?: { id: string } }
    expect(created.success).toBe(true)
    const sessionId = created.session?.id
    expect(sessionId).toBeTruthy()
    expect(created.session).not.toHaveProperty('userId')
    expect(created.session).not.toHaveProperty('workspaceId')

    const eventsResponse = await fetch(`${baseUrl(server)}/api/events?sessionId=${encodeURIComponent(sessionId!)}`)
    expect(eventsResponse.status).toBe(200)

    await expect(sendSessionCommand(serverRuntime, sessionId!, {
      type: 'command:send-message',
      content: 'hello web',
    })).resolves.toEqual({ success: true })

    const sse = await readUntil(eventsResponse, text => (
      text.includes('event: session:stream') && text.includes('"type":"stream:complete"')
    ))
    expect(sse).toContain('event: session:event')
    expect(sse).toContain('event: session:stream')
    expect(sse).toContain('Echo:')
  })

  it('reuses retry and edit-and-resend commands through the development runtime', async () => {
    const serverRuntime = await createTestServerRuntime()
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      runtime: serverRuntime.runtime,
    }))
    const baseUrlValue = baseUrl(server)
    const created = await createSession(baseUrlValue, 'Command reuse', {})
    const sessionId = created.session?.id
    expect(sessionId).toBeTruthy()

    let eventsResponse = await fetch(`${baseUrlValue}/api/sessions/${encodeURIComponent(sessionId!)}/events`)
    await expect(sendSessionCommand(serverRuntime, sessionId!, {
      type: 'command:send-message',
      content: 'first',
    })).resolves.toEqual({ success: true })
    await readUntil(eventsResponse, text => text.includes('"type":"stream:complete"'))

    let messages = await getSessionMessages(baseUrlValue, sessionId!)
    expect(messages.map(message => `${message.role}:${message.content}`)).toEqual([
      'user:first',
      'assistant:Echo: first',
    ])

    eventsResponse = await fetch(`${baseUrlValue}/api/sessions/${encodeURIComponent(sessionId!)}/events`)
    await expect(sendSessionCommand(serverRuntime, sessionId!, {
      type: 'command:retry-message',
      messageId: messages[1].id,
    })).resolves.toEqual({ success: true })
    const retrySse = await readUntil(eventsResponse, text => text.includes('"type":"stream:complete"'))
    expect(retrySse).toContain('messages:replaced')

    messages = await getSessionMessages(baseUrlValue, sessionId!)
    expect(messages.map(message => `${message.role}:${message.content}`)).toEqual([
      'user:first',
      'assistant:Echo: first',
    ])

    eventsResponse = await fetch(`${baseUrlValue}/api/sessions/${encodeURIComponent(sessionId!)}/events`)
    await expect(sendSessionCommand(serverRuntime, sessionId!, {
      type: 'command:edit-and-resend',
      messageId: messages[0].id,
      newContent: 'edited',
    })).resolves.toEqual({ success: true })
    const editSse = await readUntil(eventsResponse, text => text.includes('"type":"stream:complete"'))
    expect(editSse).toContain('messages:replaced')

    messages = await getSessionMessages(baseUrlValue, sessionId!)
    expect(messages.map(message => `${message.role}:${message.content}`)).toEqual([
      'user:edited',
      'assistant:Echo: edited',
    ])
  })

  it('uses the onething desktop settings file by default', async () => {
    const storeRoot = await createTempDir('onething-desktop-settings-')
    const originalStorePath = process.env.ONETHING_STORE_PATH
    process.env.ONETHING_STORE_PATH = storeRoot
    await writeFile(join(storeRoot, 'settings.json'), `${JSON.stringify({
      theme: 'light',
      ai: {
        provider: 'openai',
        providers: {
          openai: {
            apiKey: 'sk-desktop-secret',
            model: 'gpt-4o',
            selectedModels: ['gpt-4o'],
          },
        },
      },
    })}\n`, 'utf8')

    try {
      const serverRuntime = await createTestServerRuntime({
        dataRoot: await createTempDir('onething-server-data-'),
      })
      runtimes.push(serverRuntime)

      const response = await serverRuntime.runtime.settings!.get() as SettingsResponse

      expect(response.settings).toEqual(expect.objectContaining({
        theme: 'light',
      }))
      expect(response.settings?.ai.provider).toBe('openai')
      expect(response.settings?.ai.providers.openai.model).toBe('gpt-4o')
      expect(response.settings?.ai.providers.openai.apiKey).toBe(SERVER_REDACTED_SECRET)
      expect(JSON.stringify(response.settings)).not.toContain('sk-desktop-secret')
    } finally {
      if (originalStorePath === undefined) delete process.env.ONETHING_STORE_PATH
      else process.env.ONETHING_STORE_PATH = originalStorePath
    }
  })

  it('uses the onething desktop app state and chat sessions by default', async () => {
    const storeRoot = await createTempDir('onething-desktop-sessions-')
    const originalStorePath = process.env.ONETHING_STORE_PATH
    process.env.ONETHING_STORE_PATH = storeRoot
    const sessionsDir = join(storeRoot, 'sessions')
    await mkdir(sessionsDir, { recursive: true })

    const now = Date.now()
    const session = {
      id: 'desktop-session-1',
      name: 'Desktop Session',
      createdAt: now - 1000,
      updatedAt: now,
      agentId: 'default',
      lastProvider: 'openai',
      lastModel: 'gpt-4o',
      messages: [
        {
          id: 'message-user-1',
          sessionId: 'desktop-session-1',
          role: 'user',
          content: 'hello from desktop json',
          timestamp: now - 500,
        },
        {
          id: 'message-assistant-1',
          sessionId: 'desktop-session-1',
          role: 'assistant',
          content: 'hello from web',
          timestamp: now,
        },
      ],
    }

    await writeFile(join(storeRoot, 'app-state.json'), `${JSON.stringify({
      currentSessionId: session.id,
      currentWorkspaceId: null,
    })}\n`, 'utf8')
    await writeFile(join(sessionsDir, 'index.json'), `${JSON.stringify([{
      id: session.id,
      name: session.name,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      agentId: session.agentId,
      lastProvider: session.lastProvider,
      lastModel: session.lastModel,
      messageCount: session.messages.length,
      previewText: session.messages[0].content,
    }])}\n`, 'utf8')
    await writeFile(join(sessionsDir, `${session.id}.json`), `${JSON.stringify(session)}\n`, 'utf8')

    try {
      const serverRuntime = await createTestServerRuntime({
        dataRoot: await createTempDir('onething-server-data-'),
      })
      runtimes.push(serverRuntime)
      const server = await listen(createOnethingHttpServer({
        runtime: serverRuntime.runtime,
      }))
      const baseUrlValue = baseUrl(server)

      // app-state 域已迁到通用 RPC 通道(P4c),`GET /api/app-state` 不再存在;
      // 同一份 `app-state.json` 现在经 `POST /api/rpc` 的 appState.get 读出来。
      // 这个 fixture 的 runtime 是手搭的,不走 `registerAppRpcDomains`,所以域要
      // 自己挂一下 —— 挂的是**真** handler,读的正是 ONETHING_STORE_PATH 那份。
      const { registerAppStateRpcDomain } = await import('../../rpc/domains/app-state.js')
      const disposeAppStateDomain = registerAppStateRpcDomain()
      await expect(fetchJson(`${baseUrlValue}/api/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain: 'appState', method: 'get', payload: {} }),
      })).resolves.toEqual(expect.objectContaining({
        ok: true,
        data: expect.objectContaining({ currentSessionId: session.id }),
      }))
      disposeAppStateDomain()

      const list = await fetchJson(`${baseUrlValue}/api/sessions`)
      expect(list.sessions).toEqual([
        expect.objectContaining({
          id: session.id,
          name: session.name,
          messageCount: 2,
        }),
      ])

      const messages = await getSessionMessages(baseUrlValue, session.id)
      expect(messages.map(message => `${message.role}:${message.content}`)).toEqual([
        'user:hello from desktop json',
        'assistant:hello from web',
      ])
    } finally {
      if (originalStorePath === undefined) delete process.env.ONETHING_STORE_PATH
      else process.env.ONETHING_STORE_PATH = originalStorePath
    }
  })

  it('stores web settings per user/workspace owner in the server runtime', async () => {
    const settingsRoot = await createTempDir('onething-server-settings-')
    const serverRuntime = await createTestServerRuntime({ settingsRoot })
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
    }))

    const aliceHeaders = contextHeaders('alice', 'settings-a')
    const bobHeaders = contextHeaders('bob', 'settings-a')
    const aliceOtherWorkspaceHeaders = contextHeaders('alice', 'settings-b')

    const aliceInitial = await fetchJson(`${baseUrl(server)}/api/settings`, { headers: aliceHeaders })
    expect(aliceInitial.settings).toEqual(expect.objectContaining({
      theme: 'dark',
    }))

    const saved = await fetchJson(`${baseUrl(server)}/api/settings`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({
        theme: 'light',
        general: {
          typographyDensity: 'comfortable',
        },
        ai: {
          providers: {
            openai: {
              apiKey: 'sk-alice-secret',
              model: 'gpt-4o',
              selectedModels: [],
            },
            codex: {
              authType: 'oauth',
              model: 'gpt-5.3-codex',
              selectedModels: [],
              oauthToken: {
                accessToken: 'access-alice-secret',
                refreshToken: 'refresh-alice-secret',
                expiresAt: 12345,
                tokenType: 'Bearer',
                idToken: 'id-alice-secret',
              },
            },
          },
        },
      }),
    })
    expect(saved.settings).toEqual(expect.objectContaining({
      theme: 'light',
      general: expect.objectContaining({
        typographyDensity: 'comfortable',
      }),
      tools: expect.any(Object),
    }))
    expect(saved.settings.ai.providers.openai.apiKey).toBe(SERVER_REDACTED_SECRET)
    expect(saved.settings.ai.providers.codex.oauthToken).toBe(SERVER_REDACTED_SECRET)
    expect(JSON.stringify(saved.settings)).not.toContain('sk-alice-secret')
    expect(JSON.stringify(saved.settings)).not.toContain('access-alice-secret')

    const aliceAgain = await fetchJson(`${baseUrl(server)}/api/settings`, { headers: aliceHeaders })
    expect(aliceAgain.settings).toEqual(expect.objectContaining({
      theme: 'light',
      general: expect.objectContaining({
        typographyDensity: 'comfortable',
      }),
    }))
    expect(aliceAgain.settings.ai.providers.openai.apiKey).toBe(SERVER_REDACTED_SECRET)
    expect(aliceAgain.settings.ai.providers.codex.oauthToken).toBe(SERVER_REDACTED_SECRET)
    expect(JSON.stringify(aliceAgain.settings)).not.toContain('sk-alice-secret')
    expect(JSON.stringify(aliceAgain.settings)).not.toContain('access-alice-secret')

    const bobSettings = await fetchJson(`${baseUrl(server)}/api/settings`, { headers: bobHeaders })
    const aliceOtherWorkspaceSettings = await fetchJson(`${baseUrl(server)}/api/settings`, {
      headers: aliceOtherWorkspaceHeaders,
    })
    expect(bobSettings.settings).toEqual(expect.objectContaining({ theme: 'dark' }))
    expect(bobSettings.settings.ai.providers.openai.apiKey).toBe('')
    expect(aliceOtherWorkspaceSettings.settings).toEqual(expect.objectContaining({ theme: 'dark' }))
    expect(aliceOtherWorkspaceSettings.settings.ai.providers.openai.apiKey).toBe('')
  })

  it('tests network proxy settings through the development server runtime', async () => {
    const serverRuntime = await createTestServerRuntime()
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
    }))

    await expect(fetchJson(`${baseUrl(server)}/api/network/test-proxy`, {
      method: 'POST',
      headers: {
        ...contextHeaders('alice', 'network-dev-workspace'),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        proxy: {
          enabled: false,
          url: '',
        },
      }),
    })).resolves.toEqual({
      success: false,
      error: 'Proxy is disabled.',
    })
  })

  it('redacts server settings secrets and preserves them when clients save sanitized settings', () => {
    const previous = createDefaultSettings()
    previous.ai.providers.openai.apiKey = 'sk-real-openai'
    previous.ai.providers.codex.oauthToken = {
      accessToken: 'access-real-codex',
      refreshToken: 'refresh-real-codex',
      expiresAt: 12345,
      tokenType: 'Bearer',
      idToken: 'id-real-codex',
    }
    previous.mcp = {
      enabled: true,
      servers: [{
        id: 'mcp-secret-server',
        name: 'Secret MCP',
        transport: 'stdio',
        enabled: true,
        command: 'npx',
        args: ['-y', '@private/mcp-server'],
        cwd: '/srv/private-workspace',
        env: {
          MCP_TOKEN: 'mcp-env-secret',
        },
        headers: {
          Authorization: 'Bearer mcp-header-secret',
        },
      }],
    }

    const sanitized = sanitizeSettingsForClient(previous)
    expect(sanitized.ai.providers.openai.apiKey).toBe(SERVER_REDACTED_SECRET)
    expect(sanitized.ai.providers.codex.oauthToken).toBe(SERVER_REDACTED_SECRET)
    expect(sanitized.mcp?.servers[0]).toEqual(expect.objectContaining({
      command: SERVER_REDACTED_SECRET,
      args: SERVER_REDACTED_SECRET,
      cwd: SERVER_REDACTED_SECRET,
      env: SERVER_REDACTED_SECRET,
      headers: SERVER_REDACTED_SECRET,
    }))
    expect(JSON.stringify(sanitized)).not.toContain('sk-real-openai')
    expect(JSON.stringify(sanitized)).not.toContain('access-real-codex')
    expect(JSON.stringify(sanitized)).not.toContain('mcp-env-secret')
    expect(JSON.stringify(sanitized)).not.toContain('mcp-header-secret')

    sanitized.theme = 'light'
    const merged = mergeServerSettingsUpdate(previous, sanitized)
    expect(merged.theme).toBe('light')
    expect(merged.ai.providers.openai.apiKey).toBe('sk-real-openai')
    expect(merged.ai.providers.codex.oauthToken).toEqual(previous.ai.providers.codex.oauthToken)
    expect(merged.mcp?.servers[0]).toEqual(previous.mcp.servers[0])

    const cleared = mergeServerSettingsUpdate(previous, {
      ...sanitized,
      ai: {
        ...sanitized.ai,
        providers: {
          ...sanitized.ai.providers,
          openai: {
            ...sanitized.ai.providers.openai,
            apiKey: '',
          },
        },
      },
      mcp: {
        ...sanitized.mcp,
        servers: [{
          ...sanitized.mcp?.servers[0],
          env: {},
        }],
      },
    })
    expect(cleared.ai.providers.openai.apiKey).toBe('')
    expect(cleared.ai.providers.codex.oauthToken).toEqual(previous.ai.providers.codex.oauthToken)
    expect(cleared.mcp?.servers[0].env).toEqual({})
    expect(cleared.mcp?.servers[0].headers).toEqual(previous.mcp.servers[0].headers)

    const partial = mergeServerSettingsUpdate(previous, { theme: 'dark' })
    expect(partial.mcp).toEqual(previous.mcp)
  })

  it('persists owner-scoped server settings outside the browser-facing payload', async () => {
    const settingsRoot = await createTempDir('onething-server-settings-')
    const aliceContext = { userId: 'alice', workspaceId: 'settings-persist' }
    const baseSettings = createDefaultSettings()
    const firstRuntime = await createTestServerRuntime({ settingsRoot })
    runtimes.push(firstRuntime)

    const saved = await firstRuntime.runtime.settings!.update({
      ...baseSettings,
      theme: 'light',
      ai: {
        ...baseSettings.ai,
        providers: {
          ...baseSettings.ai.providers,
          openai: {
            ...baseSettings.ai.providers.openai,
            apiKey: 'sk-persisted-openai',
          },
        },
      },
      mcp: {
        enabled: true,
        servers: [{
          id: 'persisted-mcp',
          name: 'Persisted MCP',
          transport: 'sse',
          enabled: true,
          url: 'https://mcp.example.test/sse?token=mcp-url-secret',
          headers: {
            Authorization: 'Bearer mcp-persisted-header',
          },
        }],
      },
    }, aliceContext) as SettingsResponse
    expect(saved).toEqual(expect.objectContaining({
      success: true,
      settings: expect.objectContaining({
        theme: 'light',
      }),
    }))
    await firstRuntime.shutdown()
    runtimes.splice(runtimes.indexOf(firstRuntime), 1)

    const persisted = await readFile(join(settingsRoot, 'alice', 'settings-persist.json'), 'utf8')
    expect(persisted).toContain('sk-persisted-openai')
    expect(persisted).toContain('mcp-persisted-header')
    expect(persisted).not.toContain(SERVER_REDACTED_SECRET)

    const secondRuntime = await createTestServerRuntime({ settingsRoot })
    runtimes.push(secondRuntime)
    const aliceSettings = await secondRuntime.runtime.settings!.get(aliceContext) as SettingsResponse
    const bobSettings = await secondRuntime.runtime.settings!.get({
      userId: 'bob',
      workspaceId: 'settings-persist',
    }) as SettingsResponse

    expect(aliceSettings.settings).toEqual(expect.objectContaining({ theme: 'light' }))
    expect(aliceSettings.settings?.ai.providers.openai.apiKey).toBe(SERVER_REDACTED_SECRET)
    expect(aliceSettings.settings?.mcp?.servers[0].url).toBe(SERVER_REDACTED_SECRET)
    expect(aliceSettings.settings?.mcp?.servers[0].headers).toBe(SERVER_REDACTED_SECRET)
    expect(JSON.stringify(aliceSettings.settings)).not.toContain('sk-persisted-openai')
    expect(JSON.stringify(aliceSettings.settings)).not.toContain('mcp-persisted-header')
    expect(bobSettings.settings).toEqual(expect.objectContaining({ theme: 'dark' }))
    expect(bobSettings.settings?.ai.providers.openai.apiKey).toBe('')
  })

  // P4c 第五批:「按会话改设置」的六条 REST(archive / working-directory / agent /
  // permission-mode / model 与按 id 取会话)已随 `sessionsRouter` 迁走 —— server 侧
  // 那份 per-owner 的第二实现连同它的沙箱根校验一起没有了(语义变化,见方案文档)。
  // `sessions.update` 仍在,但它今天只服务 `max-tokens` 一条;它的账本翻译由
  // `__tests__/session-agent-event.test.ts` 直接对着 facade 钉。

	  it('isolates sessions and SSE streams by user/workspace context', async () => {
    const serverRuntime = await createTestServerRuntime()
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
    }))

    const aliceHeaders = contextHeaders('alice', 'workspace-a')
    const bobHeaders = contextHeaders('bob', 'workspace-a')
    const created = await createSession(baseUrl(server), 'Alice only', aliceHeaders)
    const sessionId = created.session?.id
    expect(sessionId).toBeTruthy()

    const aliceList = await fetchJson(`${baseUrl(server)}/api/sessions`, { headers: aliceHeaders })
    const bobList = await fetchJson(`${baseUrl(server)}/api/sessions`, { headers: bobHeaders })
    expect(aliceList.sessions?.map((session: { id: string }) => session.id)).toContain(sessionId)
    expect(bobList.sessions ?? []).toHaveLength(0)

    const bobEvents = await fetch(`${baseUrl(server)}/api/events?sessionId=${encodeURIComponent(sessionId!)}`, {
      headers: bobHeaders,
    })
    expect(bobEvents.status).toBe(200)
    const bobSessionEvents = await fetch(`${baseUrl(server)}/api/sessions/${encodeURIComponent(sessionId!)}/events`, {
      headers: bobHeaders,
    })
    expect(bobSessionEvents.status).toBe(200)

    // 命令的 per-owner 前置检查随被删掉的 adapter 一起没了(域取的是桌面的形状,
    // 见 `backend/rpc/domains/session-command.ts` 文件头);这条用例守的是**事件
    // 扇出**的隔离 —— 别人的会话里发生的事不许漏进 bob 的两条 SSE。
    await sendSessionCommand(serverRuntime, sessionId!, {
      type: 'command:send-message',
      content: 'secret',
    })

    const [bobSse, bobSessionSse] = await Promise.all([
      readFor(bobEvents, 120),
      readFor(bobSessionEvents, 120),
    ])
    expect(bobSse).not.toContain('secret')
    expect(bobSse).not.toContain('session:event')
    expect(bobSse).not.toContain('session:stream')
    expect(bobSessionSse).not.toContain('secret')
    expect(bobSessionSse).not.toContain('session:event')
	    expect(bobSessionSse).not.toContain('session:stream')
	  })

	  /**
	   * 片段的增删改查已迁到通用 RPC 通道(promptsRouter),`/api/prompts*` 五条路由
	   * 连同 server 的 per-owner 片段库一起拔除。这条测试把**新事实**钉住:那些
	   * 路径必须是 404,而不是悄悄留一条旧轨。
	   *
	   * 原测试断言的是 alice/bob 各自一份片段库——那条隔离随路由一起没了(信封不带
	   * request context,单用户前提下三宿主共用 `<store>/prompts.json`)。域本身的
	   * 行为改由 `packages/backend/rpc/__tests__/prompts-domain.test.ts` 守。
	   */
	  it('no longer serves the retired /api/prompts REST surface', async () => {
	    const dataRoot = await createTempDir('onething-prompts-')
	    const serverRuntime = await createTestServerRuntime({ dataRoot })
	    runtimes.push(serverRuntime)
	    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
	      runtime: serverRuntime.runtime,
	    }))

	    const aliceHeaders = contextHeaders('alice', 'workspace-prompts')
	    await expect(fetchJson(`${baseUrl(server)}/api/prompts`, {
	      headers: aliceHeaders,
	    })).resolves.toEqual({ success: false, error: 'Not found' })
	    await expect(fetchJson(`${baseUrl(server)}/api/prompts/prompt-1`, {
	      headers: aliceHeaders,
	    })).resolves.toEqual({ success: false, error: 'Not found' })
	  })

	  it('routes permission responses back into the session command stream with ownership checks', async () => {
    const serverRuntime = await createTestServerRuntime()
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
    }))

    const aliceHeaders = contextHeaders('alice', 'workspace-permissions')
    const bobHeaders = contextHeaders('bob', 'workspace-permissions')
    const created = await createSession(baseUrl(server), 'Permission session', aliceHeaders)
    const sessionId = created.session?.id
    expect(sessionId).toBeTruthy()

    let permissionCommand: any
    const unsubscribe = (serverRuntime.eventBus as any).onAnySession('command:permission-respond', (envelope: any) => {
      permissionCommand = envelope
    })

    await (serverRuntime.eventBus as any).emit(sessionId!, {
      type: 'permission:request',
      requestId: 'permission-1',
      targetChannel: 'api',
      toolCallId: 'tool-1',
      messageId: 'message-1',
      permissionType: 'bash',
      title: 'Run command',
      metadata: {},
    })

    const bobResponse = await fetchJson(`${baseUrl(server)}/api/permissions/permission-1/respond`, {
      method: 'POST',
      headers: { ...bobHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'once' }),
    })
    expect(bobResponse).toEqual({ success: false, error: 'Permission request not found' })
    expect(permissionCommand).toBeUndefined()

    const aliceResponse = await fetchJson(`${baseUrl(server)}/api/permissions/permission-1/respond`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'once' }),
    })
    expect(aliceResponse).toEqual({ success: true })
    expect(permissionCommand).toEqual(expect.objectContaining({
      sessionId,
      event: {
        type: 'command:permission-respond',
        channel: 'api',
        requestId: 'permission-1',
        decision: 'once',
      },
    }))

    unsubscribe()
  })

  /**
   * 结构债 P4c:活询问的读/清整只迁到 `permission` RPC 域,
   * `/api/sessions/:id/permissions/{pending,clear}` 两条路由与它们背后的
   * `permissions.getPending` / `permissions.clearSession` adapter 一起删了 ——
   * 这条端到端断言随之退役。它测的两件事都随实现消失:
   *  - server 自己维护的 `pendingPermissions` 镜像(只在 `persistsMessages` 为假的
   *    回声后端上有读者,真引擎那侧一直是 `Permission.getPendingPrompts`);
   *  - adapter 里那道「会话不属于这个 owner → Session not found」的归属护栏 ——
   *    桌面那条实现从来没有它,搬家取的是桌面的形状(见
   *    `app/rpc/domains/permission.ts` 的文件头,那里逐条记了这两处差异)。
   * 新路的用例在 `app/rpc/__tests__/permission-domain.test.ts`。
   */

  /**
   * 主线 T 批 3：授权账页迁到通用 RPC 通道，这条端到端断言跟着改走
   * `POST /api/rpc`。归属护栏（跨 owner 看不见、越界工作区根被拒）由
   * `app/rpc/domains/permission-grants.ts` 顶着,不再是 server 自己的
   * `canRevokePermissionGrant` —— 断言一条没减。
   */
  it('manages owner-scoped permission grants over the generic RPC route', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'onething-permissions-'))
    tempDirs.push(dataRoot)
    // 生产形态:HTTP 面与引擎面共用**同一个** app 会话库。归属校验搬进
    // `@onething/backend` 之后它读的就是这一份 —— echo backend 默认那份独立的
    // 内存库会让「同一个 server 两本账」的老毛病在测试里假绿。
    const serverRuntime = await createTestServerRuntime({
      dataRoot,
      sessionStore: createAppBackedServerSessionStore(),
    })
    runtimes.push(serverRuntime)
    const disposeDomain = registerPermissionGrantsRpcDomain()
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
      workspaceRoot: serverRuntime.workspaceRoot,
    }))
    const grantsRpc = async (headers: Record<string, string>, method: string, payload: unknown) => {
      const response = await fetchJson(`${baseUrl(server)}/api/rpc`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ domain: 'permissionGrants', method, payload }),
      })
      expect(response.ok).toBe(true)
      return response.data
    }

    const aliceHeaders = contextHeaders('alice', 'workspace-grants')
    const bobHeaders = contextHeaders('bob', 'workspace-grants')
    const created = await createSession(baseUrl(server), 'Grant session', aliceHeaders)
    const sessionId = created.session?.id
    const workspaceRoot = created.session?.workingDirectory
    expect(sessionId).toBeTruthy()
    expect(workspaceRoot).toBeTruthy()

    await (serverRuntime.eventBus as any).emit(sessionId!, {
      type: 'permission:request',
      requestId: 'permission-session-grant',
      targetChannel: 'api',
      toolCallId: 'tool-session',
      messageId: 'message-session',
      permissionType: 'bash',
      title: 'Run session command',
      pattern: 'git status',
      metadata: {},
    })
    await fetchJson(`${baseUrl(server)}/api/permissions/permission-session-grant/respond`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'session' }),
    })

    const listedSessionGrants = await grantsRpc(aliceHeaders, 'list', { sessionId })
    const sessionGrantId = listedSessionGrants.sessionGrants?.[0]?.id
    expect(listedSessionGrants).toEqual(expect.objectContaining({
      success: true,
      sessionGrants: [
        expect.objectContaining({
          scope: 'session',
          type: 'bash',
          sessionId,
          userId: 'alice',
          workspaceId: 'workspace-grants',
        }),
      ],
      workspaceGrants: [],
    }))
    expect(sessionGrantId).toBeTruthy()

    const bobSessionGrants = await grantsRpc(bobHeaders, 'list', { sessionId })
    expect(bobSessionGrants).toEqual({ success: false, error: 'Session not found' })

    await expect(grantsRpc(aliceHeaders, 'revoke', { id: sessionGrantId }))
      .resolves.toEqual({ success: true })

    await (serverRuntime.eventBus as any).emit(sessionId!, {
      type: 'permission:request',
      requestId: 'permission-workspace-grant',
      targetChannel: 'api',
      toolCallId: 'tool-workspace',
      messageId: 'message-workspace',
      permissionType: 'file_write',
      title: 'Write file',
      pattern: 'notes.md',
      metadata: {},
    })
    await fetchJson(`${baseUrl(server)}/api/permissions/permission-workspace-grant/respond`, {
      method: 'POST',
      headers: { ...aliceHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'workdir' }),
    })

    const listedWorkspaceGrants = await grantsRpc(aliceHeaders, 'list', { workspaceRoot })
    expect(listedWorkspaceGrants).toEqual(expect.objectContaining({
      success: true,
      sessionGrants: [],
      workspaceGrants: [
        expect.objectContaining({
          scope: 'workspace',
          type: 'file_write',
          workspaceRoot,
          userId: 'alice',
          workspaceId: 'workspace-grants',
        }),
      ],
    }))

    const bobWorkspaceGrants = await grantsRpc(bobHeaders, 'list', { workspaceRoot })
    expect(bobWorkspaceGrants).toEqual({
      success: false,
      error: 'Workspace root must stay inside the workspace sandbox root.',
    })

    await expect(grantsRpc(aliceHeaders, 'clearWorkspace', { workspaceRoot }))
      .resolves.toEqual({ success: true })

    const afterClear = await grantsRpc(aliceHeaders, 'list', { workspaceRoot })
    disposeDomain()
    expect(afterClear).toEqual({ success: true, sessionGrants: [], workspaceGrants: [] })
  })

  it('rejects identity headers when no auth token is configured', async () => {
    const serverRuntime = await createTestServerRuntime()
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      runtime: serverRuntime.runtime,
    }))

    const spoofed = await fetch(`${baseUrl(server)}/api/settings`, {
      headers: { 'x-onething-user-id': 'someone-else' },
    })
    expect(spoofed.status).toBe(401)

    const plain = await fetch(`${baseUrl(server)}/api/capabilities`)
    expect(plain.status).toBe(200)
  })

  it('requires a matching bearer token for every request when configured', async () => {
    const serverRuntime = await createTestServerRuntime()
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
    }))

    const missing = await fetch(`${baseUrl(server)}/api/capabilities`)
    expect(missing.status).toBe(401)

    const wrong = await fetch(`${baseUrl(server)}/api/capabilities`, {
      headers: { authorization: 'Bearer wrong-token' },
    })
    expect(wrong.status).toBe(401)

    const authorized = await fetch(`${baseUrl(server)}/api/capabilities`, {
      headers: { authorization: `Bearer ${TEST_SERVER_AUTH_TOKEN}` },
    })
    expect(authorized.status).toBe(200)
  })

  /**
   * `POST /api/streams/abort` —— P4c 第五批为 `apps/mobile` 保留的那条 REST
   * (拍板 #32)。要钉的是「它不是第二份实现」:请求折成 chat 域的信封,交给
   * **同一个** RPC 处理者,再把 `data` 拆回旧 body 的形状。mobile 换成
   * `/api/rpc` 的那天这条路由与这个用例一起消失。
   */
  it('serves the mobile-only /api/streams/abort as a thin adapter over the chat RPC domain', async () => {
    resetRpcRegistryForTests()
    const abortStream = vi.fn(async () => ({ success: true }))
    const dispose = registerRouterHandlers(chatRouter, {
      async getHistory() { return { success: true, messages: [] } },
      async generateTitle() { return { success: true, title: '' } },
      async getSystemPromptSnapshot() { return { success: false, error: 'not in this test' } },
      async updateMessageThinkingTime() { return { success: true } },
      abortStream,
      async getActiveStreams() { return { success: true, sessionIds: [] } },
    })
    const serverRuntime = await createTestServerRuntime()
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
      workspaceRoot: serverRuntime.workspaceRoot,
    }))

    try {
      await expect(fetchJson(`${baseUrl(server)}/api/streams/abort`, {
        method: 'POST',
        headers: {
          ...contextHeaders('alice', 'abort-workspace'),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sessionId: 'session-1' }),
      })).resolves.toEqual({ success: true })
      // 处理者收到的是**信封**,以及宿主自己铸的 dispatch context。
      expect(abortStream).toHaveBeenCalledWith({ sessionId: 'session-1' }, expect.objectContaining({
        transport: 'http',
        ownerUid: 'alice',
        workspaceId: 'abort-workspace',
      }))
    } finally {
      dispose()
      resetRpcRegistryForTests()
    }
  })

  /**
   * The generic RPC route (主线 T0). The server half is domain-blind: it
   * forwards the envelope to the assembly-layer dispatch table and serializes
   * whatever comes back. What is pinned here is that it sits behind the same
   * bearer gate as every other /api route, that a registered domain is
   * reachable, and that failures arrive as `{ ok:false }` bodies rather than
   * HTTP error codes (the renderer client is the only place that throws).
   */
  it('serves every domain router through the single POST /api/rpc route', async () => {
    resetRpcRegistryForTests()
    const echo = vi.fn(async (input: { value: string }) => ({ value: input.value.toUpperCase() }))
    const dispose = registerRouterHandlers(
      defineRouter<{
        echo: { input: { value: string }; output: { value: string } }
        boom: { input: void; output: void }
      }>('http-probe', ['echo', 'boom']),
      {
        echo,
        async boom() { throw new Error('handler exploded') },
      },
    )
    const serverRuntime = await createTestServerRuntime()
    runtimes.push(serverRuntime)
    const server = await listen(createOnethingHttpServer({
      authToken: TEST_SERVER_AUTH_TOKEN,
      runtime: serverRuntime.runtime,
      workspaceRoot: serverRuntime.workspaceRoot,
    }))
    const rpcUrl = `${baseUrl(server)}/api/rpc`
    const jsonHeaders = {
      ...contextHeaders('alice', 'rpc-workspace'),
      'content-type': 'application/json',
    }
    const post = (body: unknown) => fetchJson(rpcUrl, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(body),
    })

    try {
      const unauthorized = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ domain: 'http-probe', method: 'echo', payload: { value: 'hi' } }),
      })
      expect(unauthorized.status).toBe(401)

      await expect(post({ domain: 'http-probe', method: 'echo', payload: { value: 'hi' } }))
        .resolves.toEqual({ ok: true, data: { value: 'HI' } })
      // 主线 T 批 3：handler 拿到的第二个参数是**宿主铸的** dispatch context，
      // 不是请求体里的任何东西。这条断言是整个安全设计的落点：owner 来自已过
      // bearer 门的身份头，sandboxRoot 由 server 自己按 owner 算出来。
      expect(echo).toHaveBeenCalledWith({ value: 'hi' }, {
        transport: 'http',
        ownerUid: 'alice',
        workspaceId: 'rpc-workspace',
        sandboxRoot: join(serverRuntime.workspaceRoot, 'alice', 'rpc-workspace'),
      })

      // 客户端在信封里塞 context 是徒劳的：wire 上没有这个字段。
      await post({
        domain: 'http-probe',
        method: 'echo',
        payload: { value: 'spoof' },
        context: { transport: 'ipc', sandboxRoot: '/' },
      } as unknown as Record<string, unknown>)
      expect(echo).toHaveBeenLastCalledWith({ value: 'spoof' }, {
        transport: 'http',
        ownerUid: 'alice',
        workspaceId: 'rpc-workspace',
        sandboxRoot: join(serverRuntime.workspaceRoot, 'alice', 'rpc-workspace'),
      })

      await expect(post({ domain: 'nope', method: 'echo', payload: {} })).resolves.toEqual({
        ok: false,
        error: { message: 'Unknown RPC domain "nope"', code: 'UNKNOWN_DOMAIN' },
      })

      await expect(post({ domain: 'http-probe', method: 'nope', payload: {} })).resolves.toEqual({
        ok: false,
        error: { message: 'Unknown RPC method "http-probe.nope"', code: 'UNKNOWN_METHOD' },
      })

      await expect(post({ domain: 'http-probe', method: 'boom', payload: null })).resolves.toEqual({
        ok: false,
        error: { message: 'handler exploded' },
      })

      // Garbage body: still 200 + an RpcResponse, so one client-side branch
      // handles every failure shape.
      const malformed = await fetch(rpcUrl, {
        method: 'POST',
        headers: jsonHeaders,
        body: 'not json',
      })
      expect(malformed.status).toBe(200)
      const malformedBody = await malformed.json() as { ok: boolean; error: { code?: string } }
      expect(malformedBody.ok).toBe(false)
      expect(malformedBody.error.code).toBe('BAD_REQUEST')
    } finally {
      dispose()
      resetRpcRegistryForTests()
    }
  })
})

async function listen(server: Server): Promise<Server> {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

function contextHeaders(userId: string, workspaceId: string): Record<string, string> {
  return {
    'authorization': `Bearer ${TEST_SERVER_AUTH_TOKEN}`,
    'x-onething-user-id': userId,
    'x-onething-workspace-id': workspaceId,
  }
}

async function createTempDir(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(path)
  return path
}

async function createSession(
  baseUrlValue: string,
  name: string,
  headers: Record<string, string>,
): Promise<{ success: boolean; session?: { id: string; workingDirectory?: string } }> {
  return fetchJson(`${baseUrlValue}/api/sessions`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  })
}

/**
 * 结构债 P4c 第四批:`POST /api/sessions/:id/commands` 已随命令总线整只迁到
 * `session-command` RPC 域而删除,而这些用例跑的是**回声后端**(它有自己的
 * EventBus,而域打的是装配层那台单例),所以走不了 `/api/rpc`。
 *
 * 这些用例要证的本来也不是「那条路由存在」,而是「命令进了总线之后
 * server 的会话/事件/SSE 一路对得上」—— 于是这里直接往该 runtime 的总线上发,
 * 与被删掉的 adapter 里 `forwardSessionCommand` 逐字同义。传输面那一半由
 * `packages/backend/rpc/__tests__/session-command-domain.test.ts` 守。
 */
async function sendSessionCommand(
  serverRuntime: OnethingServerRuntime,
  sessionId: string,
  command: unknown,
): Promise<{ success: boolean }> {
  await (serverRuntime.eventBus as any).emit(sessionId, command)
  return { success: true }
}

async function getSessionMessages(
  baseUrlValue: string,
  sessionId: string,
  headers: Record<string, string> = {},
): Promise<Array<{ id: string; role: string; content: string }>> {
  const response = await fetchJson(`${baseUrlValue}/api/session-messages/page`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, limit: 20 }),
  })
  return response.messages ?? []
}

async function postSessionAction(
  baseUrlValue: string,
  sessionId: string,
  action: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<any> {
  return fetchJson(`${baseUrlValue}/api/sessions/${encodeURIComponent(sessionId)}/${action}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init)
  return response.json()
}

function baseUrl(server: Server): string {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port')
  return `http://${address.address}:${address.port}`
}

async function readFirstChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Response body is not readable')
  const { value } = await reader.read()
  await reader.cancel()
  if (!value) return ''
  return new TextDecoder().decode(value)
}

async function readUntil(
  response: Response,
  predicate: (text: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Response body is not readable')
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + timeoutMs

  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now())
      const result = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => {
          setTimeout(() => resolve({ done: true, value: undefined }), remaining)
        }),
      ])
      if (result.done) break
      text += decoder.decode(result.value, { stream: true })
      if (predicate(text)) return text
    }
    throw new Error(`Timed out waiting for SSE payload. Received: ${text}`)
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/** Extracts the SSE id of the frame whose data mentions the given event type. */
function sseIdFor(sseText: string, eventType: string): number {
  const match = new RegExp(`id: (\\d+)\\nevent: session:event\\ndata: [^\\n]*${eventType}`).exec(sseText)
  if (!match) throw new Error(`missing SSE frame for ${eventType}: ${sseText}`)
  return Number(match[1])
}

async function readFor(response: Response, durationMs: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Response body is not readable')
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + durationMs

  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now())
      const result = await Promise.race([
        reader.read(),
        new Promise<ReadableStreamReadResult<Uint8Array>>(resolve => {
          setTimeout(() => resolve({ done: true, value: undefined }), remaining)
        }),
      ])
      if (result.done) break
      text += decoder.decode(result.value, { stream: true })
    }
    return text
  } finally {
    await reader.cancel().catch(() => {})
  }
}

