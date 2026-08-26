import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  CoreSession,
  CoreSessionDetails,
  CoreSessionMeta,
  CoreTimelineStep,
  CoreToolCallState,
  StoredChatMessage,
  UserMessageMarker,
} from '@onething/core/session'
import { encodeJsonlHeaderLine, encodeJsonlMessageLine } from '@onething/core/session'
import { createOnethingSessionRepository } from '../session-repository.js'
import { createHybridSessionStorageDriver } from '../storage-driver.js'

// 启动阶段的全量 sanitize 扫描已删除,冷加载(repository.getSession)是
// 崩溃恢复的唯一防线。本文件把原 sanitizeAllSessionsOnStartup 的四类修复
// 钉在冷加载路径上:isStreaming 复位、中断 step 置 failed、executing/pending
// toolCall 置 cancelled、过期 context-compact 系统消息置 failed。

interface TestMessage extends StoredChatMessage {
  content: string
  isStreaming?: boolean
  toolCalls?: Array<CoreToolCallState & { id: string }>
  steps?: CoreTimelineStep[]
}

interface TestSession extends CoreSession<TestMessage> {
  id: string
  workingDirectory?: string
  workingDirectoryRoots?: string[]
}

const tempDirs: string[] = []

function createTempSessionsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-crash-recovery-'))
  const sessionsDir = path.join(dir, 'sessions')
  fs.mkdirSync(sessionsDir, { recursive: true })
  tempDirs.push(dir)
  return sessionsDir
}

function readJsonFile<TValue>(filePath: string, fallback: TValue): TValue {
  if (!fs.existsSync(filePath)) return fallback
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TValue
  } catch {
    return fallback
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8')
}

/**
 * 把一份"崩溃现场"直接铺到盘上(`meta.json` + `messages.jsonl`)。
 *
 * S3w-3 批 6b 删掉了驱动的消息写半边,`saveSessionToFile` 从此只落会话外壳 ——
 * 于是"用一个仓库实例写出现场、再用另一个实例冷加载"这条老套路没了写的那一半。
 * 这里改成直接写**存量抄本化石**(裁定 9a:那种文件仍然可读,只是不再由产品写
 * 出来),读那一半、`rehydrate`、冷加载崩溃修复三段一字未动 —— 这个文件问的
 * 正是那三段。
 */
function seedTranscriptFossil(sessionsDir: string, session: TestSession): void {
  const dir = path.join(sessionsDir, session.id)
  fs.mkdirSync(dir, { recursive: true })
  let text = encodeJsonlHeaderLine(session.id)
  session.messages.forEach((message, index) => {
    text += encodeJsonlMessageLine(index + 1, message)
  })
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), text, 'utf-8')
  const { messages, ...rest } = session as TestSession & Record<string, unknown>
  writeJsonFile(path.join(dir, 'meta.json'), {
    ...rest,
    formatVersion: 2,
    log: { messageCount: messages.length, lastSeq: messages.length },
  })
}

function createRepository(sessionsDir: string, cacheSize?: number) {
  const storageDriver = createHybridSessionStorageDriver<TestSession>({
    getSessionsDir: () => sessionsDir,
    getLegacySessionPath: sessionId => path.join(sessionsDir, `${sessionId}.json`),
    newSessionFormat: () => 'jsonl',
    readJsonFile,
    writeJsonFileAsync: async (filePath, data) => {
      writeJsonFile(filePath, data)
    },
    deleteJsonFile: filePath => fs.rmSync(filePath, { force: true }),
  })

  return createOnethingSessionRepository<
    TestSession,
    TestMessage,
    CoreSessionMeta,
    CoreSessionDetails,
    UserMessageMarker
  >({
    defaultAgentId: 'default-agent',
    ...(cacheSize !== undefined ? { cacheSize } : {}),
    getSessionsDir: () => sessionsDir,
    getSessionPath: sessionId => path.join(sessionsDir, `${sessionId}.json`),
    readJsonFile,
    writeJsonFile,
    writeJsonFileAsync: async (filePath, data) => {
      writeJsonFile(filePath, data)
    },
    deleteJsonFile: filePath => fs.rmSync(filePath, { force: true }),
    storageDriver,
    getCurrentSessionId: () => '',
    setCurrentSessionId: () => {},
    getDefaultWorkingDirectory: () => '/tmp/workspace',
    logger: { info: () => {}, error: () => {} },
  })
}

function makeCrashedSession(now: number): TestSession {
  return {
    id: 'crashed',
    messages: [
      { id: 'm1', role: 'user', content: '触发一个长任务', timestamp: now - 60_000 },
      {
        id: 'm2',
        role: 'assistant',
        content: '进行中…',
        timestamp: now - 50_000,
        isStreaming: true,
        toolCalls: [
          { id: 't1', status: 'executing' },
          { id: 't2', status: 'pending' },
        ],
        steps: [
          {
            title: 'Running: bash',
            status: 'running',
            toolCall: { status: 'executing' },
            childSteps: [
              { title: '等待授权', status: 'awaiting-confirmation' },
            ],
          },
        ],
      } as TestMessage,
      {
        id: 'm3',
        role: 'system',
        timestamp: now - 11 * 60 * 1000,
        content: JSON.stringify({
          type: 'context-compact',
          status: 'compacting',
          summary: '压缩到一半',
          compactedMessageCount: 12,
        }),
      },
    ],
  } as TestSession
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('crash recovery via cold load', () => {
  it('repairs an interrupted streaming session on first load after a crash', async () => {
    const sessionsDir = createTempSessionsDir()
    const now = Date.now()

    // 铺一份"崩溃现场"的存量抄本,再追加半行模拟进程死在 jsonl 写入中途。
    seedTranscriptFossil(sessionsDir, makeCrashedSession(now))
    const logPath = path.join(sessionsDir, 'crashed', 'messages.jsonl')
    expect(fs.existsSync(logPath)).toBe(true)
    fs.appendFileSync(logPath, '{"id":"m4","role":"assistant","content":"写到一半被杀', 'utf-8')

    // 全新实例(空缓存)冷加载 —— 即原启动扫描被替代后的真实恢复路径。
    const repository = createRepository(sessionsDir)
    const session = repository.getSession('crashed')
    expect(session).toBeDefined()

    const messages = session!.messages
    expect(messages.map(message => message.id)).toEqual(['m1', 'm2', 'm3'])

    const assistant = messages[1]
    expect(assistant.isStreaming).toBe(false)
    expect(assistant.toolCalls?.map(toolCall => toolCall.status)).toEqual(['cancelled', 'cancelled'])

    // R-a(§13.6):崩溃收口以 prepare 为准 —— `cancelled` + 共用常量那一句,
    // 标题**原样留着**(那次改写在事件账本里没有来源,投影重建不出来)。
    const step = assistant.steps![0]
    expect(step.status).toBe('cancelled')
    expect(step.title).toBe('Running: bash')
    expect(step.error).toBeTruthy()
    expect(step.toolCall?.status).toBe('cancelled')
    expect(step.childSteps![0]).toMatchObject({
      status: 'cancelled',
      error: 'Interrupted: permission request was not answered',
    })

    const compact = JSON.parse(messages[2].content) as { status: string; error?: string }
    expect(compact.status).toBe('failed')
    expect(compact.error).toBeTruthy()

    // 批 6b 起修复**只在内存里**:抄本不再被写回(消息写半边已删),事件账本上
    // 也没有这次修复的产地(§13.6 R-a)。所以判据换成"再冷加载一次照样修得对"
    // —— 修复是每次接手时现算的,幂等。
    await repository.flushSessionSave('crashed')
    const again = createRepository(sessionsDir).getSession('crashed')
    expect(again?.messages[1].isStreaming).toBe(false)
    expect(again?.messages[1].toolCalls?.map(toolCall => toolCall.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('leaves a cleanly finished session untouched', async () => {
    const sessionsDir = createTempSessionsDir()
    const seeder = createRepository(sessionsDir)
    const clean: TestSession = {
      id: 'clean',
      messages: [
        { id: 'm1', role: 'user', content: 'hi', timestamp: 1 },
        {
          id: 'm2',
          role: 'assistant',
          content: 'done',
          timestamp: 2,
          isStreaming: false,
          toolCalls: [{ id: 't1', status: 'completed' }],
          steps: [{ title: 'bash', status: 'completed' }],
        } as TestMessage,
      ],
    } as TestSession
    seedTranscriptFossil(sessionsDir, clean)
    const before = fs.readFileSync(path.join(sessionsDir, 'clean', 'messages.jsonl'), 'utf-8')

    const session = createRepository(sessionsDir).getSession('clean')
    expect(session?.messages[1].toolCalls?.[0].status).toBe('completed')
    expect(session?.messages[1].steps?.[0].status).toBe('completed')
    const after = fs.readFileSync(path.join(sessionsDir, 'clean', 'messages.jsonl'), 'utf-8')
    expect(after).toBe(before)
  })

  /**
   * §13.7:真机 `5e4d2cea` 的两条 history 影子不等的病根。
   *
   * 崩溃修复修的是**上一个进程**的残留,而它从前挂在"每一次冷加载"上。LRU 默认
   * 只有 10 条:一次活着的执行中途被挤出去,下一次 `getSession` 就把**正在跑的
   * 那条消息**当成崩溃残留修了 —— `isStreaming` 被抹掉(那条消息从此进自己的
   * 模型历史重建,而事件投影仍按 `run/start…run/end` 说它在流式,两侧从这一刻起
   * 每次请求都不等)、正在执行的 step / toolCall 被改写成 cancelled,并且这一份
   * 还被写回盘。消息形状取自那条会话(内容已洗)。
   */
  it('does not crash-repair a live session this process evicted mid-run (§13.7)', async () => {
    const sessionsDir = createTempSessionsDir()
    const repository = createRepository(sessionsDir, 2)

    const live = repository.createSession('live', '正在跑的会话')
    live.messages.push(
      { id: 'u1', role: 'user', content: '写一个 skill', timestamp: 1 } as TestMessage,
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: 2,
        isStreaming: true,
        toolCalls: [
          { id: 'call_read_1', status: 'completed' },
          { id: 'call_bash_2', status: 'executing' },
        ],
        steps: [
          { title: 'Read site-inventory.md', status: 'completed' },
          { title: 'Running: bash', status: 'running', toolCall: { status: 'executing' } },
        ],
      } as TestMessage,
    )
    repository.saveSessionToFile('live', live)
    await repository.flushSessionSave('live')
    // 消息写半边已删(批 6b),盘上那一份得自己铺 —— 冷加载要有东西读回来。
    seedTranscriptFossil(sessionsDir, live)

    // 同一个进程里挤掉它(cacheSize=2),再读回来 —— 引擎在真机上就是这样接着写的。
    repository.createSession('other-a', 'a')
    repository.createSession('other-b', 'b')
    expect(repository.getSessionCacheStats().cachedSessionIds).not.toContain('live')

    const reloaded = repository.getSession('live')
    const assistant = reloaded?.messages.find(message => message.id === 'a1')
    expect(assistant?.isStreaming).toBe(true)
    expect(assistant?.toolCalls?.map(toolCall => toolCall.status)).toEqual(['completed', 'executing'])
    expect(assistant?.steps?.map(step => step.status)).toEqual(['completed', 'running'])

    // 盘上那一份也不该被改写(修复从前是连带 saveSession 一起落盘的)。
    await repository.flushSessionSave('live')
    const raw = createRepository(sessionsDir).getSessionRaw('live')
    expect(raw?.messages.find(message => message.id === 'a1')?.isStreaming).toBe(true)
  })

  it('still repairs on the first touch, even if the previous process wrote the file', async () => {
    const sessionsDir = createTempSessionsDir()
    const now = Date.now()
    const seeder = createRepository(sessionsDir)
    seedTranscriptFossil(sessionsDir, makeCrashedSession(now))

    // 新进程 = 新仓库实例:第一次接手照旧修(上面那条豁免只认"本进程接手过")。
    const assistant = createRepository(sessionsDir).getSession('crashed')?.messages[1]
    expect(assistant?.isStreaming).toBe(false)
    expect(assistant?.toolCalls?.map(toolCall => toolCall.status)).toEqual(['cancelled', 'cancelled'])
  })
})
