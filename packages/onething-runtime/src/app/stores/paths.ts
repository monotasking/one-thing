import {
  ensureOnethingStoreDirs,
  getOnethingAgentsDir,
  getOnethingAgentsPath,
  getOnethingAppStatePath,
  getOnethingDebugDir,
  getOnethingDocsDir,
  getOnethingFileMutationsDir,
  getOnethingLogDir,
  getOnethingMCPOAuthCredentialsPath,
  getOnethingMCPToolsCatalogPath,
  getOnethingMacOSAutomationDocsPath,
  getOnethingMediaDir,
  getOnethingMediaFilesDir,
  getOnethingMediaImagesDir,
  getOnethingMediaIndexPath,
  getOnethingPermissionsDir,
  getOnethingPluginDataDir,
  getOnethingPromptsPath,
  getOnethingSchedulerDir,
  getOnethingSchedulerRunsDir,
  getOnethingSchedulerTasksPath,
  getOnethingScreenshotsDir,
  getOnethingSessionDatabasePath,
  getOnethingSessionPath,
  getOnethingSessionsDir,
  getOnethingSettingsPath,
  getOnethingStoreDirs,
  getOnethingStorePath,
  getOnethingToolOutputPath,
  getOnethingToolOutputsDir,
  getOnethingToolUsageDocsPath,
  getOnethingUserProfileDir,
  getOnethingUserProfilePath,
  getOnethingVariablesPath,
  getOnethingWindowStatePath,
  getOnethingWorkspaceAvatarPath,
  getOnethingWorkspaceAvatarsDir,
  getOnethingWorkspacePath,
  getOnethingWorkspacesDir,
  type OnethingStorePathOptions,
} from '@onething/runtime/storage'

export {
  deleteJsonFile,
  ensureDir,
  generateToolOutputFilename,
  readJsonFile,
  writeJsonFile,
  writeJsonFileAsync,
} from '@onething/core/storage'

interface StorePathHost {
  isPackaged?: boolean
  resourcesPath?: string
}

let storePathHost: StorePathHost = {}

export function configureStorePathHost(host: StorePathHost): void {
  storePathHost = host
}

export function getStorePath(options?: OnethingStorePathOptions): string {
  return getOnethingStorePath(options)
}

export function getLogDir(options?: OnethingStorePathOptions): string {
  return getOnethingLogDir(options)
}

export function getDebugDir(options?: OnethingStorePathOptions): string {
  return getOnethingDebugDir(options)
}


export function getSettingsPath(options?: OnethingStorePathOptions): string {
  return getOnethingSettingsPath(options)
}

export function getAgentsDir(options?: OnethingStorePathOptions): string {
  return getOnethingAgentsDir(options)
}

export function getAgentsPath(options?: OnethingStorePathOptions): string {
  return getOnethingAgentsPath(options)
}

export function getVariablesPath(options?: OnethingStorePathOptions): string {
  return getOnethingVariablesPath(options)
}

export function getPromptsPath(options?: OnethingStorePathOptions): string {
  return getOnethingPromptsPath(options)
}

export function getAppStatePath(options?: OnethingStorePathOptions): string {
  return getOnethingAppStatePath(options)
}

export function getWindowStatePath(options?: OnethingStorePathOptions): string {
  return getOnethingWindowStatePath(options)
}

export function getSessionsDir(options?: OnethingStorePathOptions): string {
  return getOnethingSessionsDir(options)
}

export function getSessionPath(sessionId: string, options?: OnethingStorePathOptions): string {
  return getOnethingSessionPath(sessionId, options)
}

export function getSessionDatabasePath(options?: OnethingStorePathOptions): string {
  return getOnethingSessionDatabasePath(options)
}

export function getWorkspacesDir(options?: OnethingStorePathOptions): string {
  return getOnethingWorkspacesDir(options)
}

export function getWorkspacePath(workspaceId: string, options?: OnethingStorePathOptions): string {
  return getOnethingWorkspacePath(workspaceId, options)
}

export function getWorkspaceAvatarsDir(options?: OnethingStorePathOptions): string {
  return getOnethingWorkspaceAvatarsDir(options)
}

export function getWorkspaceAvatarPath(
  workspaceId: string,
  extension: string,
  options?: OnethingStorePathOptions,
): string {
  return getOnethingWorkspaceAvatarPath(workspaceId, extension, options)
}

export function getUserProfileDir(options?: OnethingStorePathOptions): string {
  return getOnethingUserProfileDir(options)
}

export function getUserProfilePath(options?: OnethingStorePathOptions): string {
  return getOnethingUserProfilePath(options)
}

export function getScreenshotsDir(options?: OnethingStorePathOptions): string {
  return getOnethingScreenshotsDir(options)
}

export function getMediaDir(options?: OnethingStorePathOptions): string {
  return getOnethingMediaDir(options)
}

export function getMediaImagesDir(options?: OnethingStorePathOptions): string {
  return getOnethingMediaImagesDir(options)
}

export function getMediaFilesDir(options?: OnethingStorePathOptions): string {
  return getOnethingMediaFilesDir(options)
}

export function getMediaIndexPath(options?: OnethingStorePathOptions): string {
  return getOnethingMediaIndexPath(options)
}

export function getSchedulerDir(options?: OnethingStorePathOptions): string {
  return getOnethingSchedulerDir(options)
}

export function getSchedulerTasksPath(options?: OnethingStorePathOptions): string {
  return getOnethingSchedulerTasksPath(options)
}

export function getSchedulerRunsDir(options?: OnethingStorePathOptions): string {
  return getOnethingSchedulerRunsDir(options)
}

export function getToolOutputsDir(options?: OnethingStorePathOptions): string {
  return getOnethingToolOutputsDir(options)
}

export function getFileMutationsDir(options?: OnethingStorePathOptions): string {
  return getOnethingFileMutationsDir(options)
}

export function getToolOutputPath(filename: string, options?: OnethingStorePathOptions): string {
  return getOnethingToolOutputPath(filename, options)
}

export function getMCPToolsCatalogPath(options?: OnethingStorePathOptions): string {
  return getOnethingMCPToolsCatalogPath(options)
}

export function getMCPOAuthCredentialsPath(options?: OnethingStorePathOptions): string {
  return getOnethingMCPOAuthCredentialsPath(options)
}

export function getPluginDataDir(options?: OnethingStorePathOptions): string {
  return getOnethingPluginDataDir(options)
}

export function getPermissionsDir(options?: OnethingStorePathOptions): string {
  return getOnethingPermissionsDir(options)
}

export function getStoreDirs(options?: OnethingStorePathOptions): string[] {
  return getOnethingStoreDirs(options)
}

export function getDocsDir(): string {
  return getOnethingDocsDir({
    isPackaged: Boolean(storePathHost.isPackaged),
    resourcesPath: storePathHost.resourcesPath || process.resourcesPath,
    cwd: process.cwd(),
  })
}

export function getMacOSAutomationDocsPath(): string {
  return getOnethingMacOSAutomationDocsPath({
    isPackaged: Boolean(storePathHost.isPackaged),
    resourcesPath: storePathHost.resourcesPath || process.resourcesPath,
    cwd: process.cwd(),
  })
}

export function getToolUsageDocsPath(): string {
  return getOnethingToolUsageDocsPath({
    isPackaged: Boolean(storePathHost.isPackaged),
    resourcesPath: storePathHost.resourcesPath || process.resourcesPath,
    cwd: process.cwd(),
  })
}

export function ensureStoreDirs(): void {
  ensureOnethingStoreDirs()
}
