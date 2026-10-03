import os from 'os'
import path from 'path'
import { ensureDir } from './json-file.js'

export interface CoreStorePathOptions {
  storePath?: string
  envStorePath?: string
  defaultStoreDirName?: string
  sessionDatabaseFilename?: string
  cwd?: string
  resourcesPath?: string
  isPackaged?: boolean
}

const DEFAULT_CORE_STORE_DIR_NAME = '.headless-core'
const DEFAULT_CORE_SESSION_DATABASE_FILENAME = 'sessions.sqlite'

export function getStorePath(options: CoreStorePathOptions = {}): string {
  return options.storePath
    || options.envStorePath
    || path.join(os.homedir(), options.defaultStoreDirName ?? DEFAULT_CORE_STORE_DIR_NAME)
}

export function getLogDir(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'log')
}

export function getDebugDir(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'debug')
}


export function getSettingsPath(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'settings.json')
}

export function getAgentsDir(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'agents')
}

export function getAgentsPath(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'agents.json')
}

export function getVariablesPath(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'variables.json')
}

export function getPromptsPath(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'prompts.json')
}

export function getAppStatePath(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'app-state.json')
}

export function getWindowStatePath(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'window-state.json')
}

export function getSessionsDir(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'sessions')
}

export function getSessionPath(sessionId: string, options: CoreStorePathOptions = {}): string {
  return path.join(getSessionsDir(options), `${sessionId}.json`)
}

export function getSessionDatabasePath(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), options.sessionDatabaseFilename ?? DEFAULT_CORE_SESSION_DATABASE_FILENAME)
}

export function getWorkspacesDir(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'workspaces')
}

export function getWorkspacePath(workspaceId: string, options: CoreStorePathOptions = {}): string {
  return path.join(getWorkspacesDir(options), `${workspaceId}.json`)
}

export function getWorkspaceAvatarsDir(options: CoreStorePathOptions = {}): string {
  return path.join(getWorkspacesDir(options), 'avatars')
}

export function getWorkspaceAvatarPath(
  workspaceId: string,
  extension: string,
  options: CoreStorePathOptions = {},
): string {
  return path.join(getWorkspaceAvatarsDir(options), `${workspaceId}.${extension}`)
}

export function getUserProfileDir(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'user-profile')
}

export function getUserProfilePath(options: CoreStorePathOptions = {}): string {
  return path.join(getUserProfileDir(options), 'profile.json')
}

export function getScreenshotsDir(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'screenshots')
}

export function getMediaDir(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'media')
}

export function getMediaImagesDir(options: CoreStorePathOptions = {}): string {
  return path.join(getMediaDir(options), 'images')
}

export function getMediaFilesDir(options: CoreStorePathOptions = {}): string {
  return path.join(getMediaDir(options), 'files')
}

export function getMediaIndexPath(options: CoreStorePathOptions = {}): string {
  return path.join(getMediaDir(options), 'index.json')
}

export function getSchedulerDir(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'scheduler')
}

export function getSchedulerTasksPath(options: CoreStorePathOptions = {}): string {
  return path.join(getSchedulerDir(options), 'tasks.json')
}

export function getSchedulerRunsDir(options: CoreStorePathOptions = {}): string {
  return path.join(getSchedulerDir(options), 'runs')
}

export function getToolOutputsDir(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'tool-outputs')
}

export function getFileMutationsDir(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'file-mutations')
}

export function getToolOutputPath(filename: string, options: CoreStorePathOptions = {}): string {
  return path.join(getToolOutputsDir(options), filename)
}

export function generateToolOutputFilename(toolName: string, sessionId?: string): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).substring(2, 8)
  const prefix = sessionId ? `${sessionId.slice(0, 8)}_` : ''
  return `${prefix}${toolName}_${timestamp}_${random}.txt`
}

export function getMCPToolsCatalogPath(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'mcp-tools-catalog.md')
}

export function getPluginDataDir(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'plugin-data')
}

export function getDocsDir(options: CoreStorePathOptions = {}): string {
  if (options.isPackaged && options.resourcesPath) {
    return path.join(options.resourcesPath, 'docs')
  }
  return path.join(options.cwd || process.cwd(), 'resources', 'docs')
}

export function getMacOSAutomationDocsPath(options: CoreStorePathOptions = {}): string {
  return path.join(getDocsDir(options), 'macos-automation.md')
}

export function getToolUsageDocsPath(options: CoreStorePathOptions = {}): string {
  return path.join(getDocsDir(options), 'tool-usage-guide.md')
}

export function getPermissionsDir(options: CoreStorePathOptions = {}): string {
  return path.join(getStorePath(options), 'permissions')
}

export function getStoreDirs(options: CoreStorePathOptions = {}): string[] {
  return [
    getStorePath(options),
    getLogDir(options),
    getAgentsDir(options),
    getSessionsDir(options),
    getWorkspacesDir(options),
    getWorkspaceAvatarsDir(options),
    getUserProfileDir(options),
    getScreenshotsDir(options),
    getMediaDir(options),
    getMediaImagesDir(options),
    getMediaFilesDir(options),
    getSchedulerDir(options),
    getSchedulerRunsDir(options),
    getToolOutputsDir(options),
    getFileMutationsDir(options),
    getPermissionsDir(options),
    getPluginDataDir(options),
  ]
}

export function ensureStoreDirs(options: CoreStorePathOptions = {}): void {
  for (const dir of getStoreDirs(options)) {
    ensureDir(dir)
  }
}
