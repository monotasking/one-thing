/**
 * `applyTheme(…, tokenOverrides)` —— 覆盖的**合成点**。
 *
 * 这条测试是真机走查的回归闩:装了 `contributes.theme.overrides` 的插件、界面
 * 却几乎看不出变化,根因是覆盖落在主题算完**之后**,只盖得住 `CSS_VAR_MAP` 列出的
 * 原始变量;而 renderer 上可见的 UI 绝大多数消费的是从 resolvedColors 派生出来的
 * `--ui-*` / `-rgb` / 色阶变量,它们整片留在旧色上。
 *
 * 所以这里钉的不是"原始变量变了"(那从来就是对的),而是**派生层跟着变**:
 *  1. 引用层 —— 主题里按名字引用顶层 token 的取值(`bg.btn.primary: "accent"`);
 *  2. 语义层 —— `applyThemeColorSemantics` 从 primary 现算的色阶;
 *  3. ui 层  —— `resolveThemeUI` 派生的 `--ui-*`;
 *  4. -rgb 变体 —— `generateCSSVariables` 从 hex 现算的三元组。
 * 以及反向:不给覆盖时整张表逐字不变(合成点前移不得改变无插件时的产出)。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { applyTheme, initializeThemes, sanitizeThemeTokenOverrides } from '../index.js'

const BRAND = '#ff4d00'
const BRAND_ACCENT = '#ff8800'

let pristine: Record<string, string>

beforeAll(() => {
  initializeThemes()
  pristine = applyTheme('flexoki', 'dark')
})

describe('applyTheme tokenOverrides', () => {
  it('不给覆盖(undefined / 空表 / 全被过滤掉)时产出逐字不变', () => {
    expect(applyTheme('flexoki', 'dark', undefined, undefined)).toEqual(pristine)
    expect(applyTheme('flexoki', 'dark', undefined, {})).toEqual(pristine)
    // 键不在主题 token 表、值是空白 —— 主题系统自己这道门直接筛掉。
    expect(applyTheme('flexoki', 'dark', undefined, {
      'definitely.not.a.token': BRAND,
      primary: '   ',
    })).toEqual(pristine)
  })

  it('覆盖 primary/accent:原始变量、引用层、色阶、ui 语义层、-rgb 变体一起变', () => {
    const applied = applyTheme('flexoki', 'dark', undefined, {
      primary: BRAND,
      accent: BRAND_ACCENT,
    })

    // ① 原始变量 —— 声明什么就是什么(内部加工不得改写出口值)。
    expect(applied['--color-primary']).toBe(BRAND)
    expect(applied['--primary']).toBe(BRAND)
    expect(applied['--accent']).toBe(BRAND_ACCENT)

    // ② 引用层 —— flexoki 的 `bg.btn.primary` 写的是引用名 "accent",
    //    主按钮这类最显眼的品牌表面走的就是这条路。
    expect(applied['--bg-btn-primary']).toBe(BRAND_ACCENT)
    expect(applied['--bg-btn-primary']).not.toBe(pristine['--bg-btn-primary'])
    // 未被显式声明的 accentMain 跟随 primary(与主题作者写 primary 时同规)。
    expect(applied['--accent-main']).toBe(BRAND)

    // ③ 语义色阶 —— applyThemeColorSemantics 从覆盖后的 primary 现算。
    for (const cssVar of [
      '--color-primary-hover',
      '--color-primary-bg',
      '--color-primary-bg-hover',
      '--color-primary-border',
      '--color-primary-text',
      '--color-primary-light',
    ]) {
      expect(applied[cssVar], cssVar).not.toBe(pristine[cssVar])
    }

    // ④ ui 语义层 —— 覆盖面的大头。
    expect(applied['--ui-action-primary-bg']).toBe(BRAND)
    expect(applied['--ui-accent-primary-fg']).toBe(BRAND)
    expect(applied['--ui-border-focus-border']).not.toBe(pristine['--ui-border-focus-border'])

    // ⑤ -rgb 变体 —— rgba(var(--…-rgb), α) 一族。
    expect(applied['--color-primary-rgb']).toBe('255, 77, 0')
    expect(applied['--primary-rgb']).toBe('255, 77, 0')
    // accentRgb 是主题手写的三元组:accent 被覆盖后让位,由新 accent 现算。
    expect(applied['--accent-rgb']).toBe('255, 136, 0')

    // 没被覆盖的 token 仍跟随主题。
    expect(applied['--bg-app']).toBe(pristine['--bg-app'])
  })

  it('覆盖面不是个位数 —— 派生层整片跟着走(合成点前移的量化闩)', () => {
    const applied = applyTheme('flexoki', 'dark', undefined, {
      primary: BRAND,
      accent: BRAND_ACCENT,
    })
    const changed = Object.keys(applied).filter(key => applied[key] !== pristine[key])
    // 合成点在响应侧时只有 3 条(--color-primary / --primary / --accent)。
    expect(changed.length).toBeGreaterThan(20)
    expect(changed.filter(key => key.startsWith('--ui-')).length).toBeGreaterThan(10)
  })

  it('覆盖表面 token(bg.app)时,ui 语义层与 -rgb 一起重算', () => {
    const applied = applyTheme('flexoki', 'dark', undefined, { 'bg.app': '#123456' })
    expect(applied['--bg-app']).toBe('#123456')
    expect(applied['--bg-rgb']).toBe('18, 52, 86')
    const changed = Object.keys(applied).filter(key => applied[key] !== pristine[key])
    expect(changed.filter(key => key.startsWith('--ui-')).length).toBeGreaterThan(10)
  })

  it('明暗两套各自重算 —— 覆盖不是一张贴上去的静态表', () => {
    const dark = applyTheme('flexoki', 'dark', undefined, { primary: BRAND })
    const light = applyTheme('flexoki', 'light', undefined, { primary: BRAND })
    expect(dark['--color-primary']).toBe(BRAND)
    expect(light['--color-primary']).toBe(BRAND)
    // 同一个 primary,深浅两套背景上算出来的底色不同。
    expect(dark['--color-primary-bg']).not.toBe(light['--color-primary-bg'])
  })
})

describe('sanitizeThemeTokenOverrides', () => {
  it('白名单就是 CSS_VAR_MAP 的键集合,空表退化成 undefined', () => {
    expect(sanitizeThemeTokenOverrides(undefined)).toBeUndefined()
    expect(sanitizeThemeTokenOverrides({})).toBeUndefined()
    expect(sanitizeThemeTokenOverrides({ nope: '#fff' })).toBeUndefined()
    expect(sanitizeThemeTokenOverrides({ primary: '#fff', nope: '#000' }))
      .toEqual({ primary: '#fff' })
    // 原型链上的东西不算 token。
    expect(sanitizeThemeTokenOverrides({ toString: '#fff' })).toBeUndefined()
    expect(sanitizeThemeTokenOverrides({ primary: '' })).toBeUndefined()
  })
})
