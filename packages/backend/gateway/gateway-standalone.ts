/**
 * 独立网关的**启动面**(D184 / D202):从环境变量读渠道与运行时、起一台网关、停它。
 *
 * 从前这些函数与「被当成主模块执行就起网关」的守卫一起住在网关入口 `gateway.ts` 里;
 * 打进单文件包以后每个模块的 `import.meta.url` 都等于包本身,装配一引入口就会起一台网关。
 * 现在拆成两只:本文件只放可以被 import 的函数,没有主模块判断;进程入口是兄弟
 * `gateway-standalone-main.ts`(只有 `main()` 与守卫,谁都不许 import 它)。
 * 网关入口从这里转交 `startGateway` / `startGatewayFromEnv`,给将来的进程壳用。
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  isCoreConversationRuntime,
  type CoreConversationRuntime,
} from './gateway-conversation-runtime.js'
import { TelegramChannel } from './channels/telegram/telegram.js'
import { WechatChannel } from './channels/wechat/wechat.js'
import {
  readAllowlistConfigFromEnv,
  readGatewayChannelIdsFromEnv,
  readGatewayPermissionConfigFromEnv,
  readPositiveInteger,
  readTelegramBotToken,
} from './gateway-config.js'
import {
  Allowlist,
  type Channel,
  configureGatewayLogging,
  Gateway,
  GatewayBridge,
  type GatewayCommandProvider,
  type GatewayLoggerFactory,
  gatewayLogger,
  GatewaySessionRegistry,
  RateLimiter,
} from './hub/gateway-hub.js'

export interface GatewayRuntime {
  gateway: Gateway
  startPromise?: Promise<void>
}

export interface StartGatewayOptions {
  runtime: CoreConversationRuntime
  env?: NodeJS.ProcessEnv
  channels?: Channel[]
  background?: boolean
  commandProvider?: GatewayCommandProvider
  /**
   * 宿主的日志工厂(logging L2)。签名与 `@onething/backend/logging` 的
   * `getLogger(ns)` 一致 —— Electron 宿主直接把它传进来,网关的记录就落进
   * 宿主的 `app.jsonl`,命名空间是 `gateway.*`。
   * 不给 = 自带的终端 pretty 实现(独立进程跑网关时的形态)。
   */
  getLogger?: GatewayLoggerFactory
}

export interface StartGatewayFromEnvOptions {
  env?: NodeJS.ProcessEnv
  importRuntimeModule?: (specifier: string) => Promise<unknown>
  startGatewayImpl?: (options: StartGatewayOptions) => Promise<GatewayRuntime>
}

export async function startGateway(options: StartGatewayOptions): Promise<GatewayRuntime> {
  const env = options.env ?? process.env
  // 先装日志:下面每一个构造函数(以及 storage / iLink 里的自由函数)都从这里取。
  configureGatewayLogging(options.getLogger)
  const allowlist = new Allowlist(readAllowlistConfigFromEnv(env))
  const rateLimiter = new RateLimiter({
    maxPerMinute: readPositiveInteger(env.GATEWAY_RATE_LIMIT, 10),
  })
  const registry = new GatewaySessionRegistry(options.runtime)
  const bridge = new GatewayBridge({
    allowlist,
    rateLimiter,
    registry,
    runtime: options.runtime,
    commandProvider: options.commandProvider,
    permissionConfig: readGatewayPermissionConfigFromEnv(env),
  })
  const gateway = new Gateway(bridge)
  const channels = options.channels ?? createGatewayChannelsFromEnv(env)

  if (!channels.length) {
    throw new Error('No gateway channels configured. Set GATEWAY_CHANNELS=wechat,telegram or enable at least one supported channel.')
  }

  for (const channel of channels) {
    gateway.register(channel)
  }
  gatewayLogger().info('gateway starting', { channels: channels.map(channel => channel.id) })

  const startPromise = gateway.start()
  if (options.background) {
    return { gateway, startPromise }
  }

  await startPromise
  return { gateway, startPromise }
}

export function createGatewayChannelsFromEnv(env: NodeJS.ProcessEnv): Channel[] {
  return readGatewayChannelIdsFromEnv(env).map(channel => {
    if (channel === 'telegram') {
      return new TelegramChannel({
        botToken: readTelegramBotToken(env),
        apiBaseUrl: env.GATEWAY_TELEGRAM_API_BASE_URL ?? env.TELEGRAM_API_BASE_URL,
      })
    }

    return new WechatChannel()
  })
}

export async function startGatewayFromEnv(options: StartGatewayFromEnvOptions = {}): Promise<GatewayRuntime> {
  const env = options.env ?? process.env
  const runtime = await loadGatewayConversationRuntimeFromEnv(
    env,
    options.importRuntimeModule ?? importGatewayRuntimeModule,
  )
  return (options.startGatewayImpl ?? startGateway)({
    runtime,
    env,
  })
}

async function loadGatewayConversationRuntimeFromEnv(
  env: NodeJS.ProcessEnv,
  importRuntimeModule: (specifier: string) => Promise<unknown>,
): Promise<CoreConversationRuntime> {
  const moduleSpecifier = env.ONETHING_GATEWAY_RUNTIME_MODULE ?? env.GATEWAY_RUNTIME_MODULE
  if (!moduleSpecifier?.trim()) {
    throw new Error(
      'Standalone Gateway needs a real onething runtime. Set ONETHING_GATEWAY_RUNTIME_MODULE to a module that exports default/runtime/createGatewayRuntime returning an OnethingConversationRuntime (CoreConversationRuntime from @onething/backend/gateway).',
    )
  }

  const moduleExports = await importRuntimeModule(resolveRuntimeModuleSpecifier(moduleSpecifier))
  const runtime = await resolveRuntimeExport(moduleExports)
  if (!isCoreConversationRuntime(runtime)) {
    throw new Error(
      'Gateway runtime module must export default, runtime, conversationRuntime, createGatewayRuntime, createOnethingGatewayRuntime, or getConversationRuntime as an OnethingConversationRuntime.',
    )
  }
  return runtime
}

async function importGatewayRuntimeModule(specifier: string): Promise<unknown> {
  return import(specifier)
}

function resolveRuntimeModuleSpecifier(specifier: string): string {
  const trimmed = specifier.trim()
  if (trimmed.startsWith('.') || trimmed.startsWith('/')) {
    return pathToFileURL(resolve(trimmed)).href
  }
  return trimmed
}

async function resolveRuntimeExport(moduleExports: unknown): Promise<unknown> {
  const runtimeExport = selectRuntimeExport(moduleExports)
  return typeof runtimeExport === 'function'
    ? runtimeExport()
    : runtimeExport
}

function selectRuntimeExport(moduleExports: unknown): unknown {
  if (!moduleExports || typeof moduleExports !== 'object') return moduleExports
  const exports = moduleExports as Record<string, unknown>
  return exports.default
    ?? exports.runtime
    ?? exports.conversationRuntime
    ?? exports.createGatewayRuntime
    ?? exports.createOnethingGatewayRuntime
    ?? exports.getConversationRuntime
    ?? moduleExports
}

export async function stopGateway(runtime: GatewayRuntime): Promise<void> {
  await runtime.gateway.stop()
}
