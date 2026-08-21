import {
  configureOnethingSkillsLoaderRuntime,
} from '@onething/runtime/skills'
import {
  builtinMusicProviders,
  getMusicProvider,
} from '@onething/runtime/music'
import {
  listPluginSkillRoots,
} from '@onething/runtime/skills/plugin-roots.wiring'
import {
  getOnethingStorePath,
} from '@onething/runtime/storage'
import {
  getSettings,
} from '../../stores/settings.js'
import {
  listConnectedSkillRoots,
} from '../../stores/connected-directories.js'

/** Every provider's CLI skill dir; only the active provider's is exposed. */
const musicSkillDirs = new Set(
  builtinMusicProviders.map(provider => provider.prose.skillDirName),
)

/**
 * Host injection points for packaged-app resource resolution. Defaults are
 * correct for dev and headless runs (not packaged, no resources dir); the
 * Electron host wires the real getters at startup. Late-bound thunks, so
 * wiring after this module's import-time configure call still takes effect.
 */
export interface SkillsEnvironmentHostPorts {
  isPackaged?: () => boolean
  getResourcesPath?: () => string | undefined
}

let envPorts: SkillsEnvironmentHostPorts = {}

export function configureSkillsEnvironmentHost(ports: SkillsEnvironmentHostPorts): void {
  envPorts = ports
}

let skillsLoaderConfigured = false

/** Explicit assembly step: wire the skills loader to app settings/paths. */
export function configureAppSkillsLoader(): void {
  if (skillsLoaderConfigured) return
  skillsLoaderConfigured = true
  configureOnethingSkillsLoaderRuntime({
    getStorePath: getOnethingStorePath,
    listPluginSkillRoots,
    // 技能页手工加的自定义目录 + 接入目录(后者投影成同款根,复用同一条
    // 扫描/去重/id 链路,不另起一套)。技能设置页读的是 settings 原始值,
    // 不经过这个适配器,所以接入目录不会漏进那个可编辑列表里。
    listCustomSkillRoots: () => [
      ...(getSettings().skills?.customDirectories ?? []),
      ...listConnectedSkillRoots(),
    ],
    isPackaged: () => envPorts.isPackaged?.() ?? false,
    getResourcesPath: () => envPorts.getResourcesPath?.(),
    getCwd: () => process.cwd(),
    isBuiltinSkillDirEnabled: dirName => {
      if (!musicSkillDirs.has(dirName)) return true
      return getMusicProvider(getSettings().music?.provider).prose.skillDirName === dirName
    },
  })
}

export {
  configureOnethingSkillsLoaderRuntime,
  createSkill,
  deleteSkill,
  ensureSkillsDirectories,
  findProjectSkillPaths,
  getBuiltinSkillsPath,
  getEnvSkillsPath,
  getExternalSkillsPaths,
  getHermesConfigPath,
  getHermesHome,
  getProjectSkillsPath,
  getUserSkillsPath,
  loadAllSkills,
  loadProjectSkillsForDirectory,
  readSkillFile,
} from '@onething/runtime/skills'
export type {
  OnethingSkillsLoaderAdapters,
} from '@onething/runtime/skills'
