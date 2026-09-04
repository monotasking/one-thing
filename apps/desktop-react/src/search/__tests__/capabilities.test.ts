import { describe, expect, it } from 'vitest'
import type { SearchCapabilityManifestDto, SearchStatusResponse } from '@shared/ipc/search'
import { ALL_TAB, indexReadoutOf, nextTab, resolveTab, tabsOf } from '../capabilities'

/**
 * tab 条来自自述(检索重建 S4a,设计 §9 第一条 / §4.0)。
 *
 * 这一族守的是**骨架不认识能力**:同一只 `tabsOf` 喂六份自述、喂两份、喂零份,
 * 答案各不相同而代码一个字不改。「注销一个能力 tab 少一格」那条反证(§11 S4)
 * 就是它 —— 拿走一份自述,那一格当场消失。
 */

function manifest(id: string, order: number, labelKey = `search.capability.${id}`): SearchCapabilityManifestDto {
  return { id, labelKey, icon: 'Search', kind: 'indexed', budget: { default: 5, timeoutMs: 300 }, order }
}

describe('tabsOf', () => {
  it('`all` 固定第一,其余按 order 升序', () => {
    const tabs = tabsOf([manifest('c', 3), manifest('a', 1), manifest('b', 2)])
    expect(tabs.map(tab => tab.id)).toEqual([ALL_TAB, 'a', 'b', 'c'])
  })

  it('同 order 保**注册序**(注册顺序 = 缺省展示顺序,§4.3)', () => {
    const tabs = tabsOf([manifest('second', 1), manifest('first', 1)])
    expect(tabs.map(tab => tab.id)).toEqual([ALL_TAB, 'second', 'first'])
  })

  it('labelKey / icon 是**自述原样**,壳不翻译也不改名', () => {
    const tabs = tabsOf([{ ...manifest('symbols', 2, 'plugin.symbols.label'), icon: 'Braces' }])
    expect(tabs[1]).toEqual({ id: 'symbols', labelKey: 'plugin.symbols.label', icon: 'Braces' })
  })

  /** §11 S4 的反证:「tab 写死 → 注销一个能力 tab 仍在」当场红。 */
  it('注销一个能力,它那一格自动少一格 —— 壳一个字不改', () => {
    const all = [manifest('a', 1), manifest('b', 2), manifest('c', 3)]
    expect(tabsOf(all).map(tab => tab.id)).toEqual([ALL_TAB, 'a', 'b', 'c'])
    expect(tabsOf(all.filter(m => m.id !== 'b')).map(tab => tab.id)).toEqual([ALL_TAB, 'a', 'c'])
  })

  it('一个能力都没有(自述还没回来 / 问不到)时只剩 `all` —— 不伪造几格', () => {
    expect(tabsOf([]).map(tab => tab.id)).toEqual([ALL_TAB])
  })
})

describe('nextTab / resolveTab', () => {
  const tabs = tabsOf([manifest('a', 1), manifest('b', 2)])

  it('Tab 往前、⇧Tab 往后,到头回卷', () => {
    expect(nextTab(tabs, ALL_TAB, 1)).toBe('a')
    expect(nextTab(tabs, 'b', 1)).toBe(ALL_TAB)
    expect(nextTab(tabs, ALL_TAB, -1)).toBe('b')
  })

  it('当前这一档已经不在表里(能力刚被注销)→ 从头开始,不留在一个不存在的档上', () => {
    expect(nextTab(tabs, '并不存在', 1)).toBe(ALL_TAB)
    expect(resolveTab(tabs, '并不存在')).toBe(ALL_TAB)
    expect(resolveTab(tabs, 'b')).toBe('b')
  })

  it('一格都没有时轮转不动 —— 不抛也不给一个空 id', () => {
    expect(nextTab([], 'x', 1)).toBe('x')
  })
})

describe('indexReadoutOf', () => {
  const status = (patch: Partial<SearchStatusResponse>): SearchStatusResponse =>
    ({ mode: 'owner', pending: 0, vector: 'off', ...patch })

  it('owner + 有积压 → 只报「剩 n」,不报维护者', () => {
    expect(indexReadoutOf(status({ pending: 12 }))).toEqual({ pending: 12 })
  })

  it('owner + 没积压 → 有读数但 pending 是 0(那一行由面板按 >0 判要不要画)', () => {
    expect(indexReadoutOf(status({}))).toEqual({ pending: 0 })
  })

  /**
   * **读者模式那一行今天画不出来**(§5.6 拍点庚 09-04 裁「先不做」,`mode` 恒 owner)。
   * 这条用例守的是「画它的逻辑在」—— §10 S4 行的第七条门断言在真机上只能用注入的
   * 假 status 证,而判据本身在这只纯函数里。
   */
  it('reader → 连维护者一起报;host 缺席时是空串,不编一个名字', () => {
    expect(indexReadoutOf(status({ mode: 'reader', pending: 3, owner: { host: 'mac-mini', pid: 9 } })))
      .toEqual({ pending: 3, readerHost: 'mac-mini' })
    expect(indexReadoutOf(status({ mode: 'reader', pending: 0 })))
      .toEqual({ pending: 0, readerHost: '' })
  })

  it('error(这台机器上根本没起索引)不在这两行里说', () => {
    // 它既不是「更新中」也不是「别人在维护」,而且后果已经由「搜不到东西」自己说了。
    expect(indexReadoutOf(status({ mode: 'error' }))).toEqual({ pending: 0 })
  })

  it('问不到状态 = 两行都不画(不是「一切正常」)', () => {
    expect(indexReadoutOf(undefined)).toBeUndefined()
  })
})
