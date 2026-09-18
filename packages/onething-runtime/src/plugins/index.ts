export {
  ONETHING_LOG_MONITOR_DEFAULT_CONFIG,
  ONETHING_LOG_MONITOR_MANIFEST,
  createOnethingLogMonitorSearchToolParameters,
  registerOnethingLogMonitorPanel,
  registerOnethingLogMonitorPlugin,
  registerOnethingLogMonitorStatusDemo,
  resolveOnethingLogMonitorConfig,
} from './log-monitor.js'
/*
 * memory-wiki 曾经在这里导出一整屏。2026-08-12 它退出内置搬进市场仓
 * (`monotasking/plugin` 的 `packages/memory-wiki`,包名
 * `@onething-plugins/memory-wiki`)—— 判据是"离了宿主活不了"才留在内置,而它
 * 只用注入 api 上的四样东西。同 id、同家目录,用户数据零迁移。
 *
 * 这里不留转发桩:一个没有实现的导出面只会让下一个人以为宿主还认识它。
 *
 * `note-skills` 于 2026-09-18 走了同一条路的另一头 —— 它不是搬去市场,是**退役**:
 * 「笔记库里的技能」今天由技能加载器直接吃(`listCustomSkillRoots` 那条 `custom:`
 * 链路),不再需要一个插件来当中间人(正本 `docs/design/notes-obsidian-cli-2026-09.md`
 * §4.4)。同样不留转发桩。
 */
export * from './plugin-command-execution.js'
export * from './ipc-operations.js'
export * from './plugin-list.js'
export * from './theme-overrides.js'
export * from './config-schema.js'
export type {
  OnethingLogMonitorConfig,
  OnethingLogMonitorPanelApi,
  OnethingLogMonitorPluginApi,
  OnethingLogMonitorStatusApi,
  OnethingLogMonitorSearchToolParameters,
  RegisterOnethingLogMonitorPluginOptions,
} from './log-monitor.js'
