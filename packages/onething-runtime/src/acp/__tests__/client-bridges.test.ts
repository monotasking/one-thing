import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACPClient, clientCapabilitiesFor } from '../client.js'
import { MemoryACPSessionLinkStore } from '../session-links.js'
import type { AcpClientRequestContext, AcpFsBridge, AcpTerminalBridge } from '../types.js'
import type { ACPAgentConfig } from '@shared/contracts/acp.js'

/**
 * A3-b:`fs/*` / `terminal/*` 只经注入的桥(方案 §3.5 / §11.3)。夹具是真子进程的 ACP agent,
 * `@fs` / `@term` 两条剧本从 agent 那一侧真的发请求;桥是假的,只记它被怎么调了。
 * 裸实现已删:没注入文件桥 = method-not-found;终端能力只在终端桥在且答「有通道」时声明。
 */

const AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url))

let root: string
let agentDir: string

function config(): ACPAgentConfig {
  return {
    id: 'fake',
    name: 'Fake',
    enabled: true,
    command: process.execPath,
    args: [AGENT],
    env: {
      FAKE_AGENT_DIR: agentDir,
      FAKE_AGENT_CAPS: 'none',
      FAKE_AGENT_FS: '1',
      FAKE_AGENT_TERMINAL: '1',
      FAKE_AGENT_FS_OUTSIDE: '/elsewhere/.ssh/id_rsa',
    },
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
  for await (const event of client.streamPrompt({ localSessionId: 'local-1', prompt, cwd: root, messageId: 'msg-9' })) {
    if (event.type === 'finish') break
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acp-bridges-'))
  agentDir = join(root, 'agent')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('clientCapabilitiesFor', () => {
  const none = { terminal: false, authTerminal: false, elicitation: false }
  it('fs 两条恒声明;terminal / auth.terminal / elicitation 各按自己的判据声明', () => {
    expect(clientCapabilitiesFor(none)).toEqual({
      fs: { readTextFile: true, writeTextFile: true },
      session: { configOptions: {}, notices: {}, compaction: {} },
      plan: {},
    })
    expect(clientCapabilitiesFor({ ...none, terminal: true })).toMatchObject({ terminal: true })
    expect(clientCapabilitiesFor({ ...none, authTerminal: true })).toMatchObject({ auth: { terminal: true } })
    expect(clientCapabilitiesFor({ ...none, elicitation: true })).toMatchObject({ elicitation: { form: {}, url: {} } })
    expect(clientCapabilitiesFor({ ...none, elicitation: true })).not.toHaveProperty('auth')
  })
})

describe('ACPClient × 注入的桥', () => {
  it('fs 请求带着会话归属交给文件桥;桥的拒绝原话回到 agent', async () => {
    const seen: Array<{ method: string; context: AcpClientRequestContext; path: string }> = []
    const fsBridge: AcpFsBridge = {
      async readTextFile(context, params) {
        seen.push({ method: 'read', context, path: params.path })
        if (params.path.includes('.ssh')) throw new Error('onething denied reading it.')
        return { content: 'from bridge' }
      },
      async writeTextFile(context, params) {
        seen.push({ method: 'write', context, path: params.path })
      },
    }
    const client = new ACPClient(config(), { getSessionLinks: () => new MemoryACPSessionLinkStore(), getFsBridge: () => fsBridge })
    try {
      await runTurn(client, '@fs')
    } finally {
      await client.disconnect()
    }
    expect(seen.map(entry => entry.method)).toEqual(['read', 'read', 'write'])
    expect(seen[0].context).toMatchObject({ agentId: 'fake', agentName: 'Fake', localSessionId: 'local-1', messageId: 'msg-9' })
    const log = calls()
    expect(log.find(call => call.method === 'fs-read')).toMatchObject({ ok: true, content: 'from bridge' })
    expect(log.find(call => call.method === 'fs-read-outside')).toMatchObject({ ok: false, code: -32603, message: 'onething denied reading it.' })
    expect(log.find(call => call.method === 'fs-write')).toMatchObject({ ok: true })
    // 没有终端桥:握手不声明终端(agent 那一侧的 SDK 把缺席补成 false)。
    expect(clientCaps()?.terminal).toBeFalsy()
  }, 20_000)

  it('没注入文件桥:fs 两条答 method-not-found(裸读已删)', async () => {
    const client = new ACPClient(config(), { getSessionLinks: () => new MemoryACPSessionLinkStore() })
    try {
      await runTurn(client, '@fs')
    } finally {
      await client.disconnect()
    }
    const log = calls()
    expect(log.find(call => call.method === 'fs-read')).toMatchObject({ ok: false, code: -32601 })
    expect(log.find(call => call.method === 'fs-write')).toMatchObject({ ok: false, code: -32601 })
  }, 20_000)

  it('终端桥在且有通道:握手声明 terminal,五个方法全走桥', async () => {
    const methods: string[] = []
    let exitResolve: ((value: { exitCode: number }) => void) | undefined
    const terminalBridge: AcpTerminalBridge = {
      available: () => true,
      async create(_context, params) { methods.push(`create:${params.command}`); return { terminalId: `t-${methods.length}` } },
      async output() { methods.push('output'); return { output: 'hi\n', truncated: false, exitStatus: { exitCode: 0 } } },
      async waitForExit() {
        methods.push('wait')
        return new Promise(resolve => { exitResolve = resolve; setTimeout(() => exitResolve?.({ exitCode: 0 }), 5) })
      },
      async kill() { methods.push('kill') },
      async release() { methods.push('release') },
    }
    const client = new ACPClient(config(), { getSessionLinks: () => new MemoryACPSessionLinkStore(), getTerminalBridge: () => terminalBridge })
    try {
      await runTurn(client, '@term')
    } finally {
      await client.disconnect()
    }
    expect(methods).toEqual(['create:/bin/sh', 'wait', 'output', 'release', 'create:/bin/sh', 'kill', 'wait', 'release'])
    const log = calls()
    expect(clientCaps()?.terminal).toBe(true)
    expect(log.find(call => call.method === 'term-output')).toMatchObject({ output: 'hi\n' })
  }, 20_000)

  it('终端桥在但宿主没有终端通道:不声明、不挂方法(agent 拿到 method-not-found)', async () => {
    const terminalBridge = { available: () => false } as unknown as AcpTerminalBridge
    const client = new ACPClient(config(), { getSessionLinks: () => new MemoryACPSessionLinkStore(), getTerminalBridge: () => terminalBridge })
    try {
      await runTurn(client, '@term')
    } finally {
      await client.disconnect()
    }
    const log = calls()
    expect(clientCaps()?.terminal).toBeFalsy()
    expect(log.find(call => call.method === 'term-error')).toMatchObject({ code: -32601 })
  }, 20_000)
})
