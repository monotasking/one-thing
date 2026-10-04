/**
 * 日志设施的宿主注入口(D191 从 `logging-configure.ts` 搬来,经入口交出)。
 *
 * 一个纯槽:Electron 把 log 目录镜像进自己的崩溃工具、并接管 renderer 的 console 兜底;headless 宿主两个都不给,
 * 只落主进程自己的输出。宿主端口表(`backend-host-ports.ts` 的 `logging` 那一格)写它,`configureLogging()` 读它。
 * 搬出来是因为它没有副作用,而 configure 那半有(文件 sink、管家、崩溃钩子都在模块求值时就进了打包闭包):
 * 宿主端口表从入口拿这个槽,就不必为了一个槽去引装配入口。
 */
import type { LogLevel } from '@shared/logging/types'

/**
 * 宿主注入口。Electron 把 log 目录镜像进自己的崩溃工具、并接管 renderer 的
 * console 兜底;headless 宿主两个都不给,只落主进程自己的输出。
 */
export interface AppLoggingHostPorts {
  setAppLogsPath?: (logDir: string) => void
  createRendererConsoleCapture?: (options: {
    log: (entry: RendererCaptureLogEntry) => void
  }) => { attach(): void; detach(): void }
}

/** 宿主兜底采集(Electron `console-message`)投递的形状。 */
export interface RendererCaptureLogEntry {
  level: LogLevel
  /** 不给则记 `renderer`。 */
  ns?: string
  msg: string
  fields?: Record<string, unknown>
  /** 旧口径的标签(`renderer:<wcId>`),落进 `fields.source`。 */
  source?: string
}

let hostPorts: AppLoggingHostPorts = {}

export function configureAppLoggingHost(ports: AppLoggingHostPorts): void {
  hostPorts = ports
}

/**
 * 还原到**未注入**态(C0 R6)。`applyHostPorts` 的还原函数逆序调它,于是
 * `backend.dispose()` 之后这个进程回到"没有宿主声明过这件能力"。
 *
 * 注意与 `resetLoggingForTests()` 的区别:那一个拆的是 `configureLogging()` 起的
 * 文件 sink / janitor / crash hooks(宿主在装配**之前**调、寿命比 backend 长);
 * 这一个只清宿主表 `logging` 那一格递进来的两件采集能力。
 */
export function resetAppLoggingHost(): void {
  hostPorts = {}
}

/** 读槽(给 `configureLogging()` 用)。 */
export function appLoggingHostPorts(): AppLoggingHostPorts {
  return hostPorts
}
