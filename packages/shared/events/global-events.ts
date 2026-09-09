/**
 * Global Event Types
 *
 * Events not scoped to any session.
 */

import type { PluginNotifySound } from '@onething/core/plugins/notify-sound'

// ── App lifecycle ───────────────────────────────

export interface AppInitializedEvent {
  type: 'app:initialized'
  timestamp: number
}

export interface AppQuittingEvent {
  type: 'app:quitting'
  timestamp: number
}

// ── Settings ────────────────────────────────────

export interface SettingsChangedEvent {
  type: 'settings:changed'
  changedKeys: string[]
}

// ── Session lifecycle ───────────────────────────

export interface SessionCreatedEvent {
  type: 'session:created'
  sessionId: string
  name: string
}

export interface SessionSwitchedEvent {
  type: 'session:switched'
  fromSessionId?: string
  toSessionId: string
}

export interface SessionDeletedEvent {
  type: 'session:deleted'
  sessionId: string
}

// ── MCP server lifecycle ────────────────────────

export interface MCPServerConnectedEvent {
  type: 'mcp:server-connected'
  serverId: string
}

export interface MCPServerDisconnectedEvent {
  type: 'mcp:server-disconnected'
  serverId: string
}

export interface MCPServerErrorEvent {
  type: 'mcp:server-error'
  serverId: string
  error: string
}

// ── Plugin lifecycle ────────────────────────────

export interface PluginLoadedEvent {
  type: 'plugin:loaded'
  pluginId: string
}

export interface PluginErrorEvent {
  type: 'plugin:error'
  pluginId: string
  error: string
}

export interface PluginNotificationEvent {
  type: 'plugin:notification'
  pluginId: string
  message: string
  level: 'info' | 'warn' | 'error'
  /**
   * 机械同步信号 —— 有 kind 就**不给人看**,只驱动宿主刷新。
   *
   * 没有它的时候,插件每次 ctx.refresh() 用户都会收到一条
   * `plugin-panel-refresh:log-monitor:logs` 弹窗;message 里那串是给日志看的
   * 地址,不是给人读的句子。给人看的通知(api.ui.notify、熔断告警)不带 kind。
   */
  kind?: 'config-changed' | 'panel-refresh' | 'catalog-changed' | 'layout'
  /** kind = panel-refresh 时的面板 id。 */
  panelId?: string
  /**
   * kind = layout 时的布局动词(I 期,`api.ui.toggleSidebar` / `openWorkbench`)。
   *
   * 搭既有这班车而不是新开一条通道:带 kind 的通知本来就是"机械信号,不弹
   * toast",新增一个 kind 因此不动 toast 那一侧一行代码。**手势闸与
   * unsupported 都在主进程判完了**,过线的每一条都是已放行的命令。
   */
  layout?: {
    verb: 'toggle-sidebar' | 'open-workbench'
    /** open-workbench 才有:要聚焦的插件面板 id(缺省 = 只展开右栏)。 */
    panelId?: string
  }
  /**
   * 提示音(M1)——**宿主裁决后的结果**:枚举校验、静音、限频都已经在装配层
   * 算完。省略 = 不出声,与 M1 之前逐字节一致。机械信号(带 kind 的那些)永远
   * 不带它:那些不给人看,自然也不该给人听。
   */
  sound?: PluginNotifySound
}

// ── Resources (原子 K2a) ────────────────────────

/**
 * 一条资源事件出了内核(`docs/design/atom-2026-09.md` §2 的 `Watch`)。
 *
 * **它是转发,不是第二种事实。** 真身在 `ResourceEventHub`(纯内存、按前缀订阅);
 * 装配层单向订阅一次,把每条转成这一条全局事件放上总线 —— hub 不反向认识总线
 * (K1 留账写死的方向)。
 *
 * `ref` / `event` / `payload` 与 hub 那条逐字同名同义;`at` 是**装配层盖的**:
 * hub 有意不带时刻(`events.ts` 头注释:内核里的"现在几点"要么是一处不可测的隐式
 * 依赖,要么是一个为没人读的值加的构造参数),时刻由落账的那一层盖。
 *
 * `payload` 的形状由那种资源自己的 `ResourceSpec.events[name].payload` 说了算 ——
 * 总线不解释它,这里也不该给它一个假的类型。
 */
export interface ResourceEventOccurredEvent {
  type: 'resource:event'
  /** `<scheme>:<path>` —— 出事的那个资源。 */
  ref: string
  /** 自述 `events` 里的名字。 */
  event: string
  payload: unknown
  /** epoch ms,装配层盖。 */
  at: number
}

// ── Union ───────────────────────────────────────

export type GlobalEvent =
  | AppInitializedEvent
  | AppQuittingEvent
  | SettingsChangedEvent
  | SessionCreatedEvent
  | SessionSwitchedEvent
  | SessionDeletedEvent
  | MCPServerConnectedEvent
  | MCPServerDisconnectedEvent
  | MCPServerErrorEvent
  | PluginLoadedEvent
  | PluginErrorEvent
  | PluginNotificationEvent
  | ResourceEventOccurredEvent
