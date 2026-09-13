import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * **全仓唯一那条容器焦点环例外**(R1)。
 *
 * CLAUDE.md 第 1 轴写着「焦点一律走全局焦点环,**禁裸删 outline**」。那条法的主语是
 * 控件;这一条删的是**作用域根**的环 —— 一块面被响应链送回焦点时不该整块亮一圈边
 * (08-28 判例:「残留焦点的柔环看起来像卡片莫名带阴影」)。
 *
 * 09-13 焦点环收口之后它不再独占一份 `focus/focus-scope.css`:判词与规则一起搬进
 * `styles/global.css` 的载体契约那一组,和 `data-focus-ring="none"` 并排 ——
 * 它本来就是「不画」那一族的第三个选择器,只是判据不是自述属性,而是
 * 「树送焦点用的那种根」这个结构事实。
 *
 * 这一组守三件事:
 *  ① 那条规则还在,而且判据是**两格一起**(`[data-focus-scope]` + `[tabindex="-1"]`)——
 *    少一格就会波及别的东西;
 *  ② 它与 `data-focus-ring="none"` **同一组**(同一条规则里),不是第二处产地;
 *  ③ 环的样子只有一个产地:整只 focus 域里一句 `outline` 都不许再有。
 *
 * 读源文本之前**先剥注释**(仓规:病历文本会让断言自红 —— 上面那两段话里就写着
 * `outline` 这个词)。
 */

const strip = (raw: string) => raw.replace(/\/\*[\s\S]*?\*\//g, '')

const globalCss = strip(readFileSync(resolve(process.cwd(), 'src/styles/global.css'), 'utf8'))

describe('作用域根不画焦点环', () => {
  it('规则在,而且两格判据缺一不可', () => {
    expect(globalCss).toMatch(/\[data-focus-scope\]\[tabindex='-1'\]:focus-visible/)
  })

  it('它与 data-focus-ring="none" 是同一组,块里只有一句 outline: none', () => {
    const at = globalCss.indexOf("[data-focus-scope][tabindex='-1']:focus-visible")
    const block = globalCss.slice(at, globalCss.indexOf('}', at) + 1)
    expect(block).toMatch(/^\[data-focus-scope\]\[tabindex='-1'\]:focus-visible\s*\{[^}]*\}$/)
    expect(globalCss.slice(Math.max(0, at - 200), at)).toMatch(/\[data-focus-ring='none'\]:focus-visible,/)
    expect(block.match(/[a-z-]+\s*:/g)).toEqual(['outline:'])
    expect(block).toMatch(/outline:\s*none/)
  })

  it('环的样子不在 focus 域里(唯一产地是 styles/)', () => {
    const dir = resolve(process.cwd(), 'src/focus')
    const css = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.css'))
    expect(css).toEqual([])
  })
})
