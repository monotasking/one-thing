import { describe, expect, it } from 'vitest'
import type { ContextVariable } from '../index.js'
import { createChannelSessionGuard } from '../channel-guard.js'

const guard = createChannelSessionGuard(sessionId =>
  sessionId.startsWith('ext-') ? { originIdentityKey: 'identity:im:telegram:default:u1' } : {},
)

function v(partial: Partial<ContextVariable> & { name: string }): ContextVariable {
  return { value: 'x', ...partial }
}

describe('channel session guard', () => {
  it('identifies external sessions by originIdentityKey', () => {
    expect(guard.isExternalIdentitySession('ext-telegram')).toBe(true)
    expect(guard.isExternalIdentitySession('desktop-session')).toBe(false)
  })

  it('hides custom global variables from external sessions, keeps reserved ones', () => {
    // 保留名那一条用 `home`(P3:两个笔记目录变量退役,`RESERVED_NAMES` 里不再有它们)。
    const variables = [
      v({ name: 'workdir', scope: 'session' }),
      v({ name: 'home', scope: 'global' }),
      v({ name: 'owner_secret_target', scope: 'global' }),
      v({ name: 'task_state', scope: 'session' }),
    ]
    expect(guard.filterVariablesForSession('ext-telegram', variables).map(x => x.name))
      .toEqual(['workdir', 'home', 'task_state'])
    expect(guard.filterVariablesForSession('desktop-session', variables)).toHaveLength(4)
  })

  it('blocks external sessions from writing global scope', () => {
    expect(() => guard.assertExternalWriteAllowed('ext-telegram', 'anything', 'global'))
      .toThrow(/cannot be modified from a channel/)
    expect(() => guard.assertExternalWriteAllowed('desktop-session', 'anything', 'global'))
      .not.toThrow()
  })

  /**
   * P3(2026-09-18):「声明的 scope 不是 global、写的却是全局状态」这一档没有了
   * —— 那张 `GLOBAL_EFFECT_NAMES` 里只有两个笔记目录变量,它们随笔记领域退役。
   * 今天的判据回到一句话:**看 scope**。再出现这样一个名字时,把它加回
   * `channel-guard.ts`,而不是加在调用方。
   */
  it('按 scope 判,不再按名字:session 档的写一律放行', () => {
    expect(() => guard.assertExternalWriteAllowed('ext-telegram', 'anything', 'session'))
      .not.toThrow()
    expect(() => guard.assertExternalWriteAllowed('ext-telegram', 'anything', undefined))
      .not.toThrow()
    expect(() => guard.assertExternalWriteAllowed('ext-telegram', 'anything', 'agent'))
      .toThrow(/cannot be modified/)
    expect(() => guard.assertExternalWriteAllowed('ext-telegram', 'anything', 'project'))
      .toThrow(/cannot be modified/)
  })

  it('allows external sessions full use of session-scoped state', () => {
    expect(() => guard.assertExternalWriteAllowed('ext-telegram', 'task_state', undefined))
      .not.toThrow()
    expect(() => guard.assertExternalWriteAllowed('ext-telegram', 'workdir', 'session'))
      .not.toThrow()
  })
})
