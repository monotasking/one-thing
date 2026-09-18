/**
 * K3-b —— 音乐这只 provider 的单测(假适配器,不起 backend、不起播放器)。
 *
 * 旧 `radio` 的金标(`runtime/toolkit/__tests__/golden/life.test.ts` 的
 * `golden: radio` 一族)随那只工具一起退役,用例**逐条**迁到这里:五个 action 各
 * 一条(open / retune / close / request / status —— status 成了读法)、两条参数
 * 校验(intent 只有一个字、request 缺 song)、一条点歌失败;再加 K3-b 新开的播放器
 * 四条与事件转发。
 *
 * 跑的是**真管线**:`new ResourceTool(provider)` + `ToolRunner.run`,与模型调它、
 * 界面经 `ResourceKernel.do` 调它是同一条路。假的只有那八条端口。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Principal } from '@onething/core/permission'
import { ToolRunner } from '@onething/core/toolkit'
import type { Outcome, ToolEvent } from '@onething/core/toolkit'
import { ResourceEventHub, ResourceTool } from '@onething/core/resource'
import type { ResourceEvent } from '@onething/core/resource'
import { ZodValidator } from '@onething/runtime/toolkit'
import type { RadioToolAdapters, RadioToolStatus } from '@onething/runtime/toolkit'
import type { OnethingMusicNowPlaying } from '@onething/runtime/music'
import { allowAuthorizer, RecordingObserver } from '../../../../core/toolkit/__tests__/fakes.js'
import {
  MusicResourceProvider,
  type MusicBackendAdapters,
  type MusicPlayerAdapters,
  type MusicResourceAdapters,
  type MusicStationAdapters,
} from '../music-provider.js'

const STATUS: RadioToolStatus = {
  active: true,
  intent: '安静的中文民谣',
  programmeLength: 5,
  nowPlayingTitle: '晴天',
}

const NOW_PLAYING: OnethingMusicNowPlaying = {
  status: 'playing',
  title: '晴天 - 周杰伦',
  position: 41,
  duration: 269,
  progress: '0:41 / 4:29',
  queueLength: 5,
  currentIndex: 1,
}

const BRIEF = {
  active: true,
  intent: '安静的中文民谣',
  programmeLength: 5,
  canResume: true,
  upNext: '稻香',
  volume: 62,
}

const PROGRAMME = { entries: [{ encryptedId: '1', title: '稻香' }], onDeck: '晴天' }

const LYRICS = { title: '晴天 - 周杰伦', lines: [{ at: 12, text: '故事的小黄花' }] }

const RUNTIME_STATE = {
  setupStage: 'ready' as const,
  configured: true,
  loggedIn: true,
  playerBackend: 'mpv' as const,
  source: 'fm' as const,
  login: { status: 'ok' as const },
}

function radioAdapters(overrides: Partial<RadioToolAdapters> = {}): RadioToolAdapters {
  return {
    open: async () => STATUS,
    close: async () => ({ ...STATUS, active: false, programmeLength: 0 }),
    status: () => STATUS,
    request: async () => ({ success: true, title: '晴天 周杰伦' }),
    ...overrides,
  }
}

function playerAdapters(overrides: Partial<MusicPlayerAdapters> = {}): MusicPlayerAdapters {
  return {
    command: async () => ({ success: true }),
    nowPlaying: () => NOW_PLAYING,
    lyrics: () => LYRICS,
    watchNowPlaying: () => () => {},
    watchFacts: () => () => {},
    ...overrides,
  }
}

function stationAdapters(overrides: Partial<MusicStationAdapters> = {}): MusicStationAdapters {
  return {
    brief: () => BRIEF,
    programme: () => PROGRAMME,
    programmeAction: () => ({ success: true }),
    // 缺省:话递进去了,他没回(空回话 = 不发事件,见下面那一族用例)。
    tell: async () => ({ reply: Promise.resolve(undefined) }),
    ...overrides,
  }
}

function backendAdapters(overrides: Partial<MusicBackendAdapters> = {}): MusicBackendAdapters {
  return {
    state: () => RUNTIME_STATE,
    setup: async () => ({ success: true, state: RUNTIME_STATE }),
    stopKeepalive: () => {},
    providers: () => ({ providers: [], activeId: 'ncm-cli' }),
    search: async () => ({ success: true, records: [{ title: '晴天', artist: '周杰伦', playFlag: true }] }),
    setProvider: async () => ({ success: true }),
    watchSetup: () => () => {},
    ...overrides,
  }
}

/**
 * 四族端口装成一台 provider。位置参数从两个变成一个对象(理由在 provider 的文件
 * 头),这只 helper 让既有那十四个调用点只改一个名字。
 */
function makeProvider(
  radio: RadioToolAdapters = radioAdapters(),
  player: MusicPlayerAdapters = playerAdapters(),
  overrides: Partial<MusicResourceAdapters> = {},
): MusicResourceProvider {
  return new MusicResourceProvider({
    radio,
    player,
    station: stationAdapters(),
    backend: backendAdapters(),
    ...overrides,
  })
}

/** 一次失败的说法。`Outcome.failed` 带 `error` 与 `message` 两格,比的是同一句话。 */
function failureOf(outcome: Outcome): string {
  return outcome.kind === 'failed' ? outcome.message : `not failed: ${outcome.kind}`
}

interface Run {
  outcome: Outcome
  text: string
  titles: string[]
}

async function run(
  provider: MusicResourceProvider,
  input: Record<string, unknown>,
  principal: Principal = { kind: 'user', userId: 'local' },
): Promise<Run> {
  const observer = new RecordingObserver()
  const runner = new ToolRunner({
    authorizer: allowAuthorizer,
    observer,
    validator: new ZodValidator(),
    session: () => ({ id: 'music-session' }),
  })
  const outcome = await runner.run(new ResourceTool(provider), {
    callId: 'music-call',
    toolId: 'music',
    input,
    sessionId: 'music-session',
    messageId: 'music-message',
    principal,
  })
  const text =
    outcome.kind === 'ok'
      ? outcome.result.content
          .filter(part => part.type === 'text')
          .map(part => part.text ?? '')
          .join('\n')
      : ''
  const titles = observer.events
    .map(entry => entry.event)
    .filter((event): event is Extract<ToolEvent, { type: 'annotate' }> => event.type === 'annotate')
    .map(event => event.title ?? '')
  return { outcome, text, titles }
}

describe('music resource provider —— 电台四条(旧 radio 的 action 逐条对应)', () => {
  it('open:把意图递给端口,回执带 DJ 编排那段话,并发 radioOpened', async () => {
    const open = vi.fn(async () => STATUS)
    const provider = makeProvider(radioAdapters({ open }), playerAdapters())
    const hub = new ResourceEventHub()
    const seen: ResourceEvent[] = []
    hub.watch('music:', event => seen.push(event))
    provider.attach(hub)

    const done = await run(provider, { op: 'open', intent: '下雨天,安静的中文民谣' })

    expect(done.outcome.kind).toBe('ok')
    expect(open).toHaveBeenCalledWith('下雨天,安静的中文民谣', { clearProgramme: false }, undefined)
    expect(done.titles.at(-1)).toBe('电台已开')
    expect(done.text).toContain('active: true')
    expect(done.text).toContain('DJ 正在编排')
    // 「拿状态」那句指路跟着改口:旧文案说的是 `radio(action: "status")`。
    expect(done.text).toContain('music(read: "radio")')
    expect(seen).toEqual([
      { ref: 'music:radio', event: 'radioOpened', payload: { intent: '下雨天,安静的中文民谣' } },
    ])
  })

  it('retune:同一只端口,只是 clearProgramme 为真', async () => {
    const open = vi.fn(async () => STATUS)
    const provider = makeProvider(radioAdapters({ open }), playerAdapters())
    const done = await run(provider, { op: 'retune', intent: '换成爵士' })

    expect(done.outcome.kind).toBe('ok')
    expect(open).toHaveBeenCalledWith('换成爵士', { clearProgramme: true }, undefined)
    expect(done.titles.at(-1)).toBe('已换台')
  })

  it('close:关台并发 radioClosed', async () => {
    const close = vi.fn(async () => ({ ...STATUS, active: false, programmeLength: 0 }))
    const provider = makeProvider(radioAdapters({ close }), playerAdapters())
    const hub = new ResourceEventHub()
    const seen: ResourceEvent[] = []
    hub.watch('music:', event => seen.push(event))
    provider.attach(hub)

    const done = await run(provider, { op: 'close' })

    expect(close).toHaveBeenCalledTimes(1)
    expect(done.titles.at(-1)).toBe('电台已关')
    expect(done.text).toContain('active: false')
    expect(seen.map(event => event.event)).toEqual(['radioClosed'])
  })

  it('request:插队成功,回执报完整歌名', async () => {
    const request = vi.fn(async () => ({ success: true, title: '晴天 周杰伦' }))
    const provider = makeProvider(radioAdapters({ request }), playerAdapters())
    const done = await run(provider, { op: 'request', song: '晴天 周杰伦' })

    expect(request).toHaveBeenCalledWith('晴天 周杰伦', undefined)
    expect(done.titles.at(-1)).toBe('已插队')
    expect(done.text).toBe('「晴天 周杰伦」将在下一首播出。向用户确认时报这个完整歌名。')
  })

  it('request 失败:仍然是一次成功的回执,带端口自己那句话(旧 radio 的口径)', async () => {
    const provider = makeProvider(
      radioAdapters({ request: async () => ({ success: false, error: '找不到这首歌' }) }),
      playerAdapters(),
    )
    const done = await run(provider, { op: 'request', song: '不存在的歌' })

    expect(done.outcome.kind).toBe('ok')
    expect(done.titles.at(-1)).toBe('点歌失败')
    expect(done.text).toBe('找不到这首歌')
  })
})

describe('music resource provider —— 参数校验(旧 radio 的两条边界)', () => {
  it('模型给的 intent 只有一个字:落 failed,措辞照抄 radio', async () => {
    const open = vi.fn(async () => STATUS)
    const provider = makeProvider(radioAdapters({ open }), playerAdapters())
    const done = await run(provider, { op: 'open', intent: 'x' }, { kind: 'agent', agentId: 'dj' })

    expect(done.outcome.kind).toBe('failed')
    expect(failureOf(done.outcome)).toContain(
      'open/retune 需要 intent:用一句话概括听众想要的氛围',
    )
    // **端口一次都没被碰到** —— 校验在 plan 期,不是 apply 里的一句 early return。
    expect(open).not.toHaveBeenCalled()
  })

  /**
   * 碎屑那条判据**按主体分档**(音乐收尾这一单)。它从头到尾是冲着模型来的;人这
   * 一侧空简报是一句成立的话(「你来挑」),而界面那条路今天就允许它 —— 退成投影
   * 不许把它弄丢。
   */
  it('人给的空简报:照跑,而且递给端口的就是空串(「你来挑」)', async () => {
    const open = vi.fn(async () => STATUS)
    const provider = makeProvider(radioAdapters({ open }), playerAdapters())
    const done = await run(provider, { op: 'open', intent: '' })

    expect(done.outcome.kind).toBe('ok')
    expect(open).toHaveBeenCalledWith('', { clearProgramme: false }, undefined)
  })

  it('request 的 song 是空白:落 failed,措辞照抄 radio', async () => {
    const request = vi.fn(async () => ({ success: true, title: 'x' }))
    const provider = makeProvider(radioAdapters({ request }), playerAdapters())
    const done = await run(provider, { op: 'request', song: '   ' })

    expect(done.outcome.kind).toBe('failed')
    expect(failureOf(done.outcome)).toContain('request 需要 song:')
    expect(request).not.toHaveBeenCalled()
  })
})

describe('music resource provider —— 播放器四条', () => {
  it.each([
    ['pause', '已暂停'],
    ['resume', '已继续'],
    ['next', '已切下一首'],
    ['like', '已红心'],
  ])('%s 走 MusicCommand 词表里的同名命令', async (op, title) => {
    const command = vi.fn(async () => ({ success: true }))
    const provider = makeProvider(radioAdapters(), playerAdapters({ command }))
    const done = await run(provider, { op })

    expect(done.outcome.kind).toBe('ok')
    expect(command).toHaveBeenCalledWith({ command: op }, undefined)
    expect(done.titles.at(-1)).toBe(title)
    expect(done.text).toContain('晴天 - 周杰伦')
  })

  it('播放命令说不 = failed,带回执自己那句话(与点歌那一条刻意不同)', async () => {
    const provider = makeProvider(
      radioAdapters(),
      playerAdapters({ command: async () => ({ success: false, error: '当前无播放进程' }) }),
    )
    const done = await run(provider, { op: 'pause' })

    expect(done.outcome.kind).toBe('failed')
    expect(failureOf(done.outcome)).toContain('当前无播放进程')
  })
})

describe('music resource provider —— 两条读法', () => {
  it('radio:交出来的就是 RadioToolStatus 那份形状', async () => {
    const provider = makeProvider(radioAdapters(), playerAdapters())
    const done = await run(provider, { read: 'radio' })

    expect(done.outcome.kind).toBe('ok')
    expect(JSON.parse(done.text)).toEqual(STATUS)
  })

  it('nowPlaying:折成自述那份 schema;没有播放器在跑 = 一份「停着」的读数', async () => {
    const provider = makeProvider(radioAdapters(), playerAdapters())
    expect(JSON.parse((await run(provider, { read: 'nowPlaying' })).text)).toEqual({
      playing: true,
      status: 'playing',
      title: '晴天 - 周杰伦',
      position: 41,
      duration: 269,
      progress: '0:41 / 4:29',
      queueLength: 5,
      currentIndex: 1,
    })

    const silent = makeProvider(radioAdapters(), playerAdapters({ nowPlaying: () => null }))
    expect(JSON.parse((await run(silent, { read: 'nowPlaying' })).text)).toEqual({
      playing: false,
      status: 'stopped',
      position: 0,
      queueLength: 0,
      currentIndex: 0,
    })
  })
})

describe('music resource provider —— nowPlayingChanged 的转发', () => {
  it('attach 时订一次,产地一响就转成 music:player 上的事件;dispose 之后不再订', async () => {
    let push: ((nowPlaying: OnethingMusicNowPlaying | null) => void) | undefined
    const unwatch = vi.fn()
    const provider = makeProvider(
      radioAdapters(),
      playerAdapters({
        watchNowPlaying: listener => {
          push = listener
          return unwatch
        },
      }),
    )
    const hub = new ResourceEventHub()
    const seen: ResourceEvent[] = []
    hub.watch('music:', event => seen.push(event))

    provider.attach(hub)
    expect(push).toBeTypeOf('function')

    push?.(NOW_PLAYING)
    expect(seen).toEqual([
      {
        ref: 'music:player',
        event: 'nowPlayingChanged',
        payload: {
          playing: true,
          status: 'playing',
          title: '晴天 - 周杰伦',
          position: 41,
          duration: 269,
          progress: '0:41 / 4:29',
          queueLength: 5,
          currentIndex: 1,
        },
      },
    ])

    provider.dispose()
    expect(unwatch).toHaveBeenCalledTimes(1)
    // 幂等 —— 第二次什么都不做(关机链上一条 disposer 被跑两次是常态)。
    provider.dispose()
    expect(unwatch).toHaveBeenCalledTimes(1)
  })
})

describe('music resource provider —— 听歌的事实(宠物 P4 §11.1)', () => {
  it('attach 时订一次,事实原样转成 music:player 上的事件,且每条都在自述里带着 moment;dispose 之后退订', () => {
    let push: ((event: string, payload: Record<string, unknown>) => void) | undefined
    const unwatch = vi.fn()
    const provider = makeProvider(
      radioAdapters(),
      playerAdapters({
        watchFacts: listener => {
          push = listener
          return unwatch
        },
      }),
    )
    const hub = new ResourceEventHub()
    const seen: ResourceEvent[] = []
    hub.watch('music:', event => seen.push(event))
    provider.attach(hub)

    push?.('skipStreak', { count: 3, titles: ['a', 'b', 'c'] })
    expect(seen).toEqual([{ ref: 'music:player', event: 'skipStreak', payload: { count: 3, titles: ['a', 'b', 'c'] } }])

    const moments = Object.fromEntries(
      ['trackStarted', 'skipped', 'skipStreak', 'liked', 'resumedAfterPause', 'interlude']
        .map(name => [name, provider.spec.events[name]?.moment?.weight]),
    )
    expect(moments).toEqual({
      trackStarted: 'low',
      skipped: 'low',
      skipStreak: 'high',
      liked: 'low',
      resumedAfterPause: 'normal',
      interlude: 'normal',
    })

    provider.dispose()
    expect(unwatch).toHaveBeenCalledTimes(1)
  })
})

describe('music resource provider —— 地址', () => {
  it('缺席就按做法自己补;指着另一个单例就当场说不', async () => {
    const command = vi.fn(async () => ({ success: true }))
    const provider = makeProvider(radioAdapters(), playerAdapters({ command }))

    // 显式给对的那一个:照跑。
    expect((await run(provider, { op: 'pause', ref: 'music:player' })).outcome.kind).toBe('ok')

    const wrong = await run(provider, { op: 'pause', ref: 'music:radio' })
    expect(wrong.outcome.kind).toBe('failed')
    expect(failureOf(wrong.outcome)).toContain('music:player')
  })
})

/**
 * ── 音乐收尾:补齐的那一批 ────────────────────────────────────────────────
 *
 * 十四条 RPC 方法退成投影时长出来的读法与做法。它们与上面那一批走的是同一条路,
 * 所以这里只钉各自**特有**的那一句话。
 */
describe('music resource provider —— 补齐的读法', () => {
  it.each([
    ['brief', BRIEF],
    ['programme', PROGRAMME],
    ['lyrics', LYRICS],
    ['state', RUNTIME_STATE],
    ['providers', { providers: [], activeId: 'ncm-cli' }],
  ])('%s:交出来的就是端口那份结构化值', async (read, expected) => {
    const done = await run(makeProvider(), { read })
    expect(done.outcome.kind).toBe('ok')
    expect(JSON.parse(done.text)).toEqual(expected)
  })

  it('search:空词与端口说不,两句话各有各的产地', async () => {
    const blank = await run(makeProvider(), { read: 'search', query: '  ' })
    expect(blank.outcome.kind).toBe('failed')
    expect(failureOf(blank.outcome)).toBe('query is required')

    const broken = makeProvider(undefined, undefined, {
      backend: backendAdapters({ search: async () => ({ success: false, error: '搜索失败:超时' }) }),
    })
    expect(failureOf((await run(broken, { read: 'search', query: '晴天' })).outcome)).toBe('搜索失败:超时')
  })
})

describe('music resource provider —— 补齐的做法', () => {
  it('seek / volume:缺一个数与给一个非数说的是同一句话(产地是端口那张 argv 表)', async () => {
    for (const [op, key] of [['seek', 'position'], ['volume', 'level']] as const) {
      expect(failureOf((await run(makeProvider(), { op })).outcome)).toBe(`${op} 需要一个数值参数`)
      expect(failureOf((await run(makeProvider(), { op, [key]: Number.POSITIVE_INFINITY })).outcome))
        .toBe(`${op} 需要一个数值参数`)
    }

    const command = vi.fn(async () => ({ success: true }))
    const done = await run(makeProvider(radioAdapters(), playerAdapters({ command })), { op: 'seek', position: 42 })
    expect(done.outcome.kind).toBe('ok')
    // 整只请求原样递给端口:`value` 的钳位与 argv 的拼法只有它知道。
    expect(command).toHaveBeenCalledWith({ command: 'seek', value: 42 }, undefined)
  })

  it.each([
    ['prev', 'prev'],
    ['radioResume', 'radio-resume'],
    ['radioStop', 'radio-stop'],
  ])('%s 走 MusicCommand 词表里的 %s', async (op, wire) => {
    const command = vi.fn(async () => ({ success: true }))
    const done = await run(makeProvider(radioAdapters(), playerAdapters({ command })), { op })
    expect(done.outcome.kind).toBe('ok')
    expect(command).toHaveBeenCalledWith({ command: wire }, undefined)
  })

  it('programmeAction:形状不对 = 「没给动作」;端口说不 = failed', async () => {
    expect(failureOf((await run(makeProvider(), { op: 'programmeAction' })).outcome)).toBe('action is required')
    expect(failureOf((await run(makeProvider(), { op: 'programmeAction', action: { kind: 'move', encryptedId: 'e1' } })).outcome))
      .toBe('action is required')

    const refused = makeProvider(undefined, undefined, {
      station: stationAdapters({ programmeAction: () => ({ success: false, error: '这一条已经播过了' }) }),
    })
    expect(failureOf((await run(refused, { op: 'programmeAction', action: { kind: 'remove', encryptedId: 'e1' } })).outcome))
      .toBe('这一条已经播过了')
  })

  it('setup:词表外的动作当场说不;成功时回执带整份状态,并按判据决定动不动保活播放器', async () => {
    expect(failureOf((await run(makeProvider(), { op: 'setup', action: 'rm -rf' })).outcome)).toBe('未知的配置操作')

    const stopKeepalive = vi.fn()
    const ready = makeProvider(undefined, undefined, { backend: backendAdapters({ stopKeepalive }) })
    const done = await run(ready, { op: 'setup', action: 'check-env' })
    expect(done.outcome.kind).toBe('ok')
    expect(done.outcome.kind === 'ok' ? done.outcome.result.details?.state : undefined).toEqual(RUNTIME_STATE)
    // ready + mpv:那台离屏 TUI 还有用,不停。
    expect(stopKeepalive).not.toHaveBeenCalled()

    const halfway = makeProvider(undefined, undefined, {
      backend: backendAdapters({
        stopKeepalive,
        setup: async () => ({ success: true, state: { ...RUNTIME_STATE, setupStage: 'login' as const } }),
      }),
    })
    await run(halfway, { op: 'setup', action: 'logout' })
    expect(stopKeepalive).toHaveBeenCalledTimes(1)
  })

  it('setProvider:换成了才发 providerChanged,而且发的地址是 music:provider', async () => {
    const provider = makeProvider()
    const hub = new ResourceEventHub()
    const seen: ResourceEvent[] = []
    hub.watch('music:', event => seen.push(event))
    provider.attach(hub)

    expect((await run(provider, { op: 'setProvider', providerId: 'spotify-cli' })).outcome.kind).toBe('ok')
    expect(seen).toEqual([
      { ref: 'music:provider', event: 'providerChanged', payload: { providerId: 'spotify-cli' } },
    ])

    const refused = makeProvider(undefined, undefined, {
      backend: backendAdapters({ setProvider: async () => ({ success: false, error: '未知的音乐 CLI:spotify' }) }),
    })
    const failed = await run(refused, { op: 'setProvider', providerId: 'spotify' })
    expect(failureOf(failed.outcome)).toBe('未知的音乐 CLI:spotify')
  })

  /**
   * ── 接入向导那两条事实(2026-09-18,正本 `music-panel-2026-09.md` §6.1)────────
   *
   * 壳订的就是它们:一步做完了重拉 `state`,装工具那一段把输出铺在屏上。
   */
  it('setup:每一步结束发一次 setupChanged,地址是 music:provider,负载只有 setupStage', async () => {
    const provider = makeProvider()
    const hub = new ResourceEventHub()
    const seen: ResourceEvent[] = []
    hub.watch('music:', event => seen.push(event))
    provider.attach(hub)

    expect((await run(provider, { op: 'setup', action: 'check-env' })).outcome.kind).toBe('ok')
    expect(seen).toEqual([
      { ref: 'music:provider', event: 'setupChanged', payload: { setupStage: 'ready' } },
    ])

    // 凭据一个字都不进这条事实(账本长期留着;判词在 provider 的 `plan` 上)。
    seen.length = 0
    await run(provider, { op: 'setup', action: 'set-credentials', appId: '123', privateKey: 'sk-secret' })
    expect(JSON.stringify(seen)).not.toContain('sk-secret')
    expect(seen).toHaveLength(1)
  })

  it('setup:这一步失败了就不发 —— 它是事实不是命令', async () => {
    const provider = makeProvider(undefined, undefined, {
      backend: backendAdapters({ setup: async () => ({ success: false, error: 'npm 不在这台机器上' }) }),
    })
    const hub = new ResourceEventHub()
    const seen: ResourceEvent[] = []
    hub.watch('music:', event => seen.push(event))
    provider.attach(hub)

    const failed = await run(provider, { op: 'setup', action: 'install-tool', tool: 'ncm-cli' })
    expect(failureOf(failed.outcome)).toBe('npm 不在这台机器上')
    expect(seen).toEqual([])
  })

  it('安装输出折成 setupOutput;别的向导事件一律不转,dispose 退订', async () => {
    let push: ((event: { type: string; tool?: string; chunk?: string }) => void) | undefined
    let unsubscribed = 0
    const provider = makeProvider(undefined, undefined, {
      backend: backendAdapters({
        watchSetup: listener => {
          push = listener
          return () => {
            unsubscribed += 1
            push = undefined
          }
        },
      }),
    })
    const hub = new ResourceEventHub()
    const seen: ResourceEvent[] = []
    hub.watch('music:', event => seen.push(event))
    provider.attach(hub)

    push?.({ type: 'install-output', tool: 'ncm-cli', chunk: 'added 87 packages\n' })
    // `state` 是服务内部的每一次 patch,`login-output` 里装的是登录凭据 —— 两种都不转。
    push?.({ type: 'state' })
    push?.({ type: 'login-output', chunk: 'https://music.163.com/login?codekey=secret' })
    expect(seen).toEqual([
      {
        ref: 'music:provider',
        event: 'setupOutput',
        payload: { tool: 'ncm-cli', chunk: 'added 87 packages\n' },
      },
    ])

    // 退订的是**登记方**(`mountBuiltinResources` 把它排在 unmount 之后,见 provider
    // 文件头),所以这里判的是「dispose 真的还了那张订阅」,而不是「还了之后还发不发」
    // —— 后者归端口:退订之后它压根不会再叫这只回调。
    provider.dispose()
    expect(unsubscribed).toBe(1)
    expect(push).toBeUndefined()
    provider.dispose()
    expect(unsubscribed).toBe(1)
  })

  /**
   * **效果按主体分档**(与 K3-a' 的 `removeMessage` 同一种形状)。判据直接问 `plan`
   * —— 效果是计划的一格,而「这一次将要做什么」本来就取决于谁在做。
   */
  it.each([
    ['setup', { action: 'logout' }],
    ['setProvider', { providerId: 'ncm-cli' }],
  ])('%s:人自己按的那一次零效果,模型 / 插件顶格 capability_change', async (op, params) => {
    const provider = makeProvider()
    const planWith = async (principal: Principal) =>
      (await provider.plan(op, null, params, { principal } as never)).effects.map(effect => effect.kind)

    expect(await planWith({ kind: 'user', userId: 'local' })).toEqual([])
    expect(await planWith({ kind: 'agent', agentId: 'dj' })).toEqual(['capability_change'])
    expect(await planWith({ kind: 'system', component: 'plugin:radio-skin' })).toEqual(['capability_change'])
  })
})

/**
 * 跟主持人说话(2026-09-18,正本 `apps/desktop-react/docs/music-panel-2026-09.md` §7.1)。
 *
 * 这一族问的全是**边界**:话有没有原样递进去、这条做法自己动没动别的东西、他的回话
 * 折成了哪一条事实、空回话与没回话是不是真的什么都不发。他回话那一段的判据(取哪条
 * 消息、超时多久)在端口那一侧,由 `wiring/music/__tests__/radio-talk.test.ts` 钉。
 */
describe('music resource provider —— tell(跟主持人说话)', () => {
  it('把话原样递给端口,不碰播放也不碰节目单', async () => {
    const tell = vi.fn(async () => ({ reply: Promise.resolve(undefined) }))
    const command = vi.fn(async () => ({ success: true }))
    const programmeAction = vi.fn(() => ({ success: true }))
    const provider = makeProvider(radioAdapters(), playerAdapters({ command }), {
      station: stationAdapters({ tell, programmeAction }),
    })

    const done = await run(provider, { op: 'tell', text: '换个心情' })

    expect(done.outcome.kind).toBe('ok')
    expect(tell).toHaveBeenCalledWith('换个心情', undefined)
    expect(command).not.toHaveBeenCalled()
    expect(programmeAction).not.toHaveBeenCalled()
    expect(done.titles.at(-1)).toBe('已转达')
  })

  it('零效果:说句话不该弹卡 —— 真正的改动由主持人自己的工具各自过闸', async () => {
    const provider = makeProvider()
    const effectsFor = async (principal: Principal) =>
      (await provider.plan('tell', null, { text: '现在放的是什么' }, { principal } as never)).effects

    expect(await effectsFor({ kind: 'user', userId: 'local' })).toEqual([])
    expect(await effectsFor({ kind: 'agent', agentId: 'dj' })).toEqual([])
  })

  it('空话不是一次转达', async () => {
    const tell = vi.fn(async () => ({ reply: Promise.resolve(undefined) }))
    const provider = makeProvider(radioAdapters(), playerAdapters(), { station: stationAdapters({ tell }) })

    const done = await run(provider, { op: 'tell', text: '   ' })

    expect(done.outcome.kind).toBe('failed')
    expect(failureOf(done.outcome)).toContain('tell 需要 text')
    expect(tell).not.toHaveBeenCalled()
  })

  it('他回了一句:发 hostReplied,同一句话在 text 与 say 两格上', async () => {
    const provider = makeProvider(radioAdapters(), playerAdapters(), {
      station: stationAdapters({ tell: async () => ({ reply: Promise.resolve('好,往下收一收。') }) }),
    })
    const hub = new ResourceEventHub()
    const seen: ResourceEvent[] = []
    hub.watch('music:', event => seen.push(event))
    provider.attach(hub)

    const done = await run(provider, { op: 'tell', text: '慢一点' })
    // 回话是**后来**的一条事实:做法早就交卷了,这里等的是那一发。
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(done.outcome.kind).toBe('ok')
    const replied = seen.filter(event => event.event === 'hostReplied')
    expect(replied).toHaveLength(1)
    expect(replied[0]?.ref).toBe('music:radio')
    expect(replied[0]?.payload).toEqual({ text: '好,往下收一收。', say: '好,往下收一收。' })
  })

  it('他干完活没说话(空文本 / 超时):一条事实都不发', async () => {
    const provider = makeProvider(radioAdapters(), playerAdapters(), {
      station: stationAdapters({ tell: async () => ({ reply: Promise.resolve(undefined) }) }),
    })
    const hub = new ResourceEventHub()
    const seen: ResourceEvent[] = []
    hub.watch('music:', event => seen.push(event))
    provider.attach(hub)

    await run(provider, { op: 'tell', text: '随便放点什么' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(seen.filter(event => event.event === 'hostReplied')).toHaveLength(0)
  })

  it('不等他想完:回话再久,这条做法也当场交卷', async () => {
    let release: (() => void) | undefined
    const slow = new Promise<string | undefined>(resolve => { release = () => resolve('等了很久才说的一句') })
    const provider = makeProvider(radioAdapters(), playerAdapters(), {
      station: stationAdapters({ tell: async () => ({ reply: slow }) }),
    })

    const done = await run(provider, { op: 'tell', text: '在吗' })
    expect(done.outcome.kind).toBe('ok')

    release?.()
    await slow
  })

  it('地址说错了当场说不:tell 在电台上,不在播放器上', async () => {
    const provider = makeProvider()
    const done = await run(provider, { op: 'tell', ref: 'music:player', text: '换个心情' })
    expect(done.outcome.kind).toBe('failed')
    expect(failureOf(done.outcome)).toContain('music:radio')
  })
})
