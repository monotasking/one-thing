import { describe, expect, it } from 'vitest'
import { buildAgentLoopDirectToolsWithAdapters } from '../../agent-loop/agent-loop.js'
import { executeCoreDirectTool } from '../../agent-loop/agent-loop.js'
import { principalId, type Principal } from '@shared/permission/principal.js'

/**
 * The actor has to survive the whole way down, not just exist at the top.
 *
 * Every hop here is an OPTIONAL field being copied from one context object to
 * the next, which means a dropped hop is not a type error — it silently
 * produces `undefined` and the judgment quietly loses its subject again. These
 * tests are the only thing that notices.
 */

const AGENT: Principal = { kind: 'agent', agentId: 'skill-reviewer' }

describe('principal survives the tool-execution chain', () => {
  it('agent-loop runtime context → executeToolDirectly', async () => {
    let seen: Principal | undefined
    const tools = buildAgentLoopDirectToolsWithAdapters({
      definitions: {
        'read': { description: 'Read', parameters: [] },
      } as never,
      context: {
        sessionId: 's1',
        messageId: 'm1',
        principal: AGENT,
      },
      executeToolDirectly: async (_toolName, _args, context) => {
        seen = context.principal
        return { success: true, data: {} }
      },
    })

    await tools[0].execute({}, { toolCallId: 'call_1' } as never)
    expect(seen).toEqual(AGENT)
    expect(principalId(seen!)).toBe('agent:skill-reviewer')
  })

  it('direct execution context → enforcePermission (built-in tools)', async () => {
    let seen: Principal | undefined
    await executeCoreDirectTool({
      toolName: 'write',
      args: {},
      context: { sessionId: 's1', messageId: 'm1', principal: AGENT },
      isMCPTool: () => false,
      executeMCPTool: async () => ({}),
      analyzeTool: async () => ({ success: true, effects: [{ kind: 'file_write' }] }),
      executeTool: async () => ({ success: true }),
      enforcePermission: async input => { seen = input.principal },
      createExecutionContext: context => ({ ...context }) as never,
      formatFailure: () => 'failed',
    })
    expect(seen).toEqual(AGENT)
  })

  it('direct execution context → enforcePermission (MCP tools take a separate path)', async () => {
    // MCP does not go through analyzeTool at all — it builds its permission
    // plan in its own branch, so the actor has to be threaded there too.
    let seen: Principal | undefined
    await executeCoreDirectTool({
      toolName: 'mcp_search',
      args: { action: 'call', tool: 'write_file', server: 'fs' },
      context: { sessionId: 's1', messageId: 'm1', principal: AGENT },
      isMCPTool: () => true,
      executeMCPTool: async () => ({}),
      analyzeTool: async () => ({ success: true, effects: [] }),
      executeTool: async () => ({ success: true }),
      enforcePermission: async input => { seen = input.principal },
      createExecutionContext: context => ({ ...context }) as never,
      formatFailure: () => 'failed',
    })
    expect(seen).toEqual(AGENT)
  })

  it('an absent actor stays absent — no silent substitution', async () => {
    let called = false
    let seen: Principal | undefined = AGENT
    await executeCoreDirectTool({
      toolName: 'write',
      args: {},
      context: { sessionId: 's1', messageId: 'm1' },
      isMCPTool: () => false,
      executeMCPTool: async () => ({}),
      analyzeTool: async () => ({ success: true, effects: [{ kind: 'file_write' }] }),
      executeTool: async () => ({ success: true }),
      enforcePermission: async input => { called = true; seen = input.principal },
      createExecutionContext: context => ({ ...context }) as never,
      formatFailure: () => 'failed',
    })
    expect(called).toBe(true)
    expect(seen).toBeUndefined()
  })
})
