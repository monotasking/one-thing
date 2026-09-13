import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { configureChatPort, type ChatPort } from '../../data/chat-port'
import { configureMeterPort } from '../../data/meter-port'
import { configureModelsPort } from '../../data/models-port'
import { meterQuery, useMeterSource } from '../../data/meter-source'
import { prefsQuery, providersQuery, useModelsSource } from '../../data/models-source'
import { catalogQuery } from '../../providers/catalog-query'
import { currentSpaceId } from '../../workspace/current'
import { chatSources } from '../../data/chat-source'
import { seedSessionsSource } from '../../data/__fixtures__/sessions'
import { useSessionsSource } from '../../data/sessions-source'
import { useExposeStore } from '../../expose/store'
import { initialExposeState } from '../../expose/transitions'
import { useStageStore } from '../../stage/store'
import { panelRef } from '../../stage/panel-ref'
import { NOTIFICATIONS_ITEM_ID } from '../../stage/items'
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
  /*
   * **把冷开那一串尾巴在 act 里跑完**(W5-c-3)。两台折叠器按帧合并推屏
   * (chat-source 的 rAF 环),而 `waitFor` 只等到 `status === 'ready'` 那一刻 ——
   * 后面还有几拍落在断言之外,于是订着它们的每一件(消息流、活标题、目录、
   * W5-c 之后还有输入框的忙态)各刷一行「not wrapped in act」。
   * 这一句与下面 `push()` 那只 helper 是同一条:**推屏的那几帧要包在 act 里**。
   */
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  })
  return view
}

/**
 * **两口哑端口**(W5-c-3)。
 *
 * W5-c 之后会话叶自己渲染输入框,于是这一族用例连带把 `Composer` 挂了起来 ——
 * 它挂载时会去订读数(`meterPort`)与拉当前这一家的目录(`modelsPort`)。这两口
 * 在这里**没有被测**,可它们不配的话走的是真实现:一次 `import('platform/connection')`
 * 的动态 import 落在用例之外,React 于是刷 80 行「not wrapped in act」。
 *
 * 所以给它们各一份**当场答完、答的是「没有」**的假实现:零往返、零延迟,
 * 一个字的事实都不造(读数缺席态、目录空表)——这一族要量的两片叶各画各的正文,
 * 与这两口毫无关系。
 *
 * **光有假端口还不够**:`ensure()` 就算端口当场答完,也要过一个微任务才落地 ——
 * 而那一拍排在 `act()` 之后,于是 React 照旧喊「not wrapped in act」。所以这里
 * 连同**把答案直接打进那几格 query**(`patch` 是 kernel 的就地补丁口,不绕过
 * 任何东西;与 `composer/components/Composer.test.tsx` 的同一手):打过之后
 * `ensure` 是「确保问过」→ 恒等,一发都不出门。
 */
function silencePanelPorts(): void {
  configureMeterPort({
    ready: async () => undefined,
    getSessionUsage: async () => ({ apiCostUSD: 0, subscriptionCostUSD: 0, turnCount: 0 }) as never,
    getTokenUsage: async () => ({ success: false, error: '这一族不量读数' }) as never,
  })
  configureModelsPort({
    ready: async () => undefined,
    listProviders: async () => ({ success: true, providers: [] }),
    readProviderSettings: async () => ({ success: false, error: '这一族不量模型' }) as never,
    readSettings: async () => ({ success: true, settings: {} as never }),
    updateSessionModel: async () => ({ success: true }) as never,
  })
  providersQuery.patch([])
  prefsQuery.get(currentSpaceId()).patch({ prefs: { defaultProvider: '', configs: {} }, custom: [] })
  // 读数那三格(两条会话 + 保留键):`null` = 这条会话确实没有读数,不是没问过。
  for (const id of ['', A, B]) meterQuery.get(id).patch({ sessionId: id, tokens: null, usage: null })
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  silencePanelPorts()
  seedSessionsSource()
  useExposeStore.setState({ ...initialExposeState })
  useWorkbenchStore.getState().reset()
  useWorkbenchStore.getState().seed()
})

/*
 * **整只拆台包在 act 里**(W5-c-3)。vitest 的 afterEach 后进先出,它比 RTL 自己的
 * 卸载**先跑** —— 那时这几片叶还挂在屏上,所以每一次 store 归零都是一次真的重渲染。
 * 归零那几口从前只包了一半(`chatSources` 包了、名册没包),于是屏上每一件订着
 * 名册的都刷一行「not wrapped in act」;W5-c 之后叶里多了输入框那一棵子树,
 * 同一条噪音跟着翻倍。判据与 `MeterCard.test.tsx` 的 afterEach 逐字同源。
 */
afterEach(async () => {
  await act(async () => {
    stopSessionProjection()
    chatSources.resetAll()
    useSessionsSource.getState().reset()
    useMeterSource.getState().reset()
    useModelsSource.getState().reset()
    // 目录那一族有自己的家(providers/catalog-query.ts),models-source 的 reset
    // 不收它 —— 两个 reset 收同一格就是两个主人。所以用例自己收。
    catalogQuery.reset()
  })
  configureChatPort(undefined)
  configureMeterPort(undefined)
  configureModelsPort(undefined)
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

/**
 * **输入框属于会话叶**(W5-c 路线 A,正本 `composer-in-leaf-2026-09.md` §4.2)。
 *
 * 报障的原话是「composer 在其他 tab 页也存在,导致会遮挡内容」—— 病根是它挂在
 * 外壳的 `.center` 上,显不显示与那一格装的是什么内容**无关**。裁定之后这件事
 * 是结构上的:哪里有会话叶,哪里才有输入框。
 *
 * 这两条量的正是那句话的两半,而且都是 DOM 上的事实(不是种类表上的):
 *  ① 两片会话叶 → **恰好两块**,各在各自那一格内容层里;
 *  ② 一格非会话内容(这里拿通知瓦当代表) → 它那一层里**一块都没有**,
 *     而且屏幕上的总数一块没多。
 *
 * **反证**:把 `content/kinds/session.tsx` 里那格 `.composerDock` 删掉 → ① 红;
 * 把它搬回 `AppShell` 的 `.center` 上 → ② 红(那一格会横跨整个中央区)。
 */
describe('输入框属于会话叶:有几片叶就有几块,别的内容一块都没有', () => {
  const docks = () => screen.queryAllByTestId('composer-dock')
  /** 这一块输入框长在哪一格内容层里。 */
  const hostOf = (dock: Element) =>
    dock.closest('[data-pane-tab]')?.getAttribute('data-pane-tab') ?? null

  it('两片会话叶 → 恰好两块,各在各自那一格里', async () => {
    await mountTwoLeaves()
    expect(docks()).toHaveLength(2)
    expect(new Set(docks().map(hostOf))).toEqual(new Set([`session:${A}`, `session:${B}`]))
  })

  it('非会话那一格里一块都没有(而且总数一块没多)', async () => {
    await mountTwoLeaves()
    await act(async () => {
      useWorkbenchStore.getState().openRef(panelRef(NOTIFICATIONS_ITEM_ID))
    })
    const panelLayer = layerOf(`panel:${NOTIFICATIONS_ITEM_ID}`)
    expect(panelLayer).toBeTruthy()
    expect(panelLayer!.querySelector('[data-testid="composer-dock"]')).toBeNull()
    expect(docks()).toHaveLength(2)
  })
})
