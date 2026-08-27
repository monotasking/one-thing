/**
 * 群聊「清空聊天记录」在**仓库这一层**留下的那件事:已读游标清得掉。
 * (docs/design/collab-room-clear-and-mention-all.md B)
 *
 * `updateSessionCollab` 抹得掉 `collab.seenMessageId` —— 已读游标的清除全靠它,
 * 而这个仓库有过"白名单静默吞字段"的案底,所以这条要钉死。
 *
 * **文件从 `sessions-clear-messages.test.ts` 改名而来**(F4-a,§16.12):清空
 * 本身的三条断言随 `stores/clearSessionMessages` 一起退役 —— 那个存储原语
 * P0.2 之后就零生产调用点了(群聊走命令面 `replaceAll{reason:'clear'}`,
 * `wiring/collab/room-config.ts`),批 6b 查明、本批按 §16.11 拍板 5 删除。
 * 清空的行为判据在命令面那一侧:`session/__tests__/commands.test.ts` 与
 * `event-translator` 退役后的 `command-events` 一族。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

let previousHome: string | undefined
let tempHome: string
let loadedSessions: typeof import('../sessions.js') | null = null

async function loadIsolatedStores(): Promise<typeof import('../sessions.js')> {
  vi.resetModules()
  const paths = await import('@onething/runtime/storage')
  const sessions = await import('../sessions.js')
  loadedSessions = sessions
  paths.ensureOnethingStoreDirs()
  return sessions
}

beforeEach(() => {
  previousHome = process.env.HOME
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-collab-cursor-test-'))
  process.env.HOME = tempHome
  loadedSessions = null
})

afterEach(async () => {
  await loadedSessions?.flushAllPendingSaves()
  process.env.HOME = previousHome
  fs.rmSync(tempHome, { recursive: true, force: true })
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
