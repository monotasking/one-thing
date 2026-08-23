/**
 * OpenRouter 的图像输出(P3-2,设计稿 §5.1「图像输出」行 / §11 生图路由)。
 *
 * 三段链路各一组用例:
 *  1. **能力账本** —— openrouter 家 + `supportsImageOutput` ⇒
 *     `imageOutputServedBy: 'in-loop'`(不换通路,回普通流);
 *  2. **请求侧** —— 能出图才发 `modalities: ['text','image']`;
 *  3. **响应侧** —— `images[]` → `provider-data` 事件,再由 `provider-data.ts`
 *     落成一段正文。
 *
 * ⚠️ **流式 `delta.images` 在 OpenRouter 的 OpenAPI 里没有声明**。这里两种形状
 * (`delta.images` 与 `message.images`)的项都按**非流式** `message.images[]`
 * 的形状假定:`{ type:'image_url', image_url:{ url } }`,`url` 是 data URL。
 * **待真机核**。
 */
import { describe, expect, it, vi } from 'vitest'
import type { AgentTurnStreamEvent } from '@onething/core/agent-loop'
import { createAgentProviderFromRuntime } from '../../factory.js'
import {
  applyOnethingAgentLoopProviderData,
  planOnethingProviderDataPart,
} from '../../provider-data.js'
import { resolveOnethingModelCapabilities } from '../../../../providers/model-capability.js'

const IMAGE_MODEL = 'google/gemini-2.5-flash-image'
const TEXT_MODEL = 'openai/gpt-5.5'

const DATA_URL = 'data:image/png;base64,iVBORw0KGgo='

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

async function runOpenRouterTurn(model: string, body: string): Promise<StreamRun> {
  const bodies: Record<string, unknown>[] = []
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? 'null')))
    return sseResponse(body)
  }) as typeof globalThis.fetch

  const provider = createAgentProviderFromRuntime(
    'openrouter',
    {
      apiKey: 'sk-openrouter-test',
      model,
      models: { [IMAGE_MODEL]: { supportsImageOutput: true } },
    },
    { fetchImpl },
  )
  const events: AgentTurnStreamEvent[] = []
  for await (const event of provider!.streamTurn!({
    messages: [{ role: 'user', content: '画一轮月亮。' }],
    model,
    turn: 1,
  })) {
    events.push(event)
  }
  return { events, requestBody: bodies[0]! }
}

function providerDataEvents(events: AgentTurnStreamEvent[]): unknown[] {
  return events
    .filter(event => event.type === 'provider-data')
    .map(event => (event as { providerData: unknown }).providerData)
}

// ---------------------------------------------------------------------------
// 1. 能力账本
// ---------------------------------------------------------------------------

describe('openrouter image output — capability ledger', () => {
  it('serves image output in-loop (chat-completions returns the image itself)', () => {
    const resolved = resolveOnethingModelCapabilities({
      providerId: 'openrouter',
      modelId: IMAGE_MODEL,
      registryEntry: { supportsImageOutput: true },
    })
    expect(resolved.imageOutput).toBe(true)
    expect(resolved.imageOutputServedBy).toBe('in-loop')
  })

  it('leaves the dedicated image endpoints alone', () => {
    expect(
      resolveOnethingModelCapabilities({
        providerId: 'openai',
        modelId: 'gpt-image-1',
        registryEntry: { supportsImageOutput: true },
      }).imageOutputServedBy,
    ).toBe('dedicated-api')
  })

  it('says nothing for an openrouter model that cannot draw', () => {
    expect(
      resolveOnethingModelCapabilities({
        providerId: 'openrouter',
        modelId: TEXT_MODEL,
      }).imageOutputServedBy,
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 2. 请求侧
// ---------------------------------------------------------------------------

describe('openrouter image output — request body', () => {
  const MINIMAL = sse({
    choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
  })

  it('declares `modalities` for a model that draws in-loop', async () => {
    const { requestBody } = await runOpenRouterTurn(IMAGE_MODEL, MINIMAL)
    expect(requestBody.modalities).toEqual(['text', 'image'])
  })

  it('sends no extra byte for a text-only model', async () => {
    const { requestBody } = await runOpenRouterTurn(TEXT_MODEL, MINIMAL)
    expect(requestBody).not.toHaveProperty('modalities')
  })
})

// ---------------------------------------------------------------------------
// 3. 响应侧
// ---------------------------------------------------------------------------

describe('openrouter image output — stream decoding', () => {
  it('decodes `delta.images[]`', async () => {
    const { events } = await runOpenRouterTurn(
      IMAGE_MODEL,
      sse(
        {
          choices: [
            {
              index: 0,
              delta: {
                images: [{ type: 'image_url', image_url: { url: DATA_URL } }],
              },
            },
          ],
        },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ),
    )
    expect(providerDataEvents(events)).toEqual([
      {
        provider: 'openrouter',
        type: 'image-generation-result',
        callId: '1-img-0',
        status: 'completed',
        result: 'iVBORw0KGgo=',
        mediaType: 'image/png',
      },
    ])
  })

  it('decodes `message.images[]` (the non-streaming shape folded into a stream)', async () => {
    const { events } = await runOpenRouterTurn(
      IMAGE_MODEL,
      sse({
        choices: [
          {
            index: 0,
            message: {
              images: [{ type: 'image_url', image_url: { url: DATA_URL } }],
            },
            finish_reason: 'stop',
          },
        ],
      }),
    )
    expect(providerDataEvents(events)).toEqual([
      {
        provider: 'openrouter',
        type: 'image-generation-result',
        callId: '1-img-0',
        status: 'completed',
        result: 'iVBORw0KGgo=',
        mediaType: 'image/png',
      },
    ])
  })

  it('keeps an http URL as a URL (本期不下载)', async () => {
    const { events } = await runOpenRouterTurn(
      IMAGE_MODEL,
      sse({
        choices: [
          {
            index: 0,
            delta: {
              images: [
                {
                  type: 'image_url',
                  image_url: { url: 'https://cdn.example.com/moon.png' },
                },
              ],
            },
            finish_reason: 'stop',
          },
        ],
      }),
    )
    expect(providerDataEvents(events)).toEqual([
      {
        provider: 'openrouter',
        type: 'image-generation-result',
        callId: '1-img-0',
        status: 'completed',
        url: 'https://cdn.example.com/moon.png',
      },
    ])
  })

  it('numbers several images inside one turn', async () => {
    const { events } = await runOpenRouterTurn(
      IMAGE_MODEL,
      sse(
        {
          choices: [
            {
              index: 0,
              delta: {
                images: [{ type: 'image_url', image_url: { url: DATA_URL } }],
              },
            },
          ],
        },
        {
          choices: [
            {
              index: 0,
              delta: {
                images: [{ type: 'image_url', image_url: { url: DATA_URL } }],
              },
              finish_reason: 'stop',
            },
          ],
        },
      ),
    )
    expect(
      providerDataEvents(events).map(data => (data as { callId: string }).callId),
    ).toEqual(['1-img-0', '1-img-1'])
  })

  it('ignores a chunk with no image (and never guesses at an unknown url scheme)', async () => {
    const { events } = await runOpenRouterTurn(
      IMAGE_MODEL,
      sse(
        {
          choices: [
            {
              index: 0,
              delta: {
                content: 'hi',
                images: [{ type: 'image_url', image_url: { url: 'ftp://nope' } }],
              },
              finish_reason: 'stop',
            },
          ],
        },
      ),
    )
    expect(providerDataEvents(events)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 4. 落点(`provider-data.ts` 按 type 判,不按 provider 名判)
// ---------------------------------------------------------------------------

interface OrderedPart {
  type: string
  [key: string]: unknown
}

function applyOptions(providerData: Record<string, unknown>) {
  const orderedParts: OrderedPart[] = []
  const content = { value: '' }
  const saveMediaImage = vi.fn(async () => ({
    id: 'media_1',
    filePath: '/store/media/media_1.png',
    prompt: 'draw moon',
    revisedPrompt: 'better moon',
    model: IMAGE_MODEL,
    createdAt: 1,
  }))
  const notifyImageGenerated = vi.fn(async () => {})
  const sendContentPart = vi.fn()
  return {
    orderedParts,
    content,
    saveMediaImage,
    notifyImageGenerated,
    sendContentPart,
    options: {
      providerData,
      turnIndex: 1,
      model: IMAGE_MODEL,
      sessionId: 's1',
      messageId: 'm1',
      latestUserPrompt: 'draw moon',
      content,
      orderedParts,
      emitter: { sendContentPart },
      handleTextChunk: (delta: string) => {
        content.value += delta
        return content.value
      },
      saveMediaImage,
      notifyImageGenerated,
    },
  }
}

describe('openrouter image output — message placement', () => {
  it('plans a base64 result as message text, whatever the provider name is', () => {
    expect(
      planOnethingProviderDataPart({
        provider: 'openrouter',
        type: 'image-generation-result',
        result: 'iVBORw0KGgo=',
      }),
    ).toBe('text')
    expect(
      planOnethingProviderDataPart({
        provider: 'openrouter',
        type: 'image-generation-start',
      }),
    ).toBe('none')
    // 空事件:瞬态卡已经收了,消息上不留格。
    expect(
      planOnethingProviderDataPart({
        provider: 'openrouter',
        type: 'image-generation-result',
      }),
    ).toBe('none')
  })

  it('saves a base64 image into the media library and writes the markdown', async () => {
    const harness = applyOptions({
      provider: 'openrouter',
      type: 'image-generation-result',
      callId: '1-img-0',
      status: 'completed',
      result: 'iVBORw0KGgo=',
      mediaType: 'image/png',
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applied = await applyOnethingAgentLoopProviderData(harness.options as any)

    expect(applied).toBe(true)
    expect(harness.saveMediaImage).toHaveBeenCalledWith({
      base64: 'iVBORw0KGgo=',
      prompt: 'draw moon',
      revisedPrompt: undefined,
      model: IMAGE_MODEL,
      sessionId: 's1',
      messageId: 'm1',
    })
    expect(harness.orderedParts).toEqual([
      {
        type: 'text',
        content:
          '**Revised prompt:** better moon\n\n![Generated Image|mediaId:media_1](media://media_1.png)',
        turnIndex: 1,
      },
    ])
    expect(harness.notifyImageGenerated).toHaveBeenCalledWith(
      expect.objectContaining({ mediaId: 'media_1', sessionId: 's1' }),
    )
  })

  it('writes a plain markdown link for an http URL and never touches the media library', async () => {
    const harness = applyOptions({
      provider: 'openrouter',
      type: 'image-generation-result',
      callId: '1-img-0',
      status: 'completed',
      url: 'https://cdn.example.com/moon.png',
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applied = await applyOnethingAgentLoopProviderData(harness.options as any)

    expect(applied).toBe(true)
    expect(harness.saveMediaImage).not.toHaveBeenCalled()
    expect(harness.notifyImageGenerated).not.toHaveBeenCalled()
    expect(harness.orderedParts).toEqual([
      {
        type: 'text',
        content: '![Generated Image](https://cdn.example.com/moon.png)',
        turnIndex: 1,
      },
    ])
  })

  it('shows the transient loading card for a non-codex generation start', async () => {
    const harness = applyOptions({
      provider: 'openrouter',
      type: 'image-generation-start',
      callId: '1-img-0',
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const applied = await applyOnethingAgentLoopProviderData(harness.options as any)

    expect(applied).toBe(true)
    expect(harness.sendContentPart).toHaveBeenCalledWith({
      type: 'image-loading',
      turnIndex: 1,
      label: 'Generating image',
    })
    expect(harness.orderedParts).toEqual([])
  })
})
