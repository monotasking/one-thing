import { describe, expect, it } from 'vitest'
import { describeResourceSpecProblem } from '@onething/core/resource'
import { ClockSource, dayPartAt } from '../clock-source.js'
import { ambientResourceSpecFor, DuplicateAmbientEventError } from '../resource-spec.js'
import type { AmbientSource, AmbientTimers } from '../source.js'
import { parseWttrReply, weatherKindOfCode, WeatherSource, type WeatherReading } from '../weather-source.js'

/** 手摇的时钟与计时器:`advance(ms)` 按到点顺序跑。 */
function manualTimers(start: Date) {
  let now = start.getTime()
  let seq = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  const timers: AmbientTimers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq
      pending.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: handle => void pending.delete(handle as number),
  }
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }
  const advance = async (ms: number) => {
    const target = now + ms
    await flush()
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      pending.delete(due[0])
      now = due[1].at
      due[1].fn()
      await flush()
    }
    now = target
  }
  return { timers, advance, pending: () => pending.size }
}

describe('ClockSource(09-19:时间是一种 trigger)', () => {
  it('段落边界', () => {
    expect([0, 5, 6, 10, 11, 12, 13, 17, 18, 22, 23].map(dayPartAt)).toEqual([
      'lateNight', 'lateNight', 'morning', 'morning', 'noon', 'noon', 'afternoon', 'afternoon', 'evening', 'evening', 'lateNight',
    ])
  })

  it('开机不补报;跨进下一段那个整点报一声,同一段里的整点不报;停了就不再报', async () => {
    const m = manualTimers(new Date(2026, 8, 19, 16, 30))
    const clock = new ClockSource(m.timers)
    const got: Array<[string, Record<string, unknown>]> = []
    const stop = clock.start((event, payload) => got.push([event, payload]))
    expect(got).toEqual([])
    await m.advance(30 * 60_000) // 17:00 —— 还是下午
    expect(got).toEqual([])
    await m.advance(60 * 60_000) // 18:00 —— 傍晚
    expect(got).toEqual([['dayPart', { part: 'evening', hour: 18 }]])
    expect(clock.snapshot()).toEqual({ hour: 18, part: 'evening' })
    stop()
    expect(m.pending()).toBe(0)
    await m.advance(6 * 60 * 60_000)
    expect(got).toHaveLength(1)
  })
})

describe('WeatherSource(09-19:天气是一种 trigger)', () => {
  const reading = (kind: WeatherReading['kind']): WeatherReading => ({ kind, description: kind, tempC: 20, place: '杭州' })

  it('第一次读到只记下;类别变了才报(带 from);读不到不报也不清掉上一次', async () => {
    const m = manualTimers(new Date(2026, 8, 19, 16, 0))
    const replies: Array<WeatherReading | null> = [reading('clear'), reading('clear'), null, reading('rain')]
    const source = new WeatherSource(async () => replies.shift() ?? null, m.timers, 1000)
    const got: Array<[string, Record<string, unknown>]> = []
    const stop = source.start((event, payload) => got.push([event, payload]))
    await m.advance(0)
    expect(got).toEqual([])
    expect(source.snapshot()).toMatchObject({ kind: 'clear' })
    await m.advance(1000)
    await m.advance(1000)
    expect(got).toEqual([])
    expect(source.snapshot()).toMatchObject({ kind: 'clear' })
    await m.advance(1000)
    expect(got).toEqual([['weatherChanged', { kind: 'rain', from: 'clear', description: 'rain', tempC: 20, place: '杭州' }]])
    stop()
  })

  it('wttr.in 回复解析:代码归类、中文描述优先、形状不对 = null', () => {
    expect(weatherKindOfCode(113)).toBe('clear')
    expect(weatherKindOfCode(296)).toBe('rain')
    expect(weatherKindOfCode(338)).toBe('snow')
    expect(weatherKindOfCode(248)).toBe('fog')
    expect(weatherKindOfCode(389)).toBe('storm')
    expect(weatherKindOfCode(116)).toBe('cloudy')
    expect(
      parseWttrReply({
        current_condition: [{ temp_C: '19', weatherCode: '296', weatherDesc: [{ value: 'Light rain' }], lang_zh: [{ value: '小雨' }] }],
        nearest_area: [{ areaName: [{ value: 'Hangzhou' }] }],
      }),
    ).toEqual({ kind: 'rain', description: '小雨', tempC: 19, place: 'Hangzhou' })
    expect(parseWttrReply({})).toBeNull()
    expect(parseWttrReply(null)).toBeNull()
  })
})

describe('ambient: 的自述由来源表并出来', () => {
  it('过契约门;事件带着各自的 moment;不做模型工具', () => {
    const spec = ambientResourceSpecFor([new ClockSource(), new WeatherSource(async () => null)])
    expect(describeResourceSpecProblem(spec)).toBeNull()
    expect(spec.events.dayPart?.moment?.weight).toBe('normal')
    expect(spec.events.weatherChanged?.moment?.weight).toBe('normal')
    expect(spec.exposure?.aiTool).toBe(false)
  })

  it('陌生能力演练:加一只来源 = 它自己的类 + 表上一行,自述里就多出它的事件', () => {
    const calendar: AmbientSource = {
      id: 'calendar',
      events: { meetingSoon: { title: 'A meeting starts soon', payload: { type: 'object', properties: {}, required: [] }, moment: { weight: 'high', gist: '快开会了' } } },
      snapshot: () => undefined,
      start: () => () => {},
    }
    const spec = ambientResourceSpecFor([new ClockSource(), calendar])
    expect(Object.keys(spec.events).sort()).toEqual(['dayPart', 'meetingSoon'])
  })

  it('两只来源撞了事件名 → 拒绝(不许悄悄盖掉一只)', () => {
    expect(() => ambientResourceSpecFor([new ClockSource(), new ClockSource()])).toThrow(DuplicateAmbientEventError)
  })
})
