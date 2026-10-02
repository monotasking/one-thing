import { describe, expect, it, vi } from 'vitest'
import {
  listOnethingSettingsTools,
  listOnethingSettingsToolsForIpc,
  type ListOnethingSettingsToolsOptions,
  type OnethingVisibleToolLike,
} from '../tool-list-presentation.js'

interface TestTool extends OnethingVisibleToolLike {
  name: string
}

function listTestTools(options: ListOnethingSettingsToolsOptions<TestTool>) {
  return listOnethingSettingsTools<TestTool>(options)
}

describe('listOnethingSettingsTools', () => {
  it('projects visible tool sources and hides the raw mcp: entries', async () => {
    await expect(listTestTools({
      getAllToolsAsync: () => [
        { id: 'read', name: 'Read' },
        { id: 'plugin:notes', name: 'Notes' },
        { id: 'mcp:legacy-server:tool', name: 'Legacy MCP' },
      ],
      getMCPToolDefinitions: () => [{ id: 'mcp-router', name: 'MCP Router' }],
    })).resolves.toEqual([
      { id: 'read', name: 'Read', source: 'builtin' },
      { id: 'plugin:notes', name: 'Notes', source: 'plugin' },
      { id: 'mcp-router', name: 'MCP Router', source: 'mcp' },
    ])
  })

  it('does not duplicate an already visible MCP router tool', async () => {
    await expect(listTestTools({
      getAllToolsAsync: () => [{ id: 'mcp-router', name: 'MCP Router' }],
      getMCPToolDefinitions: () => [{ id: 'mcp-router', name: 'MCP Router' }],
    })).resolves.toEqual([
      { id: 'mcp-router', name: 'MCP Router', source: 'builtin' },
    ])
  })

  it('normalizes settings-visible tool list failures for IPC callers', async () => {
    const logger = { error: vi.fn() }

    await expect(listOnethingSettingsToolsForIpc({
      getAllToolsAsync: () => {
        throw new Error('tools failed')
      },
      getMCPToolDefinitions: () => [],
      logger,
    })).resolves.toEqual({
      success: false,
      error: 'tools failed',
    })

    expect(logger.error).toHaveBeenCalledTimes(1)
  })
})
