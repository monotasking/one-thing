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
  canonicalHistoryMessages,
  projectModelHistory,
  type SessionLogEventRecord,
} from '@onething/core/session'
import type { ChatMessage } from '@shared/ipc.js'
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
