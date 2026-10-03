import { describe, expect, it, vi } from 'vitest'
import {
  callOnethingMCPTool,
  getOnethingMCPPrompt,
  listOnethingMCPPrompts,
  listOnethingMCPResources,
  listOnethingMCPTools,
  readOnethingMCPResource,
} from '../capability-operations.js'

describe('MCP capability operations', () => {
  it('lists tools, resources, and prompts using host adapters', () => {
    expect(listOnethingMCPTools({
      getAllTools: () => [{ name: 'search' }],
    })).toEqual({
      success: true,
      tools: [{ name: 'search' }],
    })

    expect(listOnethingMCPResources({
      getAllResources: () => [{ uri: 'file://a' }],
    })).toEqual({
      success: true,
      resources: [{ uri: 'file://a' }],
    })

    expect(listOnethingMCPPrompts({
      getAllPrompts: () => [{ name: 'brief' }],
    })).toEqual({
      success: true,
      prompts: [{ name: 'brief' }],
    })
  })

  it('projects tool call results into a stable response', async () => {
    const callTool = vi.fn(async () => ({
      success: false,
      content: [{ type: 'text', text: 'nope' }],
      error: 'tool failed',
      isError: true,
    }))

    await expect(callOnethingMCPTool({
      serverId: 'server-1',
      toolName: 'search',
      args: { q: 'hello' },
      callTool,
    })).resolves.toEqual({
      success: false,
      content: [{ type: 'text', text: 'nope' }],
      error: 'tool failed',
      isError: true,
    })

    expect(callTool).toHaveBeenCalledWith('server-1', 'search', { q: 'hello' })
  })

  it('projects resource and prompt reads into stable responses', async () => {
    const readResource = vi.fn(() => ({
      success: true,
      content: { text: 'resource' },
    }))
    const getPrompt = vi.fn(async () => ({
      success: true,
      messages: [{ role: 'user', content: 'hi' }],
    }))

    await expect(readOnethingMCPResource({
      serverId: 'server-1',
      uri: 'file://a',
      readResource,
    })).resolves.toEqual({
      success: true,
      content: { text: 'resource' },
      error: undefined,
    })

    await expect(getOnethingMCPPrompt({
      serverId: 'server-1',
      name: 'brief',
      args: { topic: 'runtime' },
      getPrompt,
    })).resolves.toEqual({
      success: true,
      messages: [{ role: 'user', content: 'hi' }],
      error: undefined,
    })

    expect(readResource).toHaveBeenCalledWith('server-1', 'file://a')
    expect(getPrompt).toHaveBeenCalledWith('server-1', 'brief', { topic: 'runtime' })
  })
})
