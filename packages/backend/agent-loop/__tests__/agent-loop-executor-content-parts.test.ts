import { describe, expect, it } from 'vitest'
import { appendOrderedPart, createAgentLoopExecutorTurnState, persistAgentLoopTurnContentPartsWithAdapters } from '@onething/backend/agent-loop'
import { dispatchAgentLoopToolContentPartsWithAdapters, getAgentLoopReasoningPlacement, hasAgentLoopVisibleTurnActivity, planAgentLoopToolContentPartsDispatch, planAgentLoopTurnContentPersistence } from '../agent-loop-executor-content-parts.js'

describe('core agent-loop executor helpers', () => {
  it('creates turn state and merges adjacent ordered text/reasoning parts', () => {
    const turn = createAgentLoopExecutorTurnState<unknown, { type: string; content?: string; turnIndex?: number }>()

    appendOrderedPart(turn.orderedParts, { type: 'text', content: 'hello', turnIndex: 1 })
    appendOrderedPart(turn.orderedParts, { type: 'text', content: ' world', turnIndex: 1 })
    appendOrderedPart(turn.orderedParts, { type: 'reasoning', content: 'think', turnIndex: 1 })
    appendOrderedPart(turn.orderedParts, { type: 'reasoning', content: ' more', turnIndex: 1 })

    expect(turn).toMatchObject({
      toolCalls: [],
      content: { value: '' },
      reasoning: { value: '' },
      hasSentToolParts: false,
      orderedParts: [
        { type: 'text', content: 'hello world', turnIndex: 1 },
        { type: 'reasoning', content: 'think more', turnIndex: 1 },
      ],
    })
  })

  it('places first-turn reasoning at top until visible activity appears', () => {
    const turn = createAgentLoopExecutorTurnState<unknown, { type: string; content?: string; turnIndex?: number }>()

    expect(hasAgentLoopVisibleTurnActivity(turn)).toBe(false)
    expect(getAgentLoopReasoningPlacement({
      turnIndex: 1,
      accumulatedContent: '',
      turn,
    })).toBe('top')

    appendOrderedPart(turn.orderedParts, { type: 'provider-data', turnIndex: 1 })
    expect(hasAgentLoopVisibleTurnActivity(turn)).toBe(false)
    expect(getAgentLoopReasoningPlacement({
      turnIndex: 1,
      accumulatedContent: '',
      turn,
    })).toBe('top')

    appendOrderedPart(turn.orderedParts, { type: 'text', content: 'hello', turnIndex: 1 })
    expect(hasAgentLoopVisibleTurnActivity(turn)).toBe(true)
    expect(getAgentLoopReasoningPlacement({
      turnIndex: 1,
      accumulatedContent: '',
      turn,
    })).toBe('inline')
  })

  it('plans agent-loop content-part dispatch and persistence in core', () => {
    const turn = createAgentLoopExecutorTurnState<unknown, { type: string; content?: string; turnIndex?: number }>()
    turn.orderedParts.push(
      { type: 'provider-data', turnIndex: 1 },
      { type: 'text', content: 'hello', turnIndex: 1 },
      { type: 'reasoning', content: 'think', turnIndex: 1 },
    )

    expect(planAgentLoopToolContentPartsDispatch(turn, 1)).toEqual({
      shouldSend: true,
      parts: [
        { type: 'text', content: 'hello', turnIndex: 1 },
        { type: 'reasoning', content: 'think', turnIndex: 1 },
      ],
      dataStepsPart: { type: 'data-steps', turnIndex: 1 },
    })

    turn.hasSentToolParts = true
    expect(planAgentLoopToolContentPartsDispatch(turn, 1)).toEqual({
      shouldSend: false,
      parts: [],
    })

    expect(planAgentLoopTurnContentPersistence(turn, 1)).toEqual({
      persistParts: [
        { type: 'provider-data', turnIndex: 1 },
        { type: 'text', content: 'hello', turnIndex: 1 },
        { type: 'reasoning', content: 'think', turnIndex: 1 },
      ],
      immediateParts: [
        { type: 'text', content: 'hello', turnIndex: 1 },
        { type: 'reasoning', content: 'think', turnIndex: 1 },
      ],
    })

    turn.toolCalls.push({ id: 'call-1' })
    expect(planAgentLoopTurnContentPersistence(turn, 1)).toEqual({
      persistParts: [
        { type: 'provider-data', turnIndex: 1 },
        { type: 'text', content: 'hello', turnIndex: 1 },
        { type: 'reasoning', content: 'think', turnIndex: 1 },
        { type: 'data-steps', turnIndex: 1 },
      ],
      immediateParts: [],
    })

    const adapterTurn = createAgentLoopExecutorTurnState<unknown, { type: string; content?: string; turnIndex?: number }>()
    adapterTurn.orderedParts.push(
      { type: 'provider-data', turnIndex: 2 },
      { type: 'text', content: 'adapter', turnIndex: 2 },
    )
    const sentParts: unknown[] = []
    const persistedParts: unknown[] = []

    expect(dispatchAgentLoopToolContentPartsWithAdapters({
      turn: adapterTurn,
      turnIndex: 2,
      emitter: {
        sendContentPart: part => sentParts.push(part),
      },
    })).toMatchObject({ shouldSend: true })
    expect(adapterTurn.hasSentToolParts).toBe(true)
    expect(sentParts).toEqual([
      { type: 'text', content: 'adapter', turnIndex: 2 },
      { type: 'data-steps', turnIndex: 2 },
    ])

    adapterTurn.toolCalls.push({ id: 'call-adapter' })
    expect(persistAgentLoopTurnContentPartsWithAdapters({
      sessionId: 's1',
      assistantMessageId: 'm1',
      turn: adapterTurn,
      turnIndex: 2,
      store: {
        addMessageContentPart: (_sessionId, _messageId, part) => persistedParts.push(part),
      },
      emitter: {
        sendContentPart: part => sentParts.push(part),
      },
    })).toMatchObject({ immediateParts: [] })
    expect(persistedParts).toEqual([
      { type: 'provider-data', turnIndex: 2 },
      { type: 'text', content: 'adapter', turnIndex: 2 },
      { type: 'data-steps', turnIndex: 2 },
    ])
  })

  it('keeps the steps anchor at its streamed position when text follows the tool call (external agents)', () => {
    // External agents interleave text → tool → text inside one turn: the
    // dispatch records the anchor inline, and persistence must not append a
    // second anchor at the end (which would yank the cards below the text).
    const turn = createAgentLoopExecutorTurnState<unknown, { type: string; content?: string; turnIndex?: number }>()
    turn.orderedParts.push({ type: 'text', content: 'before ', turnIndex: 0 })

    const sent: unknown[] = []
    dispatchAgentLoopToolContentPartsWithAdapters({
      turn,
      turnIndex: 0,
      emitter: { sendContentPart: part => sent.push(part) },
    })
    turn.toolCalls.push({ id: 'call-1' })
    // Post-tool text arrives after the anchor.
    turn.orderedParts.push({ type: 'text', content: ' after', turnIndex: 0 })

    expect(turn.orderedParts).toEqual([
      { type: 'text', content: 'before ', turnIndex: 0 },
      { type: 'data-steps', turnIndex: 0 },
      { type: 'text', content: ' after', turnIndex: 0 },
    ])
    expect(planAgentLoopTurnContentPersistence(turn, 0)).toEqual({
      persistParts: [
        { type: 'text', content: 'before ', turnIndex: 0 },
        { type: 'data-steps', turnIndex: 0 },
        { type: 'text', content: ' after', turnIndex: 0 },
      ],
      immediateParts: [],
    })
  })
})
