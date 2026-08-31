import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 检索面**行首那颗徽**的产地守卫(09-01 真机报障:NOTEBOOK 撑破胶囊边框)。
 *
 * ── 为什么这一条读样式表,而不是读一次 getComputedStyle ────────────────────
 * 与 composer-css.test.ts 逐字同一条理由:这一批的样式是 CSS Modules,
 * 在 vitest 里 `import s from './x.module.css'` 拿回来的只是一张**类名映射**,
 * 那份 CSS 从来没有进过 jsdom 的样式表。于是 `getComputedStyle(chip).width`
 * 在这台机器上恒等于空 —— 它答的是「jsdom 没有这条规则」,不是「那颗徽多宽」。
 * 而这条报障的产地恰恰**就是那一行 `width: var(--search-chip-w)`**。
 * 所以门就守在产地上:读源文件,断言写死的那一行不许回来。
 *
 * **真正的几何(徽上的字宽 ≤ 胶囊内容盒宽)要真机才量得到** —— 那一半在
 * `scripts/gate-search.mjs` 里,对着真排版逐颗徽量 scrollWidth / clientWidth。
 * 两半都要在:静态这半守「有人把结构改回定宽」,真机那半守「改完真的不溢出」。
 */

/* 从**应用根**拼路径(vitest 的 cwd 就是 apps/desktop-react);理由同 composer-css.test.ts。 */
const rawCss = readFileSync(
  resolve(process.cwd(), 'src/search/components/SearchPanel.module.css'),
  'utf8',
)

/*
 * 先剥注释(仓纪律):上面那几段病历里写满了 `width: var(--search-chip-w)` 这类
 * 被否掉的写法,不剥的话「禁令」类断言会被自己的病历钉红。
 */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '')

/** 取一条规则的整块声明(`.sel {...}` 里那一段)。 */
function block(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, `样式表里找不到 ${selector}`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', at)
  return css.slice(at, end)
}

describe('行首徽:胶囊 hug 内容,列宽交给容器', () => {
  it('胶囊**不写死宽** —— 09-01 报障的产地就是那一行', () => {
    expect(block('.chip')).not.toMatch(/(^|[^-])width:\s*var\(--search-chip-w\)/)
    // 只许有下限与上限,不许有 `width:`(min-width / max-width 不算)。
    expect(block('.chip')).not.toMatch(/(?<!-)\bwidth:/)
  })

  it('短徽保住今天那颗胶囊的形(min-width 走 token)', () => {
    expect(block('.chip')).toMatch(/min-width:\s*var\(--search-chip-min\)/)
  })

  it('长到离谱时有底(max-width 走 token)—— 徽列不许把标题挤没', () => {
    expect(block('.chip')).toMatch(/max-width:\s*var\(--search-chip-max\)/)
  })

  it('封顶之后由徽内那层弯腰(省略号),不是硬切', () => {
    const text = block('.chipText')
    expect(text).toMatch(/overflow:\s*hidden/)
    expect(text).toMatch(/text-overflow:\s*ellipsis/)
    expect(text).toMatch(/white-space:\s*nowrap/)
  })

  it('列宽定在容器那张网上:徽列是内容自适应轨道(全列按最宽那颗对齐)', () => {
    expect(block('.body')).toMatch(/grid-template-columns:\s*minmax\(0,\s*max-content\)/)
  })

  it('行认领同一份列(subgrid),所以各行的原文从同一条竖线起笔', () => {
    expect(block('.row')).toMatch(/grid-template-columns:\s*subgrid/)
  })

  /*
   * 底部那条 item 从前靠 `padding-left: calc(… --search-chip-w …)` 对齐,
   * 那个 calc 的前提是「徽列定宽」—— 前提没了,它必须一起走,否则它会用一个
   * 再也不成立的数去缩进(屏幕上就是「读数那行与正文列差几个像素」)。
   */
  it('底部那条 item 不再靠写死的徽宽做缩进,而是落在同一份 subgrid 的第二列', () => {
    const more = block('.more,\n.end')
    expect(more).toMatch(/grid-template-columns:\s*subgrid/)
    expect(more).not.toMatch(/--search-chip-w/)
    expect(block('.moreText')).toMatch(/grid-column:\s*2\s*\/\s*-1/)
  })
})

describe('token 侧:定宽那一格已经换成上下限', () => {
  const tokens = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )

  it('--search-chip-w 已经退役 —— 留着它就会有人再写回定宽', () => {
    expect(tokens).not.toMatch(/--search-chip-w:/)
  })

  it('--search-chip-min / --search-chip-max 都在', () => {
    expect(tokens).toMatch(/--search-chip-min:\s*\d/)
    expect(tokens).toMatch(/--search-chip-max:\s*\d/)
  })
})
