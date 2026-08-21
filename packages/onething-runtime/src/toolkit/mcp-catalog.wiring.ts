/**
 * R2b —— MCP 工具进目录(§13.7 裁定 5)。
 *
 * 旧路里 MCP 是 `core/engine/direct-tool-execution.ts` 里一整支 `if (isMCPTool)`;
 * 新路里它就是目录里的一个普通 `Tool`(`McpTool`),对 Catalog / Surface / Runner /
 * Authorizer 一视同仁(尺子⑥)。
 *
 * 生命周期按裁定 5:**连接建立时 register + ensurePrepared,断开时 unregister**,
 * 挂点是 `app/mcp/capabilities-changed.ts`(它已经是"服务器工具面变了"的唯一通知
 * 点)。这里额外在每次解析工具面/执行前做一次幂等的 diff 同步 —— 因为
 * `getMCPToolDefinitionsForModel()` 是**每次现算**的(flat/router 两种模式会随
 * 阈值翻转),而通知点只覆盖"服务器推了 list_changed"这一种变化。两条路进同一个
 * 函数,所以不会有两份口径。
 *
 * **模型面不由这里决定**:缝 1 仍然把 MCP 定义按旧路递给 `planAgentLoopTools`
 * (那里管 flat/router 的互斥与 enabled 过滤),目录只负责"这个名字调下来时,谁来
 * 跑它"。这样开关翻开时模型看到的 MCP 工具面逐字不变。
 */

import type { Catalog } from '@onething/core/toolkit'
import type { JsonObject } from '@onething/core'
import { McpTool, type McpToolBridge, type McpToolDescription } from './index.js'
import {
  executeMCPTool,
  getMCPToolDefinitionsForModel,
  resolveMCPServerIdForToolRef,
} from '../mcp/index.wiring.js'

/** 本模块登记过的 id。不碰目录里别人注册的东西 —— 摘只摘自己挂上去的。 */
const registered = new Map<Catalog, Set<string>>()

function describeFromLiveDefinitions(toolId: string): McpToolDescription | undefined {
  const definition = getMCPToolDefinitionsForModel().find(item => item.id === toolId)
  if (!definition) return undefined
  return {
    id: definition.id,
    name: definition.name,
    description: definition.description,
    ...(definition.parameterSchema ? { parameterSchema: definition.parameterSchema as JsonObject } : {}),
  }
}

const bridge: McpToolBridge = {
  describe: toolId => describeFromLiveDefinitions(toolId),
  execute: (toolId, args, options) => executeMCPTool(toolId, args, options),
  resolveServerId: toolRef => resolveMCPServerIdForToolRef(toolRef),
}

/**
 * 幂等同步。返回本次实际新注册的 id(调用方据此决定要不要 `ensurePrepared`)。
 *
 * `catalog.has(id)` 时不覆盖:内置工具与 MCP 工具重名时,内置的赢 —— 与旧路
 * `isMCPTool` 排在内置分支之前的口径**相反**,但那条口径今天不可能被触发
 * (MCP id 一律带 `mcp:` 前缀或是那两个 router 名),所以这里选更保守的那一边。
 */
export function syncMcpToolsIntoCatalog(catalog: Catalog): string[] {
  let mine = registered.get(catalog)
  if (!mine) {
    mine = new Set<string>()
    registered.set(catalog, mine)
  }

  let definitions: Array<{ id: string; name: string; description: string; parameterSchema?: unknown }>
  try {
    definitions = getMCPToolDefinitionsForModel()
  } catch {
    // MCP 没起来 / 读表炸了不该让工具执行整条挂掉:保持现状。
    return []
  }

  const wanted = new Set(definitions.map(item => item.id))
  for (const id of [...mine]) {
    if (wanted.has(id)) continue
    catalog.unregister(id)
    mine.delete(id)
  }

  const added: string[] = []
  for (const definition of definitions) {
    if (mine.has(definition.id) || catalog.has(definition.id)) continue
    catalog.register(new McpTool({
      toolId: definition.id,
      bridge,
      initial: {
        id: definition.id,
        name: definition.name,
        description: definition.description,
        ...(definition.parameterSchema ? { parameterSchema: definition.parameterSchema as JsonObject } : {}),
      },
    }))
    mine.add(definition.id)
    added.push(definition.id)
  }
  return added
}

/** 服务器工具面变了(裁定 5 的挂点)。同步 + 预热新工具的 schema。 */
export function refreshMcpToolsInCatalog(catalog: Catalog): void {
  const added = syncMcpToolsIntoCatalog(catalog)
  for (const id of added) {
    void catalog.ensurePrepared(id).catch(() => {
      // 一次拉描述失败不毒死这个工具:`Catalog.ensurePrepared` 已经把记录删掉了,
      // 下一次调用会重试。
    })
  }
}

/** 测试钩子。 */
export function resetMcpCatalogSyncForTests(): void {
  registered.clear()
}
