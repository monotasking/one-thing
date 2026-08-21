/**
 * Skills IPC Handlers
 *
 * Handles IPC communication for Hermes Agent SKILL.md operations
 */

import fs from 'fs'
import path from 'path'
import { openElectronPath } from '@onething/electron-host/shell/operations'
import {
  registerElectronSkillsIpcHandlers,
  type ElectronSkillAddDirectoryRequest,
  type ElectronSkillDeleteRequest,
  type ElectronSkillOpenDirectoryRequest,
  type ElectronSkillReadFileRequest,
  type ElectronSkillRemoveDirectoryRequest,
  type ElectronSkillSetAgentRequest,
  type ElectronSkillToggleEnabledRequest,
  type ElectronSkillUpdateDirectoryRequest,
  type ElectronSkillsGetAllRequest,
} from '@onething/electron-host/ipc/skills'
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
  type SkillSource,
  toggleOnethingSkillEnabledForIpc,
  updateOnethingSkillDirectoryForIpc,
} from '@onething/runtime/skills'
import { IPC_CHANNELS } from '@shared/ipc.js'
import type { SkillDefinition } from '@shared/ipc.js'
import {
  createSkill,
  deleteSkill,
  readSkillFile,
  getUserSkillsPath,
} from '@onething/backend/wiring/skills/index.js'
import { getSettings, saveSettings } from '@onething/backend/stores/settings.js'
import {
  getAllSkillsForDisplay,
  getSkillsForSession as getRuntimeSkillsForSession,
  initializeSessionSkills,
  invalidateSessionSkillsCache,
} from '@onething/backend/wiring/skills/session-skills.js'
import { getLogger } from '@onething/backend/wiring/logging/index.js'

const log = getLogger('ipc.skills')

let skillsIpcInitialized = false

/**
 * Initialize the skill system
 */
export async function initializeSkills(): Promise<void> {
  if (skillsIpcInitialized) return
  await initializeSessionSkills()
  skillsIpcInitialized = true
  log.info('session skills initialized')
}

/**
 * Register all skill-related IPC handlers
 */
export function registerSkillHandlers() {
  registerElectronSkillsIpcHandlers({
    channels: {
      getAll: IPC_CHANNELS.SKILLS_GET_ALL,
      refresh: IPC_CHANNELS.SKILLS_REFRESH,
      readFile: IPC_CHANNELS.SKILLS_READ_FILE,
      openDirectory: IPC_CHANNELS.SKILLS_OPEN_DIRECTORY,
      create: IPC_CHANNELS.SKILLS_CREATE,
      delete: IPC_CHANNELS.SKILLS_DELETE,
      toggleEnabled: IPC_CHANNELS.SKILLS_TOGGLE_ENABLED,
      listDirectories: IPC_CHANNELS.SKILLS_LIST_DIRECTORIES,
      addDirectory: IPC_CHANNELS.SKILLS_ADD_DIRECTORY,
      updateDirectory: IPC_CHANNELS.SKILLS_UPDATE_DIRECTORY,
      removeDirectory: IPC_CHANNELS.SKILLS_REMOVE_DIRECTORY,
      setAgent: IPC_CHANNELS.SKILLS_SET_AGENT,
    },
    getAll: async (request?: ElectronSkillsGetAllRequest) => {
      return listOnethingSkillsForIpc({
        workingDirectory: request?.workingDirectory,
        ensureInitialized: initializeSkills,
        listSkills: options => getAllSkillsForDisplay(options),
        logger: console,
      })
    },
    refresh: async () => {
      return refreshOnethingSkillsForIpc({
        invalidateSkillsCache,
        listSkills: options => getAllSkillsForDisplay(options),
        logger: console,
      })
    },
    readFile: async (request: ElectronSkillReadFileRequest) => {
      return readOnethingSkillFileForIpc({
        skillId: request.skillId,
        fileName: request.fileName,
        readSkillFile,
        logger: console,
      })
    },
    openDirectory: async (request?: ElectronSkillOpenDirectoryRequest) => {
      return openOnethingSkillDirectoryForIpc({
        skillId: request?.skillId,
        listSkills: options => getAllSkillsForDisplay(options),
        getUserSkillsPath,
        openPath: path => openElectronPath(path),
        logger: console,
      })
    },
    create: async (request: unknown) => {
      const typedRequest = request as {
        name: string
        description: string
        instructions: string
        source: SkillSource
      }
      return createOnethingSkillForIpc({
        name: typedRequest.name,
        description: typedRequest.description,
        instructions: typedRequest.instructions,
        source: typedRequest.source,
        createSkill,
        invalidateSkillsCache,
        logger: console,
      })
    },
    delete: async (request: ElectronSkillDeleteRequest) => {
      return deleteOnethingSkillForIpc({
        skillId: request.skillId,
        deleteSkill,
        invalidateSkillsCache,
        logger: console,
      })
    },
    toggleEnabled: async (request: ElectronSkillToggleEnabledRequest) => {
      return toggleOnethingSkillEnabledForIpc({
        skillId: request.skillId,
        enabled: request.enabled,
        getSettings,
        saveSettings,
        logger: console,
      })
    },
    listDirectories: async () => {
      return listOnethingSkillDirectoriesForIpc({
        getSettings,
        logger: console,
      })
    },
    addDirectory: async (request: ElectronSkillAddDirectoryRequest) => {
      return addOnethingSkillDirectoryForIpc({
        path: request.path,
        label: request.label,
        agentId: request.agentId,
        getSettings,
        saveSettings,
        validateDirectory: validateSkillDirectoryPath,
        resolvePath: value => path.resolve(value),
        invalidateSkillsCache: () => invalidateSkillsCache(),
        logger: console,
      })
    },
    updateDirectory: async (request: ElectronSkillUpdateDirectoryRequest) => {
      return updateOnethingSkillDirectoryForIpc({
        id: request.id,
        enabled: request.enabled,
        label: request.label,
        agentId: request.agentId,
        getSettings,
        saveSettings,
        invalidateSkillsCache: () => invalidateSkillsCache(),
        logger: console,
      })
    },
    removeDirectory: async (request: ElectronSkillRemoveDirectoryRequest) => {
      return removeOnethingSkillDirectoryForIpc({
        id: request.id,
        getSettings,
        saveSettings,
        invalidateSkillsCache: () => invalidateSkillsCache(),
        logger: console,
      })
    },
    setAgent: async (request: ElectronSkillSetAgentRequest) => {
      const current = getAllSkillsForDisplay().find(skill => skill.id === request.skillId)
      return setOnethingSkillAgentForIpc({
        skillId: request.skillId,
        agentId: request.agentId,
        currentEnabled: current?.enabled,
        getSettings,
        saveSettings,
        invalidateSkillsCache: () => invalidateSkillsCache(),
        logger: console,
      })
    },
  })

  log.info('handlers registered')
}

function validateSkillDirectoryPath(dirPath: string): string | null {
  if (!path.isAbsolute(dirPath)) {
    return 'Directory path must be absolute'
  }
  try {
    const stat = fs.statSync(dirPath)
    if (!stat.isDirectory()) {
      return 'Path is not a directory'
    }
  } catch {
    return 'Directory does not exist or is not readable'
  }
  return null
}

/**
 * Get all loaded skills (for use in chat context)
 * @deprecated Use getSkillsForSession for session-aware skill loading
 */
export function getLoadedSkills(): SkillDefinition[] {
  return getAllSkillsForDisplay({ enabledOnly: true })
}

/**
 * Invalidate skills cache for a specific workingDirectory or all caches
 */
export function invalidateSkillsCache(workingDirectory?: string): void {
  invalidateSessionSkillsCache(workingDirectory)
  log.debug('skills cache invalidated', { workingDirectory: workingDirectory ?? null })
}

/**
 * Get skills for a specific session, including project skills based on workingDirectory
 * Uses per-workingDirectory caching to avoid repeated filesystem traversal
 *
 * @param workingDirectory - Session's working directory for project skill discovery
 * @returns Array of enabled skills (user + project + plugin)
 */
export function getSkillsForSession(workingDirectory?: string): SkillDefinition[] {
  return getRuntimeSkillsForSession(workingDirectory)
}
