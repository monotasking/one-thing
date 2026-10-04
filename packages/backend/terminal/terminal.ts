/**
 * terminal —— 真终端:node-pty 起的伪终端会话、16ms 批量输出、序号与回放环、带代次的确认流控,
 * 以及把输出经全局事件推出去的那只广播器。
 *
 * 对外交出两类东西:
 * - 终端服务:服务类与进程级取用口、「这台宿主有没有终端」、装上输出广播器、
 *   关停时杀光 / 窗口重载时标记全部脱离,以及宿主端口与退出状态的形状;
 * - 认识事件总线的输出广播器(`createEventBusTerminalBroadcaster`,T0)。
 * 依赖 event、logging。
 */

// 终端服务。
export {
  configureTerminalBroadcaster,
  getTerminalService,
  hasTerminalHost,
  killAllTerminals,
  markAllTerminalsDetached,
  TerminalService,
} from './terminal-service.js'
export type { TerminalExitStatus, TerminalHostPorts } from './terminal-service.js'

// 经事件总线推输出的广播器。
export { createEventBusTerminalBroadcaster } from './terminal-bus-broadcaster.js'
