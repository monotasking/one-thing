/**
 * ACP agent 配置与会话选项的形状(A0-3:只此一份)。
 *
 * 产品层 `runtime/src/acp/types.ts` 与契约层 `shared/ipc/acp.ts` 都 `import type` 这里:
 * 契约层不许依赖产品层,产品层(非 `*.wiring.ts`)不许 import `@shared/ipc`,
 * 两边都够得着、又不反向依赖的只有 `@shared/contracts`。
 */
import type { JsonObject } from '../json.js'

export type ACPPermissionMode = 'allow' | 'reject'

export interface ACPAgentConfig {
  id: string
  name: string
  description?: string
  enabled: boolean
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  model?: string
  permissionMode?: ACPPermissionMode
  allowFileSystemAccess?: boolean
  allowTerminalAccess?: boolean
  mcpServers?: JsonObject[]
  connectTimeoutMs?: number
  promptTimeoutMs?: number
  idleTimeoutMs?: number
  maxBufferedUpdates?: number
  maxSessionRecords?: number
  maxTerminals?: number
  maxTerminalOutputBytes?: number
}

/**
 * 一台 agent 在**它自己的会话里**自述的一格可调选项(ACP `configOptions`:模型 / 模式 /
 * 思考档……)。onething 不认识「模型」这件事 —— agent 列什么就画什么,选中后原样经
 * `session/set_config_option` 交回去。只收 `select` 那一种;分组的选项在投影时拍平,
 * 组名落进 `group`。
 */
export interface ACPSessionOptionChoice {
  value: string
  name: string
  description?: string
  group?: string
}

export interface ACPSessionOption {
  id: string
  name: string
  description?: string
  /** ACP 的 `category`:`model` / `mode` / `thought_level` / 扩展值。只是提示,不是判据。 */
  category?: string
  currentValue: string
  choices: ACPSessionOptionChoice[]
}
