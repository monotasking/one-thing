import { computed, ref } from 'vue'
import type {
  AgentDefinition,
  SkillDefinition,
  SkillDirectoryConfig,
  SkillSettings,
} from '@/types'
import { platformApi } from '@/platform'
import { agentsApi } from '@/platform/agents-client'

export interface UseSkillsEmit {
  (e: 'update:settings', value: SkillSettings): void
}

/**
 * State + IPC for the Skills settings panel: skill list, custom skill
 * directories, agent bindings. Mutations persist immediately through the
 * main process; the emit keeps the parent's localSettings mirror in sync so
 * the settings auto-save never clobbers what was just written.
 */
export function useSkills(getSettings: () => SkillSettings, emit: UseSkillsEmit) {
  const skills = ref<SkillDefinition[]>([])
  const directories = ref<SkillDirectoryConfig[]>([])
  const agents = ref<AgentDefinition[]>([])
  const isLoading = ref(false)
  const lastError = ref<string | null>(null)

  const agentNameById = computed(() => {
    const map = new Map<string, string>()
    for (const agent of agents.value) {
      map.set(agent.id, agent.name)
    }
    return map
  })

  function agentName(agentId: string | null | undefined): string | null {
    if (!agentId) return null
    return agentNameById.value.get(agentId) ?? agentId
  }

  function emitSettings(patch: Partial<SkillSettings>) {
    const current = getSettings()
    emit('update:settings', {
      ...current,
      enableSkills: current.enableSkills ?? true,
      ...patch,
    })
  }

  function emitSkillEntry(skillId: string, entry: { enabled: boolean; agentId?: string | null }) {
    const current = getSettings()
    emitSettings({
      skills: { ...current.skills, [skillId]: entry },
    })
  }

  async function loadAll() {
    isLoading.value = true
    lastError.value = null
    // Settled independently: a host that lacks one endpoint (e.g. the web
    // build without directory management) must not blank the whole page.
    const [skillsResult, directoriesResult, agentsResult] = await Promise.allSettled([
      platformApi.getSkills(),
      platformApi.listSkillDirectories(),
      agentsApi.listAgents(),
    ])
    if (skillsResult.status === 'fulfilled' && skillsResult.value.success && skillsResult.value.skills) {
      skills.value = skillsResult.value.skills
    } else if (skillsResult.status === 'rejected') {
      lastError.value = skillsResult.reason instanceof Error
        ? skillsResult.reason.message
        : 'Failed to load skills'
      console.error('Failed to load skills:', skillsResult.reason)
    }
    if (directoriesResult.status === 'fulfilled' && directoriesResult.value.success && directoriesResult.value.directories) {
      directories.value = directoriesResult.value.directories
    }
    if (agentsResult.status === 'fulfilled' && agentsResult.value.success && agentsResult.value.agents) {
      agents.value = agentsResult.value.agents
    }
    isLoading.value = false
  }

  async function refresh() {
    isLoading.value = true
    lastError.value = null
    try {
      const response = await platformApi.refreshSkills()
      if (response.success && response.skills) {
        skills.value = response.skills
      } else if (response.error) {
        lastError.value = response.error
      }
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : 'Failed to refresh skills'
      console.error('Failed to refresh skills:', error)
    } finally {
      isLoading.value = false
    }
  }

  async function toggleSkillEnabled(skill: SkillDefinition, enabled: boolean) {
    try {
      const response = await platformApi.toggleSkillEnabled(skill.id, enabled)
      if (!response.success) {
        lastError.value = response.error ?? 'Failed to toggle skill'
        return
      }
      skill.enabled = enabled
      emitSkillEntry(skill.id, { enabled, agentId: skill.agentId ?? undefined })
    } catch (error) {
      console.error('Failed to toggle skill:', error)
    }
  }

  async function setSkillAgent(skill: SkillDefinition, agentId: string | null) {
    try {
      const response = await platformApi.setSkillAgent(skill.id, agentId)
      if (!response.success) {
        lastError.value = response.error ?? 'Failed to assign agent'
        return
      }
      skill.agentId = agentId
      emitSkillEntry(skill.id, { enabled: skill.enabled, agentId })
    } catch (error) {
      console.error('Failed to assign skill agent:', error)
    }
  }

  async function addDirectory(input: { path: string; label?: string; agentId?: string | null }): Promise<string | null> {
    try {
      const response = await platformApi.addSkillDirectory(input)
      if (!response.success || !response.directory) {
        return response.error ?? 'Failed to add skill directory'
      }
      directories.value = [...directories.value, response.directory]
      emitSettings({ customDirectories: directories.value })
      await refresh()
      return null
    } catch (error) {
      return error instanceof Error ? error.message : 'Failed to add skill directory'
    }
  }

  async function updateDirectory(input: { id: string; enabled?: boolean; label?: string; agentId?: string | null }) {
    try {
      const response = await platformApi.updateSkillDirectory(input)
      if (!response.success || !response.directory) {
        lastError.value = response.error ?? 'Failed to update skill directory'
        return
      }
      directories.value = directories.value.map(dir =>
        dir.id === input.id ? response.directory! : dir,
      )
      emitSettings({ customDirectories: directories.value })
      await refresh()
    } catch (error) {
      console.error('Failed to update skill directory:', error)
    }
  }

  async function removeDirectory(id: string) {
    try {
      const response = await platformApi.removeSkillDirectory(id)
      if (!response.success) {
        lastError.value = response.error ?? 'Failed to remove skill directory'
        return
      }
      directories.value = directories.value.filter(dir => dir.id !== id)
      emitSettings({ customDirectories: directories.value })
      await refresh()
    } catch (error) {
      console.error('Failed to remove skill directory:', error)
    }
  }

  async function deleteSkill(skillId: string): Promise<boolean> {
    try {
      const response = await platformApi.deleteSkill(skillId)
      if (!response.success) {
        lastError.value = response.error ?? 'Failed to delete skill'
        return false
      }
      skills.value = skills.value.filter(skill => skill.id !== skillId)
      return true
    } catch (error) {
      console.error('Failed to delete skill:', error)
      return false
    }
  }

  async function openSkillDirectory(skillId?: string) {
    try {
      await platformApi.openSkillDirectory(skillId)
    } catch (error) {
      console.error('Failed to open skill directory:', error)
    }
  }

  async function openPath(path: string) {
    try {
      await platformApi.openPath(path)
    } catch (error) {
      console.error('Failed to open path:', error)
    }
  }

  /** Returns the picked directory path, or null when cancelled/unsupported */
  async function pickDirectory(): Promise<string | null> {
    try {
      const result = await platformApi.showOpenDialog({
        properties: ['openDirectory'],
        title: 'Choose a skills directory',
      })
      if (result && !result.canceled && result.filePaths?.length) {
        return result.filePaths[0]
      }
    } catch (error) {
      console.error('Failed to open directory picker:', error)
    }
    return null
  }

  return {
    skills,
    directories,
    agents,
    isLoading,
    lastError,
    agentName,
    loadAll,
    refresh,
    toggleSkillEnabled,
    setSkillAgent,
    addDirectory,
    updateDirectory,
    removeDirectory,
    deleteSkill,
    openSkillDirectory,
    openPath,
    pickDirectory,
    emitSettings,
  }
}
