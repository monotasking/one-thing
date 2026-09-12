import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pxOf, terminalFaceFrom } from '../theme'

/**
 * **终端配色是从 CSS 变量现算的**(T1)。这一组守两件事:
 *  ① 推导本身(读不到的格子**不填**,而不是兑一个);
 *  ② 那些变量名在 `styles/palette.css` 里真的有产地 —— 否则这只文件就是在
 *     读一串永远为空的名字,而屏幕会静悄悄地用 xterm 的缺省色。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const paletteCss = readFileSync(path.resolve(here, '../../../styles/palette.css'), 'utf-8')

/** 读样式表源文本的门**先剥注释**(施工纪律:病历文本会让断言自红)。 */
const paletteBody = paletteCss.replace(/\/\*[\s\S]*?\*\//g, '')

const TABLE: Record<string, string> = {
  '--term-bg': '#111111',
  '--term-fg': '#eeeeee',
  '--term-cursor': '#ff00ff',
  '--term-selection': 'rgba(1, 2, 3, 0.4)',
  '--term-red': '#ff0000',
  '--font-mono': "'JetBrains Mono', monospace",
  '--fs-meta': ' 12px ',
}

describe('推导', () => {
  it('按表取色,字面与字号各成一格', () => {
    const face = terminalFaceFrom((name) => TABLE[name] ?? '')
    expect(face.theme.background).toBe('#111111')
    expect(face.theme.foreground).toBe('#eeeeee')
    expect(face.theme.cursor).toBe('#ff00ff')
    expect(face.theme.selectionBackground).toBe('rgba(1, 2, 3, 0.4)')
    expect(face.theme.red).toBe('#ff0000')
    expect(face.fontFamily).toBe("'JetBrains Mono', monospace")
    expect(face.fontSize).toBe(12)
  })

  it('**读不到的那一格不填**(空串塞进 ITheme 会让 xterm 当颜色解析)', () => {
    const face = terminalFaceFrom((name) => TABLE[name] ?? '')
    expect('green' in face.theme).toBe(false)
    expect('brightWhite' in face.theme).toBe(false)
  })

  it('一格都读不到时交一份空的 —— 全用 xterm 缺省,而不是抛', () => {
    const face = terminalFaceFrom(() => '')
    expect(face.theme).toEqual({})
    expect(face.fontFamily).toBeUndefined()
    expect(face.fontSize).toBeUndefined()
  })

  it('`cursorAccent` 取的是底色(光标里那个字要压在底纸上读得出来)', () => {
    const face = terminalFaceFrom((name) => TABLE[name] ?? '')
    expect(face.theme.cursorAccent).toBe(TABLE['--term-bg'])
  })

  it('pxOf:读不出数、零、负数一律 undefined', () => {
    expect(pxOf('12px')).toBe(12)
    expect(pxOf(' 12.5px ')).toBe(12.5)
    expect(pxOf('')).toBeUndefined()
    expect(pxOf('0px')).toBeUndefined()
    expect(pxOf('-1px')).toBeUndefined()
    expect(pxOf('inherit')).toBeUndefined()
  })
})

describe('那些名字在 palette.css 里真的有产地', () => {
  const NAMES = [
    '--term-bg',
    '--term-fg',
    '--term-cursor',
    '--term-selection',
    '--term-black',
    '--term-red',
    '--term-green',
    '--term-yellow',
    '--term-blue',
    '--term-magenta',
    '--term-cyan',
    '--term-white',
    '--term-bright-black',
    '--term-bright-red',
    '--term-bright-green',
    '--term-bright-yellow',
    '--term-bright-blue',
    '--term-bright-magenta',
    '--term-bright-cyan',
    '--term-bright-white',
  ]

  it('二十格颜色**亮暗两档各有一份**(暗档挂在 `data-color-mode="dark"` 上)', () => {
    const dark = paletteBody.slice(paletteBody.indexOf(":root[data-color-mode='dark']"))
    const light = paletteBody.slice(0, paletteBody.indexOf(":root[data-color-mode='dark']"))
    for (const name of NAMES) {
      expect(light, `亮档缺 ${name}`).toContain(`${name}:`)
      expect(dark, `暗档缺 ${name}`).toContain(`${name}:`)
    }
  })

  it('组件文件里一个字面色值都没有(铁律一):这一族只在 palette.css 出现', () => {
    const themeSource = readFileSync(path.resolve(here, '../theme.ts'), 'utf-8')
    expect(themeSource).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    const leafCss = readFileSync(path.resolve(here, '../TerminalLeaf.module.css'), 'utf-8')
    expect(leafCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
  })
})
