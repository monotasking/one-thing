import { describe, expect, it } from 'vitest'
import { agentToolsFromToolDefinitions } from './tools.js'
import type { AgentToolExecutionContext } from './types.js'

const ctx: AgentToolExecutionContext = {
  sessionId: 's',
  messageId: 'm',
  toolCallId: 'c',
}

describe('agentToolsFromToolDefinitions terminate passthrough (N6)', () => {
  // The registry adapter (and, through it, plugin tools) surface terminate as a
  // field on the execution result; this is the layer that must carry it onto
  // the AgentToolResult the runner inspects.
  it('threads terminate from a successful adapter result onto the AgentToolResult', async () => {
    const [tool] = agentToolsFromToolDefinitions(
      { demo: { description: 'd', parameters: [] } },
      async () => ({ success: true, data: { output: 'final' }, terminate: true }),
    )

    const result = await tool.execute({}, ctx)
    expect(result.terminate).toBe(true)
    expect(result.content).toContain('final')
  })

  it('threads terminate from a failed adapter result too', async () => {
    const [tool] = agentToolsFromToolDefinitions(
      { demo: { description: 'd', parameters: [] } },
      async () => ({ success: false, error: 'boom', terminate: true }),
    )

    const result = await tool.execute({}, ctx)
    expect(result.terminate).toBe(true)
    expect(result.error).toBe('boom')
  })

  it('leaves terminate undefined when the adapter omits it', async () => {
    const [tool] = agentToolsFromToolDefinitions(
      { demo: { description: 'd', parameters: [] } },
      async () => ({ success: true, data: { output: 'ok' } }),
    )

    const result = await tool.execute({}, ctx)
    expect(result.terminate).toBeUndefined()
  })
})
