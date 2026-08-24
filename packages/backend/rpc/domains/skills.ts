/**
 * skills(技能管理)域 —— 结构债 P4c 第二批,整只从手写 IPC 通道搬到通用
 * `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/skills.ts` 的手写 IPC 工厂 + `apps/electron/src/main/ipc/skills.ts`
 *    那层壳适配(`IPC_CHANNELS` 上那十二条 skills 通道);
 *  - `preload/bridge.ts` 的十二条包装与 `platform/web.ts` 的十三条 REST 镜像
 *    (其中 `directories` 四条与 `agent` 一条在 server 侧**根本没有路由** ——
 *    打了就 404 的死镜像);
 *  - `server/http.ts` 的六条 REST 路由 + 一个 `/api/skills/<id>[/action]` 正则块、
 *    `server/runtime.ts` 的 `skills` facade adapter,以及只服务于它的那套 per-owner
 *    的**第二份技能实现**(`owners/<uid>/<wid>/skills` 目录扫描 / frontmatter 解析 /
 *    创建 / 删除,十三个 `*ServerSkill*` 助手)。
 *
 * 逻辑一行没搬:十二条方法**逐条**转调 `@onething/runtime/skills` 的投影
 * (`*OnethingSkill*ForIpc`),端口照旧从 `@onething/backend/wiring/skills` 与
 * 设置缓存取 —— 与迁移前 `@main` 那份适配逐字同义。
 *
 * **唯一需要宿主的那条是 `openDirectory`**:它要「在文件管理器里打开一个目录」,
 * 而这件事只有 Electron 桌面做得到。它现在走 `@onething/runtime/shell` 的
 * `configureShellHost` 端口(P4c 第二批新立):桌面注入 Electron 的打开原语,
 * server / CLI 不注入 —— 于是拿到一句结构化的「宿主没有外壳能力」。这正是从前
 * server adapter 里那句「web server runtime 不支持打开本地技能目录」的同义降级,
 * 区别是它不再需要第二份实现,也不再是一句写死的英文。
 */
import fs from 'fs'
import path from 'path'
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
  toggleOnethingSkillEnabledForIpc,
  updateOnethingSkillDirectoryForIpc,
} from '@onething/runtime/skills'
import { getShellHost } from '@onething/runtime/shell/host-ports'
import type { SkillsRoutes } from '@shared/ipc/skills.js'
import { getSettings, saveSettings } from '../../stores/settings.js'
import { consolePort, getLogger } from '../../wiring/logging/index.js'
import {
  createSkill,
  deleteSkill,
  getUserSkillsPath,
  readSkillFile,
} from '../../wiring/skills/index.js'
import {
  getAllSkillsForDisplay,
  initializeSkills,
  invalidateSkillsCache,
} from '../../wiring/skills/session-skills.js'
import type { RpcRouteHandlers } from '../registry.js'
import type { DeleteOnethingSkillForIpcOptions, OnethingSkillsIpcLogger } from '@onething/runtime/skills/ipc-operations'
import type { ConsoleLikePort } from '@onething/runtime/logging'
import type { SkillDefinition, AppSettings } from '@shared/ipc.js'
import type { ListOnethingSkillsForIpcOptions, RefreshOnethingSkillsForIpcOptions, OpenOnethingSkillDirectoryForIpcOptions, CreateOnethingSkillForIpcOptions, ToggleOnethingSkillEnabledForIpcOptions, AddOnethingSkillDirectoryForIpcOptions, UpdateOnethingSkillDirectoryForIpcOptions, RemoveOnethingSkillDirectoryForIpcOptions, SetOnethingSkillAgentForIpcOptions } from '@onething/runtime/skills/ipc-operations'

const log = getLogger('rpc.skills')
/** 投影层收的是鸭子 logger;过渡替身与 `wiring/skills` 用的是同一个(area ① 统一后删)。 */
const consoleLog: ConsoleLikePort & OnethingSkillsIpcLogger = consolePort(log)

/**
 * 自定义技能根的路径判据。**只收绝对路径,且必须是当下可读的目录** ——
 * 与 `packages/shared/defaults/settings.ts` 里那段说明同源,搬家时逐字保留。
 */
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

export const skillsRpcHandlers: RpcRouteHandlers<SkillsRoutes> = {
  async getAll(request) {
    const listOnethingSkillsForIpcOptions: ListOnethingSkillsForIpcOptions<SkillDefinition> = {
      workingDirectory: request?.workingDirectory,
      ensureInitialized: initializeSkills,
      listSkills: options => getAllSkillsForDisplay(options),
      logger: consoleLog,
    };
    return listOnethingSkillsForIpc(listOnethingSkillsForIpcOptions)
  },
  async refresh() {
    const refreshOnethingSkillsForIpcOptions: RefreshOnethingSkillsForIpcOptions<SkillDefinition> = {
      invalidateSkillsCache: () => invalidateSkillsCache(),
      listSkills: options => getAllSkillsForDisplay(options),
      logger: consoleLog,
    };
    return refreshOnethingSkillsForIpc(refreshOnethingSkillsForIpcOptions)
  },
  async readFile(request) {
    return readOnethingSkillFileForIpc({
      skillId: request.skillId,
      fileName: request.fileName,
      readSkillFile,
      logger: consoleLog,
    })
  },
  async openDirectory(request) {
    const openOnethingSkillDirectoryForIpcOptions: OpenOnethingSkillDirectoryForIpcOptions<SkillDefinition> = {
      skillId: request?.skillId,
      listSkills: options => getAllSkillsForDisplay(options),
      getUserSkillsPath,
      // 未注入宿主 = 拿到一句非空的失败原因,投影据此把它折成失败结果
      // (Electron 打开原语的约定:空串才算成功)。
      openPath: targetPath => getShellHost().openPath(targetPath),
      logger: consoleLog,
    };
    return openOnethingSkillDirectoryForIpc(openOnethingSkillDirectoryForIpcOptions)
  },
  async create(request) {
    const createOnethingSkillForIpcOptions: CreateOnethingSkillForIpcOptions<SkillDefinition> = {
      name: request.name,
      description: request.description,
      instructions: request.instructions,
      source: request.source,
      createSkill,
      invalidateSkillsCache: () => invalidateSkillsCache(),
      logger: consoleLog,
    };
    return createOnethingSkillForIpc(createOnethingSkillForIpcOptions)
  },
  async delete(request) {
    const deleteOnethingSkillForIpcOptions: DeleteOnethingSkillForIpcOptions = {
      skillId: request.skillId,
      deleteSkill,
      invalidateSkillsCache: () => invalidateSkillsCache(),
      logger: consoleLog,
    };
    return deleteOnethingSkillForIpc(deleteOnethingSkillForIpcOptions)
  },
  async toggleEnabled(request) {
    const toggleOnethingSkillEnabledForIpcOptions: ToggleOnethingSkillEnabledForIpcOptions<AppSettings> = {
      skillId: request.skillId,
      enabled: request.enabled,
      getSettings,
      saveSettings,
      logger: consoleLog,
    };
    return toggleOnethingSkillEnabledForIpc(toggleOnethingSkillEnabledForIpcOptions)
  },
  async listDirectories() {
    return listOnethingSkillDirectoriesForIpc({
      getSettings,
      logger: consoleLog,
    })
  },
  async addDirectory(request) {
    const addOnethingSkillDirectoryForIpcOptions: AddOnethingSkillDirectoryForIpcOptions<AppSettings> = {
      path: request.path,
      label: request.label,
      agentId: request.agentId,
      getSettings,
      saveSettings,
      validateDirectory: validateSkillDirectoryPath,
      resolvePath: value => path.resolve(value),
      invalidateSkillsCache: () => invalidateSkillsCache(),
      logger: consoleLog,
    };
    return addOnethingSkillDirectoryForIpc(addOnethingSkillDirectoryForIpcOptions)
  },
  async updateDirectory(request) {
    const updateOnethingSkillDirectoryForIpcOptions: UpdateOnethingSkillDirectoryForIpcOptions<AppSettings> = {
      id: request.id,
      enabled: request.enabled,
      label: request.label,
      agentId: request.agentId,
      getSettings,
      saveSettings,
      invalidateSkillsCache: () => invalidateSkillsCache(),
      logger: consoleLog,
    };
    return updateOnethingSkillDirectoryForIpc(updateOnethingSkillDirectoryForIpcOptions)
  },
  async removeDirectory(request) {
    const removeOnethingSkillDirectoryForIpcOptions: RemoveOnethingSkillDirectoryForIpcOptions<AppSettings> = {
      id: request.id,
      getSettings,
      saveSettings,
      invalidateSkillsCache: () => invalidateSkillsCache(),
      logger: consoleLog,
    };
    return removeOnethingSkillDirectoryForIpc(removeOnethingSkillDirectoryForIpcOptions)
  },
  async setAgent(request) {
    // 这条技能今天到底开着没有:设置里没有条目时,新条目沿用它现在的可见状态,
    // 免得「绑定 agent」顺手把一条本来开着的技能关掉。
    const current = getAllSkillsForDisplay().find(skill => skill.id === request.skillId)
    const setOnethingSkillAgentForIpcOptions: SetOnethingSkillAgentForIpcOptions<AppSettings> = {
      skillId: request.skillId,
      agentId: request.agentId,
      currentEnabled: current?.enabled,
      getSettings,
      saveSettings,
      invalidateSkillsCache: () => invalidateSkillsCache(),
      logger: consoleLog,
    };
    return setOnethingSkillAgentForIpc(setOnethingSkillAgentForIpcOptions)
  },
}

