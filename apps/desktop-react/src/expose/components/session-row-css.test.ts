import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * 09-04 用户报:钉在边架(320px)时标题只剩「屏幕使…」三个字。病根是悬停动作
 * 两颗钮**常驻在 flex 流里**,静息时也占 ~56px;改成浮在行尾之上(绝对定位),
 * 标题在静息态拿回整行。
 *
 * ── 09-12 换配方:显形不再靠时间列淡出,靠动作层自己那条渐变面纱 ────────────
 * 旧配方(`.row:hover .time { opacity: 0 }`)正是 09-12 报的那条真 bug 的病根:
 * `opacity < 1` 让时间与项目签各自成了**独立层叠上下文**,而它们的 DOM 顺序
 * 排在动作之后 —— 于是两块透明的盒子画在钮**上面**并且照样接鼠标(真机:指针
 * 停在眼睛正中,`elementFromPoint` 答 `SPAN._time`;点眼睛进了会话)。
 * 新配方三条,逐条在这里钉住:动作层**带 z-index**、动作层**不在流里**、
 * 那条「时间淡出」的规则**整条不在了**(病根删了,不是绕开)。
 *
 * jsdom 不排版,这几条守在样式表源文本上(剥注释后判 —— 病历文本里写着那些
 * 被否决的旧写法,不剥会读到注释里那一份)。
 */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const css = strip(readFileSync(path.join(__dirname, 'SessionRow.module.css'), 'utf-8'))
const block = (selector: string) => css.slice(css.indexOf(selector)).split('}')[0]

describe('SessionRow 悬停动作不占行内空间', () => {
  it('.actions 绝对定位、.row 是它的定位上下文', () => {
    expect(block('.actions {')).toMatch(/position:\s*absolute/)
    expect(block('.row {')).toMatch(/position:\s*relative/)
  })

  it('动作层**立在时间 / 项目签之上**(z-index + 不占流)—— 09-12 那条 bug 的修法', () => {
    const actions = block('.actions {')
    expect(actions).toMatch(/z-index:\s*1\b/)
    expect(actions).not.toMatch(/margin|flex:/)
  })

  it('**没有**「时间 / 项目签淡出」那条规则了 —— 病根是它,删掉而不是绕开', () => {
    expect(css).not.toMatch(/\.row:hover \.time/)
    expect(css).not.toMatch(/\.row:hover \.project/)
    // 那两格也不许自己带 opacity 过渡(它们从前为淡出而有)。
    expect(block('.time {')).not.toMatch(/opacity/)
  })

  it('显形靠自己那条渐变面纱,两档薄膜各一条,右端压着宿主那层不透明的面', () => {
    const actions = block('.actions {')
    // 上层 = 薄膜,下层 = 不透明的宿主面:半透明的墨单独收不掉字。
    expect(actions).toMatch(/var\(--st-hover\)\s*var\(--expose-veil-w\)/)
    expect(actions).toMatch(/var\(--surface-host\)\s*var\(--expose-veil-w\)/)
    // 当前会话那一行换第二档薄膜(两档,与行的底色同源)。
    expect(css).toMatch(
      /\.row\[aria-selected='true'\] \.actions[\s\S]*?var\(--st-sel-hover\)\s*var\(--expose-veil-w\)/,
    )
    // 面纱有多长 = 动作层往左伸多远:一个数两处用。
    expect(actions).toMatch(/padding-inline-start:\s*var\(--expose-veil-w\)/)
  })

  it('菜单开着时 ⋯ 保持显形(否则鼠标一移进菜单那颗钮当场消失)', () => {
    expect(css).toMatch(/\.row\[data-menu-open='true'\] \.actions/)
  })

  /*
   * 字形是**条件渲染**的(09-12 拍板:普通聊天不预留那 16px),而正本 §3.2 说
   * 总览形「变的只有三件」—— 起笔线不在其列。容器查询改不了 React 画不画那个
   * `<div>`,所以宽档用一格外边距把缺席那一格补回来:**零 DOM 节点,对齐照旧**。
   * 侧栏形不补,那才是这次翻面换来的 20px。
   */
  it('总览形把缺席的字形用一格外边距补回来;侧栏形**不补**', () => {
    expect(css).toMatch(
      /@container expose \(min-width: 761px\)[\s\S]*\.title:first-child \{\s*margin-inline-start:\s*calc\(var\(--expose-glyph-w\) \+ var\(--sp-2\)\)/,
    )
    // 基准规则(侧栏形)里不许有这一条 —— 补了就把那 20px 又还回去了。
    const base = css.slice(0, css.indexOf('@container'))
    expect(base).not.toMatch(/\.title:first-child/)
  })
})
