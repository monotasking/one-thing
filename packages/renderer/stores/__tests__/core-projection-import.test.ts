/**
 * **U1-a 冒烟:core 的投影件在 renderer 这一侧真的 import 得动、用得起来。**
 *
 * U-b 的前提是"renderer 直接 import core 投影 reducer"。U1-a 只斩了那三条
 * `node:` 短边(`permission/rejection-message` / `context-compact-content` /
 * `json-message-page-file`),**一行渲染管道都没有动** —— 所以这只用例要证的
 * 也只有两件:
 *
 *  1. 四条叶子路径从 `packages/renderer` 里 import 得到(exports 表 + 解析都对);
 *  2. 它们在这一侧**跑得起来**:折一小段事件流 → 物化成消息 → 过一次 canonical。
 *
 * **它不证"闭包里没有 `node:`"** —— vitest 跑在 node 上,`node:fs` 在这里 import
 * 得动。那件事由静态棘轮守:`scripts/headless-boundary-check.ts` 的
 * `checkRendererCoreImportsAreBrowserSafe`(扫 renderer 的每一条
 * `@onething/core/...`,算传递闭包,闭包里任何一个 `node:` 都是红)。两道门各证
 * 一半,少哪一半都不算数。
 *
 * 走的是**叶子路径**,不是 `@onething/core/session` 那个桶 —— 判例
 * `platform/plugins-client.ts:27-30`(桶会把 node 触点拖进来)。
 */

import { describe, expect, it } from 'vitest'
import {
  createSessionProjectionState,
  reduceSessionProjection,
} from '@onething/core/session/projection/reducer'
import {
  materializeChatMessages,
  projectChatMessages,
} from '@onething/core/session/projection/chat-messages'
import { canonicalChatMessage } from '@onething/core/session/projection/canonical'
import { decodeSessionChunksEventData } from '@onething/core/session/events/chunk-codec'

/** 一段最小的真事件流:一句用户消息 + 一次执行,正文走 `assistant/chunks`。 */
function ledger(): unknown[] {
  return [
    {
      seq: 1,
      time: 1000,
      type: 'user/message',
      data: { message: { id: 'u1', role: 'user', content: '在吗', timestamp: 1000 } },
      surfaceOp: 'append',
    },
    {
      seq: 2,
      time: 1001,
      type: 'run/start',
      data: {
        runId: 'r1',
        kind: 'send',
        assistantMessageId: 'a1',
        provider: 'deepseek',
        model: 'deepseek-chat',
        timestamp: 1001,
        createdAssistantMessage: true,
      },
      surfaceOp: 'append',
    },
    {
      seq: 3,
      time: 1002,
      type: 'assistant/chunks',
      // 打包形态(定律二:打包是**存储编码**)——`text[]` 是逐条 delta,`dt[]` 是
      // 它们相对 `time0` 的偏移。
      data: {
        runId: 'r1',
        requestIndex: 1,
        messageId: 'a1',
        partIndex: 0,
        kind: 'text',
        time0: 1002,
        dt: [0, 1],
        text: ['在', '的'],
      },
    },
    {
      seq: 4,
      time: 1003,
      type: 'assistant/part-end',
      data: { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text' },
    },
    { seq: 5, time: 1004, type: 'run/end', data: { runId: 'r1', outcome: 'completed' } },
  ]
}

describe('U1-a:core 投影件在 renderer 侧可用', () => {
  it('四条叶子路径都 import 得到(不是 undefined)', () => {
    expect(typeof createSessionProjectionState).toBe('function')
    expect(typeof reduceSessionProjection).toBe('function')
    expect(typeof projectChatMessages).toBe('function')
    expect(typeof materializeChatMessages).toBe('function')
    expect(typeof canonicalChatMessage).toBe('function')
    expect(typeof decodeSessionChunksEventData).toBe('function')
  })

  it('在这一侧折得出消息树:一问一答,正文来自 assistant/chunks', () => {
    // 逐条折(U1-b 的活路子:一条事件推一次),再物化。
    let state = createSessionProjectionState()
    for (const event of ledger()) state = reduceSessionProjection(state, event as never)

    const { messages } = materializeChatMessages(state)
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(messages[0].content).toBe('在吗')
    expect(messages[1].content).toBe('在的')
    // `run/end` 之后不再是"生成中"(策略表 `message.isStreaming` 那一条)。
    expect(messages[1].isStreaming).toBeUndefined()
    expect(messages[1].provider).toBe('deepseek')
  })

  it('canonical 这把尺也在这一侧跑得起来(ui-shadow 的法官)', () => {
    // **两条路折同一段账**:逐条推(活路)vs 整份折(`projectChatMessages`,
    // 冷加载那条路)—— canonical 之后必须逐格相等。ui-shadow 要比的正是这种等式。
    let state = createSessionProjectionState()
    for (const event of ledger()) state = reduceSessionProjection(state, event as never)
    const incremental = materializeChatMessages(state).messages[1]
    const wholeFile = projectChatMessages(ledger() as never).messages[1]

    const a = canonicalChatMessage(incremental as unknown as Record<string, unknown>)
    expect(a).toBeTruthy()
    expect(canonicalChatMessage(wholeFile as unknown as Record<string, unknown>)).toEqual(a)
  })

  it('打包解码器同样在这一侧可用(U1-b 要吃它)', () => {
    const decoded = decodeSessionChunksEventData({
      runId: 'r1',
      requestIndex: 1,
      messageId: 'a1',
      partIndex: 0,
      kind: 'text',
      time0: 1002,
      dt: [0, 1],
      text: ['在', '的'],
    } as never)
    // 解包出来的就是当初那两条 delta(定律二:decode∘encode ≡ id 的读侧一半)。
    expect(decoded).toBeTruthy()
  })
})
