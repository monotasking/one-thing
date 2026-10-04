/**
 * 协作房间里的「权限请求等太久了」提醒(D202):授权层只发 `permission:ask-stale`,本功能的监听器
 * 查房、写那一句系统消息。钉三件事:房间会话与房间里的工作会话都写进房间、措辞与从前逐字相同;
 * 不在房间里的会话不写;退订之后不再写。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, { id: string; kind?: string; collab?: { roomSessionId?: string } }>(),
  posted: [] as Array<{ roomSessionId: string; content: string }>,
}))

vi.mock('@onething/backend/session', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  getSession: (id: string) => mocks.sessions.get(id),
}))
vi.mock('../collab-room-config.js', () => ({
  postCollabSystemLine: (roomSessionId: string, content: string) => { mocks.posted.push({ roomSessionId, content }) },
}))

const { installPermissionStaleReminder } = await import('../collab-permission-stale-reminder.js')

type Handler = (envelope: { event: { type: 'permission:ask-stale'; sessionId: string; title: string; elapsedMs: number } }) => void

function fakeBus() {
  const handlers = new Set<Handler>()
  return {
    onGlobal: (type: string, handler: Handler) => {
      expect(type).toBe('permission:ask-stale')
      handlers.add(handler)
      return () => { handlers.delete(handler) }
    },
    emit: (sessionId: string, title: string) => {
      for (const handler of handlers) handler({ event: { type: 'permission:ask-stale', sessionId, title, elapsedMs: 30 * 60_000 } })
    },
  }
}

beforeEach(() => {
  mocks.sessions.clear()
  mocks.posted.length = 0
  mocks.sessions.set('room-1', { id: 'room-1', kind: 'room' })
  mocks.sessions.set('work-1', { id: 'work-1', kind: 'work', collab: { roomSessionId: 'room-1' } })
  mocks.sessions.set('chat-1', { id: 'chat-1', kind: 'chat' })
})

describe('permission:ask-stale → 协作房间里的一行提醒', () => {
  it('writes the reminder into the room, for the room itself and for a work session in it', () => {
    const bus = fakeBus()
    installPermissionStaleReminder(bus as never)
    bus.emit('room-1', '运行 bash')
    bus.emit('work-1', '写文件')
    expect(mocks.posted).toEqual([
      { roomSessionId: 'room-1', content: '有一个权限请求已等待 30 分钟未处理:运行 bash(从看板任务卡打开工作会话审批)' },
      { roomSessionId: 'room-1', content: '有一个权限请求已等待 30 分钟未处理:写文件(从看板任务卡打开工作会话审批)' },
    ])
  })

  it('stays silent for a session outside any room, and after the listener is removed', () => {
    const bus = fakeBus()
    const stop = installPermissionStaleReminder(bus as never)
    bus.emit('chat-1', '运行 bash')
    bus.emit('missing', '运行 bash')
    stop()
    bus.emit('room-1', '运行 bash')
    expect(mocks.posted).toEqual([])
  })
})
