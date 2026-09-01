import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { render, screen } from '@testing-library/react'
import { TopBar } from '../TopBar'

/**
 * 顶栏**兼作窗口顶带**(09-01 用户看真机后的裁定:「header 与红绿灯放同一行,
 * 红绿灯稍往下来点」)。这个文件顶替了上一版的 `titlebar.test.tsx` —— 那条
 * 独立的 28px 空带连同它的组件、样式表、token 一起退役了。
 *
 * 这里钉住的是**拖拽判例里能被静态查到的那一半**。手感那一半(真拖窗动没动)
 * 只有 CGEvent 量得出来:`-webkit-app-region` 在浏览器里没有任何可观察的运行后果,
 * 而 CDP 注入的鼠标事件根本到不了窗口管理器那一层。
 *
 *  ① **结构**:让位块必须是拖拽带**同一分支的子孙** —— no-drag 只在这种位置
 *     才生效,摆到旁边去的 no-drag 是个不生效的安慰剂;
 *  ② **内容盒**:`.bar` 不许有左内衬 —— app-region 只按内容盒算,靠 padding 让位
 *     等于「让出来的地方仍然可拖」,而那一段恰恰是最不该拖的(红绿灯在那儿);
 *  ③ **逐件 no-drag**:这条带上每一件可点的东西都要自己声明,漏一件的表现是
 *     「点它变成拖窗」,且**静默**——没有报错、没有 lint、只有用户来报。
 *
 * 顺带钉住盖的两句:fixed + 让开一条顶栏(红绿灯不受 z-index 管,会压在面头上)。
 */

const componentsDir = path.resolve(__dirname, '..')
/** 病历文本会让断言自红(本仓 CSS 注释里常引用写法),读源文本的门先剥注释。 */
const cssCode = (name: string) =>
  readFileSync(path.join(componentsDir, name), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')

/** 取一个类的声明块正文(极简切分:本仓 CSS Modules 无嵌套语法)。 */
function block(css: string, selector: string): string {
  const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)
  return match ? match[1] : ''
}

describe('顶栏兼顶带:拖拽区', () => {
  it('红绿灯让位块是拖拽带的子孙 —— no-drag 只在同一分支上才生效', () => {
    render(<TopBar />)
    const bar = screen.getByTestId('topbar')
    const traffic = screen.getByTestId('topbar-traffic')
    expect(traffic.parentElement).toBe(bar)
  })

  it('让位块对读屏软件隐身:它是给原生控件腾的地方,不是页面内容', () => {
    render(<TopBar />)
    expect(screen.getByTestId('topbar-traffic').getAttribute('aria-hidden')).toBe('true')
  })

  it('带是 drag,带上每一件可点的都是 no-drag(漏一件=点它变拖窗,且静默)', () => {
    const css = cssCode('TopBar.module.css')
    expect(block(css, '.bar')).toMatch(/-webkit-app-region:\s*drag/)
    for (const sel of ['.traffic', '.titleBtn', '.trailing']) {
      expect(block(css, sel), `${sel} 少了 no-drag`).toMatch(/-webkit-app-region:\s*no-drag/)
    }
  })

  it('带没有左内衬:让位靠真元素,不靠 padding(app-region 只算内容盒)', () => {
    const bar = block(cssCode('TopBar.module.css'), '.bar')
    // `padding: 0 var(--sp-4) 0 0` —— 第四个值(左)必须是 0。
    const padding = /padding:\s*([^;]+);/.exec(bar)?.[1].trim().split(/\s+/) ?? []
    expect(padding).toHaveLength(4)
    expect(padding[3]).toBe('0')
  })

  it('让位宽吃 token,不写字面 px(四轴·token 纪律)', () => {
    expect(block(cssCode('TopBar.module.css'), '.traffic')).toMatch(
      /width:\s*var\(--titlebar-traffic-w\)/,
    )
  })

  it('让位块 flex: none —— 被压缩就等于标题盖到灯上', () => {
    expect(block(cssCode('TopBar.module.css'), '.traffic')).toMatch(/flex:\s*none/)
  })

  it('让位块拉满带高 —— no-drag 摘的是面积,高 0 等于什么都没摘', () => {
    // 真机读数 `traffic {w:80,h:0}` 才逼出来的一条:`.bar` 是 align-items:center,
    // 这块元素没有内容,不拉伸就是 80×0,那 80px 照样是拖拽把手。
    expect(block(cssCode('TopBar.module.css'), '.traffic')).toMatch(/align-self:\s*stretch/)
  })
})

describe('盖满整扇窗', () => {
  it('盖是 fixed —— 参考系是视口,不是内容栏', () => {
    expect(block(cssCode('CoverLayer.module.css'), '.cover')).toMatch(/position:\s*fixed/)
  })

  it('盖的底铺满,但面让开一条顶栏 —— 红绿灯不受 z-index 管,会压在面头上', () => {
    const cover = block(cssCode('CoverLayer.module.css'), '.cover')
    expect(cover).toMatch(/padding:\s*var\(--topbar-h\)/)
    // 底本身不许跟着让:让位是 padding(里面那块面的事),inset 仍然是整扇窗。
    expect(cover).toMatch(/inset:\s*0/)
  })

  it('盖挂在壳的根上(在 </main> 之后),不再挂在 .center 里', () => {
    const shell = readFileSync(path.join(componentsDir, 'AppShell.tsx'), 'utf-8')
    const mainEnd = shell.indexOf('</main>')
    const cover = shell.indexOf('<CoverLayer />')
    expect(mainEnd).toBeGreaterThan(0)
    expect(cover).toBeGreaterThan(mainEnd)
  })
})

describe('独立顶带已退役', () => {
  it('壳里第一件就是顶栏 —— 没有第二条带,内容从 y=0 起', () => {
    const shell = readFileSync(path.join(componentsDir, 'AppShell.tsx'), 'utf-8')
    // 注释里会**提到**它退役了,所以查的是有没有真的引用/挂载。
    const code = shell.replace(/\/\*[\s\S]*?\*\/|\{\/\*[\s\S]*?\*\/\}/g, '')
    expect(code).not.toMatch(/<TitleBar\b/)
    expect(code).not.toMatch(/from '\.\/TitleBar'/)
  })
})
