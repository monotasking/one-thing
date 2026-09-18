/**
 * Plugin System Types
 *
 * Plugins are directories under ~/.onething/plugins/.
 * Each plugin has a plugin-entry.ts (default export) and an optional plugin.json manifest.
 *
 * Inspired by pi-mono's extension system, adapted for onething's Electron architecture.
 */

import type { z } from 'zod'
import type { IMConnector } from '@shared/ipc.js'
import type {
  CorePluginPanelRegistration,
  CorePluginRequestHandler,
  CorePluginStatusAPI,
  CorePluginStorage,
  CorePluginStorageWithFiles,
  CorePluginAPI,
  CorePluginCommandContext,
  CorePluginCommandDefinition,
  CorePluginDefinition,
  CorePluginEntry,
  CorePluginEventHandler,
  CorePluginSchedulerAPI,
  CorePluginStoreShape,
  CorePluginStoreData,
  CorePluginToolContext,
  CorePluginToolDefinition,
  CorePluginToolExecutionMode,
  CorePluginToolResult,
  MinimalCorePluginUI,
  PluginManifest,
  PluginSettings,
  PluginSource,
} from '@onething/core/plugins'
/**
 * R4b:旧 `Tool.Metadata` 就是 `object`(旧 `tools/tool.ts` 的第 20 行)。旧树
 * 删掉之后这个别名原样留在这里 —— 它是插件对外契约的一部分(`registerTool` 的
 * 第二个类型参数),与工具系统内部机制无关。
 */
export type ToolMetadata = object
import type { PluginSkillRootProvider } from '@onething/runtime/skills/plugin-roots.wiring'
import type {
  PluginPromptContext,
  PluginPromptContextProvider,
} from '@onething/runtime/prompts/plugin-context.wiring'
import type {
  BeforeContextCompactContext,
  BeforeContextCompactHook,
  AfterAssistantResponseContext,
  AfterAssistantResponseHook,
} from '@onething/runtime/plugins/lifecycle.wiring'
import type {
  SchedulerRunOptions,
  SchedulerRunRecord,
  SchedulerTaskHandle,
  SchedulerTaskRegistration,
  SchedulerTaskSnapshot,
} from '@onething/runtime/scheduler'

export type {
  CorePluginDefinition,
  CorePluginAPI,
  CorePluginCommandContext,
  CorePluginCommandDefinition,
  CorePluginEntry,
  CorePluginEventHandler,
  CorePluginSchedulerAPI,
  CorePluginStoreShape,
  CorePluginStoreData,
  CorePluginToolContext,
  CorePluginToolDefinition,
  CorePluginToolExecutionMode,
  CorePluginToolResult,
  MinimalCorePluginUI,
  PluginManifest,
  PluginSettings,
  PluginSource,
}

// ── Plugin Definition (loaded plugin) ──────────

export interface PluginDefinition extends CorePluginDefinition<PluginEntry> {}

// ── Plugin Store (per-plugin persistent key-value) ──

export interface PluginStoreData extends CorePluginStoreData {}

// ── Tool Definition (simplified for plugins) ───

export interface PluginToolDefinition<
  P extends z.ZodType = z.ZodType,
  M extends ToolMetadata = ToolMetadata,
> extends CorePluginToolDefinition<P, z.infer<P>, PluginToolContext<M>, PluginToolResult<M>> {}

export interface PluginToolContext<M extends ToolMetadata = ToolMetadata> extends CorePluginToolContext<M> {}

export interface PluginToolResult<M extends ToolMetadata = ToolMetadata> extends CorePluginToolResult<M> {}

// ── Command Definition ─────────────────────────

export interface PluginCommandDefinition extends CorePluginCommandDefinition<PluginCommandContext> {}

export interface PluginCommandContext extends CorePluginCommandContext {}

export type PluginScheduledTaskRegistration = Omit<SchedulerTaskRegistration, 'pluginId'>

export interface PluginSchedulerAPI
  extends CorePluginSchedulerAPI<
    PluginScheduledTaskRegistration,
    SchedulerTaskHandle,
    SchedulerTaskSnapshot,
    SchedulerRunOptions,
    SchedulerRunRecord
  > {}

// ── Plugin API (the "pi" object passed to plugin entry) ──

export interface PluginAPI
  extends
    CorePluginAPI<
    PluginToolDefinition,
    PluginEventHandler,
    Omit<PluginCommandDefinition, 'name'>,
    PluginPromptContextProvider,
    BeforeContextCompactHook,
    AfterAssistantResponseHook,
    PluginSkillRootProvider,
    PluginStore,
    PluginSchedulerAPI,
    MinimalPluginUI,
    CorePluginRequestHandler,
    // KV + message-state + F1 受管文件树(`api.storage.files`)。
    CorePluginStorageWithFiles,
    CorePluginPanelRegistration,
    CorePluginStatusAPI,
    IMConnector
  > {
  registerTool<P extends z.ZodType, M extends ToolMetadata>(
    tool: PluginToolDefinition<P, M>,
  ): void
}

/**
 * 轻通道(本地单文件脚本)拿到的**窄化 API**。
 *
 * 姿态:没有 manifest = 没有 `contributes` 声明 = 没有需要声明的能力(宪法第 3 条)。
 * 于是本地脚本的 api 面**物理收窄**到"不需要声明就能用"的那些 —— 自己给自己加东西
 * 够用:注册工具 / 斜杠命令、订阅观察型事件、发横幅、读写自己的 KV、排定时任务。
 *
 * **不给**(因为它们靠 manifest 声明门,本地脚本没有清单去声明):
 * `sendMessage` / `sessions` / `isIdle` / `llm`(sessions:* / llm:complete)、
 * `interceptInput` / `interceptToolCall` / `interceptToolResult`(input/toolcall/toolresult:intercept)、
 * `registerWorkspacePanel` / `registerUiSlot` / `theme`(面板 / 锚点块 / 外观靠声明定位)、
 * `resources`(原子 K4-b 的读 / 做 / 看:三条 `resources:*` 声明门都在 manifest 里,
 * 本地脚本没有清单去声明,于是这一格连挂都不挂 —— 它是"靠声明门的能力物理不挂"
 * 这条规矩最新的一行,不是一次遗漏)、
 * `registerSearchProvider`(search:provide)、`registerIMConnector`(试点注册表)、
 * `registerRequestHandler` / `settings`(与 UI/清单面绑定)、`steer` / `followUp` /
 * 生命周期钩子 / prompt-context / skill root。
 *
 * 这些方法在本地脚本的 api 对象上**物理不挂**(调用即 `undefined is not a function`),
 * 而不是留一个会抛错的桩 —— 更干净,类型上也一眼看清能用什么。要用被收窄掉的能力,
 * 就把脚本打包成正式插件并在 `contributes.permissions` 里声明。
 */
export type LocalPluginAPI = Pick<
  PluginAPI,
  | 'id'
  | 'registerTool'
  | 'registerCommand'
  | 'on'
  | 'events'
  | 'ui'
  | 'storage'
  | 'store'
  | 'scheduler'
  | 'onDispose'
>

/** 本地脚本 api 上保留的键 —— 与 `LocalPluginAPI` 一一对应(运行期收窄据它裁剪)。 */
export const LOCAL_PLUGIN_API_KEYS = [
  'id',
  'registerTool',
  'registerCommand',
  'on',
  'events',
  'ui',
  'storage',
  'store',
  'scheduler',
  'onDispose',
] as const satisfies ReadonlyArray<keyof LocalPluginAPI>

/** Event handler receives the full SessionEventEnvelope */
export type PluginEventHandler = CorePluginEventHandler

export type {
  PluginPromptContext,
  PluginPromptContextProvider,
  BeforeContextCompactContext,
  BeforeContextCompactHook,
  AfterAssistantResponseContext,
  AfterAssistantResponseHook,
  SchedulerRunOptions,
  SchedulerRunRecord,
  SchedulerTaskHandle,
  SchedulerTaskRegistration,
  SchedulerTaskSnapshot,
}

// ── Plugin Store ───────────────────────────────

export interface PluginStore extends CorePluginStoreShape {}

// ── Minimal UI (v1) ────────────────────────────

export interface MinimalPluginUI extends MinimalCorePluginUI {}

// ── Plugin Entry ───────────────────────────────

/** Function exported by plugin-entry.ts */
export type PluginEntry = CorePluginEntry<PluginAPI>
