// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { mergeKeymapPersisted, normalizeKeymapOverrides } from '../persisted'
import { useKeymapStore } from '../store'
import { effectiveCombos, lookupCommands } from '../transitions'

/** 09-13 真机 leveldb 里挖出来的那份存档,一字不改:v2 的单对象、版本号 4。 */
const REAL_BLOB =
  '{"state":{"overrides":{"toggle:files":{"key":"1","meta":true},"toggle:settings":{"key":",","meta":true},"toggle:search":{"key":"f","meta":true,"shift":true},"shelf.left.toggle":{"key":"b","meta":true},"workspace.slot:2":{"key":"™","meta":true,"alt":true},"toggle:sessions":{"key":"2","meta":true}}},"version":4}'

describe('normalizeKeymapOverrides', () => {
  it('v2 的单对象包成一格数组;null 与数组原样;读不懂的丢', () => {
    expect(
      normalizeKeymapOverrides({
        a: { key: '1', meta: true },
        b: null,
        c: [{ key: 'x', ctrl: true }, 'garbage'],
        d: 'nonsense',
        e: 7,
        f: {},
      }),
    ).toEqual({ a: [{ key: '1', meta: true }], b: null, c: [{ key: 'x', ctrl: true }] })
  })

  it('不是对象的 overrides 读作空表', () => {
    expect(normalizeKeymapOverrides(undefined)).toEqual({})
    expect(normalizeKeymapOverrides([1])).toEqual({})
    expect(normalizeKeymapOverrides('x')).toEqual({})
  })

  it('merge 只收 overrides,其余以当前实例为准', () => {
    const current = { overrides: { z: null }, bind: 'keep' }
    expect(mergeKeymapPersisted({ overrides: { a: { key: 'q' } }, bind: 'evil' }, current)).toEqual({
      overrides: { a: [{ key: 'q' }] },
      bind: 'keep',
    })
    expect(mergeKeymapPersisted(undefined, current)).toEqual({ overrides: {}, bind: 'keep' })
  })
})

describe('useKeymapStore 水合真机那份坏存档', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('版本 4 + 单对象:水合后每一格都是数组,⌘2 走 lookupCommands 不再抛', async () => {
    localStorage.setItem('onething.keymap', REAL_BLOB)
    await useKeymapStore.persist.rehydrate()
    const state = useKeymapStore.getState()
    for (const value of Object.values(state.overrides)) expect(value === null || Array.isArray(value)).toBe(true)
    expect(effectiveCombos(state, 'toggle:sessions')).toEqual([{ key: '2', meta: true }])
    const hit = lookupCommands(state, { key: '2', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, 'mac')
    expect(hit).toContain('toggle:sessions')
  })
})
