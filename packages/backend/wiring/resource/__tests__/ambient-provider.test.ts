import { describe, expect, it, vi } from 'vitest'
import type { ResourceEventHub } from '@onething/core/resource'
import type { AmbientSource } from '@onething/runtime/ambient'
import { AmbientResourceProvider } from '../ambient-provider.js'

function fakeSource(id: string, event: string) {
  let emit: ((event: string, payload: Record<string, unknown>) => void) | undefined
  const stop = vi.fn()
  const source: AmbientSource = {
    id,
    events: { [event]: { title: event, payload: { type: 'object', properties: {}, required: [] }, moment: { weight: 'normal', gist: event } } },
    snapshot: () => ({ seen: id }),
    start: (fn) => {
      emit = fn
      return stop
    },
  }
  return { source, fire: (payload: Record<string, unknown>) => emit?.(event, payload), stop }
}

describe('AmbientResourceProvider(ambient:here)', () => {
  it('attach 时每只来源开始听;它们报的事实经 hub 以 ambient:here 发出去;dispose 停掉每只', async () => {
    const clock = fakeSource('clock', 'dayPart')
    const weather = fakeSource('weather', 'weatherChanged')
    const provider = new AmbientResourceProvider([clock.source, weather.source])
    const emitted: unknown[] = []
    const hub = { emit: (ref: unknown, event: string, payload: unknown) => emitted.push({ ref, event, payload }) } as unknown as ResourceEventHub
    provider.attach(hub)
    weather.fire({ kind: 'rain' })
    expect(emitted).toEqual([{ ref: { scheme: 'ambient', path: 'here' }, event: 'weatherChanged', payload: { kind: 'rain' } }])
    expect(await provider.read('now', null, {}, {} as never)).toEqual({ clock: { seen: 'clock' }, weather: { seen: 'weather' } })
    provider.dispose()
    expect(clock.stop).toHaveBeenCalledTimes(1)
    expect(weather.stop).toHaveBeenCalledTimes(1)
    provider.dispose()
    expect(clock.stop).toHaveBeenCalledTimes(1)
  })

  it('一只来源起不来,别的照常', () => {
    const good = fakeSource('clock', 'dayPart')
    const bad: AmbientSource = { ...fakeSource('weather', 'weatherChanged').source, start: () => { throw new Error('boom') } }
    const provider = new AmbientResourceProvider([bad, good.source])
    const emitted: unknown[] = []
    provider.attach({ emit: (_r: unknown, event: string) => emitted.push(event) } as unknown as ResourceEventHub)
    good.fire({})
    expect(emitted).toEqual(['dayPart'])
  })
})
