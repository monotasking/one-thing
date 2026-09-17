/**
 * 宠物子系统的接线(§9.4 / §9.6 第二条):一种**假资源**发事件,经真的
 * `forwardResourceEventsToBus` 上真的总线,子系统查注册表里的 `moment` 喂宿主。
 *
 *   · 带 `moment` 且带现成台词的事件 → `pet:` 发出 `utterance`,账本落盘;
 *   · 不带 `moment` 的事件 → 什么都不发生;
 *   · `pet:` 自己的 `poked` 绕回来只进账本,不开口;
 *   · `say` 被预算挡掉回执说原因,`adopt` 未知 id 当场拒绝。
 *
 * 内核的 runner 用不上(这里只 mount 与 emit),provider 的 plan / apply 直接调。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ResourceKernel,
  ResourceRegistry,
  type ResourceEventHub,
  type ResourceProvider,
  type ResourceSpec,
} from '@onething/core/resource'
import type { PlanContext, RunContext, ToolRunner } from '@onething/core/toolkit'
import type { Utterance } from '@onething/runtime/pets'
import { EventBus } from '../../../events/event-bus.js'
import { forwardResourceEventsToBus } from '../../resource/event-bridge.js'
import { PetResourceProvider } from '../../resource/pet-provider.js'
import type { HostVoiceKit, PatterSpeech } from '../../music/host-voice.js'
import { PetsSubsystem, UnknownPetError } from '../subsystem.js'

const EMPTY = { type: 'object', properties: {}, required: [] }

const demoSpec: ResourceSpec = {
  scheme: 'demo',
  title: 'A resource the pet system has never heard of',
  reads: {},
  ops: {},
  events: {
    announced: { title: 'Something worth saying', payload: EMPTY, moment: { weight: 'high', gist: '有件事值得说' } },
    ticked: { title: 'Nothing worth saying', payload: EMPTY },
  },
}

class DemoProvider implements ResourceProvider {
  readonly spec = demoSpec
  hub: ResourceEventHub | undefined
  attach(hub: ResourceEventHub): void { this.hub = hub }
  async read(): Promise<unknown> { return null }
  async plan(): Promise<never> { throw new Error('no ops') }
  async apply(): Promise<never> { throw new Error('no ops') }
  emit(event: string, payload: unknown): void { this.hub?.emit({ scheme: 'demo', path: 'x' }, event, payload) }
}

class Clock {
  t = 5_000_000
  now(): number { return this.t }
}

let dir: string
let bus: EventBus
let kernel: ResourceKernel
let demo: DemoProvider
let pets: PetsSubsystem
let provider: PetResourceProvider
let clock: Clock
let utterances: Utterance[]
let petEvents: string[]
let teardown: Array<() => unknown>

const planCtx = { principal: { kind: 'user', userId: 'local' }, invocation: { sessionId: 's' } } as unknown as PlanContext
const runCtx = {} as RunContext

async function doOp(op: string, params: unknown): Promise<Record<string, unknown>> {
  const intent = await provider.plan(op, { scheme: 'pet', path: 'current' }, params, planCtx)
  const result = await provider.apply(op, intent, runCtx)
  return JSON.parse(result.content[0].text ?? '{}') as Record<string, unknown>
}

async function ledger(): Promise<Array<Record<string, unknown>>> {
  await pets.settled()
  try {
    const text = await readFile(path.join(dir, 'heidou', 'ledger.jsonl'), 'utf8')
    return text.trim().split('\n').filter(Boolean).map(row => JSON.parse(row) as Record<string, unknown>)
  } catch {
    return []
  }
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'onething-pets-subsystem-'))
  bus = new EventBus()
  kernel = new ResourceKernel(new ResourceRegistry(), {} as ToolRunner)
  clock = new Clock()
  utterances = []
  petEvents = []
  teardown = []
  demo = new DemoProvider()
  pets = new PetsSubsystem({ dir, registry: kernel.registry, bus, clock })
  await pets.start()
  provider = new PetResourceProvider(pets)
  teardown.push(kernel.mount(demo), kernel.mount(provider), forwardResourceEventsToBus(kernel, bus))
  teardown.push(bus.onGlobal('resource:event', ({ event }) => {
    if (!event.ref.startsWith('pet:')) return
    petEvents.push(event.event)
    if (event.event === 'utterance') utterances.push(event.payload as Utterance)
  }))
})

afterEach(async () => {
  for (const stop of teardown.reverse()) await stop()
  await pets.dispose()
  await rm(dir, { recursive: true, force: true })
})

describe('PetsSubsystem', () => {
  it('turns a resource event that declares a moment and carries a line into a pet utterance', async () => {
    demo.emit('announced', { say: '下一首来了' })
    const lines = await ledger()
    expect(utterances).toEqual([expect.objectContaining({ petId: 'heidou', mode: 'speak', text: '下一首来了', about: { scheme: 'demo', event: 'announced' } })])
    expect(lines.map(line => line.kind)).toEqual(['moment', 'utterance'])
    expect(pets.current().utterances.map(u => u.text)).toEqual(['下一首来了'])
  })

  it('ignores a resource event whose spec declares no moment', async () => {
    demo.emit('ticked', { say: '这句不该出现' })
    expect(await ledger()).toEqual([])
    expect(petEvents).toEqual([])
  })

  it('records the pet\'s own poked fact as a low moment and never speaks for it', async () => {
    expect(await doOp('poke', {})).toEqual({ ok: true })
    const lines = await ledger()
    expect(petEvents).toEqual(['poked'])
    expect(lines).toEqual([expect.objectContaining({ kind: 'moment', scheme: 'pet', event: 'poked', weight: 'low' })])
    expect(utterances).toEqual([])
  })

  it('answers a budget-blocked say with a reason instead of throwing', async () => {
    expect(await doOp('say', { mode: 'speak', text: '第一句' })).toMatchObject({ said: true, utterance: { text: '第一句' } })
    expect(await doOp('say', { mode: 'speak', text: '第二句' })).toEqual({ said: false, reason: 'busy' })
    expect(await doOp('say', { mode: 'mutter', text: '嘀咕' })).toMatchObject({ said: true, utterance: { mode: 'mutter' } })
    expect(utterances.map(u => u.text)).toEqual(['第一句', '嘀咕'])
  })

  it('refuses an unknown pet id at plan time and a wrong address', async () => {
    await expect(provider.plan('adopt', null, { id: 'dragon' }, planCtx)).rejects.toBeInstanceOf(UnknownPetError)
    await expect(provider.read('current', { scheme: 'pet', path: 'elsewhere' }, {}, {} as never)).rejects.toThrow('pet:current')
    expect(await doOp('adopt', { id: 'heidou' })).toEqual({ pet: { id: 'heidou', name: '黑豆', rig: 'heidou-svg' } })
    await pets.settled()
    expect(JSON.parse(await readFile(path.join(dir, 'current.json'), 'utf8'))).toEqual({ id: 'heidou' })
  })

  it('picks its memory back up from disk on the next start', async () => {
    demo.emit('announced', { say: '记住我' })
    await pets.settled()
    const again = new PetsSubsystem({ dir, registry: kernel.registry, bus: new EventBus(), clock })
    await again.start()
    expect(again.current().utterances.map(u => u.text)).toEqual(['记住我'])
    await again.dispose()
  })
})

/**
 * 电台的话交给宠物说(P3,§10.2「宠物接管」/ §10.6 / §10.7)。音乐那边借来的工具包是假的:
 * 合成答一段假音频,出声端口按脚本放 —— 从不出声。
 */
describe('PetsSubsystem · host voice (P3)', () => {
  const SPEECH: PatterSpeech = { audioBase64: 'QUJD', mimeType: 'audio/mpeg' }

  function fakeKit(options: { play?: (signal?: AbortSignal) => Promise<void>; speech?: PatterSpeech | null } = {}) {
    const order: string[] = []
    const fallbackSpeak = vi.fn<HostVoiceKit['fallback']['speak']>(async () => {})
    const kit: HostVoiceKit & { fallbackSpeak: typeof fallbackSpeak } = {
      source: { scheme: 'music', event: 'radio-patter' },
      fallbackSpeak,
      fallback: { prefetch: vi.fn(), speak: fallbackSpeak },
      synthesize: vi.fn(async () => {
        order.push('synthesize')
        return options.speech === undefined ? SPEECH : options.speech
      }),
      prefetch: vi.fn(),
      play: vi.fn(async (_speech, playOptions) => {
        order.push('play')
        await options.play?.(playOptions.signal)
      }),
    }
    return { kit, order }
  }

  function trackOrder(order: string[]): void {
    teardown.push(bus.onGlobal('resource:event', ({ event }) => {
      if (event.ref.startsWith('pet:') && (event.event === 'utterance' || event.event === 'hushed')) order.push(event.event)
    }))
  }

  it('认领 → utterance → 合成 → speech:activity 开 → 播放 → 关 → hushed;说完不再算在说', async () => {
    const { kit, order } = fakeKit()
    trackOrder(order)
    teardown.push(bus.onGlobal('speech:activity', ({ event }) => order.push(`activity:${event.active}`)))
    await pets.createHostVoice(kit).speak('下一首是一首老歌。', { title: 'song', overMusic: true })
    expect(order).toEqual(['utterance', 'synthesize', 'activity:true', 'play', 'activity:false', 'hushed'])
    expect(kit.fallbackSpeak).not.toHaveBeenCalled()
    // 合成用的是宠物的嗓子(调法 key 带着宠物 id)。
    expect((kit.synthesize as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toMatchObject({ key: expect.stringContaining('heidou') })
    expect(pets.current().speaking).toBe(false)
    const lines = await ledger()
    expect(lines.map(line => line.kind)).toEqual(['utterance', 'hushed'])
  })

  it('没配语音(合成答 null):不放、不报出声,气泡照出、hushed 立刻到', async () => {
    const { kit, order } = fakeKit({ speech: null })
    trackOrder(order)
    teardown.push(bus.onGlobal('speech:activity', ({ event }) => order.push(`activity:${event.active}`)))
    await pets.createHostVoice(kit).speak('没有声音的一句。', { title: 'song', overMusic: true })
    expect(order).toEqual(['utterance', 'synthesize', 'hushed'])
  })

  it('中止:正在放的那段停下,照样发 hushed', async () => {
    const abort = new AbortController()
    const { kit, order } = fakeKit({
      play: signal => new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true })),
    })
    trackOrder(order)
    const speaking = pets.createHostVoice(kit).speak('很长很长的一句。', { title: 'song', overMusic: false, signal: abort.signal })
    await vi.waitFor(() => expect(order).toContain('play'))
    expect(pets.current().speaking).toBe(true)
    abort.abort()
    await speaking
    expect(order).toEqual(['utterance', 'synthesize', 'play', 'hushed'])
    expect(pets.current().speaking).toBe(false)
  })

  it('正在说上一句:等它 hushed 再开口,不丢', async () => {
    let releaseFirst: (() => void) | undefined
    const { kit, order } = fakeKit({
      play: () => new Promise<void>(resolve => {
        if (!releaseFirst) releaseFirst = resolve
        else resolve()
      }),
    })
    trackOrder(order)
    const voice = pets.createHostVoice(kit)
    const first = voice.speak('第一句。', { title: 'a', overMusic: false })
    await vi.waitFor(() => expect(order).toContain('play'))
    const second = voice.speak('第二句。', { title: 'b', overMusic: false })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(order.filter(step => step === 'utterance')).toHaveLength(1)
    releaseFirst?.()
    await Promise.all([first, second])
    expect(order).toEqual(['utterance', 'synthesize', 'play', 'hushed', 'utterance', 'synthesize', 'play', 'hushed'])
    expect(utterances.map(u => u.text)).toEqual(['第一句。', '第二句。'])
  })

  it('等满上限还没说完:直接开口压过去,账本记 preempted', async () => {
    const quick = new PetsSubsystem({ dir, registry: kernel.registry, bus: new EventBus(), clock, claimWaitMs: 30 })
    await quick.start()
    const { kit } = fakeKit({ play: () => new Promise<void>(() => {}) })
    const voice = quick.createHostVoice(kit)
    void voice.speak('永远说不完。', { title: 'a', overMusic: false })
    await vi.waitFor(() => expect(kit.play).toHaveBeenCalledTimes(1))
    void voice.speak('电台等不及了。', { title: 'b', overMusic: false })
    await vi.waitFor(() => expect(kit.play).toHaveBeenCalledTimes(2))
    await quick.settled()
    const rows = (await readFile(path.join(dir, 'heidou', 'ledger.jsonl'), 'utf8')).trim().split('\n').map(row => JSON.parse(row) as { kind: string })
    expect(rows.map(row => row.kind)).toEqual(['utterance', 'utterance', 'preempted'])
    await quick.dispose()
  })

  it('子系统已 dispose:不认领,退回音乐的缺省实现照说', async () => {
    const { kit, order } = fakeKit()
    await pets.dispose()
    await pets.createHostVoice(kit).speak('照说。', { title: 'song', overMusic: false })
    expect(kit.fallbackSpeak).toHaveBeenCalledTimes(1)
    expect(order).toEqual([])
  })

  it('没出声的开口(say 做法)在估计时长到点时 hushed,dispose 清掉那只计时器', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      expect(await doOp('say', { mode: 'speak', text: '只有字的一句' })).toMatchObject({ said: true })
      expect(petEvents).not.toContain('hushed')
      await vi.advanceTimersByTimeAsync(3_100)
      await pets.settled()
      expect(petEvents).toContain('hushed')
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * 宠物自己开口(P4 §11.2 / §11.3):没带台词的时刻交给后备作曲器;说出来的 `speak` 走同一段出声路,
 * 前后一对 `speech:activity`;出声期间算「正在说」。
 */
describe('PetsSubsystem · own lines (P4)', () => {
  const SPEECH: PatterSpeech = { audioBase64: 'QUJD', mimeType: 'audio/mpeg' }

  async function fresh(options: { fallback?: (text: string) => string | null; play?: () => Promise<void>; withKit?: boolean }) {
    const order: string[] = []
    const composed: string[] = []
    const kit: HostVoiceKit = {
      source: { scheme: 'music', event: 'radio-patter' },
      fallback: { prefetch: vi.fn(), speak: vi.fn(async () => {}) },
      synthesize: vi.fn(async () => {
        order.push('synthesize')
        return SPEECH
      }),
      prefetch: vi.fn(),
      play: vi.fn(async () => {
        order.push('play')
        await options.play?.()
      }),
    }
    const localBus = new EventBus()
    const sub = new PetsSubsystem({
      dir,
      registry: kernel.registry,
      bus: localBus,
      clock,
      ...(options.fallback
        ? { fallbackComposer: { compose: ({ moment }) => { composed.push(moment.event); return options.fallback!(moment.event) } } }
        : {}),
      ...(options.withKit === false ? {} : { voiceKit: () => kit }),
    })
    await sub.start()
    const localProvider = new PetResourceProvider(sub)
    const stops = [kernel.mount(localProvider), forwardResourceEventsToBus(kernel, localBus)]
    localBus.onGlobal('resource:event', ({ event }) => {
      if (event.ref.startsWith('pet:') && (event.event === 'utterance' || event.event === 'hushed')) order.push(event.event)
    })
    localBus.onGlobal('speech:activity', ({ event }) => order.push(`activity:${event.active}`))
    return { sub, kit, order, composed, stop: async () => { for (const s of stops.reverse()) await s(); await sub.dispose() } }
  }

  beforeEach(async () => {
    // 外层 beforeEach 挂的那只 pet provider 与这里各自的那只会抢同一个 scheme:先摘掉外层的。
    for (const stop of teardown.splice(0).reverse()) await stop()
    await pets.dispose()
  })

  it('a moment without a ready line is written by the fallback composer; a ready line is passed through', async () => {
    const h = await fresh({ fallback: event => `模型为 ${event} 写的一句` })
    const unmountDemo = kernel.mount(demo)
    try {
      demo.emit('announced', {})
      await h.sub.settled()
      await vi.waitFor(() => expect(h.order).toContain('hushed'))
      expect(h.composed).toEqual(['announced'])
      expect(h.sub.current().utterances.map(u => u.text)).toEqual(['模型为 announced 写的一句'])

      clock.t += 1_000_000
      demo.emit('announced', { say: '现成的台词' })
      await h.sub.settled()
      expect(h.composed).toEqual(['announced'])
      expect(h.sub.current().utterances.map(u => u.text).at(-1)).toBe('现成的台词')
    } finally {
      unmountDemo()
      await h.stop()
    }
  })

  it('a spoken own line is voiced: utterance → synthesize → activity on → play → activity off → hushed, speaking until hushed', async () => {
    let release: (() => void) | undefined
    const h = await fresh({ play: () => new Promise<void>(resolve => { release = resolve }) })
    const unmountDemo = kernel.mount(demo)
    try {
      demo.emit('announced', { say: '我自己想说一句' })
      await vi.waitFor(() => expect(h.order).toContain('play'))
      clock.t += 60_000 // 远超估计时长:还在出声就还算在说
      expect(h.sub.current().speaking).toBe(true)
      release?.()
      await vi.waitFor(() => expect(h.order).toContain('hushed'))
      expect(h.order).toEqual(['utterance', 'synthesize', 'activity:true', 'play', 'activity:false', 'hushed'])
      expect(h.sub.current().speaking).toBe(false)
    } finally {
      unmountDemo()
      await h.stop()
    }
  })

  it('a say speak is voiced too; a mutter never is', async () => {
    const h = await fresh({})
    try {
      await h.sub.say('mutter', '呼噜')
      await h.sub.say('speak', '说出声')
      await vi.waitFor(() => expect(h.order).toContain('hushed'))
      expect(h.kit.synthesize).toHaveBeenCalledTimes(1)
      expect(h.order).toEqual(['utterance', 'utterance', 'synthesize', 'activity:true', 'play', 'activity:false', 'hushed'])
    } finally {
      await h.stop()
    }
  })
})
