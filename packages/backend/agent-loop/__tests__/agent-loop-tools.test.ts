import { describe, expect, it } from 'vitest'
import { planAgentLoopTools } from '../agent-loop-runtime.js'

const TOOLS = [
  { id: 'bash', description: 'run commands' },
  { id: 'read', description: 'read files' },
  { id: 'variable', description: 'state board' },
]

const MCP_ROUTER = { id: 'mcp_search', description: 'route mcp tools' }

describe('planAgentLoopTools', () => {
  it('passes all tools through without an allowlist', () => {
    const plan = planAgentLoopTools({
      toolLoadingEnabled: true,
      allEnabledTools: TOOLS,
      mcpRouterTool: MCP_ROUTER,
    })

    expect(plan.toolNames).toEqual(['bash', 'read', 'variable'])
    expect(plan.mcpToolNames).toEqual(['mcp_search'])
    expect(plan.hasTools).toBe(true)
  })

  it('restricts tools to the agent allowlist, including the MCP router', () => {
    const plan = planAgentLoopTools({
      toolLoadingEnabled: true,
      allEnabledTools: TOOLS,
      mcpRouterTool: MCP_ROUTER,
      allowedToolIds: ['bash'],
    })

    expect(plan.toolNames).toEqual(['bash'])
    expect(plan.mcpToolNames).toEqual([])
    expect(plan.hasTools).toBe(true)
  })

  it('keeps the MCP router when the allowlist includes it', () => {
    const plan = planAgentLoopTools({
      toolLoadingEnabled: true,
      allEnabledTools: TOOLS,
      mcpRouterTool: MCP_ROUTER,
      allowedToolIds: ['read', 'mcp_search'],
    })

    expect(plan.toolNames).toEqual(['read'])
    expect(plan.mcpToolNames).toEqual(['mcp_search'])
  })

  it('treats an empty allowlist as no restriction', () => {
    const plan = planAgentLoopTools({
      toolLoadingEnabled: true,
      allEnabledTools: TOOLS,
      allowedToolIds: [],
    })

    expect(plan.toolNames).toEqual(['bash', 'read', 'variable'])
  })
})
