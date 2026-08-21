import type { Logger } from '@onething/core/logging'

/**
 * 进程级兜底(P7)。在它之前:全仓没有一处 `unhandledRejection` 监听,server
 * 连 `uncaughtExceptionMonitor` 都没有 —— 进程死了盘上什么都不剩。
 *
 * **未捕获异常默认走 `uncaughtExceptionMonitor`**:它照样能在进程死之前 fatal
 * 一条 + 同步刷盘,但**不改变 Node 的默认行为**(打栈 → 退出码 1)。装
 * `uncaughtException` 监听等于接管默认行为,那是用户可感知的变化,不该由日志
 * 改造顺手做掉 —— 需要接管的宿主显式传 `uncaughtException: 'handle'`。
 */
export type UncaughtExceptionMode = 'monitor' | 'handle'

export interface ProcessCrashHooksOptions {
  /** 退出前把缓冲落盘(JSONL sink 的 `flushSync`)。 */
  flushSync?: () => void
  /** 默认 `'monitor'`:只记录 + 刷盘,Node 照常打栈并退出。 */
  uncaughtException?: UncaughtExceptionMode
  /** 注入点,便于测试。 */
  processRef?: NodeJS.Process
  /** `'handle'` 模式下把栈原样打出来(console 已被劫持时仍要看得见)。 */
  printFatal?: (error: unknown) => void
}

export interface ProcessCrashHooks {
  dispose(): void
}

export function installProcessCrashHooks(
  logger: Logger,
  options: ProcessCrashHooksOptions = {},
): ProcessCrashHooks {
  const target = options.processRef ?? process
  const mode: UncaughtExceptionMode = options.uncaughtException ?? 'monitor'

  const onUnhandledRejection = (reason: unknown): void => {
    logger.fatal('unhandled promise rejection', undefined, reason)
    options.flushSync?.()
  }

  const onUncaught = (error: Error, origin?: string): void => {
    logger.fatal('uncaught exception', { origin: origin ?? 'uncaughtException' }, error)
    options.flushSync?.()
    if (mode !== 'handle') return
    options.printFatal?.(error)
    target.exit(1)
  }

  const onWarning = (warning: Error): void => {
    logger.warn('process warning', { name: warning.name, stack: warning.stack })
  }

  target.on('unhandledRejection', onUnhandledRejection)
  const uncaughtEvent = mode === 'handle' ? 'uncaughtException' : 'uncaughtExceptionMonitor'
  target.on(uncaughtEvent, onUncaught)
  target.on('warning', onWarning)

  return {
    dispose(): void {
      target.off('unhandledRejection', onUnhandledRejection)
      target.off(uncaughtEvent, onUncaught)
      target.off('warning', onWarning)
    },
  }
}
