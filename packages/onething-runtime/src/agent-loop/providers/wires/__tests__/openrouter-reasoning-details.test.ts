/**
 * OpenRouter 的 `reasoning_details[]` 原样回传(P3-4,设计稿 §5.1「思维链字段/
 * 回传」行 / §12)。
 *
 * 官方口径只有一句:**多轮 / 工具调用必须把整段连续的 `reasoning_details`
 * 原样送回,顺序不可改**。所以这一批用例守的是「原样」的四个面:
 *
 *  1. **解析** —— `delta.reasoning_details[]` 与被折进流里的
 *     `message.reasoning_details[]` 两种落点都认,一块内多项合成一条事件、
 *     块内顺序不动,项的全部字段一个不解释、一个不丢;文字增量
 *     (`reasoning` / `reasoning_content`)照旧走 `reasoning-delta`,两条线并存。
 *  2. **落点** —— 非 codex 的 provider-data 落一格 `'provider-data'`
 *     (`planOnethingProviderDataPart`),与 codex 的 `encrypted-reasoning` 同一格。
 *  3. **重建** —— 消息上那一格经 `getHistoryProviderData` +
 *     `providerDataFromOnethingContentPart` 摊回 `AgentMessage.providerData[]`,
 *     于是重建出来的历史照样回传得出去(codex 的加密思维链走的正是这条路)。
 *  4. **回传** —— 跨条 providerData 按声明顺序摊平;`reasoning_content` 与
 *     `reasoning_details` 并存;**只有 openrouter 配方写这个字段**,换家时那些
 *     details 自然不回传(它们挂在 `provider:'openrouter'` 名下)。
 */
import { describe, expect, it } from 'vitest'
import type {
  AgentJsonValue,
  AgentMessage,
  AgentTurnStreamEvent,
} from '@onething/core/agent-loop'
import { getHistoryProviderData } from '@onething/core/engine'
import { createAgentProviderFromRuntime } from '../../factory.js'
import { planOnethingProviderDataPart, providerDataFromOnethingContentPart } from '../../provider-data.js'
import { OpenAIChatPartCodec, openRouterReasoningDetails } from '../openai-chat-messages.js'

const MODEL = 'openai/gpt-5.5'

const ENCRYPTED = {
  type: 'reasoning.encrypted',
  id: 'rs_1',
  index: 0,
  format: 'openai-responses-v1',
  data: 'ENCRYPTED-PAYLOAD-1',
} as const

const TEXT = {
  type: 'reasoning.text',
  id: 'rs_2',
  index: 1,
  format: 'unknown',
  text: '再决定读哪个文件。',
  signature: 'sig-2',
} as const

function sse(...chunks: unknown[]): string {
  return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
}

function sseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

interface StreamRun {
  events: AgentTurnStreamEvent[]
  requestBody: Record<string, unknown>
}

async function runTurn(
  providerId: string,
  body: string,
  messages: AgentMessage[] = [{ role: 'user', content: '读一下 a.txt。' }],
): Promise<StreamRun> {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? 'null')))
    return sseResponse(body)
  }) as typeof globalThis.fetch

  const provider = createAgentProviderFromRuntime(
    providerId,
    { apiKey: `sk-${providerId}-test`, model: MODEL },
    { fetchImpl },
  )
  const events: AgentTurnStreamEvent[] = []
  for await (const event of provider!.streamTurn!({ messages, model: MODEL, turn: 1 })) {
    events.push(event)
  }
  return { events, requestBody: bodies[0]! }
}

const MINIMAL = sse({
  choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
})

function providerDataEvents(events: AgentTurnStreamEvent[]): unknown[] {
  return events
    .filter(event => event.type === 'provider-data')
    .map(event => (event as { providerData: unknown }).providerData)
}

function assistantMessage(requestBody: Record<string, unknown>): Record<string, unknown> {
  const messages = requestBody.messages as Array<Record<string, unknown>>
  return messages.find(message => message.role === 'assistant')!
}

// ---------------------------------------------------------------------------
// 1. 解析
// ---------------------------------------------------------------------------

describe('openrouter reasoning_details — stream decoding', () => {
  it('decodes `delta.reasoning_details[]`', async () => {
    const { events } = await runTurn(
      'openrouter',
      sse(
        { choices: [{ index: 0, delta: { reasoning_details: [ENCRYPTED] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ),
    )
    expect(providerDataEvents(events)).toEqual([
      { provider: 'openrouter', type: 'reasoning-details', details: [ENCRYPTED] },
    ])
  })

  it('decodes `message.reasoning_details[]` (the non-streaming shape folded into a stream)', async () => {
    const { events } = await runTurn(
      'openrouter',
      sse({
        choices: [
          { index: 0, message: { reasoning_details: [TEXT] }, finish_reason: 'stop' },
        ],
      }),
    )
    expect(providerDataEvents(events)).toEqual([
      { provider: 'openrouter', type: 'reasoning-details', details: [TEXT] },
    ])
  })

  it('keeps several items of one chunk in one event, in order', async () => {
    const { events } = await runTurn(
      'openrouter',
      sse({
        choices: [
          {
            index: 0,
            delta: { reasoning_details: [ENCRYPTED, TEXT] },
            finish_reason: 'stop',
          },
        ],
      }),
    )
    expect(providerDataEvents(events)).toEqual([
      { provider: 'openrouter', type: 'reasoning-details', details: [ENCRYPTED, TEXT] },
    ])
  })

  it('leaves the text delta alone — `reasoning` still becomes a reasoning-delta', async () => {
    const { events } = await runTurn(
      'openrouter',
      sse({
        choices: [
          {
            index: 0,
            delta: { reasoning: '先看一眼目录。', reasoning_details: [ENCRYPTED] },
            finish_reason: 'stop',
          },
        ],
      }),
    )
    expect(events.filter(event => event.type === 'reasoning-delta')).toEqual([
      { type: 'reasoning-delta', turn: 1, delta: '先看一眼目录。' },
    ])
    expect(providerDataEvents(events)).toHaveLength(1)
  })

  it('says nothing for a chunk without details (and never invents an item out of a non-object)', async () => {
    const { events } = await runTurn(
      'openrouter',
      sse({
        choices: [
          {
            index: 0,
            delta: { content: 'hi', reasoning_details: ['not-an-object', null, 42] },
            finish_reason: 'stop',
          },
        ],
      }),
    )
    expect(providerDataEvents(events)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 2. 落点
// ---------------------------------------------------------------------------

describe('openrouter reasoning_details — message placement', () => {
  it('plans one `provider-data` slot, same as codex encrypted reasoning', () => {
    expect(
      planOnethingProviderDataPart({
        provider: 'openrouter',
        type: 'reasoning-details',
        details: [ENCRYPTED],
      }),
    ).toBe('provider-data')
    expect(
      planOnethingProviderDataPart({
        provider: 'codex',
        type: 'encrypted-reasoning',
        encryptedContent: 'ENC',
      }),
    ).toBe('provider-data')
  })
})

// ---------------------------------------------------------------------------
// 3. 重建
// ---------------------------------------------------------------------------

describe('openrouter reasoning_details — history rebuild', () => {
  it('survives the content-part → providerData[] rebuild', () => {
    const rebuilt = getHistoryProviderData(
      {
        id: 'm1',
        role: 'assistant',
        content: '我先读一下这个文件。',
        contentParts: [
          { type: 'text', content: '我先读一下这个文件。', turnIndex: 1 },
          {
            type: 'provider-data',
            providerData: {
              provider: 'openrouter',
              type: 'reasoning-details',
              details: [ENCRYPTED],
            },
            turnIndex: 1,
          },
          {
            type: 'provider-data',
            providerData: {
              provider: 'openrouter',
              type: 'reasoning-details',
              details: [TEXT],
            },
            turnIndex: 1,
          },
        ],
      },
      { providerDataFromContentPart: providerDataFromOnethingContentPart },
    )

    expect(rebuilt).toHaveLength(2)
    // 重建出来的历史照样回传得出去 —— 与直播那条路读的是同一个数组。
    expect(
      openRouterReasoningDetails({
        role: 'assistant',
        content: '我先读一下这个文件。',
        providerData: rebuilt,
      }),
    ).toEqual([ENCRYPTED, TEXT])
  })
})

// ---------------------------------------------------------------------------
// 4. 回传
// ---------------------------------------------------------------------------

const HISTORY: AgentMessage[] = [
  { role: 'user', content: '读一下 a.txt。' },
  {
    role: 'assistant',
    content: '我先读一下这个文件。',
    reasoningContent: '先确认文件存在。',
    providerData: [
      { provider: 'openrouter', type: 'reasoning-details', details: [ENCRYPTED] },
      { provider: 'openrouter', type: 'reasoning-details', details: [TEXT] },
    ],
    toolCalls: [{ id: 'call_read', name: 'read_file', arguments: '{"path":"a.txt"}' }],
  },
  { role: 'tool', toolCallId: 'call_read', content: 'hello from a.txt' },
  { role: 'user', content: '总结一下。' },
]

describe('openrouter reasoning_details — replay', () => {
  it('replays every item in declaration order, with every field intact', async () => {
    const { requestBody } = await runTurn('openrouter', MINIMAL, HISTORY)
    expect(assistantMessage(requestBody).reasoning_details).toEqual([ENCRYPTED, TEXT])
  })

  it('never touches another family — the details ride under `provider:"openrouter"`', async () => {
    // 同一条线(openai-chat)上的别家。xAI 的两条通路 P4-4 起在
    // openai-responses 上,请求体里根本没有 `messages` 这个键 —— 这里换成
    // `qwen` 保持「另一家」的对照,跨线协议的对照由快照套件覆盖。
    for (const providerId of ['openai', 'kimi', 'deepseek', 'qwen']) {
      const { requestBody } = await runTurn(providerId, MINIMAL, HISTORY)
      expect(assistantMessage(requestBody)).not.toHaveProperty('reasoning_details')
    }
  })

  it('coexists with `reasoning_content` (they are two things, not a choice)', () => {
    const codec = new OpenAIChatPartCodec({
      includeAssistantReasoning: true,
      replayReasoningDetails: true,
    })
    expect(codec.assistant(HISTORY[1]!)[0]).toMatchObject({
      role: 'assistant',
      reasoning_content: '先确认文件存在。',
      reasoning_details: [ENCRYPTED, TEXT],
    })
  })

  it('writes no field at all when the message carries no details', () => {
    const codec = new OpenAIChatPartCodec({ replayReasoningDetails: true })
    expect(codec.assistant({ role: 'assistant', content: 'hi' })[0]).not.toHaveProperty(
      'reasoning_details',
    )
    // 别家的 provider-data 不算数(只认 provider:'openrouter' + reasoning-details)。
    expect(
      openRouterReasoningDetails({
        role: 'assistant',
        content: 'hi',
        providerData: [
          { provider: 'codex', type: 'encrypted-reasoning', encryptedContent: 'ENC' },
          { provider: 'openrouter', type: 'image-generation-result', result: 'x' },
        ],
      }) satisfies AgentJsonValue[],
    ).toEqual([])
  })
})
