import { describe, expect, it } from 'vitest'
import { resolveSceneHiddenToolIds, SKILL_SCENE_TOOLS } from '../scene-surface.js'

const COLLAB = ['send_message', 'board', 'history', 'notebook']
const FEATURE = ['feature_mount', 'feature_unmount', 'feature_inspect']

describe('resolveSceneHiddenToolIds', () => {
  it('a plain chat turn hides collab, goal and skill-scene tools, keeps the chat floor', () => {
    const hidden = resolveSceneHiddenToolIds({ session: { kind: 'chat' } })
    for (const id of [...COLLAB, 'goal', ...FEATURE]) expect(hidden).toContain(id)
    for (const id of ['bash', 'read', 'write', 'edit', 'variable', 'task', 'ask_user', 'time', 'web_search', 'web_open', 'radio', 'practice']) {
      expect(hidden).not.toContain(id)
    }
  })

  it('an unknown / missing kind is a chat turn (gateway sessions must not leak collab tools)', () => {
    expect(resolveSceneHiddenToolIds({ session: undefined })).toEqual(
      expect.arrayContaining(COLLAB),
    )
    expect(resolveSceneHiddenToolIds({ session: { kind: 'weird' } })).toEqual(
      expect.arrayContaining(COLLAB),
    )
  })

  it('room / agent / work turns see the collab tools their venue allows', () => {
    const room = resolveSceneHiddenToolIds({ session: { kind: 'room' } })
    expect(room).not.toContain('send_message')
    expect(room).not.toContain('board')
    expect(room).not.toContain('history')
    // notebook 只在 agent / work(collab/tool-surface.ts 的场子表)。
    expect(room).toContain('notebook')

    for (const kind of ['agent', 'work']) {
      const hidden = resolveSceneHiddenToolIds({ session: { kind } })
      for (const id of COLLAB) expect(hidden).not.toContain(id)
    }
  })

  it('goal is visible only while the session goal is active', () => {
    expect(resolveSceneHiddenToolIds({ session: { goal: { status: 'active' } } })).not.toContain('goal')
    for (const status of ['paused', 'complete', 'abandoned', 'budget_limited', undefined]) {
      expect(resolveSceneHiddenToolIds({ session: { goal: status ? { status } : null } })).toContain('goal')
    }
  })

  it('a dispatched task session cannot see task (no nesting)', () => {
    expect(resolveSceneHiddenToolIds({ session: { task: { parentSessionId: 'p' } } })).toContain('task')
    expect(resolveSceneHiddenToolIds({ session: {} })).not.toContain('task')
  })

  it('skill-scene tools appear only when that skill is enabled for the turn', () => {
    expect(SKILL_SCENE_TOOLS['onething-self-evolution']).toEqual(FEATURE)
    const off = resolveSceneHiddenToolIds({ session: {}, enabledSkillNames: ['other'] })
    for (const id of FEATURE) expect(off).toContain(id)
    const on = resolveSceneHiddenToolIds({ session: {}, enabledSkillNames: ['onething-self-evolution'] })
    for (const id of FEATURE) expect(on).not.toContain(id)
  })
})
