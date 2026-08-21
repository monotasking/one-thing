/**
 * Guards on the segmentation call itself.
 *
 * The first field failure here was silent and expensive: thinking was left to
 * the provider default, so deepseek-v4-flash spent the entire output budget in
 * the reasoning channel and returned "". Nothing threw, nothing was written,
 * and every turn still billed for it. These tests pin the parameters that
 * failure came down to, and the early-exit paths that must stay quiet but
 * traceable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collectLogRecordsForTests } from '../../logging/index.js'

const mocks = vi.hoisted(() => ({
  runAgentLoop: vi.fn(async (_options: Record<string, unknown>) => ({
    text: '{"action":"new","kind":"task","title":"Fix the parser","detail":"off-by-one"}',
    usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130 },
    toolResults: [],
  })),
  createUtilityProvider: vi.fn(async () => ({
    provider: {} as never,
    providerId: 'deepseek',
    model: 'deepseek-v4-flash',
    thinking: undefined as boolean | undefined,
  })),
  append: vi.fn(async () => {}),
  read: vi.fn(async () => [] as unknown[]),
  billTocUsage: vi.fn(() => vi.fn()),
}))

vi.mock('@onething/core/agent-loop', () => ({ runAgentLoop: mocks.runAgentLoop }))
vi.mock('../../../providers/utility-provider.js', () => ({
  createUtilityProvider: mocks.createUtilityProvider,
}))
vi.mock('../../../stores/settings.js', () => ({ getSettings: () => ({}) }))
vi.mock('@onething/runtime/storage', () => ({ getOnethingSessionsDir: () => '/tmp/toc-test' }))
vi.mock('../../usage/bill-side-line.js', () => ({ billTocUsage: mocks.billTocUsage }))
vi.mock('@onething/runtime/toc', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    createSessionSegmentStore: () => ({
      read: mocks.read,
      append: mocks.append,
      rewrite: vi.fn(),
      clear: vi.fn(),
      segmentsPath: () => '/tmp/toc-test/s1/segments.jsonl',
    }),
  }
})

const { recordTocTurn } = await import('../index.js')

function turn(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    assistantMessageId: 'a1',
    // Long enough and with file changes, so the free skip gate lets it through.
    userMessage: 'Please rework the goal storage so finished goals become history',
    assistantReply: 'Done, goals now accumulate.',
    toolIterations: 3,
    files: [{ path: 'a.ts', added: 2, removed: 1 }],
    timestamp: 5000,
    ...overrides,
  }
}

let logs: ReturnType<typeof collectLogRecordsForTests>

beforeEach(() => {
  vi.clearAllMocks()
  mocks.read.mockResolvedValue([])
  mocks.billTocUsage.mockReturnValue(vi.fn())
  // 每一次早退都说明理由 —— 迁移后那句理由是 `fields.detail`,不再是 console 行。
  logs = collectLogRecordsForTests()
})

afterEach(() => {
  logs.stop()
})

function loggedLines(): string {
  return logs.records.map(record => String(record.fields?.detail ?? record.msg)).join('\n')
}

describe('recordTocTurn model call', () => {
  it('disables thinking explicitly rather than inheriting the provider default', async () => {
    await recordTocTurn(turn() as never)

    const options = mocks.runAgentLoop.mock.calls[0]?.[0]
    expect(options?.thinking).toBe('disabled')
  })

  it('keeps thinking off even when the tool-call model has it switched on', async () => {
    // The toggle governs the user's own chat; a hybrid reasoner answering with
    // an empty string here is worse than one that never reasons.
    mocks.createUtilityProvider.mockResolvedValueOnce({
      provider: {} as never,
      providerId: 'deepseek',
      model: 'deepseek-v4-flash',
      thinking: true,
    })

    await recordTocTurn(turn() as never)
    expect(mocks.runAgentLoop.mock.calls[0]?.[0]?.thinking).toBe('disabled')
  })

  it('leaves room to answer even if a provider ignores the flag', async () => {
    await recordTocTurn(turn() as never)
    expect(mocks.runAgentLoop.mock.calls[0]?.[0]?.maxTokens).toBeGreaterThanOrEqual(400)
  })

  it('writes the segment and bills the call on a good reply', async () => {
    const written = await recordTocTurn(turn() as never)

    expect(mocks.append).toHaveBeenCalledTimes(1)
    expect(written?.[0]).toMatchObject({ title: 'Fix the parser', origin: 'inferred' })
    expect(mocks.billTocUsage).toHaveBeenCalledWith('deepseek', 'deepseek-v4-flash', 's1')
  })
})

describe('recordTocTurn early exits', () => {
  it('says why when the reply is empty instead of failing silently', async () => {
    // The exact field failure: no throw, no file, and previously no trace.
    mocks.runAgentLoop.mockResolvedValueOnce({
      text: '',
      usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
      toolResults: [],
    })

    const written = await recordTocTurn(turn() as never)

    expect(written).toBeUndefined()
    expect(mocks.append).not.toHaveBeenCalled()
    expect(loggedLines()).toContain('unparseable reply')
  })

  it('skips a slight turn for free, without reaching the model', async () => {
    const written = await recordTocTurn(
      turn({ userMessage: 'ok', toolIterations: 0, files: [] }) as never,
    )

    expect(written).toBeUndefined()
    expect(mocks.runAgentLoop).not.toHaveBeenCalled()
    expect(loggedLines()).toContain('too slight')
  })

  it('reports the feature being unconfigured rather than looking broken', async () => {
    mocks.createUtilityProvider.mockResolvedValueOnce(undefined as never)

    await recordTocTurn(turn() as never)

    expect(mocks.runAgentLoop).not.toHaveBeenCalled()
    expect(loggedLines()).toContain('no tool-call model configured')
  })

  it('does not let a provider failure escape to the trigger', async () => {
    mocks.runAgentLoop.mockRejectedValueOnce(new Error('provider exploded'))

    await expect(recordTocTurn(turn() as never)).resolves.toBeUndefined()
    expect(loggedLines()).toContain('model call failed')
  })
})
