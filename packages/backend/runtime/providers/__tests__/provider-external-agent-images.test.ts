/**
 * 图片链路的 provider 一半(2026-08-12,审计 `claude-code-sdk-audit-2026-08-11` 的
 * 「图片静默丢弃」)。连接器无关:替身连接器只记下收到的请求。
 *
 * A6-b(2026-09-26)从 `claude-code-images.test.ts` 拆出:SDK 连接器那一半随连接器退役,
 * 这一半断的是 `createExternalAgentProvider` 自己 —— 送到了 / 没送到要说 / 接不住要说。
 */
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  createExternalAgentProvider,
  externalAgentImagesUnsupportedNotice,
} from '../provider-external-agent.js'
import type {
  ExternalAgentCapabilities,
  ExternalAgentConnector,
  ExternalAgentTurnRequest,
} from '@onething/backend/runtime/external-agents'

/** 一个真的存在的工作目录(provider 开跑前查它)。 */
const EXISTING_CWD = tmpdir()

/** 一张 1×1 的真 PNG,base64 原样取自 `data:` URL 的负载。 */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`

describe('createExternalAgentProvider 图片链路', () => {
  function stubConnector(
    captured: ExternalAgentTurnRequest[],
    capabilities: Partial<ExternalAgentCapabilities> = {},
  ): ExternalAgentConnector {
    return {
      id: 'acp',
      capabilities: {
        streamingText: true,
        thinking: true,
        toolSteps: true,
        permissionBridge: 'callback',
        resume: true,
        fork: true,
        steer: false,
        imagesIn: true,
        mcpInjection: 'config',
        concurrentSessions: 'per-process',
        ...capabilities,
      },
      async *streamTurn(request) {
        captured.push(request)
        yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
      },
      async interrupt() {},
      async dispose() {},
    }
  }

  it('最后一条用户消息的图片被送到连接器(image 与 image/* file 两种部件都算)', async () => {
    const captured: ExternalAgentTurnRequest[] = []
    const provider = createExternalAgentProvider({
      providerId: 'acp',
      connector: stubConnector(captured),
      localSessionId: 'session-1',
      workingDirectory: EXISTING_CWD,
    })
    for await (const _event of provider.streamTurn!({
      model: 'claude-code',
      messages: [
        { role: 'user', content: [{ type: 'text', text: '旧的一轮' }, { type: 'image', image: 'data:image/png;base64,OLD' }] },
        { role: 'assistant', content: '好' },
        {
          role: 'user',
          content: [
            { type: 'text', text: '图里是什么字母?' },
            { type: 'image', image: TINY_PNG_DATA_URL },
            { type: 'file', data: 'data:image/webp;base64,ZZZ', mediaType: 'image/webp' },
            { type: 'file', data: 'JVBER', mediaType: 'application/pdf' },
          ],
        },
      ],
      turn: 1,
    })) { /* drain */ }

    expect(captured[0]?.prompt).toBe('图里是什么字母?')
    // 只取**这一条**消息的图 —— 上一轮那张不许混进来。
    expect(captured[0]?.images).toEqual([
      { image: TINY_PNG_DATA_URL },
      { image: 'data:image/webp;base64,ZZZ', mediaType: 'image/webp' },
    ])
  })

  it('能力表决定声明:imagesIn 翻假,vision-input 就没了', () => {
    const withImages = createExternalAgentProvider({
      providerId: 'acp',
      connector: stubConnector([]),
      workingDirectory: '/tmp',
    })
    expect(withImages.capabilities?.inputModalities).toEqual(['text', 'image'])
    expect(withImages.capabilities?.capabilities).toContain('vision-input')

    const withoutImages = createExternalAgentProvider({
      providerId: 'acp',
      connector: stubConnector([], { imagesIn: false }),
      workingDirectory: '/tmp',
    })
    expect(withoutImages.capabilities?.inputModalities).toEqual(['text'])
    expect(withoutImages.capabilities?.capabilities).not.toContain('vision-input')
  })

  it('接不住图的连接器:不偷偷剥掉,而是当场说没送到', async () => {
    const captured: ExternalAgentTurnRequest[] = []
    const provider = createExternalAgentProvider({
      providerId: 'acp',
      connector: stubConnector(captured, { imagesIn: false }),
      workingDirectory: EXISTING_CWD,
    })
    const events: AgentEventLike[] = []
    for await (const event of provider.streamTurn!({
      model: 'claude-code',
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: '看图' }, { type: 'image', image: TINY_PNG_DATA_URL }],
      }],
      turn: 1,
    })) events.push(event as AgentEventLike)

    expect(events[0]).toMatchObject({
      type: 'text-delta',
      delta: externalAgentImagesUnsupportedNotice(1),
    })
    // 文本照跑,图片一张都没塞给接不住的连接器。
    expect(captured[0]?.images).toBeUndefined()
    expect(captured[0]?.prompt).toBe('看图')
  })

  it('只有图、又接不住:一条可见正文 + finish(error),绝不静默', async () => {
    const captured: ExternalAgentTurnRequest[] = []
    const provider = createExternalAgentProvider({
      providerId: 'acp',
      connector: stubConnector(captured, { imagesIn: false }),
      workingDirectory: EXISTING_CWD,
    })
    const events: AgentEventLike[] = []
    for await (const event of provider.streamTurn!({
      model: 'claude-code',
      messages: [{ role: 'user', content: [{ type: 'image', image: TINY_PNG_DATA_URL }] }],
      turn: 1,
    })) events.push(event as AgentEventLike)

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ type: 'text-delta' })
    expect(events[1]).toMatchObject({ type: 'finish', finishReason: 'error' })
    expect(captured).toHaveLength(0)
  })

  it('只有图、接得住:不再当成空 prompt 抛错', async () => {
    const captured: ExternalAgentTurnRequest[] = []
    const provider = createExternalAgentProvider({
      providerId: 'acp',
      connector: stubConnector(captured),
      workingDirectory: EXISTING_CWD,
    })
    for await (const _event of provider.streamTurn!({
      model: 'claude-code',
      messages: [{ role: 'user', content: [{ type: 'image', image: TINY_PNG_DATA_URL }] }],
      turn: 1,
    })) { /* drain */ }
    expect(captured[0]?.prompt).toBe('')
    expect(captured[0]?.images).toEqual([{ image: TINY_PNG_DATA_URL }])
  })
})

type AgentEventLike = { type: string; delta?: string; finishReason?: string }
