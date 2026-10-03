import { describe, expect, it } from 'vitest'
import { formatStateVariablesForPrompt } from '../format.js'
import { SessionStoreProvider } from '../providers/session-store.js'
import { parseVariablesFile } from '../schema.js'
import type { ContextVariable } from '../types.js'

function makeProvider() {
  const store = new Map<string, ContextVariable[]>()
  return new SessionStoreProvider({
    read: sessionId => store.get(sessionId) ?? [],
    write: (sessionId, variables) => {
      store.set(sessionId, variables)
    },
  })
}

describe('custom variable state flag', () => {
  it('persists state through set/list; only state variables reach the prompt', async () => {
    const provider = makeProvider()
    const ctx = { sessionId: 's1' }
    await provider.set(ctx, { name: 'migration_state', value: 'phase 2/3', state: true })
    await provider.set(ctx, { name: 'deploy_target', value: 'staging' })

    const listed = provider.list(ctx)
    expect(listed.find(v => v.name === 'migration_state')?.state).toBe(true)
    expect(listed.find(v => v.name === 'deploy_target')?.state).toBeUndefined()

    // state 带值进正文,非 state 只留一行名录(§R.4 修订)。
    expect(formatStateVariablesForPrompt(listed)).toBe([
      '<var name="migration_state" state="true">phase 2/3</var>',
      '<var name="deploy_target" state="false"/>',
    ].join('\n'))
  })

  it('state is sticky across writes — a value update does not silently demote it', async () => {
    const provider = makeProvider()
    const ctx = { sessionId: 's1' }
    await provider.set(ctx, { name: 'migration_state', value: 'phase 1/3', state: true })
    await provider.set(ctx, { name: 'migration_state', value: 'phase 2/3' })

    expect(provider.list(ctx).find(v => v.name === 'migration_state')?.state).toBe(true)
  })

  /**
   * §R.6 的读盘迁移:旧会话文件里存的是三档 volatility。'turn' 是唯一"要一直
   * 在眼前"的那一档,其余(含从未有 provider 产出过的 'on-demand')归 false ——
   * 用户自建的 static 变量因此变成"要自己去读",这是明说的行为变化。
   */
  it('migrates the legacy volatility field on read, without rewriting the file', () => {
    const stored = [
      { name: 'legacy_turn', value: 'a', volatility: 'turn' },
      { name: 'legacy_static', value: 'b', volatility: 'static' },
      { name: 'legacy_on_demand', value: 'c', volatility: 'on-demand' },
      { name: 'no_field', value: 'd' },
    ] as unknown as ContextVariable[]
    const provider = new SessionStoreProvider({
      read: () => stored,
      write: () => undefined,
    })

    const listed = provider.list({ sessionId: 's1' })
    expect(listed.find(v => v.name === 'legacy_turn')?.state).toBe(true)
    expect(listed.find(v => v.name === 'legacy_static')?.state).toBe(false)
    expect(listed.find(v => v.name === 'legacy_on_demand')?.state).toBe(false)
    expect(listed.find(v => v.name === 'no_field')?.state).toBeUndefined()

    // 迁移过来的非 state 同样只进名录 —— 值要自己 get,但它们的存在不再是秘密。
    expect(formatStateVariablesForPrompt(listed)).toBe([
      '<var name="legacy_turn" state="true">a</var>',
      '<var name="legacy_on_demand" state="false"/>',
      '<var name="legacy_static" state="false"/>',
      '<var name="no_field" state="false"/>',
    ].join('\n'))
  })

  it('applies the same migration when variables.json is parsed', () => {
    const { data, recovered } = parseVariablesFile({
      user_note_dir: '',
      work_note_dir: '',
      global_variables: [
        { name: 'legacy_turn', value: 'a', volatility: 'turn' },
        { name: 'legacy_static', value: 'b', volatility: 'static' },
        { name: 'already_new', value: 'c', state: true },
        { name: 'plain', value: 'd' },
      ],
      agent_variables: {},
      project_variables: {},
    })

    expect(recovered).toBe(false)
    expect(data.global_variables.map(v => [v.name, v.state])).toEqual([
      ['legacy_turn', true],
      ['legacy_static', false],
      ['already_new', true],
      ['plain', undefined],
    ])
  })
})
