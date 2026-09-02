import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/ipc/chat'
import type { SpaceRecord } from '@shared/ipc/spaces'
import { configureSpacesPort } from '../../data/spaces-port'
import { configureSessionsPort, type SessionsPort } from '../../data/sessions-port'
import {
  REFRESH_THROTTLE_MS,
  onSessionsRemoved,
  sessionsQuery,
  useSessionsSource,
} from '../../data/sessions-source'
import { useWorkspaceStore } from '../store'
import { currentSpaceId, subscribeCurrentSpace } from '../current'
import { DEFAULT_SPACE_ID } from '../types'
import { NOW } from '../../data/__fixtures__/sessions'

/**
 * 「真切换」批的判据(09-01)。切换工作区 = **换世界**,这里钉住那个世界换的
 * 是什么、怎么换的、以及换的时候屏幕上不许发生什么。
 *
 * 三组:
 *  ① 窄读面(`workspace/current.ts`):解析规则与订阅去重 —— 全应用的换世界都
 *     挂在它上面,它抖一下就是三个数据源各白跑一趟;
 *  ② 会话列表:按空间投影、**切换零重拉**、离场的 id 交给形态机;
 *  ③ 建会话:归属当场落定(这是壳与引擎之间**唯一**的那格接缝)。
 *
 * 凭证与 provider 设置那一组在 `providers/__tests__/space-switch.test.ts`。
 */

const DEFAULT: SpaceRecord = { id: DEFAULT_SPACE_ID, name: '默认', createdAt: 0 }
const WORK: SpaceRecord = { id: 'ws-work', name: '工作', createdAt: 100 }

/** 三条会话:两条在默认空间(一条老会话**没有** workspaceId),一条在 ws-work。 */
const METAS: SessionMeta[] = [
  { id: 'legacy', name: '老会话', createdAt: NOW, updatedAt: NOW } as SessionMeta,
  {
    id: 'in-default',
    name: '默认里的',
    createdAt: NOW,
    updatedAt: NOW,
    workspaceId: DEFAULT_SPACE_ID,
  } as SessionMeta,
  { id: 'in-work', name: '工作里的', createdAt: NOW, updatedAt: NOW, workspaceId: 'ws-work' } as SessionMeta,
]

let listMeta: ReturnType<typeof vi.fn>
let create: ReturnType<typeof vi.fn>

function installSessionsPort(): void {
  listMeta = vi.fn(async () => ({ success: true, sessions: METAS }))
  create = vi.fn(async () => ({ success: true, session: { id: 'new-1' } }))
  const port: SessionsPort = {
    ready: async () => undefined,
    listMeta: () => listMeta(),
    getSegments: async () => ({ success: true, segments: [] }),
    getMessagesPage: async () => ({ success: true, messages: [] }),
    getUserMarkers: async () => ({ success: true, markers: [] }),
    create: (request) => create(request),
    updateWorkingDirectory: async () => ({ success: true }),
    onSessionEvent: () => () => {},
    onSessionLifecycle: () => () => {},
  }
  configureSessionsPort(port)
}

/** 把工作区列表读进来(端口给两个空间),当前停在默认。 */
async function loadSpaces(): Promise<void> {
  configureSpacesPort({
    ready: async () => undefined,
    list: vi.fn(async () => ({ success: true, spaces: [DEFAULT, WORK] })),
    create: vi.fn(async () => ({ success: false, error: 'not stubbed' })),
    update: vi.fn(async () => ({ success: true })),
    remove: vi.fn(async () => ({ success: true, removed: true })),
  })
  await useWorkspaceStore.getState().load()
}

beforeEach(() => {
  useWorkspaceStore.getState().reset()
  useSessionsSource.getState().reset()
  installSessionsPort()
})

afterEach(() => {
  useSessionsSource.getState().reset()
  useWorkspaceStore.getState().reset()
})

describe('currentSpaceId —— 解析过的那一个', () => {
  it('列表还没读到时**原样相信 persist 槽**,不落回默认', () => {
    // 开机首帧:`spaces` 还是空的,但用户记着的是 ws-work。落回 default 会让
    // 会话列表先按 default 过滤一屏再跳成真的那一份 —— 那正是四律里禁的闪。
    useWorkspaceStore.setState({ spaces: [], currentId: 'ws-work' })
    expect(currentSpaceId()).toBe('ws-work')
  })

  it('列表读到了而记着的那个不在里面 = 落回默认(与屏幕上的 ✓ 同一条规则)', async () => {
    useWorkspaceStore.setState({ currentId: 'ws-ghost' })
    await loadSpaces()
    expect(currentSpaceId()).toBe(DEFAULT_SPACE_ID)
  })

  it('记着的那个在列表里就是它', async () => {
    await loadSpaces()
    useWorkspaceStore.getState().switchTo('ws-work')
    expect(currentSpaceId()).toBe('ws-work')
  })
})

describe('subscribeCurrentSpace —— 只在解析过的 id 真变了才叫', () => {
  it('改名 / 换色 / 列表重读一律不叫 —— 否则改个色三个数据源各白跑一趟', async () => {
    await loadSpaces()
    const seen: string[] = []
    const stop = subscribeCurrentSpace((next) => seen.push(next))

    // store 的每一次写都会推一次订阅,这三次都不该穿过去。
    // (09-02 批 5:前两发原本推的是 `busy: true/false` —— 那颗全局忙布尔已经迁进
    //  workspaceMutation,不在 store 上了。换成读列表那两档状态翻转,推的次数
    //  与「不该穿过去」这件事一字不变。)
    useWorkspaceStore.setState({ status: 'loading' })
    useWorkspaceStore.setState({ status: 'ready' })
    useWorkspaceStore.setState({ spaces: [DEFAULT, { ...WORK, name: '工作(改过名)' }] })
    expect(seen).toEqual([])

    useWorkspaceStore.getState().switchTo('ws-work')
    expect(seen).toEqual(['ws-work'])
    stop()
  })

  it('回调拿得到旧的那一个(按空间的缓存要靠它作废)', async () => {
    await loadSpaces()
    const pairs: [string, string][] = []
    const stop = subscribeCurrentSpace((next, previous) => pairs.push([next, previous]))
    useWorkspaceStore.getState().switchTo('ws-work')
    expect(pairs).toEqual([['ws-work', DEFAULT_SPACE_ID]])
    stop()
  })

  it('退订之后不再叫', async () => {
    await loadSpaces()
    const seen: string[] = []
    subscribeCurrentSpace((next) => seen.push(next))()
    useWorkspaceStore.getState().switchTo('ws-work')
    expect(seen).toEqual([])
  })
})

describe('会话列表按空间投影', () => {
  it('默认空间里看得见老会话(缺 workspaceId 读作 default),看不见别的空间的', async () => {
    await loadSpaces()
    await useSessionsSource.getState().start()
    expect(useSessionsSource.getState().sessions.map((s) => s.id)).toEqual(['legacy', 'in-default'])
  })

  it('切过去只剩那个空间的那一条', async () => {
    await loadSpaces()
    await useSessionsSource.getState().start()
    useWorkspaceStore.getState().switchTo('ws-work')
    expect(useSessionsSource.getState().sessions.map((s) => s.id)).toEqual(['in-work'])
  })

  it('**切换零重拉**:同一本全库账重投影一次,一发请求都不打', async () => {
    // 假时钟从头装到尾。**不能等到断言那一刻才装** —— 数据源的重拉是节流的
    // (`scheduleRefresh` 排一个 REFRESH_THROTTLE_MS 之后的 setTimeout),
    // 在它排完之后才换时钟,那颗真定时器会活到用例结束之后才响,于是这条断言
    // 恒绿。反证跑出来的正是这一格:往 `onSpaceChanged` 里塞一发 `scheduleRefresh()`,
    // 先前那版断言照样是绿的。
    vi.useFakeTimers()
    try {
      await loadSpaces()
      await useSessionsSource.getState().start()
      expect(listMeta).toHaveBeenCalledTimes(1)

      useWorkspaceStore.getState().switchTo('ws-work')
      // 新世界的首屏是**同步**就位的 —— 这一句就是「不闪」的机器证明:
      // 没有请求就没有等待,也就没有骨架的位置。
      expect(useSessionsSource.getState().sessions.map((s) => s.id)).toEqual(['in-work'])
      // 换世界一发请求都不打,所以那一格 query 一动没动:还是上一次那份答案。
      expect(sessionsQuery.get().phase).toBe('ready')
      expect(sessionsQuery.get().inflight).toBe(false)

      useWorkspaceStore.getState().switchTo(DEFAULT_SPACE_ID)
      expect(useSessionsSource.getState().sessions.map((s) => s.id)).toEqual([
        'legacy',
        'in-default',
      ])

      // 节流窗口整个走完:排过队的重拉这时该响了,而这里一发都不该有。
      await vi.advanceTimersByTimeAsync(REFRESH_THROTTLE_MS * 3)
      expect(listMeta).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('离场的 id 走 onSessionsRemoved —— 形态机据此夹持焦点、关掉 Quick Look', async () => {
    await loadSpaces()
    await useSessionsSource.getState().start()
    const batches: string[][] = []
    const stop = onSessionsRemoved((ids) => batches.push([...ids]))
    useWorkspaceStore.getState().switchTo('ws-work')
    expect(batches).toEqual([['legacy', 'in-default']])
    stop()
  })

  it('切到一个什么都没有的空间 = 空列表,不是错误态', async () => {
    configureSpacesPort({
      ready: async () => undefined,
      list: vi.fn(async () => ({ success: true, spaces: [DEFAULT, WORK, { id: 'ws-empty', name: '空的', createdAt: 200 }] })),
      create: vi.fn(async () => ({ success: false, error: 'not stubbed' })),
      update: vi.fn(async () => ({ success: true })),
      remove: vi.fn(async () => ({ success: true, removed: true })),
    })
    await useWorkspaceStore.getState().load()
    await useSessionsSource.getState().start()
    useWorkspaceStore.getState().switchTo('ws-empty')
    const st = useSessionsSource.getState()
    expect(st.sessions).toEqual([])
    expect(st.groups).toEqual([])
    // 空列表不是错误态:那一格照样是 ready,一句错都没有。
    expect(sessionsQuery.get().phase).toBe('ready')
    expect(sessionsQuery.get().error).toBeUndefined()
  })
})

describe('建会话的归属', () => {
  it('落在当前工作区上 —— 这是壳与引擎之间唯一那格接缝', async () => {
    await loadSpaces()
    await useSessionsSource.getState().start()
    useWorkspaceStore.getState().switchTo('ws-work')
    await useSessionsSource.getState().create(null)
    expect(create).toHaveBeenCalledWith({ workspaceId: 'ws-work' })
  })

  it('停在默认空间时带的就是 default(而不是不带这一格)', async () => {
    await loadSpaces()
    await useSessionsSource.getState().start()
    await useSessionsSource.getState().create(null)
    expect(create).toHaveBeenCalledWith({ workspaceId: DEFAULT_SPACE_ID })
  })
})
