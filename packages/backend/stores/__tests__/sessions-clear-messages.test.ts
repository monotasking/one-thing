/**
 * `clearSessionMessages` —— 群聊「清空聊天记录」的存储原语
 * (docs/design/collab-room-clear-and-mention-all.md B)。
 *
 * 三件事必须同时成立,少一件这个功能就有幽灵:
 *  - 内存与索引归零,meta 的计数跟着一致(否则分页会去读不存在的行);
 *  - 不再另存 `messages.cleared-*` 留档(批 6b / 裁定 10):被清掉的消息事件原样
 *    躺在 `events.jsonl` 里,事件本身就是那份档;
 *  - `updateSessionCollab` 抹得掉 `collab.seenMessageId` —— 已读游标的清除全靠
 *    它,而这个仓库有过"白名单静默吞字段"的案底,所以这条要钉死。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/ipc.js'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

let previousHome: string | undefined
let tempHome: string
let loadedSessions: typeof import('../sessions.js') | null = null
let sessionsDir = ''

async function loadIsolatedStores(): Promise<typeof import('../sessions.js')> {
  vi.resetModules()
  const paths = await import('@onething/runtime/storage')
  const sessions = await import('../sessions.js')
  loadedSessions = sessions
  paths.ensureOnethingStoreDirs()
  sessionsDir = paths.getOnethingSessionsDir()
  return sessions
}

function userMessage(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, timestamp: 1 }
}

function sessionDir(sessionId: string): string {
  return path.join(sessionsDir, sessionId)
}

function archivedLogs(sessionId: string): string[] {
  return fs.readdirSync(sessionDir(sessionId)).filter(name => name.startsWith('messages.cleared-'))
}

function eventTypes(sessionId: string): string[] {
  const file = path.join(sessionDir(sessionId), 'events.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    .map(line => JSON.parse(line).type as string)
}

beforeEach(() => {
  previousHome = process.env.HOME
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-clear-messages-test-'))
  process.env.HOME = tempHome
  // 批 6b(§15.22)兑现了批 6a 写在这里的预告:抄本写代码已删、`messages.cleared-*`
  // 留档按裁定 10 退役,于是这个文件问的东西整体挪到了**事件面** —— 内存与索引
  // 归零、`session/cleared` 只遮不删、被遮的消息事件原样还在。抄本档位那根杆连同
  // 这里的 env 设置一起消失。
  loadedSessions = null
})

afterEach(async () => {
  await loadedSessions?.flushAllPendingSaves()
  process.env.HOME = previousHome
  fs.rmSync(tempHome, { recursive: true, force: true })
})

describe('clearSessionMessages', () => {
  it('清空内存与索引,并把 meta 计数归零', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('room-1', '官网改版组')
    sessions.addMessage('room-1', userMessage('m-1', '大家早'))
    sessions.addMessage('room-1', userMessage('m-2', '今天聊改版'))

    const result = await sessions.clearSessionMessages('room-1')

    expect(result.cleared).toBe(true)
    expect(result.clearedCount).toBe(2)
    expect(sessions.getSession('room-1')?.messages).toEqual([])

    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir('room-1'), 'meta.json'), 'utf-8'))
    expect(meta.log.messageCount).toBe(0)
    expect(sessions.getSessionsList().find(item => item.id === 'room-1')?.messageCount).toBe(0)
  })

  /**
   * 批 6b(裁定 10):**留档退役,事件本身就是档。**
   *
   * 清空在账本上是一条 `session/cleared` —— 只遮蔽、不删除:被遮的
   * `user/message` 原样躺在 `events.jsonl` 里。再复制一份 `messages.cleared-*`
   * 等于给"事件是唯一真相"开第一个例外(而且是个没有任何读取路径、只进不出的
   * 例外)。存量那批按裁定 9a 原地不动。
   *
   * 注意这个**存储原语**今天没有生产调用点:群聊「清空聊天记录」走的是命令面
   * `sessionCommands.replaceAll{reason:'clear'}`(`wiring/collab/room-config.ts`),
   * 那条路才带翻译器、才写 `session/cleared`(判据在 `event-translator.test.ts`)。
   * 所以这里只断言"不再留档 + 被删的消息事件原样还在",不断言遮蔽事件。
   */
  it('不再留档:被清掉的那条消息事件原样躺在账本里', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('room-1', '官网改版组')
    sessions.addMessage('room-1', userMessage('m-1', '大家早'))

    await sessions.clearSessionMessages('room-1')

    expect(archivedLogs('room-1')).toEqual([])
    expect(eventTypes('room-1')).toContain('user/message')
    const events = fs.readFileSync(path.join(sessionDir('room-1'), 'events.jsonl'), 'utf-8')
    expect(events).toContain('大家早')
  })

  it('查无此会话 = 什么都不做', async () => {
    const sessions = await loadIsolatedStores()
    expect(await sessions.clearSessionMessages('nope')).toEqual({ cleared: false, clearedCount: 0 })
  })

  it('不退用量:花掉的钱不因为记录被删而回来', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('room-1', '官网改版组')
    sessions.addMessage('room-1', userMessage('m-1', '大家早'))
    sessions.updateSessionTokenUsage('room-1', {
      inputTokens: 100,
      outputTokens: 40,
      totalTokens: 140,
    })

    await sessions.clearSessionMessages('room-1')

    expect(sessions.getSessionTokenUsage('room-1')?.totalInputTokens).toBe(100)
  })
})

describe('updateSessionCollab 与已读游标', () => {
  it('抹得掉 seenMessageId,而 roomSessionId 原样留着', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('agent-exec-fe-room-1', '[执行] 小李')
    sessions.updateSessionCollab('agent-exec-fe-room-1', {
      kind: 'agent',
      collab: { roomSessionId: 'room-1', seenMessageId: 'm-9', seenAt: 123 },
    })
    expect(sessions.getSession('agent-exec-fe-room-1')?.collab?.seenMessageId).toBe('m-9')

    sessions.updateSessionCollab('agent-exec-fe-room-1', {
      collab: { roomSessionId: 'room-1' },
    })

    const collab = sessions.getSession('agent-exec-fe-room-1')?.collab
    expect(collab?.seenMessageId).toBeUndefined()
    expect(collab?.seenAt).toBeUndefined()
    expect(collab?.roomSessionId).toBe('room-1')
  })
})
