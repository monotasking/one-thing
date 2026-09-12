import type { ITheme } from '@xterm/xterm'

/**
 * **xterm 的配色与字面,从 CSS 变量现算**(T1)。
 *
 * ── 为什么非得「现算」不可 ───────────────────────────────────────────────
 * xterm 的渲染器(canvas / WebGL)不认 CSS:颜色必须以一份 `ITheme` **值**交给
 * 它,读过一次就定死在那台渲染器里。所以这一只是全壳少数几处「把 CSS 变量读成
 * JS 值」的地方之一 —— 它**不违反**「组件文件零字面色值」那条铁律,恰恰相反:
 * 十六格 ANSI 色一个都不写在这里,全部在 `styles/palette.css` 的 `--term-*` 那
 * 一节命名一次(那一节自己写着为什么它不过主题桥)。这只文件只知道**名字**。
 *
 * 主题换了要重算一遍,那一声由 `theme/theme-source.onThemeApplied` 发
 * (判词在那只函数上);谁来听是 `registry.ts` 的事 —— 这只文件是纯的。
 *
 * ── 读不到就**不填那一格**,而不是兑一个 ─────────────────────────────────
 * `getComputedStyle` 在变量没定义时给空串。空串塞进 `ITheme` 会让 xterm 抛
 * (它当颜色解析),所以这里一律**跳过**:少一格 = 那一格用 xterm 自己的缺省。
 * 兑一个假的(比如拿前景色顶上)只会让「某个色没定义」这件事再也看不出来。
 */

/** `ITheme` 上的键 → 它读哪一个 CSS 变量。**一张表,零分支**。 */
const COLOR_VARS: Readonly<Record<string, string>> = {
  background: '--term-bg',
  foreground: '--term-fg',
  cursor: '--term-cursor',
  cursorAccent: '--term-bg',
  selectionBackground: '--term-selection',
  black: '--term-black',
  red: '--term-red',
  green: '--term-green',
  yellow: '--term-yellow',
  blue: '--term-blue',
  magenta: '--term-magenta',
  cyan: '--term-cyan',
  white: '--term-white',
  brightBlack: '--term-bright-black',
  brightRed: '--term-bright-red',
  brightGreen: '--term-bright-green',
  brightYellow: '--term-bright-yellow',
  brightBlue: '--term-bright-blue',
  brightMagenta: '--term-bright-magenta',
  brightCyan: '--term-bright-cyan',
  brightWhite: '--term-bright-white',
}

/** 字面那三格读的变量。字号跟的是读数那一档(`--fs-meta`),不是正文。 */
const FONT_FAMILY_VAR = '--font-mono'
const FONT_SIZE_VAR = '--fs-meta'

export interface TerminalFace {
  theme: ITheme
  fontFamily?: string
  fontSize?: number
}

/** `12px` / ` 12.5px ` → 12.5;读不出数就是 undefined(那一格不填)。 */
export function pxOf(raw: string): number | undefined {
  const value = Number.parseFloat(raw.trim())
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * 现在这一刻的终端面相。`read` 是「按变量名取值」那一口 —— 生产里就是
 * `getComputedStyle(document.documentElement).getPropertyValue`,测试里是一张表
 * (所以这只函数是纯的,不去问 `document`)。
 */
export function terminalFaceFrom(read: (name: string) => string): TerminalFace {
  const theme: Record<string, string> = {}
  for (const [key, cssVar] of Object.entries(COLOR_VARS)) {
    const value = read(cssVar).trim()
    if (value) theme[key] = value
  }
  const fontFamily = read(FONT_FAMILY_VAR).trim() || undefined
  const fontSize = pxOf(read(FONT_SIZE_VAR))
  return { theme: theme as ITheme, ...(fontFamily ? { fontFamily } : {}), ...(fontSize ? { fontSize } : {}) }
}

/** 生产里的那一口读法。没有 document(SSR / 单测)时全空 = 全部用 xterm 缺省。 */
export function currentTerminalFace(): TerminalFace {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return terminalFaceFrom(() => '')
  }
  const style = getComputedStyle(document.documentElement)
  return terminalFaceFrom((name) => style.getPropertyValue(name))
}
