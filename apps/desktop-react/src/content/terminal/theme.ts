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

/** 查找高亮那两格(T2)。判词在 `TerminalFindFace` 上。 */
const FIND_MATCH_VAR = '--term-find-match'
const FIND_ACTIVE_VAR = '--term-find-active'

/**
 * **查找高亮的四格颜色**(T2)。
 *
 * ── 形状为什么在这里自己写一遍,而不是 import 搜索插件的类型 ────────────────
 * `@xterm/addon-search` 的 `ISearchDecorationOptions` 逐字就是这四格,但把那条
 * import 拉进这只文件会让「认识 `@xterm/*` 的地方」从一处变成两处
 * (`screen.ts` 文件头那句话是有执法意义的:xterm 在 import 那一刻就去探 canvas)。
 * 结构类型让这份自述与插件那份**恒等可用**,而边只长在 `screen.ts` 上。
 *
 * ── 为什么四格都是 `#RRGGBB`,不许带透明度 ──────────────────────────────
 * 插件自己的文档写着 `matchBackground` 「must use #RRGGBB format」—— 它要把这个
 * 值塞进 canvas 的一层装饰里自己合成。所以 `palette.css` 上那两格也是不透明的
 * 实色,与同族的 `--term-selection`(rgba)刻意不同:那一格交给的是 xterm 的
 * 选区,这两格交给的是装饰层。
 */
export interface TerminalFindFace {
  matchBackground: string
  matchOverviewRuler: string
  activeMatchBackground: string
  activeMatchColorOverviewRuler: string
}

export interface TerminalFace {
  theme: ITheme
  fontFamily?: string
  fontSize?: number
  /**
   * 查找高亮。**读不到那两格变量就是 undefined** —— 与颜色那一族「少一格就用
   * xterm 的缺省」同一条判词,只是这里的后果要写明:装饰关掉之后插件的
   * `onDidChangeResults` **不发**(它自己的文档写着「When decorations are
   * enabled」),于是查找照样能找,只是读数那一格空着。兑一对假颜色出来会让
   * 「这台机器上终端色板没加载」这件事再也看不出来。
   */
  find?: TerminalFindFace
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
  const match = read(FIND_MATCH_VAR).trim()
  const active = read(FIND_ACTIVE_VAR).trim()
  // 两格**一起有才算**:只有一半的装饰画出来是「命中与当前命中长一个样」,
  // 那比不画更难读。
  const find: TerminalFindFace | undefined =
    match && active
      ? {
          matchBackground: match,
          matchOverviewRuler: match,
          activeMatchBackground: active,
          activeMatchColorOverviewRuler: active,
        }
      : undefined
  return {
    theme: theme as ITheme,
    ...(fontFamily ? { fontFamily } : {}),
    ...(fontSize ? { fontSize } : {}),
    ...(find ? { find } : {}),
  }
}

/** 生产里的那一口读法。没有 document(SSR / 单测)时全空 = 全部用 xterm 缺省。 */
export function currentTerminalFace(): TerminalFace {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') {
    return terminalFaceFrom(() => '')
  }
  const style = getComputedStyle(document.documentElement)
  return terminalFaceFrom((name) => style.getPropertyValue(name))
}
