import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ACPAgentConfig, ACPAgentState } from '@shared/ipc/acp'
import {
  acpAgentsQuery,
  agentIdFromName,
  agentStateOfFrame,
  argsFromLine,
  argsToLine,
  configureAcpAgentsPort,
  detectAgentsMutation,
  replaceAgentRow,
  resetAcpAgentsSource,
  startAcpAgentsSource,
  updateAgentMutation,
  updatePayloadOf,
  type AcpAgentsPort,
} from '../acp-agents-source'

/**
 * ACP 名册的数据层(A1-b)。钉四件:
 *  ① **发给后端的那一份**:种子 agent 的启用开关只带 `enabled` 是不够的(后端对已有覆盖
 *     是整条替换)—— 发的是生效配置 ⊕ 改动;`enabled` 只在「这次改的就是它」或「上次显式拨过」
 *     时带上;用户手加的条目整份发;
 *  ② 推送帧就地换一行,不整份重灌,名册那三格(manifest / source / detect)不被一帧推送擦掉;
 *  ③ 「重新探测」的回答直接落格;
 *  ④ 小纯函数:名字 → id、参数一行 ↔ 数组、推送帧判形。
 */

function row(over: Omit<Partial<ACPAgentState>, 'config'> & { id: string; config?: Partial<ACPAgentConfig> }): ACPAgentState {
  const { id, config, ...rest } = over
  return {
    config: { id, name: id, enabled: true, command: `${id}-bin`, args: [], ...config } as ACPAgentConfig,
    status: 'disconnected',
    sessionCount: 0,
    activePromptCount: 0,
    source: 'builtin',
    manifest: { id, name: id.toUpperCase(), launch: { command: `${id}-bin` } },
    detect: { installed: true, version: '1.2.3', checkedAt: 1 },
    ...rest,
  }
}

interface Fake extends AcpAgentsPort {
  rows: ACPAgentState[]
  updates: ACPAgentConfig[]
  emit(state: ACPAgentState): void
}

function fakePort(rows: ACPAgentState[]): Fake {
  let listener: ((state: ACPAgentState) => void) | undefined
  const fake: Fake = {
    rows,
    updates: [],
    ready: async () => undefined,
    getAgents: async () => ({ success: true, agents: fake.rows }),
    detect: async () => ({ success: true, agents: fake.rows.map((r) => ({ ...r, detect: { installed: false, checkedAt: 2 } })) }),
    refreshRegistry: async () => ({ success: true, agents: fake.rows }),
    addAgent: async () => ({ success: true }),
    updateAgent: async (config) => {
      fake.updates.push(config)
      return { success: true }
    },
    removeAgent: async () => ({ success: true }),
    authenticate: async () => ({ ok: true }),
    onAgentState: (callback) => {
      listener = callback
      return () => {
        listener = undefined
      }
    },
    emit: (state) => listener?.(state),
  }
  return fake
}

beforeEach(() => resetAcpAgentsSource())
afterEach(() => {
  resetAcpAgentsSource()
  configureAcpAgentsPort(undefined)
})

describe('updatePayloadOf —— 发给 acp.updateAgent 的那一份', () => {
  it('种子 agent 拨启用:生效配置 ⊕ { enabled },id 必在', () => {
    const payload = updatePayloadOf(row({ id: 'gemini' }), { enabled: false })
    expect(payload.id).toBe('gemini')
    expect(payload.enabled).toBe(false)
    // 其余格照生效值带着 —— 与种子相等的由后端剥掉,不相等的(上次改过的)得以保住。
    expect(payload.command).toBe('gemini-bin')
  })

  it('种子 agent 改别的格:启用值等于缺省(= 探测到已安装)时**不带** enabled,别把随探测走的值钉死', () => {
    const payload = updatePayloadOf(row({ id: 'gemini' }), { command: 'my-gemini' })
    expect('enabled' in payload).toBe(false)
    expect(payload.command).toBe('my-gemini')
  })

  it('种子 agent 改别的格:上次显式拨过启用(与缺省不同)→ 带上,不让这次保存把那一拨抹掉', () => {
    const disabled = row({ id: 'gemini', config: { enabled: false } })
    expect(updatePayloadOf(disabled, { command: 'x' }).enabled).toBe(false)
    const forced = row({ id: 'kimi', config: { enabled: true }, detect: { installed: false, checkedAt: 1 } })
    expect(updatePayloadOf(forced, { command: 'x' }).enabled).toBe(true)
  })

  it('用户手加的条目:整份发(它没有 manifest 可以相减)', () => {
    const mine = row({ id: 'mine', source: 'user' })
    const payload = updatePayloadOf(mine, { args: ['--acp'] })
    expect(payload).toMatchObject({ id: 'mine', name: 'mine', enabled: true, command: 'mine-bin', args: ['--acp'] })
  })
})

describe('名册的就地更新', () => {
  it('推送帧换掉那一行,别的行身份不变;名册那三格缺席时留旧行的', () => {
    const a = row({ id: 'a' })
    const b = row({ id: 'b' })
    const next = replaceAgentRow([a, b], { ...row({ id: 'b' }), status: 'connected', pid: 42, manifest: undefined, detect: undefined, source: undefined })
    expect(next[0]).toBe(a)
    expect(next[1]).toMatchObject({ status: 'connected', pid: 42 })
    expect(next[1]!.manifest).toBe(b.manifest)
    expect(next[1]!.detect).toBe(b.detect)
  })

  it('推不认识的那一台 → 接到末尾', () => {
    expect(replaceAgentRow([row({ id: 'a' })], row({ id: 'z' })).map((r) => r.config.id)).toEqual(['a', 'z'])
  })

  it('acp:agent-state 经推送面落进同一格', async () => {
    const fake = fakePort([row({ id: 'a' }), row({ id: 'b' })])
    configureAcpAgentsPort(fake)
    await acpAgentsQuery.ensure()
    await startAcpAgentsSource()
    const before = acpAgentsQuery.get().data!
    fake.emit({ ...row({ id: 'a' }), status: 'error', error: 'boom' })
    const after = acpAgentsQuery.get().data!
    expect(after[0]).toMatchObject({ status: 'error', error: 'boom' })
    expect(after[1]).toBe(before[1])
  })

  it('还一行都没拉到时,一帧推送不凭空造名册', async () => {
    const fake = fakePort([row({ id: 'a' })])
    configureAcpAgentsPort(fake)
    await startAcpAgentsSource()
    fake.emit(row({ id: 'a' }))
    expect(acpAgentsQuery.get().data).toBeUndefined()
  })

  it('「重新探测」的回答直接落格', async () => {
    configureAcpAgentsPort(fakePort([row({ id: 'a' })]))
    await acpAgentsQuery.ensure()
    await detectAgentsMutation.run()
    expect(acpAgentsQuery.get().data![0]!.detect).toEqual({ installed: false, checkedAt: 2 })
  })

  it('启用开关:乐观翻过去,发出去的是 updatePayloadOf 那一份', async () => {
    const fake = fakePort([row({ id: 'a' })])
    configureAcpAgentsPort(fake)
    await acpAgentsQuery.ensure()
    const state = acpAgentsQuery.get().data![0]!
    const run = updateAgentMutation.run({ state, patch: { enabled: false } })
    expect(acpAgentsQuery.get().data![0]!.config.enabled).toBe(false)
    await run
    expect(fake.updates).toHaveLength(1)
    expect(fake.updates[0]).toMatchObject({ id: 'a', enabled: false })
  })
})

describe('小纯函数', () => {
  it('名字 → id:只收 [a-z0-9-],撞了加序号,拼不出就给一个不撞的', () => {
    expect(agentIdFromName('Claude · 工作', [])).toBe('claude')
    expect(agentIdFromName('My Agent', ['my-agent'])).toBe('my-agent-2')
    expect(agentIdFromName('工作', [])).toMatch(/^custom-[a-z0-9]+$/)
  })

  it('参数一行 ↔ 数组', () => {
    expect(argsFromLine('  --acp   --fast ')).toEqual(['--acp', '--fast'])
    expect(argsToLine(['--acp', '--fast'])).toBe('--acp --fast')
    expect(argsToLine(undefined)).toBe('')
  })

  it('推送帧判形:没有 config.id 的一律丢', () => {
    expect(agentStateOfFrame({ state: row({ id: 'a' }) })?.config.id).toBe('a')
    expect(agentStateOfFrame({ state: { config: {} } })).toBeNull()
    expect(agentStateOfFrame(null)).toBeNull()
  })
})
