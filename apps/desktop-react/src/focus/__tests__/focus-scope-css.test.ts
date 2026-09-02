import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * **全仓唯一那条容器焦点环例外**(R1)。
 *
 * CLAUDE.md 第 1 轴写着「焦点一律走全局 `:focus-visible` 环,**禁裸删 outline**」。
 * 那条法的主语是控件;这一条删的是**作用域根**的环 —— 一块面被响应链送回焦点时
 * 不该整块亮一圈边(08-28 判例:「残留焦点的柔环看起来像卡片莫名带阴影」)。
 * 理由全文写在 `focus/focus-scope.css` 的文件头上。
 *
 * 这一组守两件事:
 *  ① 那条规则还在,而且判据是**两格一起**(`[data-focus-scope]` + `[tabindex="-1"]`)——
 *    少一格就会波及别的东西;
 *  ② 例外只有**这一条**:整只 focus 域里 `outline: none` 只出现一次。
 *    要再加一条,先回答「它为什么不能像别的面一样把焦点送给里面某个真控件」。
 *
 * 读源文本之前**先剥注释**(仓规:病历文本会让断言自红 —— 上面那两段话里就写着
 * `outline` 这个词)。
 */

const raw = readFileSync(resolve(process.cwd(), 'src/focus/focus-scope.css'), 'utf8')
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')

describe('作用域根不画焦点环', () => {
  it('规则在,而且两格判据缺一不可', () => {
    expect(css).toMatch(/\[data-focus-scope\]\[tabindex='-1'\]:focus-visible\s*\{/)
    expect(css).toMatch(/outline:\s*none/)
  })

  it('例外只有这一条(整只 focus 域里 `outline: none` 出现一次)', () => {
    expect(css.match(/outline:\s*none/g)?.length).toBe(1)
  })

  it('它只删环,不顺手改别的(这一条不许长成一块皮肤)', () => {
    const body = css.slice(css.indexOf(':focus-visible'))
    const declarations = body.match(/[a-z-]+\s*:/g) ?? []
    expect(declarations).toEqual(['outline:'])
  })
})
