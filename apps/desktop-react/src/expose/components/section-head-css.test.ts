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

  /*
   * ── 09-12 方向 A:箭头挪到行尾,而且**悬停或已折叠才显**(正本 §3.1)────────
   * 「已折叠才显」是这一格的要点:一节收起来之后,屏幕上除了「少了一片行」没有
   * 任何东西说明它是被收起来的(而不是空的)—— 那时箭头是**状态显示**。
   * 显形只动 opacity、常驻在流里:条件渲染或 display 切换会让节名在悬停那一刻
   * 左右跳一格(无位移原则)。
   */
  it('箭头在行尾、常驻在流里、悬停或已折叠才显(只动 opacity)', () => {
    const css = read('SectionHead.module.css')
    const caret = block(css, '.caret {')
    expect(caret).toMatch(/opacity:\s*0/)
    expect(caret).toMatch(/transition:\s*opacity/)
    // 节名是这一行唯一的弯腰件 —— 它吸满剩余空间,箭头因此被挤到行尾。
    expect(block(css, '.label {')).toMatch(/flex:\s*1 1 auto/)
    expect(css).toMatch(/\.head\[aria-expanded='false'\] \.caret/)
    expect(css).toMatch(/\.head:hover \.caret/)
  })

  /*
   * 粘顶的高与滚动容器的 `scroll-padding-top` 是**同一个数**:不告诉滚动容器
   * 「上面那一行被节头占着」,键盘走到视口外的行会被停在节头底下(环在、行看不见)。
   * 两种形各有各的节头高,所以这一对**要逐档对上**。
   */
  it('两种形各自那个节头高,滚动边界逐档跟着它走', () => {
    const head = read('SectionHead.module.css')
    const tree = read('SessionTree.module.css')
    expect(block(head, '.head {')).toMatch(/height:\s*var\(--expose-sec-h\)/)
    expect(block(tree, '.scroll {')).toMatch(
      /scroll-padding-top:\s*calc\(var\(--expose-sec-h\) \+ var\(--expose-row-gap\)\)/,
    )
    // 总览形那一档:两边一起回到 --list-row-h。
    expect(head).toMatch(/@container expose \(min-width: 761px\)[\s\S]*height:\s*var\(--list-row-h\)/)
    expect(tree).toMatch(
      /@container expose \(min-width: 761px\)[\s\S]*scroll-padding-top:\s*calc\(var\(--list-row-h\) \+ var\(--expose-row-gap\)\)/,
    )
  })

  /*
   * 「第一节让 4 而不是 10」由**列表**重定义那格 token(自定义属性会继承),
   * 而不是写一条跨 CSS Module 去点节头类名的规则(名字带哈希,点不到)。
   */
  it('第一节的上边距由列表重定义 token,节头那条规则一个字不用改', () => {
    expect(block(read('SectionHead.module.css'), '.head {')).toMatch(
      /margin:\s*var\(--expose-sec-lead\) 0 0/,
    )
    expect(read('SessionTree.module.css')).toMatch(
      /\.section:first-child \{\s*--expose-sec-lead:\s*var\(--sp-1\)/,
    )
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
