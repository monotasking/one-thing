import { beforeEach, describe, expect, it } from 'vitest'
import { useStageStore } from '../stage/store'
import { zh } from './zh'
import { en } from './en'
import { format, resolveLang, t, translate } from './index'
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
    expect(t('expose.sessionCount', { count: 5 })).toBe('5 sessions')
  })
})
