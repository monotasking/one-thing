import { describe, expect, it, vi } from 'vitest'
import {
  addOnethingSkillDirectoryForIpc,
  createOnethingSkillForIpc,
  deleteOnethingSkillForIpc,
  listOnethingSkillDirectoriesForIpc,
  listOnethingSkillsForIpc,
  openOnethingSkillDirectoryForIpc,
  readOnethingSkillFileForIpc,
  refreshOnethingSkillsForIpc,
  removeOnethingSkillDirectoryForIpc,
  setOnethingSkillAgentForIpc,
  toggleOnethingSkillEnabledForIpc,
  updateOnethingSkillDirectoryForIpc,
} from '../ipc-operations.js'
import type { SkillDefinition, SkillSettings } from '../types.js'

function skill(id = 'user:demo'): SkillDefinition {
  return {
    id,
    name: 'demo',
    description: 'Demo skill',
    source: 'user',
    path: '/skills/demo/SKILL.md',
    directoryPath: '/skills/demo',
    enabled: true,
    instructions: 'Use demo.',
  }
}

describe('skills IPC operations', () => {
  it('lists and refreshes renderer-facing skills through adapters', async () => {
    const ensureInitialized = vi.fn()
    const invalidateSkillsCache = vi.fn()
    const listSkills = vi.fn(() => [skill()])

    await expect(listOnethingSkillsForIpc({
      workingDirectory: '/repo',
      ensureInitialized,
      listSkills,
    })).resolves.toEqual({
      success: true,
      skills: [skill()],
    })
    expect(ensureInitialized).toHaveBeenCalled()
    expect(listSkills).toHaveBeenCalledWith({
      workingDirectory: '/repo',
      enabledOnly: false,
    })

    await expect(refreshOnethingSkillsForIpc({
      invalidateSkillsCache,
      listSkills,
    })).resolves.toEqual({
      success: true,
      skills: [skill()],
    })
    expect(invalidateSkillsCache).toHaveBeenCalled()
  })

  it('reads skill support files and reports missing files', async () => {
    await expect(readOnethingSkillFileForIpc({
      skillId: 'user:demo',
      fileName: 'SKILL.md',
      readSkillFile: () => 'content',
    })).resolves.toEqual({
      success: true,
      content: 'content',
    })

    await expect(readOnethingSkillFileForIpc({
      skillId: 'user:demo',
      fileName: 'missing.md',
      readSkillFile: () => null,
    })).resolves.toEqual({
      success: false,
      error: 'File not found or not readable',
    })
  })

  it('opens either a concrete skill directory or the user skills folder', async () => {
    const openPath = vi.fn()
    const listSkills = vi.fn(() => [skill()])

    await expect(openOnethingSkillDirectoryForIpc({
      skillId: 'user:demo',
      listSkills,
      getUserSkillsPath: () => '/skills/user',
      openPath,
    })).resolves.toEqual({ success: true })
    expect(openPath).toHaveBeenCalledWith('/skills/demo')

    await expect(openOnethingSkillDirectoryForIpc({
      skillId: 'missing',
      listSkills,
      getUserSkillsPath: () => '/skills/user',
      openPath,
    })).resolves.toEqual({ success: true })
    expect(openPath).toHaveBeenLastCalledWith('/skills/user')

    await expect(openOnethingSkillDirectoryForIpc({
      listSkills,
      getUserSkillsPath: () => '/skills/user',
      openPath: () => 'Native open failed',
    })).resolves.toEqual({
      success: false,
      error: 'Native open failed',
    })
  })

  it('creates and deletes skills while invalidating caches', async () => {
    const invalidateSkillsCache = vi.fn()
    const createSkill = vi.fn(() => skill())

    await expect(createOnethingSkillForIpc({
      name: 'demo',
      description: 'Demo skill',
      instructions: 'Use demo.',
      source: 'user',
      createSkill,
      invalidateSkillsCache,
    })).resolves.toEqual({
      success: true,
      skill: skill(),
    })
    expect(createSkill).toHaveBeenCalledWith('demo', 'Demo skill', 'Use demo.', 'user')
    expect(invalidateSkillsCache).toHaveBeenCalled()

    await expect(deleteOnethingSkillForIpc({
      skillId: 'user:demo',
      deleteSkill: vi.fn(() => true),
      invalidateSkillsCache,
    })).resolves.toEqual({ success: true })

    await expect(deleteOnethingSkillForIpc({
      skillId: 'missing',
      deleteSkill: vi.fn(() => false),
      invalidateSkillsCache,
    })).resolves.toEqual({
      success: false,
      error: 'Skill not found',
    })
  })

  it('toggles skill settings with default settings shape', async () => {
    const settings: { skills?: { enableSkills: boolean; skills: Record<string, { enabled: boolean }> } } = {}
    const saveSettings = vi.fn()

    await expect(toggleOnethingSkillEnabledForIpc({
      skillId: 'user:demo',
      enabled: false,
      getSettings: () => settings,
      saveSettings,
    })).resolves.toEqual({ success: true })

    expect(settings.skills).toEqual({
      enableSkills: true,
      skills: {
        'user:demo': { enabled: false },
      },
    })
    expect(saveSettings).toHaveBeenCalledWith(settings)
  })

  it('preserves an existing agent binding when toggling enabled state', async () => {
    const settings: { skills?: SkillSettings } = {
      skills: {
        enableSkills: true,
        skills: { 'user:demo': { enabled: true, agentId: 'writer' } },
      },
    }

    await expect(toggleOnethingSkillEnabledForIpc({
      skillId: 'user:demo',
      enabled: false,
      getSettings: () => settings,
      saveSettings: vi.fn(),
    })).resolves.toEqual({ success: true })

    expect(settings.skills?.skills['user:demo']).toEqual({ enabled: false, agentId: 'writer' })
  })

  it('assigns and clears per-skill agent bindings', async () => {
    const settings: { skills?: SkillSettings } = {}
    const saveSettings = vi.fn()
    const invalidateSkillsCache = vi.fn()

    await expect(setOnethingSkillAgentForIpc({
      skillId: 'user:demo',
      agentId: 'coder',
      currentEnabled: true,
      getSettings: () => settings,
      saveSettings,
      invalidateSkillsCache,
    })).resolves.toEqual({ success: true })
    expect(settings.skills?.skills['user:demo']).toEqual({ enabled: true, agentId: 'coder' })
    expect(invalidateSkillsCache).toHaveBeenCalled()

    await expect(setOnethingSkillAgentForIpc({
      skillId: 'user:demo',
      agentId: null,
      getSettings: () => settings,
      saveSettings,
      invalidateSkillsCache,
    })).resolves.toEqual({ success: true })
    expect(settings.skills?.skills['user:demo']).toEqual({ enabled: true, agentId: null })
  })

  it('adds, updates, lists, and removes custom skill directories', async () => {
    const settings: { skills?: SkillSettings } = {}
    const saveSettings = vi.fn()
    const invalidateSkillsCache = vi.fn()

    const added = await addOnethingSkillDirectoryForIpc({
      path: '/team/skills',
      label: 'Team',
      agentId: 'writer',
      getSettings: () => settings,
      saveSettings,
      validateDirectory: () => null,
      invalidateSkillsCache,
      createId: () => 'dir-1',
    })
    expect(added).toEqual({
      success: true,
      directory: { id: 'dir-1', path: '/team/skills', label: 'Team', agentId: 'writer', enabled: true },
    })
    expect(invalidateSkillsCache).toHaveBeenCalledTimes(1)

    // Duplicate path is rejected.
    await expect(addOnethingSkillDirectoryForIpc({
      path: '/team/skills',
      getSettings: () => settings,
      saveSettings,
      validateDirectory: () => null,
      invalidateSkillsCache,
    })).resolves.toEqual({ success: false, error: 'Directory is already registered' })

    // Validation failures surface as errors.
    await expect(addOnethingSkillDirectoryForIpc({
      path: '/missing',
      getSettings: () => settings,
      saveSettings,
      validateDirectory: () => 'Directory does not exist',
      invalidateSkillsCache,
    })).resolves.toEqual({ success: false, error: 'Directory does not exist' })

    await expect(listOnethingSkillDirectoriesForIpc({
      getSettings: () => settings,
    })).resolves.toEqual({
      success: true,
      directories: [{ id: 'dir-1', path: '/team/skills', label: 'Team', agentId: 'writer', enabled: true }],
    })

    await expect(updateOnethingSkillDirectoryForIpc({
      id: 'dir-1',
      enabled: false,
      agentId: null,
      getSettings: () => settings,
      saveSettings,
      invalidateSkillsCache,
    })).resolves.toEqual({
      success: true,
      directory: { id: 'dir-1', path: '/team/skills', label: 'Team', agentId: undefined, enabled: false },
    })

    // Removing drops the directory and its per-skill overrides.
    settings.skills!.skills['custom:dir-1:review'] = { enabled: false }
    settings.skills!.skills['user:demo'] = { enabled: true }
    await expect(removeOnethingSkillDirectoryForIpc({
      id: 'dir-1',
      getSettings: () => settings,
      saveSettings,
      invalidateSkillsCache,
    })).resolves.toEqual({ success: true })
    expect(settings.skills?.customDirectories).toEqual([])
    expect(settings.skills?.skills).toEqual({ 'user:demo': { enabled: true } })

    await expect(removeOnethingSkillDirectoryForIpc({
      id: 'dir-1',
      getSettings: () => settings,
      saveSettings,
      invalidateSkillsCache,
    })).resolves.toEqual({ success: false, error: 'Skill directory not found' })
  })
})
