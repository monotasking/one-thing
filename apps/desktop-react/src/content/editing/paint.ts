import type { Analysis } from './inline-tokens'

/**
 * 切分 → HTML(正本 `docs/todo-editor-2026-09.md` §3.6)。**一份切分两种画法**:
 * `revealed` 里的元素画出记号(淡灰),其余元素的记号与链接地址不画;文字两态同一个样子 ——
 * 粗体仍是 `<strong>`、行内码仍是那一颗小底(消息 `InlineRun` 的同一格样式),
 * 所以进编辑时唯一的变化是记号出现。
 *
 * 同时交出 `vis`:屏幕上第 n 个字在原文里的下标。光标换算只认它。
 *
 * 纯函数、输出字符串:编辑中的那一项由光标控制器直接写 `innerHTML`(每次输入后按新值重画、
 * 放回光标),React 不参与那一格的子节点,也就不会在光标底下重排 DOM。
 */

export interface PaintClasses {
  /** 行内码那一颗小底(消息 InlineRun 的 `.code`)。 */
  readonly code: string
  /** 链接文字(消息 InlineRun 的 `.link`)。 */
  readonly link: string
  /** 记号(淡灰)。 */
  readonly mark: string
  /** 链接地址(淡灰)。 */
  readonly url: string
  /** 不显示记号档里「光标所在的那个元素」的淡底。 */
  readonly current: string
}

export interface Painted {
  readonly html: string
  readonly vis: readonly number[]
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, ch => ESCAPES[ch])
}

export function paint(analysis: Analysis, revealed: ReadonlySet<number>, current: number | null, classes: PaintClasses): Painted {
  const vis: number[] = []
  let html = ''
  let openCode: number | null = null
  const inCurrent = (groups: readonly number[]) => current !== null && groups.includes(current)
  for (const token of analysis.tokens) {
    const own = token.groups.length ? token.groups[token.groups.length - 1] : null
    const visible = token.kind === 'text' || (own !== null && revealed.has(own))
    if (!visible) continue
    // 行内码是一颗小底:两个反引号与里面的字装进同一个元素(否则画成三颗)。
    const codeGroup = token.flags.code ? own : null
    if (codeGroup !== openCode) {
      if (openCode !== null) html += '</span>'
      if (codeGroup !== null) html += `<span class="${classes.code}${inCurrent(token.groups) ? ` ${classes.current}` : ''}">`
      openCode = codeGroup
    }
    for (let i = token.from; i < token.to; i++) vis.push(i)
    const text = escapeHtml(analysis.source.slice(token.from, token.to))
    if (token.kind !== 'text') {
      html += `<span class="${token.kind === 'url' ? classes.url : classes.mark}">${text}</span>`
      continue
    }
    let inner = text
    if (token.flags.link) inner = `<span class="${classes.link}">${inner}</span>`
    if (token.flags.delete) inner = `<s>${inner}</s>`
    if (token.flags.emphasis) inner = `<em>${inner}</em>`
    if (token.flags.strong) inner = `<strong>${inner}</strong>`
    if (!token.flags.code && inCurrent(token.groups)) inner = `<span class="${classes.current}">${inner}</span>`
    html += inner
  }
  if (openCode !== null) html += '</span>'
  return { html, vis }
}
