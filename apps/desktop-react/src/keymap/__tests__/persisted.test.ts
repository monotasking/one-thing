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

  it('merge 只收用户自己的那三格,其余以当前实例为准', () => {
    const current = { overrides: { z: null }, bind: 'keep' }
    expect(mergeKeymapPersisted({ overrides: { a: { key: 'q' } }, bind: 'evil' }, current)).toEqual({
      overrides: { a: [{ key: 'q' }] },
      profileId: 'default',
      userProfiles: [],
      bind: 'keep',
    })
    expect(mergeKeymapPersisted(undefined, current)).toEqual({
      overrides: {},
      profileId: 'default',
      userProfiles: [],
      bind: 'keep',
    })
  })

  /**
   * **K5:`partialize` 存的那三格与 `merge` 收的那三格必须一一对上。**
   * 存了却不收就是「设置里换了组,重启回出厂」—— 而那种病没有任何报错,
   * 只有用户第二天发现键又变回去了。
   */
  it('键位组那两格从存档里收得回来,而且照样按形状归一', () => {
    const current = { overrides: {}, profileId: 'default', userProfiles: [] }
    const merged = mergeKeymapPersisted(
      {
        overrides: {},
        profileId: 'vscode',
        userProfiles: [
          { id: 'user:mine', name: '我的', bindings: { 'tab.close': { key: 'q', meta: true } } },
          // 没有身份的丢(选不中也删不掉),顶掉内置 id 的也丢(「回到出厂」那条路不许被存档拿走)。
          { name: '没有 id', bindings: {} },
          { id: 'default', name: '冒名顶替', bindings: {} },
          'x',
        ],
      },
      current,
    )
    expect(merged.profileId).toBe('vscode')
    expect(merged.userProfiles).toEqual([
      { id: 'user:mine', name: '我的', bindings: { 'tab.close': [{ key: 'q', meta: true }] } },
    ])
  })

  it('组 id 不是串 = 他没换过组;组表不是数组 = 一组都没有', () => {
    const current = { overrides: {}, profileId: 'vscode', userProfiles: [] }
    const merged = mergeKeymapPersisted({ profileId: 7, userProfiles: 'x' }, current)
    expect(merged.profileId).toBe('default')
    expect(merged.userProfiles).toEqual([])
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
