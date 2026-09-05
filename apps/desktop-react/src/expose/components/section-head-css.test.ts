import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * 09-04 用户令「让它不透明」:粘顶节头要有底,行从底下滚过不许透出来。
 * 底色不是节头自己的,是它坐着的那一层宿主面(--surface-host):四个 Placement 宿主根
 * 各自声明,节头只读。jsdom 不排版,守在样式表源文本上(剥注释后判)。
 */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const read = (rel: string) => strip(readFileSync(path.join(__dirname, rel), 'utf-8'))
const block = (css: string, selector: string) => css.slice(css.indexOf(selector)).split('}')[0]

describe('粘顶节头不透明', () => {
  it('.head 的底读 --surface-host,tokens 给缺省', () => {
    expect(block(read('SectionHead.module.css'), '.head {')).toMatch(/background:\s*var\(--surface-host\)/)
    expect(read('../../styles/tokens.css')).toMatch(/--surface-host:\s*var\(--surface-2\)/)
  })
  /*
   * 09-04 用户报「group 的 hover 看不到几乎」:那时悬停只提一档墨色。膜必须是
   * **叠上去的一层图层**而不是换底色 —— --st-hover 是半透明的墨,拿它当 background
   * 会把上面那条「不透明」当场顶掉(行又透出来)。两句断言正是这一对约束。
   */
  it('悬停有标准薄膜,而且底仍然不透明(膜是叠的图层,不是换掉的底色)', () => {
    const css = read('SectionHead.module.css')
    const hover = block(css, '.head:hover {')
    expect(hover).toMatch(/background-image:\s*linear-gradient\(var\(--st-hover\),\s*var\(--st-hover\)\)/)
    // 膜不许写成 `background:` / `background-color:` —— 那会顶掉 .head 的宿主底色。
    expect(hover).not.toMatch(/background(-color)?:/)
  })

  it('四个 Placement 宿主各自声明 --surface-host,且声明在真正铺内容底的那一格上(同块同色)', () => {
    // W2:`CoverLayer` 退役,`FullLayer` 顶上 —— 同一条判据,同一个位置。
    for (const host of ['FloatWindow', 'EdgeShelf', 'StageOverlay', 'FullLayer']) {
      const css = read(`../../components/${host}.module.css`)
      const blocks = css.split('}').filter((b) => b.includes('--surface-host:'))
      expect(blocks.length, host).toBe(1)
      const n = blocks[0].match(/--surface-host:\s*var\(--surface-([12])\)/)?.[1]
      expect(n, host).toBeDefined()
      // 声明所在的块自己就得铺着同一层面 —— 09-04「背景色很奇怪」:边架把它声明在
      // surface-1 的外壳上,而内容底 .body 是 surface-2,节头就成了一块异色。
      expect(blocks[0], host).toMatch(new RegExp(`background:\\s*var\\(--surface-${n}\\)`))
    }
  })
})
