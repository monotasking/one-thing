import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closePetSource,
  configurePetPort,
  openPetSource,
  petCurrentQuery,
  petOps,
  resetPetSource,
  usePetHushedId,
  usePetOnAir,
  usePetUtterance,
} from '../pet-source'
import type { ResourceEventFact, ResourcePort } from '../resource-port'

/**
 * `pet-source` 的线(宠物 P2,正本 §9.1 / §9.5):
 *  ① 开:先订 `pet:` 再读 `current`;关到零才退订;
 *  ② `utterance` 事件 → 一份新的「最新一句」(新对象身份)+ `current` 标脏;读数里的旧话语不算;
 *  ③ 读失败(宿主没有宠物)不抛,最新一句一直是 null;
 *  ④ 戳 / 撸发完不等,失败被吞掉;
 *  ⑤ ON AIR:开口点灯、对得上的 `hushed` 灭灯;`hushed` 丢了,读数包含那句却不在说 → 灭灯(P3)。
 */

const DENIED: ResourcePort = {
  ready: async () => undefined,
  read: async () => ({ kind: 'denied', reason: 'fake port' }),
  do: async () => ({ kind: 'denied', reason: 'fake port' }),
  onResourceEvent: () => () => undefined,
}

const OLD = { id: 'old', petId: 'heidou', mode: 'speak', text: '一小时前那句', at: 1, duck: true }

function fakePort(overrides: Partial<ResourcePort> = {}) {
  const log: string[] = []
  let listener: ((fact: ResourceEventFact) => void) | undefined
  const port: ResourcePort = {
    ready: async () => undefined,
    read: vi.fn(async (ref: string, name: string) => {
      log.push(`read ${ref} ${name}`)
      return { kind: 'ok' as const, value: { pet: { id: 'heidou', name: '黑豆', rig: 'heidou-svg' }, speaking: false, utterances: [OLD] } }
    }),
    do: vi.fn(async (ref: string, op: string) => {
      log.push(`do ${ref} ${op}`)
      return { kind: 'ok' as const, text: '{"ok":true}' } as never
    }),
    onResourceEvent: (prefix, callback) => {
      log.push(`subscribe ${prefix}`)
      listener = callback
      return () => {
        log.push('unsubscribe')
        listener = undefined
      }
    },
    ...overrides,
  }
  return { port, log, emit: (fact: ResourceEventFact) => listener?.(fact) }
}

beforeEach(() => {
  resetPetSource()
})

afterEach(() => {
  // 先卸载再清:`latest` 清空会通知还挂着的 hook,在 act 外就是一次无主更新。
  cleanup()
  resetPetSource()
  configurePetPort(DENIED)
})

describe('pet-source', () => {
  it('subscribes to pet: before reading current, and unsubscribes only when the last user closes', async () => {
    const { port, log } = fakePort()
    configurePetPort(port)
    await openPetSource()
    await openPetSource()
    expect(log).toEqual(['subscribe pet:', 'read pet:current current'])
    expect(petCurrentQuery.get().data?.utterances).toEqual([OLD])
    closePetSource()
    expect(log).not.toContain('unsubscribe')
    closePetSource()
    expect(log.at(-1)).toBe('unsubscribe')
  })

  it('surfaces only utterances that arrive as events, one new object per event', async () => {
    const { port, emit } = fakePort()
    configurePetPort(port)
    const { result } = renderHook(() => usePetUtterance())
    await act(async () => {
      await openPetSource()
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
    })
    // 读数里那句旧话不算「刚说的」。
    expect(result.current).toBeNull()
    act(() => emit({ ref: 'pet:current', event: 'utterance', payload: { ...OLD, id: 'u1', text: '刚说的', at: 2 } }))
    const first = result.current
    expect(first?.utterance).toEqual({ mode: 'speak', text: '刚说的' })
    act(() => emit({ ref: 'pet:current', event: 'poked', payload: { at: 3 } }))
    expect(result.current).toBe(first)
    act(() => emit({ ref: 'pet:current', event: 'utterance', payload: { ...OLD, id: 'u2', mode: 'mutter', text: '刚说的', at: 4 } }))
    expect(result.current).not.toBe(first)
    expect(result.current?.utterance).toEqual({ mode: 'mutter', text: '刚说的' })
    closePetSource()
  })

  it('stays silent when the host has no pet subsystem', async () => {
    configurePetPort(DENIED)
    const { result } = renderHook(() => usePetUtterance())
    await act(async () => {
      await openPetSource()
    })
    expect(petCurrentQuery.get().data).toBeUndefined()
    expect(result.current).toBeNull()
    closePetSource()
  })

  it('fires poke and stroke without waiting, and swallows failures', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline')
    })
    const { port } = fakePort({ do: failing })
    configurePetPort(port)
    expect(petOps.poke()).toBeUndefined()
    petOps.stroke()
    await act(async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve()
    })
    expect(failing.mock.calls.map((call) => (call as unknown[])[1])).toEqual(['poke', 'stroke'])
  })

  it('lights on a speak utterance and goes dark on its own hushed; a mutter does neither', async () => {
    const { port, emit } = fakePort()
    configurePetPort(port)
    const { result } = renderHook(() => ({ onAir: usePetOnAir(), hushedId: usePetHushedId(), latest: usePetUtterance() }))
    await act(async () => {
      await openPetSource()
    })
    expect(result.current.onAir).toBe(false)
    act(() => emit({ ref: 'pet:current', event: 'utterance', payload: { ...OLD, id: 'u1', text: '开口', at: 2 } }))
    expect(result.current.onAir).toBe(true)
    expect(result.current.latest?.id).toBe('u1')
    act(() => emit({ ref: 'pet:current', event: 'utterance', payload: { ...OLD, id: 'm1', mode: 'mutter', text: '嘀咕', at: 3 } }))
    expect(result.current.onAir).toBe(true)
    act(() => emit({ ref: 'pet:current', event: 'hushed', payload: { utteranceId: 'm1', at: 4 } }))
    expect(result.current.onAir).toBe(true)
    act(() => emit({ ref: 'pet:current', event: 'hushed', payload: { utteranceId: 'u1', at: 5 } }))
    expect(result.current.onAir).toBe(false)
    expect(result.current.hushedId).toBe('u1')
    closePetSource()
  })

  it('a lost hushed does not leave the lamp lit: a read that already has the line but is not speaking turns it off', async () => {
    let reply = { speaking: true, utterances: [] as unknown[] }
    const { port, emit } = fakePort({
      read: async () => ({ kind: 'ok' as const, value: { pet: { id: 'heidou', name: '黑豆', rig: 'heidou-svg' }, ...reply } }),
    })
    configurePetPort(port)
    const { result } = renderHook(() => usePetOnAir())
    await act(async () => {
      await openPetSource()
    })
    const line = { ...OLD, id: 'u9', text: '断线那一句', at: 9 }
    // 读数还没包含这一句(早于开口):不作数。
    reply = { speaking: false, utterances: [] }
    act(() => emit({ ref: 'pet:current', event: 'utterance', payload: line }))
    await act(async () => {
      await petCurrentQuery.ensure()
    })
    expect(result.current).toBe(true)
    reply = { speaking: false, utterances: [line] }
    await act(async () => {
      petCurrentQuery.invalidate()
      await petCurrentQuery.ensure()
      for (let i = 0; i < 10; i += 1) await Promise.resolve()
    })
    expect(result.current).toBe(false)
    closePetSource()
  })
})
