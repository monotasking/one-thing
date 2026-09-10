import { describe, expect, it } from 'vitest'

import {
  EFFECT_CLASSES,
  EFFECT_POLICY,
  effectPolicyFor,
  isBarrierEffect,
  isKnownEffectClass,
  makeEffect,
  policyOf,
  requiresAuthorization,
} from '../effects.js'
import { isBarrierEffect as coreIsBarrierEffect, type ToolEffectKind } from '../../tools/tool-effect.js'

/** core 现有的 9 个 kind —— 名字不许改,只许新增(§9 风险 2)。 */
const LEGACY_KINDS: ToolEffectKind[] = [
  'read',
  'file_edit',
  'file_write',
  'file_destructive_edit',
  'bash',
  'mcp',
  'external_directory',
  'sensitive_file_read',
  'capability_change',
]

describe('EffectClass 目录与默认策略表', () => {
  it('每个 kind 都有策略行(这是 R0 的前置钉子)', () => {
    for (const kind of EFFECT_CLASSES) {
      const row = EFFECT_POLICY[kind]
      expect(row, `missing policy row for ${kind}`).toBeDefined()
      expect(row.kind).toBe(kind)
      expect(['silent', 'ask', 'never-grantable']).toContain(row.policy)
      expect(row.prompt.length, `missing permission-card copy for ${kind}`).toBeGreaterThan(0)
    }
    expect(EFFECT_CLASSES.length).toBe(Object.keys(EFFECT_POLICY).length)
  })

  it('沿用 core 的 9 个 kind 名', () => {
    for (const kind of LEGACY_KINDS) expect(isKnownEffectClass(kind)).toBe(true)
  })

  /**
   * 合表之后 `core/permission/permission-policy.ts` 不再有自己的逐 kind 口径 ——
   * 它读的就是这张表。所以这条用例的角色从「两处不矛盾」变成「这张表自己的取值
   * 不许被人顺手改掉」;两处一致由 `permission/__tests__/silent-effects.test.ts`
   * 那条遍历量。
   */
  it('这张表的取值:根内读静默,越界读 / 敏感读 / 写 / 命令 / MCP 要问', () => {
    // read 在根内静默;越界读/敏感读是另外两个 kind,它们要问。
    expect(EFFECT_POLICY.read.policy).toBe('silent')
    expect(EFFECT_POLICY.external_directory.policy).toBe('ask')
    expect(EFFECT_POLICY.sensitive_file_read.policy).toBe('ask')
    for (const kind of ['bash', 'mcp', 'file_edit', 'file_write', 'file_destructive_edit'] as const) {
      expect(EFFECT_POLICY[kind].policy, kind).toBe('ask')
    }
    // capability_change 永不可记忆。
    expect(EFFECT_POLICY.capability_change.policy).toBe('never-grantable')
  })

  it('屏障判定与 core/tools/tool-effect.ts 同口径', () => {
    for (const kind of LEGACY_KINDS) {
      expect(EFFECT_POLICY[kind].barrier, kind).toBe(
        coreIsBarrierEffect({ kind, resources: [], barrier: false }),
      )
    }
  })

  /**
   * 合表(2026-09-10 用户拍板)。这四行原本一律 `silent`,而判定核那一侧有第二张
   * 表、四类真跑起来照样弹卡 —— 表说的话不作数。合表把那张名单删掉、判定核改读
   * 这一列,于是这四行必须先说真话:
   *
   *  - `net_fetch` / `user_ask` 留 `silent`(只读的出网取材;以及「我要问你一个
   *    问题」不该先问一次「准不准我问你」)—— 这是**真的行为变化**,两只工具从此
   *    不弹卡;
   *  - `session_message` / `session_spawn` 改 `ask`(往别的会话发消息、开子会话是
   *    真有后果的)—— **行为没变**,是表跟上了行为。
   */
  it('合表后按效果表:出网与提问静默,跨会话投递与派工要问', () => {
    expect(EFFECT_POLICY.net_fetch.policy).toBe('silent')
    expect(EFFECT_POLICY.user_ask.policy).toBe('silent')
    expect(requiresAuthorization([makeEffect('net_fetch', ['https://x'])])).toBe(false)
    expect(requiresAuthorization([makeEffect('user_ask', ['call-1'])])).toBe(false)

    expect(EFFECT_POLICY.session_message.policy).toBe('ask')
    expect(EFFECT_POLICY.session_spawn.policy).toBe('ask')
    expect(requiresAuthorization([makeEffect('session_spawn', ['s1'])])).toBe(true)
    // 屏障与合表无关,照旧:两次并发登记会把并发闸算错。
    expect(EFFECT_POLICY.session_spawn.barrier).toBe(true)
    expect(EFFECT_POLICY.session_message.barrier).toBe(false)
  })

  /**
   * R3a 新增的第五个 kind。它是 `app/plugins/api.ts` 里那句写死的
   * `permissionGuard: 'permission-gated'`(插件不能给自己发免检通行证)在新树里的
   * 说法 —— 恒 ask、带屏障,与旧行为逐字一致。
   */
  it('plugin_exec:恒 ask、带屏障(插件工具旧路恒 permission-gated)', () => {
    expect(EFFECT_POLICY.plugin_exec.policy).toBe('ask')
    expect(EFFECT_POLICY.plugin_exec.barrier).toBe(true)
    expect(isKnownEffectClass('plugin_exec')).toBe(true)
    expect(requiresAuthorization([makeEffect('plugin_exec', ['plugin:demo:echo'])])).toBe(true)
  })

  /**
   * 原子 K2a' 新增的第六个 kind(`docs/design/atom-2026-09.md` §6)。
   *
   * 它不是「没有副作用」,是「副作用只在界面上,而且主体本来就拥有它」——— 那扇窗是
   * 这个人的窗。所以 silent 且**不带屏障**:两条界面动作彼此无关,排队没有东西可保护。
   * silent 不等于不留痕:它照样落 `tool/audit`。
   */
  it('ui_change:silent、不带屏障,但仍是一条认得出来的效果', () => {
    expect(EFFECT_POLICY.ui_change.policy).toBe('silent')
    expect(EFFECT_POLICY.ui_change.barrier).toBe(false)
    expect(isKnownEffectClass('ui_change')).toBe(true)
    expect(requiresAuthorization([makeEffect('ui_change', ['workbench:tab/1'])])).toBe(false)
    expect(isBarrierEffect(makeEffect('ui_change', ['workbench:tab/1']))).toBe(false)
  })

  it('未知 kind 兜底为 ask,绝不静默放行', () => {
    const row = effectPolicyFor('quantum_teleport')
    expect(row.policy).toBe('ask')
    expect(row.barrier).toBe(true)
    expect(isKnownEffectClass('quantum_teleport')).toBe(false)
  })

  it('effect 上的 barrier 可以放松策略表的默认', () => {
    expect(isBarrierEffect(makeEffect('bash', ['ls']))).toBe(true)
    expect(isBarrierEffect(makeEffect('bash', ['ls'], { barrier: false }))).toBe(false)
    expect(isBarrierEffect(makeEffect('read', ['a.ts']))).toBe(false)
  })

  it('requiresAuthorization 只在有非 silent 效果时为真', () => {
    expect(requiresAuthorization([])).toBe(false)
    expect(requiresAuthorization([makeEffect('read', ['a.ts']), makeEffect('net_fetch', ['https://x'])])).toBe(false)
    expect(requiresAuthorization([makeEffect('read', ['a.ts']), makeEffect('bash', ['rm'])])).toBe(true)
    expect(policyOf(makeEffect('capability_change', ['notes']))).toBe('never-grantable')
  })
})
