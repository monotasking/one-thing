/**
 * project-dir —— 项目目录名册:用户登记过的项目根(按空间各一份),给提示词的「已知项目」、
 * 工作目录判据与设置页用。
 *
 * 对外交出三类东西:
 * - 名册与项目的形状、从路径算项目 id、项目根的规范化与「这条路径在不在这些根里」;
 * - 开给设置页的增 / 删 / 改 / 取 / 列(带各自的请求形状);
 * - 装配:起名册(`bootstrapProjectDirs`)与按空间取名册仓库。
 * 依赖 space、session、storage、logging。
 */

// 项目与项目根。
export { projectIdFromPath } from './project-dir-id.js'
export { canonicalizeProjectRoot, normalizeProjectRoots, projectRootsInclude } from './project-dir-types.js'
export type { Project, ProjectIndexEntry } from './project-dir-types.js'

// 开给设置页的操作。
export {
  addOnethingProjectDirForIpc,
  getOnethingProjectDirForIpc,
  listOnethingProjectDirsForIpc,
  removeOnethingProjectDirForIpc,
  updateOnethingProjectDirForIpc,
} from './project-dir-ipc-operations.js'
export type {
  ProjectDirsAddRequest,
  ProjectDirsGetRequest,
  ProjectDirsRemoveRequest,
  ProjectDirsUpdateRequest,
} from './project-dir-ipc-operations.js'

// 装配。`getProjectsStore` 经 `project-dir-bootstrap` 转交:测试在那只文件上打桩。
export { bootstrapProjectDirs, getProjectsStore } from './project-dir-bootstrap.js'

// 提示词里的名册变量(D202 改名说清差别):按空间算的那只是底,按会话算的先把会话解析成空间再调它。
// 引擎拿的是按会话那只;它经 `project-dir-bootstrap` 转交,测试在那只文件上打桩。
export { buildProjectDirsPromptVarsForSpace } from './project-dir-prompt.js'
export { buildProjectDirsPromptVarsForSession } from './project-dir-bootstrap.js'
