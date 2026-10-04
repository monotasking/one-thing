/**
 * `acp-mcp-bridge.cjs` 在这台宿主上的哪儿(ACP A4-a,`docs/design/acp-integration-2026-09.md`
 * §3.6)。
 *
 * 与 `search/search-worker.ts` 的 `resolveSearchWorkerPath` **同一条规矩、同一种写法**:
 * 三份构建配方(`apps/desktop-react/scripts/build-electron.mjs` 第四个 esbuild、
 * `scripts/build-cli.mjs` 第三个、`scripts/build-server.mjs` ③)都把它放在宿主入口旁边,
 * 这里按宿主 bundle 自己的 `import.meta.url` 往旁边找 —— 没有一个宿主递路径,加第四个宿主
 * 是加一条构建入口,不是加一行接线。
 *
 * 打包后的那一份在 `app.asar.unpacked/` 下(`electron-builder.yml` 的 asarUnpack 那一行),
 * 而且**必须**用那一份:agent 起它的命令是 `ELECTRON_RUN_AS_NODE=1 <Electron>`,那条 node
 * 没有 asar 补丁,asar 里的路径对它来说不存在。所以解包那一份排在前面。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getLogger } from '@onething/backend/logging/configure-logging'

const log = getLogger('app.acp.host-mcp')

/** 三份构建配方共同约定的产物名。 */
export const ACP_MCP_BRIDGE_FILENAME = 'acp-mcp-bridge.cjs'

/** 逃生口:门脚本 / 测试可以直接指一份产物。 */
export const ACP_MCP_BRIDGE_PATH_ENV = 'ONETHING_ACP_MCP_BRIDGE'

/**
 * 找不到 = `undefined`(不抛):「这台宿主没有 stdio 桥」该结构化降级成「这一轮不给宿主
 * 工具」,而不是把会话起不来。开发期直接跑源码(vitest / tsx)时就是这个答案。
 */
export function resolveAcpMcpBridgePath(): string | undefined {
  const candidates: string[] = []
  const override = process.env[ACP_MCP_BRIDGE_PATH_ENV]
  if (override !== undefined && override.length > 0) candidates.push(path.resolve(override))
  const here = hostDirectory()
  if (here !== undefined) {
    const inPlace = path.join(here, ACP_MCP_BRIDGE_FILENAME)
    const unpacked = unpackedTwin(inPlace)
    if (unpacked !== undefined) candidates.push(unpacked)
    candidates.push(inPlace)
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  log.warn('acp mcp bridge bundle not found; agents without http MCP get no host tools', {
    fields: { candidates },
  })
  return undefined
}

/** `…/app.asar/…` → `…/app.asar.unpacked/…`;不在 asar 里 = `undefined`。见 search worker 同名函数。 */
function unpackedTwin(filePath: string): string | undefined {
  const marker = `app.asar${path.sep}`
  if (!filePath.includes(marker)) return undefined
  return filePath.replace(marker, `app.asar.unpacked${path.sep}`)
}

/** 宿主 bundle 所在目录。与 `search/search-worker.ts` 的 `hostDirectory` 逐字同型。 */
function hostDirectory(): string | undefined {
  try {
    const here = import.meta.url
    if (typeof here === 'string' && here.startsWith('file:')) {
      return path.dirname(fileURLToPath(here))
    }
  } catch {
    // import.meta 在某些 CJS 降级下会被折成 {} —— 落到下面那一支。
  }
  return typeof __dirname === 'string' ? __dirname : undefined
}
