import {
  checkOnethingFileAccess,
  configureOnethingToolSandboxRuntime,
  expandOnethingToolSandboxPath,
  findOnethingReadSandboxRootForPath,
  findOnethingSandboxRootForPath,
  getOnethingDefaultReadRoots,
  getOnethingDownloadsDirectory,
  getOnethingReadSandboxRoots,
  getOnethingToolSandboxBoundary,
  getOnethingToolSandboxRoots,
  isOnethingToolPathContained,
  resolveOnethingToolPath,
  type CoreFileAccessTargetType,
} from '@onething/runtime/tools/sandbox-runtime'
import { getSettings } from '../../../stores/settings.js'
import { getConnectedDirectories } from '../../../stores/connected-directories.js'
import {
  getOnethingToolOutputsDir,
} from '@onething/runtime/storage'
import { getVariablesStore } from '@onething/runtime/variables/store-bound'

export interface SandboxHost {
  getPath?: (name: string) => string
}

let sandboxHost: SandboxHost = {}

let sandboxRuntimeConfigured = false

/** Explicit assembly step (no import-time side effects): wire the tool
 * sandbox runtime to app settings/paths. Called by createOnethingBackend. */
export function configureAppToolSandbox(): void {
  if (sandboxRuntimeConfigured) return
  sandboxRuntimeConfigured = true
  configureOnethingToolSandboxRuntime({
  getDefaultWorkingDirectory: () => getSettings().tools?.bash?.defaultWorkingDirectory,
  getHostPath: name => sandboxHost.getPath?.(name),
  getNoteDirectories: () => {
    const store = getVariablesStore()
    return [store.getUserNoteDir(), store.getWorkNoteDir()]
  },
  /**
   * **全局层**接入目录。这份适配器服务的是拿不到会话的调用面(`checkFileAccess`、
   * `findReadSandboxRootForPath` 等 —— 它们的签名里没有 sessionId,也没有一条
   * 诚实的路能补出来),所以退回全局层是这里的正确答案,不是遗漏。
   * 带会话的读根走 `app/tools/builtin/read.ts` 的 adaptersOverride(批 B2)。
   */
  getConnectedDirectories,
  // The bash tool's overflow logs ("full output saved to …"): re-reading a
  // tool result already adjudicated by the permission system — never prompt.
  getAppArtifactDirectories: () => [getOnethingToolOutputsDir()],
  })
}

export function configureSandboxHost(host: SandboxHost): void {
  sandboxHost = host
}

export const expandPath = expandOnethingToolSandboxPath
export const resolveToolPath = resolveOnethingToolPath
export const isPathContained = isOnethingToolPathContained
export const getSandboxBoundary = getOnethingToolSandboxBoundary
export const getSandboxRoots = getOnethingToolSandboxRoots
export const getDownloadsDirectory = getOnethingDownloadsDirectory
export const getDefaultReadRoots = getOnethingDefaultReadRoots
export const getReadSandboxRoots = getOnethingReadSandboxRoots
export const findSandboxRootForPath = findOnethingSandboxRootForPath
export const findReadSandboxRootForPath = findOnethingReadSandboxRootForPath
export const checkFileAccess = checkOnethingFileAccess

export type { CoreFileAccessTargetType }
