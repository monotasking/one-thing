import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { SessionLifecycleEvent } from '@onething/client/events/session-lifecycle'
import { configureSessionsPort } from './sessions-port'
import type { SessionsPort } from './sessions-port'
import { useExposeStore } from '../expose/store'
import { initialExposeState } from '../expose/transitions'
import { scopeSpecOf } from '../expose/scopes'
import type { ProjectScope } from '../expose/types'
import {
  chaptersQuery,
  CREATE_KEY,
  markersQuery,
  messagesQuery,
  REFRESH_THROTTLE_MS,
  sessionMutation,
  pinKey,
  sessionsQuery,
  useSessionsSource,
  workdirKey,
} from './sessions-source'
import { AGENT_SESSION_META, NOW, ONETHING_DIR, SESSION_META } from './__fixtures__/sessions'

/**
 * 数据源的判据全是纯逻辑(节流 / 增量 vs 重拉 / 缓存失效),所以这里换掉端口就够,
 * 一台 core 都不用起 —— 这正是 sessions-port.ts 存在的理由。
 */

/**
 * 夹具里会被陈列的那一批 —— **09-04 起就是全部**。
 *
 * 08-31 那道「kind 'agent' / 'room' 不进列表」的投影过滤随方向 A 退役(层级铺开
 * 之后没有一档需要被藏),所以这里不再 filter 一遍:名单就是夹具本身,
 * 次序也是夹具的次序(数据源只按空间过滤,不重排)。
 */
const LISTED_IDS = SESSION_META.map((m) => m.id)
const LISTED = LISTED_IDS.length

let listMeta: ReturnType<typeof vi.fn>
let getSegments: ReturnType<typeof vi.fn>
let getMessagesPage: ReturnType<typeof vi.fn>
let getUserMarkers: ReturnType<typeof vi.fn>
let create: ReturnType<typeof vi.fn>
let updateWorkingDirectory: ReturnType<typeof vi.fn>
let updatePin: ReturnType<typeof vi.fn>
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
  updatePin = vi.fn(async () => ({ success: true }))
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
    updatePin: (id, isPinned) => updatePin(id, isPinned),
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
    // 「读到哪一步了」7e 之后是列表那一格 query 的读数,不再是 store 上一个压扁的
    // status:有过一次答案 = phase 走到 ready(而且从此再也不退回去,律②)。
    expect(sessionsQuery.get().phase).toBe('ready')
    // 09-04:一条都不滤(群房、执行会话、派工全在),次序仍是夹具次序。
    expect(state.sessions.map((s) => s.id)).toEqual(LISTED_IDS)
    expect(state.sessions.map((s) => s.id)).toContain('rm-release')
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
    expect(sessionsQuery.get().error).toBe('连不上')
    // 一次都没成过,所以 phase 还在 initial —— 总览据它画「正在读」还是「没连上」,
    // 判据分开了(从前两件事压在一个 status 里)。
    expect(sessionsQuery.get().phase).toBe('initial')
    expect(useSessionsSource.getState().sessions).toEqual([])
  })

  it('reset 会退订', async () => {
    await start()
    useSessionsSource.getState().reset()
    expect(unsubscribed).toBe(1)
  })
})

/**
 * ── 7e:列表那一发迁 `createQuery` ────────────────────────────────────────
 * 这一批钉的是**迁移换来的那几条性质**,而不是「还能拉到数据」:
 * equals(同答案不换身份)、keep-previous(重拉不清屏)、以及那道
 * 「屏幕那一份到底变没变」的闸(它换掉了从前手记的 onScreen 布尔)。
 */
describe('列表那一格 query', () => {
  it('equals:同一份答案重拉 —— dataRev 不动、data 不换引用、屏幕那一份一格不重投影', async () => {
    await start()
    const rev = sessionsQuery.get().dataRev
    const data = sessionsQuery.get().data
    const { sessions, projects } = useSessionsSource.getState()

    await useSessionsSource.getState().refresh()

    // 确实重问了一遍(不是被折叠掉了)。
    expect(listMeta).toHaveBeenCalledTimes(2)
    // 但答案逐条相同 —— 于是 kernel 留住上一份,身份一格没换(律④)。
    expect(sessionsQuery.get().dataRev).toBe(rev)
    expect(sessionsQuery.get().data).toBe(data)
    // 屏幕那一份也没重投影:`buildProjects` 一次都没跑(引用逐格恒等)。
    expect(useSessionsSource.getState().sessions).toBe(sessions)
    expect(useSessionsSource.getState().projects).toBe(projects)
    // 「上次拉取」照样前进 —— 问过没有与答案变没变是两件事。
    expect(sessionsQuery.get().updatedAt).toBeGreaterThan(0)
  })

  it('内容真变了就该换:dataRev 前进,屏幕那一份跟着重投影', async () => {
    await start()
    const rev = sessionsQuery.get().dataRev
    const sessionsBefore = useSessionsSource.getState().sessions

    listMeta.mockResolvedValue({
      success: true,
      sessions: SESSION_META.map((m) => (m.id === 'os-compact' ? { ...m, name: '换了个名字' } : m)),
    })
    await useSessionsSource.getState().refresh()

    expect(sessionsQuery.get().dataRev).toBe(rev + 1)
    expect(useSessionsSource.getState().sessions).not.toBe(sessionsBefore)
    expect(
      useSessionsSource.getState().sessions.find((s) => s.id === 'os-compact')!.title,
    ).toBe('换了个名字')
  })

  it('律②:重拉在飞时旧列表一直在屏上,phase 不退回 initial(骨架一次都不画)', async () => {
    await start()
    const before = useSessionsSource.getState().sessions
    const gate = deferred<{ success: true; sessions: typeof SESSION_META }>()
    listMeta.mockReturnValue(gate.promise)

    const flying = useSessionsSource.getState().refresh()
    await vi.advanceTimersByTimeAsync(0)

    // 这三行就是律②:在飞、旧内容还在、phase 停在 ready。
    expect(sessionsQuery.get().inflight).toBe(true)
    expect(sessionsQuery.get().phase).toBe('ready')
    expect(useSessionsSource.getState().sessions).toBe(before)

    gate.resolve({ success: true, sessions: SESSION_META })
    await flying
    expect(useSessionsSource.getState().sessions).toBe(before)
  })

  it('重拉失败:那句原话记在这一格上,而上一份列表**一条都没少**', async () => {
    await start()
    const before = useSessionsSource.getState().sessions
    listMeta.mockResolvedValue({ success: false, error: '断了' })

    await useSessionsSource.getState().refresh()

    expect(sessionsQuery.get().error).toBe('断了')
    expect(sessionsQuery.get().phase).toBe('ready')
    expect(useSessionsSource.getState().sessions).toBe(before)
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

  it('a 问的是**全库账**不是屏幕:账上认识的会话在发事件,一次都不重拉', async () => {
    // 判据 a 的产地是 `ledger()`(listMeta 交下来那一份),不是 `state.sessions`。
    // 09-04 之前这条用例靠「被投影滤掉的执行会话」来分辨这两者;过滤退役之后
    // 分辨的活交给**空间**:别的工作区里的会话在账上、不在屏幕上(下一组钉它)。
    // 这一条守住剩下那一半:在账上的会话推事件,不该换来一次整表重拉。
    listMeta.mockResolvedValue({ success: true, sessions: [...SESSION_META, AGENT_SESSION_META] })
    await start()
    expect(useSessionsSource.getState().sessions.map((s) => s.id)).toContain(AGENT_SESSION_META.id)
    expect(listMeta).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 5; i += 1) {
      emit?.(envelope(AGENT_SESSION_META.id, SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED))
    }
    await vi.advanceTimersByTimeAsync(REFRESH_THROTTLE_MS * 2)
    expect(listMeta).toHaveBeenCalledTimes(1)
    expect(useSessionsSource.getState().sessions).toHaveLength(LISTED + 1)
  })

  /**
   * 「别的工作区里的会话来一条 delta **刻意不重投影**」—— 7e 迁移必须原样保住的
   * 那条性质。判据换了产地(从手记的一格 onScreen 布尔换成算出来的事实),
   * 但可观察的行为逐字相同:账上照样更新、屏幕那一份一格不动、一发请求都不打。
   */
  it('别的工作区里的会话来一条 delta:账上照样更新,屏幕那一份**刻意不重投影**', async () => {
    const elsewhere = {
      id: 'in-other-space',
      name: '别处的会话',
      createdAt: NOW,
      updatedAt: NOW,
      workspaceId: 'ws-other',
    }
    listMeta.mockResolvedValue({ success: true, sessions: [...SESSION_META, elsewhere] })
    await start()
    // 它认识(在账上),但不在当前工作区的屏幕那一份里。
    expect(sessionsQuery.get().data!.map((s) => s.id)).toContain('in-other-space')
    expect(useSessionsSource.getState().sessions.map((s) => s.id)).not.toContain('in-other-space')

    const sessions = useSessionsSource.getState().sessions
    const projects = useSessionsSource.getState().projects
    const rev = sessionsQuery.get().dataRev

    emit?.(envelope('in-other-space', SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED))

    // 账上那一格真的抬了时间 —— 切回那个空间时次序就是对的。
    expect(sessionsQuery.get().dataRev).toBe(rev + 1)
    expect(sessionsQuery.get().data!.find((s) => s.id === 'in-other-space')!.updatedAt).toBe(
      NOW + 60_000,
    )
    // 屏幕那一份**同一个数组**:`buildProjects` 一次都没跑(律④)。
    expect(useSessionsSource.getState().sessions).toBe(sessions)
    expect(useSessionsSource.getState().projects).toBe(projects)
    // 也没有被判据 a 当成新建 —— 一发重拉都不打。
    await vi.advanceTimersByTimeAsync(REFRESH_THROTTLE_MS * 2)
    expect(listMeta).toHaveBeenCalledTimes(1)
  })

  it('a 的另一半:认识的会话只打增量 —— 一发请求都不发,而且那一格真的变了', async () => {
    await start()
    const rev = sessionsQuery.get().dataRev
    emit?.(envelope('os-compact', SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED))
    expect(sessionsQuery.get().dataRev).toBe(rev + 1)
    await vi.advanceTimersByTimeAsync(REFRESH_THROTTLE_MS * 2)
    expect(listMeta).toHaveBeenCalledTimes(1)
  })

  it('增量抬不动就不抬:信封比账上还旧时,连一次重投影都没有', async () => {
    await start()
    const sessions = useSessionsSource.getState().sessions
    const rev = sessionsQuery.get().dataRev
    // 这条会话的 updatedAt 就是 NOW 附近,给一个更早的时刻。
    emit?.({
      sessionId: 'os-compact',
      sequence: 1,
      timestamp: 1,
      event: { type: SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED } as SessionEventEnvelope['event'],
    })
    expect(sessionsQuery.get().dataRev).toBe(rev)
    expect(useSessionsSource.getState().sessions).toBe(sessions)
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
    // 列表那一格一点事都没有:一条会话没有目录,不是整个面读不到了。
    expect(sessionsQuery.get().error).toBeUndefined()
    expect(sessionsQuery.get().phase).toBe('ready')
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
 * ── 7e:写路迁 `createMutation` ────────────────────────────────────────────
 * 两口一个联合(`create` / `workdir`),而这一批钉的是迁移换来的三条:
 * 逐格忙态(律③)、对账排在返回之前(调用方的承诺)、失败那句原话原样交出去。
 * 「建会话打了哪几发、次序是什么」在 data/session-create.test.ts,不在这里重抄。
 */
describe('写路:一只 mutation,两口一个联合', () => {
  it('忙态是**逐格**的:建会话占 CREATE_KEY,换目录占 workdir:<会话 id>', async () => {
    await start()
    const gate = deferred<{ success: true; session: { id: string } }>()
    create.mockReturnValue(gate.promise)

    const flying = useSessionsSource.getState().create(null)
    await vi.advanceTimersByTimeAsync(0)

    expect(sessionMutation.isPending(CREATE_KEY)).toBe(true)
    // 别的格一格都没被点亮 —— 不是整面一颗忙布尔。
    expect(sessionMutation.isPending(workdirKey('os-compact'))).toBe(false)

    gate.resolve({ success: true, session: { id: 'new-1' } })
    await flying
    expect(sessionMutation.isPending(CREATE_KEY)).toBe(false)
  })

  it('换目录的忙态跟着会话走:换 A 的目录,B 那一格不亮', async () => {
    await start()
    const gate = deferred<{ success: true }>()
    updateWorkingDirectory.mockReturnValue(gate.promise)

    const flying = useSessionsSource.getState().setWorkingDirectory('os-compact', ONETHING_DIR)
    await vi.advanceTimersByTimeAsync(0)

    expect(sessionMutation.isPending(workdirKey('os-compact'))).toBe(true)
    expect(sessionMutation.isPending(workdirKey('os-provider'))).toBe(false)
    expect(sessionMutation.isPending(CREATE_KEY)).toBe(false)

    gate.resolve({ success: true })
    await flying
    expect(sessionMutation.isPending(workdirKey('os-compact'))).toBe(false)
  })

  it('create:回来的那一刻列表里已经有它 —— 对账那一发排在返回之前', async () => {
    await start()
    create.mockImplementation(async () => {
      // 建成之后线上就多了这一条,重拉才看得见。
      listMeta.mockResolvedValue({
        success: true,
        sessions: [...SESSION_META, { id: 'new-1', name: 'New Chat', createdAt: NOW, updatedAt: NOW }],
      })
      return { success: true, session: { id: 'new-1' } }
    })
    expect(useSessionsSource.getState().sessions.map((s) => s.id)).not.toContain('new-1')

    const outcome = await useSessionsSource.getState().create(null)

    expect(outcome).toEqual({ ok: true, sessionId: 'new-1' })
    expect(listMeta).toHaveBeenCalledTimes(2)
    expect(useSessionsSource.getState().sessions.map((s) => s.id)).toContain('new-1')
  })

  /**
   * 次序那一格:**控件**的忙态在对账之前就解除(律③要的那一拍 —— 对账是后台的
   * 事,不该把钮多按住一拍),而 **create 自己**多等一口(它对调用方的承诺是
   * 「回来的那一刻列表里已经有它」)。两件事各归各位,这条用例同时钉住两头。
   */
  it('忙态在对账之前解除,而 create 自己要等到对账落地才返回', async () => {
    await start()
    const gate = deferred<{ success: true; sessions: typeof SESSION_META }>()
    listMeta.mockReturnValue(gate.promise)

    let returned = false
    const flying = useSessionsSource.getState().create(null)
    void flying.then(() => {
      returned = true
    })
    await vi.advanceTimersByTimeAsync(0)

    // 建那一发已经落地:控件解禁了(钮上的「…中」这时就该没了)。
    expect(sessionMutation.isPending(CREATE_KEY)).toBe(false)
    // 但 create 还没回来 —— 它在等对账那一发。
    expect(returned).toBe(false)
    expect(listMeta).toHaveBeenCalledTimes(2)

    gate.resolve({ success: true, sessions: SESSION_META })
    await flying
    expect(returned).toBe(true)
  })

  it('setWorkingDirectory 成功:同步重拉,回来的那一刻归属已经跟着换了', async () => {
    await start()
    // 归属读的是**投影出来的事实**(`session.projectId`),不是一份分好组的表 ——
    // 09-04 P2 之后 store 里没有 `groups` 那一格了(分组是 list-model 的事)。
    const inProject = () =>
      useSessionsSource
        .getState()
        .sessions.filter((s) => s.projectId === ONETHING_DIR)
        .map((s) => s.id)
    expect(inProject()).not.toContain('lo-notes')
    listMeta.mockImplementation(async () => ({
      success: true,
      sessions: SESSION_META.map((m) =>
        m.id === 'lo-notes' ? { ...m, workingDirectory: ONETHING_DIR } : m,
      ),
    }))

    const outcome = await useSessionsSource.getState().setWorkingDirectory('lo-notes', ONETHING_DIR)

    expect(outcome).toEqual({ ok: true })
    expect(updateWorkingDirectory).toHaveBeenCalledWith('lo-notes', ONETHING_DIR)
    expect(listMeta).toHaveBeenCalledTimes(2)
    expect(inProject()).toContain('lo-notes')
  })

  it('setWorkingDirectory:后端说不行 → **原话**原样交出去,一次重拉都不发', async () => {
    await start()
    updateWorkingDirectory.mockResolvedValue({
      success: false,
      error: 'Working directory must stay inside the workspace sandbox root.',
    })

    const outcome = await useSessionsSource.getState().setWorkingDirectory('lo-notes', '/nope')

    expect(outcome).toEqual({
      ok: false,
      error: 'Working directory must stay inside the workspace sandbox root.',
    })
    // 写没成 = 列表没有任何理由变。
    expect(listMeta).toHaveBeenCalledTimes(1)
  })

  it('setWorkingDirectory:端口自己抛也收成同一种答案(不是一次没人接的 rejection)', async () => {
    await start()
    updateWorkingDirectory.mockRejectedValue(new Error('socket 断了'))

    const outcome = await useSessionsSource.getState().setWorkingDirectory('lo-notes', '/nope')

    expect(outcome).toEqual({ ok: false, error: 'socket 断了' })
    expect(listMeta).toHaveBeenCalledTimes(1)
  })

  /**
   * ── 置顶那一口(09-04)────────────────────────────────────────────────────
   * 与换目录同形,但对账的必要性更硬:后端这一发**一条事件都不推**
   * (`updateOnethingSessionPinForIpc` 不叫 `notifySessionIndexChanged`),
   * 不重拉的话按下图钉之后屏幕一动不动。所以这一组的头一条钉的就是那一发重拉。
   *
   * P1 又在它前面加了一层**乐观补丁**(交互四律第 1 条:写操作就地更新):
   * 屏幕上那一行必须在**这一发还没回来**的时候就搬进「置顶」节 —— 下面两条
   * 钉的就是那一层的两半(翻得动 / 翻得回来)。
   */
  it('乐观:那一发还在飞,账本上就已经翻了(就地更新,律①)', async () => {
    await start()
    const gate = deferred<{ success: true }>()
    updatePin.mockReturnValue(gate.promise)

    const flying = useSessionsSource.getState().setPinned('lo-notes', true)
    // 一次 await 都没走 —— 补丁是**同步**打的,不是等 microtask。
    expect(useSessionsSource.getState().sessions.find((x) => x.id === 'lo-notes')!.isPinned).toBe(
      true,
    )

    gate.resolve({ success: true })
    await flying
  })

  it('乐观那一笔在**写没成**时翻回去 —— 屏幕上不许留一条后端并不认的置顶', async () => {
    await start()
    updatePin.mockResolvedValue({ success: false, error: '这条会话不在' })

    const result = await useSessionsSource.getState().setPinned('lo-notes', true)

    expect(result).toEqual({ ok: false, error: '这条会话不在' })
    /*
     * 这一条真的能判:写没成 = `settle` 直接返回 = **一次重拉都不发**
     * (下一行钉着),所以账本上留下来的只可能是乐观那一笔本身。
     * 反证:把 `if (!outcome.ok) flip(!isPinned)` 摘掉 → 这一条当场红。
     */
    expect(listMeta).toHaveBeenCalledTimes(1)
    expect(useSessionsSource.getState().sessions.find((x) => x.id === 'lo-notes')!.isPinned).toBe(
      false,
    )
  })

  it('setPinned 成功:同步重拉,回来的那一刻列表里那条已经是置顶的', async () => {
    await start()
    expect(useSessionsSource.getState().sessions.find((x) => x.id === 'lo-notes')!.isPinned).toBe(
      false,
    )
    listMeta.mockResolvedValue({
      success: true,
      sessions: SESSION_META.map((m) => (m.id === 'lo-notes' ? { ...m, isPinned: true } : m)),
    })

    const result = await useSessionsSource.getState().setPinned('lo-notes', true)

    expect(result).toEqual({ ok: true })
    expect(updatePin).toHaveBeenCalledWith('lo-notes', true)
    expect(listMeta).toHaveBeenCalledTimes(2)
    expect(useSessionsSource.getState().sessions.find((x) => x.id === 'lo-notes')!.isPinned).toBe(
      true,
    )
  })

  it('置顶的忙态按会话分格(pin:<id>),与换目录那一格互不干涉', async () => {
    await start()
    const gate = deferred<{ success: true }>()
    updatePin.mockReturnValue(gate.promise)

    const flying = useSessionsSource.getState().setPinned('os-compact', true)
    await vi.advanceTimersByTimeAsync(0)

    expect(sessionMutation.isPending(pinKey('os-compact'))).toBe(true)
    expect(sessionMutation.isPending(pinKey('os-provider'))).toBe(false)
    expect(sessionMutation.isPending(workdirKey('os-compact'))).toBe(false)

    gate.resolve({ success: true })
    await flying
    expect(sessionMutation.isPending(pinKey('os-compact'))).toBe(false)
  })

  it('后端说不行 → **原话**原样交出去,一次重拉都不发', async () => {
    await start()
    updatePin.mockResolvedValue({ success: false, error: '这条会话不在' })
    const result = await useSessionsSource.getState().setPinned('lo-notes', true)
    expect(result).toEqual({ ok: false, error: '这条会话不在' })
    expect(listMeta).toHaveBeenCalledTimes(1)
  })

  it('端口自己抛也收成同一种答案(不是一次没人接的 rejection)', async () => {
    await start()
    updatePin.mockRejectedValue(new Error('socket 断了'))
    expect(await useSessionsSource.getState().setPinned('lo-notes', true)).toEqual({
      ok: false,
      error: 'socket 断了',
    })
  })

  it('空 id 连一发都不打 —— 它是问错了的话,不是一次失败的写', async () => {
    await start()
    expect(await useSessionsSource.getState().setPinned('', true)).toEqual({
      ok: false,
      error: 'sessionId 为空',
    })
    expect(updatePin).not.toHaveBeenCalled()
  })

  it('setWorkingDirectory:空 id 连一发都不打 —— 它是问错了的话,不是一次失败的写', async () => {
    await start()
    const outcome = await useSessionsSource.getState().setWorkingDirectory('', ONETHING_DIR)
    expect(outcome).toEqual({ ok: false, error: 'sessionId 为空' })
    expect(updateWorkingDirectory).not.toHaveBeenCalled()
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

  it('屏幕那一份跟着重投影:删光「无项目」那一档之后它一条都不剩', async () => {
    const LOOSE_SCOPE: ProjectScope = { kind: 'loose' }
    await start()
    // 无项目会话现在有三条:随手记、孤儿派工、执行会话 —— 09-04 起后两档也进
    // 列表了,所以要删满才空得掉。判据从「组消失」改成「屏幕那一份里没有了」:
    // P2 之后分组不在数据源这一层(它是 `expose/list-model` 的事)。
    // 判据读**那张表**(`SCOPE_SPECS` 的 loose 一行),不在测试里手抄一份
    // 「没目录且不是协作」—— 两份判据必然分叉(旧 COLLAB_KINDS 那一案的形状)。
    const isLoose = scopeSpecOf(LOOSE_SCOPE).predicate
    const loose = () =>
      useSessionsSource
        .getState()
        .sessions.filter((s) => isLoose(s, LOOSE_SCOPE))
        .map((s) => s.id)
    expect(loose()).toEqual(expect.arrayContaining(['lo-notes', 'wk-orphan', 'ag-xiaoli']))
    emitLifecycle!(deleted(['lo-notes', 'wk-orphan', 'ag-xiaoli']))
    expect(loose()).toEqual([])
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
