import { describe, expect, it } from 'vitest'
import { appendAgentLoopTurnToolCallOnce, rememberAgentLoopToolStepId } from '../agent-loop-executor-turn-state.js'
import { planAgentLoopToolCallFallback } from '../agent-loop-executor-tool-steps.js'

describe('core agent-loop executor helpers', () => {
  it('tracks agent-loop tool-call fallback state in core', () => {
    const stepIds = new Map<string, string>()
    expect(rememberAgentLoopToolStepId(stepIds, 'call_1', undefined)).toBeUndefined()
    expect(stepIds.size).toBe(0)
    expect(rememberAgentLoopToolStepId(stepIds, 'call_1', 'step_1')).toBe('step_1')
    expect(stepIds.get('call_1')).toBe('step_1')

    const turnToolCalls = [{ id: 'call_1', toolName: 'read' }]
    expect(appendAgentLoopTurnToolCallOnce(turnToolCalls, { id: 'call_1', toolName: 'read-again' })).toBe(false)
    expect(appendAgentLoopTurnToolCallOnce(turnToolCalls, { id: 'call_2', toolName: 'write' })).toBe(true)
    expect(turnToolCalls.map(toolCall => toolCall.id)).toEqual(['call_1', 'call_2'])

    expect(planAgentLoopToolCallFallback([{ id: 'call_1' }], {
      toolCallId: 'call_1',
      toolName: 'read',
      args: { path: '/tmp/a.txt' },
    })).toEqual({
      shouldStartPlaceholder: false,
      toolCallId: 'call_1',
      toolName: 'read',
      args: { path: '/tmp/a.txt' },
    })

    expect(planAgentLoopToolCallFallback([], {
      toolCallId: 'call_3',
      toolName: 'bash',
    })).toEqual({
      shouldStartPlaceholder: true,
      toolCallId: 'call_3',
      toolName: 'bash',
      args: {},
    })
  })
})
