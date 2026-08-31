import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { render, screen } from '@testing-library/react'
import { TitleBar } from '../TitleBar'

/**
 * 自绘顶带(09-01「不要 macOS 自己的刘海」)。
 *
 * 这里钉住的全是**拖拽判例**能被静态查到的那一半 —— 手感那一半(真拖窗动没动、
 * 点控件触不触发拖拽)由 CDP + CGEvent 真机门量,jsdom 一格也量不出来:
 * `-webkit-app-region` 在浏览器里没有任何可观察的计算后果。
 *
 * 所以这里查两件事:
 *  ① **结构**:让位块必须是拖拽带**同一分支的子孙** —— `no-drag` 只在这种位置
 *     才生效,摆到旁边去的 no-drag 是个不生效的安慰剂;
 *  ② **声明**:那两句 app-region 真的写在了各自的块里(改样式时被顺手删掉就红)。
 *
 * 顺带钉住盖的那一句 `position: fixed`:09-01 盖改成盖满整扇窗,fixed 与「挂在壳
 * 根上」是同一件事的两半,退回 absolute 就等于退回「只接管内容栏」。
 */

const componentsDir = path.resolve(__dirname, '..')
/** 病历文本会让断言自红(本仓的 CSS 注释里常引用写法),读源文本的门先剥注释。 */
const cssCode = (name: string) =>
  readFileSync(path.join(componentsDir, name), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')

/** 取一个类的声明块正文(极简切分:本仓 CSS Modules 无嵌套语法)。 */
function block(css: string, selector: string): string {
  const match = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)
  return match ? match[1] : ''
}

describe('自绘顶带', () => {
  it('红绿灯让位块是拖拽带的子孙 —— no-drag 只在同一分支上才生效', () => {
    render(<TitleBar />)
    const bar = screen.getByTestId('titlebar')
    const traffic = screen.getByTestId('titlebar-traffic')
    expect(bar.contains(traffic)).toBe(true)
    expect(traffic.parentElement).toBe(bar)
  })

  it('整条带对读屏软件隐身:它是窗口管理器的把手,不是页面内容', () => {
    render(<TitleBar />)
    expect(screen.getByTestId('titlebar').getAttribute('aria-hidden')).toBe('true')
  })

  it('带是 drag、让位块是 no-drag(两句都在各自的块里)', () => {
    const css = cssCode('TitleBar.module.css')
    expect(block(css, '.bar')).toMatch(/-webkit-app-region:\s*drag/)
    expect(block(css, '.traffic')).toMatch(/-webkit-app-region:\s*no-drag/)
  })

  it('带的高度吃 token,不写字面 px(四轴·token 纪律)', () => {
    expect(block(cssCode('TitleBar.module.css'), '.bar')).toMatch(
      /height:\s*var\(--titlebar-h\)/,
    )
  })
})

describe('盖满整扇窗', () => {
  it('盖是 fixed —— 参考系是视口,不是内容栏', () => {
    expect(block(cssCode('CoverLayer.module.css'), '.cover')).toMatch(/position:\s*fixed/)
  })

  it('盖的底铺满,但面让开一整条顶带 —— 红绿灯不受 z-index 管,会压在面头上', () => {
    const cover = block(cssCode('CoverLayer.module.css'), '.cover')
    expect(cover).toMatch(/padding:\s*var\(--titlebar-h\)/)
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
