import { describe, expect, it } from 'vitest'
import type { SearchCapabilityManifestDto, SearchStatusResponse } from '@shared/ipc/search'
import {
  ALL_TAB,
  browseCapabilitiesOf,
  indexReadoutOf,
  labelKeyOf,
  labelTextOf,
  nextTab,
  resolveTab,
  scopeNamesOf,
  tabsOf,
} from '../capabilities'

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

/**
 * 空词的「所有」档去问谁(S4b 修)。判据是**自述的一格 `browse`**,不是壳里的
 * 一个名字 —— 所以这一族喂的全是造出来的 id,一个真能力都不认。
 */
describe('browseCapabilitiesOf(空词时谁有浏览态)', () => {
  const browsable = (id: string, order: number): SearchCapabilityManifestDto =>
    ({ ...manifest(id, order), browse: true })

  it('只挑自报了 `browse` 的那些 —— 缺席 = 空词时没东西可列', () => {
    expect(browseCapabilitiesOf([manifest('a', 1), browsable('b', 2), manifest('c', 3)]))
      .toEqual(['b'])
  })

  it('次序与 tab 条同一条(order 升序,同 order 保注册序)', () => {
    expect(browseCapabilitiesOf([browsable('late', 3), browsable('early', 1), browsable('mid', 2)]))
      .toEqual(['early', 'mid', 'late'])
  })

  /** §4.0 的硬指标:再来一个自报浏览态的能力,空词那一屏自己多一组。 */
  it('注册表多一个 `browse` 的陌生能力 → 多一格,壳一个字不改', () => {
    const base = [manifest('a', 1), browsable('b', 2)]
    expect(browseCapabilitiesOf(base)).toEqual(['b'])
    expect(browseCapabilitiesOf([...base, browsable('zzz', 9)])).toEqual(['b', 'zzz'])
  })

  it('一个都没声明(或者自述还没回来)= 空表 —— 那时面板照旧发 `all`', () => {
    expect(browseCapabilitiesOf([manifest('a', 1)])).toEqual([])
    expect(browseCapabilitiesOf([])).toEqual([])
  })
})

describe('labelKeyOf(组名从自述读)', () => {
  it('答那个能力自述里的 labelKey', () => {
    expect(labelKeyOf([manifest('a', 1), manifest('b', 2)], 'b')).toBe('search.capability.b')
  })

  it('表里没有它 = `undefined`(不编一个名字)', () => {
    expect(labelKeyOf([manifest('a', 1)], 'zzz')).toBeUndefined()
  })
})

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

  /**
   * **`error` 不再被吞**(检索面终稿 落差 #19,09-05 裁定)。
   *
   * 从前的判词是「后果已经由『搜不到东西』自己说了」——而那正是病:屏幕上
   * 「一条都没搜到」与「索引坏了、只剩扫描那几类」长得一模一样,用户没有任何
   * 办法分辨。现在它自报一格 `unavailable`,页脚据此上屏一句人话(无重试)。
   */
  it('error(这台机器上根本没起索引)自报一格 unavailable —— 页脚据此说一句人话', () => {
    expect(indexReadoutOf(status({ mode: 'error' }))).toEqual({ pending: 0, unavailable: true })
    // 它不是「别人在维护」:那一格仍然缺席,两句话不混。
    expect(indexReadoutOf(status({ mode: 'error' }))?.readerHost).toBeUndefined()
  })

  it('问不到状态 = 两行都不画(不是「一切正常」)', () => {
    expect(indexReadoutOf(undefined)).toBeUndefined()
  })

  /**
   * **语义召回那一格**(S7 §15;步⑦ 留账 E-6 第一条)。四态里只有中间两态值一行字:
   * `ready` 与 `off` 什么都不说 —— 开关关着不是新闻,能用了也不必宣布。
   */
  it('vector:只有 downloading / embedding 上表,ready 与 off 一个字不说', () => {
    expect(indexReadoutOf(status({ vector: 'downloading' })))
      .toEqual({ pending: 0, vector: 'downloading' })
    expect(indexReadoutOf(status({ vector: 'embedding', vectorPending: 41 })))
      .toEqual({ pending: 0, vector: 'embedding', vectorPending: 41 })
    expect(indexReadoutOf(status({ vector: 'ready' }))).toEqual({ pending: 0 })
    expect(indexReadoutOf(status({ vector: 'off' }))).toEqual({ pending: 0 })
    // 旧后端不给这一格 = 不知道 = 不画(不是「关着」)。
    expect(indexReadoutOf({ mode: 'owner', pending: 0 })).toEqual({ pending: 0 })
  })

  /** 它与 `mode` **无关**:索引是 reader / error 时模型照样可能在下载。 */
  it('vector 与 mode 各说各的 —— 三条 return 都驮着它', () => {
    expect(indexReadoutOf(status({ mode: 'error', vector: 'embedding', vectorPending: 3 })))
      .toEqual({ pending: 0, unavailable: true, vector: 'embedding', vectorPending: 3 })
    expect(indexReadoutOf(status({ mode: 'reader', vector: 'downloading' })))
      .toEqual({ pending: 0, readerHost: '', vector: 'downloading' })
  })
})

/**
 * **输入框占位里那串档名**(R12;落差 #51 / #125 / #129)。
 *
 * 从前是字典里写死的「搜文件、章节、消息、会话…」——「章节」早就不是一个档了。
 * 现在它是自述的投影:表里有哪几档就念哪几档,`all` 不算(它不是一类能搜的东西)。
 */
describe('scopeNamesOf(占位从自述生成)', () => {
  const tabs = tabsOf([manifest('chats', 1), manifest('files', 2)])
  const label = (tab: { id: string }) => ({ all: '所有', chats: '会话', files: '文件' })[tab.id] ?? ''

  it('`all` 那一格不进去 —— 它是「不挑」这个动作,不是一类东西', () => {
    expect(scopeNamesOf(tabs, label)).toEqual(['会话', '文件'])
  })

  it('次序与 tab 条同一条(order 升序)—— 屏幕上从左念到右就是这串字', () => {
    const reordered = tabsOf([manifest('files', 9), manifest('chats', 1)])
    expect(scopeNamesOf(reordered, label)).toEqual(['会话', '文件'])
  })

  it('注销一个能力,它那个名字自己就没了 —— 壳一个字不改', () => {
    expect(scopeNamesOf(tabsOf([manifest('chats', 1)]), label)).toEqual(['会话'])
  })

  it('自述还没回来 = 空表(调用方据此退回那句不带档名的兜底,不印一串猜的)', () => {
    expect(scopeNamesOf(tabsOf([]), label)).toEqual([])
  })

  it('名字空着的那一格丢掉 —— 一个「、、」比少一个名字更像坏了', () => {
    expect(scopeNamesOf(tabs, tab => (tab.id === 'files' ? '' : '会话'))).toEqual(['会话'])
  })
})

/**
 * 屏幕上那一格写什么(S4b)。
 *
 * 起因是一条真会上屏的形:插件能力(或任何一个不在壳这份字典里的能力)给的
 * `labelKey` 翻不出来时,`translate` 答的是 `undefined` —— 渲染成一格**空白 tab**。
 * 空白比原文糟得多:原文至少说得出「这一档叫什么」,而空白让人以为控件坏了。
 */
describe('labelTextOf(翻得出画译文,翻不出画原文)', () => {
  it('翻得出来就画译文', () => {
    expect(labelTextOf('search.capability.chats', '会话')).toBe('会话')
  })

  it('翻不出来(字典里没有这个键)就画**原文**,不是一格空白', () => {
    expect(labelTextOf('search.capability.unknown', undefined)).toBe('search.capability.unknown')
    // `translate` 对缺席的键实际答的是 undefined,渲染成空串 —— 空串同样要退到原文。
    expect(labelTextOf('search.capability.unknown', '')).toBe('search.capability.unknown')
  })
})
