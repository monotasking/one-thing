import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TOC_INPUT_TOKEN_BUDGET,
  buildTocPrompt,
  sampleHeadAndTail,
  shouldIncludeReasoning,
} from '../input.js'
import { isTrivialTurn, parseTocDecision } from '../decide.js'
import { applyTurnDecision, openSegmentOf } from '../apply.js'
import type { SessionSegment } from '../types.js'

function segment(overrides: Partial<SessionSegment> & { id: string }): SessionSegment {
  return {
    origin: 'inferred',
    kind: 'task',
    title: 'a segment',
    detail: '',
    files: [],
    startedAt: 0,
    turnCount: 1,
    revision: 0,
    ...overrides,
  }
}

describe('isTrivialTurn', () => {
  it('skips an acknowledgement that did no work', () => {
    expect(isTrivialTurn({ userMessage: 'ok thanks', toolIterations: 0, fileCount: 0 })).toBe(true)
  })

  it('never skips a turn that ran tools or changed files', () => {
    expect(isTrivialTurn({ userMessage: 'go', toolIterations: 3, fileCount: 0 })).toBe(false)
    expect(isTrivialTurn({ userMessage: 'go', toolIterations: 0, fileCount: 2 })).toBe(false)
  })

  it('never skips a substantial message even with no tool work', () => {
    expect(isTrivialTurn({
      userMessage: 'I think the whole approach here is wrong, we should reconsider the storage shape',
      toolIterations: 0,
      fileCount: 0,
    })).toBe(false)
  })
})

describe('shouldIncludeReasoning', () => {
  it('withholds reasoning when the user message already states the intent', () => {
    const longMessage = 'Please refactor the goal storage so finished goals are kept as history instead of being overwritten'
    expect(shouldIncludeReasoning(longMessage, 'lots of thinking')).toBe(false)
  })

  it('includes reasoning for a terse message, where the intent lives elsewhere', () => {
    expect(shouldIncludeReasoning('continue', 'lots of thinking')).toBe(true)
    expect(shouldIncludeReasoning("that's wrong", 'lots of thinking')).toBe(true)
  })

  it('does nothing when there is no reasoning to include', () => {
    expect(shouldIncludeReasoning('continue', undefined)).toBe(false)
    expect(shouldIncludeReasoning('continue', '   ')).toBe(false)
  })
})

describe('sampleHeadAndTail', () => {
  it('returns short text untouched', () => {
    expect(sampleHeadAndTail('short', 100)).toBe('short')
  })

  it('keeps both ends and marks the gap', () => {
    const text = `${'A'.repeat(500)}${'B'.repeat(500)}`
    const sampled = sampleHeadAndTail(text, 200)

    expect(sampled.length).toBeLessThanOrEqual(200)
    expect(sampled.startsWith('A')).toBe(true)
    expect(sampled.endsWith('B')).toBe(true)
    // The elision is marked so the model does not read it as continuous.
    expect(sampled).toContain('chars omitted')
  })

  it('favours the head, where the intent is stated', () => {
    const text = `${'A'.repeat(1000)}${'B'.repeat(1000)}`
    const sampled = sampleHeadAndTail(text, 400)
    const heads = (sampled.match(/A/g) ?? []).length
    const tails = (sampled.match(/B/g) ?? []).length
    expect(heads).toBeGreaterThan(tails)
  })
})

describe('buildTocPrompt', () => {
  it('holds the budget even against an enormous chain of thought', () => {
    // The whole point of the priority order: a 200k-char reasoning trace must
    // not be able to move the ceiling.
    const built = buildTocPrompt({
      userMessage: 'continue',
      assistantReply: 'done',
      reasoning: 'X'.repeat(200_000),
      files: ['a.ts'],
    })

    expect(built.estimatedTokens).toBeLessThanOrEqual(DEFAULT_TOC_INPUT_TOKEN_BUDGET)
    expect(built.includedReasoning).toBe(true)
  })

  it('omits reasoning entirely for a self-explanatory message', () => {
    const built = buildTocPrompt({
      userMessage: 'Please rework the goal storage so finished goals become history rather than being overwritten',
      reasoning: 'X'.repeat(50_000),
      files: [],
    })

    expect(built.includedReasoning).toBe(false)
    expect(built.text).not.toContain('assistant_reasoning')
  })

  it('always keeps the user message and the file facts', () => {
    const built = buildTocPrompt({
      userMessage: 'fix the parser',
      files: ['src/parser.ts', 'src/lexer.ts'],
    })

    expect(built.text).toContain('fix the parser')
    expect(built.text).toContain('src/parser.ts')
  })

  it('carries the current segment so the model can judge update vs new', () => {
    const built = buildTocPrompt({
      userMessage: 'keep going',
      files: [],
      currentSegment: { title: 'Fix the parser', detail: 'off-by-one in the lexer', kind: 'task' },
    })

    expect(built.text).toContain('Fix the parser')
  })

  it('flags when this turn shares no file with the current segment', () => {
    // Models lean hard toward `update`; a disjoint file set is the cheapest
    // evidence available that the work actually moved on.
    const built = buildTocPrompt({
      userMessage: 'now fix the sidebar',
      files: ['src/Sidebar.vue'],
      currentSegment: {
        title: 'Fix the parser',
        detail: '',
        kind: 'task',
        files: ['src/parser.ts'],
      },
    })

    expect(built.text).toContain('file_overlap')
  })

  it('stays silent about overlap when the turn shares a file', () => {
    const built = buildTocPrompt({
      userMessage: 'keep going',
      files: ['src/parser.ts', 'src/lexer.ts'],
      currentSegment: {
        title: 'Fix the parser',
        detail: '',
        kind: 'task',
        files: ['src/parser.ts'],
      },
    })

    expect(built.text).not.toContain('file_overlap')
  })

  it('stays silent when either side touched nothing — absence is not evidence', () => {
    const noFilesThisTurn = buildTocPrompt({
      userMessage: 'what do you think?',
      files: [],
      currentSegment: { title: 'Fix the parser', detail: '', kind: 'task', files: ['a.ts'] },
    })
    const segmentHasNoFiles = buildTocPrompt({
      userMessage: 'now fix the sidebar',
      files: ['b.ts'],
      currentSegment: { title: 'A discussion', detail: '', kind: 'question', files: [] },
    })

    expect(noFilesThisTurn.text).not.toContain('file_overlap')
    expect(segmentHasNoFiles.text).not.toContain('file_overlap')
  })

  it('keeps the tail of a long reply, where the conclusion is', () => {
    const built = buildTocPrompt({
      userMessage: 'x'.repeat(200),
      assistantReply: `${'A'.repeat(5000)}FINAL_CONCLUSION`,
      files: [],
    })

    expect(built.text).toContain('FINAL_CONCLUSION')
  })
})

describe('parseTocDecision', () => {
  it('parses a well-formed decision', () => {
    const decision = parseTocDecision(
      '{"action":"new","kind":"task","title":"Fix rename","detail":"Space was swallowed."}',
      { hasCurrentSegment: false },
    )
    expect(decision).toEqual({
      action: 'new',
      kind: 'task',
      title: 'Fix rename',
      detail: 'Space was swallowed.',
    })
  })

  it('tolerates prose or a code fence around the JSON', () => {
    const decision = parseTocDecision(
      'Sure!\n```json\n{"action":"skip"}\n```',
      { hasCurrentSegment: true },
    )
    expect(decision?.action).toBe('skip')
  })

  it('turns an update with nothing to update into opening a segment', () => {
    const decision = parseTocDecision('{"action":"update","title":"First bit of work"}', {
      hasCurrentSegment: false,
    })
    expect(decision?.action).toBe('new')
  })

  it('gives up on malformed output rather than inventing a segment', () => {
    expect(parseTocDecision('no json at all', { hasCurrentSegment: true })).toBeUndefined()
    expect(parseTocDecision('{broken', { hasCurrentSegment: true })).toBeUndefined()
    // A titleless segment renders as a blank row the user cannot act on.
    expect(parseTocDecision('{"action":"new","title":"  "}', { hasCurrentSegment: false }))
      .toBeUndefined()
  })

  it('takes the first complete object when a model adds prose or a second one', () => {
    // Small models routinely narrate, fence the answer, or tack on an example.
    // Spanning first-brace to last-brace swallows all of it and parses to
    // nothing — throwing away an answer that was right there.
    const decision = parseTocDecision(
      'Here is my answer:\n{"action":"new","title":"Real answer"}\nFor example: {"action":"skip"}',
      { hasCurrentSegment: false },
    )
    expect(decision?.title).toBe('Real answer')
  })

  it('is not fooled by braces inside a string', () => {
    const decision = parseTocDecision(
      '{"action":"new","title":"Fix the {curly} parser","detail":"}"}',
      { hasCurrentSegment: false },
    )
    expect(decision?.title).toBe('Fix the {curly} parser')
  })

  it('rejects a truncated object rather than half-parsing it', () => {
    expect(parseTocDecision('{"action":"new","title":"cut off', { hasCurrentSegment: true }))
      .toBeUndefined()
  })

  it('clamps an over-long title', () => {
    const decision = parseTocDecision(
      JSON.stringify({ action: 'new', title: 'T'.repeat(500) }),
      { hasCurrentSegment: false },
    )
    expect(decision!.title.length).toBeLessThanOrEqual(72)
  })
})

describe('applyTurnDecision', () => {
  const base = { messageId: 'm2', timestamp: 5000, newSegmentId: 'seg-new' }

  it('overwrites the description on update rather than appending', () => {
    const segments = [segment({ id: 's1', title: 'Old reading', detail: 'first impression' })]
    const next = applyTurnDecision(segments, {
      ...base,
      decision: { action: 'update', kind: 'task', title: 'What it turned out to be', detail: 'the real cause' },
      files: [{ path: 'a.ts', added: 2, removed: 1 }],
    })

    expect(next[0]?.title).toBe('What it turned out to be')
    expect(next[0]?.detail).toBe('the real cause')
    expect(next[0]?.revision).toBe(1)
    expect(next[0]?.turnCount).toBe(2)
    expect(next[0]?.endMessageId).toBe('m2')
  })

  it('opens a new segment and leaves the previous one closed', () => {
    const segments = [segment({ id: 's1', title: 'First job' })]
    const next = applyTurnDecision(segments, {
      ...base,
      decision: { action: 'new', kind: 'task', title: 'Second job', detail: '' },
      files: [],
    })

    expect(next).toHaveLength(2)
    expect(next[0]?.title).toBe('First job')
    expect(next[1]).toMatchObject({ id: 'seg-new', title: 'Second job', turnCount: 1 })
  })

  it('records a skipped turn against the segment without changing its description', () => {
    const segments = [segment({ id: 's1', title: 'Keep me', detail: 'keep this too', revision: 3 })]
    const next = applyTurnDecision(segments, {
      ...base,
      decision: { action: 'skip', kind: 'task', title: '', detail: '' },
      files: [{ path: 'a.ts', added: 1, removed: 0 }],
    })

    expect(next[0]?.title).toBe('Keep me')
    expect(next[0]?.detail).toBe('keep this too')
    expect(next[0]?.revision).toBe(3)
    // The turn still happened: churn and the end anchor move.
    expect(next[0]?.turnCount).toBe(2)
    expect(next[0]?.files).toEqual([{ path: 'a.ts', added: 1, removed: 0 }])
  })

  it('sums file churn across turns of one segment', () => {
    const segments = [segment({ id: 's1', files: [{ path: 'a.ts', added: 1, removed: 1 }] })]
    const next = applyTurnDecision(segments, {
      ...base,
      decision: { action: 'update', kind: 'task', title: 'still going', detail: '' },
      files: [{ path: 'a.ts', added: 2, removed: 0 }, { path: 'b.ts', added: 5, removed: 0 }],
    })

    expect(next[0]?.files).toEqual([
      { path: 'a.ts', added: 3, removed: 1 },
      { path: 'b.ts', added: 5, removed: 0 },
    ])
  })
})

describe('openSegmentOf', () => {
  it('never extends a goal-backed segment', () => {
    // Goal segments mirror a finished goal record; extending one would make
    // the projection disagree with the goal it came from.
    const segments = [
      segment({ id: 's1' }),
      segment({ id: 'goal:g1', origin: 'goal', goalId: 'g1' }),
    ]
    expect(openSegmentOf(segments)?.id).toBe('s1')
  })

  it('returns undefined when there is nothing inferred yet', () => {
    expect(openSegmentOf([segment({ id: 'goal:g1', origin: 'goal' })])).toBeUndefined()
    expect(openSegmentOf([])).toBeUndefined()
  })
  it('never exceeds the ceiling across a sweep of budgets and input sizes', () => {
    // The budget is the whole cost story; a single hand-picked case is not
    // enough evidence that it holds.
    const budgets = [500, 1000, 3000, 8000]
    const reasoningSizes = [0, 100, 5_000, 200_000]
    const replySizes = [0, 200, 50_000]

    for (const tokenBudget of budgets) {
      for (const reasoningSize of reasoningSizes) {
        for (const replySize of replySizes) {
          const built = buildTocPrompt({
            userMessage: 'go',
            assistantReply: 'R'.repeat(replySize),
            reasoning: 'T'.repeat(reasoningSize),
            files: Array.from({ length: 60 }, (_, i) => `src/file-${i}.ts`),
            currentSegment: { title: 'T'.repeat(72), detail: 'D'.repeat(240), kind: 'task' },
          }, { tokenBudget })

          expect(
            built.estimatedTokens,
            `budget=${tokenBudget} reasoning=${reasoningSize} reply=${replySize}`,
          ).toBeLessThanOrEqual(tokenBudget)
        }
      }
    }
  })
})
