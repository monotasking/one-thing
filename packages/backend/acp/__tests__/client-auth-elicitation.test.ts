import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACPClient, authMethodsOf, isAcpAuthRequired, toAcpPromptError } from '../acp-client.js'
import { MemoryACPSessionLinkStore } from '../session-links.js'
import type {
  AcpAuthBridge,
  AcpElicitationBridge,
  AcpElicitationContext,
  AcpElicitationRequest,
} from '../acp-types.js'
import type { ACPAgentConfig, ACPAgentState } from '@shared/contracts/acp.js'

/**
 * A3-c:登录与提问(方案 §3.5 / §11.3)。夹具是真子进程的 ACP agent:`FAKE_AGENT_ELICIT` 那条剧本
 * 从 agent 那一侧真的发 `elicitation/create`;`FAKE_AGENT_AUTH` 让它没登录时以 `auth_required` 拒。
 * 桥是假的,只记它被怎么调了。
 */

const AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url))

let root: string
let agentDir: string

function config(env: Record<string, string> = {}): ACPAgentConfig {
  return {
    id: 'fake',
    name: 'Fake',
    enabled: true,
    command: process.execPath,
    args: [AGENT],
    env: { FAKE_AGENT_DIR: agentDir, FAKE_AGENT_CAPS: 'none', ...env },
    connectTimeoutMs: 10_000,
  }
}

function calls(): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(agentDir, 'calls.log'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

function clientCaps(): Record<string, unknown> | null {
  return JSON.parse(readFileSync(join(agentDir, 'client-caps.json'), 'utf8'))
}

async function runTurn(client: ACPClient, prompt: string): Promise<void> {
  for await (const event of client.streamPrompt({ localSessionId: 'local-1', prompt, cwd: root, messageId: 'msg-7' })) {
    if (event.type === 'finish') break
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acp-a3c-'))
  agentDir = join(root, 'agent')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('提问(elicitation/create)', () => {
  it('注入了提问桥:握手声明 elicitation,agent 的表单交给桥,桥的答复原样回到 agent', async () => {
    const seen: Array<{ context: AcpElicitationContext; request: AcpElicitationRequest }> = []
    const bridge: AcpElicitationBridge = {
      async create(context, request) {
        seen.push({ context, request })
        return { action: 'accept', content: { color: 'b', note: 'hi' } }
      },
      complete() {},
    }
    const client = new ACPClient(config({ FAKE_AGENT_ELICIT: '1' }), {
      getSessionLinks: () => new MemoryACPSessionLinkStore(),
      getElicitationBridge: () => bridge,
    })
    try {
      await runTurn(client, '@elicit')
    } finally {
      await client.disconnect()
    }
    expect(clientCaps()?.elicitation).toEqual({ form: {}, url: {} })
    expect(seen).toHaveLength(1)
    expect(seen[0].context).toMatchObject({ agentId: 'fake', localSessionId: 'local-1', messageId: 'msg-7' })
    expect(seen[0].request).toMatchObject({ mode: 'form', message: 'Fake agent needs two answers' })
    expect(calls().find(call => call.method === 'elicit')).toMatchObject({
      response: { action: 'accept', content: { color: 'b', note: 'hi' } },
    })
  }, 20_000)

  it('假 agent 发 elicitation/create:没注入提问桥 → 不声明、答 method-not-found', async () => {
    const client = new ACPClient(config({ FAKE_AGENT_ELICIT: '1' }), { getSessionLinks: () => new MemoryACPSessionLinkStore() })
    try {
      await runTurn(client, '@elicit')
    } finally {
      await client.disconnect()
    }
    expect(clientCaps()?.elicitation).toBeFalsy()
    expect(calls().find(call => call.method === 'elicit')).toMatchObject({ code: -32601 })
  }, 20_000)
})

describe('登录能力声明', () => {
  it('登录桥在且有终端:声明 auth.terminal;没终端或没桥:不声明', async () => {
    const bridge = (terminal: boolean): AcpAuthBridge => ({
      terminalAvailable: () => terminal,
      authenticate: async () => ({ ok: true }),
    })
    // agent 那一侧的 SDK 把没声明的 `auth` 补成 `{ terminal: false }`,所以比的是那一格的真假。
    for (const [getAuthBridge, expected] of [
      [() => bridge(true), true],
      [() => bridge(false), false],
      [() => undefined, false],
    ] as const) {
      const client = new ACPClient(config(), { getSessionLinks: () => new MemoryACPSessionLinkStore(), getAuthBridge })
      await client.connect()
      await client.disconnect()
      expect(Boolean((clientCaps()?.auth as { terminal?: boolean } | undefined)?.terminal)).toBe(expected)
    }
  }, 30_000)
})

describe('auth.required 的起落', () => {
  it('agent 型:开会话被 auth_required 拒 → required;authenticate → 清掉,下一轮走通', async () => {
    const states: ACPAgentState[] = []
    const client = new ACPClient(config({ FAKE_AGENT_AUTH: 'agent' }), { getSessionLinks: () => new MemoryACPSessionLinkStore() })
    client.onAgentStateChanged(state => states.push(state))
    try {
      await client.connect()
      expect(client.state.auth).toEqual({
        methods: [{ id: 'fake-agent-login', name: 'Fake agent login', description: 'authenticate in-band', type: 'agent' }],
        required: false,
      })
      const failure = await runTurn(client, 'hello').then(() => undefined, (error: unknown) => error)
      expect((failure as Error).message).toContain('"Fake" is not logged in')
      expect(client.state.auth?.required).toBe(true)
      expect(states.some(state => state.auth?.required === true)).toBe(true)

      await client.authenticate('fake-agent-login')
      expect(client.state.auth?.required).toBe(false)
      expect(calls().find(call => call.method === 'authenticate')).toMatchObject({ methodId: 'fake-agent-login' })
      await runTurn(client, 'hello again')
      expect(client.state.auth?.required).toBe(false)
    } finally {
      await client.disconnect()
    }
  }, 20_000)

  it('终端型:markAuthenticated 清掉 required;断开不清', async () => {
    const client = new ACPClient(config({ FAKE_AGENT_AUTH: 'terminal' }), { getSessionLinks: () => new MemoryACPSessionLinkStore() })
    try {
      await runTurn(client, 'hello').catch(() => undefined)
      expect(client.state.auth).toMatchObject({ required: true, methods: [{ id: 'fake-terminal-login', type: 'terminal' }] })
      await client.disconnect()
      expect(client.state.auth?.required).toBe(true)
      client.markAuthenticated()
      expect(client.state.auth?.required).toBe(false)
      expect(existsSync(join(agentDir, 'credentials'))).toBe(false)
    } finally {
      await client.disconnect()
    }
  }, 20_000)
})

describe('纯函数', () => {
  it('authMethodsOf:type 缺席 = agent,认不出的 type 不上屏', () => {
    expect(authMethodsOf({
      authMethods: [
        { id: 'a', name: 'A' },
        { id: 't', name: 'T', type: 'terminal', args: ['--x'] },
        { id: 'e', name: 'E', type: 'env_var' } as never,
      ],
    })).toEqual([
      { id: 'a', name: 'A', type: 'agent' },
      { id: 't', name: 'T', type: 'terminal' },
    ])
    expect(authMethodsOf(null)).toEqual([])
  })

  it('isAcpAuthRequired 认对端原错与换成人话之后的错', () => {
    const raw = { code: -32000, message: 'Authentication required' }
    expect(isAcpAuthRequired(raw)).toBe(true)
    expect(isAcpAuthRequired(toAcpPromptError(raw, 'Fake'))).toBe(true)
    expect(isAcpAuthRequired({ code: -32603, message: 'x' })).toBe(false)
  })
})
