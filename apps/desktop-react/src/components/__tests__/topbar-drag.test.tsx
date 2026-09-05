import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { render, screen } from '@testing-library/react'
import { TopBar } from '../TopBar'
import { AppShell } from '../AppShell'

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
 * 顺带钉住全屏层那几句(W2:它顶替了「盖」)——fixed、不让顶栏(它自己有一条
 * 28px 檐带)、以及 `--topbar-lead` 三档提到壳根之后「两条带子读同一个变量」。
 */

const componentsDir = path.resolve(__dirname, '..')

/**
 * 壳根那一格(W2:红绿灯让位的两条判据从 `.bar` 提到了这里)。
 * 取的是 `data-focus-scope="root"` —— 那是响应链的根,也就是 `.shell` 本身。
 */
const shellRoot = (): HTMLElement => {
  const el = document.querySelector('[data-focus-scope="root"]')
  if (!(el instanceof HTMLElement)) throw new Error('壳根没挂出来')
  return el
}
/** 病历文本会让断言自红(本仓 CSS 注释里常引用写法),读源文本的门先剥注释。 */
const cssCode = (name: string) =>
  readFileSync(path.join(componentsDir, name), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * 取一个选择器的声明块正文(极简切分:本仓 CSS Modules 无嵌套语法)。
 * 选择器整体转义 —— 属性选择器里的 `[` `]` 在正则里是字符类,只在前面补一个
 * 反斜杠(旧写法)会把 `.bar[data-fullscreen='true']` 编成一个永远匹配不上的式子,
 * 而 `block()` 匹配不上时返回空串,断言会以「这一句没写」的面目失败 —— 假红。
 */
function block(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)
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
    for (const sel of ['.traffic', '.trailing']) {
      expect(block(css, sel), `${sel} 少了 no-drag`).toMatch(/-webkit-app-region:\s*no-drag/)
    }
    /*
     * W1-b:会话名钮退役,它的位子换成了**中央区各片叶的标签组**(设计 §2.2 D 稿)。
     * 那一组住在另一份样式表里(`workbench/TopBarTabs.module.css`),但它是这条
     * 拖拽带的子孙,所以那一句 no-drag 归这条判例管 —— 少了它,点标签 = 拖窗。
     *
     * **落点是 tab 自己,不是那一组**:组铺满整段跨度,tab 只占左边一小截;
     * 写在组上等于把「组里剩下的空白仍是拖窗区」整条抹掉(真机门当场抓到过)。
     */
    const tabsCss = readFileSync(
      path.resolve(componentsDir, '../workbench/TopBarTabs.module.css'),
      'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(
      block(tabsCss, ".group [data-pane-chrome] [role='tab']"),
      'tab 少了 no-drag',
    ).toMatch(/-webkit-app-region:\s*no-drag/)
    /*
     * 而**带子与那一组都不许**声明 no-drag:红绿灯那 80px 与右端动作组之外的空白
     * 仍然要能拖窗(设计 §2.2 原话)。顺手在这两层写一句,这条带就再也拖不动了
     * —— 而且屏幕上一个像素都看不出来。
     */
    expect(block(tabsCss, '.band')).not.toMatch(/-webkit-app-region/)
    expect(block(tabsCss, '.group')).not.toMatch(/-webkit-app-region/)
  })

  it('标签组的 DOM 留在带子里 —— portal 出去 = 静默破拖拽区(坑 ①)', () => {
    render(<TopBar />)
    const bar = screen.getByTestId('topbar')
    const band = screen.getByTestId('topbar-tabs')
    // `no-drag` 只在 drag 元素**同一分支的子孙**上才生效。portal 到 body 之后
    // 那句声明还在、屏幕上一模一样,拖拽却当场破 —— 静态查得到的只有这一句。
    expect(bar.contains(band)).toBe(true)
    expect(bar.contains(screen.getByTestId('topbar-trailing'))).toBe(true)
  })

  it('带没有左内衬:让位靠真元素,不靠 padding(app-region 只算内容盒)', () => {
    const bar = block(cssCode('TopBar.module.css'), '.bar')
    // `padding: 0 var(--sp-4) 0 0` —— 第四个值(左)必须是 0。
    const padding = /padding:\s*([^;]+);/.exec(bar)?.[1].trim().split(/\s+/) ?? []
    expect(padding).toHaveLength(4)
    expect(padding[3]).toBe('0')
  })

  it('让位宽吃 token,不写字面 px(四轴·token 纪律)', () => {
    /*
     * ── W2:`--topbar-lead` 三档的产地提到了**壳根** ────────────────────────
     * 它有了第二个消费者(全屏层那条 28px 檐带),而那一层挂在壳的根上、
     * 根本不是 `.bar` 的后代 —— 定义留在 `.bar` 上它就读不到(宽度塌成 0)。
     * 所以这一条从此**两头各问一句**:壳根定义、两条带子只消费。
     */
    expect(block(cssCode('TopBar.module.css'), '.traffic')).toMatch(
      /width:\s*var\(--topbar-lead\)/,
    )
    expect(block(cssCode('FullLayer.module.css'), '.lead')).toMatch(
      /width:\s*var\(--topbar-lead\)/,
    )
    const shellCss = cssCode('AppShell.module.css')
    expect(block(shellCss, '.shell')).toMatch(/--topbar-lead:\s*var\(--titlebar-traffic-w\)/)
    expect(block(shellCss, ".shell[data-host-fullscreen='true']")).toMatch(
      /--topbar-lead:\s*var\(--sp-4\)/,
    )
  })

  it('这台上没有灯(Windows / Linux / 浏览器壳)→ 让位归 0(W1-b,设计 §2.2)', () => {
    expect(block(cssCode('AppShell.module.css'), ".shell[data-host-traffic='none']")).toMatch(
      /--topbar-lead:\s*0px/,
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

describe('让位跟着红绿灯走(W2:那两格属性搬到了壳根)', () => {
  it('宿主说不在全屏 → 壳根不挂 data-host-fullscreen(让位是 80 那一档)', () => {
    render(<AppShell />)
    // jsdom 里没有 onethingHost,useHostFullScreen 诚实答 false —— 这正是
    // 「浏览器里没有原生全屏,也就没有会消失的灯」那一格。
    expect(shellRoot().hasAttribute('data-host-fullscreen')).toBe(false)
    // 同一台上「有没有灯」是**另一格**判据:没有宿主 = 浏览器壳 = 没有灯。
    expect(shellRoot().getAttribute('data-host-traffic')).toBe('none')
  })

  it('宿主报 darwin → 有灯,让位是 80 那一档(判据问宿主,不猜 UA)', () => {
    ;(window as unknown as { onethingHost?: unknown }).onethingHost = { platform: 'darwin' }
    try {
      render(<AppShell />)
      expect(shellRoot().hasAttribute('data-host-traffic')).toBe(false)
    } finally {
      delete (window as unknown as { onethingHost?: unknown }).onethingHost
    }
  })

  it('宿主报 win32 → 系统边框,壳里没有灯', () => {
    ;(window as unknown as { onethingHost?: unknown }).onethingHost = { platform: 'win32' }
    try {
      render(<AppShell />)
      expect(shellRoot().getAttribute('data-host-traffic')).toBe('none')
    } finally {
      delete (window as unknown as { onethingHost?: unknown }).onethingHost
    }
  })

  it('宿主推来全屏 → 壳根挂上 data-host-fullscreen(让位收到 --sp-4)', async () => {
    const handlers: ((v: boolean) => void)[] = []
    ;(window as unknown as { onethingHost?: unknown }).onethingHost = {
      onFullScreenChange: (h: (v: boolean) => void) => {
        handlers.push(h)
        return () => { handlers.splice(handlers.indexOf(h), 1) }
      },
    }
    try {
      render(<AppShell />)
      expect(handlers).toHaveLength(1)
      const { act } = await import('@testing-library/react')
      act(() => handlers[0](true))
      expect(shellRoot().getAttribute('data-host-fullscreen')).toBe('true')
      act(() => handlers[0](false))
      expect(shellRoot().hasAttribute('data-host-fullscreen')).toBe(false)
    } finally {
      delete (window as unknown as { onethingHost?: unknown }).onethingHost
    }
  })

  it('宽度过渡吃 --dur(动效档 none 会把它变直切),不写字面时长', () => {
    const traffic = block(cssCode('TopBar.module.css'), '.traffic')
    expect(traffic).toMatch(/transition:\s*width\s+var\(--dur\)/)
    expect(traffic).not.toMatch(/\d+m?s\b/)
  })
})

describe('铺满整扇窗:真全屏(W2 —— 「盖」这一档已退役)', () => {
  it('全屏层是 fixed —— 参考系是视口,不是内容栏', () => {
    expect(block(cssCode('FullLayer.module.css'), '.full')).toMatch(/position:\s*fixed/)
  })

  it('它铺满整扇窗、**不让顶栏**:顶上那 28px 是它自己的檐带,不是让位', () => {
    const full = block(cssCode('FullLayer.module.css'), '.full')
    expect(full).toMatch(/inset:\s*0/)
    // 「盖」当年让出 `--topbar-h` 是因为它压不过原生红绿灯;全屏自己画一条檐带,
    // 灯落在那条带子上(让位由 `--topbar-lead` 那一格给),所以整层不让。
    expect(full).not.toMatch(/padding/)
    expect(block(cssCode('FullLayer.module.css'), '.strip')).toMatch(
      /height:\s*var\(--full-strip-h\)/,
    )
  })

  it('**层序推翻了「盖」那一档**:z 读 --z-full,而 --z-cover 全仓已无产地', () => {
    expect(block(cssCode('FullLayer.module.css'), '.full')).toMatch(/z-index:\s*var\(--z-full\)/)
    // 读样式表源文本的门**先剥注释**(本仓那条法):病历文本里满是 `--z-cover`
    // 这样的旧名字,不剥的话这一条会以「它还在」的面目假红。
    const tokens = readFileSync(
      path.join(componentsDir, '..', 'styles', 'tokens.css'),
      'utf-8',
    ).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(tokens).toMatch(/--z-full:\s*550/)
    expect(tokens).not.toMatch(/--z-cover/)
  })

  it('全屏层挂在壳的根上(在 </main> 之后)', () => {
    const shell = readFileSync(path.join(componentsDir, 'AppShell.tsx'), 'utf-8')
    const mainEnd = shell.indexOf('</main>')
    const full = shell.indexOf('<FullLayer />')
    expect(mainEnd).toBeGreaterThan(0)
    expect(full).toBeGreaterThan(mainEnd)
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
