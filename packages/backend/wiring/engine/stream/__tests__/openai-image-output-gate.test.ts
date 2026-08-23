/**
 * 拍板 #13 的**两道闸合起来**跑一遍:账本 → 引擎闸 → 线上的工具表。
 *
 * 两份单测各守一半 —— `providers/__tests__/model-capability.test.ts` 守账本
 * (「gpt-5.5 有原生出图工具」),`__tests__/wire-snapshots/.../openai/
 * image-output.request.json` 守方言(「`requestedOutputModalities` 含 image ⇒
 * 工具表多一项」)。这份守的是**中间那一段**:引擎真的会把账本的裁定填进
 * `requestedOutputModalities`,而 provider 真的会因此在 `/v1/responses` 的
 * 请求体里长出 `{type:'image_generation'}`。
 *
 * 闸门的账本一侧**不打桩**:`modelServesImageOutputInLoop` 直连真正的
 * `onethingModelServesImageOutputInLoop`,所以「官方支持表」这条事实是真的被
 * 问了一次,不是被 mock 编出来的。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultSettings } from '@shared/defaults/settings.js'
import type { ToolSettings } from '@shared/ipc.js'
import type { AgentOutputModality, AgentTurnStreamEvent } from '@onething/core/agent-loop'
import { createAgentProviderFromRuntime } from '@onething/runtime/agent-loop/providers'
import {
  onethingModelServesImageOutputInLoop,
} from '@onething/runtime/providers'
import type { StreamSender } from '../stream-processor.js'
import type { ProviderConfigWithKey, StreamExecutionParams } from '../stream-executor.js'

interface CapturedStreamContext {
  requestedOutputModalities?: AgentOutputModality[]
}

const mocks = vi.hoisted(() => ({
  engine: {
    registerController: vi.fn(),
    removeController: vi.fn(),
    getSteeringQueue: vi.fn(() => undefined),
    getFollowUpQueue: vi.fn(() => undefined),
  },
  executeAgentLoopStreamGeneration: vi.fn(
    async (_context: unknown, _history: unknown, _sessionName?: string) =>
      ({ pausedForConfirmation: false }),
  ),
}))

vi.mock('../../../providers/model-registry.js', () => ({
  modelSupportsImageGeneration: vi.fn(async () => false),
  // 账本一侧是真的 —— 没有 provider 配置就让它只读内置规则表。
  modelServesImageOutputInLoop: (modelId: string, providerId?: string) =>
    onethingModelServesImageOutputInLoop(undefined, modelId, providerId),
  modelSupportsTools: vi.fn(async () => true),
  getModelById: vi.fn(async () => undefined),
}))

vi.mock('../image-stream.js', () => ({
  processImageGenerationStream: vi.fn(async () => true),
}))

vi.mock('../agent-loop-executor.js', () => ({
  executeAgentLoopStreamGeneration: mocks.executeAgentLoopStreamGeneration,
}))

vi.mock('../../index.js', () => ({
  getStreamEngine: () => mocks.engine,
}))

const { executeMessageStream } = await import('../stream-executor.js')

const sender: StreamSender = { isDestroyed: () => false, send: vi.fn() }

const toolSettings: ToolSettings = { enableToolCalls: true, tools: {} }

function params(model: string, providerId = 'openai'): StreamExecutionParams {
  const configWithApiKey: ProviderConfigWithKey = {
    apiKey: 'sk-openai',
    model,
    selectedModels: [model],
  }
  return {
    sender,
    sessionId: 's1',
    assistantMessageId: 'm1',
    messageContent: 'draw me an icon',
    historyMessages: [{ role: 'user', content: 'draw me an icon' }],
    configWithApiKey,
    providerId,
    settings: createDefaultSettings(),
    toolSettings,
    sessionName: 'Session',
  }
}

/** 引擎闸的产物 —— 这一回合到底向 provider 要了什么模态。 */
async function requestedModalities(
  model: string,
  providerId = 'openai',
): Promise<AgentOutputModality[] | undefined> {
  mocks.executeAgentLoopStreamGeneration.mockClear()
  await executeMessageStream(params(model, providerId))
  const context = mocks.executeAgentLoopStreamGeneration.mock.calls[0]?.[0] as
    | CapturedStreamContext
    | undefined
  return context?.requestedOutputModalities
}

const COMPLETED_SSE = `event: response.completed\ndata: ${JSON.stringify({
  type: 'response.completed',
  response: { id: 'resp_1', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
})}\n\n`

/** provider 一侧 —— 真的 `openai` 方言,桩 fetch,只看发出去的请求体。 */
async function wireToolsFor(
  model: string,
  modalities: AgentOutputModality[] | undefined,
): Promise<Array<Record<string, unknown>>> {
  let body: { tools?: Array<Record<string, unknown>> } = {}
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? '{}')) as typeof body
    return new Response(COMPLETED_SSE, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof globalThis.fetch

  const provider = createAgentProviderFromRuntime('openai', { apiKey: 'sk-openai', model }, {
    fetchImpl,
  })
  const events: AgentTurnStreamEvent[] = []
  for await (const event of provider!.streamTurn!({
    model,
    messages: [{ role: 'user', content: 'draw me an icon' }],
    tools: [{
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async () => ({ content: 'ok' }),
    }],
    ...(modalities ? { requestedOutputModalities: modalities } : {}),
    turn: 1,
  })) {
    events.push(event)
  }
  expect(events.length).toBeGreaterThan(0)
  return body.tools ?? []
}

describe('OpenAI native image output — engine gate meets the dialect (#13)', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('gpt-5.5:引擎要图 ⇒ 线上工具表长出 image_generation', async () => {
    const modalities = await requestedModalities('gpt-5.5')
    expect(modalities).toEqual(['image'])

    const tools = await wireToolsFor('gpt-5.5', modalities)
    expect(tools).toEqual(expect.arrayContaining([
      { type: 'image_generation', output_format: 'png' },
    ]))
  })

  it('gpt-5.4(官方支持表外):引擎不要图 ⇒ 线上只有函数工具', async () => {
    const modalities = await requestedModalities('gpt-5.4')
    expect(modalities).toBeUndefined()

    const tools = await wireToolsFor('gpt-5.4', modalities)
    expect(tools).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image_generation' }),
    ]))
    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'function', name: 'read_file' }),
    ]))
  })
})
