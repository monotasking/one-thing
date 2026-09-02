import { describe, expect, it } from 'vitest'
import { FOCUS_SCOPED_KEYS, FOCUS_SCOPES, FOCUS_SCOPE_LIST, focusScopeKeysOf } from '../scopes'
import { KEY_SCOPES, SCOPED_KEYS } from '../../keymap/scopes'
import { zh } from '../../i18n/zh'
import { en } from '../../i18n/en'
import type { FocusScopeId, FocusScopeKind } from '../types'

/**
 * **封闭表的守卫**。加一格作用域 = 三件事(表加一行 / `FocusScopeId` 加一格 /
 * labelKey 在两本字典里成对存在),这一组保证缺一件当场红,而不是等到真机上
 * 某块面的名字读成一个键名。
 *
 * 反证:把 `FOCUS_SCOPES.viewer` 的 labelKey 改成一个不存在的键 → 第二条红;
 * 把 `viewer` 那三行局部键删一行 → 投影那两条红(以及 keymap-scopes 那一组)。
 */

const ALL_IDS: readonly FocusScopeId[] = [
  'root',
  'viewer',
  'files',
  'composer',
  'search',
  'expose',
  'chat',
  'settings',
  'dock',
  'stage-layer',
  'float-layer',
  'shelf-layer',
  'cover-layer',
  'jumpbar',
  'drawer',
  'zoom',
  'popover',
  'tooltip',
  'dialog',
  'menu',
  'palette',
]

describe('FOCUS_SCOPES 封闭表', () => {
  it('首批 21 格,一格不多一格不少', () => {
    expect(FOCUS_SCOPE_LIST.map((s) => s.id).sort()).toEqual([...ALL_IDS].sort())
  })

  it('每一格的 key 与它自己的 id 一致(表是按 id 索引的,不许对不上)', () => {
    for (const [key, spec] of Object.entries(FOCUS_SCOPES)) expect(spec.id).toBe(key)
  })

  it('每一格的 labelKey 在 zh / en 两本字典里都真有一条', () => {
    for (const spec of FOCUS_SCOPE_LIST) {
      expect(zh[spec.labelKey], `zh ${spec.id}`).toBeTruthy()
      expect(en[spec.labelKey], `en ${spec.id}`).toBeTruthy()
    }
  })

  it('行为档只有五种,而且 root 只有一格', () => {
    const kinds: FocusScopeKind[] = ['root', 'layer', 'region', 'float', 'modal']
    for (const spec of FOCUS_SCOPE_LIST) expect(kinds).toContain(spec.kind)
    expect(FOCUS_SCOPE_LIST.filter((s) => s.kind === 'root').map((s) => s.id)).toEqual(['root'])
  })

  it('四个 Placement 宿主都是 layer,三种临时面各归其档', () => {
    for (const id of ['stage-layer', 'float-layer', 'shelf-layer', 'cover-layer'] as const) {
      expect(FOCUS_SCOPES[id].kind).toBe('layer')
    }
    /*
     * `popover` 在 modal 这一格(R1 改),理由写在 `scopes.ts` 那一行上:
     * 行为档 `modal` 说的是 **Tab 走不走得出去**,与 ARIA 的 `aria-modal`
     * 不是一个词 —— 而 `ui/Popover` 今天就在圈禁 Tab。
     */
    for (const id of ['dialog', 'menu', 'palette', 'popover'] as const) {
      expect(FOCUS_SCOPES[id].kind).toBe('modal')
    }
    for (const id of ['jumpbar', 'drawer', 'zoom', 'tooltip'] as const) {
      expect(FOCUS_SCOPES[id].kind).toBe('float')
    }
  })
})

describe('局部键:今天只有查看器与文件树两格', () => {
  it('查看器三条、文件树两条,别的作用域一条都没有', () => {
    expect(focusScopeKeysOf('viewer').map((k) => k.action)).toEqual(['save', 'jump', 'find'])
    expect(focusScopeKeysOf('files').map((k) => k.action)).toEqual(['detail', 'detail'])
    const withKeys = FOCUS_SCOPE_LIST.filter((s) => (s.keys?.length ?? 0) > 0).map((s) => s.id)
    expect(withKeys).toEqual(['viewer', 'files'])
  })

  it('每条键的 scope 字段真的指着装它的那一格(表里不许有搬错家的行)', () => {
    for (const spec of FOCUS_SCOPE_LIST) {
      for (const key of spec.keys ?? []) expect(key.scope).toBe(spec.id)
    }
  })

  it('每条键的 labelKey 也在两本字典里', () => {
    for (const key of FOCUS_SCOPED_KEYS) {
      expect(zh[key.labelKey], `zh ${key.action}`).toBeTruthy()
      expect(en[key.labelKey], `en ${key.action}`).toBeTruthy()
    }
  })
})

describe('keymap/scopes 是它的投影,不是第二份声明', () => {
  it('条数逐条对得上(旧表现在从 FOCUS_SCOPES 派生)', () => {
    expect(SCOPED_KEYS.length).toBe(FOCUS_SCOPED_KEYS.length)
    expect(SCOPED_KEYS.map((k) => k.combo)).toEqual(FOCUS_SCOPED_KEYS.map((k) => k.combo))
  })

  it('唯一一处不是恒等的:`files` 在旧表里叫 `files.row`,名字也照旧', () => {
    expect(KEY_SCOPES.map((s) => s.id)).toEqual(['viewer', 'files.row'])
    expect(KEY_SCOPES.find((s) => s.id === 'files.row')?.labelKey).toBe('keys.scopeFilesRow')
    expect(SCOPED_KEYS.filter((k) => k.scope === 'files.row')).toHaveLength(2)
  })
})
