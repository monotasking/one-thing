/**
 * **F2 合同:命令即事件**(`docs/design/session-event-sourcing-2026-08.md`
 * §16.7 = F2-a、§16.8 = F2-b)。
 *
 * 两件事,一件都不能少:
 *
 * 1. **产地**:`appendMessage` / `deleteMessage` / `patchMessage`(F2-a)与
 *    `upsertMessage` / `truncateFrom`(F2-b)的事件构造已经不在翻译器里了
 *    (翻译器上连这五个方法名都没有),它住在 `command-events.ts`,是命令
 *    的第一手表达。而**写出来的事件逐字段与翻转前相同** —— 翻的是产地,不是账本。
 * 2. **时序**:事件 append 在 reducer 应用到 store **之前**。断言方式是从 store 端口
 *    (reducer 的那一步)**内部**回头看一眼活投影:如果事件真的先落了,那一刻投影里
 *    已经有这次命令的结果。用 `peekSessionProjection`(不推进)而不是
 *    `getLiveSessionProjection`(自己会 drain 尾巴)—— 后者拿来断言等于什么都没钉住。
 *
 * harness 与 `write-side-visibility.test.ts` 同款:跑**真的**事件日志 / 投影 /
 * surface,只替身最底下的会话仓库与 store 端口。
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
  messages: new Map<string, ChatMessage[]>(),
  /** 每次 store 端口被调到时,活投影(不推进)里的读数。 */
  seenByStorePort: [] as { port: string; visible: string[]; patches: Record<string, unknown> }[],
  /** `patchSession` 端口进门那一刻,投影折出来的 `sessionMeta.agentId`。 */
  sessionMetaAtPort: [] as (string | undefined)[],
}))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingSessionsDir: () => state.sessionsDir,
  getOnethingLogDir: () => path.join(state.storeDir, 'log'),
}))

vi.mock('../../stores/sessions.js', () => ({
  getSession: (id: string) => ({ id, messages: state.messages.get(id) ?? [] }),
  getSessionRaw: (id: string) => ({ id, messages: state.messages.get(id) ?? [] }),
  getSessions: () => [],
  getSessionMessages: (id: string) => state.messages.get(id),
  getSessionMessagesPage: () => ({ success: true, messages: [] }),
  getSessionUserMessageMarkers: () => [],
  readSessionTranscriptFile: () => undefined,
  // 生产接线的那几口:本用例自己搭命令面,不走 `getSessionCommands()`。
  saveSessionForCommands: () => {},
  flushSessionSave: async () => {},
  patchSessionFields: () => false,
  stampCollabAgentId: (_sessionId: string, message: ChatMessage) => message,
  updateSessionsIndexMetaForCommands: () => true,
}))

const { createSessionCommands } = await import('../commands.js')
const { sessionCommandEvents } = await import('../command-events.js')
const { sessionLifecycleEvents } = await import('../lifecycle-events.js')
const { flushSessionEventLog, readSessionLogEventsSync, resetSessionEventLogCache } = await import(
  '../event-log.js'
)
const { resetSessionSurfaceCache } = await import('../event-surface.js')
const { resetSessionRuns } = await import('../runs.js')
const { resetSessionEventStatsCache } = await import('../event-stats.js')
const { getLiveSessionProjection, peekSessionProjection, resetSessionProjectionCache } =
  await import('../projection-cache.js')
const { resetSessionEventReadCache } = await import('../events-reads.js')
const { resetSessionPrepareCache } = await import('../prepare.js')

const SESSION = 'f2a-order'

beforeEach(() => {
  delete process.env.ONETHING_SESSION_SHADOW
  state.storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-f2a-'))
  state.sessionsDir = path.join(state.storeDir, 'sessions')
  fs.mkdirSync(path.join(state.sessionsDir, SESSION), { recursive: true })
  state.messages = new Map([[SESSION, []]])
  state.seenByStorePort = []
  state.sessionMetaAtPort = []
  resetSessionEventLogCache()
  resetSessionSurfaceCache()
  resetSessionRuns()
  resetSessionEventStatsCache()
  resetSessionProjectionCache()
  resetSessionEventReadCache()
  resetSessionPrepareCache()
})

afterEach(async () => {
  await flushSessionEventLog()
  fs.rmSync(state.storeDir, { recursive: true, force: true })
})

/** 活投影**不推进地**看一眼:只有已经折进去的事件才在这里面。 */
function peekedMessageIds(): string[] {
  return (peekSessionProjection(SESSION)?.nodes ?? [])
    .filter(node => !node.hidden)
    .map(node => node.messageId)
}

function peekedNode(messageId: string) {
  return peekSessionProjection(SESSION)?.nodes.find(node => node.messageId === messageId)
}

function noteStorePort(port: string): void {
  const patches: Record<string, unknown> = {}
  for (const node of peekSessionProjection(SESSION)?.nodes ?? []) {
    // 节点上的 `patch` 是常驻的空对象 —— 只记真的落了补丁的那些。
    if (node.patch && Object.keys(node.patch).length > 0) patches[node.messageId] = node.patch
  }
  state.seenByStorePort.push({ port, visible: peekedMessageIds(), patches })
}

/**
 * §17.7.1 批 3:老 reducer 与它的执行体删了 —— 命令面对 store 的最后一次触碰是
 * **落盘调度**(`saveSession`)。所以"事件先落"的观测点就挂在它上面:被调到的
 * 那一刻,活投影里已经是这条命令写完之后的样子。
 */
function commandsOverStore(now = 4242) {
  return createSessionCommands(
    {
      saveSession: () => noteStorePort('saveSession'),
      // 与真 store 同义:那条会话不在就答不上来(F2-c 的判据靠它)。
      getSession: id => (state.messages.has(id)
        ? ({ id, messages: state.messages.get(id) } as never)
        : undefined),
      updateSessionsIndexMeta: () => true,
      flushSessionSave: async () => {},
      patchSession: (id) => {
        noteStorePort('patchSession')
        // 会话级事件不上 surface,所以"事件先落了没有"要看投影折出来的会话元数据。
        state.sessionMetaAtPort.push(
          (peekSessionProjection(SESSION) as { sessionMeta?: { agentId?: string } } | undefined)
            ?.sessionMeta?.agentId,
        )
        return state.messages.has(id)
      },
    },
    { now: () => now },
  )
}

function userMessage(id: string, content = 'hi'): ChatMessage {
  return { id, role: 'user', content, timestamp: 1 }
}

async function events(): Promise<SessionLogEventRecord[]> {
  await flushSessionEventLog(SESSION)
  return readSessionLogEventsSync(SESSION)
}

describe('F2 产地:命令的事件构造全在命令面上(§16.7 / §16.8 / §16.9)', () => {
  it('翻译器整个模块已经不在了', () => {
    // F2-c 之后 `event-translator.ts` 整体退役 —— 十三条命令的事件产地全在
    // `command-events.ts`,两个非命令采集点在 `lifecycle-events.ts`。
    // 留一个模块在那里 = 第二个产地,而"同一条命令写出两种事件"是静默的。
    expect(fs.existsSync(new URL('../event-translator.ts', import.meta.url))).toBe(false)
  })

  it('产地名单:命令面七条 + 生命周期采集点两条,一条不多一条不少', () => {
    expect(Object.keys(sessionCommandEvents).sort()).toEqual([
      'appendMessage',
      'deleteMessage',
      'patchMessage',
      'patchSession',
      'replaceAll',
      'truncateFrom',
      'upsertMessage',
    ])
    expect(Object.keys(sessionLifecycleEvents).sort()).toEqual([
      'sessionCompacted',
      'sessionCreated',
    ])
  })

  it('事件逐字段与翻转前相同:user/message + message/patched + message/deleted', async () => {
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    commands.appendMessage(SESSION, { message: userMessage('u2') })
    commands.patchMessage(SESSION, { messageId: 'u1', patch: { steered: true } as Partial<ChatMessage> })
    commands.deleteMessage(SESSION, { messageId: 'u2' })

    const line = await events()
    expect(line.map(event => event.type)).toEqual([
      'user/message',
      'user/message',
      'message/patched',
      'message/deleted',
    ])
    expect(line[0].surfaceOp).toBe('append')
    expect((line[0].data as unknown as { message: ChatMessage }).message).toEqual(userMessage('u1'))
    expect(line[2].data).toEqual({ messageId: 'u1', patch: { steered: true } })
    expect(line[2].surfaceOp).toBeUndefined()
    expect(line[3].data).toEqual({ messageId: 'u2' })
    // 只遮蔽它自己那一格(u2 是 seq 2)。
    expect(line[3].surfaceOp).toEqual({ op: 'replace', start: 2, end: 2 })
    expect(line[3].sourceEventSeqs).toEqual([2])
  })

  it('正文 / 派生字段照旧不进 message/patched;剩下全空就一条都不写', async () => {
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    commands.patchMessage(SESSION, {
      messageId: 'u1',
      patch: { content: 'rewritten', isStreaming: false, steps: [] } as Partial<ChatMessage>,
    })

    expect((await events()).map(event => event.type)).toEqual(['user/message'])
  })

  it('那条消息不在 = 一条事件都不写(判据与 reducer 的 changed 同源)', async () => {
    const commands = commandsOverStore()
    commands.patchMessage(SESSION, { messageId: 'ghost', patch: { steered: true } as Partial<ChatMessage> })
    commands.deleteMessage(SESSION, { messageId: 'ghost' })
    commands.truncateFrom(SESSION, { messageId: 'ghost', inclusive: true })
    commands.truncateFrom(SESSION, { messageId: 'ghost', inclusive: false, newContent: 'x' })

    expect(await events()).toEqual([])
  })

  /**
   * F2-c 补的那道判据(§16.9 的洞):`appendMessage` / `upsertMessage` 的 reducer
   * 恒为"改得成",唯一改不成的情形是**整条会话不在** —— 那时 store 上什么都没有,
   * 账本却会留下一条 `user/message`。两条命令口径一致:一条事件都不写。
   */
  it('整条会话不在 = append / upsert 一条事件都不写(F2-c 堵的洞)', async () => {
    const commands = commandsOverStore()
    commands.appendMessage('never-created', { message: userMessage('u1') })
    commands.upsertMessage('never-created', { message: userMessage('u2') })

    await flushSessionEventLog()
    expect(fs.existsSync(path.join(state.sessionsDir, 'never-created'))).toBe(false)
    // 同一份命令面在**在册**的那条会话上照旧写。
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    expect((await events()).map(event => event.type)).toEqual(['user/message'])
  })

  it('replaceAll:clear 遮蔽整条 surface、replaced 逐条 imported、normalize 一条不写', async () => {
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    commands.appendMessage(SESSION, { message: userMessage('u2') })

    await commands.replaceAll(SESSION, { messages: [], reason: 'clear' })
    const cleared = (await events())[2]
    expect(cleared.type).toBe('session/cleared')
    expect(cleared.data).toEqual({ reason: 'clear' })
    expect(cleared.surfaceOp).toEqual({ op: 'replace', start: 1, end: 2 })
    expect(cleared.sourceEventSeqs).toEqual([1, 2])

    await commands.replaceAll(SESSION, { messages: [userMessage('n1'), userMessage('n2')], reason: 'replaced' })
    expect((await events()).map(event => event.type).slice(3))
      .toEqual(['session/cleared', 'message/imported', 'message/imported'])

    // normalize 是冷加载的形状规整,消息集合没变 —— 判例照旧,一条都不写。
    const before = (await events()).length
    await commands.replaceAll(SESSION, { messages: [], reason: 'normalize' })
    expect(await events()).toHaveLength(before)
  })

  it('patchSession:只有 agent / model / workdir 进事件,而且只在真的变了的时候', async () => {
    state.messages.set(SESSION, [])
    const commands = commandsOverStore()
    // 快照来自 store 上那条会话;这里让它有一份"改之前"。
    commands.patchSession(SESSION, {
      patch: { agentId: 'b', workingDirectory: '/new', name: 'renamed' },
    })
    expect((await events()).map(event => event.type))
      .toEqual(['session/agent-changed', 'session/workdir-changed'])
    expect((await events())[0].data).toEqual({ to: 'b' })
    expect((await events())[1].data).toEqual({ to: '/new' })
  })

  it('patchSession:整条会话不在 = 一条事件都不写', async () => {
    const commands = commandsOverStore()
    commands.patchSession('never-created', { patch: { agentId: 'b' } })
    await flushSessionEventLog()
    expect(fs.existsSync(path.join(state.sessionsDir, 'never-created'))).toBe(false)
  })

  /**
   * §14.1 表 `commands.ts:209` 的 existed 探测判例:**流中的 assistant 消息在活投影
   * 里还没有那一格**(它的 surface 格子是 `run/start`),走随读模式分岔的门面会把
   * "就地换掉"误判成"新增",于是一条 `message/patched` 被写成了 `system/message`。
   * 判据走抄本真相面,所以流中 upsert 与落定 upsert 分得清清楚楚。
   */
  it('upsertMessage:流中 assistant = 一条不写(它在账本上那一格是 run/start)', async () => {
    const commands = commandsOverStore()
    commands.upsertMessage(SESSION, {
      message: { id: 'a1', role: 'assistant', content: '', timestamp: 1, isStreaming: true },
    })
    expect(await events()).toEqual([])
  })

  /**
   * **§17.7.1 批 3:判据换了产地,这只用例的前提跟着换。**
   *
   * 从前"在不在"问的是内存 store 上那份消息数组(与老 reducer 同源),所以流中
   * 那条 assistant 占位一进 store,第二次 upsert 就走"就地换掉"支。批 3 之后判据
   * 是**投影节点表** —— 而流中占位在账本上一格都没有(它那一格是引擎写的
   * `run/start`,不是命令面写的),于是命令面看不见它。
   *
   * 这不是丢了判据:c4-d 之后 store 的消息数组本来就是折叠产物的物化,一条
   * 折不出来的消息对**所有**读路(`listMessages` / `getMessage` 全是 `fromEvents`)
   * 一样不存在。所以这里改用一条**账本看得见**的消息验"落定支",流中那半边
   * 单独一只用例。
   */
  it('upsertMessage:落定 = fullBody 的 message/patched(带 via 说清调用类别)', async () => {
    const commands = commandsOverStore()
    const settled: ChatMessage = {
      id: 'a1', role: 'assistant', content: 'first', timestamp: 1,
    }
    commands.upsertMessage(SESSION, { message: settled })
    expect((await events()).map(event => event.type)).toEqual(['system/message'])

    commands.upsertMessage(SESSION, { message: { ...settled, content: 'settled' } })
    const line = await events()
    expect(line.map(event => event.type)).toEqual(['system/message', 'message/patched'])
    expect(line[1].data).toEqual({
      messageId: 'a1',
      patch: { role: 'assistant', content: 'settled', timestamp: 1 },
      // §17.7.1 批 2 裁定 2:整条替换这一档要说清自己是 upsert 写的 —— 它与
      // `patchMessage` 在会话账上的待遇不同(前者盖 `updatedAt`),而两者的事件
      // 形状完全同构。盖不盖章的策略住 `core/session/account.ts` 一处。
      via: 'upsert',
    })
  })

  it('upsertMessage:新增支写的就是 appendMessage 那一条(同一份构造)', async () => {
    const commands = commandsOverStore()
    commands.upsertMessage(SESSION, { message: userMessage('u1') })

    const line = await events()
    expect(line.map(event => event.type)).toEqual(['user/message'])
    expect(line[0].surfaceOp).toBe('append')
    expect((line[0].data as unknown as { message: ChatMessage }).message).toEqual(userMessage('u1'))
  })

  it('truncateFrom(regenerate):message/deleted 遮蔽"这条到末尾"', async () => {
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    commands.appendMessage(SESSION, { message: userMessage('u2') })
    commands.appendMessage(SESSION, { message: userMessage('u3') })

    commands.truncateFrom(SESSION, { messageId: 'u2', inclusive: true })

    const line = await events()
    expect(line.map(event => event.type)).toEqual([
      'user/message', 'user/message', 'user/message', 'message/deleted',
    ])
    expect(line[3].data).toEqual({ messageId: 'u2' })
    // 遮蔽的是 u2(seq 2)到末尾(seq 3),不是它自己一格。
    expect(line[3].surfaceOp).toEqual({ op: 'replace', start: 2, end: 3 })
    expect(line[3].sourceEventSeqs).toEqual([2, 3])
  })

  it('truncateFrom(edit):user/message-edited 的底稿来自抄本,正文与时刻来自命令', async () => {
    const commands = commandsOverStore(7777)
    commands.appendMessage(SESSION, {
      message: { ...userMessage('u1', 'before'), model: 'from-transcript' },
    })
    commands.appendMessage(SESSION, { message: userMessage('u2') })

    commands.truncateFrom(SESSION, { messageId: 'u1', inclusive: false, newContent: 'after' })

    const line = await events()
    expect(line.map(event => event.type)).toEqual([
      'user/message', 'user/message', 'user/message-edited',
    ])
    expect(line[2].surfaceOp).toEqual({ op: 'replace', start: 1, end: 2 })
    expect(line[2].sourceEventSeqs).toEqual([1, 2])
    // 逐字镜像 core 的 `applyTruncate`:底稿原样 + 新正文 + 新时刻。
    expect((line[2].data as unknown as { message: ChatMessage }).message).toEqual({
      id: 'u1', role: 'user', content: 'after', timestamp: 7777, model: 'from-transcript',
    })
    // 时钟同源:折叠上那条改写后的消息盖的是**同一个数**,不是第二次读表。
    expect(
      (peekSessionProjection(SESSION)?.nodes.find(
        node => !node.hidden && node.kind === 'message' && node.messageId === 'u1',
      ) as { message?: ChatMessage } | undefined)?.message?.timestamp,
    ).toBe(7777)
  })

  it('truncateFrom(edit):contentParts 只在显式带了那个键时才动', async () => {
    const withParts: ChatMessage = {
      ...userMessage('u1'),
      contentParts: [{ type: 'text', content: 'keep me' }],
    }
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: withParts })
    commands.truncateFrom(SESSION, { messageId: 'u1', inclusive: false, newContent: 'after' })

    const kept = (await events())[1]
    expect((kept.data as unknown as { message: ChatMessage }).message.contentParts)
      .toEqual([{ type: 'text', content: 'keep me' }])
  })

  it('truncateFrom(edit):显式 contentParts:null = 清空那一格', async () => {
    const withParts: ChatMessage = {
      ...userMessage('u1'),
      contentParts: [{ type: 'text', content: 'drop me' }],
    }
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: withParts })
    commands.truncateFrom(SESSION, {
      messageId: 'u1', inclusive: false, newContent: 'after', contentParts: null,
    })

    const cleared = (await events())[1]
    expect((cleared.data as unknown as { message: ChatMessage }).message)
      .not.toHaveProperty('contentParts')
  })
})

describe('F2-a 时序:事件 append 先于落盘调度(§16.7;批 3 起 store 侧只剩落盘)', () => {
  it('appendMessage:store 端口被调到的那一刻,活投影里已经有这条消息', () => {
    getLiveSessionProjection(SESSION)
    const commands = commandsOverStore()

    commands.appendMessage(SESSION, { message: userMessage('u1') })

    expect(state.seenByStorePort).toEqual([{ port: 'saveSession', visible: ['u1'], patches: {} }])
    // 而 store 侧(影子验证器)也确实推导出了同一条。
  })

  it('patchMessage:补丁在 store 端口之前就落在活投影的那条节点上', () => {
    getLiveSessionProjection(SESSION)
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    state.seenByStorePort = []

    commands.patchMessage(SESSION, { messageId: 'u1', patch: { steered: true } as Partial<ChatMessage> })

    // store 端口那一刻已经能读到自己刚写的补丁 —— 这就是 F1 的同步可见落在命令面上。
    expect(state.seenByStorePort).toEqual([
      { port: 'saveSession', visible: ['u1'], patches: { u1: { steered: true } } },
    ])
    expect((peekedNode('u1')?.patch as Record<string, unknown> | undefined)?.steered).toBe(true)
  })

  it('deleteMessage(messageId):遮蔽先生效,store 端口进门时那条已经不在投影上', () => {
    getLiveSessionProjection(SESSION)
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    commands.appendMessage(SESSION, { message: userMessage('u2') })
    state.seenByStorePort = []

    commands.deleteMessage(SESSION, { messageId: 'u2' })

    expect(state.seenByStorePort).toEqual([{ port: 'saveSession', visible: ['u1'], patches: {} }])
  })

  it('deleteMessage(matchMarker):同一条纪律 —— 先找、先记事件、后删 store', () => {
    getLiveSessionProjection(SESSION)
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    commands.appendMessage(SESSION, { message: userMessage('u2') })
    state.seenByStorePort = []

    commands.deleteMessage(SESSION, { matchMarker: message => message.id === 'u1' })

    expect(state.seenByStorePort).toEqual([{ port: 'saveSession', visible: ['u2'], patches: {} }])
  })

  it('upsertMessage:store 端口进门时,活投影上已经是换过的那一条', () => {
    getLiveSessionProjection(SESSION)
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    state.seenByStorePort = []

    commands.upsertMessage(SESSION, { message: { ...userMessage('u1'), steered: true } as ChatMessage })

    expect(state.seenByStorePort).toEqual([
      { port: 'saveSession', visible: ['u1'], patches: { u1: { role: 'user', timestamp: 1, steered: true, content: 'hi' } } },
    ])
  })

  it('truncateFrom(regenerate):遮蔽先生效,store 端口进门时那一段已经不在投影上', () => {
    getLiveSessionProjection(SESSION)
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    commands.appendMessage(SESSION, { message: userMessage('u2') })
    commands.appendMessage(SESSION, { message: userMessage('u3') })
    state.seenByStorePort = []

    commands.truncateFrom(SESSION, { messageId: 'u2', inclusive: true })

    expect(state.seenByStorePort).toEqual([
      { port: 'saveSession', visible: ['u1'], patches: {} },
    ])
  })

  it('truncateFrom(edit):改写与截断都在 store 端口之前就落在活投影上', () => {
    getLiveSessionProjection(SESSION)
    const commands = commandsOverStore(7777)
    commands.appendMessage(SESSION, { message: userMessage('u1', 'before') })
    commands.appendMessage(SESSION, { message: userMessage('u2') })
    state.seenByStorePort = []

    commands.truncateFrom(SESSION, { messageId: 'u1', inclusive: false, newContent: 'after' })

    expect(state.seenByStorePort).toEqual([
      { port: 'saveSession', visible: ['u1'], patches: {} },
    ])
    // 新节点接上了,而且带的就是命令合成的那一份。(编辑重发是"遮蔽旧格 + 加新格",
    // 所以要取**没被遮蔽**的那一格 —— 按 id 取第一格拿到的是旧的。)
    const visible = peekSessionProjection(SESSION)?.nodes.find(
      node => !node.hidden && node.kind === 'message' && node.messageId === 'u1',
    )
    const shown = (visible as { message?: ChatMessage } | undefined)?.message
    expect(shown?.content).toBe('after')
    expect(shown?.timestamp).toBe(7777)
  })

  it('replaceAll(clear):遮蔽先生效,store 端口进门时 surface 上已经空了', async () => {
    getLiveSessionProjection(SESSION)
    const commands = commandsOverStore()
    commands.appendMessage(SESSION, { message: userMessage('u1') })
    commands.appendMessage(SESSION, { message: userMessage('u2') })
    state.seenByStorePort = []

    await commands.replaceAll(SESSION, { messages: [], reason: 'clear' })

    expect(state.seenByStorePort).toEqual([
      { port: 'saveSession', visible: [], patches: {} },
    ])
  })

  it('patchSession:事件在 store 端口之前就落账(会话级三格)', async () => {
    getLiveSessionProjection(SESSION)
    const commands = commandsOverStore()
    state.seenByStorePort = []

    commands.patchSession(SESSION, { patch: { agentId: 'b' } })

    expect(state.seenByStorePort.map(entry => entry.port)).toEqual(['patchSession'])
    // 端口进门那一刻,那条事件已经折进活投影的会话元数据里了。
    expect(state.sessionMetaAtPort).toEqual(['b'])
    expect((await events()).map(event => event.type)).toEqual(['session/agent-changed'])
  })
})
