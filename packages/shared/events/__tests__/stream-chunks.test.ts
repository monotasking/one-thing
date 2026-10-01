import { describe, expect, it } from 'vitest'
import type {
  ReasoningDeltaChunk,
  ReasoningPlacement,
  StreamChunk,
  TextDeltaChunk,
  ToolInputDeltaChunk,
} from '../stream-chunks.js'

describe('core stream chunk protocol', () => {
  it('keeps text, reasoning, and tool input deltas in the headless event boundary', () => {
    const text: TextDeltaChunk = {
      type: 'text-delta',
      text: 'visible',
      voiceSpeakText: 'spoken',
      turnIndex: 1,
    }
    const placement: ReasoningPlacement = 'inline'
    const reasoning: ReasoningDeltaChunk = {
      type: 'reasoning-delta',
      reasoning: 'thinking',
      placement,
      turnIndex: 1,
    }
    const toolInput: ToolInputDeltaChunk = {
      type: 'tool-input-delta',
      toolCallId: 'tool-1',
      argsTextDelta: '{"path"',
    }
    const chunks: StreamChunk[] = [text, reasoning, toolInput]

    expect(chunks.map(chunk => chunk.type)).toEqual([
      'text-delta',
      'reasoning-delta',
      'tool-input-delta',
    ])
  })
})
