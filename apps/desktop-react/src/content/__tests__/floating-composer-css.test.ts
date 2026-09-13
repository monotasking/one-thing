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
 * 选择器必须**从行首**起 —— 否则 `.composerDock` 会先命中一条把它当子串包住的
 * 规则,断言于是读到隔壁那条的声明块,红得莫名其妙。
 */
function block(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`)
  expect(at, `样式表里找不到行首的 ${selector}`).toBeGreaterThanOrEqual(0)
  return css.slice(at + 1, css.indexOf('}', at))
}

const shell = read('src/components/AppShell.module.css')
/*
 * W5-c(路线 A):落位带那两条从外壳搬进了**会话叶自己的**样式表 —— 输入框是
 * `session` 那一种内容的器官,「一块内容长什么样」跟着那块内容走。让位那一条
 * 留在外壳(那是外壳的事),只是抓手从类名换成了 `[data-composer-dock]`:
 * CSS Modules 的类名跨文件会被哈希成两个不同的名字。
 */
const leaf = read('src/content/kinds/ChatLeaf.module.css')
const chat = read('src/content/ChatStream.module.css')
const composer = read('src/composer/components/Composer.module.css')
const pill = read('src/content/FollowPill.module.css')
const toc = read('src/toc/TocPanel.module.css')
const tokens = read('src/styles/tokens.css')

describe('① 输入框浮起来,聊天区铺满', () => {
  it('落位带绝对定位贴底,且自己不接事件(不然它会吃掉底下正文的滚轮)', () => {
    const dock = block(leaf, '.composerDock')
    expect(dock).toMatch(/position:\s*absolute/)
    expect(dock).toMatch(/bottom:\s*0/)
    expect(dock).toMatch(/pointer-events:\s*none/)
    // 孩子收回事件 —— 否则输入框自己也点不动。
    expect(block(leaf, '.composerDock > *')).toMatch(/pointer-events:\s*auto/)
  })

  /**
   * 09-13(Dock 常驻改整边浮栏)**推翻**了这一条的前一版。
   *
   * 旧版钉的是 `.shell[data-dock-reserve='bottom'] .composerDock { bottom: reserve }` ——
   * 那是**内衬形**让位的必需品:内衬打在 `.center` 的 `padding-block-end` 上,而输入框
   * 是 `.center` 的绝对定位子元素,`bottom` 量的是包含块的 padding box,父级那条内衬
   * 一个像素都推不动它,所以要在它自己身上再写一次。
   *
   * 四条边改成**平移形**(让位打在 `.main` 的 padding 上)之后,`.center` 整格就已经
   * 在让位线以上了 —— 输入框贴的是一个已经缩过的包含块,`bottom: 0` 天然落在线上。
   * 那条覆写于是**必须删掉**:留着就是让位算两遍,输入框会浮在半空。
   *
   * 断言因此反过来:**不许再有那条规则**,而让位落在 `.main` 上。
   */
  it('Dock 停底边的让位落在 .main 上(平移形),输入框不再有第二条 bottom 覆写', () => {
    expect(shell).not.toMatch(/\.shell\[data-dock-reserve='bottom'\]\s+\.composerDock\s*\{/)
    expect(block(shell, ".shell[data-dock-reserve='bottom'] .main")).toMatch(
      /padding-block-end:\s*var\(--dock-reserve-h\)/,
    )
    /*
     * W5-c(路线 A)再补三句:落位带搬进了会话叶(`ChatLeaf.module.css`),外壳的样式表里
     * 不许再有 `.composerDock` 的任何规则,也不许按 `[data-composer-dock]` 属性给它
     * 单独让位 —— 它住在 `.main` 已经缩好的内容盒里,让位按构造继承,再写一条就是
     * 让两遍(真机读数在 `gate:chat-follow` ②:气口里压着一条消息,差 44px)。
     * 落位带身上那个属性仍旧要挂着:真机门按它找人(`scripts/lib/composer-dock.mjs`)。
     */
    expect(shell).not.toMatch(/data-dock-reserve='bottom'\]\s*\[data-composer-dock\]/)
    expect(shell).not.toMatch(/\.composerDock\s*\{/)
    expect(read('src/content/kinds/session.tsx')).toMatch(/data-composer-dock/)
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
    // W5-c:量它的那只观察者跟着输入框搬进了会话叶(`useComposerGeometry`)。
    expect(read('src/content/kinds/session.tsx')).toMatch(
      /setProperty\(name, `\$\{Math\.round\(px\)\}px`\)/,
    )
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
   * 被量进去。那只观察者(W5-c 起住在会话叶里)、`.scroll` 那两条内衬都因此一行没改。
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
