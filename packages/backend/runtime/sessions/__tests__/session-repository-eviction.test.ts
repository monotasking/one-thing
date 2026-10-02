import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CoreSession,
  CoreSessionDetails,
  CoreSessionMessageWithModelInfo,
  CoreSessionMessageWithUsage,
  CoreSessionMeta,
  StoredChatMessage,
  UserMessageMarker,
} from '@onething/backend/core/session'
import { createOnethingSessionRepository } from '../session-repository.js'

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

function createTempSessionsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-eviction-'))
  const sessionsDir = path.join(dir, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  tempDirs.push(dir)
  return sessionsDir
}

function readJsonFile<TValue>(filePath: string, fallback: TValue): TValue {
  if (!fs.existsSync(filePath)) return fallback
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TValue
}

function writeJsonFile(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}

async function writeJsonFileAsync(filePath: string, data: unknown): Promise<void> {
  writeJsonFile(filePath, data)
}

function makeRepository(sessionsDir: string, cacheSize: number) {
  let currentSessionId = ''
  const logger = { info: vi.fn(), error: vi.fn() }
  const repository = createOnethingSessionRepository<
    TestSession,
    TestMessage,
    TestMeta,
    CoreSessionDetails,
    UserMessageMarker
  >({
    defaultAgentId: 'default-agent',
    cacheSize,
    getSessionsDir: () => sessionsDir,
    getSessionPath: sessionId => path.join(sessionsDir, `${sessionId}.json`),
    readJsonFile,
    writeJsonFile,
    writeJsonFileAsync,
    deleteJsonFile: filePath => fs.rmSync(filePath, { force: true }),
    getCurrentSessionId: () => currentSessionId,
    setCurrentSessionId: sessionId => {
      currentSessionId = sessionId
    },
    getDefaultWorkingDirectory: () => '~/workspace',
    expandPath: value => value.replace(/^~/, '/Users/test'),
    logger,
  })
  return { repository, logger }
}

describe('session repository — LRU eviction does not drop pending writes (1.2)', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flushes an evicted dirty session instead of silently skipping its write', async () => {
    const sessionsDir = createTempSessionsDir()
    const { repository } = makeRepository(sessionsDir, 2)

    // 目标会话:写入消息但先不 flush,让它停留在挂起写入状态。
    const target = repository.createSession('s1', 'target')
    target.messages.push({ id: 'm1', role: 'user', content: 'unsaved streaming token', timestamp: 100 })
    repository.saveSessionToFile('s1', target, { lazy: true })

    // 触碰 >cacheSize 个其他会话,把 s1 挤出 LRU 缓存(cacheSize=2)。
    repository.createSession('s2', 'other-a')
    repository.createSession('s3', 'other-b')

    // 此刻 s1 已被淘汰:旧行为下 getLatest 落空 -> 写入被静默跳过。
    expect(repository.getSessionCacheStats().cachedSessionIds).not.toContain('s1')

    await repository.flushSessionSave('s1')

    // 修复后:挂起快照兜底,消息应真正落盘。
    const onDisk = readJsonFile<TestSession | null>(path.join(sessionsDir, 's1.json'), null)
    expect(onDisk?.messages).toEqual([
      expect.objectContaining({ id: 'm1', content: 'unsaved streaming token' }),
    ])
  })
})
