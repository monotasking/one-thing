/**
 * 索引 Worker 的日志出口:**把记录交给宿主写**,而不是在 Worker 里自己找文件。
 *
 * 设计:docs/design/logging-system-2026-08.md §8.3 区 ①(产品层只有一个 `getLogger`
 * 门面,root 由装配层替换)+ docs/design/search-index-2026-09.md §15.3(2026-09-17 补)。
 *
 * ## 病:Worker 里的日志从来没有落过地
 *
 * `setRuntimeLoggerRoot()` 是**主线程**上 `configureLogging()` 调的那一句;Worker 是
 * 另一条线程、另一份模块实例,那一句从来没有在它里面跑过。于是 `logging/index.ts` 的
 * 兜底 root 生效 —— 它只挂一只 `MemoryRingSink`(200 条),线程一死就没了。
 * 09-17 用户真机事故里 `VectorWriter.markOff` 那句 `semantic recall turned itself off`
 * 就死在这里:设置页写着「原因在日志里」,而日志里一行都没有 —— 那句话是假的。
 *
 * ## 治:一只 postMessage sink + 宿主那一侧原样重发
 *
 * Worker 侧把 `LogRecord` 整条 `postMessage({ type: 'log', record })` 出去;
 * 主线程侧的 `IndexWorkerHost` 收到就用**宿主自己的** `getLogger(record.ns)` 按原级别
 * 重发一次(`worker-host.ts` 的 `spawn()`)。于是 Worker 的记录与主线程的记录进同一个
 * `app.jsonl`、同一份等级 spec、同一只看门人,`ns` 还是 `search.index.worker` /
 * `search.embedding`,只多一格 `fields.thread`。
 *
 * ## 两条交代
 *
 *  - **Worker 侧不过滤**(root 的 level 写死 `'trace'`):等级由宿主那一份 spec 说了算。
 *    理由是**诊断模式**:它在运行期 `setLogLevelSpec()` 改宿主的等级,而 Worker 的
 *    `workerData` 在 `new Worker(...)` 那一刻就定死了 —— 在 Worker 里再判一次等级,
 *    只会让「打开诊断模式却看不见 Worker 的 debug」。代价可忽略:Worker 这一侧全仓
 *    **零** `trace` / `debug` 调用点(全是 info / warn / error,且都是罕发)。
 *  - **`record.time` 会被宿主重新盖一次**。跨线程的那一跳是微秒级,而让宿主的
 *    `LoggerRoot` 统一盖时间,比在协议里多一格「别盖这条的时间」便宜得多。
 */

import {
  LOG_LEVEL_VALUE,
  LoggerRoot,
  safeStringify,
  type LogLevel,
  type LogRecord,
  type LogSink,
} from '@onething/core/logging'

import { setRuntimeLoggerRoot } from '../../logging/index.js'

/** Worker → 宿主的日志帧类型标记。请求 / 应答帧都带 `id`,这一帧**不带** —— 它不是往返。 */
export const WORKER_LOG_MESSAGE_TYPE = 'log'

/** 宿主重发时补的那一格:一眼看出这条来自哪条线程。 */
export const WORKER_LOG_THREAD_FIELD = 'search-worker'

export interface WorkerLogMessage {
  type: typeof WORKER_LOG_MESSAGE_TYPE
  record: LogRecord
}

/**
 * 这一帧是不是日志。**逐格验**而不是只看 `type`:结构化克隆过来的东西在类型上是
 * `unknown`,而下一步就要拿 `level` 去点宿主 logger 上的方法。
 */
export function isWorkerLogMessage(value: unknown): value is WorkerLogMessage {
  if (typeof value !== 'object' || value === null) return false
  const frame = value as { type?: unknown; record?: unknown }
  if (frame.type !== WORKER_LOG_MESSAGE_TYPE) return false
  const record = frame.record as Partial<LogRecord> | undefined
  if (typeof record !== 'object' || record === null) return false
  return typeof record.ns === 'string'
    && typeof record.msg === 'string'
    && typeof record.level === 'string'
    && Object.prototype.hasOwnProperty.call(LOG_LEVEL_VALUE, record.level)
}

/** 一条记录该按哪个级别重发(不认识的级别当 `info`,不丢)。 */
export function workerLogLevelOf(record: LogRecord): LogLevel {
  return Object.prototype.hasOwnProperty.call(LOG_LEVEL_VALUE, record.level) ? record.level : 'info'
}

/**
 * 一只把记录 `postMessage` 出去的 sink。
 *
 * **结构化克隆过不去的 `fields` 不许把这条记录弄丢**:第二次尝试把 `fields` 压成一个
 * `serialized` 串再发(`safeStringify` 认得循环引用与函数)。两次都不行才算了 ——
 * sink 里抛出去会顺着 `LoggerRoot` 反过来炸调用方,而调用方多半正在报另一个错。
 */
export function createWorkerLogSink(post: (value: unknown) => void): LogSink {
  return {
    write(record: LogRecord): void {
      try {
        post({ type: WORKER_LOG_MESSAGE_TYPE, record } satisfies WorkerLogMessage)
      } catch {
        try {
          const flattened: LogRecord = {
            ...record,
            ...(record.fields !== undefined
              ? { fields: { serialized: safeStringify(record.fields) } }
              : {}),
          }
          post({ type: WORKER_LOG_MESSAGE_TYPE, record: flattened } satisfies WorkerLogMessage)
        } catch {
          // 两次都发不出去:这条记录就此丢掉。日志不许成为第二个故障源。
        }
      }
    },
  }
}

/**
 * 把这条 Worker 线程的日志 root 换成「发给宿主」。**返回还原函数**(单测用)。
 *
 * 由 `worker.ts` 在**任何别的装配之前**调一次 —— `new SqliteIndex(...)` 开库那一刻
 * 就可能 `warn`(sqlite-vec 装不上),那句话也该落地。
 */
export function installWorkerLogging(post: (value: unknown) => void): () => void {
  setRuntimeLoggerRoot(new LoggerRoot({ level: 'trace', sinks: [createWorkerLogSink(post)] }))
  return () => { setRuntimeLoggerRoot(null) }
}
