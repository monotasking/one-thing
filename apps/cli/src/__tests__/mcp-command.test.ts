/**
 * MCP 服务端出口(原子 K4-c)。
 *
 * 起法(第④步批 3 起):CLI 真用的那只方法表(`backend-requests.ts`)接在一只内存传输上,传输背后是替身的
 * `resources` 域 —— 本测试问的是「一份自述怎么变成一只 MCP 工具、一次 `tools/call` 怎么落到 `resources` 的四个方法上、
 * 主体带没带过去」,不是「后端能不能装配」。主体在真机上坐在请求头里、由后端铸(那一半由
 * `packages/backend/__tests__/rpc-principal.test.ts` 与 `gate:cli-http` 的审计账证);管线那一半(效果 → 授权 → 审计)
 * 由 `packages/backend` 那边的资源门证。从前这里起的是一台真守护进程 + unix socket,回执不经出门脱敏;现在与浏览器
 * 壳看到的是同一份(施工单 §2.4 风险段「改后被脱敏是对的」)。
 *
 * MCP 那一半是**真 SDK**:一台真 `Server`、一个真 `Client`,`InMemoryTransport`
 * 连起来。所以 `initialize` / `tools/list` / `tools/call` 三段协议是真跑的,
 * `clientInfo.name` 也是真从握手里来的 —— 主体那一格因此不是我们自己喂给自己的。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { InMemoryTransport, Server } from '@modelcontextprotocol/server'

const CLIENT_NAME = 'test-agent'

/**
 * 每例 20 秒,不是 vitest 缺省的 5 秒。
 *
 * 每一例都**从头起一只方法表 + 一台 MCP server**,而第一次触到 MCP SDK 与资源那几只纯函数
 * 那两棵模块树时要付一次求值(单独跑这一份是 4s,整套并行跑时更慢)。这不是「测试
 * 很慢」,是「这一份测试的被测物包含两次真实的进程级装配」—— 把它压进 5 秒的办法
 * 只有共享一只方法表,而那会让「主体带没带过去」那一例读到上一例的残留。
 */
const MCP_TEST_TIMEOUT_MS = 20_000

/** 替身后端手里那点状态。测试直接读它,好证明「真改了名」。 */
const state = {
  sessions: new Map<string, { id: string; title: string }>([['s1', { id: 's1', title: 'Old title' }]]),
  principals: [] as Array<{ method: string; component: string }>,
}

const SPECS: Record<string, unknown> = {
  session: {
    scheme: 'session',
    title: 'Sessions',
    reads: {
      get: {
        title: 'A short summary of one session',
        query: { type: 'object', properties: {} },
        result: { type: 'object' },
      },
    },
    ops: {
      rename: {
        title: 'Rename a session',
        params: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        effects: [],
        home: 'core',
      },
      removeMessage: {
        title: 'Remove one message',
        params: { type: 'object', properties: { messageId: { type: 'string' } }, required: ['messageId'] },
        effects: ['session_destructive'],
        home: 'core',
      },
    },
    events: {},
  },
  dir: {
    scheme: 'dir',
    title: 'Directories',
    reads: { list: { title: 'List a directory', query: { type: 'object', properties: {} }, result: { type: 'object' } } },
    ops: {
      reveal: {
        title: 'Reveal in the file manager',
        params: { type: 'object', properties: {} },
        effects: ['ui_change'],
        home: 'shell',
      },
    },
    events: {},
  },
}

function sessionIdOf(ref: string): string {
  return ref.slice(ref.indexOf(':') + 1)
}

/**
 * 替身后端:一只内存传输上的 `resources` 域(第④步批 3 起桥走 HTTP 上的这四个方法)。`actingSystem` 是那只传输
 * 代表的系统组件 —— 真机上它坐在请求头 `X-Onething-Acting-System` 上,由后端铸成主体;这里直接记下来。
 */
function resourceHandlers(actingSystem: string | undefined) {
  return {
    'resources.list': () => ({ schemes: [{ scheme: 'dir', title: 'Directories' }, { scheme: 'session', title: 'Sessions' }] }),
    'resources.describe': (payload: unknown) => {
      const scheme = (payload as { scheme: string }).scheme
      const spec = SPECS[scheme]
      if (!spec) throw new Error(`No resource is registered for scheme: ${scheme}`)
      return spec
    },
    'resources.read': (payload: unknown) => {
      const { ref, name } = payload as { ref: string; name: string }
      state.principals.push({ method: 'read', component: actingSystem ?? '(default)' })
      const session = state.sessions.get(sessionIdOf(ref))
      if (!session) return { kind: 'failed', error: { name: 'Error', message: `No session: ${ref}` } }
      if (name !== 'get') return { kind: 'invalid', message: `unknown read: ${name}` }
      return { kind: 'ok', value: { id: session.id, title: session.title } }
    },
    'resources.do': (payload: unknown) => {
      const { ref, op, params } = payload as { ref: string; op: string; params: Record<string, unknown> }
      state.principals.push({ method: 'do', component: actingSystem ?? '(default)' })
      const session = state.sessions.get(sessionIdOf(ref))
      if (!session) return { kind: 'failed', error: { name: 'Error', message: `No session: ${ref}` } }
      if (op === 'rename') {
        session.title = String(params.title ?? '')
        return { kind: 'ok', text: `renamed to ${session.title}` }
      }
      return { kind: 'denied', reason: 'not allowed here' }
    },
  }
}

let storePath = ''
let stopBackend: (() => void) | undefined
let closeMcp: (() => Promise<void>) | undefined

describe('onething mcp —— 资源投影成一台 MCP server', () => {
  beforeEach(() => {
    vi.resetModules()
    state.sessions = new Map([['s1', { id: 's1', title: 'Old title' }]])
    state.principals = []
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-mcp-'))
  })

  afterEach(async () => {
    await closeMcp?.()
    closeMcp = undefined
    stopBackend?.()
    stopBackend = undefined
    const logging = await import('@onething/backend/logging/logging-configure')
    await logging.shutdownAppLogging()
    fs.rmSync(storePath, { recursive: true, force: true })
  }, MCP_TEST_TIMEOUT_MS)

  /** CLI 真用的那只方法表,接在替身后端的内存传输上。 */
  async function connectBackend() {
    const { createBackendRequester } = await import('../backend-requests.js')
    const { createMemoryTransport } = await import('@onething/backend-client')
    const requester = createBackendRequester(actingSystem => createMemoryTransport({ handlers: resourceHandlers(actingSystem) }))
    stopBackend = () => requester.close()
    return requester
  }

  /** 后端方法表 + 一台真 MCP server + 一个真 MCP client,握完手交出来。 */
  async function connectMcp() {
    const backendClient = await connectBackend()
    const { createResourceMcpServer } = await import('../mcp-command.js')
    const server = createResourceMcpServer(backendClient as never, {
      server: new Server({ name: 'onething', version: '0.0.0-test' }, { capabilities: { tools: {} } }) as never,
      // 超时那一支在这里不该被等到 —— 调小只是为了「万一等到了」不拖住整个套件。
      doTimeoutMs: 2_000,
    })
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: CLIENT_NAME, version: '1.0.0' })
    await Promise.all([
      (server as unknown as { connect(t: unknown): Promise<void> }).connect(serverTransport),
      client.connect(clientTransport as never),
    ])
    closeMcp = async () => { await client.close() }
    return { client, backendClient }
  }

  async function callText(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args })
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>
    return { text: content.map(part => part.text ?? '').join('\n'), isError: result.isError === true }
  }

  it('tools/list 是在场自述的投影:每个 scheme 一只工具 + 元工具,入参是 oneOf', async () => {
    const { client } = await connectMcp()
    const listed = await client.listTools()
    const names = listed.tools.map(tool => tool.name).sort()
    expect(names).toEqual(['dir', 'resources', 'session'])

    const session = listed.tools.find(tool => tool.name === 'session')
    // 与本机 AI 看到的是**同一份 schema**(`toolInputSchemaOf`):可辨识联合,
    // 先做法后读法、族内字典序。
    const branches = (session?.inputSchema as { oneOf?: Array<{ properties?: Record<string, unknown> }> }).oneOf
    expect(Array.isArray(branches)).toBe(true)
    expect(branches?.length).toBe(3)
    expect(Object.keys(branches?.[0]?.properties ?? {})).toContain('op')
    expect(Object.keys(branches?.[2]?.properties ?? {})).toContain('read')
    // 做法清单进描述(`toolDescriptionOf`),带效果的自述多一句审批话。
    expect(session?.description).toContain('rename — Rename a session')
    expect(session?.description).toContain('needs approval')
    // `home: 'shell'` 那一格读的是投影上的真值,不是还原函数盖上去的那个。
    expect(listed.tools.find(tool => tool.name === 'dir')?.description).toContain('app window')
  }, MCP_TEST_TIMEOUT_MS)

  it('resources {list:true} 列出在场命名空间', async () => {
    const { client } = await connectMcp()
    const { text, isError } = await callText(client, 'resources', { list: true })
    expect(isError).toBe(false)
    expect(text).toContain('session')
    expect(text).toContain('dir')
  }, MCP_TEST_TIMEOUT_MS)

  it('session {read:"get"} 回摘要 JSON', async () => {
    const { client } = await connectMcp()
    const { text, isError } = await callText(client, 'session', { read: 'get', ref: 'session:s1' })
    expect(isError).toBe(false)
    expect(JSON.parse(text)).toEqual({ id: 's1', title: 'Old title' })
  }, MCP_TEST_TIMEOUT_MS)

  it('session {op:"rename"} 真改了名,而且主体是 system:mcp:<clientName>', async () => {
    const { client } = await connectMcp()
    const { text, isError } = await callText(client, 'session', {
      op: 'rename', ref: 'session:s1', title: 'New title',
    })
    expect(isError).toBe(false)
    expect(text).toContain('New title')
    expect(state.sessions.get('s1')?.title).toBe('New title')
    // 主体一路带到了传输上:缺省的本机用户被顶掉了(真机上是 `X-Onething-Acting-System` 请求头)。
    expect(state.principals.at(-1)).toEqual({ method: 'do', component: `mcp:${CLIENT_NAME}` })
  }, MCP_TEST_TIMEOUT_MS)

  it('不存在的会话是 isError,不是协议错误', async () => {
    const { client } = await connectMcp()
    const { text, isError } = await callText(client, 'session', { read: 'get', ref: 'session:ghost' })
    expect(isError).toBe(true)
    expect(text).toContain('No session')
  }, MCP_TEST_TIMEOUT_MS)

  /**
   * 反证②的落点:后端**抛**出来的那一支(`describe` 一个不存在的 scheme)也必须
   * 是 `isError`,不是 `throw`。把 `callResourceTool` 的 catch 改成 rethrow,这一例
   * 当场红(`callTool` 会以协议错误 reject)。
   */
  it('后端抛出来的错也折成 isError,连接不受影响', async () => {
    const { client } = await connectMcp()
    const { text, isError } = await callText(client, 'resources', { describe: 'nope' })
    expect(isError).toBe(true)
    expect(text).toContain('No resource is registered')
    // 连接还活着 —— 这正是「结局不是异常」要保住的东西。
    expect((await client.listTools()).tools.length).toBe(3)
  }, MCP_TEST_TIMEOUT_MS)

  it('地址缺席时说清楚,而不是编一个空 path 的地址出来', async () => {
    const { client } = await connectMcp()
    const { text, isError } = await callText(client, 'session', { op: 'rename', title: 'x' })
    expect(isError).toBe(true)
    expect(text).toContain('needs an address')
  }, MCP_TEST_TIMEOUT_MS)

  /**
   * 反证①的落点:方法表只认 `system` 一支主体(真机上后端那一侧也只能把主体降成 `system`,见
   * `http-server-principal.ts`)。走的是**方法表本身**(不经 MCP 桥)—— 伪造者本来就不会经过桥。把
   * `backend-requests.ts` 的 `resourcesFor` 里那道判据拆掉,这一例当场红。
   */
  it('方法表拒绝伪造的 user / agent 主体', async () => {
    const backendClient = await connectBackend()
    await expect(backendClient.request('resource.do' as never, {
      ref: 'session:s1', op: 'rename', params: { title: 'hacked' },
      principal: { kind: 'user', userId: 'local' },
    })).rejects.toThrow(/principal must be/)
    await expect(backendClient.request('resource.do' as never, {
      ref: 'session:s1', op: 'rename', params: { title: 'hacked' },
      principal: { kind: 'agent', agentId: 'a1' },
    })).rejects.toThrow(/principal must be/)
    // 主体不给仍然是缺省的本机用户 —— 这条老路一个字没变。
    await backendClient.request('resource.do' as never, {
      ref: 'session:s1', op: 'rename', params: { title: 'by the user' },
    })
    expect(state.principals.at(-1)).toEqual({ method: 'do', component: '(default)' })
    expect(state.sessions.get('s1')?.title).toBe('by the user')
  }, MCP_TEST_TIMEOUT_MS)
})

/**
 * 「没人能答那张卡」那一支(`DO_TIMEOUT_MS`)。
 *
 * 不起后端:被测的正是「后端那边永远不回话」。真机上那是一次
 * `session_destructive` 停在 `Permission.ask` 上 —— 桥等不到,于是**它自己收场**,
 * 而且说的是为什么(「这条桥后面没有人」),不是一句「超时」。
 */
describe('onething mcp —— 等不到审批时自己收场', () => {
  it('do 超时折成 isError,措辞说清楚是审批不是网络', async () => {
    const { callResourceTool } = await import('../mcp-command.js')
    const client = {
      request: (method: string) =>
        method === 'resource.do' ? new Promise<never>(() => {}) : Promise.resolve({}),
    }
    const result = await callResourceTool(
      client as never,
      'session',
      { op: 'removeMessage', ref: 'session:s1', messageId: 'm1' },
      { kind: 'system', component: 'mcp:test' },
      30,
    )
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('needs approval')
  })
})
