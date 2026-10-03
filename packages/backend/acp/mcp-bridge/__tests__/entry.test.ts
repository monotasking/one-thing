/**
 * ACP A4-a:stdio 桥进程本身(`entry.ts` → `acp-mcp-bridge.cjs`)。
 *
 * 用**真配方**(`apps/desktop-react/scripts/build-electron.mjs` 的 `acpMcpBridgeEsbuildOptions`)
 * 把入口打成一份临时 `.cjs`,用系统 node 起它,再用真 MCP 客户端(stdio 传输)去驱动 ——
 * 验的是 agent 那一侧真的会看到的东西。活核由一台假 HTTP 服务器扮演:它只认一把 token,
 * 把收到的每个 RPC 信封记下来。
 *
 * 钉:`tools/list` 转成 `host-mcp.listTools`、`tools/call` 转成 `host-mcp.callTool { name, args }`
 * 且参数原样;每一发都带 `Authorization: Bearer <桥凭据>`;核心答 401 时模型拿到的是一条
 * `isError` 的文字而不是协议错误;stdout 上除了协议帧什么都没有(否则客户端早就解析失败了)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { HOST_MCP_BRIDGE_ENV, HOST_MCP_RPC } from '../server.js'

const repoRoot = path.resolve(__dirname, '../../../../..')
const TOKEN = 'bridge-token-for-test'

let outdir: string
let bundle: string
let server: Server
let url: string
let revoked = false
const seen: Array<{ auth?: string; body: { domain: string; method: string; payload: unknown } }> = []

beforeAll(async () => {
  outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-mcp-bridge-'))
  const recipe = await import(pathToFileURL(path.join(repoRoot, 'apps/desktop-react/scripts/build-electron.mjs')).href) as {
    acpMcpBridgeEsbuildOptions(options: { outdir: string; repoRoot: string }): Record<string, unknown>
    ACP_MCP_BRIDGE_NAME: string
  }
  const { build } = await import('esbuild')
  await build({ ...recipe.acpMcpBridgeEsbuildOptions({ outdir, repoRoot }), logLevel: 'silent', sourcemap: false })
  bundle = path.join(outdir, `${recipe.ACP_MCP_BRIDGE_NAME}.cjs`)

  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      const auth = request.headers.authorization
      if (auth !== `Bearer ${TOKEN}` || revoked) {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ success: false, error: 'Unauthorized' }))
        return
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      seen.push({ auth, body })
      let data: unknown
      if (body.method === 'listTools') {
        data = { tools: [{ name: 'send_notification', description: 'notify', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } }] }
      } else {
        data = { content: [{ type: 'text', text: `called ${body.payload.name}` }] }
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, data }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
}, 120_000)

afterAll(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()))
  fs.rmSync(outdir, { recursive: true, force: true })
})

it('the built bridge speaks MCP on stdio and forwards to host-mcp over /api/rpc with the credential', async () => {
  expect(fs.existsSync(bundle)).toBe(true)
  const client = new Client({ name: 'fake-agent', version: '0.0.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    env: { [HOST_MCP_BRIDGE_ENV.url]: url, [HOST_MCP_BRIDGE_ENV.token]: TOKEN, ELECTRON_RUN_AS_NODE: '1' },
    stderr: 'pipe',
  })
  await client.connect(transport)
  try {
    const listed = await client.listTools()
    expect(listed.tools.map(tool => tool.name)).toEqual(['send_notification'])

    const called = await client.callTool({ name: 'send_notification', arguments: { message: 'done', level: 'success' } })
    expect(called).toMatchObject({ content: [{ type: 'text', text: 'called send_notification' }] })

    expect(seen.map(entry => entry.body)).toEqual([
      { domain: HOST_MCP_RPC.domain, method: 'listTools', payload: {} },
      { domain: HOST_MCP_RPC.domain, method: 'callTool', payload: { name: 'send_notification', args: { message: 'done', level: 'success' } } },
    ])
    expect(seen.every(entry => entry.auth === `Bearer ${TOKEN}`)).toBe(true)

    // 凭据作废:模型拿到一条读得懂的 isError,连接不断。
    revoked = true
    const refused = await client.callTool({ name: 'send_notification', arguments: { message: 'x' } })
    expect(refused).toMatchObject({ isError: true })
    expect(JSON.stringify(refused)).toMatch(/no longer accepts this bridge credential/)
  } finally {
    await client.close()
  }
}, 60_000)

it('refuses to start without the two env vars and says so on stderr only', async () => {
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, [bundle], {
    env: { PATH: process.env.PATH ?? '' },
    encoding: 'utf8',
    timeout: 20_000,
  })
  expect(result.status).toBe(2)
  expect(result.stdout).toBe('')
  expect(result.stderr).toMatch(/ONETHING_MCP_URL/)
}, 30_000)
