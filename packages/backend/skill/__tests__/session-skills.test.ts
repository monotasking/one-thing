import { describe, expect, it, vi } from 'vitest'
import {
  createOnethingSessionSkillsRuntime,
  mergeOnethingSkillsByPriority,
  type OnethingSessionSkillLike,
  type OnethingSessionSkillSettings,
} from '../session-skills.js'

interface TestSkill extends OnethingSessionSkillLike {
  source: 'global' | 'project'
}

function skill(id: string, name: string, source: TestSkill['source'], enabled = true): TestSkill {
  return { id, name, source, enabled }
}

describe('onething session skills runtime', () => {
  it('merges skill groups by name priority', () => {
    expect(mergeOnethingSkillsByPriority(
      [skill('project-a', 'review', 'project')],
      [skill('global-a', 'review', 'global'), skill('global-b', 'write', 'global')],
    )).toEqual([
      skill('project-a', 'review', 'project'),
      skill('global-b', 'write', 'global'),
    ])
  })

  it('loads lazily, applies settings, and prefers project skills over global skills', () => {
    let settings: OnethingSessionSkillSettings = {
      skills: {
        'global-disabled': { enabled: false },
        'project-enabled': { enabled: true },
      },
    }
    const ensureSkillsDirectories = vi.fn()
    const loadAllSkills = vi.fn(() => [
      skill('global-disabled', 'disabled', 'global', true),
      skill('global-review', 'review', 'global', true),
    ])
    const loadProjectSkillsForDirectory = vi.fn(() => [
      skill('project-enabled', 'disabled', 'project', false),
      skill('project-review', 'review', 'project', true),
    ])
    const runtime = createOnethingSessionSkillsRuntime<TestSkill>({
      ensureSkillsDirectories,
      loadAllSkills,
      loadProjectSkillsForDirectory,
      getSkillSettings: () => settings,
    })

    expect(runtime.getForSession('/repo')).toEqual([
      skill('project-enabled', 'disabled', 'project', true),
      skill('project-review', 'review', 'project', true),
    ])
    expect(ensureSkillsDirectories).toHaveBeenCalledTimes(1)
    expect(loadAllSkills).toHaveBeenCalledTimes(1)
    expect(loadProjectSkillsForDirectory).toHaveBeenCalledWith('/repo')

    settings = { skills: { 'project-enabled': { enabled: false } } }

    expect(runtime.getForSession('/repo')).toEqual([
      skill('project-review', 'review', 'project', true),
    ])
    expect(loadProjectSkillsForDirectory).toHaveBeenCalledTimes(1)
  })

  it('returns disabled skills for display without mutating cached skill state', () => {
    const runtime = createOnethingSessionSkillsRuntime<TestSkill>({
      ensureSkillsDirectories: vi.fn(),
      loadAllSkills: () => [
        skill('global-enabled', 'enabled', 'global', true),
        skill('global-disabled', 'disabled', 'global', true),
      ],
      loadProjectSkillsForDirectory: vi.fn(),
      getSkillSettings: () => ({
        skills: {
          'global-disabled': { enabled: false },
        },
      }),
    })

    expect(runtime.getAll({ enabledOnly: false })).toEqual([
      skill('global-enabled', 'enabled', 'global', true),
      skill('global-disabled', 'disabled', 'global', false),
    ])
    expect(runtime.getForSession()).toEqual([
      skill('global-enabled', 'enabled', 'global', true),
    ])
  })

  it('filters agent-bound skills by session agent and applies per-skill agent overrides', () => {
    const runtime = createOnethingSessionSkillsRuntime<TestSkill>({
      ensureSkillsDirectories: vi.fn(),
      loadAllSkills: () => [
        { ...skill('custom:dir1:review', 'review', 'global'), agentId: 'writer' },
        skill('user:shared', 'shared', 'global'),
        skill('user:reassigned', 'reassigned', 'global'),
      ],
      loadProjectSkillsForDirectory: vi.fn(),
      getSkillSettings: () => ({
        skills: {
          // Per-skill override binds this one to the coder agent.
          'user:reassigned': { enabled: true, agentId: 'coder' },
        },
      }),
    })

    // Session on the writer agent: gets its bound skill + unbound skills.
    expect(runtime.getForSession(undefined, 'writer').map(s => s.id)).toEqual([
      'custom:dir1:review',
      'user:shared',
    ])
    // Session on the coder agent: override wins, directory-bound skill dropped.
    expect(runtime.getForSession(undefined, 'coder').map(s => s.id)).toEqual([
      'user:shared',
      'user:reassigned',
    ])
    // Display listing without an agent keeps everything and exposes bindings.
    const all = runtime.getAll({ enabledOnly: false })
    expect(all.map(s => [s.id, s.agentId ?? null])).toEqual([
      ['custom:dir1:review', 'writer'],
      ['user:shared', null],
      ['user:reassigned', 'coder'],
    ])
  })

  it('invalidates per-directory and global caches', async () => {
    const loadAllSkills = vi
      .fn<() => TestSkill[]>()
      .mockReturnValueOnce([skill('global-1', 'global', 'global')])
      .mockReturnValueOnce([skill('global-2', 'global', 'global')])
      .mockReturnValue([skill('global-3', 'global', 'global')])
    const loadProjectSkillsForDirectory = vi
      .fn<() => TestSkill[]>()
      .mockReturnValueOnce([skill('project-1', 'project', 'project')])
      .mockReturnValueOnce([skill('project-2', 'project', 'project')])
    const runtime = createOnethingSessionSkillsRuntime<TestSkill>({
      ensureSkillsDirectories: vi.fn(),
      loadAllSkills,
      loadProjectSkillsForDirectory,
      getSkillSettings: () => undefined,
    })

    await runtime.initialize()
    expect(runtime.getForSession('/repo')).toEqual([
      skill('project-1', 'project', 'project'),
      skill('global-1', 'global', 'global'),
    ])

    runtime.invalidateCache('/repo')
    expect(runtime.getForSession('/repo')).toEqual([
      skill('project-2', 'project', 'project'),
      skill('global-1', 'global', 'global'),
    ])

    runtime.invalidateCache()
    expect(runtime.getForSession()).toEqual([
      skill('global-2', 'global', 'global'),
    ])
  })
})
