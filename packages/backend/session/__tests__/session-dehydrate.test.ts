import { describe, expect, it } from 'vitest'
import { dehydrateSessionForStorage, rehydrateSessionFromStorage } from '../session-dehydrate.js'

const base64 = 'iVBORw0KGgoAAAANSUhEUg'.repeat(40_000) // ~880KB

function makeSession() {
  const toolCall = {
    id: 'tc1',
    toolName: 'read',
    arguments: { path: '/tmp/shot.png' },
    status: 'completed',
    result: {
      title: 'Image: shot.png',
      output: '[Image file: /tmp/shot.png]',
      attachments: [{ type: 'image', path: '/tmp/shot.png', content: base64, mimeType: 'image/png' }],
    },
    changes: undefined,
  }
  return {
    id: 's1',
    messages: [
      { id: 'm0', role: 'user', content: 'hi' },
      {
        id: 'm1',
        role: 'assistant',
        content: 'done',
        toolCalls: [toolCall],
        steps: [{
          id: 'step1',
          type: 'tool-call',
          title: 'read shot.png',
          status: 'completed',
          timestamp: 1,
          toolCallId: 'tc1',
          toolCall: { ...toolCall },
          partialResult: {
            content: [
              { type: 'text', text: '[Image file: /tmp/shot.png]' },
              { type: 'image', path: '/tmp/shot.png', data: base64, mimeType: 'image/png' },
            ],
          },
          partialResultIsPartial: false,
        }],
      },
    ],
  }
}

describe('dehydrateSessionForStorage', () => {
  it('drops step duplicates and inline binaries, shrinking the payload', () => {
    const session = makeSession()
    const before = JSON.stringify(session).length
    const dehydrated = dehydrateSessionForStorage(session)
    const after = JSON.stringify(dehydrated).length

    expect(after).toBeLessThan(before / 100) // 3× ~880KB duplicates → tiny
    const message = (dehydrated as ReturnType<typeof makeSession>).messages[1]
    expect(message.steps![0].toolCall).toBeUndefined()
    expect(message.steps![0].partialResult).toBeUndefined()
    const attachment = (message.toolCalls![0].result as { attachments: Array<{ content: string; path: string }> }).attachments[0]
    expect(attachment.content).toContain('data omitted')
    expect(attachment.path).toBe('/tmp/shot.png')
  })

  it('does not mutate the live session object', () => {
    const session = makeSession()
    dehydrateSessionForStorage(session)
    expect(session.messages[1].steps![0].toolCall).toBeTruthy()
    expect(session.messages[1].steps![0].partialResult).toBeTruthy()
    const attachment = (session.messages[1].toolCalls![0].result as { attachments: Array<{ content: string }> }).attachments[0]
    expect(attachment.content).toBe(base64)
  })

  it('keeps mid-stream partial results (only stripped of binaries)', () => {
    const session = makeSession()
    session.messages[1].steps![0].partialResultIsPartial = true as never
    const dehydrated = dehydrateSessionForStorage(session) as ReturnType<typeof makeSession>
    const partial = dehydrated.messages[1].steps![0].partialResult as { content: Array<{ type: string; text?: string; data?: string }> }
    expect(partial).toBeTruthy()
    expect(partial.content[0].text).toBe('[Image file: /tmp/shot.png]')
    expect(partial.content[1].data).toContain('data omitted')
  })
})

describe('dehydrateSessionForStorage — toolCall.changes round-trip fidelity (§13.17)', () => {
  // Legacy (2026-07) stepOnly form: changes live ONLY on steps[].toolCall,
  // the step is linked to a top-level toolCalls[] entry that has no changes.
  function makeStepOnlySession() {
    return {
      id: 's-steponly',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          toolCalls: [
            { id: 'tc1', toolId: 'edit', toolName: 'edit', arguments: {}, status: 'completed', result: 'ok' },
          ],
          steps: [
            {
              type: 'tool-call',
              toolCallId: 'tc1',
              toolCall: {
                id: 'tc1',
                toolId: 'edit',
                toolName: 'edit',
                arguments: {},
                status: 'completed',
                result: 'ok',
                changes: { hunks: [{ a: 1, b: 2 }], summary: 'edited' },
              },
            },
          ],
        },
      ],
    }
  }

  it('preserves changes through a stepOnly dehydrate→rehydrate (synthetic repro)', () => {
    const de = dehydrateSessionForStorage({ messages: [structuredClone(makeStepOnlySession().messages[0])] }) as any
    const re = rehydrateSessionFromStorage(structuredClone(de)) as any
    // Merged up to the canonical holder, and the redundant step copy dropped.
    expect(re.messages[0].toolCalls[0].changes).toEqual({ hunks: [{ a: 1, b: 2 }], summary: 'edited' })
    // rehydrate relinks step.toolCall to the top-level entry (same ref) →
    // renderer reading step.toolCall.changes gets it back.
    expect(re.messages[0].steps[0].toolCall?.changes).toEqual({ hunks: [{ a: 1, b: 2 }], summary: 'edited' })
    expect(re.messages[0].steps[0].toolCall).toBe(re.messages[0].toolCalls[0])
  })

  it('is idempotent: a second dehydrate is a byte-for-byte no-op', () => {
    const once = dehydrateSessionForStorage(makeStepOnlySession()) as any
    const twice = dehydrateSessionForStorage(structuredClone(once)) as any
    expect(JSON.stringify(twice)).toEqual(JSON.stringify(once))
    // The merged changes survive the second pass.
    expect(twice.messages[0].toolCalls[0].changes).toEqual({ hunks: [{ a: 1, b: 2 }], summary: 'edited' })
    expect(twice.messages[0].steps[0].toolCall).toBeUndefined()
  })

  it('does not overwrite an existing top-level changes (both-form: top wins)', () => {
    const session: any = {
      id: 's-both',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          toolCalls: [
            { id: 'tc1', toolName: 'edit', status: 'completed', result: 'ok', changes: { summary: 'TOP' } },
          ],
          steps: [
            {
              type: 'tool-call',
              toolCallId: 'tc1',
              toolCall: { id: 'tc1', toolName: 'edit', status: 'completed', result: 'ok', changes: { summary: 'STEP' } },
            },
          ],
        },
      ],
    }
    const de = dehydrateSessionForStorage(session) as any
    expect(de.messages[0].toolCalls[0].changes).toEqual({ summary: 'TOP' })
  })

  it('strips originalContent off merged changes (merge-then-strip order)', () => {
    const session: any = {
      id: 's-legacy-orig',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          toolCalls: [{ id: 'tc1', toolName: 'write', status: 'completed', result: 'ok' }],
          steps: [
            {
              type: 'tool-call',
              toolCallId: 'tc1',
              toolCall: {
                id: 'tc1',
                toolName: 'write',
                status: 'completed',
                result: 'ok',
                changes: { hunks: [{ a: 1 }], originalContent: 'x'.repeat(5000) },
              },
            },
          ],
        },
      ],
    }
    const de = dehydrateSessionForStorage(session) as any
    const changes = de.messages[0].toolCalls[0].changes
    expect(changes.hunks).toEqual([{ a: 1 }])
    expect(changes.originalContent).toBeUndefined()
  })

  it('keeps a stripped step.toolCall copy (with its changes) for an unlinked step', () => {
    // step.toolCallId does not match any top-level id → no merge, copy survives.
    const session: any = {
      id: 's-unlinked',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          toolCalls: [{ id: 'other', toolName: 'edit', status: 'completed', result: 'ok' }],
          steps: [
            {
              type: 'tool-call',
              toolCallId: 'orphan',
              toolCall: {
                id: 'orphan',
                toolName: 'edit',
                status: 'completed',
                result: 'ok',
                changes: { summary: 'kept' },
              },
            },
          ],
        },
      ],
    }
    const de = dehydrateSessionForStorage(session) as any
    expect(de.messages[0].steps[0].toolCall).toBeTruthy()
    expect(de.messages[0].steps[0].toolCall.changes).toEqual({ summary: 'kept' })
    // The unrelated top-level entry gets nothing merged.
    expect(de.messages[0].toolCalls[0].changes).toBeUndefined()
  })
})

describe('rehydrateSessionFromStorage', () => {
  it('restores step.toolCall link and rebuilds the final partialResult', () => {
    const stored = dehydrateSessionForStorage(makeSession())
    const session = rehydrateSessionFromStorage(JSON.parse(JSON.stringify(stored))) as ReturnType<typeof makeSession>
    const message = session.messages[1]
    const step = message.steps![0]

    expect(step.toolCall).toBe(message.toolCalls![0])
    expect(step.partialResult).toBeTruthy()
    expect(step.partialResultIsPartial).toBe(false)
    const parts = (step.partialResult as { content: Array<{ type: string; text?: string }> }).content
    expect(parts.some(part => part.type === 'text' && part.text?.includes('[Image file: /tmp/shot.png]'))).toBe(true)
  })

  it('round-trips already-hydrated sessions without harm', () => {
    const session = makeSession()
    const rehydrated = rehydrateSessionFromStorage(session)
    expect(rehydrated.messages[1].steps![0].toolCall?.id).toBe('tc1')
  })
})
