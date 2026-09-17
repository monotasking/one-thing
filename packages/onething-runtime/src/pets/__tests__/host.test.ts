/**
 * `PetHost` 的注意力预算、记忆与换宠物(正本 §9.2 那张表逐行,§9.6 第一条)。
 * 时钟是手摇的:每条规矩都在一个确定的毫秒上判。
 */
import { describe, expect, it } from 'vitest'
import { HEIDOU } from '../builtin/heidou.js'
import { SayPassthroughComposer, type MomentComposer } from '../composer.js'
import { estimateSpeechMs, PET_DEFAULT_COOLDOWN_MS, PetHost } from '../host.js'
import { foldPetMemory, parsePetLedgerLine, PET_MEMORY_LINES, PET_RECENT_UTTERANCES, type PetLedgerLine } from '../ledger.js'
import type { PetManifest } from '../manifest.js'
import type { Moment, MomentWeight } from '../types.js'

class FakeClock {
  constructor(public t = 1_000_000) {}
  now(): number { return this.t }
  advance(ms: number): void { this.t += ms }
}

const PARROT: PetManifest = { id: 'parrot', name: '鹦鹉', rig: 'parrot-svg', voice: { pitch: 'high', timbre: 'bright', rate: 'fast' }, persona: '学舌' }

function moment(clock: FakeClock, weight: MomentWeight, say?: string, event = 'changed'): Moment {
  return { scheme: 'demo', event, weight, gist: '有事发生', payload: say === undefined ? {} : { say }, at: clock.now() }
}

function makeHost(clock = new FakeClock(), composer: MomentComposer = new SayPassthroughComposer(), lines?: PetLedgerLine[]) {
  return { clock, host: new PetHost({ pet: HEIDOU, composer, clock, ...(lines ? { lines } : {}) }) }
}

describe('PetHost · attention budget', () => {
  it('speaks a high moment that carries a line, then marks itself speaking for the estimated time', async () => {
    const { clock, host } = makeHost()
    const out = await host.onMoment(moment(clock, 'high', '下一首是晴天'))
    expect(out.utterance).toMatchObject({ petId: 'heidou', mode: 'speak', text: '下一首是晴天', about: { scheme: 'demo', event: 'changed' }, at: clock.now(), duck: true })
    expect(out.lines.map(line => line.kind)).toEqual(['moment', 'utterance'])
    const view = host.current()
    expect(view.speaking).toBe(true)
    expect(view.speakingUntil).toBe(clock.now() + estimateSpeechMs('下一首是晴天'))
    clock.advance(estimateSpeechMs('下一首是晴天'))
    expect(host.current().speaking).toBe(false)
    expect(host.current().speakingUntil).toBeUndefined()
  })

  it('drops a second speak while one line is still being said — even a high one — and records why', async () => {
    const { clock, host } = makeHost()
    await host.onMoment(moment(clock, 'high', '第一句'))
    clock.advance(500)
    const out = await host.onMoment(moment(clock, 'high', '第二句'))
    expect(out.utterance).toBeUndefined()
    expect(out.dropped).toBe('busy')
    expect(out.lines.at(-1)).toMatchObject({ kind: 'dropped', reason: 'busy', about: { scheme: 'demo', event: 'changed' } })
  })

  it('holds normal moments to the cooldown, but lets high ones jump it', async () => {
    const { clock, host } = makeHost()
    await host.onMoment(moment(clock, 'high', '开场'))
    clock.advance(60_000) // 说完了,但冷却没过
    const normal = await host.onMoment(moment(clock, 'normal', '闲聊一句'))
    expect(normal.dropped).toBe('cooldown')
    const high = await host.onMoment(moment(clock, 'high', '插队这句'))
    expect(high.utterance?.text).toBe('插队这句')
    clock.advance(PET_DEFAULT_COOLDOWN_MS)
    const later = await host.onMoment(moment(clock, 'normal', '冷却过了'))
    expect(later.utterance?.text).toBe('冷却过了')
  })

  it('never speaks a low moment — it only lands in the ledger', async () => {
    const { clock, host } = makeHost()
    const out = await host.onMoment(moment(clock, 'low', '这句不该说'))
    expect(out.utterance).toBeUndefined()
    expect(out.dropped).toBeUndefined()
    expect(out.lines).toEqual([expect.objectContaining({ kind: 'moment', weight: 'low' })])
    expect(host.current().utterances).toEqual([])
  })

  it('records nothing-to-say when the composer has no line', async () => {
    const { clock, host } = makeHost()
    const out = await host.onMoment(moment(clock, 'high'))
    expect(out.dropped).toBe('nothing-to-say')
    // 没说出口就不占预算:下一句照常开口。
    const next = await host.onMoment(moment(clock, 'normal', '这句能说'))
    expect(next.utterance?.text).toBe('这句能说')
  })

  it('counts an in-flight composition as speaking, and re-checks the clock after it returns', async () => {
    const clock = new FakeClock()
    let release: (text: string) => void = () => {}
    const slow: MomentComposer = { compose: () => new Promise<string>(resolve => { release = resolve }) }
    const host = new PetHost({ pet: HEIDOU, composer: slow, clock })
    const pending = host.onMoment(moment(clock, 'high'))
    expect(host.current().speaking).toBe(true)
    expect(host.say('speak', '抢先').dropped).toBe('busy')
    release('想好了')
    expect((await pending).utterance?.text).toBe('想好了')
  })
})

describe('PetHost · say', () => {
  it('treats say/speak as high: it ignores the cooldown but not a line in progress', async () => {
    const { clock, host } = makeHost()
    await host.onMoment(moment(clock, 'high', '开场'))
    expect(host.say('speak', '现在说').dropped).toBe('busy')
    expect(host.say('speak', '现在说').lines.at(-1)).toMatchObject({ kind: 'dropped', reason: 'busy', text: '现在说' })
    clock.advance(10_000)
    const spoken = host.say('speak', '冷却里也能说')
    expect(spoken.utterance).toMatchObject({ mode: 'speak', text: '冷却里也能说', duck: true })
    expect(spoken.utterance?.about).toBeUndefined()
  })

  it('lets a mutter through at any time without touching the budget', async () => {
    const { clock, host } = makeHost()
    await host.onMoment(moment(clock, 'high', '开场'))
    const until = host.current().speakingUntil
    const mutter = host.say('mutter', '嘀咕')
    expect(mutter.utterance).toMatchObject({ mode: 'mutter', text: '嘀咕', duck: false })
    expect(host.current().speakingUntil).toBe(until)
    clock.advance(estimateSpeechMs('开场'))
    // 嘀咕不刷新冷却起点:冷却仍从「开场」算。
    clock.advance(PET_DEFAULT_COOLDOWN_MS)
    expect((await host.onMoment(moment(clock, 'normal', '照常'))).utterance?.text).toBe('照常')
  })
})

describe('PetHost · adopt and memory', () => {
  it('adopt switches the pet, clears speaking, and takes that pet\'s own ledger as memory', async () => {
    const { clock, host } = makeHost()
    await host.onMoment(moment(clock, 'high', '黑豆说的'))
    expect(host.current().speaking).toBe(true)
    host.adopt(PARROT, [])
    const view = host.current()
    expect(view.pet).toEqual({ id: 'parrot', name: '鹦鹉', rig: 'parrot-svg' })
    expect(view.speaking).toBe(false)
    expect(view.utterances).toEqual([])
    const out = host.say('speak', '你好')
    expect(out.utterance?.petId).toBe('parrot')
  })

  it('picks the cooldown back up from a loaded ledger (restart)', async () => {
    const first = makeHost()
    await first.host.onMoment(moment(first.clock, 'high', '重启前'))
    const lines = [...first.host.memory()]
    first.clock.advance(30_000)
    const second = makeHost(first.clock, new SayPassthroughComposer(), lines)
    expect(second.host.current().utterances.map(u => u.text)).toEqual(['重启前'])
    expect((await second.host.onMoment(moment(first.clock, 'normal', '太快了'))).dropped).toBe('cooldown')
  })

  it('keeps the last 50 lines in memory and hands out the last 20 utterances, newest last', () => {
    const { clock, host } = makeHost()
    for (let i = 0; i < 60; i += 1) {
      clock.advance(1)
      host.say('mutter', `第${i}句`)
    }
    expect(host.memory()).toHaveLength(PET_MEMORY_LINES)
    const utterances = host.current().utterances
    expect(utterances).toHaveLength(PET_RECENT_UTTERANCES)
    expect(utterances.at(-1)?.text).toBe('第59句')
  })
})

describe('ledger lines', () => {
  it('round-trips every line the host produces through JSON, and refuses malformed ones', async () => {
    const { clock, host } = makeHost()
    await host.onMoment(moment(clock, 'high', '一句'))
    host.say('speak', '被挡')
    await host.onMoment(moment(clock, 'low'))
    for (const line of host.memory()) {
      expect(parsePetLedgerLine(JSON.stringify(line))).toEqual(line)
    }
    expect(parsePetLedgerLine('{"kind":"utterance","petId":"heidou","at":1}')).toBeNull()
    expect(parsePetLedgerLine('{"kind":"dropped","petId":"heidou","at":1,"reason":"tired"}')).toBeNull()
    expect(parsePetLedgerLine('{"kind":"moment"')).toBeNull()
    expect(parsePetLedgerLine('[]')).toBeNull()
  })

  it('folds speakingUntil and lastSpokeAt from speak lines only', () => {
    const lines: PetLedgerLine[] = [
      { kind: 'utterance', petId: 'heidou', at: 10, utterance: { id: 'a', petId: 'heidou', mode: 'speak', text: '说', at: 10, duck: true } },
      { kind: 'utterance', petId: 'heidou', at: 20, utterance: { id: 'b', petId: 'heidou', mode: 'mutter', text: '嘀', at: 20, duck: false } },
    ]
    const memory = foldPetMemory(lines, () => 1000)
    expect(memory.lastSpokeAt).toBe(10)
    expect(memory.speakingUntil).toBe(1010)
    expect(memory.utterances.map(u => u.id)).toEqual(['a', 'b'])
  })
})

describe('PetHost · claim (P3, §10.3)', () => {
  const RADIO = { scheme: 'music', event: 'radio-patter' }

  it('空闲:立刻开口、记账,认领后到 hush 之前都算在说(不按估计时长)', () => {
    const { clock, host } = makeHost()
    const out = host.claim(RADIO, '下一首是晴天')
    expect(out.kind).toBe('claimed')
    if (out.kind !== 'claimed') return
    expect(out.preempted).toBe(false)
    expect(out.utterance).toMatchObject({ mode: 'speak', text: '下一首是晴天', about: RADIO, duck: true })
    expect(out.lines.map(line => line.kind)).toEqual(['utterance'])
    // 估计时长过了很久,声音还在放 —— 仍在说。
    clock.advance(estimateSpeechMs('下一首是晴天') * 5)
    expect(host.current().speaking).toBe(true)
    const hushed = host.hush(out.utterance.id)
    expect(hushed).toEqual([{ kind: 'hushed', petId: 'heidou', at: clock.now(), utteranceId: out.utterance.id }])
    expect(host.current().speaking).toBe(false)
    // speakingUntil 改成了实际结束时刻:折回来也是它。
    expect(foldPetMemory(host.memory(), estimateSpeechMs).speakingUntil).toBe(clock.now())
  })

  it('冷却中:无视冷却(同 high)', async () => {
    const { clock, host } = makeHost()
    await host.onMoment(moment(clock, 'high', '刚说过'))
    clock.advance(estimateSpeechMs('刚说过'))
    // 还在 4 分钟冷却里:normal 时刻会被挡,认领不会。
    expect((await host.onMoment(moment(clock, 'normal', '被冷却挡'))).dropped).toBe('cooldown')
    expect(host.claim(RADIO, '电台的话').kind).toBe('claimed')
  })

  it('正在说别的:答 wait(不记账);估计时长那种给出剩余毫秒,出声那种等 hush;带 preempt 压过去并记 preempted', async () => {
    const { clock, host } = makeHost()
    await host.onMoment(moment(clock, 'high', '宠物自己的一句话'))
    clock.advance(1_000)
    const before = host.memory().length
    expect(host.claim(RADIO, '电台')).toEqual({ kind: 'wait', retryInMs: estimateSpeechMs('宠物自己的一句话') - 1_000 })
    expect(host.memory().length).toBe(before)

    clock.advance(estimateSpeechMs('宠物自己的一句话'))
    const first = host.claim(RADIO, '第一段口播')
    expect(first.kind).toBe('claimed')
    if (first.kind !== 'claimed') return
    expect(host.claim(RADIO, '第二段口播')).toEqual({ kind: 'wait', retryInMs: null })

    const second = host.claim(RADIO, '第二段口播', { preempt: true })
    expect(second.kind).toBe('claimed')
    if (second.kind !== 'claimed') return
    expect(second.preempted).toBe(true)
    expect(second.lines.map(line => line.kind)).toEqual(['utterance', 'preempted'])
    expect(second.lines[1]).toMatchObject({ kind: 'preempted', utteranceId: second.utterance.id, over: first.utterance.id })
    // 被压住的那一句晚到的回执不许把新的那一句「说完」。
    host.hush(first.utterance.id)
    expect(host.current().speaking).toBe(true)
    host.hush(second.utterance.id)
    expect(host.current().speaking).toBe(false)
    for (const line of host.memory()) expect(parsePetLedgerLine(JSON.stringify(line))).toEqual(line)
  })

  it('空白文本不认领;换宠物之后上一只的回执不记账', () => {
    const { host } = makeHost()
    expect(host.claim(RADIO, '   ')).toEqual({ kind: 'refused' })
    const out = host.claim(RADIO, '黑豆说的')
    if (out.kind !== 'claimed') throw new Error('expected claimed')
    host.adopt(PARROT)
    expect(host.current().speaking).toBe(false)
    expect(host.hush(out.utterance.id)).toEqual([])
  })
})
