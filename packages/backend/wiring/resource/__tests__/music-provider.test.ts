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
import { ToolRunner } from '@onething/core/toolkit'
import type { Outcome, ToolEvent } from '@onething/core/toolkit'
import { ResourceEventHub, ResourceTool } from '@onething/core/resource'
import type { ResourceEvent } from '@onething/core/resource'
import { ZodValidator } from '@onething/runtime/toolkit'
import type { RadioToolAdapters, RadioToolStatus } from '@onething/runtime/toolkit'
import type { OnethingMusicNowPlaying } from '@onething/runtime/music'
import { allowAuthorizer, RecordingObserver } from '../../../../core/toolkit/__tests__/fakes.js'
import { MusicResourceProvider, type MusicPlayerAdapters } from '../music-provider.js'

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
    watchNowPlaying: () => () => {},
    ...overrides,
  }
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

async function run(provider: MusicResourceProvider, input: Record<string, unknown>): Promise<Run> {
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
    principal: { kind: 'user', userId: 'local' },
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
    const provider = new MusicResourceProvider(radioAdapters({ open }), playerAdapters())
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
    const provider = new MusicResourceProvider(radioAdapters({ open }), playerAdapters())
    const done = await run(provider, { op: 'retune', intent: '换成爵士' })

    expect(done.outcome.kind).toBe('ok')
    expect(open).toHaveBeenCalledWith('换成爵士', { clearProgramme: true }, undefined)
    expect(done.titles.at(-1)).toBe('已换台')
  })

  it('close:关台并发 radioClosed', async () => {
    const close = vi.fn(async () => ({ ...STATUS, active: false, programmeLength: 0 }))
    const provider = new MusicResourceProvider(radioAdapters({ close }), playerAdapters())
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
    const provider = new MusicResourceProvider(radioAdapters({ request }), playerAdapters())
    const done = await run(provider, { op: 'request', song: '晴天 周杰伦' })

    expect(request).toHaveBeenCalledWith('晴天 周杰伦', undefined)
    expect(done.titles.at(-1)).toBe('已插队')
    expect(done.text).toBe('「晴天 周杰伦」将在下一首播出。向用户确认时报这个完整歌名。')
  })

  it('request 失败:仍然是一次成功的回执,带端口自己那句话(旧 radio 的口径)', async () => {
    const provider = new MusicResourceProvider(
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
  it('open 的 intent 只有一个字:落 failed,措辞照抄 radio', async () => {
    const open = vi.fn(async () => STATUS)
    const provider = new MusicResourceProvider(radioAdapters({ open }), playerAdapters())
    const done = await run(provider, { op: 'open', intent: 'x' })

    expect(done.outcome.kind).toBe('failed')
    expect(failureOf(done.outcome)).toContain(
      'open/retune 需要 intent:用一句话概括听众想要的氛围',
    )
    // **端口一次都没被碰到** —— 校验在 plan 期,不是 apply 里的一句 early return。
    expect(open).not.toHaveBeenCalled()
  })

  it('request 的 song 是空白:落 failed,措辞照抄 radio', async () => {
    const request = vi.fn(async () => ({ success: true, title: 'x' }))
    const provider = new MusicResourceProvider(radioAdapters({ request }), playerAdapters())
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
    const provider = new MusicResourceProvider(radioAdapters(), playerAdapters({ command }))
    const done = await run(provider, { op })

    expect(done.outcome.kind).toBe('ok')
    expect(command).toHaveBeenCalledWith(op, undefined)
    expect(done.titles.at(-1)).toBe(title)
    expect(done.text).toContain('晴天 - 周杰伦')
  })

  it('播放命令说不 = failed,带回执自己那句话(与点歌那一条刻意不同)', async () => {
    const provider = new MusicResourceProvider(
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
    const provider = new MusicResourceProvider(radioAdapters(), playerAdapters())
    const done = await run(provider, { read: 'radio' })

    expect(done.outcome.kind).toBe('ok')
    expect(JSON.parse(done.text)).toEqual(STATUS)
  })

  it('nowPlaying:折成自述那份 schema;没有播放器在跑 = 一份「停着」的读数', async () => {
    const provider = new MusicResourceProvider(radioAdapters(), playerAdapters())
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

    const silent = new MusicResourceProvider(radioAdapters(), playerAdapters({ nowPlaying: () => null }))
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
    const provider = new MusicResourceProvider(
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

describe('music resource provider —— 地址', () => {
  it('缺席就按做法自己补;指着另一个单例就当场说不', async () => {
    const command = vi.fn(async () => ({ success: true }))
    const provider = new MusicResourceProvider(radioAdapters(), playerAdapters({ command }))

    // 显式给对的那一个:照跑。
    expect((await run(provider, { op: 'pause', ref: 'music:player' })).outcome.kind).toBe('ok')

    const wrong = await run(provider, { op: 'pause', ref: 'music:radio' })
    expect(wrong.outcome.kind).toBe('failed')
    expect(failureOf(wrong.outcome)).toContain('music:player')
  })
})
