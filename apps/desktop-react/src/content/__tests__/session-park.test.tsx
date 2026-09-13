import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'
import { configureChatPort, type ChatPort } from '../../data/chat-port'
import { chatSources } from '../../data/chat-source'
import { configureSessionsPort, type SessionsPort } from '../../data/sessions-port'
import { useSessionsSource } from '../../data/sessions-source'
import { useExposeStore } from '../../expose/store'
import { initialExposeState } from '../../expose/transitions'
import { useStageStore } from '../../stage/store'
import { CenterRegion } from '../../workbench/CenterRegion'
import { keptContentsOf, resetKeptContents } from '../../workbench/kept-contents'
import { CENTER_REGION } from '../../workbench/regions'
import { useWorkbenchStore } from '../../workbench/store'
import { leavesOf } from '../../workbench/tree'
import '../kinds'
import { enterSessionInWorkbench } from '../session-open'
import {
  SESSION_VIEW_PARK_LIMIT,
  clearSessionParks,
  parkSessionSwap,
  parkedSessionIds,
  parkedSessionIdsOf,
  reconcileSessionParks,
  stopSessionParks,
} from '../session-park'
import { startSessionProjection, stopSessionProjection } from '../session-projection'
import { sessionRefOf } from '../session-ref'
import type { SessionLifecycleEvent } from '@onething/client/events/session-lifecycle'
import type { SessionMeta } from '@shared/ipc/chat'

/**
 * **组件级停靠**(2026-09-10,交互预算第三单;正本 `content/session-park.ts` 文件头)。
 *
 * 这一组问的是屏幕与那本账:切走的那片会话**是不是同一个 DOM 节点**、切回来
 * 有没有重挂、上限到了谁被卸载、真删那一拍谁没了、两片叶各说各的。
 * 停靠期间那三样几何活计停不停手,由 `ChatStream.test.tsx` 那一组钉(判据在
 * 容器几何上,不在这张账上)。
 */

const T0 = 1_700_000_000_000
const IDS = ['pk-a', 'pk-b', 'pk-c', 'pk-d', 'pk-e'] as const

type Ledger = { seq: number; time: number; type: string; data: unknown }

const ledgerOf = (sessionId: string): Ledger[] => [
  { seq: 1, time: T0, type: 'session/created', data: { sessionId } },
  {
    seq: 2,
    time: T0,
    type: 'user/message',
    data: { message: { id: `${sessionId}-m1`, role: 'user', content: `${sessionId} 说的话`, timestamp: T0 } },
  },
]

function chatPort(): ChatPort {
  return {
    ready: async () => undefined,
    listRaw: async (sessionId: string) => ({ events: ledgerOf(sessionId) as never }),
    readBlob: async () => ({}),
    onSessionEvent: () => () => undefined,
    onSessionStream: () => () => undefined,
    sendMessage: async () => ({ success: true }),
    abort: async () => ({ success: true }),
    retryMessage: async () => ({ success: true }),
  } as unknown as ChatPort
}

const meta = (id: string): SessionMeta =>
  ({ id, name: id, createdAt: T0, updatedAt: T0 }) as SessionMeta

/** 名册那条「真的被删了」的产地 —— 真端口,真订阅(不手工叫 listener)。 */
let emitLifecycle: ((event: SessionLifecycleEvent) => void) | undefined

function sessionsPort(): SessionsPort {
  return {
    ready: async () => undefined,
    listMeta: async () => ({ success: true, sessions: IDS.map(meta) }),
    getSegments: async () => ({ success: true, segments: [] }),
    getMessagesPage: async () => ({ success: true, messages: [] }),
    getUserMarkers: async () => ({ success: true, markers: [] }),
    create: async () => ({ success: true, session: { id: 'new-1' } }),
    updateWorkingDirectory: async () => ({ success: true }),
    updatePin: async () => ({ success: true }),
    rename: async () => ({ success: true }),
    delete: async () => ({ success: true }),
    onSessionEvent: () => () => undefined,
    onSessionLifecycle: (callback: (event: SessionLifecycleEvent) => void) => {
      emitLifecycle = callback
      return () => {
        emitLifecycle = undefined
      }
    },
  } as unknown as SessionsPort
}

const center = () => useWorkbenchStore.getState().regions[CENTER_REGION]
const firstLeaf = () => leavesOf(center())[0].id
/** 有标签的那一层。 */
const tabLayer = (id: string) => document.querySelector(`[data-pane-tab="session:${id}"]`)
/** **停靠**的那一层(没有标签,所以取件口是另一个名字 —— 判词在 `kept-contents.ts`)。 */
const parkedLayer = (id: string) => document.querySelector(`[data-pane-kept="session:${id}"]`)
/** 这条会话此刻在屏上有没有一份实例(哪一种都算)。 */
const anyLayer = (id: string) => tabLayer(id) ?? parkedLayer(id)

/** 进一条会话并等它落定(拼贴台那一句是同步的,数据那一头是异步的)。 */
async function enter(sessionId: string): Promise<void> {
  await act(async () => {
    enterSessionInWorkbench(sessionId)
    await Promise.resolve()
  })
  await waitFor(() => expect(chatSources.get(sessionId)?.getState().status).toBe('ready'))
}

async function mountCenter() {
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<CenterRegion />)
  })
  return view
}

beforeEach(async () => {
  useStageStore.setState({ locale: 'zh' })
  configureChatPort(chatPort())
  configureSessionsPort(sessionsPort())
  useExposeStore.setState({ ...initialExposeState })
  useWorkbenchStore.getState().reset()
  clearSessionParks()
  resetKeptContents()
  await act(async () => {
    await useSessionsSource.getState().start()
  })
  startSessionProjection()
})

afterEach(async () => {
  await act(async () => {
    stopSessionProjection()
    stopSessionParks()
    chatSources.resetAll()
    useSessionsSource.getState().reset()
  })
  configureChatPort(undefined)
  emitLifecycle = undefined
})

describe('切走 / 切回:同一棵树藏起来,不卸载不重挂', () => {
  it('切走的那片会话叶是**同一个 DOM 节点**,只是挂上了 inert + aria-hidden', async () => {
    await mountCenter()
    await enter(IDS[0])
    const before = tabLayer(IDS[0])
    expect(before).toBeTruthy()

    await enter(IDS[1])

    // 反证的靶心:这一句在拆掉停靠之后是 `null`(旧那一层被卸载了)。
    const parked = parkedLayer(IDS[0])
    expect(parked).toBe(before)
    expect(parked?.hasAttribute('inert')).toBe(true)
    expect(parked?.getAttribute('aria-hidden')).toBe('true')
    expect(parked?.hasAttribute('data-pane-on')).toBe(false)
    // 停靠的那一层**不是一格标签** —— 那个取件口留给真标签(三条真机门按它枚举)。
    expect(tabLayer(IDS[0])).toBeNull()
    // 新来的那条正常显形。
    expect(tabLayer(IDS[1])?.hasAttribute('data-pane-on')).toBe(true)
  })

  it('切回去还是那一个节点(不重挂),而被换下来的那条接着停靠', async () => {
    await mountCenter()
    await enter(IDS[0])
    const nodeA = tabLayer(IDS[0])
    await enter(IDS[1])
    const nodeB = tabLayer(IDS[1])

    await enter(IDS[0])

    expect(tabLayer(IDS[0])).toBe(nodeA)
    expect(tabLayer(IDS[0])?.hasAttribute('inert')).toBe(false)
    expect(parkedLayer(IDS[1])).toBe(nodeB)
    // 切回来的那条从池子里被摘掉了(它已经有标签,留着就是同一格内容两层)。
    expect(parkedSessionIdsOf(firstLeaf())).toEqual([IDS[1]])
  })

  it('保留键那一格不进池:冷启动点第一条会话不会留下一棵空树', async () => {
    await mountCenter()
    await enter(IDS[0])
    expect(parkedSessionIdsOf(firstLeaf())).toEqual([])
    expect(anyLayer('new')).toBeNull()
  })
})

describe('上限:第四条把最早那条挤下去,挤下去的真的卸载', () => {
  it(`一片叶最多停靠 ${SESSION_VIEW_PARK_LIMIT} 条`, async () => {
    await mountCenter()
    for (const id of IDS) await enter(id)

    const leaf = firstLeaf()
    // 最近切走的排在最前:d, c, b —— a 被挤掉了。
    expect(parkedSessionIdsOf(leaf)).toEqual([IDS[3], IDS[2], IDS[1]])
    expect(anyLayer(IDS[0])).toBeNull()
    expect(parkedLayer(IDS[1])).toBeTruthy()
    expect(tabLayer(IDS[4])).toBeTruthy()
  })

  it('被挤下去那条的数据机器落进 C1 那个池,不是被丢掉', async () => {
    await mountCenter()
    for (const id of IDS) await enter(id)
    // 视图卸载 → 引用归零 → 下一拍停进数据池(那一拍排在微任务里)。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(chatSources.dockedIds()).toContain(IDS[0])
  })
})

describe('真删:名册说这条没了,停靠的那一格当场卸载', () => {
  it('删掉一条正停靠着的会话 → 它那一层从屏幕上消失', async () => {
    await mountCenter()
    await enter(IDS[0])
    await enter(IDS[1])
    expect(parkedLayer(IDS[0])).toBeTruthy()

    await act(async () => {
      emitLifecycle?.({ type: 'deleted', sessionId: IDS[0], cascadedSessionIds: [IDS[0]] })
      await Promise.resolve()
    })

    expect(anyLayer(IDS[0])).toBeNull()
    expect(parkedSessionIdsOf(firstLeaf())).toEqual([])
  })
})

describe('这本账自己:归属、对账、引用', () => {
  beforeEach(() => {
    clearSessionParks()
  })

  it('两片叶各自一只池 —— 一边停靠不会写到另一边头上', () => {
    parkSessionSwap('leaf-1', sessionRefOf(IDS[0]), sessionRefOf(IDS[1]))
    parkSessionSwap('leaf-2', sessionRefOf(IDS[2]), sessionRefOf(IDS[3]))
    expect(parkedSessionIdsOf('leaf-1')).toEqual([IDS[0]])
    expect(parkedSessionIdsOf('leaf-2')).toEqual([IDS[2]])
    expect(keptContentsOf('leaf-1').map((ref) => ref.key)).toEqual([IDS[0]])
    expect(keptContentsOf('leaf-2').map((ref) => ref.key)).toEqual([IDS[2]])
    // 引用账拿的是两片叶的并集 —— 停靠着的会话照旧收流。
    expect(parkedSessionIds().sort()).toEqual([IDS[0], IDS[2]].sort())
  })

  it('叶没了(分屏收起 / 换了一棵树)→ 对账把整格丢掉', () => {
    parkSessionSwap('leaf-gone', sessionRefOf(IDS[0]), sessionRefOf(IDS[1]))
    expect(keptContentsOf('leaf-gone')).toHaveLength(1)
    reconcileSessionParks({})
    expect(keptContentsOf('leaf-gone')).toHaveLength(0)
    expect(parkedSessionIds()).toEqual([])
  })

  it('同一格内容在别处成了标签 → 对账让停靠让位(两处各挂一层会抢 holder)', async () => {
    await mountCenter()
    await enter(IDS[0])
    await enter(IDS[1])
    expect(parkedSessionIdsOf(firstLeaf())).toEqual([IDS[0]])
    // 在**同一片叶**里另开一格标签装它(newTab 那条路的形状)。
    await act(async () => {
      useWorkbenchStore.getState().openRef(sessionRefOf(IDS[0]), { region: CENTER_REGION })
      await Promise.resolve()
    })
    expect(parkedSessionIdsOf(firstLeaf())).toEqual([])
    expect(document.querySelectorAll(`[data-pane-kept="session:${IDS[0]}"]`)).toHaveLength(0)
  })

  it('换工作区那一拍整池清掉(数据池不清 —— 判词在 layout-scope 上)', () => {
    parkSessionSwap('leaf-1', sessionRefOf(IDS[0]), sessionRefOf(IDS[1]))
    clearSessionParks()
    expect(parkedSessionIds()).toEqual([])
    expect(keptContentsOf('leaf-1')).toHaveLength(0)
  })
})
