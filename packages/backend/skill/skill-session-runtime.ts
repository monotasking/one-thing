export interface OnethingSessionSkillLike {
  id: string
  name: string
  enabled: boolean
  /** Agent this skill is scoped to; null/undefined means available to all agents */
  agentId?: string | null
}

export interface OnethingSkillEnabledSetting {
  enabled: boolean
  agentId?: string | null
}

export interface OnethingSessionSkillSettings {
  skills?: Record<string, OnethingSkillEnabledSetting | undefined>
}

export interface OnethingSessionSkillsListOptions {
  workingDirectory?: string
  enabledOnly?: boolean
  /** When provided, drop skills bound to a different agent */
  agentId?: string
}

export interface OnethingSessionSkillsRuntimeAdapters<TSkill extends OnethingSessionSkillLike> {
  ensureSkillsDirectories(): void
  loadAllSkills(): TSkill[]
  loadProjectSkillsForDirectory(workingDirectory: string): TSkill[]
  getSkillSettings(): OnethingSessionSkillSettings | undefined
  logger?: {
    log?: (...args: unknown[]) => void
  }
}

export class OnethingSessionSkillsRuntime<TSkill extends OnethingSessionSkillLike> {
  private initialized = false
  private globalSkillsCache: TSkill[] = []
  private readonly skillsCacheByDir = new Map<string, TSkill[]>()

  constructor(private readonly adapters: OnethingSessionSkillsRuntimeAdapters<TSkill>) {}

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.adapters.ensureSkillsDirectories()
    this.globalSkillsCache = this.adapters.loadAllSkills()
    this.initialized = true
    this.adapters.logger?.log?.(
      '[Skills] Session skill service initialized with',
      this.globalSkillsCache.length,
      'skills',
    )
  }

  getForSession(workingDirectory?: string, agentId?: string): TSkill[] {
    this.ensureInitialized()
    return this.getForDirectory(workingDirectory, true, agentId)
  }

  getAll(options: OnethingSessionSkillsListOptions = {}): TSkill[] {
    this.ensureInitialized()
    return this.getForDirectory(options.workingDirectory, options.enabledOnly ?? false, options.agentId)
  }

  invalidateCache(workingDirectory?: string): void {
    if (workingDirectory) {
      this.skillsCacheByDir.delete(workingDirectory)
      return
    }

    this.skillsCacheByDir.clear()
    if (this.initialized) {
      this.globalSkillsCache = this.adapters.loadAllSkills()
    }
  }

  private ensureInitialized(): void {
    if (this.initialized) return
    this.adapters.ensureSkillsDirectories()
    this.globalSkillsCache = this.adapters.loadAllSkills()
    this.initialized = true
  }

  private getForDirectory(workingDirectory?: string, enabledOnly = true, agentId?: string): TSkill[] {
    const cacheKey = workingDirectory || '__global__'
    const cached = this.skillsCacheByDir.get(cacheKey)
    if (cached) return this.applySkillSettings(cached, enabledOnly, agentId)

    const loaded = workingDirectory
      ? mergeOnethingSkillsByPriority(
        this.adapters.loadProjectSkillsForDirectory(workingDirectory),
        this.globalSkillsCache,
      )
      : this.globalSkillsCache.length > 0 ? this.globalSkillsCache : this.adapters.loadAllSkills()

    this.skillsCacheByDir.set(cacheKey, loaded)
    return this.applySkillSettings(loaded, enabledOnly, agentId)
  }

  private applySkillSettings(skills: TSkill[], enabledOnly: boolean, agentId?: string): TSkill[] {
    const settings = this.adapters.getSkillSettings()
    let result = skills.map(skill => ({ ...skill }))

    if (settings?.skills) {
      for (const skill of result) {
        const skillSettings = settings.skills[skill.id]
        if (skillSettings !== undefined) {
          skill.enabled = skillSettings.enabled
          // Per-skill override beats the directory-level binding; null clears it.
          if ('agentId' in skillSettings) {
            skill.agentId = skillSettings.agentId
          }
        }
      }
    }

    if (agentId !== undefined) {
      result = result.filter(skill => !skill.agentId || skill.agentId === agentId)
    }

    return enabledOnly ? result.filter(skill => skill.enabled) : result
  }
}

export function createOnethingSessionSkillsRuntime<TSkill extends OnethingSessionSkillLike>(
  adapters: OnethingSessionSkillsRuntimeAdapters<TSkill>,
): OnethingSessionSkillsRuntime<TSkill> {
  return new OnethingSessionSkillsRuntime(adapters)
}

export function mergeOnethingSkillsByPriority<TSkill extends Pick<OnethingSessionSkillLike, 'name'>>(
  ...skillGroups: TSkill[][]
): TSkill[] {
  const seenNames = new Set<string>()
  const merged: TSkill[] = []

  for (const group of skillGroups) {
    for (const skill of group) {
      if (seenNames.has(skill.name)) continue
      seenNames.add(skill.name)
      merged.push(skill)
    }
  }

  return merged
}
