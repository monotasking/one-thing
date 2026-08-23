/**
 * F4(§13.2):**合同测试验的是生产从不走的 core 缺省配方**。
 *
 * `projection-contract.test.ts` 的模型历史场景全部跑 `projectModelHistory` 的
 * **缺省** `buildMessageContent` —— 而真机上没有任何一次请求走过它:桌面端那条路
 * 是 `historyProjectionRecipe()`(房投影 / goal drive 折叠 / 用户消息上模型面 +
 * 图片附件钩子 + 尾块回放落点)。两者在**老会话的 `contextUpdate`** 上就不同字节:
 * 宿主把那段旧格式原样渲染进正文(铁律:老会话每条消息的字节都不许变,否则升级后
 * 第一轮就整段 cache 失效),core 缺省的那份根本不认识这个字段。
 *
 * 所以这一份跑的是**宿主配方**。它住在 app 层而不是 core 的合同测试里,理由是
 * 分层:core 的测试不许 import 装配层(`architecture-boundaries` 盯着这条)。
 * core 那边的缺省配方仍由原来那份测试守着 —— 两份各测各的那一条路。
 */
import { describe, expect, it } from 'vitest'
import {
  canonicalChatMessage,
  canonicalHistoryMessages,
  projectModelHistory,
  type SessionLogEventRecord,
} from '@onething/core/session'
import type { ChatMessage } from '@shared/ipc.js'
import {
  dehydrateProjectedMessages,
  dehydrateSessionForStorage,
  rehydrateSessionFromStorage,
} from '@onething/runtime/sessions/session-dehydrate'
import {
  buildHistoryMessages,
  historyProjectionRecipe,
} from '../../wiring/engine/stream/message-helpers.js'

/** 事件行 + 与它同源的那份消息数组(A 线 / B 线的唯一共享物是这个场景描述)。 */
function scenario(messages: ChatMessage[]): {
  messages: ChatMessage[]
  events: SessionLogEventRecord[]
} {
  const events: SessionLogEventRecord[] = messages.map((message, index) => ({
    seq: index + 1,
    time: message.timestamp ?? index + 1,
    type: 'message/imported',
    data: { message: message as never },
    surfaceOp: 'append',
  } as SessionLogEventRecord))
  return { messages, events }
}

function projectedWithHostRecipe(events: readonly SessionLogEventRecord[]): string {
  return canonicalHistoryMessages(
    projectModelHistory(events, {}, historyProjectionRecipe()) as readonly unknown[],
  )
}

function builtByHost(messages: ChatMessage[]): string {
  return canonicalHistoryMessages(buildHistoryMessages(messages) as readonly unknown[])
}

describe('F4:模型历史合同跑的是**宿主配方**', () => {
  it('renders a legacy contextUpdate exactly as the host does', () => {
    const { messages, events } = scenario([
      {
        id: 'u1', role: 'user', content: 'hello', timestamp: 1,
        // 2026-08-18 之前的老形状:一段裸字符串,不是分节 delta。
        contextUpdate: 'Current date: 2026-01-01',
      } as ChatMessage,
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: 2 } as ChatMessage,
    ])

    const host = builtByHost(messages)
    expect(host).toContain('Current date: 2026-01-01')
    expect(projectedWithHostRecipe(events)).toBe(host)

    // 反证:core 缺省配方在这一格上与宿主**不同字节** —— 这正是 F4 说的覆盖洞。
    const coreDefault = canonicalHistoryMessages(
      projectModelHistory(events, {}) as readonly unknown[],
    )
    expect(coreDefault).not.toBe(host)
  })

  it('replays the sectioned turnContext delta the way the request does', () => {
    const { messages, events } = scenario([
      {
        id: 'u1', role: 'user', content: 'hello', timestamp: 1,
        turnContext: { set: { workdir: '# Work Directory\n/tmp/x' } },
      } as ChatMessage,
      { id: 'a1', role: 'assistant', content: 'hi', timestamp: 2 } as ChatMessage,
    ])
    const host = builtByHost(messages)
    expect(host).toContain('Work Directory')
    expect(projectedWithHostRecipe(events)).toBe(host)
  })

  it('keeps a tool turn byte-identical through the host recipe', () => {
    const { messages, events } = scenario([
      { id: 'u1', role: 'user', content: 'read it', timestamp: 1 } as ChatMessage,
      {
        id: 'a1', role: 'assistant', content: 'done', timestamp: 2,
        contentParts: [{ type: 'text', content: 'done', turnIndex: 1 }],
        toolCalls: [{
          id: 'c1', toolId: 'read', toolName: 'read',
          arguments: { path: 'a.md' }, status: 'completed',
          result: 'file body', timestamp: 2,
        }],
        steps: [{
          id: 's1', type: 'file-read', title: 'Reading a.md', status: 'completed',
          timestamp: 2, turnIndex: 1, toolCallId: 'c1', result: 'file body',
        }],
      } as unknown as ChatMessage,
    ])
    expect(projectedWithHostRecipe(events)).toBe(builtByHost(messages))
  })
})

/**
 * #4(§13.13,裁定:选项 1 —— 投影也省略,与脱水一致)。
 *
 * 一张 `read` 工具读回来的图片:落盘时 `dehydrate` 把 `toolCall.result` /
 * `step.partialResult` 里那段图片正文换成 `[Image: … omitted]` 占位,补水又不还原;
 * 而投影(A8)把 blob 换回全文 —— 两侧分叉。修法:投影过一遍**同一把**
 * `dehydrateProjectedMessages`,两侧于是逐字节相同。图片本体仍在 blob 里一份。
 */
describe('§13.13 #4:工具结果图片,投影与脱水同口径省略', () => {
  const base64 = 'A'.repeat(4000)
  const imageResult = { type: 'image', mimeType: 'image/png', data: base64 }
  // 一条带图片工具结果的**全量**消息(= A8 投影补齐后的形状)。
  const full = (): ChatMessage => ({
    id: 'a1', role: 'assistant', content: 'done', timestamp: 2,
    toolCalls: [{
      id: 'c1', toolId: 'read', toolName: 'read',
      arguments: { path: 'x.png' }, status: 'completed',
      result: { ...imageResult }, timestamp: 2,
    }],
    steps: [{
      id: 's1', type: 'file-read', title: 'Reading x.png', status: 'completed',
      timestamp: 2, turnIndex: 1, toolCallId: 'c1',
      partialResult: { ...imageResult }, partialResultIsPartial: false,
    }],
  } as unknown as ChatMessage)

  // 磁盘那一份:落盘即脱水,读盘即补水(存储驱动逐字如此)。
  const disk = (): ChatMessage =>
    (rehydrateSessionFromStorage(
      dehydrateSessionForStorage({ messages: [full()] }),
    ) as { messages: ChatMessage[] }).messages[0]

  it('投影过 dehydrateProjectedMessages 后与磁盘逐字节相同(两侧都省略了图片)', () => {
    const projected = dehydrateProjectedMessages([full()])[0]
    expect(canonicalChatMessage(projected as never))
      .toEqual(canonicalChatMessage(disk() as never))
    // 占位符就是 dehydrate 那把:`[Image: image/png data omitted: 4000 chars]`。
    const json = JSON.stringify(projected)
    expect(json).toContain('data omitted: 4000 chars')
    expect(json).not.toContain(base64)
  })

  it('反证:不省略(裸投影,全量 base64)与磁盘分叉 → 红', () => {
    const raw = full()
    expect(canonicalChatMessage(raw as never))
      .not.toEqual(canonicalChatMessage(disk() as never))
    expect(JSON.stringify(raw)).toContain(base64)
  })
})
