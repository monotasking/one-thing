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
  it('四个 Placement 宿主各自声明 --surface-host,且声明在真正铺内容底的那一格上(同块同色)', () => {
    for (const host of ['FloatWindow', 'EdgeShelf', 'StageOverlay', 'CoverLayer']) {
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
