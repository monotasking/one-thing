/**
 * 主持人抽屉 —— 端口那一侧(2026-09-26,正本 `apps/desktop-react/docs/music-panel-2026-09.md` §16.3)。
 *
 * 钉三件事:状态牌(`hostState` / `hostActivity`)跟着 DJ 会话的事件走;记录流(`readHostLog`)
 * 会话不在答 `absent`、在就是那条会话的投影;报事实的订阅者炸了不拦正事。
 * 夹具抄自 `radio-talk.test.ts`(同样要假总线与会话读面),多一格 `listMessages`。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  dir: '',
  settings: { music: {} } as { music: Record<string, unknown> },
  /** 会话里此刻最后一条 assistant 消息。`null` = 一条都没有。 */
  lastAssistant: null as null | { id: string; content: unknown },
  /** 发进总线的那些命令(一条 `tell` 只该有一条)。 */
  sent: [] as Array<{ sessionId: string; command: Record<string, unknown> }>,
  /** 按 (sessionId, 事件名) 订上的处理器。用例自己扮演引擎去敲。 */
  handlers: new Map<string, Set<(envelope: unknown) => void>>(),
  /** 查无此会话的那些 id。 */
  missing: new Set<string>(),
  /** DJ 会话里的消息(`listMessages` 交出去的那一份)。 */
  messages: [] as unknown[],
  facts: [] as Array<{ event: string; payload: Record<string, unknown> }>,
  throwOnFact: false,
}))

vi.mock('@onething/backend/music/music-process-runner', () => ({
  createElectronMusicProcessRunner: () => ({
    run: async () => ({ code: 0, stdout: '{"success": true}', stderr: '' }),
    spawn: () => ({ done: Promise.resolve({ code: 0, stdout: '', stderr: '' }), kill: () => {} }),
  }),
}))

vi.mock('../player-volume.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../player-volume.js')>()),
  readProviderVolume: () => undefined,
}))

vi.mock('@onething/backend/voice/voice-host-ports', () => ({
  broadcastVoiceHostMessage: vi.fn(),
  configureVoiceHost: vi.fn(),
  getVoiceHostPorts: () => ({}),
}))

vi.mock('../music-service.js', async () => {
  const { ncmMusicProvider } = await import('@onething/backend/music/music')
  return {
    getActiveMusicProvider: () => ncmMusicProvider,
    getMusicNowPlaying: () => null,
    getMusicService: () => ({
      getState: () => ({ playerBackend: 'mpv' }),
      checkLogin: vi.fn().mockResolvedValue(false),
      refreshEnv: vi.fn().mockResolvedValue(undefined),
    }),
    nudgeMusicClients: vi.fn(),
    refreshMusicNowPlaying: vi.fn().mockResolvedValue(undefined),
    setMusicSampleListener: vi.fn(),
  }
})

vi.mock('@onething/backend/agent/agent-store-bound', () => ({
  agentExists: () => true,
  createAgent: vi.fn(),
  findAgent: () => ({ systemPrompt: '', tools: ['bash'], kind: 'service' }),
  updateAgent: vi.fn(),
}))

vi.mock('../../session/session-store.js', () => ({
  getSession: (id: string) => (mocks.missing.has(id) ? undefined : { id, messages: [], contextSize: 0 }),
  getSessionsList: vi.fn(() => []),
  createSession: vi.fn(),
  updateSessionAgent: vi.fn(),
  patchSessionFields: vi.fn(),
  onSessionsDeleted: () => () => {},
}))

vi.mock('@onething/backend/storage/storage', () => ({ getOnethingStorePath: () => mocks.dir }))
vi.mock('../../settings/settings-store.js', () => ({ getSettings: () => mocks.settings }))

/*
 * 归属这一层给一份真的(与 `radio-authorization.test.ts` 同一种摆法):每条会话都归
 * 那个固定的本机主体,于是 `sessionAccess.resolve` 走的是真判据,而不是被整只换掉。
 */
vi.mock('../../session/session-access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../session/session-access.js')>()
  return {
    ...actual,
    sessionAccess: actual.createSessionAccess({
      findMeta: (id: string) => ({ id, ownerUserId: 'local-user', ownerWorkspaceId: 'default', updatedAt: 0 }),
    }),
  }
})
vi.mock('@onething/backend/permission/permission-asks', async importOriginal => ({
  ...(await importOriginal<typeof import('@onething/backend/permission/permission-asks')>()),
  addGrant: vi.fn(),
}))
vi.mock('@onething/backend/permission/unattended', () => ({ markSessionUnattended: vi.fn() }))

vi.mock('../../session/reads.js', () => ({
  sessionReads: {
    lastMessageOfRole: (_sessionId: string, role: string) =>
      role === 'assistant' ? (mocks.lastAssistant ?? undefined) : undefined,
    countMessages: () => 0,
    listMessages: () => ({ messages: mocks.messages, changed: false }),
  },
}))

/** 一台只会记账与转发的假总线 —— 引擎那一半由用例自己扮演。 */
vi.mock('@onething/backend/event', () => ({
  getEventBus: () => ({
    emit: async (sessionId: string, command: Record<string, unknown>) => {
      mocks.sent.push({ sessionId, command })
      return { envelope: {} }
    },
    on: (sessionId: string, type: string, handler: (envelope: unknown) => void) => {
      const key = `${sessionId}|${type}`
      const set = mocks.handlers.get(key) ?? new Set()
      set.add(handler)
      mocks.handlers.set(key, set)
      return () => set.delete(handler)
    },
  }),
}))

const hostVoice = { prefetch: vi.fn(), speak: vi.fn().mockResolvedValue(undefined) }

let activeRadio: ReturnType<typeof import('../radio.js')['createRadioScope']> | undefined

async function loadRadio() {
  const radio = await import('../radio.js')
  activeRadio ??= radio.createRadioScope({
    storePath: mocks.dir,
    service: {
      ...(await import('../music-service.js')),
      runner: (await import('@onething/backend/music/music-process-runner')).createElectronMusicProcessRunner(),
    },
    hostVoice: () => hostVoice,
    announceHostFact: (event: string, payload: Record<string, unknown>) => {
      mocks.facts.push({ event, payload })
      if (mocks.throwOnFact) throw new Error('observer broke')
    },
  } as unknown as Parameters<typeof radio.createRadioScope>[0])
  return { ...radio, ...activeRadio }
}

/** 扮演引擎:这条会话上的某个事件到了,带着负载。 */
function fire(sessionId: string, type: string, event: Record<string, unknown> = {}): number {
  const handlers = mocks.handlers.get(`${sessionId}|${type}`)
  if (!handlers) return 0
  const size = handlers.size
  for (const handler of [...handlers]) handler({ event: { type, ...event } })
  return size
}

function djSessionId(radio: { getRadioStore: () => { readBrief: () => { sessionId?: string } } }): string {
  const sessionId = radio.getRadioStore().readBrief().sessionId
  if (!sessionId) throw new Error('the radio never wrote a dj session id')
  return sessionId
}

const searchCall = {
  id: 't1',
  toolId: 'bash',
  toolName: 'bash',
  arguments: { command: 'ncm-cli search song --keyword 周杰伦' },
  status: 'executing',
  timestamp: 1,
}

describe('主持人的状态牌与记录流', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.dir = mkdtempSync(path.join(os.tmpdir(), 'radio-host-'))
    mocks.settings = { music: { enabled: true } }
    mocks.lastAssistant = null
    mocks.sent = []
    mocks.handlers = new Map()
    mocks.missing = new Set()
    mocks.messages = []
    mocks.facts = []
    mocks.throwOnFact = false
  })

  afterEach(async () => {
    await activeRadio?.drain()
    activeRadio = undefined
    rmSync(mocks.dir, { recursive: true, force: true })
  })

  it('发一句 = 在想;工具调用 = 那条调用的现在时;收场 = 清空,每一步都报事实', async () => {
    const radio = await loadRadio()
    radio.getRadioStore().writeBrief({ active: true, intent: '夜里', played: [], skipped: [], loved: [] })
    expect(radio.hostState()).toEqual({ working: false })

    await radio.tellRadioHost('来点周杰伦')
    const sessionId = djSessionId(radio)
    expect(radio.hostState()).toEqual({ working: true, doing: { kind: 'thinking', label: '在想' } })
    expect(mocks.facts).toEqual([{ event: 'hostActivity', payload: { working: true, doing: { kind: 'thinking', label: '在想' } } }])

    // 参数还没流出来:还是在想 —— 状态没变就不重报。
    fire(sessionId, 'tool:input-start', { toolCallId: 't1', toolName: 'bash', toolCall: { ...searchCall, arguments: {} } })
    expect(mocks.facts).toHaveLength(1)

    fire(sessionId, 'tool:call', { toolCall: searchCall })
    expect(radio.hostState()).toEqual({ working: true, doing: { kind: 'search', label: '在搜「周杰伦」' } })
    expect(mocks.facts.slice(1)).toEqual([
      { event: 'hostActivity', payload: { working: true, doing: { kind: 'search', label: '在搜「周杰伦」' } } },
      { event: 'hostLogChanged', payload: {} },
    ])

    fire(sessionId, 'tool:result', { toolCall: { ...searchCall, status: 'completed', result: '{}' } })
    expect(mocks.facts.at(-1)).toEqual({ event: 'hostLogChanged', payload: {} })

    fire(sessionId, 'stream:complete', { data: {} })
    expect(radio.hostState()).toEqual({ working: false })
    expect(mocks.facts.slice(-2)).toEqual([
      { event: 'hostActivity', payload: { working: false } },
      { event: 'hostLogChanged', payload: {} },
    ])
    // 收场之后退订了:晚到的工具事件不再动状态牌。
    expect(fire(sessionId, 'tool:call', { toolCall: searchCall })).toBe(0)
  })

  it('新一轮顶掉旧一轮:中间不报一帧「收工了」', async () => {
    const radio = await loadRadio()
    radio.getRadioStore().writeBrief({ active: true, intent: '夜里', played: [], skipped: [], loved: [] })
    await radio.tellRadioHost('第一句')
    fire(djSessionId(radio), 'tool:call', { toolCall: searchCall })
    mocks.facts = []

    await radio.tellRadioHost('第二句')
    expect(mocks.facts).toEqual([{ event: 'hostActivity', payload: { working: true, doing: { kind: 'thinking', label: '在想' } } }])
  })

  it('报事实的订阅者炸了,话照样递进去', async () => {
    mocks.throwOnFact = true
    const radio = await loadRadio()
    radio.getRadioStore().writeBrief({ active: true, intent: '夜里', played: [], skipped: [], loved: [] })
    await expect(radio.tellRadioHost('在吗')).resolves.toBeDefined()
    expect(mocks.sent).toHaveLength(1)
    expect(radio.hostState().working).toBe(true)
  })

  it('readHostLog:简报没有会话 / 会话被删 = absent;会话在 = 那条会话的投影', async () => {
    const radio = await loadRadio()
    radio.getRadioStore().writeBrief({ active: false, intent: '', played: [], skipped: [], loved: [] })
    expect(radio.readHostLog()).toEqual({ rows: [], absent: true, truncated: false })

    radio.getRadioStore().writeBrief({ active: false, intent: '', played: [], skipped: [], loved: [], sessionId: 'gone' })
    mocks.missing.add('gone')
    expect(radio.readHostLog()).toEqual({ rows: [], absent: true, truncated: false })

    radio.getRadioStore().writeBrief({ active: false, intent: '', played: [], skipped: [], loved: [], sessionId: 'dj-1' })
    mocks.messages = [
      { id: 'u1', role: 'user', content: '放点轻音乐', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: '好。', timestamp: 2, toolCalls: [{ ...searchCall, status: 'completed' }] },
    ]
    const log = radio.readHostLog(2)
    expect(log.absent).toBe(false)
    expect(log.truncated).toBe(true)
    expect(log.rows.map(row => [row.kind, row.id])).toEqual([['card', 'a1:tool:t1'], ['host', 'a1:text:0']])
  })
})
