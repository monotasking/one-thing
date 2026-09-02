import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { SessionLifecycleEvent } from '@renderer/platform/session-lifecycle'
import { configureSessionsPort } from './sessions-port'
import type { SessionsPort } from './sessions-port'
import { useExposeStore } from '../expose/store'
import { initialExposeState } from '../expose/transitions'
import {
  chaptersQuery,
  markersQuery,
  messagesQuery,
  REFRESH_THROTTLE_MS,
  useSessionsSource,
} from './sessions-source'
import { isListedSession, toSessionSummary } from '../expose/projection'
import { AGENT_SESSION_META, NOW, ONETHING_DIR, SESSION_META } from './__fixtures__/sessions'

/**
 * 数据源的判据全是纯逻辑(节流 / 增量 vs 重拉 / 缓存失效),所以这里换掉端口就够,
 * 一台 core 都不用起 —— 这正是 sessions-port.ts 存在的理由。
 */

/**
 * 夹具里**会被陈列**的那一批(08-31 投影过滤:kind 'agent' / 'room' 不进列表)。
 * 派生而不是写死数字:判据的单产地在 projection.isListedSession,这里跟着它走,
 * 哪天名单改了这些用例是跟着变而不是集体假红。
 */
const LISTED_IDS = SESSION_META.map(toSessionSummary).filter(isListedSession).map((s) => s.id)
const LISTED = LISTED_IDS.length

let listMeta: ReturnType<typeof vi.fn>
let getSegments: ReturnType<typeof vi.fn>
let getMessagesPage: ReturnType<typeof vi.fn>
let getUserMarkers: ReturnType<typeof vi.fn>
let create: ReturnType<typeof vi.fn>
let updateWorkingDirectory: ReturnType<typeof vi.fn>
let emit: ((envelope: SessionEventEnvelope) => void) | undefined
let emitLifecycle: ((event: SessionLifecycleEvent) => void) | undefined
let unsubscribed = 0

/**
 * 「这一格手上有没有答案」—— 三张按需缓存迁进 query 族之后的读法(7c 批)。
 *
 * 从前是 `sessionId in state.chapters`;现在缓存不在 store 里,判据是
 * 「这一族建过这个键**而且**那一格有 data」。`keys()` 只报建过的格,所以这里
 * 不会因为一次查询就把格建出来(那正是 `drop` 之后该消失的东西)。
 */
function cached(id: string): { chapters: boolean; messages: boolean; markers: boolean } {
  const has = (fam: typeof chaptersQuery | typeof messagesQuery | typeof markersQuery): boolean =>
    fam.keys().includes(id) && fam.get(id).get().data !== undefined
  return { chapters: has(chaptersQuery), messages: has(messagesQuery), markers: has(markersQuery) }
}

/** 可控的一发 —— 「在飞的那一刻」要靠它拿住,拿计时器去撞是碰运气。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function envelope(sessionId: string, type: string, extra: Record<string, unknown> = {}): SessionEventEnvelope {
  return {
    sessionId,
    sequence: 1,
    timestamp: NOW + 60_000,
    event: { type, ...extra } as SessionEventEnvelope['event'],
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  listMeta = vi.fn(async () => ({ success: true, sessions: SESSION_META }))
  getSegments = vi.fn(async () => ({ success: true, segments: [] }))
  getMessagesPage = vi.fn(async () => ({ success: true, messages: [] }))
  getUserMarkers = vi.fn(async () => ({ success: true, markers: [] }))
  create = vi.fn(async () => ({ success: true, session: { id: 'new-1' } }))
  updateWorkingDirectory = vi.fn(async () => ({ success: true }))
  emit = undefined
  emitLifecycle = undefined
  unsubscribed = 0
  const port: SessionsPort = {
    ready: async () => undefined,
    listMeta: () => listMeta(),
    getSegments: (id) => getSegments(id),
    getMessagesPage: (id, limit) => getMessagesPage(id, limit),
    getUserMarkers: (id) => getUserMarkers(id),
    create: (request) => create(request),
    updateWorkingDirectory: (id, dir) => updateWorkingDirectory(id, dir),
    onSessionEvent: (callback) => {
      emit = callback
      return () => {
        unsubscribed += 1
        emit = undefined
      }
    },
    onSessionLifecycle: (callback) => {
      emitLifecycle = callback
      return () => {
        emitLifecycle = undefined
      }
    },
  }
  configureSessionsPort(port)
  useSessionsSource.getState().reset()
  useExposeStore.setState({ ...initialExposeState })
})

afterEach(() => {
  useSessionsSource.getState().reset()
  // 不还原成 undefined:那会让后面的用例掉回真 platform(见 test/setup.ts)。
  vi.useRealTimers()
})

async function start() {
  await useSessionsSource.getState().start()
}

describe('start', () => {
  it('拉一次列表并投影成组;状态走到 ready', async () => {
    await start()
    const state = useSessionsSource.getState()
    expect(state.status).toBe('ready')
    // 群房 rm-release 被投影滤掉,其余八条原样在列表里(次序仍是夹具次序)。
    expect(state.sessions.map((s) => s.id)).toEqual(LISTED_IDS)
    expect(state.sessions.map((s) => s.id)).not.toContain('rm-release')
    // 协作组**没有整个消失**:私聊 dm-ying 仍陈列,它一条就把这个组撑住了。
    expect(state.groups.map((g) => g.id)).toEqual([ONETHING_DIR, '/Users/dev/code/transreader', 'collab', 'loose'])
    expect(state.groups.find((g) => g.id === 'collab')!.sessions.map((s) => s.id)).toEqual(['dm-ying'])
    expect(listMeta).toHaveBeenCalledTimes(1)
  })

  it('幂等:再叫一次不会拉第二遍,也不会订第二条 SSE', async () => {
    await start()
    await start()
    expect(listMeta).toHaveBeenCalledTimes(1)
  })

  it('后端说不成功时进 error 并留住那句人话 —— **不回退 mock**', async () => {
    listMeta.mockResolvedValue({ success: false, error: '连不上' })
    await start()
    expect(useSessionsSource.getState().status).toBe('error')
    expect(useSessionsSource.getState().error).toBe('连不上')
    expect(useSessionsSource.getState().sessions).toEqual([])
  })

  it('reset 会退订', async () => {
    await start()
    useSessionsSource.getState().reset()
    expect(unsubscribed).toBe(1)
  })
})

describe('SSE 判据', () => {
  it('a:不认识的 sessionId → 整表重拉(新建会话唯一可靠的迹象)', async () => {
    await start()
    emit?.(envelope('brand-new', SESSION_EVENT_TYPES.MESSAGE_CREATED))
    await vi.advanceTimersByTimeAsync(REFRESH_THROTTLE_MS + 50)
    expect(listMeta).toHaveBeenCalledTimes(2)
  })

  it('a:节流 —— 一串事件塌成一次重拉', async () => {
    await start()
    for (let i = 0; i < 20; i += 1) {
      emit?.(envelope('brand-new', SESSION_EVENT_TYPES.MESSAGE_CREATED))
    }
    await vi.advanceTimersByTimeAsync(REFRESH_THROTTLE_MS + 50)
    expect(listMeta).toHaveBeenCalledTimes(2)
  })

  it('b:改名是增量 —— 只改那一格标题,一次请求都不发', async () => {
    await start()
    emit?.(envelope('os-compact', SESSION_EVENT_TYPES.SESSION_RENAMED, { name: '新名字' }))
    const renamed = useSessionsSource.getState().sessions.find((s) => s.id === 'os-compact')
    expect(renamed?.title).toBe('新名字')
    await vi.advanceTimersByTimeAsync(REFRESH_THROTTLE_MS + 50)
    expect(listMeta).toHaveBeenCalledTimes(1)
  })

  /*
   * ── 7c 的规范修正:作废 = 标脏,不是删格 ──────────────────────────────
   * 从前 SSE 说这条会话动了,就把那一格缓存**整个删掉**(`delete messages[id]`),
   * 于是正开着 Quick Look 的人会看见「内容消失 → 骨架 → 重新长出来」。现在是
   * `invalidate()`:旧答案留在屏上,有人订着就后台补拉、没人订就等下一次 ensure。
   * 所以判据从「表里还有没有这个键」换成「旧答案还在吗 + 下一次 ensure 会不会
   * 真去问」——这两句合起来才是那条修正。
   */
  it('c:消息动了 → 抬时间 + 标脏那条会话的消息与锚点缓存,但不重拉整表', async () => {
    await start()
    await useSessionsSource.getState().ensureMessages('os-compact')
    await useSessionsSource.getState().ensureMarkers('os-compact')
    expect(cached('os-compact').messages).toBe(true)

    emit?.(envelope('os-compact', SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED))
    const state = useSessionsSource.getState()
    // 律②:旧答案一格没丢(从前这里是 `in` 判 false —— 那正是「清屏」的形状)。
    expect(cached('os-compact').messages).toBe(true)
    expect(cached('os-compact').markers).toBe(true)
    expect(state.sessions.find((s) => s.id === 'os-compact')!.updatedAt).toBe(NOW + 60_000)

    // 但确实脏了:下一次 ensure 是**真去问**,不是恒等变换。
    await useSessionsSource.getState().ensureMessages('os-compact')
    await useSessionsSource.getState().ensureMarkers('os-compact')
    expect(getMessagesPage).toHaveBeenCalledTimes(2)
    expect(getUserMarkers).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(REFRESH_THROTTLE_MS + 50)
    expect(listMeta).toHaveBeenCalledTimes(1)
  })

  it('c:那条会话从来没人问过时不凭空建格(标脏对没建过的键是恒等变换)', async () => {
    await start()
    emit?.(envelope('os-compact', SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED))
    expect(messagesQuery.keys()).not.toContain('os-compact')
    expect(markersQuery.keys()).not.toContain('os-compact')
  })

  it('d:只有 stream:complete 额外标脏章节(章节是一轮跑完才推导出来的)', async () => {
    await start()
    await useSessionsSource.getState().ensureChapters('os-compact')
    expect(getSegments).toHaveBeenCalledTimes(1)

    emit?.(envelope('os-compact', SESSION_EVENT_TYPES.MESSAGE_UPDATED))
    await useSessionsSource.getState().ensureChapters('os-compact')
    // 普通消息事件不动章节:这一发 ensure 什么都没发生。
    expect(getSegments).toHaveBeenCalledTimes(1)

    emit?.(envelope('os-compact', SESSION_EVENT_TYPES.STREAM_COMPLETE))
    // 章节旧答案照样在屏上,只是脏了。
    expect(cached('os-compact').chapters).toBe(true)
    await useSessionsSource.getState().ensureChapters('os-compact')
    expect(getSegments).toHaveBeenCalledTimes(2)
  })

  it('b:改名一格缓存都不动 —— 名字变了不等于正文变了', async () => {
    await start()
    await useSessionsSource.getState().ensureMessages('os-compact')
    await useSessionsSource.getState().ensureMarkers('os-compact')
    await useSessionsSource.getState().ensureChapters('os-compact')

    emit?.(envelope('os-compact', SESSION_EVENT_TYPES.SESSION_RENAMED, { name: '新名字' }))
    await useSessionsSource.getState().ensureMessages('os-compact')
    await useSessionsSource.getState().ensureMarkers('os-compact')
    await useSessionsSource.getState().ensureChapters('os-compact')
    expect(getMessagesPage).toHaveBeenCalledTimes(1)
    expect(getUserMarkers).toHaveBeenCalledTimes(1)
    expect(getSegments).toHaveBeenCalledTimes(1)
  })

  it('a 的例外:被投影滤掉的会话在发事件 —— 认识但不陈列,一次都不重拉', async () => {
    // 执行会话(kind 'agent')不进列表,却照样在跑、照样推事件。若判据 a 只问
    // 「在不在 sessions 里」,它每推一条就换来一次整表重拉(拉回来还是被滤掉,
    // 下一条再拍一次)—— 忙起来就是每秒一发。
    listMeta.mockResolvedValue({ success: true, sessions: [...SESSION_META, AGENT_SESSION_META] })
    await start()
    expect(useSessionsSource.getState().sessions.map((s) => s.id)).not.toContain(AGENT_SESSION_META.id)
    expect(listMeta).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 5; i += 1) {
      emit?.(envelope(AGENT_SESSION_META.id, SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED))
    }
    await vi.advanceTimersByTimeAsync(REFRESH_THROTTLE_MS * 2)
    expect(listMeta).toHaveBeenCalledTimes(1)
    // 也没有被当成增量偷偷塞进列表。
    expect(useSessionsSource.getState().sessions).toHaveLength(LISTED)
  })

  it('e:与列表无关的事件一律忽略', async () => {
    await start()
    const before = useSessionsSource.getState().sessions
    emit?.(envelope('os-compact', SESSION_EVENT_TYPES.TOOL_CALL))
    emit?.(envelope('os-compact', SESSION_EVENT_TYPES.PERMISSION_REQUEST))
    expect(useSessionsSource.getState().sessions).toBe(before)
    await vi.advanceTimersByTimeAsync(REFRESH_THROTTLE_MS + 50)
    expect(listMeta).toHaveBeenCalledTimes(1)
  })
})

describe('按需取数', () => {
  it('章节 / 消息 / 锚点各拉一次就缓存,重复叫不再发请求', async () => {
    await start()
    const source = useSessionsSource.getState()
    await Promise.all([source.ensureChapters('os-provider'), source.ensureChapters('os-provider')])
    await source.ensureChapters('os-provider')
    await source.ensureMessages('os-provider')
    await source.ensureMessages('os-provider')
    await source.ensureMarkers('os-provider')
    await source.ensureMarkers('os-provider')
    expect(getSegments).toHaveBeenCalledTimes(1)
    expect(getMessagesPage).toHaveBeenCalledTimes(1)
    expect(getUserMarkers).toHaveBeenCalledTimes(1)
  })

  it('开面时不批量拉:只拉了列表,一条会话的正文都没碰', async () => {
    await start()
    expect(getSegments).not.toHaveBeenCalled()
    expect(getMessagesPage).not.toHaveBeenCalled()
    expect(getUserMarkers).not.toHaveBeenCalled()
  })

  it('拉失败缓存成空表 —— 它是「这条会话没有目录」,不是整个面的错误', async () => {
    await start()
    getSegments.mockRejectedValue(new Error('boom'))
    await useSessionsSource.getState().ensureChapters('os-provider')
    expect(chaptersQuery.get('os-provider').get().data).toEqual([])
    // fetcher 自己把「拉不到」读成空表,所以这一格的 error 是空的(见 orEmpty)。
    expect(chaptersQuery.get('os-provider').get().error).toBeUndefined()
    expect(useSessionsSource.getState().status).toBe('ready')
  })

  it('键控:三族各按 sessionId 分格,一格答案不串到另一格', async () => {
    await start()
    getSegments.mockImplementation(async (id: string) => ({
      success: true,
      segments: [{ id: `${id}-seg`, title: id, detail: '', kind: 'task', startMessageId: 'm1' }],
    }))
    await useSessionsSource.getState().ensureChapters('os-provider')
    await useSessionsSource.getState().ensureChapters('os-compact')
    expect(chaptersQuery.get('os-provider').get().data?.[0].title).toBe('os-provider')
    expect(chaptersQuery.get('os-compact').get().data?.[0].title).toBe('os-compact')
    // 三族之间也不串:章节拉过了不代表消息 / 锚点也拉过了。
    expect(cached('os-provider')).toEqual({ chapters: true, messages: false, markers: false })
  })

  it('锚点同帧双发只飞一发(迁移前它是三条里唯一没有去重的那条)', async () => {
    await start()
    const gate = deferred<{ success: true; markers: never[] }>()
    getUserMarkers.mockReturnValue(gate.promise)
    const both = Promise.all([
      useSessionsSource.getState().ensureMarkers('os-provider'),
      useSessionsSource.getState().ensureMarkers('os-provider'),
    ])
    // 折叠发生在**发请求之前**(原语的 `running` 闸),但请求本身要先 await 一口
    // 端口才发得出去 —— 所以这里放一次微任务,不是等谁落地(gate 还攥着)。
    await vi.advanceTimersByTimeAsync(0)
    expect(getUserMarkers).toHaveBeenCalledTimes(1)
    expect(markersQuery.get('os-provider').get().inflight).toBe(true)
    gate.resolve({ success: true, markers: [] })
    await both
    expect(getUserMarkers).toHaveBeenCalledTimes(1)
  })

  it('律②:后台补拉在飞时,旧章节一直在屏上', async () => {
    await start()
    const seg = (title: string) => ({
      success: true,
      segments: [{ id: 's1', title, detail: '', kind: 'task', startMessageId: 'm1' }],
    })
    getSegments.mockResolvedValue(seg('第一版'))
    await useSessionsSource.getState().ensureChapters('os-provider')
    expect(chaptersQuery.get('os-provider').get().data?.[0].title).toBe('第一版')

    // 有人订着这一格(屏幕上正开着目录),标脏就当场后台补拉。
    const off = chaptersQuery.get('os-provider').subscribe(() => undefined)
    const gate = deferred<ReturnType<typeof seg>>()
    getSegments.mockReturnValue(gate.promise)
    emit?.(envelope('os-provider', SESSION_EVENT_TYPES.STREAM_COMPLETE))

    const flying = chaptersQuery.get('os-provider').get()
    expect(flying.inflight).toBe(true)
    // 这三行就是律②:在飞、旧内容还在、phase 没退回 initial(骨架不会画)。
    expect(flying.data?.[0].title).toBe('第一版')
    expect(flying.phase).toBe('ready')

    gate.resolve(seg('第二版'))
    await vi.advanceTimersByTimeAsync(0)
    expect(chaptersQuery.get('os-provider').get().data?.[0].title).toBe('第二版')
    off()
  })
})


/**
 * H 批:删除不再等下一次整表重拉。判据全在这一批用例里 ——
 * 摘除是**按事件自带的级联名单**、缓存无条件作废、屏幕上的指针由形态机夹持。
 */
describe('会话删除(onSessionLifecycle)', () => {
  const deleted = (ids: string[]): SessionLifecycleEvent => ({
    type: 'deleted',
    sessionId: ids[0],
    cascadedSessionIds: ids,
  })

  it('收到 removed 就当场摘除,不等重拉、不发一条请求', async () => {
    await start()
    emitLifecycle!(deleted(['os-expose']))
    const state = useSessionsSource.getState()
    expect(state.sessions.map((s) => s.id)).not.toContain('os-expose')
    expect(state.sessions).toHaveLength(LISTED - 1)
    expect(listMeta).toHaveBeenCalledTimes(1)
  })

  it('分组跟着重投影:空掉的组整个消失', async () => {
    await start()
    // 独立会话组只有 lo-notes 一条。
    expect(useSessionsSource.getState().groups.map((g) => g.id)).toContain('loose')
    emitLifecycle!(deleted(['lo-notes']))
    expect(useSessionsSource.getState().groups.map((g) => g.id)).not.toContain('loose')
  })

  it('级联名单里的每一条都摘 —— 不是只摘信封上那一条', async () => {
    await start()
    emitLifecycle!(deleted(['rm-release', 'dm-ying']))
    const ids = useSessionsSource.getState().sessions.map((s) => s.id)
    expect(ids).not.toContain('rm-release')
    expect(ids).not.toContain('dm-ying')
  })

  /**
   * 删除是**丢格**(`drop`)而不是标脏:「这条会话没了」不是「答案旧了」——
   * 标脏会让还订着它的那一格当场后台补拉一发注定问不着的请求。
   */
  it('三份按需缓存一并丢格(级联子会话可能不在列表里,却在缓存里躺着)', async () => {
    await start()
    const source = useSessionsSource.getState()
    await source.ensureChapters('os-expose')
    await source.ensureMessages('os-expose')
    await source.ensureMarkers('os-expose')
    expect(cached('os-expose')).toEqual({ chapters: true, messages: true, markers: true })

    emitLifecycle!(deleted(['os-expose']))

    // 格本身没了(不是留着一份脏答案):三族的键面里都不再有它。
    expect(chaptersQuery.keys()).not.toContain('os-expose')
    expect(messagesQuery.keys()).not.toContain('os-expose')
    expect(markersQuery.keys()).not.toContain('os-expose')
    // 丢格不是后台补拉:一条请求都没多发。
    expect(getSegments).toHaveBeenCalledTimes(1)

    // 别人的缓存一格没动。
    await useSessionsSource.getState().ensureChapters('os-provider')
    emitLifecycle!(deleted(['lo-notes']))
    expect(cached('os-provider').chapters).toBe(true)
  })

  it('丢格之后再问就是一次真的首载(不是拿被删那条的旧答案顶)', async () => {
    await start()
    await useSessionsSource.getState().ensureChapters('os-expose')
    expect(getSegments).toHaveBeenCalledTimes(1)
    emitLifecycle!(deleted(['os-expose']))
    await useSessionsSource.getState().ensureChapters('os-expose')
    expect(getSegments).toHaveBeenCalledTimes(2)
  })

  it('还订着那一格的人当场看见「回到出厂」', async () => {
    await start()
    await useSessionsSource.getState().ensureMessages('os-expose')
    const seat = messagesQuery.get('os-expose')
    let heard = 0
    const off = seat.subscribe(() => {
      heard += 1
    })
    emitLifecycle!(deleted(['os-expose']))
    expect(heard).toBe(1)
    expect(seat.get().phase).toBe('initial')
    expect(seat.get().data).toBeUndefined()
    off()
  })

  it('级联名单里从来没人问过的键不会被凭空建出格来', async () => {
    await start()
    emitLifecycle!(deleted(['os-expose', 'never-asked']))
    expect(chaptersQuery.keys()).not.toContain('never-asked')
    expect(messagesQuery.keys()).not.toContain('never-asked')
    expect(markersQuery.keys()).not.toContain('never-asked')
  })

  it('created 那一半本批不接:新建仍走判据 a,不从这条订阅里再说一遍', async () => {
    await start()
    emitLifecycle!({ type: 'created', sessionId: 'brand-new' })
    await vi.advanceTimersByTimeAsync(REFRESH_THROTTLE_MS * 2)
    expect(listMeta).toHaveBeenCalledTimes(1)
    expect(useSessionsSource.getState().sessions).toHaveLength(LISTED)
  })

  it('删除事件本身不落判据 a —— 一次删除不该换来一次整表重拉', async () => {
    await start()
    // 级联删掉的子会话常常不在列表里,信封落到「不认识」正好是判据 a 的形状。
    emit!(envelope('never-seen', SESSION_EVENT_TYPES.SESSION_REMOVED))
    await vi.advanceTimersByTimeAsync(REFRESH_THROTTLE_MS * 2)
    expect(listMeta).toHaveBeenCalledTimes(1)
  })

  it('reset 会把这条订阅也退掉', async () => {
    await start()
    expect(emitLifecycle).toBeDefined()
    useSessionsSource.getState().reset()
    expect(emitLifecycle).toBeUndefined()
  })
})

/**
 * 数据源摘完之后把 id 交给形态机(expose/store.ts 里那条 onSessionsRemoved 订阅)。
 * 这批用例钉的是**那条接缝真的接上了** —— 判据本身在 transitions.test.ts。
 */
describe('删除 → 形态夹持(接缝)', () => {
  it('Quick Look 正开着被删的那条 → 退回总览', async () => {
    await start()
    useExposeStore.getState().openQuickLook('os-expose')
    expect(useExposeStore.getState().view).toEqual({ mode: 'quicklook', sessionId: 'os-expose' })

    emitLifecycle!({ type: 'deleted', sessionId: 'os-expose', cascadedSessionIds: ['os-expose'] })

    expect(useExposeStore.getState().view).toEqual({ mode: 'overview' })
  })

  it('当前会话被删 → 回空态(不自动挑一条顶上)', async () => {
    await start()
    useExposeStore.getState().enterSession('os-compact')
    expect(useExposeStore.getState().currentSessionId).toBe('os-compact')

    emitLifecycle!({ type: 'deleted', sessionId: 'os-compact', cascadedSessionIds: ['os-compact'] })

    expect(useExposeStore.getState().currentSessionId).toBe('')
  })

  it('删的是别的会话时当前会话一格不动', async () => {
    await start()
    useExposeStore.getState().enterSession('os-compact')
    emitLifecycle!({ type: 'deleted', sessionId: 'lo-notes', cascadedSessionIds: ['lo-notes'] })
    expect(useExposeStore.getState().currentSessionId).toBe('os-compact')
  })
})
