/**
 * 网关的日志注入口(logging L2,docs/design/logging-system-2026-08.md §2)。
 *
 * 网关是**独立可执行**的:它既能被 Electron 宿主抱在怀里跑(那时该把宿主的
 * `getLogger` 传进来,记录直接落 `app.jsonl`),也能自己 `node gateway.js` 跑
 * (那时谁也没传,得自带一个能打到终端的默认实现)。
 *
 * 注入的是**工厂**(`(ns) => Logger`)而不是单个 `Logger`:`Logger.child()` 按
 * 契约只绑字段、不换命名空间,而 §2.2 要的是 `gateway.wechat` / `gateway.telegram`
 * 这样的**前缀**(它是等级过滤的单位:`ONETHING_LOG=gateway.wechat=debug`)。
 * 宿主侧的 `getLogger(ns)` 恰好就是这个签名,一个字不用适配。
 *
 * 两种取法,同一个工厂:
 *  - **类**(Gateway / GatewayBridge / 各 Channel)在构造时接 `logger?`,
 *    显式给的赢 —— 这是"构造时注入"那句话的字面落地;
 *  - **自由函数**(storage 的读写助手、iLink 的 HTTP 包装)没有构造函数,
 *    读进程级的 `gatewayLogger(ns)`,由 `startGateway` 一次装好。
 *
 * 默认实现**不是 console 包装**,而是内核那套 `LoggerRoot + ConsoleSink` ——
 * 这样"没人注入"和"有人注入"两条路产出的记录形状逐字相同,只是 sink 不同。
 * 网关目录因此可以做到 `console.*` = 0。
 *
 * 边界:`packages/gateway` 只依赖 `packages/core`,而 `core/logging` 是零依赖、
 * 零 node import 的 —— 这条 import 不动任何红线。
 */
import { ConsoleSink, LoggerRoot, type Logger } from '@onething/core/gateway-runtime'

export type { Logger } from '@onething/core/gateway-runtime'

/** 宿主注入的形状 —— 与 `@onething/backend/logging` 的 `getLogger` 同签名。 */
export type GatewayLoggerFactory = (ns: string) => Logger

/** 网关命名空间的根:`gateway`、`gateway.wechat`、`gateway.bridge`… */
export const GATEWAY_LOG_NS = 'gateway'

let fallbackRoot: LoggerRoot | null = null
let activeFactory: GatewayLoggerFactory | null = null

function fallbackFactory(ns: string): Logger {
  fallbackRoot ??= new LoggerRoot({
    level: process.env.ONETHING_LOG ?? 'info',
    sinks: [new ConsoleSink({ format: 'pretty' })],
    src: 'gateway',
  })
  return fallbackRoot.logger(ns)
}

/**
 * 装上宿主的工厂。`startGateway({ getLogger })` 调一次;不调 = 用默认那只。
 * 返回卸载函数,测试与"宿主关掉网关再开"都靠它复位。
 */
export function configureGatewayLogging(factory: GatewayLoggerFactory | undefined): () => void {
  const previous = activeFactory
  activeFactory = factory ?? null
  return () => {
    activeFactory = previous
  }
}

/** 取一个网关命名空间下的 logger:`gatewayLogger('wechat')` → `gateway.wechat`。 */
export function gatewayLogger(suffix?: string): Logger {
  const ns = suffix ? `${GATEWAY_LOG_NS}.${suffix}` : GATEWAY_LOG_NS
  return (activeFactory ?? fallbackFactory)(ns)
}

/** 构造时注入的解析:显式给的 logger 赢,没给就走进程级工厂。 */
export function resolveGatewayLogger(logger: Logger | undefined, suffix?: string): Logger {
  return logger ?? gatewayLogger(suffix)
}

/** 测试用:把模块级单例复位。 */
export function resetGatewayLoggingForTests(): void {
  fallbackRoot = null
  activeFactory = null
}
