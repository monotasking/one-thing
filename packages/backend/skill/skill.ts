/**
 * skill —— 技能:从内置、用户、项目、插件与笔记库这几处根目录读出 `SKILL.md`,按会话决定哪些技能开着,
 * 以及技能的增删改(给设置页与 `skill_manage` 工具用)。
 *
 * 对外交出三类东西:
 * - 装配:技能加载器与管理器的接线、宿主的环境注入口、内置资源目录、会话技能缓存的初始化、
 *   把笔记库挂成技能根;
 * - 运行期:取一个会话开着的技能、让会话技能缓存失效、插件登记自己的技能根;
 * - 调试日志口的形状 `OnethingSkillsIpcLogger`。
 * 依赖 note、settings、storage、agent、music、file、logging。
 */

// 装配。
export {
  configureAppSkillsLoader,
  configureSkillsEnvironmentHost,
  getAppBuiltinResourcePath,
  resetSkillsEnvironmentHost,
} from './skill-sources.js'
export type { SkillsEnvironmentHostPorts } from './skill-sources.js'
export { configureAppSkillManage } from './skill-manage-setup.js'
export { initializeSessionSkills } from './skill-session-cache.js'
export { bootstrapNoteVaultSkillRoots } from './skill-note-vault-roots.js'

// 运行期。
export { getSkillsForSession, invalidateSessionSkillsCache } from './skill-session-cache.js'
export { registerPluginSkillRootProvider } from './skill-plugin-roots.js'
export type { PluginSkillRootProvider } from './skill-plugin-roots.js'

// 调试日志口。
export type { OnethingSkillsIpcLogger } from './skill-ipc-operations.js'
