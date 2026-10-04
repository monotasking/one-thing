/**
 * 日志级别的词汇。
 *
 * 它是契约:`logs` RPC 域(`@shared/ipc/logs.ts`)的载荷里就有它。日志内核的其余形状
 * (记录、接收端、Logger)是后端的机制,留在 `packages/backend/logging/logging-types.ts`,
 * 那边从这里取这一格。
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
