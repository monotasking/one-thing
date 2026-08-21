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
    const variables = [
      v({ name: 'workdir', scope: 'session' }),
      v({ name: 'user_note_dir', scope: 'global' }),
      v({ name: 'owner_secret_target', scope: 'global' }),
      v({ name: 'task_state', scope: 'session' }),
    ]
    expect(guard.filterVariablesForSession('ext-telegram', variables).map(x => x.name))
      .toEqual(['workdir', 'user_note_dir', 'task_state'])
    expect(guard.filterVariablesForSession('desktop-session', variables)).toHaveLength(4)
  })

  it('blocks external sessions from writing global scope', () => {
    expect(() => guard.assertExternalWriteAllowed('ext-telegram', 'anything', 'global'))
      .toThrow(/cannot be modified from a channel/)
    expect(() => guard.assertExternalWriteAllowed('desktop-session', 'anything', 'global'))
      .not.toThrow()
  })

  it('blocks note-dir writes even without an explicit global scope', () => {
    // NotesProvider claims these names regardless of the declared scope, so
    // the guard must key off the effective target, not the scope parameter.
    expect(() => guard.assertExternalWriteAllowed('ext-telegram', 'work_note_dir', undefined))
      .toThrow(/cannot be modified/)
    expect(() => guard.assertExternalWriteAllowed('ext-telegram', 'user_note_dir', 'session'))
      .toThrow(/cannot be modified/)
  })

  it('allows external sessions full use of session-scoped state', () => {
    expect(() => guard.assertExternalWriteAllowed('ext-telegram', 'task_state', undefined))
      .not.toThrow()
    expect(() => guard.assertExternalWriteAllowed('ext-telegram', 'workdir', 'session'))
      .not.toThrow()
  })
})
