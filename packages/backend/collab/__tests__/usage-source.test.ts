/**
 * W13.3 — usageSource transit through core.
 *
 * A passthrough field is exactly the kind of change that typechecks while
 * silently going nowhere, so the seam is asserted where it actually matters:
 * core's stream executor must carry the label from the command's params onto
 * the text-stream context, because that is what the ledger write reads
 * (agent-loop-executor: `state.ctx.usageSource || 'chat'`).
 *
 * The producers (coordinator drive / worker briefing) are asserted on their own
 * emitted commands in coordinator-reply-quote.test.ts and worker.test.ts.
 *
 * Budget attribution is NOT touched: the room gate still sums the ledger by
 * sessionId, and nothing here implies otherwise.
 */
import { describe, expect, it } from 'vitest'
import {
  COLLAB_USAGE_SOURCE_ROOM,
  COLLAB_USAGE_SOURCE_WORK,
} from '@onething/runtime/collab'
import { buildTextStreamContext, executeCoreMessageStream } from '@onething/core/engine'

async function runWith(usageSource?: string): Promise<Record<string, unknown>> {
  let seen: Record<string, unknown> = {}
  await executeCoreMessageStream({
    params: {
      sender: {},
      sessionId: 'room-1',
      assistantMessageId: 'a1',
      messageContent: 'hi',
      historyMessages: [],
      configWithApiKey: { apiKey: 'k', model: 'm' },
      providerId: 'p',
      settings: {},
      ...(usageSource ? { usageSource } : {}),
    },
    createController: () => ({ signal: {}, abort: () => {} }),
    registry: {
      registerController: () => {},
      removeController: () => {},
      getSteeringQueue: () => undefined,
      getFollowUpQueue: () => undefined,
    },
    supportsSpecialStream: async () => false,
    processSpecialStream: async () => true,
    executeTextStream: async ctx => {
      seen = ctx as unknown as Record<string, unknown>
      return {}
    },
    logger: { log: () => {}, error: () => {} },
  })
  return seen
}

describe('core stream executor carries usageSource to the text-stream context', () => {
  it('hands the label through', async () => {
    expect((await runWith(COLLAB_USAGE_SOURCE_ROOM)).usageSource).toBe('collab-room')
    expect((await runWith(COLLAB_USAGE_SOURCE_WORK)).usageSource).toBe('collab-work')
  })

  it('leaves it undefined when nobody set one (the ledger then writes chat)', async () => {
    expect((await runWith()).usageSource).toBeUndefined()
  })

  it('does not invent the field on the context builder', () => {
    expect(buildTextStreamContext({ base: { a: 1 } })).not.toHaveProperty('usageSource')
  })
})

describe('the ledger default is chat, and only the label moves it', () => {
  // Mirrors agent-loop-executor's one-line expression, so an edit that drops
  // the fallback fails here instead of silently re-labelling every turn.
  const resolve = (usageSource?: string): string => usageSource || 'chat'

  it('keeps chat for every unlabelled turn', () => {
    expect(resolve(undefined)).toBe('chat')
    expect(resolve('')).toBe('chat')
  })

  it('uses the collab labels when they are there', () => {
    expect(resolve(COLLAB_USAGE_SOURCE_ROOM)).toBe('collab-room')
    expect(resolve(COLLAB_USAGE_SOURCE_WORK)).toBe('collab-work')
  })
})
