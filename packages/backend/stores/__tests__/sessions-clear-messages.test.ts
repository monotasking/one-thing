/**
 * `clearSessionMessages` —— 群聊「清空聊天记录」的存储原语
 * (docs/design/collab-room-clear-and-mention-all.md B)。
 *
 * 三件事必须同时成立,少一件这个功能就有幽灵:
 *  - 内存与盘上的转录都归零,meta 的计数跟着一致(否则分页会去读不存在的行);
 *  - **删之前留档一份**,而且留档里有的正是刚被删掉的那些;
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

beforeEach(() => {
  previousHome = process.env.HOME
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-clear-messages-test-'))
  process.env.HOME = tempHome
  // 这个文件问的是**抄本文件**上的后果(`messages.jsonl` 归零、`messages.cleared-*`
  // 留档)。批 6a(§15.19)把 `ONETHING_SESSION_TRANSCRIPT` 的默认翻到 `off` 之后
  // 抄本根本不写,这些断言就没有对象了 —— 所以显式扳到回滚杆 `shadow`,让用例
  // 继续问它本来问的那件事。走 env 而不是 `setSessionTranscriptModeForTesting`:
  // 下面 `loadIsolatedStores` 每次 `vi.resetModules()`,测试覆写住在模块实例里会
  // 被重置掉,而档位读的是 `process.env`,重置多少次都还在。
  //
  // **批 6b 会把这两条一起改写**:裁定 10 拍了 `messages.cleared-*` 退役
  // (`session/cleared` 只遮蔽不删,事件本身就是档),届时留档那条用例随之退役,
  // 清空那条改问事件面的遮蔽。
  process.env.ONETHING_SESSION_TRANSCRIPT = 'shadow'
  loadedSessions = null
})

afterEach(async () => {
  await loadedSessions?.flushAllPendingSaves()
  process.env.HOME = previousHome
  delete process.env.ONETHING_SESSION_TRANSCRIPT
  fs.rmSync(tempHome, { recursive: true, force: true })
})

describe('clearSessionMessages', () => {
  it('清空内存与盘上的转录,并把 meta 计数归零', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('room-1', '官网改版组')
    sessions.addMessage('room-1', userMessage('m-1', '大家早'))
    sessions.addMessage('room-1', userMessage('m-2', '今天聊改版'))

    const result = await sessions.clearSessionMessages('room-1')

    expect(result.cleared).toBe(true)
    expect(result.clearedCount).toBe(2)
    expect(sessions.getSession('room-1')?.messages).toEqual([])

    const log = fs.readFileSync(path.join(sessionDir('room-1'), 'messages.jsonl'), 'utf-8')
    expect(log).not.toContain('大家早')
    const meta = JSON.parse(fs.readFileSync(path.join(sessionDir('room-1'), 'meta.json'), 'utf-8'))
    expect(meta.log.messageCount).toBe(0)
    expect(sessions.getSessionsList().find(item => item.id === 'room-1')?.messageCount).toBe(0)
  })

  it('删之前留档一份,留档里正是被删掉的那些', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('room-1', '官网改版组')
    sessions.addMessage('room-1', userMessage('m-1', '大家早'))

    const result = await sessions.clearSessionMessages('room-1')

    const archives = archivedLogs('room-1')
    expect(archives).toHaveLength(1)
    expect(result.archivePath).toBe(path.join(sessionDir('room-1'), archives[0]))
    expect(fs.readFileSync(result.archivePath!, 'utf-8')).toContain('大家早')
  })

  it('本来就空的会话不留档(留档是"删之前盘上是什么样",没东西可留)', async () => {
    const sessions = await loadIsolatedStores()
    sessions.createSession('room-1', '官网改版组')

    const result = await sessions.clearSessionMessages('room-1')

    expect(result.cleared).toBe(true)
    expect(result.clearedCount).toBe(0)
    expect(result.archivePath).toBeUndefined()
    expect(archivedLogs('room-1')).toEqual([])
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
