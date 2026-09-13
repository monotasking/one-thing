import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Dock 让位量那条式子**声明在哪个元素上**(09-13 晚第五刀的守卫)。
 *
 * 这不是风格题,是自定义属性的求值规则:**`var()` 在声明那条 calc 的元素上代入,
 * 不在读它的元素上**。四格式子从前写在 `tokens.css` 的 `:root`,于是
 * `--dock-thick` 在那一层就把 `--dock-tile` 代成了 44px,子元素继承到的是
 * `calc(44px + …)` —— 外壳后来在 `.shell` 上把 `--dock-tile` 换成 36 / 52
 * 一个字都影响不到它。真机后果:四条边 × 三档,`.main` 那一边的 padding 恒为 86,
 * sm 档条外留白 20 / md 12 / lg 只剩 4(lg 放大后的瓦探出 9.2、压进内容 5)。
 * 这条病从 08-31 立让位那天起活了两周,**而 tokens.css 的注释一直写着
 * 「预留自己跟着走」** —— 一句没兑现的话,正是这条静态断言要替掉的东西。
 *
 * 判据分两半,缺一半都能被绕过去:
 *  ① `tokens.css` 的 `:root` 里**没有**这四格(病根回来的第一种形);
 *  ② 四格都在 `AppShell.module.css` 的 `.shell` 里,而 `.reserveSm` / `.reserveLg`
 *     覆写的是**同一个元素**(病根回来的第二种形:挪了地方但挪到了别的元素上)。
 * 真机那一半在 `gate:dock` 的 ⑩(四条边 × 三档,条内侧到内容边恒为 12.00)。
 */

/** 病历文本会让断言自红(本仓 CSS 注释里常引用旧写法),读源文本的门先剥注释。 */
const cssCode = (file: string) =>
  readFileSync(path.resolve(__dirname, file), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')

/** 取一个选择器的声明块正文(极简切分:本仓 CSS Modules 无嵌套语法)。 */
function block(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)
  return match ? match[1] : ''
}

const tokens = cssCode('../../styles/tokens.css')
const shellCss = cssCode('../AppShell.module.css')

const FORMULA_VARS = ['--dock-tile', '--dock-thick', '--dock-reserve-h', '--dock-reserve-v']

describe('Dock 让位量:式子与被覆写的变量必须同元素', () => {
  it('tokens.css 的 :root 里一格都没有 —— 那里只放数,不放依赖覆写的 calc', () => {
    const root = block(tokens, ':root')
    expect(root).not.toBe('')
    for (const name of FORMULA_VARS) {
      expect(root).not.toMatch(new RegExp(`^\\s*${name}\\s*:`, 'm'))
    }
  })

  it('数还在 tokens.css(搬的是式子,不是把 px 搬进组件样式表)', () => {
    for (const name of ['--tile-size-sm', '--tile-size-md', '--tile-size-lg', '--dock-pad-y']) {
      expect(block(tokens, ':root')).toMatch(new RegExp(`^\\s*${name}\\s*:\\s*\\d`, 'm'))
    }
  })

  it('四格式子都声明在 .shell 上', () => {
    const shell = block(shellCss, '.shell')
    expect(shell).not.toBe('')
    for (const name of FORMULA_VARS) {
      expect(shell).toMatch(new RegExp(`^\\s*${name}\\s*:`, 'm'))
    }
    // 式子本身:条厚恒吃 --dock-pad-y(厚度那一维),预留 = 条厚 + 两侧各 --sp-3。
    expect(shell).toMatch(
      /--dock-thick:\s*calc\(var\(--dock-tile\)\s*\+\s*var\(--dock-pad-y\)\s*\*\s*2\s*\+\s*var\(--bw-1\)\s*\*\s*2\)/,
    )
    for (const name of ['--dock-reserve-h', '--dock-reserve-v']) {
      expect(shell).toMatch(
        new RegExp(`${name}:\\s*calc\\(var\\(--dock-thick\\)\\s*\\+\\s*var\\(--sp-3\\)\\s*\\*\\s*2\\)`),
      )
    }
  })

  it('大小档覆写的是**同一个元素**(.reserveSm / .reserveLg 是类,与 .shell 同挂在壳根上)', () => {
    expect(block(shellCss, '.reserveSm')).toMatch(/--dock-tile:\s*var\(--tile-size-sm\)/)
    expect(block(shellCss, '.reserveLg')).toMatch(/--dock-tile:\s*var\(--tile-size-lg\)/)
    // 覆写不许写成后代选择器 —— 那又是另一个元素,代入照样落空。
    expect(shellCss).not.toMatch(/\.shell\s+\.reserve(Sm|Lg)\s*\{/)
  })
})
