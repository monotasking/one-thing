/**
 * 设置页工具列表的**呈现**(source 推导 + MCP 合并)。
 *
 * R4b:它留在这里而不是随旧树删除 —— 整个文件对工具系统一无所知
 * (`getAllToolsAsync` / `getMCPToolDefinitions` 都是注入进来的函数),它答的只是
 * 「这张清单怎么排」。旧路里它还负责在列表之前给异步工具 `setInitContext(cwd)`,
 * 那一格随「异步工具」这个概念一起删了。
 */
type MaybePromise<T> = T | Promise<T>

export interface OnethingToolListIpcLogger {
  error?: (...args: unknown[]) => void
}

export type OnethingVisibleToolSource = 'builtin' | 'plugin' | 'mcp'

export interface OnethingVisibleToolLike {
  id: string
  source?: OnethingVisibleToolSource | string
}

export interface ListOnethingSettingsToolsOptions<
  TTool extends OnethingVisibleToolLike = OnethingVisibleToolLike,
> {
  getAllToolsAsync(): MaybePromise<TTool[]>
  /**
   * 决策点 #1 hybrid: mode-resolved MCP tool defs for the settings tool list
   * — flat array at/below the threshold, single router above it.
   */
  getMCPToolDefinitions(): TTool[]
}

export type OnethingVisibleTool<TTool extends OnethingVisibleToolLike = OnethingVisibleToolLike> =
  TTool & { source: OnethingVisibleToolSource }

export async function listOnethingSettingsTools<
  TTool extends OnethingVisibleToolLike,
>(
  options: ListOnethingSettingsToolsOptions<TTool>,
): Promise<Array<OnethingVisibleTool<TTool>>> {
  const allTools = await options.getAllToolsAsync()
  const visibleTools = allTools
    .filter(tool => !tool.id.startsWith('mcp:'))
    .map(tool => ({
      ...tool,
      source: tool.id.startsWith('plugin:') ? 'plugin' : 'builtin',
    }) as OnethingVisibleTool<TTool>)

  const mcpToolDefinitions = options.getMCPToolDefinitions()
  for (const mcpTool of mcpToolDefinitions) {
    if (!visibleTools.some(tool => tool.id === mcpTool.id)) {
      visibleTools.push({
        ...mcpTool,
        source: 'mcp',
      } as OnethingVisibleTool<TTool>)
    }
  }

  return visibleTools
}

export async function listOnethingSettingsToolsForIpc<
  TTool extends OnethingVisibleToolLike,
>(
  options: ListOnethingSettingsToolsOptions<TTool> & {
    logger?: OnethingToolListIpcLogger
  },
): Promise<
  | { success: true; tools: Array<OnethingVisibleTool<TTool>> }
  | { success: false; error: string }
> {
  try {
    return {
      success: true,
      tools: await listOnethingSettingsTools(options),
    }
  } catch (error) {
    options.logger?.error?.('[Tools IPC] Error getting tools:', error)
    return {
      success: false,
      error: error instanceof Error && error.message ? error.message : 'Failed to get tools',
    }
  }
}
