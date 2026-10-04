import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RequestError } from '@agentclientprotocol/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ACPClient } from '../acp-client.js'
import { toAcpPromptError } from '../acp-client-errors.js'
import { FileACPSessionLinkStore, type ACPSessionLinkStore } from '../acp-session-links.js'
import type { ACPAgentConfig } from '@shared/contracts/acp.js'

/**
 * 选项写失败的自愈(2026-09-29 事故:换模型 13 次 `Internal error`,药丸弹回旧模型,重启桌面才好)。
 *
 * 夹具是真子进程的 ACP agent(`fixtures/fake-agent.mjs`),`FAKE_AGENT_SET_FAIL` 决定它怎么拒
 * `session/set_config_option`。断言三件:
 *  ① agent 的原话(`data`)进抛出去的那句话,不再只剩 `Internal error`;
 *  ② 一般的 JSON-RPC 拒绝 → 忘掉本地记录、经平常那条路重开、**只再试一次**;
 *  ③ `invalid params` 与 `auth_required` 不重试(前者是值不对,后者是没登录);
 *  ④ 空壳(claude-agent-acp 查询流收了尾的会话):agent 声明了 `sessionCapabilities.close` 就先
 *     `session/close` 再 resume 同一个 id;没声明就照旧;这条会话正有一轮在跑就不自救。
 */

const AGENT = fileURLToPath(new URL('./fixtures/fake-agent.mjs', import.meta.url))
const SESSION_ENDED = 'The Claude Agent session has ended. Please start a new session.'

let root: string
let agentDir: string
let cwd: string
let links: ACPSessionLinkStore

function client(setFail: string, caps = 'load', extraEnv: Record<string, string> = {}): ACPClient {
  return new ACPClient({
    id: 'fake',
    name: 'Fake',
    enabled: true,
    command: process.execPath,
    args: [AGENT],
    env: { FAKE_AGENT_DIR: agentDir, FAKE_AGENT_CAPS: caps, FAKE_AGENT_SET_FAIL: setFail, ...extraEnv },
    connectTimeoutMs: 10_000,
  } as ACPAgentConfig, { getSessionLinks: () => links })
}

function calls(): Array<{ method: string; id?: string; value?: string; code?: number }> {
  try {
    return readFileSync(join(agentDir, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  } catch {
    return []
  }
}

/** agent 收到的会话类调用(握手那一行不算)。 */
function methods(): string[] {
  return calls().map(call => call.method).filter(method => method !== 'init')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acp-option-recovery-'))
  agentDir = join(root, 'agent')
  cwd = join(root, 'work')
  links = new FileACPSessionLinkStore(() => join(root, 'store', 'acp', 'session-links.json'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('选项写失败的自愈', () => {
  it('第一次 -32603 → 重开一次、再写一次就成,答回来的选项带新值', async () => {
    const c = client('internal-once')
    try {
      const options = await c.setSessionOption('local-1', cwd, 'model', 'beta')
      expect(options.find(option => option.id === 'model')?.currentValue).toBe('beta')
      // 开 → 拒 → 经链接恢复(load)→ 再写成功:恰好一次重开。
      expect(methods()).toEqual(['new', 'set-refused', 'load', 'set'])
      const [refused, written] = [calls().find(call => call.method === 'set-refused'), calls().find(call => call.method === 'set')]
      expect(refused?.code).toBe(-32603)
      expect(written?.value).toBe('beta')
      expect(links.getLink('fake', 'local-1')?.options).toEqual({ model: 'beta' })
    } finally {
      await c.disconnect()
    }
  })

  it('一直 -32603 → 只试两次,抛出去的话带 agent 的原话', async () => {
    const c = client('internal')
    try {
      const failure = await c.setSessionOption('local-1', cwd, 'model', 'beta').then(() => undefined, (error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toContain(SESSION_ENDED)
      expect((failure as Error).message).toContain('Internal error')
      expect(methods().filter(method => method === 'set-refused')).toHaveLength(2)
      expect(methods()).toEqual(['new', 'set-refused', 'load', 'set-refused'])
    } finally {
      await c.disconnect()
    }
  })

  it('-32602 invalid params → 不重试,话带细节', async () => {
    const c = client('invalid')
    try {
      await expect(c.setSessionOption('local-1', cwd, 'model', 'beta')).rejects.toThrow('Invalid params: Unknown model value: gamma')
      expect(methods()).toEqual(['new', 'set-refused'])
    } finally {
      await c.disconnect()
    }
  })

  it('auth_required → 不重试,与 prompt 那条路同一句话,并记下「要登录」', async () => {
    const c = client('auth')
    try {
      const expected = toAcpPromptError(RequestError.authRequired(), 'Fake').message
      await expect(c.setSessionOption('local-1', cwd, 'model', 'beta')).rejects.toThrow(expected)
      expect(expected).toContain('is not logged in')
      expect(c.authRequired).toBe(true)
      expect(methods()).toEqual(['new', 'set-refused'])
    } finally {
      await c.disconnect()
    }
  })

  it('空壳 + agent 会 close:close → resume(同一个 id)→ 写成功,只 close 一次', async () => {
    const c = client('husk', 'resume,close')
    try {
      const options = await c.setSessionOption('local-1', cwd, 'model', 'beta')
      expect(options.find(option => option.id === 'model')?.currentValue).toBe('beta')
      expect(methods()).toEqual(['new', 'set-refused', 'close', 'resume', 'set'])
      const id = calls().find(call => call.method === 'new')?.id
      expect(id).toBeTruthy()
      for (const method of ['set-refused', 'close', 'resume', 'set']) {
        expect(calls().find(call => call.method === method)?.id).toBe(id)
      }
    } finally {
      await c.disconnect()
    }
  })

  it('空壳 + agent 不会 close:从不发 session/close,照旧重开重试一次', async () => {
    const c = client('husk', 'resume')
    try {
      await expect(c.setSessionOption('local-1', cwd, 'model', 'beta')).rejects.toThrow(SESSION_ENDED)
      expect(methods()).toEqual(['new', 'set-refused', 'resume', 'set-refused'])
    } finally {
      await c.disconnect()
    }
  })

  it('这条会话正有一轮在跑:不 close、不重试,话带原话,那一轮照常说完', async () => {
    const c = client('husk', 'resume,close', { FAKE_AGENT_SLOW: '1' })
    try {
      let finished = false
      const drained = (async () => {
        for await (const event of c.streamPrompt({ localSessionId: 'local-1', prompt: '@slow hi', cwd })) {
          if (event.type === 'finish') finished = true
        }
      })()
      await expect.poll(() => methods().includes('slow-start'), { timeout: 5000 }).toBe(true)

      await expect(c.setSessionOption('local-1', cwd, 'model', 'beta')).rejects.toThrow(SESSION_ENDED)
      expect(methods()).toEqual(['new', 'slow-start', 'set-refused'])

      writeFileSync(join(agentDir, 'release-slow'), '1')
      await drained
      expect(finished).toBe(true)
      expect(methods()).not.toContain('close')
      expect(c.hasLiveSession('local-1')).toBe(true)
    } finally {
      await c.disconnect()
    }
  })
})
