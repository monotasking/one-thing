/**
 * **冷加载修复的两个具名入口**(`sanitizeSessionOnStartup` / `sanitizeLoadedSession`)。
 *
 * §17.7.1 批 3 之前这个文件问的是 `applySessionCommand` 的 7 条分支(COW / 写计划 /
 * lazy 档 / 会话账)。归约器退役之后那些判据各归各家:
 *
 *  - **会话账**(`updatedAt` / `lastProvider` / `lastModel` / 截断的用量结算与
 *    timeline 修复)→ `__tests__/session-account.test.ts`(折叠器的产地逐格);
 *  - **写档与索引元数据** → `backend/session/__tests__/commands.test.ts`(写门那张表);
 *  - **事件产地与顺序** → `backend/session/__tests__/command-events-order.test.ts`。
 *
 * 留在这里的只剩修复本身:它是**可再生的派生**(同一份消息折两次得同一个结果),
 * 住在读路,而且**不改入参**(COW:变了返回新会话,没变返回 `undefined`)。
 */

import { describe, expect, it, vi } from 'vitest'
import {
  sanitizeLoadedSession,
  sanitizeSessionOnStartup,
  type CoreSessionCommandMessage,
  type CoreSessionCommandSession,
} from '../commands.js'
import { CORE_INTERRUPTED_TOOL_ERROR } from '../interrupted.js'

type Message = CoreSessionCommandMessage & {
  reasoning?: string
  thinkingTime?: number
  skillUsed?: string
}
type Session = CoreSessionCommandSession<Message>

function message(id: string, overrides: Partial<Message> = {}): Message {
  return { id, role: 'assistant', content: id, timestamp: 1, ...overrides }
}

function session(messages: Message[], overrides: Partial<Session> = {}): Session {
  return { id: 's1', messages, updatedAt: 0, ...overrides }
}

describe('冷加载修复 —— sanitizeSessionOnStartup / sanitizeLoadedSession', () => {
  const staleCompact = JSON.stringify({
    type: 'context-compact',
    status: 'compacting',
    summary: '',
    compactedMessageCount: 40,
  })

  function brokenSession(): Session {
    return session(
      [
        message('u1', { role: 'user', content: 'hi' }),
        message('a1', {
          isStreaming: true,
          toolCalls: [{ status: 'executing', requiresConfirmation: true }],
          steps: [
            {
              id: 's1',
              title: 'Running: bash',
              status: 'running',
              childSteps: [{ id: 's1a', title: 'sub', status: 'pending' }],
            },
          ],
        }),
        message('sys1', { role: 'system', content: staleCompact, timestamp: 1 }),
      ],
      { summary: 'x', summaryUpToMessageId: 'gone', summaryCreatedAt: 5 },
    )
  }

  it('startup:修中断的 step / toolCall / 卡死的 compact,入参一字不改', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = brokenSession()
    const repaired = sanitizeSessionOnStartup<Session, Message>(before)!

    expect(repaired).toBeDefined()
    expect(repaired).not.toBe(before)

    const repairedAssistant = repaired.messages[1]
    expect(repairedAssistant.isStreaming).toBe(false)
    expect(repairedAssistant.toolCalls![0]).toMatchObject({
      status: 'cancelled',
      requiresConfirmation: false,
    })
    // R-a(§13.6):崩溃收口以 prepare 为准 —— `cancelled` + 那一句共用常量,
    // 标题不再被改写(投影重建不出一次标题改写)。
    expect(repairedAssistant.steps![0]).toMatchObject({
      status: 'cancelled',
      error: CORE_INTERRUPTED_TOOL_ERROR,
    })
    expect(repairedAssistant.steps![0].title).toBe('Running: bash')
    expect(repairedAssistant.steps![0].childSteps![0].status).toBe('cancelled')
    expect(JSON.parse(repaired.messages[2].content as string).status).toBe('failed')
    // summary 锚点不存在 → 三件套一起清掉
    expect('summary' in repaired).toBe(false)
    expect('summaryUpToMessageId' in repaired).toBe(false)
    expect('summaryCreatedAt' in repaired).toBe(false)

    // 没被修的那条保持同一引用;入参整份原样
    expect(repaired.messages[0]).toBe(before.messages[0])
    expect(before.messages[1].isStreaming).toBe(true)
    expect(before.messages[1].steps![0].status).toBe('running')
    expect(before.summary).toBe('x')
    vi.restoreAllMocks()
  })

  it('loaded:只清 isStreaming,不碰 step/toolCall/compact', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = brokenSession()
    const repaired = sanitizeLoadedSession<Session, Message>(before)!

    expect(repaired.messages[1].isStreaming).toBe(false)
    expect(repaired.messages[1].steps![0].status).toBe('running')
    expect(repaired.messages[2]).toBe(before.messages[2])
    vi.restoreAllMocks()
  })

  it('干净会话:一格都不动,交回 undefined', () => {
    const before = session([message('m1')])
    expect(sanitizeSessionOnStartup<Session, Message>(before)).toBeUndefined()
    expect(sanitizeLoadedSession<Session, Message>(before)).toBeUndefined()
  })

  it('只有会话级元数据要修时也走 COW(消息数组原样复用)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = session([message('m1')], { summary: 'x', summaryUpToMessageId: 'gone' })
    const repaired = sanitizeLoadedSession<Session, Message>(before)!

    expect('summary' in repaired).toBe(false)
    expect('summaryUpToMessageId' in repaired).toBe(false)
    // 消息一条都没改 → 数组原样复用(不白白换一份引用)
    expect(repaired.messages).toBe(before.messages)
    // 入参不动
    expect(before.summary).toBe('x')
    vi.restoreAllMocks()
  })
})
