import { classifyCommand, createBashTool, parseCommand } from '@onething/runtime/tools'
import { getSettings } from '../../stores/settings.js'
import { getConnectedDirectoriesForSession } from '../../stores/connected-directories.js'
import { getToolOutputsDir } from '../../stores/paths.js'
import { createLocalBashOperations } from '../core/bash-executor.js'

function configuredShellPath(): string | undefined {
  const bashSettings = getSettings().tools?.bash
  return bashSettings && 'shellPath' in bashSettings && typeof bashSettings.shellPath === 'string'
    ? bashSettings.shellPath
    : undefined
}

/**
 * Read per call, not once at module load: the user can tighten this while the
 * app runs and the next command should honour it.
 */
function configuredEnvAllowlist(): string[] | null {
  const allowlist = getSettings().tools?.bash?.envAllowlist
  return Array.isArray(allowlist) ? allowlist : null
}

export const BashTool = createBashTool({
  getDefaultWorkingDirectory: () => getSettings().tools?.bash?.defaultWorkingDirectory,
  getToolOutputsDir,
  getShellPath: configuredShellPath,
  // per-space:按**会话归属**取,不是当前空间(批 B2 / 设计盲点 1)。
  getConnectedDirectories: sessionId => getConnectedDirectoriesForSession(sessionId),
  createOperations: options => createLocalBashOperations({
    ...options,
    envAllowlist: configuredEnvAllowlist(),
  }),
})

export { classifyCommand, parseCommand }
