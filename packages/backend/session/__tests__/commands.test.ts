/**
 * **写门的接线**(§17.7.1 批 3:老 reducer 退役之后,这张表住在命令面上)。
 *
 * 从前这个文件问的是"命令 → `OnethingSessionMessageRuntime` → 仓库"这条链上
 * 落了什么(写计划 / lazy 档 / index meta / sqlite)。批 3 把那一层删了,于是
 * 三件事都由写门自己做,断言也就落在写门的出口上:
 *
 *  - **落盘档**(`lazy`)—— 逐字复刻归约器退役前的 `resolveLazy`;
 *  - **索引元数据** —— 哪条命令盖、哪条不盖;
 *  - **会话账落格** —— 身份三格与截断效果都从**折叠块**取(这里注入一份假账,
 *    产地本身由 `core/session/__tests__/session-account.test.ts` 与 battery 守)。
 *
 * 写计划不再有:存储驱动自 S3w-3 批 6b 起就不读它了(`storage-driver.ts` 的
 * `void plan`),归约器一死它连产地都没有 —— 断言跟着一起退役。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, ChatSession } from '@shared/ipc.js'
import type { SessionAccountState } from '@onething/core/session'

const state = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
  /**
   * E 批:**写完之后**的那份投影。
   *
   * 生产里 `events?.<cmd>()` 在 `updateSessionsIndexMeta` 之前就把活投影推过去了
   * (F1 同步可见),所以写门问 `sessionReads` 拿到的是**写后**的状态;而
   * `hasMessage`(判据)问的是写**前**那份。这只 harness 把 `events` 关掉了,
   * 两者于是会塌成同一个数组 —— 用这一格把"写后"那半单独摆出来。
   * 缺席 = 两者相同(既有用例逐字不变)。
   */
  projection: undefined as ChatMessage[] | undefined,
}))

/** 写门问读门面时看到的那一份(写后)。 */
const projected = () => state.projection ?? state.messages

vi.mock('../events-reads.js', () => ({
  eventsHasMessage: (_sessionId: string, messageId: string) =>
    state.messages.some(item => item.id === messageId),
}))

vi.mock('../reads.js', () => ({
  sessionReads: {
    getMessage: (_sessionId: string, messageId: string) =>
      state.messages.find(item => item.id === messageId),
    listMessages: () => ({ messages: state.messages, changed: false }),
    countMessages: () => projected().length,
    // E 批:截断 / 删除之后写门要回头找"最后一条说过的话"补预览格。
    findMessage: (
      _sessionId: string,
      predicate: (message: ChatMessage, index: number) => boolean,
      options: { from?: 'start' | 'end' } = {},
    ) => {
      const messages = projected()
      if (options.from === 'end') {
        for (let index = messages.length - 1; index >= 0; index--) {
          if (predicate(messages[index], index)) return messages[index]
        }
        return undefined
      }
      return messages.find(predicate)
    },
  },
}))

const { createSessionCommands } = await import('../commands.js')
const { sessionReads } = await import('../reads.js')
const { eventsHasMessage } = await import('../events-reads.js')

interface SaveCall {
  sessionId: string
  lazy: boolean
}

function message(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role: 'assistant', content: id, timestamp: 1, ...overrides } as ChatMessage
}

const NOW = 1_700_000_000_000

type AccountSource = SessionAccountState | undefined | ((call: number) => SessionAccountState | undefined)

function harness(
  messages: ChatMessage[] = [],
  sessionOverrides: Partial<ChatSession> = {},
  account: AccountSource = { totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0, updatedAt: NOW },
) {
  state.messages = messages
  state.projection = undefined
  const session = {
    id: 's1',
    name: 's1',
    messages,
    createdAt: 0,
    updatedAt: 0,
    ...sessionOverrides,
  } as ChatSession

  const saves: SaveCall[] = []
  const indexMetaUpdates: Record<string, unknown>[] = []
  const flushed: string[] = []
  const sessionPatches: Record<string, unknown>[] = []

  const commands = createSessionCommands(
    {
      reads: sessionReads,
      hasMessage: eventsHasMessage,
      getSession: id => (id === 's1' ? session : undefined),
      saveSession: (sessionId, _session, options) => {
        saves.push({ sessionId, lazy: Boolean(options?.lazy) })
      },
      updateSessionsIndexMeta: (sessionId, update) => {
        const meta: Record<string, unknown> = { id: sessionId }
        update(meta)
        indexMetaUpdates.push(meta)
        return true
      },
      flushSessionSave: async sessionId => {
        flushed.push(sessionId)
      },
      stampCollabAgentId: (_sessionId, msg) => ({ ...msg, agentId: 'agent-1' }),
      patchSession: (sessionId, patch, mutateIndexMeta) => {
        if (sessionId !== 's1') return false
        Object.assign(session, patch)
        const meta: Record<string, unknown> = { id: sessionId }
        mutateIndexMeta?.(meta as never, session)
        indexMetaUpdates.push(meta)
        sessionPatches.push(patch as Record<string, unknown>)
        return true
      },
    },
    {
      events: null,
      now: () => NOW,
      // 折叠块的取处。真生产是活投影上那一份;这里可以按"第几次问"作答,
      // 好把"事件落账之后折叠才算出这一次的效果"演出来。
      account: (() => {
        let call = 0
        return () => (typeof account === 'function' ? account(call++) : account)
      })(),
    },
  )

  return { session, commands, saves, indexMetaUpdates, flushed, sessionPatches }
}

beforeEach(() => {
  state.messages = []
})

describe('写门 —— 落盘与索引元数据', () => {
  it('appendMessage:落盘(常规档)+ 盖 index meta;stampCollab 不改调用方那条', () => {
    const h = harness([message('m1')])
    const incoming = message('m2')

    const stored = h.commands.appendMessage('s1', { message: incoming, stampCollab: true })

    expect(h.saves).toEqual([{ sessionId: 's1', lazy: false }])
    // F4-a:交回的是**入库那一条**(盖过章的),而调用方手里那条一格没动。
    expect(stored.agentId).toBe('agent-1')
    expect(incoming).not.toHaveProperty('agentId')
    expect(h.indexMetaUpdates).toHaveLength(1)
  })

  it('appendMessage:会话不在 = 一件事都不做,原样交回那一条', () => {
    const h = harness([])
    const incoming = message('m2')
    expect(h.commands.appendMessage('nope', { message: incoming })).toBe(incoming)
    expect(h.saves).toEqual([])
    expect(h.indexMetaUpdates).toEqual([])
  })

  it('upsertMessage:新增支盖 index meta,就地换掉支不盖', () => {
    const h = harness([message('m1')])

    expect(h.commands.upsertMessage('s1', { message: message('m2') })).toBe(true)
    expect(h.indexMetaUpdates).toHaveLength(1)

    h.indexMetaUpdates.length = 0
    expect(h.commands.upsertMessage('s1', { message: message('m1', { content: 'x' }) })).toBe(true)
    expect(h.indexMetaUpdates).toEqual([])
    expect(h.saves).toHaveLength(2)
  })

  /**
   * **lazy 档的映射表**(逐字复刻归约器退役前的 `resolveLazy`):
   * `hint:'stream'` → lazy;`hint:'settle'` → 常规;不给 hint 时按键推断 ——
   * 键集合完全落在 content / reasoning / contentParts / thinkingTime 里才算 stream 档。
   * 除 `patchMessage` 之外的每条命令一律常规档。
   */
  it('patchMessage:lazy 档与归约器退役前逐字一致', () => {
    const h = harness([message('m1')])

    h.commands.patchMessage('s1', { messageId: 'm1', patch: { content: 'a' }, hint: 'stream' })
    h.commands.patchMessage('s1', { messageId: 'm1', patch: { content: 'b' }, hint: 'settle' })
    h.commands.patchMessage('s1', { messageId: 'm1', patch: { content: 'c' } })
    h.commands.patchMessage('s1', { messageId: 'm1', patch: { reasoning: 'r', thinkingTime: 3 } })
    h.commands.patchMessage('s1', { messageId: 'm1', patch: { content: 'd', skillUsed: 'x' } })
    h.commands.patchMessage('s1', { messageId: 'm1', patch: {} })

    expect(h.saves.map(save => save.lazy)).toEqual([true, false, true, true, false, false])
    // 补丁不盖会话账,也不动索引(逐 token 的补丁不该把会话顶到列表最前面)。
    expect(h.indexMetaUpdates).toEqual([])
    expect(h.session.updatedAt).toBe(0)
  })

  it('patchMessage:那条消息不在 = false,一次盘都不写', () => {
    const h = harness([message('m1')])
    expect(h.commands.patchMessage('s1', { messageId: 'gone', patch: { content: 'x' } })).toBe(false)
    expect(h.saves).toEqual([])
  })

  it('deleteMessage:两种形态都落盘 + 补 index meta(E4);找不到就什么都不做', () => {
    const h = harness([message('m1'), message('m2', { skillUsed: 'mark' })])

    expect(h.commands.deleteMessage('s1', { messageId: 'm1' })).toBe(true)
    expect(h.commands.deleteMessage('s1', { matchMarker: msg => msg.skillUsed === 'mark' })).toBe(true)
    expect(h.saves).toHaveLength(2)
    expect(h.indexMetaUpdates).toHaveLength(2)

    h.saves.length = 0
    expect(h.commands.deleteMessage('s1', { messageId: 'gone' })).toBe(false)
    expect(h.commands.deleteMessage('s1', { matchMarker: () => false })).toBe(false)
    expect(h.saves).toEqual([])
  })

  it('replaceAll:盖 index 计数;clear 强刷一次,replaced 不刷', async () => {
    const h = harness([message('m1'), message('m2')])

    const cleared = await h.commands.replaceAll('s1', { messages: [], reason: 'clear' })
    expect(cleared).toEqual({ replaced: true, previousCount: 2 })
    expect(h.flushed).toEqual(['s1'])
    expect(h.indexMetaUpdates.at(-1)).toMatchObject({ messageCount: 0 })

    h.flushed.length = 0
    await h.commands.replaceAll('s1', { messages: [message('m3')], reason: 'replaced' })
    expect(h.flushed).toEqual([])
  })

  it('replaceAll:会话不在 = 什么都不做', async () => {
    const h = harness([])
    expect(await h.commands.replaceAll('nope', { messages: [], reason: 'clear' }))
      .toEqual({ replaced: false, previousCount: 0 })
    expect(h.saves).toEqual([])
  })

  it('patchSession:原样转发给仓库那一口', () => {
    const h = harness([])
    expect(h.commands.patchSession('s1', { patch: { name: 'renamed' } })).toBe(true)
    expect(h.sessionPatches).toEqual([{ name: 'renamed' }])
  })
})

describe('写门 —— 会话账落格(产地是折叠)', () => {
  it('身份三格照折叠块落', () => {
    const h = harness([message('m1')], {}, {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      updatedAt: 4242,
      lastProvider: 'deepseek',
      lastModel: 'deepseek-chat',
    })

    h.commands.appendMessage('s1', { message: message('m2') })

    expect(h.session.updatedAt).toBe(4242)
    expect(h.session.lastProvider).toBe('deepseek')
    expect(h.session.lastModel).toBe('deepseek-chat')
  })

  /**
   * 账本没启用的会话(事件目录还没建起来的那一瞬)折叠给不出答案 —— 那时按命令
   * **自己取的那一刻**盖章。不是第二套算法:时钟同源之后,折叠对这条命令给出的
   * `updatedAt` 就是这个数(见 `landAccountIdentity` 的注释)。
   */
  it('折叠给不出答案时按命令的那一刻盖章,assistant 还带上 provider/model', () => {
    const h = harness([], {}, () => undefined)
    h.commands.appendMessage('s1', {
      message: message('a1', { provider: 'openai', model: 'gpt-x' }),
    })
    expect(h.session.updatedAt).toBe(NOW)
    expect(h.session.lastProvider).toBe('openai')
    expect(h.session.lastModel).toBe('gpt-x')
  })

  it('truncateFrom:扣用量 + 落 timeline 修复 + 清 summary 三件', () => {
    const effect = {
      subtracted: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      patch: { contextSize: 7, lastInputTokens: 7 },
      deletes: ['summary', 'summaryUpToMessageId', 'summaryCreatedAt'],
    }
    const h = harness(
      [message('m1'), message('m2')],
      {
        totalInputTokens: 100,
        totalOutputTokens: 50,
        totalTokens: 150,
        summary: 's',
        summaryUpToMessageId: 'gone',
        summaryCreatedAt: 1,
      } as Partial<ChatSession>,
      // 第 0 次问 = 事件还没落(折叠里还没有这一次的效果);之后才有。
      call => ({
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        updatedAt: 555,
        ...(call === 0 ? {} : { lastTruncation: effect }),
      }),
    )

    expect(h.commands.truncateFrom('s1', { messageId: 'm2', inclusive: true })).toBe(true)

    expect(h.session).toMatchObject({
      updatedAt: 555,
      totalInputTokens: 90,
      totalOutputTokens: 45,
      totalTokens: 135,
      contextSize: 7,
      lastInputTokens: 7,
    })
    expect('summary' in h.session).toBe(false)
    expect(h.saves).toEqual([{ sessionId: 's1', lazy: false }])
    expect(h.indexMetaUpdates).toHaveLength(1)
  })

  /**
   * **同一份效果不许扣两次**。折叠为每一次截断新建一个 effect 对象,写门按
   * **对象同一性**判"这一次折叠真的算过没有" —— 判据丢了就是上一次的扣减被
   * 再扣一遍(而且是静默的)。
   */
  it('truncateFrom:折叠没为这一次新算效果时,一格都不扣', () => {
    const stale = {
      subtracted: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      patch: {},
      deletes: [],
    }
    const h = harness(
      [message('m1'), message('m2')],
      { totalInputTokens: 100, totalOutputTokens: 50, totalTokens: 150 } as Partial<ChatSession>,
      { totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0, updatedAt: 9, lastTruncation: stale },
    )

    expect(h.commands.truncateFrom('s1', { messageId: 'm2', inclusive: true })).toBe(true)
    expect(h.session).toMatchObject({
      totalInputTokens: 100,
      totalOutputTokens: 50,
      totalTokens: 150,
    })
  })

  it('truncateFrom:那条消息不在 = false,一次盘都不写', () => {
    const h = harness([message('m1')])
    expect(h.commands.truncateFrom('s1', { messageId: 'gone', inclusive: true })).toBe(false)
    expect(h.commands.truncateFrom('s1', { messageId: 'gone', inclusive: false, newContent: 'x' })).toBe(false)
    expect(h.saves).toEqual([])
  })
})

/**
 * **会话列表投影的两格**(E 批)——`lastMessagePreview` / `messageCount` 与
 * `updatedAt` 同刻维护,一格不多一格不少。
 *
 * 规则那一层由 `backend/stores/__tests__/session-list-projection.test.ts` 守;
 * 这里守的是**接线**:哪条命令盖、哪条不盖、盖的时候用的是哪一条消息。
 */
describe('写门 —— 会话列表投影(lastMessagePreview / messageCount)', () => {
  it('appendMessage:预览取刚追加的那一条,计数取投影', () => {
    const appended = message('m1', { role: 'user', content: '帮我看下' })
    const h = harness([])
    // 写后的投影里已经有这一条(F1 同步可见);写门问它要计数。
    state.projection = [appended]
    h.commands.appendMessage('s1', { message: appended })
    expect(h.indexMetaUpdates.at(-1)).toMatchObject({
      messageCount: 1,
      lastMessagePreview: '帮我看下',
    })
  })

  it('appendMessage:流式助手占位是空正文 —— 预览格不动,计数照走', () => {
    const h = harness([message('m1', { role: 'user', content: '用户上一句' })])
    state.projection = [...state.messages]
    h.commands.appendMessage('s1', { message: state.messages[0] })
    expect(h.indexMetaUpdates.at(-1)?.lastMessagePreview).toBe('用户上一句')

    const placeholder = message('m2', { role: 'assistant', content: '', isStreaming: true })
    state.projection = [...state.messages, placeholder]
    h.commands.appendMessage('s1', { message: placeholder })
    const meta = h.indexMetaUpdates.at(-1)
    // 这一格在写门上没有产地(空正文),所以它保持缺席 —— 真索引里上一次写下的
    // 那句话原样留着(写门是"就地改 meta",不是整份重建)。
    expect('lastMessagePreview' in (meta ?? {})).toBe(false)
    expect(meta?.messageCount).toBe(2)
  })

  it('patchMessage 一格都不盖 —— 逐 token 的补丁不该把会话顶到列表最前面', () => {
    const h = harness([message('m1', { role: 'assistant', content: '' })])
    h.commands.patchMessage('s1', { messageId: 'm1', patch: { content: '一个 token' } })
    expect(h.indexMetaUpdates).toEqual([])
  })

  it('deleteMessage:预览回退到剩下的最后一条"说过的话"', () => {
    const h = harness([
      message('m1', { role: 'user', content: '第一句' }),
      message('m2', { role: 'assistant', content: '第二句' }),
    ])
    // 删掉之后投影里只剩第一条(判据仍看写前那份 —— 与生产同序)。
    state.projection = [state.messages[0]]
    expect(h.commands.deleteMessage('s1', { messageId: 'm2' })).toBe(true)
    expect(h.indexMetaUpdates.at(-1)).toMatchObject({
      messageCount: 1,
      lastMessagePreview: '第一句',
    })
  })

  it('replaceAll(clear):计数归零,预览一起清掉', () => {
    const h = harness([message('m1', { role: 'user', content: '会被清掉' })])
    return h.commands.replaceAll('s1', { messages: [], reason: 'clear' }).then(() => {
      const meta = h.indexMetaUpdates.at(-1)
      expect(meta?.messageCount).toBe(0)
      expect('lastMessagePreview' in (meta ?? {})).toBe(false)
    })
  })

  it('replaceAll(replaced):预览取新那份的最后一条 user/assistant', () => {
    const h = harness([message('m0', { role: 'user', content: '旧的' })])
    const next = [
      message('n1', { role: 'user', content: '新的第一句' }),
      message('n2', { role: 'assistant', content: '新的最后一句' }),
      // `ChatMessage['role']` 里没有 'tool' 这一档;系统标记同样不算"说过的话"。
      message('n3', { role: 'system', content: '系统标记不算' }),
    ]
    return h.commands.replaceAll('s1', { messages: next, reason: 'replaced' }).then(() => {
      expect(h.indexMetaUpdates.at(-1)).toMatchObject({
        messageCount: 3,
        lastMessagePreview: '新的最后一句',
      })
    })
  })
})
