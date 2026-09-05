import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { configureChatPort, type ChatPort } from '../../data/chat-port'
import { chatSources } from '../../data/chat-source'
import { seedSessionsSource } from '../../data/__fixtures__/sessions'
import { useSessionsSource } from '../../data/sessions-source'
import { useExposeStore } from '../../expose/store'
import { initialExposeState } from '../../expose/transitions'
import { useStageStore } from '../../stage/store'
import { CenterRegion } from '../../workbench/CenterRegion'
import { CENTER_REGION } from '../../workbench/regions'
import { useWorkbenchStore } from '../../workbench/store'
import { leavesOf } from '../../workbench/tree'
import '../kinds'
import { startSessionProjection, stopSessionProjection } from '../session-projection'
import { sessionRefOf } from '../session-ref'
import type { SessionStreamPayload } from '@shared/events/envelope'

/**
 * **两片会话叶并排**(W5-b 交付 1 / 5;设计 §8 W5「需求 5:会话并排」)。
 *
 * 这一组是**渲染这一端**的证据 —— 数据那一端(两台机器同时收流互不串)由
 * `data/chat-source.test.ts` 的 W5-a 那一组钉着。这里问的是屏幕:
 * 两片叶各画各的那条会话,一片流式不动另一片一个字。
 *
 * 顺带钉住**零重挂**那条断言的可观测形:焦点叶原位换会话时,**兄弟叶的 DOM
 * 节点前后是同一个**(`tree.replaceRef` 的结构共享 + `PaneLeaf` 的 memo)。
 */

const T0 = 1_700_000_000_000
const A = 'os-expose'
const B = 'os-compact'

type Ledger = { seq: number; time: number; type: string; data: unknown }

const createdIn = (seq: number, sessionId: string): Ledger => ({
  seq,
  time: T0,
  type: 'session/created',
  data: { sessionId },
})
const userMessage = (seq: number, id: string, content: string): Ledger => ({
  seq,
  time: T0,
  type: 'user/message',
  data: { message: { id, role: 'user', content, timestamp: T0 } },
})
const runStart = (seq: number, runId: string, assistantMessageId: string): Ledger => ({
  seq,
  time: T0,
  type: 'run/start',
  data: { runId, kind: 'chat', assistantMessageId, timestamp: T0 },
})

/**
 * 一条**盖过章**的裸 delta(与 `data/chat-source.test.ts` 那两组用例逐字同形)。
 * 新路只认盖过章的 delta —— 没章的那种由账本负责(判词在 chat-source 的 onStream)。
 */
const stamped = (messageId: string, charOffset: number, text: string) => ({
  type: 'text-delta',
  text,
  messageId,
  stamp: {
    messageId,
    runId: 'r1',
    requestIndex: 0,
    partIndex: 0,
    kind: 'text' as const,
    charOffset,
    gen: 0,
  },
})

let emitStream: (payload: SessionStreamPayload) => void = () => undefined

function port(ledgers: Record<string, Ledger[]>): ChatPort {
  const streamSubs = new Set<(payload: SessionStreamPayload) => void>()
  emitStream = (payload) => streamSubs.forEach((fn) => fn(payload))
  return {
    ready: async () => undefined,
    listRaw: async (sessionId: string) => ({ events: [...(ledgers[sessionId] ?? [])] as never }),
    readBlob: async () => ({}),
    onSessionEvent: () => () => undefined,
    onSessionStream: (fn: (payload: SessionStreamPayload) => void) => {
      streamSubs.add(fn)
      return () => void streamSubs.delete(fn)
    },
    sendMessage: async () => ({ success: true }),
    abort: async () => ({ success: true }),
    retryMessage: async () => ({ success: true }),
  } as unknown as ChatPort
}

/**
 * 推一发流并等它上屏。组合与推屏是**按帧合并**的(chat-source 的 rAF 环),
 * 所以断言之前要让那一帧过去 —— 与 `data/chat-source.test.ts` 的 `settle()` 同源。
 */
async function push(emit: () => void): Promise<void> {
  await act(async () => {
    emit()
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
}

const center = () => useWorkbenchStore.getState().regions[CENTER_REGION]
const leaves = () => leavesOf(center())
/** 一格**内容**的那一层(W6-a:内容按 refId 分格,不再按标签分格)。 */
const layerOf = (id: string) => document.querySelector(`[data-pane-tab="${id}"]`)

/**
 * 摆好「两条会话同时在屏」,并把两台机器都拉起来。
 *
 * W6-a:中央区收成**一条标签条**(单叶政策),所以「两条会话并排」在这里演成
 * **同一条标签条上的两格**。被测的三件一个字没变 —— 两条各画各的正文、
 * 流式互不串味、原位换会话不重挂别的那一格 —— 因为 keep-alive 一直是按
 * **内容**算的:后台那一格照样挂着(只是看不见)。
 */
async function mountTwoLeaves() {
  configureChatPort(
    port({
      [A]: [createdIn(1, A), userMessage(2, 'ua', '甲问'), runStart(3, 'r1', 'a1')],
      [B]: [createdIn(1, B), userMessage(2, 'ub', '乙问'), runStart(3, 'r1', 'b1')],
    }),
  )
  const first = leaves()[0].id
  useWorkbenchStore.getState().replaceRef(first, sessionRefOf(''), sessionRefOf(A))
  useWorkbenchStore.getState().openRef(sessionRefOf(B))
  startSessionProjection()

  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<CenterRegion />)
  })
  await waitFor(() => {
    expect(chatSources.get(A)?.getState().status).toBe('ready')
    expect(chatSources.get(B)?.getState().status).toBe('ready')
  })
  return view
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState })
  useWorkbenchStore.getState().reset()
  useWorkbenchStore.getState().seed()
})

afterEach(async () => {
  await act(async () => {
    stopSessionProjection()
    chatSources.resetAll()
  })
  useSessionsSource.getState().reset()
  configureChatPort(undefined)
})

describe('两条会话同时在屏:各画各的,各收各的流', () => {
  it('两格同时挂着,各自画的是自己那条会话的正文', async () => {
    await mountTwoLeaves()
    // W6-a:中央区一条标签条,所以两条会话是**同一片叶里的两格**。
    expect(leaves()).toHaveLength(1)
    expect(leaves()[0].tabs).toHaveLength(2)
    expect(screen.getByText('甲问')).toBeTruthy()
    expect(screen.getByText('乙问')).toBeTruthy()
  })

  it('A 流式期间 B 那棵树一个字都不动(末帧 = 各自冷加载的样子)', async () => {
    await mountTwoLeaves()
    await push(() => emitStream({ sessionId: A, chunk: stamped('a1', 0, '甲答') as never }))
    await waitFor(() => expect(screen.getByText('甲答')).toBeTruthy())
    expect(screen.queryByText('乙答')).toBeNull()

    await push(() => emitStream({ sessionId: B, chunk: stamped('b1', 0, '乙答') as never }))
    await waitFor(() => expect(screen.getByText('乙答')).toBeTruthy())
    // 两条各自的正文都在,而且没有互相串味。
    expect(screen.getByText('甲答')).toBeTruthy()
    expect(chatSources.get(A)!.getState().messages.map((m) => m.id)).toEqual(['ua', 'a1'])
    expect(chatSources.get(B)!.getState().messages.map((m) => m.id)).toEqual(['ub', 'b1'])
  })

  it('**零重挂**:原位换会话,另一格的 DOM 节点前后是同一个', async () => {
    await mountTwoLeaves()
    const leaf = leaves()[0]
    const siblingBefore = layerOf(`session:${B}`)
    expect(siblingBefore).toBeTruthy()

    await act(async () => {
      useWorkbenchStore.getState().replaceRef(leaf.id, sessionRefOf(A), sessionRefOf('another'))
    })

    // 这一格换了内容,而**另一格**连同它的身子一格没动(同一个 DOM 节点)。
    expect(leaves()[0].id).toBe(leaf.id)
    expect(layerOf(`session:${B}`)).toBe(siblingBefore)
    expect(screen.getByText('乙问')).toBeTruthy()
  })
})
