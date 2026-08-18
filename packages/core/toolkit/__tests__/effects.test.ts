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

  it('与 core/permission/permission-policy.ts 今天的逐 kind 判定不矛盾', () => {
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

  it('新增的四个 kind 都不会凭空多弹权限卡', () => {
    expect(EFFECT_POLICY.net_fetch.policy).toBe('silent')
    expect(EFFECT_POLICY.user_ask.policy).toBe('silent')
    expect(EFFECT_POLICY.session_message.policy).toBe('silent')
    // R3a 复盘裁定:派工的本义就是"派出去继续干",风险由并发上限与子会话自己的
    // 权限卡兜住;效果保留(且仍是屏障)是为了审计里那条证词。
    expect(EFFECT_POLICY.session_spawn.policy).toBe('silent')
    expect(EFFECT_POLICY.session_spawn.barrier).toBe(true)
    expect(requiresAuthorization([makeEffect('session_spawn', ['s1'])])).toBe(false)
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
