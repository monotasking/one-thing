// @vitest-environment happy-dom
/**
 * **新旧路对拍**(U2-a,§17.8.7)。
 *
 * 同一个剧本、两条路,屏幕上那棵树必须 canonical 等价:
 *
 *  - **旧路**(开关翻回):手写拼装管道跑,树是它维护的那个数组;
 *  - **新路**(默认):账本折叠产出结构,活尾巴补"还没打包的那一截",
 *    overlay 叠占位与本地卡。
 *
 * 另外单钉三件新路特有的事:活尾巴的**即时性**(不等打包行)、打包行到达时的
 * **换装不重影**、等待指示**由 run 态派生**。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useChatStore } from '@/stores/chat'
import {
  canonicalizeTreeForCompare,
  feedUiRefoldLedgerEvent,
  resetUiRefold,
} from '@/stores/ui-refold'
import {
  clearFoldTail,
  composeFoldTree,
  feedFoldTail,
  toRenderableMessageForTest,
  resetFoldTree,
  setFoldTreeEnabled,
} from '@/stores/fold-tree'
import { resetSessionOverlays } from '@/stores/session-overlays'
import type { ChatMessage } from '@/types'

const SESSION = 'fold-tree-spec'

let seq = 0
function event(type: string, data: unknown): unknown {
  seq += 1
  return { seq, time: 1000 + seq, type, data }
}

function ledgerOneTurn(text: string[]): unknown[] {
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
    event('assistant/chunks', {
      runId: 'r1',
      requestIndex: 1,
      messageId: 'a1',
      partIndex: 0,
      kind: 'text',
      time0: 1000,
      dt: text.map((_, index) => index),
      text,
    }),
    event('assistant/part-end', { runId: 'r1', requestIndex: 1, messageId: 'a1', partIndex: 0, kind: 'text' }),
    event('request/response', { runId: 'r1', requestIndex: 1, messageId: 'a1' }),
    event('request/end', { runId: 'r1', requestIndex: 1, messageId: 'a1' }),
    event('run/end', { runId: 'r1', outcome: 'completed' }),
  ]
}

/** 只开张、不收尾的一段(run 还活着)—— 等待指示与活尾巴的场景。 */
function ledgerRunOpen(): unknown[] {
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

function tree(): ChatMessage[] {
  const composed = composeFoldTree(SESSION)
  expect(composed, '活折还没起底').toBeDefined()
  return composed!
}

beforeEach(() => {
  setActivePinia(createPinia())
  resetUiRefold()
  resetFoldTree()
  resetSessionOverlays()
  setFoldTreeEnabled(undefined)
})

describe('新旧路对拍:屏幕上那棵树 canonical 等价', () => {
  it('一轮走完的文本回合:两条路逐格相等', () => {
    // 旧路:手写拼装跑一遍。
    setFoldTreeEnabled(false)
    const store = useChatStore()
    store.sessionMessages.set(SESSION, [
      { id: 'u1', role: 'user', content: '在吗', timestamp: 1000 } as ChatMessage,
      {
        id: 'a1', role: 'assistant', content: '', timestamp: 1002, isStreaming: true,
        provider: 'deepseek', model: 'deepseek-chat', toolCalls: [], contentParts: [],
      } as ChatMessage,
    ])
    store.handleStreamChunk({ sessionId: SESSION, messageId: 'a1', type: 'text', content: '在的', turnIndex: 1 } as never)
    store.handleStreamComplete({ sessionId: SESSION } as never)
    const handTree = [...(store.sessionMessages.get(SESSION) ?? [])]

    // 新路:同一个剧本的账本词汇。
    setFoldTreeEnabled(undefined)
    feed(ledgerOneTurn(['在', '的']))

    expect(canonicalizeTreeForCompare(tree(), SESSION))
      .toEqual(canonicalizeTreeForCompare(handTree, SESSION))
  })
})

describe('新路特有的三件事', () => {
  it('活尾巴:打包行还没来,字已经在屏幕上', () => {
    feed(ledgerRunOpen())
    // 账本此刻只知道"run 开了",一个字都还没落账。
    expect(tree()[1]?.content ?? '').toBe('')

    feedFoldTail(SESSION, 'a1', 'text', 'hel')
    feedFoldTail(SESSION, 'a1', 'text', 'lo')

    const withTail = tree()[1]
    expect(withTail.content).toBe('hello')
    expect(withTail.contentParts?.at(-1)).toMatchObject({ type: 'text', content: 'hello' })
  })

  it('换装不重影:打包行到达 → 丢尾巴 → 正文只有一份', () => {
    feed(ledgerRunOpen())
    feedFoldTail(SESSION, 'a1', 'text', '在的')
    expect(tree()[1].content).toBe('在的')

    // 打包行装的就是刚才那两条 delta(`decode∘encode ≡ id`)。
    const packed = ledgerOneTurn(['在', '的']).slice(4)
    clearFoldTail(SESSION)
    feed(packed)

    const message = tree()[1]
    expect(message.content).toBe('在的')
    expect(message.contentParts?.filter(part => part.type === 'text')).toHaveLength(1)
  })

  it('等待指示由 run 态派生:run 活着且一个字没有 → waiting;有字就没有', () => {
    feed(ledgerRunOpen())
    expect(tree()[1].contentParts?.at(-1)).toMatchObject({ type: 'waiting' })

    feedFoldTail(SESSION, 'a1', 'text', '在')
    expect(tree()[1].contentParts?.some(part => part.type === 'waiting')).toBe(false)
  })

  it('run 收尾之后不再有 waiting', () => {
    feed(ledgerOneTurn(['在的']))
    expect(tree()[1].contentParts?.some(part => part.type === 'waiting')).toBe(false)
  })
})

describe('overlay 叠加', () => {
  it('本地错误卡挂在树末尾;瞬态挂在对应消息上', async () => {
    const { addOverlayLocalMessage, setOverlayTransientPart } =
      await import('@/stores/session-overlays')
    feed(ledgerOneTurn(['在的']))

    addOverlayLocalMessage(SESSION, {
      id: 'local-1', role: 'error', content: '发送失败', timestamp: 2000,
    } as ChatMessage)
    setOverlayTransientPart(SESSION, 'a1', { type: 'image-loading', turnIndex: 1 } as never)

    const composed = tree()
    expect(composed.at(-1)).toMatchObject({ id: 'local-1', role: 'error' })
    expect(composed.find(message => message.id === 'a1')?.contentParts?.at(-1))
      .toMatchObject({ type: 'image-loading' })
  })
})

describe('未结算的插件状态行走 overlay 车道', () => {
  it('新路上它经 overlay 叠到消息上(账本上按定义没有它)', async () => {
    const { setOverlayTransientPart, clearOverlayTransientParts } =
      await import('@/stores/session-overlays')
    feed(ledgerOneTurn(['在的']))

    setOverlayTransientPart(SESSION, 'a1', {
      type: 'plugin-status', pluginId: 'p', id: 's', label: '正在干活',
    } as never)
    expect(tree().find(message => message.id === 'a1')?.contentParts?.at(-1))
      .toMatchObject({ type: 'plugin-status', label: '正在干活' })

    clearOverlayTransientParts(SESSION, 'a1')
    expect(tree().find(message => message.id === 'a1')?.contentParts
      ?.some(part => part.type === 'plugin-status')).toBe(false)
  })
})

describe('开关', () => {
  it('翻回旧路之后,手写侧的写重新落在树上', () => {
    const store = useChatStore()
    setFoldTreeEnabled(undefined)
    store.addLocalMessage(SESSION, { role: 'error', content: '新路上这条不进树' })
    expect(store.sessionMessages.get(SESSION) ?? []).toHaveLength(0)

    setFoldTreeEnabled(false)
    store.addLocalMessage(SESSION, { role: 'error', content: '旧路上这条进树' })
    expect(store.sessionMessages.get(SESSION) ?? []).toHaveLength(1)
  })
})

/**
 * **真机浸泡抓到的四条回归**(2026-08-28,用户截图报障)。
 *
 * 四条全在**流中态**:老用例喂的是走完的账本(收尾态),而这四条只在"账本还没
 * 追上、活尾巴正在补"的那一段里出得来。判据也看不见它们 —— canonical 丢锚点
 * (G4)、丢 `thinkingTime`(G5),所以门全绿而屏幕全错。这一组按症状各钉一只。
 */
describe('流中态回归(真机 2026-08-28)', () => {
  /** 只开张、请求也开了、但一条正文都还没落账的那一瞬。 */
  function openRun(): unknown[] {
    return ledgerRunOpen()
  }

  it('症状 1/3:顶部推理进 message.reasoning,不进 contentParts', () => {
    feed(openRun())
    feedFoldTail(SESSION, 'a1', 'reasoning', '我先想一下', 'top')

    const assistant = tree()[1]
    expect(assistant.reasoning).toBe('我先想一下')
    // 它**不**是正文里的一格 —— 从前这里挂进 parts,于是同一段思考既进 Thought
    // 块又以正文渲染,还多出一个思考块。
    expect(assistant.contentParts?.some(part => part.type === 'reasoning')).toBe(false)
  })

  it('症状 1:行内推理只延长**最后**那一段,不回头找上一个推理块', () => {
    feed(openRun())
    // 账本已经落了「推理段 → 正文段」两格(一次真实的 reasoning→text 切换)。
    const withParts = tree()
    expect(withParts).toBeTruthy()
    feedFoldTail(SESSION, 'a1', 'reasoning', '第一段思考', 'inline')
    feedFoldTail(SESSION, 'a1', 'text', '正文开始')
    // 现在再来一段**新的**行内推理:它必须自己起一格,不许追加进第一段。
    feedFoldTail(SESSION, 'a1', 'reasoning', '第二段思考', 'inline')

    const parts = (tree()[1].contentParts ?? []) as Array<{ type: string; content?: string }>
    const reasoningParts = parts.filter(part => part.type === 'reasoning')
    expect(reasoningParts.map(part => part.content)).toEqual(['第一段思考', '第二段思考'])
    // 顺序也要对:新的那一段在正文之后。
    expect(parts.map(part => part.type)).toEqual(['reasoning', 'text', 'reasoning'])
  })

  it('症状 2:thinkingTime 由毫秒换算成秒(产品契约的单位)', () => {
    // 折叠侧给的是推理段首尾时刻差(毫秒);屏幕上那一格按秒显示。
    const events = [
      ...ledgerOneTurn(['答案']),
    ]
    feed(events)
    feedFoldTail(SESSION, 'a1', 'reasoning', 'x', 'top')
    const assistant = tree()[1] as ChatMessage & { thinkingTime?: number }
    // 这条剧本没有推理段,折叠不产出 thinkingTime —— 钉的是换算函数本身:
    // 给一个毫秒量级的值,composeFoldTree 之后必须是秒。
    const composed = { ...assistant, thinkingTime: 15_700, role: 'assistant' } as ChatMessage
    expect(toRenderableMessageForTest(composed).thinkingTime).toBeCloseTo(15.7, 3)
  })

  it('症状 4:带工具的消息合成出渲染锚点(否则一个工具卡都不画)', () => {
    seq = 0
    const events = [
      event('session/created', { sessionId: SESSION }),
      event('user/message', { message: { id: 'u1', role: 'user', content: '读一下', timestamp: 1000 } }),
      event('run/start', {
        runId: 'r1', kind: 'send', assistantMessageId: 'a1', provider: 'deepseek',
        model: 'deepseek-chat', timestamp: 1002, createdAssistantMessage: true,
      }),
      event('request/start', { runId: 'r1', requestIndex: 1, messageId: 'a1' }),
      event('tool/call', {
        callId: 't1', name: 'read', resolvedToolId: 'read',
        argumentsRaw: '{"path":"a.txt"}', messageId: 'a1', runId: 'r1', requestIndex: 1,
      }),
      event('tool/result', {
        callId: 't1', isError: false, resultPreview: 'ok', result: { text: 'ok' },
        messageId: 'a1', runId: 'r1', requestIndex: 1,
      }),
      event('request/response', { runId: 'r1', requestIndex: 1, messageId: 'a1' }),
      event('request/end', { runId: 'r1', requestIndex: 1, messageId: 'a1' }),
      event('run/end', { runId: 'r1', outcome: 'completed' }),
    ]
    feed(events)

    const assistant = tree()[1]
    expect(assistant.toolCalls?.length).toBe(1)
    // 锚点是渲染坐标 —— 判据(canonical G4)看不见它,所以必须在这里钉。
    const anchors = (assistant.contentParts ?? []).filter(
      part => part.type === 'data-steps' || part.type === 'tool-call',
    )
    expect(anchors.length).toBeGreaterThan(0)
  })
})
