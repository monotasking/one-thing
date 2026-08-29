import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import type { SessionLifecycleEvent } from '@renderer/platform/session-lifecycle'
import { configureSessionsPort } from './sessions-port'
import type { SessionsPort } from './sessions-port'
import { useExposeStore } from '../expose/store'
import { initialExposeState } from '../expose/transitions'
import { REFRESH_THROTTLE_MS, useSessionsSource } from './sessions-source'
import { NOW, ONETHING_DIR, SESSION_META } from './__fixtures__/sessions'

/**
 * 数据源的判据全是纯逻辑(节流 / 增量 vs 重拉 / 缓存失效),所以这里换掉端口就够,
 * 一台 core 都不用起 —— 这正是 sessions-port.ts 存在的理由。
 */

let listMeta: ReturnType<typeof vi.fn>
let getSegments: ReturnType<typeof vi.fn>
let getMessagesPage: ReturnType<typeof vi.fn>
let getUserMarkers: ReturnType<typeof vi.fn>
let emit: ((envelope: SessionEventEnvelope) => void) | undefined
let emitLifecycle: ((event: SessionLifecycleEvent) => void) | undefined
let unsubscribed = 0

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
  emit = undefined
  emitLifecycle = undefined
  unsubscribed = 0
  const port: SessionsPort = {
    ready: async () => undefined,
    listMeta: () => listMeta(),
    getSegments: (id) => getSegments(id),
    getMessagesPage: (id, limit) => getMessagesPage(id, limit),
    getUserMarkers: (id) => getUserMarkers(id),
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
    expect(state.sessions.map((s) => s.id)).toEqual(SESSION_META.map((m) => m.id))
    expect(state.groups.map((g) => g.id)).toEqual([ONETHING_DIR, '/Users/dev/code/transreader', 'collab', 'loose'])
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

  it('c:消息动了 → 抬时间 + 作废那条会话的消息与锚点缓存,但不重拉整表', async () => {
    await start()
    await useSessionsSource.getState().ensureMessages('os-compact')
    await useSessionsSource.getState().ensureMarkers('os-compact')
    expect('os-compact' in useSessionsSource.getState().messages).toBe(true)

    emit?.(envelope('os-compact', SESSION_EVENT_TYPES.MESSAGE_ASSISTANT_CREATED))
    const state = useSessionsSource.getState()
    expect('os-compact' in state.messages).toBe(false)
    expect('os-compact' in state.markers).toBe(false)
    expect(state.sessions.find((s) => s.id === 'os-compact')!.updatedAt).toBe(NOW + 60_000)
    await vi.advanceTimersByTimeAsync(REFRESH_THROTTLE_MS + 50)
    expect(listMeta).toHaveBeenCalledTimes(1)
  })

  it('d:只有 stream:complete 额外作废章节(章节是一轮跑完才推导出来的)', async () => {
    await start()
    await useSessionsSource.getState().ensureChapters('os-compact')
    emit?.(envelope('os-compact', SESSION_EVENT_TYPES.MESSAGE_UPDATED))
    expect('os-compact' in useSessionsSource.getState().chapters).toBe(true)
    emit?.(envelope('os-compact', SESSION_EVENT_TYPES.STREAM_COMPLETE))
    expect('os-compact' in useSessionsSource.getState().chapters).toBe(false)
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
    expect(useSessionsSource.getState().chapters['os-provider']).toEqual([])
    expect(useSessionsSource.getState().status).toBe('ready')
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
    expect(state.sessions).toHaveLength(SESSION_META.length - 1)
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

  it('三份按需缓存一并作废(级联子会话可能不在列表里,却在缓存里躺着)', async () => {
    await start()
    const source = useSessionsSource.getState()
    await source.ensureChapters('os-expose')
    await source.ensureMessages('os-expose')
    await source.ensureMarkers('os-expose')
    expect('os-expose' in useSessionsSource.getState().chapters).toBe(true)

    emitLifecycle!(deleted(['os-expose']))

    const after = useSessionsSource.getState()
    expect('os-expose' in after.chapters).toBe(false)
    expect('os-expose' in after.messages).toBe(false)
    expect('os-expose' in after.markers).toBe(false)
    // 别人的缓存一格没动。
    await useSessionsSource.getState().ensureChapters('os-provider')
    emitLifecycle!(deleted(['lo-notes']))
    expect('os-provider' in useSessionsSource.getState().chapters).toBe(true)
  })

  it('created 那一半本批不接:新建仍走判据 a,不从这条订阅里再说一遍', async () => {
    await start()
    emitLifecycle!({ type: 'created', sessionId: 'brand-new' })
    await vi.advanceTimersByTimeAsync(REFRESH_THROTTLE_MS * 2)
    expect(listMeta).toHaveBeenCalledTimes(1)
    expect(useSessionsSource.getState().sessions).toHaveLength(SESSION_META.length)
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
