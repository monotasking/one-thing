import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionEventEnvelope } from '@shared/events/envelope'
import { SESSION_EVENT_TYPES } from '@shared/events/session-events'
import { configureSessionsPort } from './sessions-port'
import type { SessionsPort } from './sessions-port'
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
  }
  configureSessionsPort(port)
  useSessionsSource.getState().reset()
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
