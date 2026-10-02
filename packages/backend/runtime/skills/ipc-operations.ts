import type {
  SkillDefinition,
  SkillDirectoryConfig,
  SkillSettings,
  SkillSource,
} from './types.js'

type MaybePromise<T> = T | Promise<T>

export interface OnethingSkillsIpcLogger {
  error?: (...args: unknown[]) => void
}

export type OnethingSkillsIpcResult<TPayload extends object = {}> =
  | ({ success: true } & TPayload)
  | { success: false; error: string }

export interface OnethingSkillDirectoryOpener {
  (path: string): MaybePromise<string | void | null | undefined>
}

export interface OnethingSkillListOptions {
  workingDirectory?: string
  enabledOnly?: boolean
}

export interface ListOnethingSkillsForIpcOptions<TSkill extends SkillDefinition = SkillDefinition> {
  workingDirectory?: string
  ensureInitialized(): MaybePromise<void>
  listSkills(options: OnethingSkillListOptions): MaybePromise<TSkill[]>
  logger?: OnethingSkillsIpcLogger
}

export async function listOnethingSkillsForIpc<TSkill extends SkillDefinition>(
  options: ListOnethingSkillsForIpcOptions<TSkill>,
): Promise<OnethingSkillsIpcResult<{ skills: TSkill[] }>> {
  try {
    await options.ensureInitialized()
    return {
      success: true,
      skills: await options.listSkills({
        workingDirectory: options.workingDirectory,
        enabledOnly: false,
      }),
    }
  } catch (error) {
    return skillsIpcError(options.logger, 'getting skills', error, 'Failed to get skills')
  }
}

export interface RefreshOnethingSkillsForIpcOptions<TSkill extends SkillDefinition = SkillDefinition> {
  invalidateSkillsCache(): MaybePromise<void>
  listSkills(options: OnethingSkillListOptions): MaybePromise<TSkill[]>
  logger?: OnethingSkillsIpcLogger
}

export async function refreshOnethingSkillsForIpc<TSkill extends SkillDefinition>(
  options: RefreshOnethingSkillsForIpcOptions<TSkill>,
): Promise<OnethingSkillsIpcResult<{ skills: TSkill[] }>> {
  try {
    await options.invalidateSkillsCache()
    return {
      success: true,
      skills: await options.listSkills({ enabledOnly: false }),
    }
  } catch (error) {
    return skillsIpcError(options.logger, 'refreshing skills', error, 'Failed to refresh skills')
  }
}

export interface ReadOnethingSkillFileForIpcOptions {
  skillId: string
  fileName: string
  readSkillFile(skillId: string, fileName: string): MaybePromise<string | null>
  logger?: OnethingSkillsIpcLogger
}

export async function readOnethingSkillFileForIpc(
  options: ReadOnethingSkillFileForIpcOptions,
): Promise<OnethingSkillsIpcResult<{ content: string }>> {
  try {
    const content = await options.readSkillFile(options.skillId, options.fileName)
    if (content === null) {
      return { success: false, error: 'File not found or not readable' }
    }
    return { success: true, content }
  } catch (error) {
    return skillsIpcError(options.logger, 'reading skill file', error, 'Failed to read skill file')
  }
}

export interface OpenOnethingSkillDirectoryForIpcOptions<TSkill extends SkillDefinition = SkillDefinition> {
  skillId?: string
  listSkills(options: OnethingSkillListOptions): MaybePromise<TSkill[]>
  getUserSkillsPath(): string
  openPath: OnethingSkillDirectoryOpener
  logger?: OnethingSkillsIpcLogger
}

export async function openOnethingSkillDirectoryForIpc<TSkill extends SkillDefinition>(
  options: OpenOnethingSkillDirectoryForIpcOptions<TSkill>,
): Promise<OnethingSkillsIpcResult> {
  try {
    const skill = options.skillId
      ? (await options.listSkills({ enabledOnly: false })).find(item => item.id === options.skillId)
      : undefined
    const openResult = await options.openPath(skill?.directoryPath || options.getUserSkillsPath())
    if (typeof openResult === 'string' && openResult.trim().length > 0) {
      return { success: false, error: openResult }
    }
    return { success: true }
  } catch (error) {
    return skillsIpcError(options.logger, 'opening skill directory', error, 'Failed to open skill directory')
  }
}

export interface CreateOnethingSkillForIpcOptions<TSkill extends SkillDefinition = SkillDefinition> {
  name: string
  description: string
  instructions: string
  source: SkillSource
  createSkill(
    name: string,
    description: string,
    instructions: string,
    source: SkillSource,
  ): MaybePromise<TSkill>
  invalidateSkillsCache(): MaybePromise<void>
  logger?: OnethingSkillsIpcLogger
}

export async function createOnethingSkillForIpc<TSkill extends SkillDefinition>(
  options: CreateOnethingSkillForIpcOptions<TSkill>,
): Promise<OnethingSkillsIpcResult<{ skill: TSkill }>> {
  try {
    const skill = await options.createSkill(
      options.name,
      options.description,
      options.instructions,
      options.source,
    )
    await options.invalidateSkillsCache()
    return { success: true, skill }
  } catch (error) {
    return skillsIpcError(options.logger, 'creating skill', error, 'Failed to create skill')
  }
}

export interface DeleteOnethingSkillForIpcOptions {
  skillId: string
  deleteSkill(skillId: string): MaybePromise<boolean>
  invalidateSkillsCache(): MaybePromise<void>
  logger?: OnethingSkillsIpcLogger
}

export async function deleteOnethingSkillForIpc(
  options: DeleteOnethingSkillForIpcOptions,
): Promise<OnethingSkillsIpcResult> {
  try {
    const deleted = await options.deleteSkill(options.skillId)
    if (!deleted) return { success: false, error: 'Skill not found' }
    await options.invalidateSkillsCache()
    return { success: true }
  } catch (error) {
    return skillsIpcError(options.logger, 'deleting skill', error, 'Failed to delete skill')
  }
}

export interface ToggleOnethingSkillEnabledForIpcOptions<TSettings extends { skills?: SkillSettings } = { skills?: SkillSettings }> {
  skillId: string
  enabled: boolean
  getSettings(): MaybePromise<TSettings>
  saveSettings(settings: TSettings): MaybePromise<unknown>
  logger?: OnethingSkillsIpcLogger
}

export async function toggleOnethingSkillEnabledForIpc<TSettings extends { skills?: SkillSettings }>(
  options: ToggleOnethingSkillEnabledForIpcOptions<TSettings>,
): Promise<OnethingSkillsIpcResult> {
  try {
    const settings = await options.getSettings()
    const skillSettings = ensureSkillSettings(settings)
    skillSettings.skills[options.skillId] = {
      ...skillSettings.skills[options.skillId],
      enabled: options.enabled,
    }
    await options.saveSettings(settings)
    return { success: true }
  } catch (error) {
    return skillsIpcError(options.logger, 'toggling skill', error, 'Failed to toggle skill')
  }
}

export interface SetOnethingSkillAgentForIpcOptions<TSettings extends { skills?: SkillSettings } = { skills?: SkillSettings }> {
  skillId: string
  /** null clears the binding so the skill is available to all agents */
  agentId: string | null
  /** Current enabled state used when the skill has no settings entry yet */
  currentEnabled?: boolean
  getSettings(): MaybePromise<TSettings>
  saveSettings(settings: TSettings): MaybePromise<unknown>
  invalidateSkillsCache?(): MaybePromise<void>
  logger?: OnethingSkillsIpcLogger
}

export async function setOnethingSkillAgentForIpc<TSettings extends { skills?: SkillSettings }>(
  options: SetOnethingSkillAgentForIpcOptions<TSettings>,
): Promise<OnethingSkillsIpcResult> {
  try {
    const settings = await options.getSettings()
    const skillSettings = ensureSkillSettings(settings)
    const existing = skillSettings.skills[options.skillId]
    skillSettings.skills[options.skillId] = {
      enabled: existing?.enabled ?? options.currentEnabled ?? true,
      agentId: options.agentId,
    }
    await options.saveSettings(settings)
    await options.invalidateSkillsCache?.()
    return { success: true }
  } catch (error) {
    return skillsIpcError(options.logger, 'assigning skill agent', error, 'Failed to assign skill agent')
  }
}

export interface ListOnethingSkillDirectoriesForIpcOptions<TSettings extends { skills?: SkillSettings } = { skills?: SkillSettings }> {
  getSettings(): MaybePromise<TSettings>
  logger?: OnethingSkillsIpcLogger
}

export async function listOnethingSkillDirectoriesForIpc<TSettings extends { skills?: SkillSettings }>(
  options: ListOnethingSkillDirectoriesForIpcOptions<TSettings>,
): Promise<OnethingSkillsIpcResult<{ directories: SkillDirectoryConfig[] }>> {
  try {
    const settings = await options.getSettings()
    return { success: true, directories: settings.skills?.customDirectories ?? [] }
  } catch (error) {
    return skillsIpcError(options.logger, 'listing skill directories', error, 'Failed to list skill directories')
  }
}

export interface AddOnethingSkillDirectoryForIpcOptions<TSettings extends { skills?: SkillSettings } = { skills?: SkillSettings }> {
  path: string
  label?: string
  agentId?: string | null
  getSettings(): MaybePromise<TSettings>
  saveSettings(settings: TSettings): MaybePromise<unknown>
  /** Return an error message when the path is not a readable directory */
  validateDirectory(path: string): MaybePromise<string | null | undefined>
  /** Resolve a path for duplicate detection (e.g. path.resolve) */
  resolvePath?(path: string): string
  invalidateSkillsCache(): MaybePromise<void>
  createId?(): string
  logger?: OnethingSkillsIpcLogger
}

export async function addOnethingSkillDirectoryForIpc<TSettings extends { skills?: SkillSettings }>(
  options: AddOnethingSkillDirectoryForIpcOptions<TSettings>,
): Promise<OnethingSkillsIpcResult<{ directory: SkillDirectoryConfig }>> {
  try {
    const trimmedPath = options.path?.trim()
    if (!trimmedPath) {
      return { success: false, error: 'Directory path is required' }
    }

    const validationError = await options.validateDirectory(trimmedPath)
    if (validationError) {
      return { success: false, error: validationError }
    }

    const settings = await options.getSettings()
    const skillSettings = ensureSkillSettings(settings)
    const directories = skillSettings.customDirectories ?? []
    const resolve = options.resolvePath ?? ((value: string) => value)
    if (directories.some(dir => resolve(dir.path) === resolve(trimmedPath))) {
      return { success: false, error: 'Directory is already registered' }
    }

    const directory: SkillDirectoryConfig = {
      id: options.createId?.() ?? `dir-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      path: trimmedPath,
      label: options.label?.trim() || undefined,
      agentId: options.agentId ?? undefined,
      enabled: true,
    }
    skillSettings.customDirectories = [...directories, directory]
    await options.saveSettings(settings)
    await options.invalidateSkillsCache()
    return { success: true, directory }
  } catch (error) {
    return skillsIpcError(options.logger, 'adding skill directory', error, 'Failed to add skill directory')
  }
}

export interface UpdateOnethingSkillDirectoryForIpcOptions<TSettings extends { skills?: SkillSettings } = { skills?: SkillSettings }> {
  id: string
  enabled?: boolean
  label?: string
  /** Pass null to clear the binding; omit to leave unchanged */
  agentId?: string | null
  getSettings(): MaybePromise<TSettings>
  saveSettings(settings: TSettings): MaybePromise<unknown>
  invalidateSkillsCache(): MaybePromise<void>
  logger?: OnethingSkillsIpcLogger
}

export async function updateOnethingSkillDirectoryForIpc<TSettings extends { skills?: SkillSettings }>(
  options: UpdateOnethingSkillDirectoryForIpcOptions<TSettings>,
): Promise<OnethingSkillsIpcResult<{ directory: SkillDirectoryConfig }>> {
  try {
    const settings = await options.getSettings()
    const skillSettings = ensureSkillSettings(settings)
    const directories = skillSettings.customDirectories ?? []
    const index = directories.findIndex(dir => dir.id === options.id)
    if (index === -1) {
      return { success: false, error: 'Skill directory not found' }
    }

    const updated: SkillDirectoryConfig = {
      ...directories[index],
      ...(options.enabled !== undefined ? { enabled: options.enabled } : {}),
      ...(options.label !== undefined ? { label: options.label.trim() || undefined } : {}),
      ...(options.agentId !== undefined ? { agentId: options.agentId ?? undefined } : {}),
    }
    skillSettings.customDirectories = [
      ...directories.slice(0, index),
      updated,
      ...directories.slice(index + 1),
    ]
    await options.saveSettings(settings)
    await options.invalidateSkillsCache()
    return { success: true, directory: updated }
  } catch (error) {
    return skillsIpcError(options.logger, 'updating skill directory', error, 'Failed to update skill directory')
  }
}

export interface RemoveOnethingSkillDirectoryForIpcOptions<TSettings extends { skills?: SkillSettings } = { skills?: SkillSettings }> {
  id: string
  getSettings(): MaybePromise<TSettings>
  saveSettings(settings: TSettings): MaybePromise<unknown>
  invalidateSkillsCache(): MaybePromise<void>
  logger?: OnethingSkillsIpcLogger
}

export async function removeOnethingSkillDirectoryForIpc<TSettings extends { skills?: SkillSettings }>(
  options: RemoveOnethingSkillDirectoryForIpcOptions<TSettings>,
): Promise<OnethingSkillsIpcResult> {
  try {
    const settings = await options.getSettings()
    const skillSettings = ensureSkillSettings(settings)
    const directories = skillSettings.customDirectories ?? []
    if (!directories.some(dir => dir.id === options.id)) {
      return { success: false, error: 'Skill directory not found' }
    }

    skillSettings.customDirectories = directories.filter(dir => dir.id !== options.id)
    // Per-skill overrides for skills from this root are keyed by `custom:<dirId>:...`
    // and would otherwise linger forever in settings.
    for (const skillId of Object.keys(skillSettings.skills)) {
      if (skillId.startsWith(`custom:${options.id}:`)) {
        delete skillSettings.skills[skillId]
      }
    }
    await options.saveSettings(settings)
    await options.invalidateSkillsCache()
    return { success: true }
  } catch (error) {
    return skillsIpcError(options.logger, 'removing skill directory', error, 'Failed to remove skill directory')
  }
}

function ensureSkillSettings(settings: { skills?: SkillSettings }): SkillSettings {
  if (!settings.skills) {
    settings.skills = { enableSkills: true, skills: {} }
  }
  if (!settings.skills.skills) {
    settings.skills.skills = {}
  }
  return settings.skills
}

function skillsIpcError(
  logger: OnethingSkillsIpcLogger | undefined,
  label: string,
  error: unknown,
  fallback: string,
): { success: false; error: string } {
  logger?.error?.(`[Skills IPC] Error ${label}:`, error)
  return {
    success: false,
    error: error instanceof Error && error.message ? error.message : fallback,
  }
}
