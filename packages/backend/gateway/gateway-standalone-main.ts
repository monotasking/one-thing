/**
 * 独立网关的**进程入口**(D184 / D202):`bun run gateway:start` 跑的就是这只文件。
 *
 * 规矩一条(「进程入口不经功能入口」,`docs/design/server-client-split-2026-10.md` §4):
 * **谁都不许 import 本文件**。它末尾的主模块判断在单文件包里对每个模块都成立,
 * 所以一旦被别的文件引进去,装配一加载就会起一台网关(D184 的那次回退)。
 * 可以被 import 的启动函数都在兄弟 `gateway-standalone.ts`;要单文件包就以本文件为入口,
 * 用 CLI 同款 esbuild 配方打。
 */
import { pathToFileURL } from 'node:url'
import { startGatewayFromEnv, stopGateway } from './gateway-standalone.js'
import { gatewayLogger } from './hub/gateway-hub.js'

async function main(): Promise<void> {
  const runtime = await startGatewayFromEnv()
  const stop = async (): Promise<void> => {
    await stopGateway(runtime)
    process.exit(0)
  }

  process.once('SIGINT', () => {
    void stop()
  })
  process.once('SIGTERM', () => {
    void stop()
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    gatewayLogger().fatal('fatal startup error', {}, error)
    process.exit(1)
  })
}
