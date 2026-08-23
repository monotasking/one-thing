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
import {
  canonicalChatMessages,
  projectChatMessages,
  projectModelHistory,
} from '@onething/core/session'

const state = vi.hoisted(() => ({
  storeDir: '',
  sessionsDir: '',
  messages: [] as ChatMessage[],
}))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

// 翻译器只从读门面取消息(`session:gate` 的那条纪律),所以测试替的也是它。
vi.mock('../reads.js', () => ({
  sessionReads: {
    getMessage: (_sessionId: string, messageId: string) =>
      state.messages.find(message => message.id === messageId),
    findMessage: (_sessionId: string, predicate: (message: ChatMessage) => boolean) =>
      state.messages.find(predicate),
    // §13.18 发现 B:写侧取材走这两扇抄本门(此替身里抄本 = state.messages)。
    getMessageFromTranscript: (_sessionId: string, messageId: string) =>
      state.messages.find(message => message.id === messageId),
    findMessageFromTranscript: (_sessionId: string, predicate: (message: ChatMessage) => boolean) =>
      state.messages.find(predicate),
    // `endSessionRun` 之后会排一次影子断言(S1b),它读的也是这扇门。
    listMessages: () => ({ messages: state.messages, changed: false }),
    getSession: () => ({ id: SESSION }),
  },
}))

const { sessionEventTranslator } = await import('../event-translator.js')
const { flushSessionEventLog, readSessionLogEventsSync, resetSessionEventLogCache } = await import(
  '../event-log.js'
)
const { resetSessionSurfaceCache } = await import('../event-surface.js')
const { beginSessionRun, endSessionRun, rotateSessionRun, resetSessionRuns } = await import('../runs.js')
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

  /**
   * G11 端到端(§10.1):collab 的 `MESSAGES_REPLACED` 走的就是
   * `sessionCommands.replaceAll(reason:'replaced')` 这一扇门。这条用例把它一路
   * 走到**投影**:事件是 `session/cleared` + 逐条 `message/imported`,而投影出来
   * 的消息列表必须**逐条等于**替换进去的那一份 —— 不是"看起来差不多",是
   * `canonicalChatMessage` 判的等。
   */
  it('G11 end-to-end: MESSAGES_REPLACED → cleared + imported, and the projection is the replaced list', async () => {
    sessionEventTranslator.appendMessage(SESSION, userMessage('old1', 'before 1'))
    sessionEventTranslator.appendMessage(SESSION, userMessage('old2', 'before 2'))

    const replacement: ChatMessage[] = [
      userMessage('n1', 'after 1'),
      { id: 'n2', role: 'assistant', content: 'after 2', timestamp: 7, model: 'gpt-4o' },
      userMessage('n3', 'after 3'),
    ]
    sessionEventTranslator.replaceAll(SESSION, replacement, 'replaced')

    const line = await events()
    expect(line.map(event => event.type)).toEqual([
      'user/message',
      'user/message',
      'session/cleared',
      'message/imported',
      'message/imported',
      'message/imported',
    ])
    const cleared = line[2]
    expect(cleared.data).toEqual({ reason: 'replaced' })
    // 旧的两格必须**列全**,否则模型历史里它们会原封不动地留着。
    expect(cleared.surfaceOp).toEqual({ op: 'replace', start: 1, end: 2 })
    expect(cleared.sourceEventSeqs).toEqual([1, 2])

    const projected = projectChatMessages(line)
    expect(canonicalChatMessages(projected.messages as unknown as Record<string, unknown>[]))
      .toEqual(canonicalChatMessages(replacement as unknown as Record<string, unknown>[]))

    // 模型可见历史上只剩新的那三条(surface 的 replace 真的遮蔽了旧的两条)。
    expect(projectModelHistory(line, { id: SESSION }).map(entry => entry.role))
      .toEqual(['user', 'assistant', 'user'])
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

/**
 * §13.7:steering 轮换之后,**这次执行**必须还收得掉自己的 run。
 *
 * 收尾的人(`executeMessageStream` 的 finally / resume 入口)手里记着的是进门时
 * 那个 runId,而轮换在执行中途换了一条。归属判据只认 `handle.runId === runId` 时,
 * 那一下直接返回:steer run 一直挂着,直到下一条用户消息进 `beginSessionRun` 被
 * 当成陈旧 run 按 `interrupted` 结掉 —— 真机 `5e4d2cea` 的 d55cf1bd 就是这样:
 * 13:53:50 正常收流(finishReason `stop`、引擎照常写了整次执行的 usage),
 * `run/end` 却是两分钟后那条用户消息带来的 `interrupted`,于是投影按
 * "completed 才计 usage" 扣掉了那条消息的用量(kind:messages 的 `0.usage` 不等)。
 */
describe('run 生命周期:steering 轮换与收尾归属(§13.7)', () => {
  it('closes the rotated run — with the runId the execution walked in with', async () => {
    const first = beginSessionRun(SESSION, { kind: 'send', assistantMessageId: 'a1' })
    const steered = rotateSessionRun(SESSION, { kind: 'steer', assistantMessageId: 'a2' })
    expect(steered.runId).not.toBe(first.runId)

    // 执行收尾:手里还是 `first.runId`(轮换是引擎内部的事,收尾的人不知道)。
    endSessionRun(SESSION, first.runId, { outcome: 'completed' })

    const ends = (await events()).filter(event => event.type === 'run/end')
    expect(ends.map(event => [event.data.runId, event.data.outcome])).toEqual([
      [first.runId, 'completed'],
      [steered.runId, 'completed'],
    ])

    // 而且下一次执行开张时,账本上没有留一条被当成"陈旧 run"的 interrupted。
    beginSessionRun(SESSION, { kind: 'send', assistantMessageId: 'a3' })
    const outcomes = (await events())
      .filter(event => event.type === 'run/end')
      .map(event => event.data.outcome)
    expect(outcomes).toEqual(['completed', 'completed'])
  })

  it('a worse outcome still wins after a rotation', async () => {
    const first = beginSessionRun(SESSION, { kind: 'send', assistantMessageId: 'a1' })
    const steered = rotateSessionRun(SESSION, { kind: 'steer', assistantMessageId: 'a2' })
    endSessionRun(SESSION, first.runId, { outcome: 'aborted' })
    const ends = (await events()).filter(event => event.type === 'run/end')
    expect(ends.map(event => [event.data.runId, event.data.outcome])).toEqual([
      [first.runId, 'completed'],
      [steered.runId, 'aborted'],
    ])
  })

  it('still refuses to close a run that belongs to another execution', async () => {
    const first = beginSessionRun(SESSION, { kind: 'send', assistantMessageId: 'a1' })
    endSessionRun(SESSION, first.runId, { outcome: 'completed' })
    const second = beginSessionRun(SESSION, { kind: 'send', assistantMessageId: 'a2' })

    // 迟到的一句"我收 first" 不该把别人的 run 收掉(轮换的凭据不跨执行传递)。
    endSessionRun(SESSION, first.runId, { outcome: 'completed' })
    const ends = (await events()).filter(event => event.type === 'run/end')
    expect(ends.map(event => event.data.runId)).toEqual([first.runId])

    endSessionRun(SESSION, second.runId, { outcome: 'completed' })
    expect((await events()).filter(event => event.type === 'run/end')).toHaveLength(2)
  })
})
