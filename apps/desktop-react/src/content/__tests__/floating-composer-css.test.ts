import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * **悬浮输入框那条几何链**(§5.6)。四份样式表 + 一份 token 表联手才成立,
 * 少任何一格,「正文从玻璃底下流过 + 贴底时留够气口」当场断掉 —— 而且**断得没声音**
 * (布局照旧能画,只是最后一条消息压在玻璃底下)。所以门守在源文本上。
 *
 * 与 `composer/components/composer-css.test.ts` 同一条判据:这批样式是 CSS Modules,
 * 在 vitest 里从来没有进过 jsdom 的样式表,`getComputedStyle` 恒答缺省值 ——
 * 拿它当断言,规则删掉了也照样绿。真机那一半由 `scripts/gate-chat-follow.mjs` 量。
 *
 * **先剥注释**(既有法条:读样式表源文本的门先剥注释)—— 这几份注释里写的是病历,
 * 病历里出现的正是断言要找的那些字。
 */
function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
}

/**
 * 取一条规则的整块声明(`.sel {...}` 里那一段)。
 *
 * 选择器必须**从行首**起 —— 否则 `.composerDock` 会先命中
 * `.shell[data-dock-reserve='bottom'] .composerDock`(它把前者当子串包住了),
 * 断言于是读到隔壁那条规则的声明块,红得莫名其妙。
 */
function block(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`)
  expect(at, `样式表里找不到行首的 ${selector}`).toBeGreaterThanOrEqual(0)
  return css.slice(at + 1, css.indexOf('}', at))
}

const shell = read('src/components/AppShell.module.css')
const chat = read('src/content/ChatStream.module.css')
const composer = read('src/composer/components/Composer.module.css')
const pill = read('src/content/FollowPill.module.css')
const toc = read('src/toc/TocPanel.module.css')
const tokens = read('src/styles/tokens.css')

describe('① 输入框浮起来,聊天区铺满', () => {
  it('落位带绝对定位贴底,且自己不接事件(不然它会吃掉底下正文的滚轮)', () => {
    const dock = block(shell, '.composerDock')
    expect(dock).toMatch(/position:\s*absolute/)
    expect(dock).toMatch(/bottom:\s*0/)
    expect(dock).toMatch(/pointer-events:\s*none/)
    // 孩子收回事件 —— 否则输入框自己也点不动。
    expect(block(shell, '.composerDock > *')).toMatch(/pointer-events:\s*auto/)
  })

  it('Dock 停底边的让位改加在它的 bottom 上(绝对定位不吃父级内边距)', () => {
    expect(block(shell, ".shell[data-dock-reserve='bottom'] .composerDock")).toMatch(
      /bottom:\s*var\(--dock-reserve-h\)/,
    )
  })
})

describe('② 气口:正文与玻璃上缘之间那 40px', () => {
  it('气口是一个 token,值 40px(09-04 用户拍板)', () => {
    expect(tokens).toMatch(/--composer-gap:\s*40px/)
  })

  it('滚动容器的底部内衬 = 输入框实高 + 气口,scroll-padding 同值', () => {
    const scroll = block(chat, '.scroll')
    const expected = /calc\(var\(--composer-h\)\s*\+\s*var\(--composer-gap\)\)/
    expect(scroll).toMatch(new RegExp(`padding-block-end:\\s*${expected.source}`))
    // scroll-padding 不继承,必须写在滚动容器自己身上,否则 TOC 跳转会停在玻璃底下。
    expect(scroll).toMatch(new RegExp(`scroll-padding-block-end:\\s*${expected.source}`))
  })

  it('内容列的底部内边距归 0 —— 气口只许加一次', () => {
    expect(block(chat, '.column')).toMatch(/padding:\s*var\(--sp-6\)\s+var\(--sp-4\)\s+0/)
  })

  it('输入框实高不是魔法数:token 里只有一个兜底 0,真值由 ResizeObserver 写', () => {
    expect(tokens).toMatch(/--composer-h:\s*0px/)
    expect(read('src/components/AppShell.tsx')).toMatch(/setProperty\(name, `\$\{Math\.round\(px\)\}px`\)/)
  })

  /*
   * ── 09-12 报障「会把内容往上顶,有时顶有时不顶」的产地 ────────────────────
   * `--composer-h` 量的是 `.composerDock` 的 `getBoundingClientRect().height`,
   * 而那只是它**布局盒**的高。抽屉从前是面板里的一格流内元素 —— 一开就把这个数
   * 抬高一整列,消息流的内衬跟着抬,**贴底跟随**时列表为了继续贴底把正文往上推
   * (上翻浏览时滚动位不动,所以只是被盖住:「有时顶有时不顶」= 两种状态)。
   *
   * 治法是几何:抽屉改成 `position: absolute`,绝对定位的子元素**不进父级布局高**。
   * 所以这条断言与上面那一条是**一对**:一条说这个数怎么量,一条说什么东西不该
   * 被量进去。AppShell 那只观察者、`.scroll` 那两条内衬都因此一行没改。
   */
  it('抽屉不进这个数:它绝对定位挂在面板上沿,布局高里没有它', () => {
    const drawer = block(composer, '.drawer')
    expect(drawer).toMatch(/position:\s*absolute/)
    expect(drawer).toMatch(/bottom:\s*100%/)
    // 反面:它一旦回到文档流(grid 展开那一形),这个数当场又把它算进去。
    expect(drawer).not.toMatch(/grid-template-rows/)
  })
})

describe('③ 玻璃(拍点 ⑪ 磨砂)', () => {
  it('底是半透明的 --glass + backdrop-filter 的 blur 与 saturate', () => {
    const panel = block(composer, '.panel')
    expect(panel).toMatch(/background:\s*var\(--glass\)/)
    expect(panel).toMatch(/backdrop-filter:\s*blur\(var\(--composer-blur\)\) saturate\(var\(--composer-saturate\)\)/)
    // Safari / 旧 WebKit 只认前缀那一行,少了它那半边浏览器上玻璃是全透明的。
    expect(panel).toMatch(/-webkit-backdrop-filter:/)
    // 边线降一档、影升到浮层那一档。
    expect(panel).toMatch(/border:\s*1px solid var\(--composer-glass-line\)/)
    expect(panel).toMatch(/box-shadow:\s*var\(--sh-2\)/)
  })

  it('抽屉开着 = 整块转不透明(清单是要读的,不能叠在正文上)', () => {
    const open = block(composer, '.panel:has(.drawerOpen)')
    expect(open).toMatch(/background:\s*var\(--surface-2\)/)
    expect(open).toMatch(/backdrop-filter:\s*none/)
    expect(open).toMatch(/-webkit-backdrop-filter:\s*none/)
  })

  it('抽屉高度上限 = min(既有上限, 中央区高度的 40%)', () => {
    expect(block(composer, '.pickScroll')).toMatch(
      /max-height:\s*min\(var\(--composer-drawer-max\), calc\(var\(--center-h, 200vh\) \* 0\.4\)\)/,
    )
  })
})

describe('④ 丸落在气口正中,TOC 键列避开玻璃', () => {
  it('丸的 bottom = 输入框实高 + 气口一半 − 丸高一半', () => {
    expect(block(pill, '.slot')).toMatch(
      /bottom:\s*calc\(var\(--composer-h\) \+ var\(--composer-gap\) \/ 2 - var\(--btn-sm\) \/ 2\)/,
    )
  })

  it('丸那条带也不接事件 —— 它横跨整个聊天区', () => {
    expect(block(pill, '.slot')).toMatch(/pointer-events:\s*none/)
    expect(block(pill, '.backing')).toMatch(/pointer-events:\s*auto/)
  })

  it('键列居的是**露在外面那一段**的中,不是整个聊天区的中', () => {
    expect(block(toc, '.rail')).toMatch(
      /top:\s*calc\(50% - \(var\(--composer-h\) \+ var\(--composer-gap\)\) \/ 2\)/,
    )
  })
})
