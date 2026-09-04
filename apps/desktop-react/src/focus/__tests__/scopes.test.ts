import { describe, expect, it } from 'vitest'
import { FOCUS_SCOPED_KEYS, FOCUS_SCOPES, FOCUS_SCOPE_LIST, focusScopeKeysOf } from '../scopes'
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
  // 拼贴树里的一片叶(W1)。
  'leaf',
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
  it('22 格(W1 加了 leaf),一格不多一格不少', () => {
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

describe('局部键:查看器 / 文件树 / 会话总览三格', () => {
  it('查看器三条、文件树两条、总览一条、叶一条,别的作用域一条都没有', () => {
    expect(focusScopeKeysOf('viewer').map((k) => k.action)).toEqual(['save', 'jump', 'find'])
    expect(focusScopeKeysOf('files').map((k) => k.action)).toEqual(['detail', 'detail'])
    // 09-04 方向 A:⌘⇧P = 置顶 / 取消置顶活动行。
    expect(focusScopeKeysOf('expose').map((k) => k.action)).toEqual(['pin.toggle'])
    // W1 拍点 ④:⌘W 关当前 tab(叶内局部键 —— 它需要一个目标)。
    expect(focusScopeKeysOf('leaf').map((k) => k.action)).toEqual(['closeTab'])
    const withKeys = FOCUS_SCOPE_LIST.filter((s) => (s.keys?.length ?? 0) > 0).map((s) => s.id)
    // 次序 = 表里的声明序(`leaf` 排在 region 那一族的末尾)。
    expect(withKeys).toEqual(['viewer', 'files', 'expose', 'leaf'])
  })

  /*
   * 带修饰的组合进这张表**就是为了能对撞** —— ⌘P 已经被 `toggle:search` 占着,
   * 而 ⌘⇧P 是另一个组合(`matchCombo` 判 shift)。这一条钉的是「新加的那条键
   * 没有踩在某条已有的全局键上」,加下一条局部键时照抄一遍。
   */
  it('⌘⇧P 与全局的 ⌘P 不是同一个组合(shift 是判据的一格)', () => {
    const pin = focusScopeKeysOf('expose')[0].combo
    expect(pin).toEqual({ meta: true, shift: true, key: 'p' })
    expect(pin.shift).toBe(true)
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

/*
 * ── 「keymap/scopes 是它的投影」那一组 09-03(R2)退役 ──────────────────────
 * R0 时 `keymap/scopes.ts` 还留着一层兼容投影(`KEY_SCOPES` / `SCOPED_KEYS` /
 * `comboFromChord`,连 `files.row` 这个旧面域 id 都原样发出去),那一组用例守的
 * 正是「投影不许与正本分叉」。R2 把落点也迁进了作用域实例,旧形状一个消费者都
 * 没有了,整层连同那三条用例一起退役 —— **没有第二份声明可对**,这只文件上面
 * 那几组守的就是正本本身。
 */
