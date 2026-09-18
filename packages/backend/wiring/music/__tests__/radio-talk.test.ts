/**
 * 跟主持人说话 —— 端口那一侧(2026-09-18,正本
 * `apps/desktop-react/docs/music-panel-2026-09.md` §7.1)。
 *
 * 这只文件钉的是**那条真入口的形**:话怎么进 DJ 会话、回话怎么取、什么时候收手。
 * 与 `radio.test.ts` 分开住,是因为它要的假件多两样(事件总线、会话读面)——
 * 那两样在别的电台用例里一次都用不到,合进去等于让每个夹具都背着它们。
 *
 * 一件事这里**不**测:`hostReplied` 那条事实怎么发 —— 那是 provider 的事
 * (`wiring/resource/__tests__/music-provider.test.ts` 的 tell 一族)。音乐域只答
 * 「他说了这句话」,不认识谁在听。
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
}))

vi.mock('@onething/runtime/music/process-runner', () => ({
  createElectronMusicProcessRunner: () => ({
    run: async () => ({ code: 0, stdout: '{"success": true}', stderr: '' }),
    spawn: () => ({ done: Promise.resolve({ code: 0, stdout: '', stderr: '' }), kill: () => {} }),
  }),
}))

vi.mock('../player-volume.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../player-volume.js')>()),
  readProviderVolume: () => undefined,
}))

vi.mock('@onething/runtime/voice/host-ports.wiring', () => ({
  broadcastVoiceHostMessage: vi.fn(),
  configureVoiceHost: vi.fn(),
  getVoiceHostPorts: () => ({}),
}))

vi.mock('../service.js', async () => {
  const { ncmMusicProvider } = await import('@onething/runtime/music/index')
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

vi.mock('@onething/runtime/agents/store-bound.wiring', () => ({
  agentExists: () => true,
  createAgent: vi.fn(),
  findAgent: () => ({ systemPrompt: '', tools: ['bash'], kind: 'service' }),
  updateAgent: vi.fn(),
}))

vi.mock('../../../stores/sessions.js', () => ({
  getSession: (id: string) => ({ id, messages: [], contextSize: 0 }),
  getSessionsList: vi.fn(() => []),
  createSession: vi.fn(),
  updateSessionAgent: vi.fn(),
}))

vi.mock('@onething/runtime/storage/index', () => ({ getOnethingStorePath: () => mocks.dir }))
vi.mock('../../../stores/settings.js', () => ({ getSettings: () => mocks.settings }))

/*
 * 归属这一层给一份真的(与 `radio-authorization.test.ts` 同一种摆法):每条会话都归
 * 那个固定的本机主体,于是 `sessionAccess.resolve` 走的是真判据,而不是被整只换掉。
 */
vi.mock('../../../session/access.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../session/access.js')>()
  return {
    ...actual,
    sessionAccess: actual.createSessionAccess({
      findMeta: (id: string) => ({ id, ownerUserId: 'local-user', ownerWorkspaceId: 'default', updatedAt: 0 }),
    }),
  }
})
vi.mock('@onething/core', async importOriginal => ({
  ...(await importOriginal<typeof import('@onething/core')>()),
  addGrant: vi.fn(),
}))
vi.mock('@onething/runtime/permissions/unattended', () => ({ markSessionUnattended: vi.fn() }))

vi.mock('../../../session/reads.js', () => ({
  sessionReads: {
    lastMessageOfRole: (_sessionId: string, role: string) =>
      role === 'assistant' ? (mocks.lastAssistant ?? undefined) : undefined,
    countMessages: () => 0,
  },
}))

/** 一台只会记账与转发的假总线 —— 引擎那一半由用例自己扮演。 */
vi.mock('../../../events/index.js', () => ({
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
      ...(await import('../service.js')),
      runner: (await import('@onething/runtime/music/process-runner')).createElectronMusicProcessRunner(),
    },
    hostVoice: () => hostVoice,
  } as unknown as Parameters<typeof radio.createRadioScope>[0])
  return { ...radio, ...activeRadio }
}

/** 扮演引擎:这条会话上的某个事件到了。返回敲到了几只处理器。 */
function fire(sessionId: string, type: string): number {
  const handlers = mocks.handlers.get(`${sessionId}|${type}`)
  if (!handlers) return 0
  // 数在敲之前:处理器跑完会**当场退订**(那正是这条路该做的),敲完再数恒为 0。
  const size = handlers.size
  for (const handler of [...handlers]) handler({ event: { type } })
  return size
}

/** 这一发 `tell` 进的是哪条会话 —— 电台自己写在简报上的那一格。 */
function djSessionId(radio: { getRadioStore: () => { readBrief: () => { sessionId?: string } } }): string {
  const sessionId = radio.getRadioStore().readBrief().sessionId
  if (!sessionId) throw new Error('the radio never wrote a dj session id')
  return sessionId
}

describe('tellRadioHost', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.dir = mkdtempSync(path.join(os.tmpdir(), 'radio-talk-'))
    mocks.settings = { music: { enabled: true } }
    mocks.lastAssistant = null
    mocks.sent = []
    mocks.handlers = new Map()
  })

  afterEach(async () => {
    await activeRadio?.drain()
    activeRadio = undefined
    rmSync(mocks.dir, { recursive: true, force: true })
    vi.useRealTimers()
  })

  it('人说的话进 DJ 那条会话:一条 SEND_MESSAGE,裹着交代、原话在里面、不当标题', async () => {
    const radio = await loadRadio()
    radio.getRadioStore().writeBrief({ active: true, intent: '下雨天', played: [], skipped: [], loved: [] })

    await radio.tellRadioHost('换个心情,别太吵')

    expect(mocks.sent).toHaveLength(1)
    const { command } = mocks.sent[0]
    expect(command.type).toBe('command:send-message')
    expect(command.source).toBe('radio')
    // 会话名是「电台」,这一句不是标题。
    expect(command.suppressTitleGeneration).toBe(true)
    const content = String(command.content)
    // 原话原样在里面,而且裹在不可信标签里(它是人打进来的字)。
    expect(content).toContain('换个心情,别太吵')
    expect(content).toContain('<untrusted_listener_message>')
    // 交代那一句:他可以去改节目单,回话一两句。
    expect(content).toContain('听众在跟你说话')
    expect(content).toContain('收件箱')
  })

  it('与唤醒词同一份 radioDj 模型覆盖', async () => {
    mocks.settings = {
      music: { enabled: true, radioDj: { providerId: 'deepseek', model: 'v3', thinking: true, thinkingEffort: 'high' } },
    }
    const radio = await loadRadio()
    radio.getRadioStore().writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })

    await radio.tellRadioHost('在吗')

    expect(mocks.sent[0].command).toMatchObject({
      providerId: 'deepseek',
      model: 'v3',
      thinking: true,
      thinkingEffort: 'high',
    })
  })

  it('流结束:取这一轮最后一条 assistant 文本当他的回话', async () => {
    const radio = await loadRadio()
    radio.getRadioStore().writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })

    const { reply } = await radio.tellRadioHost('慢一点')
    const sessionId = djSessionId(radio)
    mocks.lastAssistant = { id: 'm2', content: '  好,往下收一收。  ' }
    expect(fire(sessionId, 'stream:complete')).toBe(1)

    await expect(reply).resolves.toBe('好,往下收一收。')
    // 说完就退订:同一条会话的下一轮不该再惊动这一发。
    expect(mocks.handlers.get(`${sessionId}|stream:complete`)?.size).toBe(0)
  })

  it('他干完活不说话:空文本没有回话', async () => {
    const radio = await loadRadio()
    radio.getRadioStore().writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })

    const { reply } = await radio.tellRadioHost('随便放点什么')
    mocks.lastAssistant = { id: 'm2', content: '   ' }
    fire(djSessionId(radio), 'stream:complete')

    await expect(reply).resolves.toBeUndefined()
  })

  it('这一轮一条 assistant 都没落下:上一轮那句话不冒充新的', async () => {
    const radio = await loadRadio()
    radio.getRadioStore().writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })
    // 发之前就摆在那儿的那一句。
    mocks.lastAssistant = { id: 'm1', content: '上一轮说过的话' }

    const { reply } = await radio.tellRadioHost('在吗')
    fire(djSessionId(radio), 'stream:complete')

    await expect(reply).resolves.toBeUndefined()
  })

  it('60s 没说完就放手,而且订阅一并退掉', async () => {
    vi.useFakeTimers()
    const radio = await loadRadio()
    radio.getRadioStore().writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })

    const { reply } = await radio.tellRadioHost('在吗')
    const sessionId = djSessionId(radio)
    expect(mocks.handlers.get(`${sessionId}|stream:complete`)?.size).toBe(1)

    await vi.advanceTimersByTimeAsync(60_000)
    await expect(reply).resolves.toBeUndefined()
    expect(mocks.handlers.get(`${sessionId}|stream:complete`)?.size).toBe(0)
  })

  it('流炸了 = 没有回话', async () => {
    const radio = await loadRadio()
    radio.getRadioStore().writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })

    const { reply } = await radio.tellRadioHost('在吗')
    mocks.lastAssistant = { id: 'm2', content: '半句话' }
    fire(djSessionId(radio), 'stream:error')

    await expect(reply).resolves.toBeUndefined()
  })

  it('电台收尾(关台 / 换 CLI)也是放手:等待当场结束,不吊住 drain', async () => {
    const radio = await loadRadio()
    radio.getRadioStore().writeBrief({ active: true, intent: 'x', played: [], skipped: [], loved: [] })

    const { reply } = await radio.tellRadioHost('在吗')
    await radio.drain()
    activeRadio = undefined

    await expect(reply).resolves.toBeUndefined()
  })
})
