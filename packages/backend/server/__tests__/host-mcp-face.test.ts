/**
 * ACP A4-a:桥凭据在活核 HTTP 面上的两条路,对一台**真 backend**(`createOnethingBackend`)
 * 与真 `http.ts` 请求处理器。
 *
 * 这是 `gate:acp` ⑰⑱ 在 A4-b(connector 把 `mcpServers` 递给 agent)落地之前的单测级证明:
 * 凭据由 `backend.acp.hostMcpBridge.mintCredential` 直接签(没有也不许有「签凭据」的测试专用
 * RPC),其余全是 agent 那一侧真会走的路 ——
 *
 *  ⑰′ stdio 桥:用真配方打出 `acp-mcp-bridge.cjs`,node 起它,真 MCP 客户端 `tools/list` 看到
 *     `send_notification`,`tools/call` 让一条 `agent:notification` 落在发起会话上;
 *  ⑱′ 归因与作废:用户 token 调 `host-mcp` → 拒;桥凭据调别的域 → 403;`/api/mcp` 只认桥凭据;
 *     作废之后同一把钥匙 → `/api/rpc` 401、`/api/mcp` 401。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import type { Server } from 'node:http'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { AgentNotificationEvent } from '@shared/events/index.js'
import { HOST_MCP_UNAUTHORIZED } from '@shared/ipc/host-mcp.js'
import { HOST_MCP_BRIDGE_ENV } from '@onething/backend/runtime/acp/mcp-bridge/server'
import { createOnethingHttpServer } from '../http.js'
import { createAppServerRuntime } from './test-helpers.js'
import type { OnethingServerRuntime } from '../runtime.js'

const USER_TOKEN = 'user-secret'
const repoRoot = path.resolve(__dirname, '../../../..')

let dir: string
let runtime: OnethingServerRuntime
let server: Server
let origin: string
let sessionId: string
let bundleDir: string
let bundle: string
const notifications: AgentNotificationEvent[] = []
const previousStore = process.env.ONETHING_STORE_PATH

function bridge() {
  return runtime.backend!.acp.hostMcpBridge
}

async function rpc(token: string, domain: string, method: string, payload: unknown = {}) {
  const response = await fetch(`${origin}/api/rpc`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ domain, method, payload }),
  })
  return { status: response.status, body: await response.json() as { ok?: boolean; data?: unknown; error?: { message?: string } } }
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-mcp-face-'))
  process.env.ONETHING_STORE_PATH = dir
  runtime = await createAppServerRuntime({ storePath: dir, dataRoot: dir })
  runtime.backend!.eventBus.onGlobal('agent:notification', envelope => {
    notifications.push((envelope as unknown as { event: AgentNotificationEvent }).event)
  })
  server = createOnethingHttpServer({ runtime: runtime.runtime, authToken: USER_TOKEN })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const created = await fetch(`${origin}/api/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${USER_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'acp session' }),
  })
  sessionId = (await created.json() as { session: { id: string } }).session.id

  bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-mcp-face-bundle-'))
  const recipe = await import(pathToFileURL(path.join(repoRoot, 'apps/desktop-react/scripts/build-electron.mjs')).href) as {
    acpMcpBridgeEsbuildOptions(options: { outdir: string; repoRoot: string }): Record<string, unknown>
  }
  const { build } = await import('esbuild')
  await build({ ...recipe.acpMcpBridgeEsbuildOptions({ outdir: bundleDir, repoRoot }), logLevel: 'silent', sourcemap: false })
  bundle = path.join(bundleDir, 'acp-mcp-bridge.cjs')
}, 180_000)

afterAll(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()))
  await runtime?.shutdown()
  if (previousStore === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStore
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(bundleDir, { recursive: true, force: true })
})

describe('host-mcp over /api/rpc', () => {
  it('refuses a user token: host-mcp only accepts a bridge credential', async () => {
    const answer = await rpc(USER_TOKEN, 'host-mcp', 'listTools')
    expect(answer.status).toBe(200)
    expect(answer.body.ok).toBe(false)
    expect(answer.body.error?.message).toMatch(new RegExp(`^${HOST_MCP_UNAUTHORIZED}`))
    const call = await rpc(USER_TOKEN, 'host-mcp', 'callTool', { name: 'send_notification', args: { message: 'x' } })
    expect(call.body.ok).toBe(false)
    expect(notifications).toHaveLength(0)
  })

  it('accepts a bridge credential, and that credential reaches nothing but host-mcp', async () => {
    const { token } = bridge().mintCredential('fake-agent', sessionId)
    const listed = await rpc(token, 'host-mcp', 'listTools')
    expect(listed.body.ok).toBe(true)
    expect((listed.body.data as { tools: Array<{ name: string }> }).tools.map(t => t.name)).toContain('send_notification')

    const elsewhere = await rpc(token, 'sessions', 'list')
    expect(elsewhere.status).toBe(403)
    expect((await fetch(`${origin}/api/sessions`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403)
    bridge().revoke(token)
  })
})

describe('the stdio bridge against the live core (⑰′ / ⑱′)', () => {
  it('lists send_notification, lands the call on the originating session, and 401s after revocation', async () => {
    const { token } = bridge().mintCredential('fake-agent', sessionId)
    const client = new Client({ name: 'fake-agent', version: '0.0.0' })
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      env: { [HOST_MCP_BRIDGE_ENV.url]: origin, [HOST_MCP_BRIDGE_ENV.token]: token, ELECTRON_RUN_AS_NODE: '1' },
      stderr: 'pipe',
    }))
    try {
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('send_notification')
      const before = notifications.length
      const called = await client.callTool({ name: 'send_notification', arguments: { message: 'tests are green', title: 'CI' } })
      expect(called.isError).toBeFalsy()
      expect(notifications.slice(before)).toEqual([expect.objectContaining({
        type: 'agent:notification', sessionId, agentId: 'fake-agent', message: 'tests are green', title: 'CI', level: 'info',
      })])

      bridge().revokeSession(sessionId)
      expect((await rpc(token, 'host-mcp', 'listTools')).status).toBe(401)
      const refused = await client.callTool({ name: 'send_notification', arguments: { message: 'again' } })
      expect(refused.isError).toBe(true)
      expect(notifications.length).toBe(before + 1)
    } finally {
      await client.close()
    }
  }, 60_000)
})

describe('/api/mcp (Streamable HTTP)', () => {
  it('refuses anything but a live bridge credential', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
    expect((await fetch(`${origin}/api/mcp`, { method: 'POST', headers, body })).status).toBe(401)
    expect((await fetch(`${origin}/api/mcp`, { method: 'POST', headers: { ...headers, authorization: `Bearer ${USER_TOKEN}` }, body })).status).toBe(401)
  })

  it('serves the same tool table to an MCP client with the bridge credential', async () => {
    const { token } = bridge().mintCredential('http-agent', sessionId)
    const client = new Client({ name: 'http-agent', version: '0.0.0' })
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }))
    try {
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('send_notification')
      const before = notifications.length
      const called = await client.callTool({ name: 'send_notification', arguments: { message: 'via http', level: 'warn' } })
      expect(called.isError).toBeFalsy()
      expect(notifications.slice(before)).toEqual([expect.objectContaining({ sessionId, agentId: 'http-agent', level: 'warn' })])
    } finally {
      await client.close()
    }
    bridge().revoke(token)
    const after = await fetch(`${origin}/api/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    expect(after.status).toBe(401)
  }, 60_000)
})
