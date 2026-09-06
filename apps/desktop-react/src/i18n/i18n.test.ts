import { beforeEach, describe, expect, it } from 'vitest'
import { useStageStore } from '../stage/store'
import { zh } from './zh'
import { en } from './en'
import { format, plural, resolveLang, t, translate } from './index'
import type { MessageKey } from './index'

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
})

describe('字典完整性', () => {
  it('en 与 zh 的键集合逐条相等(漏译其实在 typecheck 就红,这里是双保险)', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('两边都没有空串 / 没有把中文抄进 en(占位符不算翻译)', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value.length, key).toBeGreaterThan(0)
    }
    for (const [key, value] of Object.entries(zh)) {
      expect(value.length, key).toBeGreaterThan(0)
    }
  })

  it('带占位的键两边占位符一致 —— 少一个就是把变量吞了', () => {
    const holes = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort()
    for (const key of Object.keys(zh) as MessageKey[]) {
      expect(holes(en[key]), key).toEqual(holes(zh[key]))
    }
  })
})

describe('单复数', () => {
  /** 每一对「一个 / 多个」键 —— 加一对计数文案就在这里加一行。 */
  const PAIRS: ReadonlyArray<readonly [MessageKey, MessageKey, string]> = [
    ['quicklook.messageCountOne', 'quicklook.messageCount', 'count'],
    /*
     * `search.allShownOne` / `search.allShown` 那一对在第 ⑨ 步随「共 N 条 · 已全部
     * 显示」一起退役:取尽读数搬进块尾之后只画「共 N 条」(`search.totalCount`),
     * 那句话里没有名词跟在数后面,不需要单复数。键删了,这一行跟着删。
     */
  ]

  it('1 走单数键,0 与 2 走复数键', () => {
    for (const [one, many] of PAIRS) {
      expect(plural(1, one, many)).toBe(one)
      expect(plural(2, one, many)).toBe(many)
      expect(plural(0, one, many)).toBe(many)
    }
  })

  /*
   * 08-31 走查在英文界面上量到「1 results · all shown」。所以这条门读的是
   * **最终那句英文**,不是「有没有调 plural」—— 后者调了照样可能把两个键写反。
   */
  it('英文单数句里不许出现复数名词(1 results 就是这么上屏的)', () => {
    for (const [one, , hole] of PAIRS) {
      const line = translate('en', one, { [hole]: 1 })
      expect(line, one).toMatch(/^1 /)
      // 「1 …s」= 复数名词跟在 1 后面。撇号所有格(1 user's)不在此列。
      expect(line, one).not.toMatch(/^1 \w+s\b/)
    }
  })

  it('中文两句逐字相同 —— 中文不分单复数,分键只是给英文腾位置', () => {
    for (const [one, many] of PAIRS) {
      expect(zh[one], one).toBe(zh[many])
    }
  })
})

describe('插值', () => {
  it('替换 {name} 形占位', () => {
    expect(format('{project} · {count} 会话', { project: 'onething', count: 3 })).toBe(
      'onething · 3 会话',
    )
  })

  it('没给的占位原样留着(不静默吞,方便一眼看出漏传)', () => {
    expect(format('在 {name} 新建会话')).toBe('在 {name} 新建会话')
    expect(format('在 {name} 新建会话', { other: 'x' })).toBe('在 {name} 新建会话')
  })
})

describe('locale 解析', () => {
  it("明确选了语言就用它,'system' 才去问浏览器", () => {
    expect(resolveLang('zh')).toBe('zh')
    expect(resolveLang('en')).toBe('en')
    expect(['zh', 'en']).toContain(resolveLang('system'))
  })

  it('translate 按语言取字典', () => {
    expect(translate('zh', 'composer.send')).toBe('发送')
    expect(translate('en', 'composer.send')).toBe('Send')
  })

  it('t() 读 store 里的 locale,切换当场生效', () => {
    expect(t('composer.send')).toBe('发送')
    useStageStore.setState({ locale: 'en' })
    expect(t('composer.send')).toBe('Send')
  })

  it('t() 也走插值', () => {
    useStageStore.setState({ locale: 'en' })
    expect(t('expose.expandRoom', { name: 'onething' })).toBe('Expand onething')
  })
})
