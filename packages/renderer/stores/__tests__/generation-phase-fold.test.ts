// @vitest-environment happy-dom
/**
 * **新路下的相位读数**(§17.8.9 增补,用户报「inputbox 的 waiting 等状态没有了」)。
 *
 * 输入框那行读数(WAITING / THINKING / RESPONDING)由
 * `chatStore.getGenerationStatus(sessionId)` 产出,`derivePhase(message)` 是它的判据。
 * U2-a 之后屏幕那棵树换了产地,而这只用例钉的正是**换源之后这条链还通不通**:
 * 一次 send 的全相位序列 waiting → thinking → responding → 收尾清空。
 *
 * 老用例喂的是手写管道(旧路),所以它们照绿;这一只**只跑新路**。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import {
  feedUiRefoldLedgerEvent,
  resetUiRefold,
} from '@/stores/ui-refold'
import {
  feedFoldTail,
  flushFoldTreePush,
  resetFoldTree,
  setFoldTreeEnabled,
} from '@/stores/fold-tree'
import { resetSessionOverlays } from '@/stores/session-overlays'

const SESSION = 'phase-fold'

let seq = 0
function event(type: string, data: unknown): unknown {
  seq += 1
  return { seq, time: 1000 + seq, type, data }
}

/** 一次 send 到"请求开了、一个字还没来"的那一段账本。 */
function ledgerUntilRequestOpen(): unknown[] {
  seq = 0
  return [
    event('session/created', { sessionId: SESSION }),
    event('user/message', {
      message: { id: 'u1', role: 'user', content: '在吗', timestamp: 1000 },
    }),
    event('run/start', {
      runId: 'r1',
      kind: 'send',
      assistantMessageId: 'a1',
      provider: 'deepseek',
      model: 'deepseek-chat',
      timestamp: 1002,
      createdAssistantMessage: true,
    }),
    event('request/start', { runId: 'r1', requestIndex: 1, messageId: 'a1' }),
  ]
}

function feed(events: readonly unknown[]): void {
  for (const record of events) feedUiRefoldLedgerEvent(SESSION, record)
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetUiRefold()
  resetFoldTree()
  resetSessionOverlays()
  setFoldTreeEnabled(undefined)
  vi.useRealTimers()
})

describe('新路:输入框相位读数的全序列', () => {
  it('send → waiting → thinking → responding → 收尾清空', () => {
    const store = useChatStore()

    // ① 引擎报了 stream:start(这一条不改消息树,新旧路都走)。
    store.handleStreamStarted({ sessionId: SESSION, messageId: 'a1' } as never)
    // 账本:run 开张、请求开张,一个字都还没来。
    feed(ledgerUntilRequestOpen())
    flushFoldTreePush(SESSION)

    const waiting = store.getGenerationStatus(SESSION)
    expect(waiting, '读数不该是 null —— 输入框那行就是靠它').not.toBeNull()
    expect(waiting?.phase).toBe('waiting')

    // ② 顶部推理开始 = THINKING。
    feedFoldTail(SESSION, 'a1', 'reasoning', '让我想想', 'top')
    flushFoldTreePush(SESSION)
    expect(store.getGenerationStatus(SESSION)?.phase).toBe('thinking')

    // ③ 正文开始 = RESPONDING。
    feedFoldTail(SESSION, 'a1', 'text', '在的')
    flushFoldTreePush(SESSION)
    expect(store.getGenerationStatus(SESSION)?.phase).toBe('responding')

    // ④ 收尾:不再生成 = 读数收起来。
    store.handleStreamComplete({ sessionId: SESSION } as never)
    expect(store.getGenerationStatus(SESSION)).toBeNull()
  })

  it('≈tokens 读数:估算累计 + stream:usage 定准(与相位同一条链)', () => {
    const store = useChatStore()
    store.handleStreamStarted({ sessionId: SESSION, messageId: 'a1' } as never)
    feed(ledgerUntilRequestOpen())

    store.handleStreamChunk({
      sessionId: SESSION, messageId: 'a1', type: 'text', content: 'hello world', turnIndex: 1,
    } as never)
    const estimated = store.getGenerationStatus(SESSION)
    expect(estimated?.outputTokens).toBeGreaterThan(0)
    expect(estimated?.outputTokensExact).toBe(false)

    store.handleStreamUsage({
      sessionId: SESSION,
      usage: { inputTokens: 12, outputTokens: 5 },
      accumulated: { inputTokens: 12, outputTokens: 5 },
    } as never)
    const exact = store.getGenerationStatus(SESSION)
    expect(exact?.outputTokens).toBe(5)
    expect(exact?.outputTokensExact).toBe(true)
    expect(exact?.inputTokens).toBe(12)
  })
})
