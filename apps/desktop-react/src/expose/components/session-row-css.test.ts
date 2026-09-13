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
   * ── 09-13 A5:那格补偿外边距**失去了对象**(对齐律 §8 第 2 / 3 条)──────────
   * 09-12 那一版字形是条件渲染的,总览形拿 `.title:first-child` 的一格外边距
   * 把缺席那一列补回来。今天每一行都有字形列,`.title` 再也不是行的第一个元素
   * 子节点 —— 那条规则恒不命中,所以整条删掉(留一条永远匹配不上的规则,
   * 下一个人会以为这里还有一档条件渲染)。
   *
   * 这条断言是**反向**的:它守的是「不许把它加回来」。加回来不会有任何可见
   * 变化(选择器不命中),却会让读代码的人得到一个假的结构事实。
   */
  it('`.title:first-child` 那格补偿**整条不在了**(每一行都有字形列,它没有对象)', () => {
    expect(css).not.toMatch(/\.title:first-child/)
  })

  /* 每一行都有那一格,所以字形列是**定宽**的(16 = --expose-glyph-w,中心落在
     红灯中心那条线上);14 宽的列会让中心偏 1px(对齐律 §8 第 2 条)。 */
  it('字形列定宽 --expose-glyph-w,图标 --expose-row-glyph 居中', () => {
    const glyph = block('.glyph {')
    expect(glyph).toMatch(/width:\s*var\(--expose-glyph-w\)/)
    expect(glyph).toMatch(/height:\s*var\(--expose-row-glyph\)/)
    expect(glyph).toMatch(/justify-content:\s*center/)
  })

  /* 普通聊天那一枚比别人淡一档:它是「这一行是什么」信息量为零的缺省档,
     同样重的墨会让一屏 400 行读起来全是图标(判词在 CSS 上)。 */
  it('`none` 那一档的墨是 --text-4(按 data-row-glyph 的值选,不是第二个类名)', () => {
    expect(css).toMatch(/\.glyph\[data-row-glyph='none'\]\s*\{\s*color:\s*var\(--text-4\)/)
  })

  /*
   * ── A2:改名那一格吃与标题**同一条**弯腰声明 ────────────────────────────
   * 它顶替标题站在同一个位置上,所以挤压律一(一行一个弯腰件)对它照样成立:
   * 按内容宽度撑出去会把行尾那颗 ⋯ 推出架子。
   *
   * **这一条为什么是源文本断言而不是几何断言(反证纪律)**:`gate:sessions` ⑦b
   * 真机量过 —— 240px 的架子里,拆掉这两行之后框宽仍是 142px / 右缘 185,
   * 与不拆逐字相同。原因是那一档里框本来就在**收缩**区间(内容基准已经比可用
   * 宽度大),`flex-shrink` 的缺省值 1 把两种写法收到同一个数上。差别只在**有
   * 余量**的那一档(总览形 ≥761):声明了才长满那一行,不声明就停在内在宽度。
   * 真机那一条(不越过行右缘)照旧留着 —— 它守的是另一半(不许撑出去);
   * 这一条守的是「长满」那一半,而它只有在这儿判得出来。
   */
  it('.rename 是这一行的弯腰件(flex + min-width: 0),与 .title 同一条', () => {
    const rename = block('.rename {')
    expect(rename).toMatch(/flex:\s*1 1 auto/)
    expect(rename).toMatch(/min-width:\s*0/)
    // 与标题那一格逐字同形 —— 两者站在同一个位置上,不该有两套弯腰配方。
    const title = block('.title {')
    expect(title).toMatch(/flex:\s*1 1 auto/)
    expect(title).toMatch(/min-width:\s*0/)
  })
})
