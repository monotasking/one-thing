/**
 * MCP 服务器配置里的私密字段:出网前脱敏、写回时合并。
 *
 * 这些规则从前只长在 `server/runtime.ts` 的 `mcp` facade adapter 里(P4c 第六批
 * 之前)。域整只搬去 `rpc/domains/mcp.ts` 之后,**规则跟着搬,但没有被稀释**:
 * 它是一道「谁在问」决定的护栏(`context.transport === 'http'`),不是某个宿主
 * 的实现细节,所以它单独成文件,由**两处**共用 ——
 *  - `server/runtime.ts` 的设置面(`redactMcpServerPrivateSettings` /
 *    `preserveMcpServerPrivateSettings` 走整棵 `settings.mcp`);
 *  - `rpc/domains/mcp.ts` 的 http 分叉(走单个 `MCPServerConfig` / `MCPServerState`)。
 *
 * 判据一句话:**能落到本机的东西不出网**。`command` / `args` / `env` / `cwd` 是
 * 会被拿去起进程的,`url` / `headers` 里通常挂着凭证 —— 这六个键一律以
 * `SERVER_REDACTED_SECRET` 出门,回来时若原样带着这个哨兵(或干脆没带这个键),
 * 就把服务器上那份真值合并回去,于是「改个名字」不会把凭证洗掉。
 */
import type { MCPServerConfig, MCPServerState } from '@onething/core/mcp'

export const SERVER_REDACTED_SECRET = '__onething_server_secret_set__'

/** 不出网的六个键。改这张表 = 改护栏,两处调用点同时生效。 */
export const MCP_SERVER_PRIVATE_KEYS = new Set([
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 空数组 / 空对象 / 空串 / null / undefined 不算「有值」——脱敏它只会制造噪声。 */
export function shouldRedactMcpPrivateValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  if (isRecord(value)) return Object.keys(value).length > 0
  return value !== undefined && value !== null && value !== ''
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function sanitizeMCPServerConfigForClient(config: MCPServerConfig): MCPServerConfig {
  const redacted = cloneJson(config) as unknown as Record<string, unknown>
  for (const key of MCP_SERVER_PRIVATE_KEYS) {
    if (shouldRedactMcpPrivateValue(redacted[key])) {
      redacted[key] = SERVER_REDACTED_SECRET
    }
  }
  return redacted as unknown as MCPServerConfig
}

export function sanitizeMCPServerStateForClient(state: MCPServerState): MCPServerState {
  return { ...state, config: sanitizeMCPServerConfigForClient(state.config) }
}

export function sanitizeMCPServerStatesForClient(states: MCPServerState[]): MCPServerState[] {
  return states.map(state => sanitizeMCPServerStateForClient(state))
}

export function sanitizeMCPMutationResultForClient<T extends { server?: MCPServerState }>(
  result: T,
): T {
  if (!result.server) return result
  return { ...result, server: sanitizeMCPServerStateForClient(result.server) }
}

/**
 * 客户端交回来的配置里,凡是没带值或带着哨兵的私密键,用服务器上那份真值补齐。
 * `previous` 缺席(新增服务器)时原样返回 —— 没有可合并的旧值。
 */
export function mergeRedactedMCPServerConfig(
  incoming: MCPServerConfig,
  previous: MCPServerConfig | undefined,
): MCPServerConfig {
  if (!previous) return incoming

  const prepared = cloneJson(incoming) as unknown as Record<string, unknown>
  const previousRecord = previous as unknown as Record<string, unknown>
  const incomingRecord = incoming as unknown as Record<string, unknown>

  for (const key of MCP_SERVER_PRIVATE_KEYS) {
    const previousValue = previousRecord[key]
    if (!shouldRedactMcpPrivateValue(previousValue)) continue
    const hasIncomingValue = Object.hasOwn(incomingRecord, key)
    const incomingValue = incomingRecord[key]
    if (!hasIncomingValue || incomingValue === SERVER_REDACTED_SECRET) {
      prepared[key] = cloneJson(previousValue)
    }
  }

  return prepared as unknown as MCPServerConfig
}
