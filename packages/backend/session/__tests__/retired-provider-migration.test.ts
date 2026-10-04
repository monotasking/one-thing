/**
 * A6-b(2026-09-26):`claude-code-agent` 退役后,老会话的外壳在冷加载时改写成
 * `acp` + `claude-code`,落一次 `meta.json`,账本不动;下一条消息因此进 ACP 连接器。
 *
 * 反证:把 `session-repository.ts` 里 `rewriteRetiredSessionProvider(stored)` 那一行摘掉,
 * 第一条用例的 `lastProvider` 断言就红;第三条的「发送走 ACP」也随之红(provider 工厂
 * 已经不认 `claude-code-agent`,见第三条的第一句断言)。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CoreSession, CoreSessionDetails, CoreSessionMeta, StoredChatMessage, UserMessageMarker } from '@onething/backend/session'
import { encodeJsonlHeaderLine, encodeJsonlMessageLine } from '@onething/backend/session'
import { createOnethingSessionRepository } from '../session-repository.js'
import { createHybridSessionStorageDriver } from '../session-storage-driver.js'
import { rewriteRetiredSessionProvider } from '../session-retired-providers.js'
import { createAgentProviderFromRuntime } from '../../provider/provider.js'
import type { ExternalAgentConnector, ExternalAgentTurnRequest } from '../../external-agent/external-agent.js'

interface TestMessage extends StoredChatMessage {
  content: string
}

interface TestSession extends CoreSession<TestMessage> {
  id: string
  lastProvider?: string
  lastModel?: string
  workingDirectory?: string
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

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

/** 一条 A6-b 之前的 Claude SDK 会话:外壳 + 一行化石消息 + 一份账本(验证不被碰)。 */
function seedLegacyClaudeSession(): { sessionsDir: string; sessionId: string; workdir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-retired-provider-'))
  tempDirs.push(root)
  const sessionsDir = path.join(root, 'sessions')
  const workdir = path.join(root, 'work')
  fs.mkdirSync(workdir, { recursive: true })
  const sessionId = 'legacy-claude'
  const dir = path.join(sessionsDir, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const message: TestMessage = { id: 'm1', role: 'user', content: '你好', timestamp: 1 }
  fs.writeFileSync(
    path.join(dir, 'messages.jsonl'),
    encodeJsonlHeaderLine(sessionId) + encodeJsonlMessageLine(1, message),
    'utf-8',
  )
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '{"legacy":"ledger"}\n', 'utf-8')
  writeJsonFile(path.join(dir, 'meta.json'), {
    id: sessionId,
    name: 'old claude session',
    createdAt: 1,
    updatedAt: 1,
    agentId: 'default',
    workingDirectory: workdir,
    lastProvider: 'claude-code-agent',
    lastModel: 'claude-sonnet-5',
    formatVersion: 2,
    log: { messageCount: 1, lastSeq: 1 },
  })
  return { sessionsDir, sessionId, workdir }
}

function createRepository(sessionsDir: string) {
  const storageDriver = createHybridSessionStorageDriver<TestSession>({
    getSessionsDir: () => sessionsDir,
    getLegacySessionPath: sessionId => path.join(sessionsDir, `${sessionId}.json`),
    newSessionFormat: () => 'jsonl',
    readJsonFile,
    writeJsonFileAsync: async (filePath, data) => { writeJsonFile(filePath, data) },
    deleteJsonFile: filePath => fs.rmSync(filePath, { force: true }),
  })
  return createOnethingSessionRepository<TestSession, TestMessage, CoreSessionMeta, CoreSessionDetails, UserMessageMarker>({
    defaultAgentId: 'default',
    getSessionsDir: () => sessionsDir,
    getSessionPath: sessionId => path.join(sessionsDir, `${sessionId}.json`),
    readJsonFile,
    writeJsonFile,
    writeJsonFileAsync: async (filePath, data) => { writeJsonFile(filePath, data) },
    deleteJsonFile: filePath => fs.rmSync(filePath, { force: true }),
    storageDriver,
    getCurrentSessionId: () => '',
    setCurrentSessionId: () => {},
    getDefaultWorkingDirectory: () => '/tmp/workspace',
    logger: { info: () => {}, error: () => {} },
  })
}

describe('A6-b:退役 provider 的会话改写', () => {
  it('冷加载把 claude-code-agent 改写成 acp + claude-code,落一次 meta.json,账本不动', async () => {
    const { sessionsDir, sessionId } = seedLegacyClaudeSession()
    const ledgerBefore = fs.readFileSync(path.join(sessionsDir, sessionId, 'events.jsonl'), 'utf-8')
    const repository = createRepository(sessionsDir)

    const session = repository.getSession(sessionId)
    expect(session?.lastProvider).toBe('acp')
    expect(session?.lastModel).toBe('claude-code')

    await repository.flushAllPendingSaves()
    const meta = JSON.parse(fs.readFileSync(path.join(sessionsDir, sessionId, 'meta.json'), 'utf-8'))
    expect(meta).toMatchObject({ lastProvider: 'acp', lastModel: 'claude-code', name: 'old claude session' })
    expect(fs.readFileSync(path.join(sessionsDir, sessionId, 'events.jsonl'), 'utf-8')).toBe(ledgerBefore)

    // 另一个进程(新仓库实例)读到的已经是改写后的外壳:不再命中退役表。
    const next = createRepository(sessionsDir)
    const stored = next.getSessionRaw(sessionId)
    expect(stored?.lastProvider).toBe('acp')
    expect(rewriteRetiredSessionProvider(stored)).toBeUndefined()
  })

  it('纯函数:只认退役表,别的 provider 一个字不碰', () => {
    const other = { lastProvider: 'deepseek', lastModel: 'deepseek-chat' }
    expect(rewriteRetiredSessionProvider(other)).toBeUndefined()
    expect(other).toEqual({ lastProvider: 'deepseek', lastModel: 'deepseek-chat' })

    const legacy = { lastProvider: 'claude-code-agent', lastModel: 'claude-opus-4-8' }
    expect(rewriteRetiredSessionProvider(legacy)).toEqual({
      from: { provider: 'claude-code-agent', model: 'claude-opus-4-8' },
      to: { provider: 'acp', model: 'claude-code' },
    })
    expect(legacy).toEqual({ lastProvider: 'acp', lastModel: 'claude-code' })
  })

  it('改写之后发一条消息走 ACP 连接器,agent 是 claude-code', async () => {
    const { sessionsDir, sessionId, workdir } = seedLegacyClaudeSession()
    const captured: ExternalAgentTurnRequest[] = []
    const fakeAcp: ExternalAgentConnector = {
      id: 'acp',
      capabilities: {
        streamingText: true,
        thinking: true,
        toolSteps: true,
        permissionBridge: 'callback',
        resume: true,
        fork: false,
        steer: false,
        imagesIn: false,
        mcpInjection: 'config',
        concurrentSessions: 'per-process',
      },
      async *streamTurn(request) {
        captured.push(request)
        yield { type: 'text-delta', turn: request.turn, delta: 'pong' }
        yield { type: 'finish', turn: request.turn, finishReason: 'stop' }
      },
      async interrupt() {},
      async dispose() {},
    }
    const connectors = { acp: fakeAcp }

    // 退役的 id 在 provider 工厂里已经不存在:不改写,这条会话就发不出去。
    expect(createAgentProviderFromRuntime('claude-code-agent', { model: 'claude-sonnet-5' }, {
      externalAgentConnectors: connectors,
    })).toBeUndefined()

    const session = createRepository(sessionsDir).getSession(sessionId)!
    const provider = createAgentProviderFromRuntime(session.lastProvider!, { model: session.lastModel! }, {
      externalAgentConnectors: connectors,
      localSessionId: sessionId,
      workingDirectory: workdir,
    })
    expect(provider).toBeDefined()
    for await (const _event of provider!.streamTurn!({
      model: session.lastModel!,
      messages: [{ role: 'user', content: '只回复单词 pong' }],
      turn: 1,
    })) { /* drain */ }
    expect(captured).toHaveLength(1)
    expect(captured[0]).toMatchObject({ localSessionId: sessionId, model: 'claude-code', prompt: '只回复单词 pong' })
  })
})
