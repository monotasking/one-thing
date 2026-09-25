/**
 * K5-a —— MCP 投影驱动在**真装配**里的门。
 *
 * 四句话,没有一句在单测里说得出口:
 *
 *   ① 装配把驱动接上了(`backend.ts` 缝 4.1 之后那一行),于是一台连上的 server
 *      在 `backend.resources.registry` 里就是一个命名空间;
 *   ② `backend.resources.do(...)` 经**真管线**(校验 → 拦截 → plan → 授权 → apply
 *      → 预算 → 审计)落到 MCP 客户端的 `callTool` 上 —— 假的只有客户端本身。
 *      它**停在一张真权限卡上**:`mcp` 这一效果类在 `EFFECT_POLICY` 里是
 *      `ask` + barrier,而资源面的 `plan` 报的是自述的静态上界,所以这条路问的
 *      问题与 `McpTool` 给模型时问的是同一句(`buildMcpPermissionPlan` 也报
 *      `mcp`)。这不是这一单引进的行为,是效果表本来就这么写的;测试照答一次
 *      `once`,而这条口径的留账写在回报里;
 *   ③ **模型面上没有它**:真工具目录里既没有 `mcp-<id>`,`resources` 元工具的
 *      list 里却有 —— 那正是 `exposure.aiTool: false` 那一格要的东西(AI 走
 *      `McpTool`,不给第二只工具);
 *   ④ `backend.dispose()` 之后那个命名空间不在了(§10.2 的「已注销」)。
 *
 * 客户端这一侧是假的:真的那一份要拉起一个 stdio 子进程。注入口是现成的 ——
 * `host.mcp.clientFactory`(`host-ports.ts` 上写着:「只有 server 那种要把 stdio
 * 关掉的宿主才会给一个自己的工厂」),所以这里连一处 `vi.mock` 都不需要。
 *
 * store 隔离与全动态 import 的写法照 `resource-kernel.test.ts` / `resource-music.test.ts`:
 * `stores/sessions.ts` / `stores/settings.ts` 在 **import 期**就解析 store 根。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type {
  MCPClientLike,
  MCPServerConfig,
  MCPServerState,
  MCPToolCallResult,
} from '@onething/core/mcp'
import type { JsonObject } from '@onething/core'

const previousStorePath = process.env.ONETHING_STORE_PATH
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-resource-mcp-'))
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  const { getCurrentBackendSafe, setCurrentBackend } = await import('../current.js')
  if (getCurrentBackendSafe()) setCurrentBackend(null)
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

const SERVER_ID = 'fake-srv'
const SCHEME = 'mcp-fake-srv'

const calls: Array<{ toolName: string; args: JsonObject }> = []

/** 一台永远连得上、报一只工具的假 server。 */
class FakeMCPClient implements MCPClientLike {
  readonly state: MCPServerState

  constructor(config: MCPServerConfig) {
    this.state = { config, status: 'disconnected', tools: [], resources: [], prompts: [] }
  }

  get status(): MCPServerState['status'] {
    return this.state.status
  }

  async connect(): Promise<void> {
    this.state.status = 'connected'
    this.state.tools = [{
      name: 'echo_text',
      description: 'Echo the text back. Nothing else.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      serverId: this.state.config.id,
    }]
  }

  async disconnect(): Promise<void> {
    this.state.status = 'disconnected'
    this.state.tools = []
  }

  async updateConfig(): Promise<void> {}

  async callTool(toolName: string, args: JsonObject): Promise<MCPToolCallResult> {
    calls.push({ toolName, args })
    return { success: true, content: [{ type: 'text', text: `echo:${String(args.text)}` }] }
  }

  async readResource(): Promise<{ success: boolean }> {
    return { success: false }
  }

  async getPrompt(): Promise<{ success: boolean }> {
    return { success: false }
  }

  async refreshCapabilities(): Promise<void> {}
}

class NoopSender extends EventEmitter {
  isDestroyed(): boolean {
    return false
  }
  send(): void {}
}

type Backend = Awaited<ReturnType<typeof import('../backend.js')['createOnethingBackend']>>

async function assemble(): Promise<Backend> {
  const { createOnethingBackend } = await import('../backend.js')
  return createOnethingBackend({
    host: {
      storePath: {},
      sandbox: {},
      auth: null,
      logging: null,
      shell: null,
      voice: null,
      terminal: null,
      skillsEnvironment: null,
      todoPlan: null,
      scratchpad: null,
      plugins: null,
      gateway: null,
      settings: null,
      evals: null,
      // 现成的注入口:这台宿主用自己的客户端,不起 stdio 子进程。
      mcp: { clientFactory: (config: MCPServerConfig) => new FakeMCPClient(config), identity: null },
      localTrust: null,
      speechOutput: null,
      dialog: null,
    },
    toolRegistry: 'headless',
    sender: new NoopSender() as never,
  })
}

/** 让对账那条 promise 链落地(通知是同步发的,对账串在链上)。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

const PRINCIPAL = { kind: 'user', userId: 'local' } as const

describe('MCP 投影驱动在真装配里(K5-a)', () => {
  it('连上一台 server → 一个命名空间;do 落到客户端;模型面上没有它', { timeout: 180_000 }, async () => {
    const backend = await assemble()
    try {
      // 一台都没连时,注册表里没有任何 `mcp-` 开头的东西。
      expect(backend.resources.registry.list().map(spec => spec.scheme).filter(s => s.startsWith('mcp-')))
        .toEqual([])

      // 这是**生产上的那条路**:设置域改完 MCP 设置就调 `applySettings`
      // (改连接 + 重建工具目录),而 `registerMCPTools()` 的第一行就是那发通知。
      await backend.mcp.applySettings({
        enabled: true,
        servers: [{ id: SERVER_ID, name: 'Fake Server', transport: 'stdio', enabled: true, command: 'noop' }],
      })
      await settle()

      // ① 一台连上的 server = 一个命名空间。
      expect(backend.resources.registry.list().map(spec => spec.scheme)).toContain(SCHEME)
      const spec = backend.resources.registry.get(SCHEME)!
      expect(spec.title).toBe('Fake Server')
      expect(Object.keys(spec.ops)).toEqual(['echoText'])
      expect(spec.ops.echoText.effects).toEqual(['mcp'])
      expect(spec.ops.echoText.title).toBe('Echo the text back.')

      // ② 一次 do 经真管线落到客户端上,带的是**真工具名**。
      //
      // 它停在一张真权限卡上(`mcp` = ask + barrier,见文件头),所以这里像
      // `resource-kernel.test.ts` 里 AI 删消息那条一样:先等卡出现,再答 `once`。
      const store = await import('../store.js')
      const sessionId = store.createSession(`resource-mcp-${Date.now()}`, 'MCP').id
      const { Permission } = await import('../wiring/permission/index.js')

      const running = backend.resources.do(
        `${SCHEME}:server`,
        'echoText',
        { text: 'hi' },
        { principal: PRINCIPAL, sessionId },
      )
      await vi.waitFor(() => expect(Permission.getPendingPrompts(sessionId)).toHaveLength(1))
      const card = Permission.getPendingPrompts(sessionId)[0]
      expect(card.type).toBe('mcp')
      // 卡上那句话是自述里那条做法的标题(工具描述的第一句)—— 人看得见要跑的是
      // 哪一只工具,不只是「有人要调一台 MCP」。
      expect(card.title).toBe('Echo the text back.')
      Permission.respond({ sessionId, permissionId: card.id, response: 'once' })

      const outcome = await running
      expect(outcome.kind).toBe('ok')
      expect(calls).toEqual([{ toolName: 'echo_text', args: { text: 'hi' } }])
      if (outcome.kind === 'ok') {
        expect(outcome.result.content.map(part => part.text ?? '').join('')).toContain('echo:hi')
      }

      // ③ 模型面上没有第二只工具 —— AI 走 `McpTool`。
      const { getToolkitCatalog } = await import('@onething/runtime/toolkit/host')
      expect(getToolkitCatalog()?.has(SCHEME)).toBe(false)
      // 但它确实是一种资源:元工具的 list 里有它。
      const meta = getToolkitCatalog()?.get('resources')
      expect(meta).toBeDefined()
      const listed = await meta!.apply(
        await meta!.plan({ list: true } as never, {} as never),
        { emit: () => {} } as never,
      )
      expect(listed.content.map(part => part.text ?? '').join('\n')).toContain(SCHEME)
    } finally {
      await backend.dispose()
    }

    // ④ 关机之后回到「未登记」。
    const { getCurrentBackendSafe } = await import('../current.js')
    expect(getCurrentBackendSafe()).toBeNull()
  })
})
