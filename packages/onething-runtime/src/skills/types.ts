export type SkillSource = 'user' | 'project' | 'plugin' | 'builtin' | 'custom'

export interface SkillConditions {
  fallbackForToolsets?: string[]
  requiresToolsets?: string[]
  fallbackForTools?: string[]
  requiresTools?: string[]
}

export interface SkillFile {
  name: string
  path: string
  type: 'markdown' | 'script' | 'template' | 'other'
}

export interface SkillDefinition {
  name: string
  description: string
  allowedTools?: string[]
  category?: string
  tags?: string[]
  relatedSkills?: string[]
  platforms?: string[]
  conditions?: SkillConditions
  disableModelInvocation?: boolean
  id: string
  source: SkillSource
  path: string
  directoryPath: string
  rootPath?: string
  relativePath?: string
  enabled: boolean
  /** Agent this skill is scoped to; null/undefined means available to all agents */
  agentId?: string | null
  instructions: string
  runtimeContext?: string
  files?: SkillFile[]
}

/** A user-managed skills root scanned in addition to the app-owned roots */
export interface SkillDirectoryConfig {
  id: string
  path: string
  label?: string
  /** Bind every skill loaded from this root to one agent; null/undefined = all agents */
  agentId?: string | null
  enabled: boolean
}

/**
 * 加载器眼里的一个自定义根 = 契约上的那份配置,**加**一格运行期语境。
 *
 * 那一格不在契约层的 `SkillDirectoryConfig` 上,因为它是一个**函数**:
 * 它落不进 `settings.json`,只在这台进程里由宿主现造(今天的唯一造者是笔记域 ——
 * 一个笔记库里的技能要知道它的附件该往哪放)。
 */
export interface CustomSkillRoot extends SkillDirectoryConfig {
  instructionContext?: PluginSkillInstructionContextProvider
}

export interface SkillSettings {
  enableSkills: boolean
  creationNudgeInterval?: number
  skills: Record<string, { enabled: boolean; agentId?: string | null }>
  customDirectories?: SkillDirectoryConfig[]
}

export interface PluginSkillInstructionContextInput {
  skillDir: string
  skillPath: string
  rootDir: string
}

export type PluginSkillInstructionContextProvider = (
  input: PluginSkillInstructionContextInput,
) => string | undefined

export interface PluginSkillRoot {
  pluginId: string
  path: string
  source?: SkillSource
  recursive?: boolean
  instructionContext?: PluginSkillInstructionContextProvider
}
