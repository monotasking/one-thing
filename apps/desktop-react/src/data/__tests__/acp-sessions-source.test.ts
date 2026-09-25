import { afterEach, describe, expect, it } from 'vitest'
import type { ACPAgentConfig, ACPAgentState } from '@shared/ipc/acp'
import {
  backoffLatched,
  configureAcpSessionsPort,
  forkAgentOf,
  importCandidatesOf,
  remoteSessionsFamily,
  remoteSessionsKey,
  remoteUpdatedAtMs,
  resetAcpSessionsSource,
  sessionCapabilityOf,
} from '../acp-sessions-source'

/**
 * A5-b 的纯判据与名单那一格(正本 `docs/design/acp-integration-2026-09.md` §3.7)。
 * 钉四件:能力位三态(报了 / 没报 / 不知道)、导入候选、分叉判据、名单按 agent × 目录分格且
 * `ok: false` 原样交回(不是失败)。
 */

function agent(id: string, over: Partial<ACPAgentState> = {}, config: Partial<ACPAgentConfig> = {}): ACPAgentState {
  return {
    config: { id, name: id, enabled: true, command: `${id}-bin`, ...config } as ACPAgentConfig,
    status: 'disconnected',
    sessionCount: 0,
    activePromptCount: 0,
    detect: { installed: true, checkedAt: 1 },
    ...over,
  }
}

afterEach(() => {
  configureAcpSessionsPort(undefined)
  resetAcpSessionsSource()
})

describe('sessionCapabilityOf', () => {
  it('没握手过 = 不知道;握手过没报 = 没有;报了(对象)= 有', () => {
    expect(sessionCapabilityOf(agent('a'), 'list')).toBeUndefined()
    expect(sessionCapabilityOf(agent('a', { capabilities: {} }), 'list')).toBe(false)
    expect(sessionCapabilityOf(agent('a', { capabilities: { sessionCapabilities: { fork: {} } } }), 'list')).toBe(false)
    expect(sessionCapabilityOf(agent('a', { capabilities: { sessionCapabilities: { list: {} } } }), 'list')).toBe(true)
  })
})

describe('importCandidatesOf', () => {
  it('启用 ∧ 装着 ∧ 没明说不会列;名册顺序不动', () => {
    const rows = [
      agent('unknown'),
      agent('lists', { capabilities: { sessionCapabilities: { list: {} } } }),
      agent('nolist', { capabilities: { sessionCapabilities: {} } }),
      agent('off', {}, { enabled: false }),
      agent('missing', { detect: { installed: false, checkedAt: 1 } }),
    ]
    expect(importCandidatesOf(rows).map((r) => r.config.id)).toEqual(['unknown', 'lists'])
    expect(importCandidatesOf(undefined)).toEqual([])
  })
})

describe('forkAgentOf', () => {
  const rows = [
    agent('forks', { capabilities: { sessionCapabilities: { fork: {} } } }),
    agent('nofork', { capabilities: { sessionCapabilities: { list: {} } } }),
    agent('unknown'),
  ]
  it('ACP 会话 ∧ 那台明确报了 fork → 那台的 id', () => {
    expect(forkAgentOf({ provider: 'acp', model: 'forks' }, rows)).toBe('forks')
  })
  it('没报 / 不知道 / 不是 ACP / 名册里没有 → 不在场', () => {
    expect(forkAgentOf({ provider: 'acp', model: 'nofork' }, rows)).toBeUndefined()
    expect(forkAgentOf({ provider: 'acp', model: 'unknown' }, rows)).toBeUndefined()
    expect(forkAgentOf({ provider: 'openai', model: 'forks' }, rows)).toBeUndefined()
    expect(forkAgentOf({ provider: 'acp', model: 'ghost' }, rows)).toBeUndefined()
    expect(forkAgentOf(undefined, rows)).toBeUndefined()
  })
})

describe('backoffLatched / remoteUpdatedAtMs', () => {
  it('只有 latched 为真才算闩上', () => {
    expect(backoffLatched(agent('a'))).toBe(false)
    expect(backoffLatched(agent('a', { backoff: { attempts: 2, until: 5, latched: false } }))).toBe(false)
    expect(backoffLatched(agent('a', { backoff: { attempts: 3, latched: true } }))).toBe(true)
  })
  it('ISO 与毫秒都认,认不出 = undefined', () => {
    expect(remoteUpdatedAtMs('2026-09-26T00:00:00Z')).toBe(Date.parse('2026-09-26T00:00:00Z'))
    expect(remoteUpdatedAtMs(1234)).toBe(1234)
    expect(remoteUpdatedAtMs('not a date')).toBeUndefined()
    expect(remoteUpdatedAtMs(undefined)).toBeUndefined()
  })
})

describe('remoteSessionsFamily', () => {
  it('按 agent × 目录分格;`ok: false` 原样落格,不当失败', async () => {
    const calls: Array<[string, string | undefined]> = []
    configureAcpSessionsPort({
      ready: async () => undefined,
      listRemoteSessions: async (agentId, cwd) => {
        calls.push([agentId, cwd])
        return agentId === 'nope'
          ? { ok: false, code: 'unsupported', error: 'no list' }
          : { ok: true, sessions: [{ acpSessionId: 's1', cwd: cwd ?? '' }] }
      },
      adoptSession: async () => ({ ok: false, code: 'failed', error: '' }),
      forkSession: async () => ({ ok: false, code: 'failed', error: '' }),
      reconnectAgent: async () => ({ ok: false, error: '' }),
    })
    const yes = remoteSessionsFamily.get(remoteSessionsKey('gemini', '/w'))
    const no = remoteSessionsFamily.get(remoteSessionsKey('nope', '/w'))
    await yes.ensure()
    await no.ensure()
    expect(calls).toEqual([
      ['gemini', '/w'],
      ['nope', '/w'],
    ])
    expect(yes.get().data).toEqual({ ok: true, sessions: [{ acpSessionId: 's1', cwd: '/w' }] })
    expect(no.get().error).toBeUndefined()
    expect(no.get().data).toMatchObject({ ok: false, code: 'unsupported' })
  })
})
