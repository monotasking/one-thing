export type CoreOSType = 'macos' | 'windows' | 'linux'

export type CorePromptProviderConfigValue = string | number | boolean | null | undefined | object
export type CorePromptProviderConfig = Record<string, CorePromptProviderConfigValue>

export interface CoreTemplateSkill {
  name: string
  description: string
  source: string
  category?: string
  enabled?: boolean
  disableModelInvocation?: boolean
  directoryPath?: string
  path?: string
  files?: Array<{ name: string }>
  instructions?: string
}

export interface CorePromptActiveProject {
  hasActive: boolean
  /** Primary root (the session cwd anchor). */
  path?: string
  displayPath?: string
  /** All roots when the project has more than one directory. */
  displayPaths?: string[]
  description?: string
}

export interface CorePromptKnownProjects {
  hasAny: boolean
  entries: Array<{ path: string; displayPath: string; displayPaths?: string[]; description: string }>
}
