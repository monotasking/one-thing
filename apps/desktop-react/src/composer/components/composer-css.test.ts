import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 输入面的**光标形状**(08-31 真机报障:空框时鼠标停在占位符上是箭头,不是 I 形)。
 *
 * ── 为什么这一条是读样式表,而不是读一次 `getComputedStyle` ────────────────
 * 这一批的样式是 CSS Modules:在 vitest 里 `import s from './x.module.css'` 拿回来的
 * 是一张**类名映射**,那份 CSS 从来没有进过 jsdom 的样式表(vite 只在浏览器里注入它)。
 * 于是 `getComputedStyle(el).cursor` 在这台机器上恒等于 `auto` —— 它答的是
 * 「jsdom 没有这条规则」,不是「这块 UI 的光标是什么」。拿它当断言,规则删掉了也照样绿。
 *
 * 而这条报障的产地恰恰**就是那两行 CSS**。所以门就守在产地上:读源文件,断言那两行
 * 还在。它验不了浏览器怎么画(那要真机),但它守得住「有人把这两行删了」——
 * 这正是这条报障复发的唯一方式。
 */

/*
 * 从**应用根**拼路径(vitest 的 cwd 就是 apps/desktop-react):`import.meta.url`
 * 在这套配置下不是一条 file: URL,拿它去 fileURLToPath 会当场抛。
 */
const raw = readFileSync(
  resolve(process.cwd(), 'src/composer/components/Composer.module.css'),
  'utf8',
)

/*
 * **先剥注释**(CLAUDE.md 那条:读样式表源文本的门先剥注释)。这份样式表里的
 * 注释写的是病历 —— 「从前这里是 flex: 1」「药丸被压到 min-content 会折行」——
 * 病历里出现的正是断言要找 / 要否掉的那些字,不剥就会让断言自绿或自红。
 */
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '')

/** 取一条规则的整块声明(`.sel {...}` 里那一段)。 */
function block(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, `样式表里找不到 ${selector}`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', at)
  return css.slice(at, end)
}

describe('可编辑区的光标形状(08-31 报障的产地)', () => {
  it.each([
    ['.input', '本体行的输入面'],
    ['.askFree', 'ask 形态里「其他」那一行'],
  ])('%s(%s)显式声明 cursor: text —— 不靠 auto 去猜', (selector) => {
    expect(block(selector)).toMatch(/cursor:\s*text/)
  })

  it.each([
    ['.input:empty::before', '输入面的占位符'],
    ['.askFree:empty::before', '「其他」那一行的占位符'],
  ])('%s(%s)是画出来的一句话,命中测试一律穿过去', (selector) => {
    expect(block(selector)).toMatch(/pointer-events:\s*none/)
  })
})

/**
 * 抽屉候选列表的**封顶**(08-31 真机报障:`@` 命中一多,抽屉一直往上长)。
 *
 * 与上面那一族同一条理由守在产地上:CSS Modules 那份样式表没进过 jsdom,
 * `getComputedStyle(...).maxHeight` 在这台机器上恒等于空 —— 它答的是
 * 「jsdom 没有这条规则」。而这条报障的产地就是这三行 CSS,删掉任何一行都复发。
 *
 * 「选中项滚进视野」是**行为**,不在这里:Composer.test.tsx 里真按一下 ↑↓ 去验。
 * 两件事必须都在 —— 只封顶不滚,比不封顶更糟。
 */
describe('抽屉候选列表:封顶 + 自己滚 + 不把滚动传给身后', () => {
  const scroll = () => block('.pickScroll')

  /*
   * 09-05(§5.6):上限从「一个 token」变成「两个数取小」——
   * `min(--composer-drawer-max, 中央区高度的 40%)`。加的那一项是因为输入框浮起来
   * 之后抽屉往上长就会盖住正文,固定 320px 在矮窗上能把正文吃掉大半。
   * 断言跟着改成**两项都在**:少了前一项就没了绝对上限,少了后一项矮窗上就复发。
   * 「不是拍在样式表里的一个像素数」这条纪律一个字没松 —— 两项都是 var()。
   */
  it('列表区有上限:既有 token 与「中央区的 40%」取小,两项都不许拍成像素数', () => {
    expect(scroll()).toMatch(/max-height:\s*min\(/)
    expect(scroll()).toMatch(/var\(--composer-drawer-max\)/)
    expect(scroll()).toMatch(/calc\(var\(--center-h, 200vh\) \* 0\.4\)/)
  })

  it('超出照常滚:纵向 auto', () => {
    expect(scroll()).toMatch(/overflow-y:\s*auto/)
  })

  /* 仓判例(Select / Tabs / 目录 / 文件面):浮在正文上的一层,滚到头之后
   * 不把剩下的滚动量传给身后的聊天流。 */
  it('滚到头不把滚动链传给身后的聊天流', () => {
    expect(scroll()).toMatch(/overscroll-behavior:\s*contain/)
  })

  /*
   * 09-12 第二批推翻了这一族最后一条(从前它守「抽屉自己仍然是 grid 0fr↔1fr」)。
   * 上面那三条一个字没动 —— 它们守的是**模型抽屉那一列**,那位住户的高仍旧由
   * 右栏那张卡定,列表照旧封顶、照旧自己滚、照旧不把滚动链传给身后。
   * `@` / `/` 两位住户改吃固定框,它们的守卫在下面那一族。
   */
})

/**
 * ══ 抽屉:面板自己的第一格 + 固定高 + 只淡入(09-12 固定高 / 09-16 并入面板)══════
 *
 * 09-12 报障原话:「它太慢了,我能看到它先很短、再慢慢长出来;能不能直接看到一个
 * 固定长度、固定宽度的最终结果」,以及「会把内容往上顶,有时顶有时不顶」。
 * 09-16 报障:抽屉像一个独立的外层,面板为接住它改了形,焦点环上沿被削平
 * (正本 `docs/composer-unified-drawer-2026-09-16.md`)。
 *
 * 每一条守卫都对应一个可复发的改法:
 *   ① 一个外框 —— 有人给 `.drawer` 加回描边 / 圆角 / 底 / 影或绝对定位,
 *      或给 `.panel:has(.drawerOpen)` 加回改圆角 / 放开 overflow;
 *   ② 固定高 —— 有人把 `.drawerFixed` 的 height 改回 auto / max-height;
 *   ③ 高度零过渡 —— 有人顺手给 `.drawer` 加一条 height / grid-rows 过渡。
 * 「不推正文」换了产地:它现在靠 `--composer-h` 只量静止部分
 * (`content/__tests__/floating-composer-css.test.ts` 守量法)。
 *
 * 「真的不顶」「真的一帧到位」「真的一个外框」是**排版**,CSS 源文本说不出那句话:
 * 它们在真机门 `npm run gate:composer-drawer` 里量。两边必须都在。
 */
describe('抽屉是面板的第一格 · 固定高 · 只淡入', () => {
  const drawer = () => block('.drawer')

  it('① 抽屉没有自己的外框:不绝对定位、不画描边 / 圆角 / 底 / 影', () => {
    expect(drawer()).not.toMatch(/position:\s*absolute/)
    expect(drawer()).not.toMatch(/border(-radius)?:/)
    expect(drawer()).not.toMatch(/background:/)
    expect(drawer()).not.toMatch(/box-shadow:/)
    // 与静止部分只隔一条内分隔线。
    expect(block('.drawerOpen')).toMatch(/border-bottom:\s*var\(--bw-1\) solid var\(--line-1\)/)
  })

  it('① 的另一半:开着抽屉时面板只换材质,形一格不动', () => {
    const open = block('.panel:has(.drawerOpen)')
    expect(open).not.toMatch(/overflow/)
    expect(open).not.toMatch(/radius/)
    expect(open).not.toMatch(/border/)
    // 常态那句 `overflow: hidden` 把抽屉也剪进同一个圆角。
    expect(block('.panel')).toMatch(/overflow:\s*hidden/)
  })

  it('② `@` / `/` 两位住户的框是**固定高**:token 与矮窗夹子两项都在', () => {
    expect(block('.drawerFixed')).toMatch(
      /height:\s*min\(var\(--composer-drawer-h\), calc\(var\(--center-h, 200vh\) \* 0\.5\)\)/,
    )
    // 高度一路传到底,列表在框里铺满自己滚(否则框底下空一条填不满的带)。
    expect(block('.drawerFixed .drawerBody')).toMatch(/height:\s*100%/)
    expect(block('.drawerFixed .pickScroll')).toMatch(/height:\s*100%/)
    expect(block('.drawerFixed .pickScroll')).toMatch(/max-height:\s*none/)
  })

  it('③ 高度一个过渡都没有,出现那一下只淡入(起点由 @starting-style 给)', () => {
    expect(drawer()).not.toMatch(/transition:/)
    expect(drawer()).not.toMatch(/grid-template-rows/)
    expect(block('.drawerOpen')).toMatch(
      /transition:\s*opacity var\(--dur-drawer\) var\(--ease-out\)/,
    )
    expect(block('.drawerOpen')).not.toMatch(/height/)
    expect(css).toMatch(/@starting-style\s*\{\s*\.drawerOpen\s*\{\s*opacity:\s*0;/)
  })

  it('③ 的另一半:关着时不占高、立刻消失', () => {
    expect(drawer()).toMatch(/display:\s*none/)
    expect(block('.drawerOpen')).toMatch(/display:\s*block/)
  })

  it('换底不带过渡:整块换材质与抽屉出现落在同一帧', () => {
    expect(block('.panel')).not.toMatch(/transition:[^;]*background/)
  })
})

/**
 * 本体行的**两行布局**与药丸的**永不折行**(09-03 真机报障的产地)。
 *
 * 守在产地上读源文件的理由与本文件头部那一段逐字相同(CSS Modules 那份样式表
 * 没进过 jsdom),不再复述。这一族守的是两件事:
 *   ① 四件工具不再与会长高的文本同行 —— `.writeRow` 是竖排;
 *   ② 药丸永不换行,只截断 —— 律二(`docs/design/react-shell-squeeze-rules-2026-08.md`)。
 *
 * 「窄档下药丸真的只占一行」是**排版**,CSS 源文本说不出这句话:它在真机门
 * `npm run gate:squeeze` 的律二那一步里量。两件事必须都在 —— 这里守住有人把
 * 这几行删了,那里守住这几行真的管用。
 */
describe('本体行两行布局 + 药丸永不折行(09-03 报障的产地)', () => {
  it('.writeRow 是竖排:输入面独占上行,四件退到工具行', () => {
    expect(block('.writeRow')).toMatch(/flex-direction:\s*column/)
  })

  it('.modelPill 永不换行,而且真的缩得下去(min-width: 0 解开自动最小尺寸)', () => {
    expect(block('.modelPill')).toMatch(/white-space:\s*nowrap/)
    expect(block('.modelPill')).toMatch(/min-width:\s*0/)
  })

  it('.modelPillLabel 是截断的产地(text-overflow 只认块级容器里的行内文本)', () => {
    expect(block('.modelPillLabel')).toMatch(/text-overflow:\s*ellipsis/)
  })

  /*
   * ── 09-12 报障「补全命令后没有空格」的**产地** ────────────────────────
   * 草稿里那个空格一直都在(`ComposerInput.test.tsx` 逐条钉着它),看不见是因为
   * 缺省的 `white-space: normal` 把**行尾空白折叠掉了**。jsdom 量不出折叠,
   * 所以这条门守在源文本上;真机那一半在 `gate:composer-drawer` 的 ④
   * (量那个空格的 Range 宽度真的大于 0)。
   */
  it('.input 声明 white-space: pre-wrap —— 行尾那个空格看得见', () => {
    expect(block('.input')).toMatch(/white-space:\s*pre-wrap/)
  })

  it('.input 声明 min-width: 0 —— 长 URL 撑不宽这一行', () => {
    expect(block('.input')).toMatch(/min-width:\s*0/)
  })

  /* 律一的分工:工具行里唯一承担伸缩的是药丸,右半那两件一格都不让。 */
  it.each([
    ['.toolsRight', '圆环 + 发送那一半'],
    ['.sendBtn', '发送键'],
  ])('%s(%s)不弯腰:flex: none', (selector) => {
    expect(block(selector)).toMatch(/flex:\s*none/)
  })

  /* 药丸里也是一行一个弯腰件:名字截断,档位那一两个字一直看得见。 */
  it('.modelPillLevel 不弯腰、不换行 —— 窄下来先截名字,不先丢档位', () => {
    expect(block('.modelPillLevel')).toMatch(/flex:\s*none/)
    expect(block('.modelPillLevel')).toMatch(/white-space:\s*nowrap/)
  })
})

/**
 * 模型抽屉的两栏(09-05 庚,设计 §5.8;报障「列表独滚卡不滚」的 CSS 那一半)。
 *
 * 守在产地上的理由与本文件头部那一段逐字相同(CSS Modules 那份样式表没进过 jsdom)。
 * 「选另一行时列表这棵 DOM 不重挂」是**行为**,在 `Composer.test.tsx` 里按一下验;
 * 两件事必须都在 —— 这里守住有人把这几行删了,那里守住它们真的管用。
 */
describe('模型抽屉两栏:只有列表滚,卡不滚', () => {
  it('两栏容器不滚;列表滚在 .pickScroll 里,卡只在自己那一格超高时兜底滚', () => {
    expect(block('.pickCols')).not.toMatch(/overflow/)
    expect(block('.modelCard')).toMatch(/overflow-y:\s*auto/)
  })

  it('面板定高(09-17 报障「选模型时高度会变」):高是一个 token,矮窗夹一半', () => {
    expect(block('.pickCols')).toMatch(
      /height:\s*min\(var\(--composer-model-drawer-h\), calc\(var\(--center-h, 200vh\) \* 0\.5\)\)/,
    )
  })

  it('列表格是相对定位那一格,列表在里面 absolute 铺满 —— 行高由卡定', () => {
    expect(block('.pickListCell')).toMatch(/position:\s*relative/)
    expect(block('.pickListCell .pickScroll')).toMatch(/position:\s*absolute/)
    expect(block('.pickListCell .pickScroll')).toMatch(/inset:\s*0/)
  })

  it('框已定高,列表格不另设保底也不另设封顶(否则会在框里留一条填不满的带)', () => {
    expect(block('.pickListCell')).toMatch(/min-height:\s*0/)
    expect(block('.pickListCell .pickScroll')).toMatch(/max-height:\s*none/)
  })

  it('列表与卡之间一根发丝线(它是分栏线,不是滚动槽)', () => {
    expect(block('.pickListCol')).toMatch(/border-right:\s*1px solid var\(--line-1\)/)
  })

  it('滚动条走 token 皮肤、悬停才显形,而且留着槽位不横抖', () => {
    expect(block('.pickScroll')).toMatch(/scrollbar-gutter:\s*stable/)
    expect(block('.pickScroll::-webkit-scrollbar-thumb')).toMatch(/background:\s*transparent/)
    expect(block('.pickScroll:hover::-webkit-scrollbar-thumb')).toMatch(
      /background:\s*var\(--scrollbar-thumb\)/,
    )
    expect(block('.pickScroll:hover::-webkit-scrollbar-thumb:hover')).toMatch(
      /background:\s*var\(--scrollbar-thumb-hover\)/,
    )
  })

  /**
   * 窄档塌成一栏,卡折到列表**上方**(order 1 / 2)。
   *
   * `@container` 条件里写不了 var(),所以那个字面量与 `--composer-pick-two-col`
   * 是**同一事实的两处** —— 这一条把两处比一遍(与 ModelCatalog 那道门同一手法)。
   */
  it('两栏塌一栏的阈值与 token 对得上,而且卡折到列表上方', () => {
    const threshold = /@container composerDrawer \(max-width:\s*(\d+)px\)/.exec(css)?.[1]
    expect(threshold, '样式表里找不到那条容器查询').toBeTruthy()
    const tokens = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8')
    const token = /--composer-pick-two-col:\s*(\d+)px/.exec(tokens)?.[1]
    expect(token).toBe(threshold)
    const narrow = css.slice(css.indexOf('@container composerDrawer'))
    expect(narrow).toMatch(/\.modelCard\s*\{[^}]*order:\s*1/)
    expect(narrow).toMatch(/\.pickListCol\s*\{[^}]*order:\s*2/)
  })

  it('容器是抽屉自己(不是窗口)—— 输入框在浮窗 / 窄舞台里各有各的宽', () => {
    expect(block('.drawerBody')).toMatch(/container:\s*composerDrawer \/ inline-size/)
  })
})

/**
 * 命令行的三格与参数幽灵占位(09-12,用户报障「命令无提示」的产地)。
 *
 * 同一条理由守在源文本上(CSS Modules 那份样式表没进过 jsdom)。
 * 「窄档里用法真的不见了」是**排版**,在真机门 `gate:composer-drawer` 的窄容器
 * 那一趟里量 —— 两件事必须都在。
 */
describe('命令行三格 + 参数幽灵占位(09-12)', () => {
  it('挤压律一:弯腰的是说明,名字与用法都不弯腰', () => {
    expect(block('.pickDesc')).toMatch(/flex:\s*1 1 auto/)
    expect(block('.pickDesc')).toMatch(/text-overflow:\s*ellipsis/)
    // 律二:结构行只截断不换行。
    expect(block('.pickDesc')).toMatch(/white-space:\s*nowrap/)
    expect(block('.pickName')).toMatch(/flex:\s*none/)
    expect(block('.pickUsage')).toMatch(/flex:\s*none/)
  })

  it('窄档收掉用法(与两栏塌一栏同一个阈值,那个数只有一处来历)', () => {
    const at = css.indexOf('@container composerDrawer (max-width: 448px)')
    const second = css.indexOf('@container composerDrawer (max-width: 448px)', at + 1)
    expect(second).toBeGreaterThan(at)
    const block448 = css.slice(second, css.indexOf('\n}', second))
    expect(block448).toMatch(/\.pickUsage/)
    expect(block448).toMatch(/display:\s*none/)
  })

  it('幽灵占位点不中、选不中 —— 它是画出来的一句提示,不是能被点中的东西', () => {
    expect(block('.argGhost')).toMatch(/pointer-events:\s*none/)
    expect(block('.argGhost')).toMatch(/user-select:\s*none/)
    // 颜色不能比占位符重:重一点就会被读成「已经输入了」。
    expect(block('.argGhost')).toMatch(/color:\s*var\(--text-4\)/)
  })
})
