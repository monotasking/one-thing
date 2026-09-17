/**
 * Global Event Types
 *
 * Events not scoped to any session.
 */

import type { PluginNotifySound } from '@onething/core/plugins/notify-sound'
import type { TerminalDataEvent, TerminalExitEvent } from '../ipc/terminal.js'

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

/**
 * 一条**壳命令**出了 core(原子 K2b-2,`docs/design/atom-2026-09.md` §5「资源的家在
 * 哪就去哪跑」/ §10.2「home 在 shell 的寿命 = 那扇壳的连接」)。
 *
 * ## 它为什么不塞进 `resource:event`
 *
 * 那一条的语义是**事实**(「这件事发生了」)。这一条是**命令**(「请你做这件事」)。
 * 把命令混进事实里,任何一个订阅事实的旁观者都会开始执行它 —— 而事件的既有纪律
 * 恰恰是「一个坏掉的观察者不该把事实撤销掉」,那条纪律只对旁观者成立。
 *
 * ## 它为什么带 `shellId`
 *
 * **SSE 是广播。** `/api/events` 上的每一帧发给每一个连着的客户端,而这条命令只该
 * 由一扇壳执行 —— 两扇壳同时跑一次「把面板挪到右边」就是挪了两次。所以坐标写在
 * 载荷里,收到的一方自己对 `shellId`,不匹配就当没看见。这是 K2a' 留账的第一个坑:
 * HTTP 侧今天不填 `RpcDispatchContext.callerId`,所以定向投递这条路走不了。
 *
 * ## 断线窗口里的命令就是丢了
 *
 * 全局事件不进任何一条会话的环形缓冲,`?after=` 不回放它们(`global-event-delivery.ts`
 * 纪律 2)。所以一条在壳断线的瞬间发出的命令没有人会执行 —— 它由 core 这一侧的
 * 超时兜住,落成 `ResourceHomeUnavailableError`(不是超时,§10.2 明说),而不是
 * 让内核为每一种事件都存一本回放账。
 */
export interface ResourceShellCommandEvent {
  type: 'resource:shell-command'
  /** 哪扇壳该执行。别的壳读到这条要当没看见。 */
  shellId: string
  /** 对账坐标。壳跑完拿它调 `resources.shellResult`。 */
  callId: string
  /**
   * 做一件事,还是读一件事。
   *
   * 读也走这条通道,因为一个 `home: 'shell'` 的命名空间**整个**住在壳里 ——
   * 它的读法同样只有那扇壳答得出来。给读另开一种事件等于为同一条往返造第二条路。
   */
  kind: 'op' | 'read'
  /** `<scheme>:<path>`,整个命名空间时为 `null`。 */
  ref: string | null
  /** `kind: 'op'` 时是做法名,`kind: 'read'` 时是读法名。 */
  op: string
  params: Record<string, unknown>
  /** epoch ms,装配层盖(同 `resource:event`)。 */
  at: number
}

// ── Terminal (真 PTY 输出,T0) ───────────────────

/**
 * 一格 PTY 的一批输出(`docs/design/terminal-browser-2026-09.md` §2.1-1)。
 *
 * ## 为什么是全局事件,不是第三条手写通道
 *
 * `TerminalService` 早就有输出流水线(16ms 合批 → seq → 环形缓冲 → 广播器端口),
 * 缺的只是**一条到得了壳的路**。而今天的 React 壳只有一条 IPC(`host:connection`,
 * `transport:gate` 的 `ipcMain` 钉数就是它),渲染层与 core 之间只有 HTTP/SSE ——
 * 于是「再开一条通道」这条路在结构上已经关死了。全局事件本来就走
 * `GET /api/events`(`backend/server/global-event-delivery.ts`),转发那一侧不认识
 * 任何一种事件的名字,所以接上它 = 加一支联合 + 出网名单加一行,零传输面改动。
 *
 * ## 「SSE 不回放全局事件」在这里正好是对的
 *
 * 全局事件不进任何一条会话的环形缓冲,`?after=` 不回放它们。终端不需要那个:
 * 回放是终端服务自己的事 —— 每次 `attach` 交出 ring + seq + 一个新代次,断线
 * 期间错过的输出由那一次 attach 补齐,而不是由传输面替它存第二本账。
 *
 * ## 不出网名单里为什么是 `true`
 *
 * 判据是「载荷会不会把本机路径 / 命令行 / 凭证带出进程」。这两条的载荷是
 * `{terminalId, seq, data}` 与 `{terminalId, exitCode}` —— `data` 里当然会有本机
 * 路径(那是终端的屏幕),但**它本来就是调用方自己刚敲出来的那扇终端的回显**:
 * 拿得到这条 SSE 的人已经过了 Bearer 那道门,而同一道门后面 `terminal.attach`
 * 会把同样的字节整段交出去。压着它不出网只会让终端在壳里永远是个假面板。
 */
export interface TerminalDataGlobalEvent extends TerminalDataEvent {
  type: 'terminal:data'
}

/** 一格 PTY 死了。服务侧保证它排在那一格最后一批 `terminal:data` 之后。 */
export interface TerminalExitGlobalEvent extends TerminalExitEvent {
  type: 'terminal:exit'
}

// ── 出声(宠物 P4)───────────────────────────────

/**
 * **这台机器上有一段话正在出声 / 刚说完**(`docs/design/pet-system-2026-09.md` §11.3)。
 *
 * 发的一方是「把一段合成好的话放出来」的那一处(今天是宠物子系统的 `voiceUtterance`,
 * 与没有宠物时电台口播的缺省出声路);订的一方是正在出声的应用(音乐:播放器正在放时
 * 压到 35%,说完恢复)。两边互不认识 —— 名字与负载里没有「宠物」「电台」,谁说话、谁压
 * 音量都只是读这一条事实。
 *
 * `active: true` 与 `false` 成对发;同一段话一对。叠着说(两段交错)时订的一方自己数。
 */
export interface SpeechActivityEvent {
  type: 'speech:activity'
  active: boolean
  /** epoch ms,发的一方盖。 */
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
  | ResourceShellCommandEvent
  | TerminalDataGlobalEvent
  | TerminalExitGlobalEvent
  | SpeechActivityEvent

// ── 出网名单(原子 K2a')────────────────────────────

/**
 * **每一种全局事件自己说要不要出网。**
 *
 * K2a 留了一笔账:`/api/events` 上没有全局事件的出口,于是 `resource:event` 只到
 * 得了进程内的订阅者。K2a' 在那条既有 SSE 上开了一条**通用**出口 ——「通用」的意思
 * 是转发那一侧不认识任何一种事件的名字,它读这张表(`backend/server/
 * global-event-delivery.ts`)。加一种全局事件 = 在上面的联合里加一支、在这张表里
 * 加一行;`Record<GlobalEvent['type'], …>` 让 `tsc` 逼你做这个决定,而不是默认
 * 出网或默认不出网 —— 两个默认都会在某天悄悄错一次。
 *
 * `false` 的四行,理由各写在行上。判据只有一条:**这条事件的载荷会不会把本机的
 * 路径、命令行或凭证带出进程**,或者**它在这条 SSE 上已经有另一种载荷形状了**。
 * 与 `mcp` / `settings` 两域 `payloadLeavesProcess` 那两处脱敏是同一条判据。
 */
export const GLOBAL_EVENT_LEAVES_PROCESS: Readonly<Record<GlobalEvent['type'], boolean>> = Object.freeze({
  'app:initialized': true,
  'app:quitting': true,
  /**
   * **不出网 —— 它在这条 SSE 上已经有一条同名帧了**,而且那一条的载荷是脱敏过的
   * 整份设置(共享层读侧补齐 E 批)。总线上这一条只带 `changedKeys`。两种载荷形状
   * 挂在同一个事件名下,客户端就得先猜自己收到的是哪一种。
   */
  'settings:changed': false,
  'session:created': true,
  'session:switched': true,
  'session:deleted': true,
  'mcp:server-connected': true,
  'mcp:server-disconnected': true,
  /**
   * **不出网 —— `error` 是自由文本**,来自一台 MCP server 的连接/握手失败:stdio
   * 那一档里它带的是本机路径与命令行,而 MCP 配置的 `args` / `env` 里常常坐着
   * API key。`mcp` 域已经为同一个理由在出界时脱敏,这里不该开一条绕过它的路。
   */
  'mcp:server-error': false,
  'plugin:loaded': true,
  /** **不出网 —— 同上**:插件加载失败的自由文本带的是本机插件目录的绝对路径。 */
  'plugin:error': false,
  /**
   * **不出网 —— 它已经有自己的推送通道**(`PLUGINS_NOTIFICATION`),而插件宿主
   * 今天只在桌面上。让它同时走两条路是「一件事两条路」;真要让浏览器收到插件
   * 通知,该做的是把那条手写通道退成这里的一行,不是两条并存。
   */
  'plugin:notification': false,
  'resource:event': true,
  /**
   * **出网 —— 它整条命就是为了出网。** 一条 `home: 'shell'` 的做法在 core 里走完
   * 校验与授权之后,`apply` 那一步要经这条 SSE 到得了壳(§5)。载荷里没有本机
   * 路径也没有凭证:`ref` 是一个资源地址,`params` 是调用方(壳自己 / 模型)刚
   * 递进来的那一坨,原路返回。
   */
  'resource:shell-command': true,
  /**
   * **出网 —— 它整条命就是为了出网**(T0)。终端的输出流水线在 core 里,而唯一
   * 的消费者住在壳的渲染层;`GET /api/events` 是这两者之间今天唯一的路(React
   * 壳只有一条 `host:connection` IPC)。载荷是 `{terminalId, seq, data}`,`data`
   * 就是那扇终端的屏幕字节 —— 同一道 Bearer 门后面 `terminal.attach` 交出去的是
   * 同一批字节,这里不新增一类暴露。
   */
  'terminal:data': true,
  /** **出网 —— 同上**。载荷只有 `{terminalId, exitCode}`。 */
  'terminal:exit': true,
  /**
   * **不出网 —— 它是进程内的协调信号**(宠物 P4,§11.3「仅进程内,不出 SSE」)。壳要知道
   * 「在说话」读的是 `pet:` 的 `utterance` / `hushed`;这一条只给同进程里正在出声的应用
   * 让路用,送出去只会让客户端多一种要忽略的帧。
   */
  'speech:activity': false,
})
