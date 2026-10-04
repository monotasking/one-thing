import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACPClient, AcpCapabilityMissingError, AcpReconnectPausedError } from '../acp-client.js'
import { AcpReconnectBackoffGate } from '../acp-reconnect-backoff.js'
import { MemoryACPSessionLinkStore } from '../acp-session-links.js'
import type { ACPAgentConfig } from '@shared/contracts/acp.js'

/**
 * A5 会话生命(方案 `docs/design/acp-integration-2026-09.md` §3.7 / §11.6),产品层那一半:
 *  - 崩溃退避:30s 窗内至多自动重连 3 次,第 4 次拒并锁上;手动重连清锁;
 *  - `session/list` 翻页;没自报能力 = `AcpCapabilityMissingError`;
 *  - 认领:`session/load` 的回放按序交回来(普通恢复照旧丢),链接落盘;
 *  - 分叉:`session/fork`,新 agent 会话记到目标本地会话名下。
 * 夹具是真子进程的假 agent(`fixtures/fake-agent.mjs`)。
 */

const AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url))

let root: string
let agentDir: string
let cwd: string
let links: MemoryACPSessionLinkStore

function config(env: Record<string, string>): ACPAgentConfig {
  return {
    id: 'fake',
    name: 'Fake',
    enabled: true,
    command: process.execPath,
    args: [AGENT],
    env: { FAKE_AGENT_DIR: agentDir, ...env },
    connectTimeoutMs: 10_000,
  } as ACPAgentConfig
}

function calls(): Array<Record<string, unknown> & { method: string }> {
  try {
    return readFileSync(join(agentDir, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  } catch {
    return []
  }
}

async function say(c: ACPClient, localSessionId: string, prompt = 'hi'): Promise<string> {
  let text = ''
  for await (const event of c.streamPrompt({ localSessionId, prompt, cwd })) {
    if (event.type !== 'update') continue
    const update = event.notification.update
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') text += update.content.text
  }
  return text
}

async function waitFor<T>(read: () => T | undefined, budgetMs = 5_000): Promise<T> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < budgetMs) {
    const value = read()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('timed out')
}

/** 杀掉 agent 进程(-9),等客户端把状态落成 error。 */
async function crash(c: ACPClient): Promise<void> {
  const pid = c.state.pid
  expect(pid).toBeTypeOf('number')
  process.kill(pid!, 'SIGKILL')
  await waitFor(() => (c.status === 'error' ? true : undefined))
}

function seedSession(id: string, extra: Record<string, unknown>): void {
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, `${id}.json`), JSON.stringify({ id, cwd, model: 'alpha', turns: 0, ...extra }))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acp-lifecycle-'))
  agentDir = join(root, 'agent')
  cwd = join(root, 'work')
  mkdirSync(cwd, { recursive: true })
  links = new MemoryACPSessionLinkStore()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('AcpReconnectBackoffGate(假钟)', () => {
  it('30s 窗内放 3 次,第 4 次拒并锁上;锁不随窗过期;reset 清', () => {
    let now = 1_000
    const gate = new AcpReconnectBackoffGate(() => now)
    expect(gate.snapshot()).toBeUndefined()
    expect(gate.admit()).toBe(true)
    now += 5_000
    expect(gate.admit()).toBe(true)
    now += 5_000
    expect(gate.admit()).toBe(true)
    expect(gate.snapshot()).toEqual({ attempts: 3, until: 31_000, latched: false })
    now += 5_000
    expect(gate.admit()).toBe(false)
    expect(gate.snapshot()).toMatchObject({ latched: true })
    expect(gate.snapshot()?.until).toBeUndefined()
    now += 120_000
    expect(gate.admit()).toBe(false)
    expect(gate.isLatched).toBe(true)
    gate.reset()
    expect(gate.snapshot()).toBeUndefined()
    expect(gate.admit()).toBe(true)
  })

  it('窗外的旧记录过期:间隔超过 30s 的重连永远放行', () => {
    let now = 0
    const gate = new AcpReconnectBackoffGate(() => now)
    for (let i = 0; i < 10; i += 1) {
      expect(gate.admit()).toBe(true)
      now += 11_000
    }
    expect(gate.isLatched).toBe(false)
    now += 60_000
    expect(gate.snapshot()).toBeUndefined()
  })
})

describe('ACPClient 崩溃退避', () => {
  it('崩后自动重连 3 次,第 4 次拒(不起新进程)并锁上;reconnect 清锁后照常', async () => {
    const c = new ACPClient(config({ FAKE_AGENT_CAPS: 'load' }), { getSessionLinks: () => links })
    const agentStates: Array<{ status: string; backoff?: unknown }> = []
    c.onAgentStateChanged(state => agentStates.push({ status: state.status, backoff: state.backoff }))
    try {
      expect(await say(c, 'local-1')).toContain('turns=1')
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await crash(c)
        expect(await say(c, 'local-1')).toContain(`turns=${attempt + 1}`)
        expect(c.state.backoff).toMatchObject({ attempts: attempt, latched: false })
      }
      // 重连后按 load 回到同一条会话(链接在)。
      expect(calls().filter(call => call.method === 'load')).toHaveLength(3)
      await crash(c)
      const initsBefore = calls().filter(call => call.method === 'init').length
      await expect(say(c, 'local-1')).rejects.toBeInstanceOf(AcpReconnectPausedError)
      await expect(say(c, 'local-1')).rejects.toThrow(/automatic reconnect is paused/)
      expect(calls().filter(call => call.method === 'init')).toHaveLength(initsBefore)
      expect(c.state.backoff).toMatchObject({ latched: true })
      expect(agentStates.some(state => (state.backoff as { latched?: boolean } | undefined)?.latched === true)).toBe(true)

      await c.reconnect()
      expect(c.status).toBe('connected')
      expect(c.state.backoff).toBeUndefined()
      expect(await say(c, 'local-1')).toContain('turns=5')
    } finally {
      await c.disconnect()
    }
  }, 30_000)

  it('手动 connect({ manual: true }) 也清锁', async () => {
    const gate = new AcpReconnectBackoffGate(() => 0, 30_000, 0)
    const c = new ACPClient(config({ FAKE_AGENT_CAPS: 'load' }), { getSessionLinks: () => links, reconnectBackoff: gate })
    try {
      await c.connect()
      await crash(c)
      await expect(c.connect()).rejects.toBeInstanceOf(AcpReconnectPausedError)
      expect(c.state.backoff?.latched).toBe(true)
      await c.connect({ manual: true })
      expect(c.status).toBe('connected')
      expect(c.state.backoff).toBeUndefined()
    } finally {
      await c.disconnect()
    }
  }, 20_000)
})

describe('ACPClient 会话列表 / 认领 / 分叉', () => {
  it('session/list 翻页到底,按 cwd 过滤;没自报 list 就抛 AcpCapabilityMissingError', async () => {
    seedSession('s-a', { title: 'Alpha', updatedAt: '2026-09-01T00:00:00Z' })
    seedSession('s-b', { title: 'Beta' })
    seedSession('s-c', {})
    const c = new ACPClient(config({ FAKE_AGENT_CAPS: 'list,load', FAKE_AGENT_LIST_PAGE: '1' }), { getSessionLinks: () => links })
    try {
      const listed = await c.listRemoteSessions(cwd)
      expect(listed.map(info => info.acpSessionId)).toEqual(['s-a', 's-b', 's-c'])
      expect(listed[0]).toEqual({ acpSessionId: 's-a', cwd, title: 'Alpha', updatedAt: '2026-09-01T00:00:00Z' })
      expect(calls().filter(call => call.method === 'list')).toHaveLength(3)
      expect(await c.listRemoteSessions(join(root, 'elsewhere'))).toEqual([])
    } finally {
      await c.disconnect()
    }
    const bare = new ACPClient(config({ FAKE_AGENT_CAPS: 'load' }), { getSessionLinks: () => links })
    try {
      await expect(bare.listRemoteSessions()).rejects.toBeInstanceOf(AcpCapabilityMissingError)
    } finally {
      await bare.disconnect()
    }
  }, 20_000)

  it('认领:load 的回放按序交回、链接落盘;之后普通的恢复照旧丢回放', async () => {
    seedSession('s-a', {
      title: 'Alpha',
      history: [
        { kind: 'user', text: 'hello' },
        { kind: 'thought', text: 'thinking' },
        { kind: 'agent', text: 'hi there' },
        { kind: 'tool', id: 't1', title: 'Read x', input: { path: 'x' } },
        { kind: 'user', text: 'again' },
        { kind: 'agent', text: 'sure' },
      ],
    })
    const c = new ACPClient(config({ FAKE_AGENT_CAPS: 'list,load' }), { getSessionLinks: () => links })
    try {
      const adopted = await c.adoptRemoteSession('local-a', 's-a', cwd)
      expect(adopted.acpSessionId).toBe('s-a')
      expect(adopted.replay.map(update => update.sessionUpdate)).toEqual([
        'user_message_chunk',
        'agent_thought_chunk',
        'agent_message_chunk',
        'tool_call',
        'tool_call_update',
        'user_message_chunk',
        'agent_message_chunk',
      ])
      expect(links.getLink('fake', 'local-a')).toMatchObject({ acpSessionId: 's-a', cwd })
      expect(links.findByAcpSession('fake', 's-a').map(link => link.localSessionId)).toEqual(['local-a'])
      // 认领出来的会话就是那一条:下一轮直接在它上面说话,不再开新会话。
      expect(await say(c, 'local-a')).toContain('session=s-a')
      expect(calls().filter(call => call.method === 'new')).toHaveLength(0)
    } finally {
      await c.disconnect()
    }
  }, 20_000)

  it('认领要 loadSession:没有就抛 AcpCapabilityMissingError', async () => {
    seedSession('s-a', {})
    const c = new ACPClient(config({ FAKE_AGENT_CAPS: 'list,resume' }), { getSessionLinks: () => links })
    try {
      await expect(c.adoptRemoteSession('local-a', 's-a', cwd)).rejects.toBeInstanceOf(AcpCapabilityMissingError)
      expect(links.getLink('fake', 'local-a')).toBeUndefined()
    } finally {
      await c.disconnect()
    }
  }, 20_000)

  it('分叉:session/fork 出一条新 agent 会话,记到目标本地会话名下,链接不同', async () => {
    const c = new ACPClient(config({ FAKE_AGENT_CAPS: 'fork,load' }), { getSessionLinks: () => links })
    try {
      expect(await say(c, 'local-src')).toContain('turns=1')
      const sourceAcp = links.getLink('fake', 'local-src')?.acpSessionId
      const forked = await c.forkSession('local-src', 'local-fork')
      expect(forked.acpSessionId).not.toBe(sourceAcp)
      expect(forked.cwd).toBe(cwd)
      expect(calls().find(call => call.method === 'fork')).toMatchObject({ from: sourceAcp, id: forked.acpSessionId, cwd })
      expect(links.getLink('fake', 'local-fork')?.acpSessionId).toBe(forked.acpSessionId)
      // fork 出来的那条带着源的轮次;下一轮在它上面说。
      expect(await say(c, 'local-fork')).toContain(`session=${forked.acpSessionId}`)
    } finally {
      await c.disconnect()
    }
    const bare = new ACPClient(config({ FAKE_AGENT_CAPS: 'load' }), { getSessionLinks: () => links })
    try {
      await expect(bare.forkSession('local-src', 'local-x')).rejects.toBeInstanceOf(AcpCapabilityMissingError)
    } finally {
      await bare.disconnect()
    }
  }, 20_000)
})
