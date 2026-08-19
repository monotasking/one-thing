/**
 * S1a:命令 → 事件的翻译表(§9.3 / §10.6 第 2 条)。
 *
 * 每条用例问的都是同一个问题:**这次命令在账本上留下了什么**,以及
 * surfaceOp / sourceEventSeqs 对不对。后者是这一期最容易写错、又最难在别处看
 * 出来的一格:少列一个 seq,模型历史里就会留着一段本该被遮掉的旧对话,而 UI
 * 上一切正常。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@shared/ipc.js'
import type { SessionLogEventRecord } from '@onething/core/session'

const state = vi.hoisted(() => ({
  storeDir: '',
  sessionsDir: '',
  messages: [] as ChatMessage[],
}))

vi.mock('../../stores/paths.js', () => ({
  getSessionsDir: () => state.sessionsDir,
  getLogDir: () => path.join(state.storeDir, 'log'),
}))

// 翻译器只从读门面取消息(`session:gate` 的那条纪律),所以测试替的也是它。
vi.mock('../reads.js', () => ({
  sessionReads: {
    getMessage: (_sessionId: string, messageId: string) =>
      state.messages.find(message => message.id === messageId),
    findMessage: (_sessionId: string, predicate: (message: ChatMessage) => boolean) =>
      state.messages.find(predicate),
  },
}))

const { sessionEventTranslator } = await import('../event-translator.js')
const { flushSessionEventLog, readSessionLogEventsSync, resetSessionEventLogCache } = await import(
  '../event-log.js'
)
const { resetSessionSurfaceCache } = await import('../event-surface.js')
const { beginSessionRun, endSessionRun, resetSessionRuns } = await import('../runs.js')
const { resetSessionEventStatsCache } = await import('../event-stats.js')

const SESSION = 's1'

beforeEach(() => {
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-translate-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  fs.writeFileSync(path.join(state.sessionsDir, SESSION, 'meta.json'), '{}')
  state.messages = []
  resetSessionEventLogCache()
  resetSessionSurfaceCache()
  resetSessionRuns()
  resetSessionEventStatsCache()
})

afterEach(async () => {
  await flushSessionEventLog()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

function userMessage(id: string, content = 'hi'): ChatMessage {
  return { id, role: 'user', content, timestamp: 1 }
}

/** append 是排队落盘的,所以读之前先过一次检查点。 */
async function events(): Promise<SessionLogEventRecord[]> {
  await flushSessionEventLog(SESSION)
  return readSessionLogEventsSync(SESSION)
}

async function types(): Promise<string[]> {
  return (await events()).map(event => event.type)
}

describe('command → event translation (§9.3)', () => {
  it('appendMessage: user → user/message, system → system/message, streaming assistant → nothing', async () => {
    sessionEventTranslator.appendMessage(SESSION, userMessage('u1'))
    sessionEventTranslator.appendMessage(SESSION, {
      id: 'sys1', role: 'system', content: 'marker', timestamp: 2,
    })
    // 助手占位由 `run/start` 表达 —— 一条消息一格,不能有两格。
    sessionEventTranslator.appendMessage(SESSION, {
      id: 'a1', role: 'assistant', content: '', timestamp: 3, isStreaming: true,
    })

    expect((await types())).toEqual(['user/message', 'system/message'])
    expect((await events()).every(event => event.surfaceOp === 'append')).toBe(true)
  })

  it('patchMessage: body and derived fields never make it into message/patched', async () => {
    sessionEventTranslator.appendMessage(SESSION, userMessage('u1'))
    sessionEventTranslator.patchMessage(SESSION, 'u1', {
      content: 'rewritten',
      reasoning: 'nope',
      isStreaming: false,
      steps: [],
      steered: true,
    } as Partial<ChatMessage>)

    const patched = (await events()).find(event => event.type === 'message/patched')
    expect(patched?.type === 'message/patched' && patched.data.patch).toEqual({ steered: true })

    // 只有正文字段的 patch 一条事件都不写。
    sessionEventTranslator.patchMessage(SESSION, 'u1', { content: 'again' } as Partial<ChatMessage>)
    expect((await events()).filter(event => event.type === 'message/patched')).toHaveLength(1)
  })

  it('patchMessage: turnContext becomes context/turn-update, not a patch', async () => {
    sessionEventTranslator.appendMessage(SESSION, userMessage('u1'))
    sessionEventTranslator.patchMessage(SESSION, 'u1', {
      turnContext: { set: { datetime: '2026-08-19' } },
    } as Partial<ChatMessage>)

    const update = (await events()).find(event => event.type === 'context/turn-update')
    expect(update?.type === 'context/turn-update' && update.data).toEqual({
      messageId: 'u1',
      set: { datetime: '2026-08-19' },
    })
    expect((await types())).not.toContain('message/patched')
  })

  it('user attachments land as BlobRef, never as inline base64', async () => {
    const base64 = Buffer.from('imagine an image').toString('base64')
    sessionEventTranslator.appendMessage(SESSION, {
      ...userMessage('u1'),
      attachments: [{
        id: 'att1', fileName: 'a.png', mimeType: 'image/png',
        size: 16, mediaType: 'image', base64Data: base64,
      }],
    })

    const event = (await events())[0]
    const attachments = (event.data as unknown as {
      message: { attachments: Array<{ base64Data: unknown }> }
    }).message.attachments
    expect(attachments[0].base64Data).toEqual({
      hash: expect.stringMatching(/^[0-9a-f]{16}$/),
      bytes: 16,
      mime: 'image/png',
    })
    // 事件行里没有那一坨 base64。
    expect(JSON.stringify(event)).not.toContain(base64)
  })

  it('deleteMessage shadows exactly its own surface node', async () => {
    sessionEventTranslator.appendMessage(SESSION, userMessage('u1'))
    sessionEventTranslator.appendMessage(SESSION, userMessage('u2'))
    sessionEventTranslator.deleteMessage(SESSION, 'u1')

    const deleted = (await events()).find(event => event.type === 'message/deleted')!
    expect(deleted.surfaceOp).toEqual({ op: 'replace', start: 1, end: 1 })
    expect(deleted.sourceEventSeqs).toEqual([1])
  })

  it('truncateFrom(edit) replaces from that message to the end of the surface', async () => {
    state.messages = [userMessage('u1', 'edited')]
    sessionEventTranslator.appendMessage(SESSION, userMessage('u1'))
    const run = beginSessionRun(SESSION, { kind: 'send', assistantMessageId: 'a1' })
    endSessionRun(SESSION, run.runId, { outcome: 'completed' })
    sessionEventTranslator.appendMessage(SESSION, userMessage('u2'))

    sessionEventTranslator.truncateFrom(SESSION, { messageId: 'u1', inclusive: false }, undefined)

    const edited = (await events()).find(event => event.type === 'user/message-edited')!
    // surface 上的三格:u1(1) / run-start(2) / u2(4)。全部被这一条替换掉。
    expect(edited.surfaceOp).toEqual({ op: 'replace', start: 1, end: 4 })
    expect(edited.sourceEventSeqs).toEqual([1, 2, 4])
    expect((edited.data as unknown as { message: { content: string } }).message.content).toBe('edited')
  })

  it('truncateFrom(regenerate) deletes inclusively with the same range', async () => {
    sessionEventTranslator.appendMessage(SESSION, userMessage('u1'))
    sessionEventTranslator.appendMessage(SESSION, userMessage('u2'))
    sessionEventTranslator.truncateFrom(SESSION, { messageId: 'u2', inclusive: true }, undefined)

    const deleted = (await events()).find(event => event.type === 'message/deleted')!
    expect(deleted.surfaceOp).toEqual({ op: 'replace', start: 2, end: 2 })
    expect(deleted.sourceEventSeqs).toEqual([2])
  })

  it('replaceAll(clear) shadows the whole surface; replaced re-imports every message (G11)', async () => {
    sessionEventTranslator.appendMessage(SESSION, userMessage('u1'))
    sessionEventTranslator.appendMessage(SESSION, userMessage('u2'))

    sessionEventTranslator.replaceAll(SESSION, [], 'clear')
    const cleared = (await events()).find(event => event.type === 'session/cleared')!
    expect(cleared.data).toEqual({ reason: 'clear' })
    expect(cleared.surfaceOp).toEqual({ op: 'replace', start: 1, end: 2 })
    expect(cleared.sourceEventSeqs).toEqual([1, 2])

    sessionEventTranslator.replaceAll(SESSION, [userMessage('n1'), userMessage('n2')], 'replaced')
    expect((await types()).slice(3)).toEqual(['session/cleared', 'message/imported', 'message/imported'])

    // normalize 是冷加载的形状规整,消息集合没变 —— 一条都不写。
    const before = (await events()).length
    sessionEventTranslator.replaceAll(SESSION, [], 'normalize')
    expect((await events())).toHaveLength(before)
  })

  it('patchSession: only agent / model / workdir become events, and only when they change', async () => {
    const before = {
      agentId: 'a', lastModel: 'm', lastProvider: 'p', workingDirectory: '/old',
    }
    sessionEventTranslator.patchSession(
      SESSION,
      { agentId: 'b', lastModel: 'm', workingDirectory: '/new', name: 'renamed' },
      before,
    )
    expect((await types())).toEqual(['session/agent-changed', 'session/workdir-changed'])
    const agent = (await events())[0]
    expect(agent.data).toEqual({ from: 'a', to: 'b' })
    expect((await events())[1].data).toEqual({ from: '/old', to: '/new' })
  })

  it('session/compacted replaces up to the cutoff; a failed compact shadows nothing', async () => {
    sessionEventTranslator.appendMessage(SESSION, userMessage('u1'))
    sessionEventTranslator.appendMessage(SESSION, userMessage('u2'))
    sessionEventTranslator.appendMessage(SESSION, userMessage('u3'))

    sessionEventTranslator.sessionCompacted(SESSION, {
      messageId: 'c1',
      summary: '## Goal\nx',
      compactedMessageCount: 2,
      compactedThroughMessageId: 'u2',
      status: 'completed',
    })
    const compacted = (await events()).find(event => event.type === 'session/compacted')!
    expect(compacted.surfaceOp).toEqual({ op: 'replace', start: 1, end: 2 })
    expect(compacted.sourceEventSeqs).toEqual([1, 2])

    sessionEventTranslator.sessionCompacted(SESSION, {
      messageId: 'c2',
      summary: '',
      compactedMessageCount: 1,
      compactedThroughMessageId: 'u3',
      status: 'failed',
      error: 'boom',
    })
    const failed = (await events()).filter(event => event.type === 'session/compacted')[1]
    expect(failed.surfaceOp).toBe('append')
    expect(failed.sourceEventSeqs).toBeUndefined()
  })

  it('writes nothing at all for a session that is not on the event ledger', async () => {
    sessionEventTranslator.appendMessage('legacy-session', userMessage('u1'))
    expect(fs.existsSync(path.join(state.sessionsDir, 'legacy-session'))).toBe(false)
  })
})
