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
} from '@onething/core/session'
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-runtime-sessions-'))
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

function deletionRepository(overrides: {
  writeJsonFileAsync?: typeof writeJsonFileAsync
  deleteJsonFile?: (filePath: string) => void
} = {}) {
  const sessionsDir = createTempSessionsDir()
  let current = ''
  const repository = createOnethingSessionRepository<TestSession, TestMessage, TestMeta, CoreSessionDetails>({
    defaultAgentId: 'default-agent',
    getSessionsDir: () => sessionsDir,
    getSessionPath: id => path.join(sessionsDir, `${id}.json`),
    readJsonFile, writeJsonFile,
    writeJsonFileAsync: overrides.writeJsonFileAsync ?? writeJsonFileAsync,
    deleteJsonFile: overrides.deleteJsonFile ?? (filePath => fs.rmSync(filePath, { force: true })),
    getCurrentSessionId: () => current,
    setCurrentSessionId: id => { current = id },
    getDefaultWorkingDirectory: () => sessionsDir,
    expandPath: value => value,
    logger: { error: vi.fn() },
  })
  return { repository, file: (id: string) => path.join(sessionsDir, `${id}.json`) }
}

describe('onething session repository', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists distinct create and branch generations before either is returned', async () => {
    const f = deletionRepository()
    f.repository.createSession('parent', 'parent')
    const parent = readJsonFile<{ storageGeneration: string }>(f.file('parent'), {} as never)
    expect(parent.storageGeneration).toMatch(/^[a-f0-9-]{36}$/)
    f.repository.createBranchSession('branch', 'branch', 'parent', 'message', [])
    const branch = readJsonFile<{ storageGeneration: string }>(f.file('branch'), {} as never)
    expect(branch.storageGeneration).toMatch(/^[a-f0-9-]{36}$/)
    expect(branch.storageGeneration).not.toBe(parent.storageGeneration)
    const index = f.repository.loadSessionsIndex() as Array<TestMeta & { storageGeneration: string }>
    expect(index.find(meta => meta.id === 'branch')?.storageGeneration).toBe(branch.storageGeneration)
    await f.repository.flushAllPendingSaves()
  })

  it('releases idle cached sessions under memory pressure, but never a protected one or one with a pending write', async () => {
    const f = deletionRepository()
    f.repository.createSession('idle', 'idle')
    f.repository.createSession('keep', 'keep')
    f.repository.createSession('dirty', 'dirty')
    await f.repository.flushAllPendingSaves()
    const dirty = f.repository.getCachedSession('dirty')!
    f.repository.saveSessionToFile('dirty', { ...dirty, name: 'dirty 2' })
    // 保鲜期没过:一条都不挤。
    expect(f.repository.releaseIdleCachedSessions({ idleMs: 60_000 })).toEqual([])
    const released = f.repository.releaseIdleCachedSessions({ idleMs: 0, isProtected: id => id === 'keep' })
    expect(released).toEqual(['idle'])
    expect(f.repository.getCachedSession('idle')).toBeUndefined()
    expect(f.repository.getCachedSession('keep')).toBeDefined()
    expect(f.repository.getCachedSession('dirty')).toBeDefined()
    await f.repository.flushAllPendingSaves()
    // 挤掉的只是缓存:从盘上照样读得回来。
    expect(f.repository.getSession('idle')?.id).toBe('idle')
  })

  it('does not publish a generation whose initial file barrier failed', () => {
    const f = deletionRepository()
    vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('initial save failed') })
    expect(() => f.repository.createSession('failed-initial', 'failed')).toThrow('initial save failed')
    expect(f.repository.getCachedSession('failed-initial')).toBeUndefined()
    expect(f.repository.loadSessionsIndex()).toEqual([])
    expect(fs.existsSync(f.file('failed-initial'))).toBe(false)
  })

  it('does not report deletion complete before an in-flight file write settles', async () => {
    let paused = false
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const f = deletionRepository({ writeJsonFileAsync: async (filePath, value) => {
      if (paused) { entered(); await held }
      await writeJsonFileAsync(filePath, value)
    } })
    const session = f.repository.createSession('held', 'held')
    await f.repository.flushSessionSave('held')
    paused = true
    session.name = 'updated'
    f.repository.saveSessionToFile('held', session)
    const saving = f.repository.flushSessionSave('held')
    await started
    const deleting = f.repository.deleteSession('held')
    expect(fs.existsSync(f.file('held'))).toBe(true)
    expect(f.repository.getSessionRaw('held')).toBeUndefined()
    release()
    await saving
    await expect(deleting).resolves.toMatchObject({ deletedIds: ['held'] })
    expect(fs.existsSync(f.file('held'))).toBe(false)
  })

  it('propagates file deletion failure and prevents cold reads from resurrecting the orphan', async () => {
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const f = deletionRepository({ deleteJsonFile: () => { throw failure } })
    f.repository.createSession('failed', 'failed')
    await f.repository.flushSessionSave('failed')
    const result = await f.repository.deleteSession('failed').catch(error => error as AggregateError)
    expect(result).toBeInstanceOf(AggregateError)
    expect((result as AggregateError).errors).toContain(failure)
    expect(fs.existsSync(f.file('failed'))).toBe(true)
    expect(f.repository.getSessionRaw('failed')).toBeUndefined()
  })

  it('detects legacy JSON helpers that report removal failure without throwing', async () => {
    const f = deletionRepository({ deleteJsonFile: () => false })
    f.repository.createSession('silent-failure', 'saved')
    await f.repository.flushSessionSave('silent-failure')
    await expect(f.repository.deleteSession('silent-failure')).rejects.toThrow('Failed to delete session')
    expect(fs.existsSync(f.file('silent-failure'))).toBe(true)
    expect(f.repository.getSessionRaw('silent-failure')).toBeUndefined()
  })

  it('owns session index, cache, JSON persistence, paging, and deletion behind host adapters', async () => {
    const sessionsDir = createTempSessionsDir()
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

    const session = repository.createSession('s1', 'First')
    expect(session.id).toBe('s1')
    expect(session.workingDirectory).toBe('/Users/test/workspace')
    expect(currentSessionId).toBe('s1')
    expect(repository.getSessionsList()).toMatchObject([{ id: 's1', name: 'First', agentId: 'default-agent' }])

    session.messages.push({
      id: 'm1',
      role: 'user',
      content: 'hello runtime',
      timestamp: 100,
    })
    repository.saveSessionToFile('s1', session)
    await repository.flushSessionSave('s1')

    expect(repository.getSessionRaw('s1')?.messages).toHaveLength(1)
    expect(repository.getSessionDetails('s1')).toMatchObject({
      id: 's1',
      name: 'First',
      messageCount: 1,
      agentId: 'default-agent',
    })
    expect(repository.getSessionMessagesPage({ sessionId: 's1', anchor: 'tail', limit: 10 }))
      .toMatchObject({ success: true, messages: [{ id: 'm1', content: 'hello runtime' }] })
    expect(repository.getSessionUserMessageMarkers('s1')).toEqual([
      { id: 'm1', seq: 1, timestamp: 100, preview: 'hello runtime' },
    ])

    await expect(repository.deleteSession('s1')).resolves.toEqual({ deletedIds: ['s1'] })
    expect(repository.getSessionsList()).toEqual([])
    expect(repository.getSessionRaw('s1')).toBeUndefined()
  })

  /**
   * S3w-1(§14.4):冷加载补水岔口 —— 装上补水源就用它顶掉抄本那一份消息,
   * 外壳仍来自存储层;补水源交白(未迁移的老会话)时一字不改走老路。
   * 补水完照旧跑 `rehydrate`(`step.toolCall` 链接由它重建)。
   */
  it('hydrates cold-loaded messages from the injected projection source', async () => {
    const sessionsDir = createTempSessionsDir()
    let currentSessionId = ''
    let hydrated: TestMessage[] | undefined
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
      readJsonFile,
      writeJsonFile,
      writeJsonFileAsync,
      deleteJsonFile: filePath => fs.rmSync(filePath, { force: true }),
      getCurrentSessionId: () => currentSessionId,
      setCurrentSessionId: sessionId => {
        currentSessionId = sessionId
      },
      hydrateMessagesFromProjection: () => hydrated,
    })

    const session = repository.createSession('s1', 'First')
    session.messages.push({ id: 'm1', role: 'user', content: 'from the transcript', timestamp: 1 })
    repository.saveSessionToFile('s1', session)
    await repository.flushSessionSave('s1')

    // 补水源交白 = 老路:盘上那份原样回来。
    repository.clearAllSessionCache()
    expect(repository.getSession('s1')?.messages).toMatchObject([{ content: 'from the transcript' }])

    // 装上补水源:冷加载的消息换成投影那一份,外壳(名字)仍来自存储层。
    hydrated = [
      { id: 'm1', role: 'user', content: 'from the projection', timestamp: 1 },
      {
        id: 'm2',
        role: 'assistant',
        content: 'answer',
        timestamp: 2,
        steps: [{ id: 'st1', title: 'call', status: 'completed', toolCallId: 'tc1' }],
        toolCalls: [{ id: 'tc1', toolName: 'read', status: 'completed', result: 'ok' }],
      } as unknown as TestMessage,
    ]
    repository.clearAllSessionCache()
    const reloaded = repository.getSession('s1')
    expect(reloaded?.name).toBe('First')
    expect(reloaded?.messages).toMatchObject([
      { content: 'from the projection' },
      { content: 'answer' },
    ])
    // 老路那条补水链一步不减:`step.toolCall` 由 `rehydrate` 接回顶层那一份。
    const step = (reloaded?.messages[1] as unknown as { steps: { toolCall?: { id: string } }[] }).steps[0]
    expect(step.toolCall?.id).toBe('tc1')
  })

  /**
   * 工单 6 ②a:用量五格住在**会话壳**上,读它不该惊动消息那一格。
   *
   * 真机上被惊动的代价不是一次多余的函数调用:补水源一动就是把整份账本读一遍、
   * 折一遍、把全部消息物化一遍(53MB 夹具上 835ms),而交出去的只有 159 个字节。
   * 所以这条用例判的是**补水源一次都没被叫过**,不是"数对不对"—— 数对了但路走
   * 错了,正是修之前的样子。
   */
  it('reads the usage fields off the shell without waking the hydration source', async () => {
    const sessionsDir = createTempSessionsDir()
    let currentSessionId = ''
    const hydrate = vi.fn<() => TestMessage[] | undefined>(() => undefined)
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
      readJsonFile,
      writeJsonFile,
      writeJsonFileAsync,
      deleteJsonFile: filePath => fs.rmSync(filePath, { force: true }),
      getCurrentSessionId: () => currentSessionId,
      setCurrentSessionId: sessionId => {
        currentSessionId = sessionId
      },
      hydrateMessagesFromProjection: hydrate,
    })

    const session = repository.createSession('s1', 'First')
    repository.updateSessionTokenUsage('s1', { inputTokens: 12, outputTokens: 34, totalTokens: 46 }, { inputTokens: 12, outputTokens: 34 })
    repository.updateSessionContextSize('s1', 789)
    repository.saveSessionToFile('s1', session)
    await repository.flushSessionSave('s1')

    repository.clearAllSessionCache()
    hydrate.mockClear()

    expect(repository.getSessionUsageFields('s1')).toMatchObject({
      totalInputTokens: 12,
      totalOutputTokens: 34,
      totalTokens: 46,
      // `updateSessionContextSize` 把这一格一起推到 789(`applySessionContextSize`
      // 的既有口径),这里如实写它此刻的值 —— 用例判的是"读得到、路走对",
      // 不是替那条写口径重新拍板。
      lastInputTokens: 789,
      contextSize: 789,
    })
    expect(hydrate).not.toHaveBeenCalled()

    // 删掉的会话仍然答"读不到" —— 两道删除判据留在壳这条路上。
    await repository.deleteSession('s1')
    expect(repository.getSessionUsageFields('s1')).toBeUndefined()
  })

  it('owns session metadata and side-effect mutations behind repository adapters', () => {
    const sessionsDir = createTempSessionsDir()
    let currentSessionId = ''
    const syncSessionMetadata = vi.fn()
    const syncSessionUsage = vi.fn()
    const syncSessionVariables = vi.fn()
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
      readJsonFile,
      writeJsonFile,
      writeJsonFileAsync,
      deleteJsonFile: filePath => fs.rmSync(filePath, { force: true }),
      getCurrentSessionId: () => currentSessionId,
      setCurrentSessionId: sessionId => {
        currentSessionId = sessionId
      },
      expandPath: value => value.replace(/^~/, '/Users/test'),
      sqlite: {
        isSessionReady: () => true,
        scheduleMigration: vi.fn(),
        syncSessionMetadata,
        syncSessionUsage,
        syncSessionVariables,
      },
    })

    repository.createSession('s1', 'First')

    expect(repository.renameSession('s1', 'Renamed')).toBe(true)
    expect(repository.updateSessionPin('s1', true)).toBe(true)
    expect(repository.updateSessionArchived('s1', true, 123)).toBe(true)
    expect(repository.updateSessionPermissionMode('s1', 'ask')).toBe(true)
    expect(repository.updateSessionWorkingDirectory('s1', '~/project')).toBe(true)
    expect(repository.updateSessionWorkingDirectoryRoots('s1', ['~/project', '/tmp'])).toBe(true)
    expect(repository.inheritSessionWorkingDirectory('s1', '~/inherited')).toBe(true)
    expect(repository.updateSessionVariables('s1', [
      { name: 'ticket', value: '42' },
    ])).toBe(true)
    expect(repository.updateSessionTokenUsage('s1', {
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    }, {
      inputTokens: 7,
    })).toBe(true)
    expect(repository.updateSessionContextSize('s1', 5)).toBe(true)
    expect(repository.updateSessionPromptContext('s1', { selected: 'prompt-1' })).toBe(true)
    expect(repository.updateSessionSummary('s1', 'Earlier context', 'm1')).toBe(true)
    expect(repository.updateSessionModel('s1', 'deepseek', 'deepseek-chat')).toBe(true)
    expect(repository.updateSessionAgent('s1', 'agent-custom')).toBe(true)

    const session = repository.getSession('s1')
    expect(session).toMatchObject({
      name: 'Renamed',
      isPinned: true,
      isArchived: true,
      archivedAt: 123,
      permissionMode: 'ask',
      workingDirectory: '/Users/test/inherited',
      workingDirectoryRoots: ['/tmp'],
      variables: [{ name: 'ticket', value: '42', updatedAt: expect.any(Number) }],
      totalInputTokens: 10,
      totalOutputTokens: 4,
      totalTokens: 14,
      lastInputTokens: 5,
      contextSize: 5,
      promptContext: { selected: 'prompt-1' },
      summary: 'Earlier context',
      summaryUpToMessageId: 'm1',
      lastProvider: 'deepseek',
      lastModel: 'deepseek-chat',
      agentId: 'agent-custom',
    })
    expect(repository.getSessionsList()[0]).toMatchObject({
      id: 's1',
      name: 'Renamed',
      isPinned: true,
      isArchived: true,
      archivedAt: 123,
      permissionMode: 'ask',
      lastProvider: 'deepseek',
      lastModel: 'deepseek-chat',
      agentId: 'agent-custom',
    })
    expect(syncSessionMetadata).toHaveBeenCalled()
    expect(syncSessionUsage).toHaveBeenCalled()
    expect(syncSessionVariables).toHaveBeenCalled()
    expect(repository.renameSession('missing', 'Nope')).toBe(false)
  })
})
