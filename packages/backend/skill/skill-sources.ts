import {
  configureOnethingSkillsLoaderRuntime,
} from '@onething/backend/skill'
import {
  builtinMusicProviders,
  getMusicProvider,
} from '@onething/backend/music'
import {
  listPluginSkillRoots,
} from '@onething/backend/skill/plugin-roots'
import {
  findBuiltinResourcePath,
  getOnethingStorePath,
} from '@onething/backend/storage'
import {
  getSettings,
} from '@onething/backend/settings'
import {
  listConnectedSkillRoots,
} from '@onething/backend/file'
import { skillVaultRootsNow } from '../note/note-subsystem.js'

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

/**
 * 还原到**未注入**态(C0 R6)。`applyHostPorts` 的还原函数逆序调它,于是
 * `backend.dispose()` 之后这个进程回到"没有宿主声明过这件能力"。
 */
export function resetSkillsEnvironmentHost(): void {
  envPorts = {}
}

/**
 * 应用自带资源目录 `resources/<name>` 在本宿主上的位置(开发 = 仓根,打包 = resourcesPath)。
 * 「打没打包 / resources 在哪」这件宿主事实今天只从 `skillsEnvironment` 这一个端口进来(名字是
 * 历史原因),所以 ACP 种子目录(`acp-agents`)也从这里取,与技能同一条规则。
 */
export function getAppBuiltinResourcePath(name: string): string {
  // 找不到时多看一眼 Electron 的 resources 目录(打包壳没接这个端口的兜底,见 `findBuiltinResourcePath`)。
  return findBuiltinResourcePath(name, {
    isPackaged: () => envPorts.isPackaged?.() ?? false,
    getResourcesPath: () => envPorts.getResourcesPath?.(),
    getCwd: () => process.cwd(),
  })
}

let skillsLoaderConfigured = false

/** Explicit assembly step: wire the skills loader to app settings/paths. */
export function configureAppSkillsLoader(): void {
  if (skillsLoaderConfigured) return
  skillsLoaderConfigured = true
  configureOnethingSkillsLoaderRuntime({
    getStorePath: getOnethingStorePath,
    listPluginSkillRoots,
    // 技能页手工加的自定义目录 + 接入目录 + 勾了「技能来源」的笔记库
    // (后两者投影成同款根,复用同一条扫描/去重/id 链路,不另起一套)。
    // 技能设置页读的是 settings 原始值,不经过这个适配器,所以这两类合成根
    // 不会漏进那个可编辑列表里。
    //
    // 笔记库这一条顶掉了 note-skills 内置插件(P3 退役):那条插件链路的技能 id
    // 里嵌的是**绝对路径的 sha1**,用户挪一次库,settings 里所有针对这些技能的
    // 启用/绑定覆盖就全成孤儿(判词逐字见 `file/connected-directories.ts`)。
    listCustomSkillRoots: () => [
      ...(getSettings().skills?.customDirectories ?? []),
      ...listConnectedSkillRoots(),
      ...skillVaultRootsNow(),
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
} from '@onething/backend/skill'
export type {
  OnethingSkillsLoaderAdapters,
} from '@onething/backend/skill'
