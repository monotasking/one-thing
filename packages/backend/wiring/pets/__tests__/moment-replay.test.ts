/**
 * **时刻回放**(宠物 P4,正本 §11.5 第二条):一段真实形状的听歌事件流,经真的 `music:` 自述
 * (那六格 `moment`)、真的事件桥、真的宿主预算,断言话语与丢弃**逐条**相等。
 *
 * 钟是手摇的,作曲器是假的(按事件名回一句),没有出声工具包(说出来的话按估计时长收尾)——
 * 这份测试从不调模型、从不起播放器。
 *
 * 流水(相对开台时刻,秒):
 *   0     开台(`radioOpened`,没有 moment → 宿主根本看不见)
 *   0/200/400 三首歌开播(`trackStarted`,low → 只记账)
 *   410/440/470 连跳三首(`skipped` ×3 low;第三次后 `skipStreak` high → 开口)
 *   480   暂停;840 回来(`resumedAfterPause` normal,距上次开口 370s > 冷却 → 开口)
 *   841   间奏(normal,上一句还没说完 → busy)
 *   900   又一首的间奏(normal,距上次开口 60s < 冷却 → cooldown)
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ResourceKernel, ResourceRegistry, type ResourceEventHub, type ResourceProvider } from '@onething/core/resource'
import type { ToolRunner } from '@onething/core/toolkit'
import { musicResourceSpec } from '@onething/runtime/music/resource-spec'
import { EventBus } from '../../../events/event-bus.js'
import { forwardResourceEventsToBus } from '../../resource/event-bridge.js'
import { PetResourceProvider } from '../../resource/pet-provider.js'
import { PetsSubsystem } from '../subsystem.js'

class FakeMusic implements ResourceProvider {
  readonly spec = musicResourceSpec
  hub: ResourceEventHub | undefined
  attach(hub: ResourceEventHub): void { this.hub = hub }
  async read(): Promise<unknown> { return null }
  async plan(): Promise<never> { throw new Error('no ops') }
  async apply(): Promise<never> { throw new Error('no ops') }
  emit(pathName: 'radio' | 'player', event: string, payload: unknown): void {
    this.hub?.emit({ scheme: 'music', path: pathName }, event, payload)
  }
}

const T0 = 1_789_000_000_000
const clock = { t: T0, now(): number { return this.t } }

let dir: string
let bus: EventBus
let kernel: ResourceKernel
let music: FakeMusic
let pets: PetsSubsystem
let stops: Array<() => unknown>

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'onething-pets-replay-'))
  clock.t = T0
  bus = new EventBus()
  kernel = new ResourceKernel(new ResourceRegistry(), {} as ToolRunner)
  music = new FakeMusic()
  pets = new PetsSubsystem({
    dir,
    registry: kernel.registry,
    bus,
    clock,
    fallbackComposer: { compose: ({ moment }) => `黑豆对 ${moment.event} 说的话` },
  })
  await pets.start()
  stops = [kernel.mount(music), kernel.mount(new PetResourceProvider(pets)), forwardResourceEventsToBus(kernel, bus)]
})

afterEach(async () => {
  for (const stop of stops.reverse()) await stop()
  await pets.dispose()
  await rm(dir, { recursive: true, force: true })
})

async function at(seconds: number, pathName: 'radio' | 'player', event: string, payload: unknown): Promise<void> {
  clock.t = T0 + seconds * 1000
  music.emit(pathName, event, payload)
  await pets.settled()
}

describe('moment replay (P4 §11.5)', () => {
  it('speaks and drops exactly as the attention budget says, line by line', async () => {
    await at(0, 'radio', 'radioOpened', { intent: '深夜 lo-fi' })
    await at(0, 'player', 'trackStarted', { title: '甲 - 歌手' })
    await at(200, 'player', 'trackStarted', { title: '乙 - 歌手' })
    await at(400, 'player', 'trackStarted', { title: '丙 - 歌手' })
    await at(410, 'player', 'skipped', { title: '丙 - 歌手' })
    await at(440, 'player', 'skipped', { title: '丁 - 歌手' })
    await at(470, 'player', 'skipped', { title: '戊 - 歌手' })
    await at(470, 'player', 'skipStreak', { count: 3, titles: ['丙 - 歌手', '丁 - 歌手', '戊 - 歌手'] })
    await at(840, 'player', 'resumedAfterPause', { pausedMs: 360_000, title: '己 - 歌手' })
    await at(841, 'player', 'interlude', { title: '己 - 歌手', atSeconds: 96, lengthSeconds: 18 })
    await at(900, 'player', 'interlude', { title: '庚 - 歌手', atSeconds: 120, lengthSeconds: 14 })

    const rows = (await readFile(path.join(dir, 'heidou', 'ledger.jsonl'), 'utf8'))
      .trim().split('\n').map(row => JSON.parse(row) as Record<string, any>)
      .filter(row => row.kind !== 'hushed')
      .map(row => {
        // 时刻行的时间是事件桥盖的墙钟(不归宿主的钟管),所以只比名字与权重;话语与丢弃是宿主按
        // 手摇的钟盖的,连秒一起比。
        const seconds = (row.at - T0) / 1000
        switch (row.kind) {
          case 'moment': return `moment ${row.event} (${row.weight})`
          case 'utterance': return `${seconds} say「${row.utterance.text}」about ${row.utterance.about.event}`
          case 'dropped': return `${seconds} drop ${row.reason} about ${row.about.event}`
          default: return `${seconds} ${row.kind}`
        }
      })

    expect(rows).toEqual([
      'moment trackStarted (low)',
      'moment trackStarted (low)',
      'moment trackStarted (low)',
      'moment skipped (low)',
      'moment skipped (low)',
      'moment skipped (low)',
      'moment skipStreak (high)',
      '470 say「黑豆对 skipStreak 说的话」about skipStreak',
      'moment resumedAfterPause (normal)',
      '840 say「黑豆对 resumedAfterPause 说的话」about resumedAfterPause',
      'moment interlude (normal)',
      '841 drop busy about interlude',
      'moment interlude (normal)',
      '900 drop cooldown about interlude',
    ])
  })
})
