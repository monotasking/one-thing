/**
 * 会话归属 space 的读写 —— 批 B1(`docs/design/workspace-spaces-2026-08.md`)。
 *
 * 两条纪律在这里钉死:
 * 1. `workspaceId` 在**创建时**定死,同时落进会话记录(meta.json)与快索引;
 * 2. 旧会话没有这个字段,读取端一律缺省 default —— **不做数据迁移**,
 *    所以「不带 workspaceId 建的会话」在盘上就该是干净的没有这个键。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CoreSession,
  CoreSessionDetails,
  CoreSessionMessageWithModelInfo,
  CoreSessionMessageWithUsage,
  CoreSessionMeta,
  StoredChatMessage,
  UserMessageMarker,
} from '@onething/core/session'
import { createOnethingSessionRepository } from '../session-repository.js'
import { DEFAULT_SPACE_ID, resolveSpaceId } from '../../spaces/types.js'

interface TestMessage
  extends StoredChatMessage,
    CoreSessionMessageWithUsage,
    CoreSessionMessageWithModelInfo {
  content: string
}

interface TestSession extends CoreSession<TestMessage> {
  id: string
  parentSessionId?: string
  workingDirectory?: string
  workingDirectoryRoots?: string[]
}

interface TestMeta extends CoreSessionMeta {
  parentSessionId?: string
}

const tempDirs: string[] = []

function createRepository() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-session-space-'))
  const sessionsDir = path.join(dir, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  tempDirs.push(dir)

  let currentSessionId = ''
  const repository = createOnethingSessionRepository<
    TestSession,
    TestMessage,
    TestMeta,
    CoreSessionDetails,
    UserMessageMarker
  >({
    defaultAgentId: 'default-agent',
    getSessionsDir: () => sessionsDir,
    getSessionPath: sessionId => path.join(sessionsDir, `${sessionId}.json`),
    readJsonFile: <TValue,>(filePath: string, fallback: TValue): TValue =>
      (fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf-8')) : fallback),
    writeJsonFile: (filePath, data) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
    },
    writeJsonFileAsync: async (filePath, data) => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
    },
    deleteJsonFile: filePath => fs.rmSync(filePath, { force: true }),
    getCurrentSessionId: () => currentSessionId,
    setCurrentSessionId: sessionId => {
      currentSessionId = sessionId
    },
  })
  return { repository, sessionsDir }
}

describe('session workspaceId', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stamps the space onto both the session record and the fast index', async () => {
    const { repository, sessionsDir } = createRepository()

    const session = repository.createSession('s1', 'In work space', { workspaceId: 'work' })
    expect(session.workspaceId).toBe('work')
    expect(repository.getSessionsList()).toMatchObject([{ id: 's1', workspaceId: 'work' }])

    await repository.flushSessionSave('s1')
    // 无 storageDriver 的宿主写整文件 JSON;字段照样落盘(jsonl 驱动的
    // meta.json 是同一份「会话减去 messages」)。
    const stored = JSON.parse(
      fs.readFileSync(path.join(sessionsDir, 's1.json'), 'utf-8'),
    )
    expect(stored.workspaceId).toBe('work')
  })

  it('leaves the field absent when no space is passed (零迁移的前提)', async () => {
    const { repository, sessionsDir } = createRepository()

    const session = repository.createSession('s2', 'Legacy shaped')
    expect(session.workspaceId).toBeUndefined()
    expect(repository.getSessionsList()[0]).not.toHaveProperty('workspaceId')

    await repository.flushSessionSave('s2')
    const stored = JSON.parse(
      fs.readFileSync(path.join(sessionsDir, 's2.json'), 'utf-8'),
    )
    expect(stored).not.toHaveProperty('workspaceId')

    // 读取端缺省:没有字段 = default,而不是"无空间"。
    expect(resolveSpaceId(repository.getSession('s2')?.workspaceId)).toBe(DEFAULT_SPACE_ID)
  })

  it('survives a cold reload through the persisted index', () => {
    const { repository } = createRepository()
    repository.createSession('s3', 'Persisted', { workspaceId: 'work' })
    repository.createSession('s4', 'Default shaped')

    const listed = repository.getSessionsList()
    expect(listed.find(meta => meta.id === 's3')?.workspaceId).toBe('work')
    expect(listed.find(meta => meta.id === 's4')?.workspaceId).toBeUndefined()
  })
})
