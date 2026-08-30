import type { PhrasingContent } from 'mdast'
import type { InlineNode } from '../model/inline'

/**
 * **mdast 行内 → InlineNode**(§3.2 的翻译表,行内那一半)。
 *
 * ── 一条总纪律:翻译表之外的节点,原文照抄 ────────────────────────────
 * 块那一层认不出的节点落 `source-fallback`(有檐、有复制、看得见源码);行内这一层
 * 做不到那样 —— 一段话中间不能插一件「东西」。所以行内的失败语义是**把它的源码原样
 * 当文字摆出来**:`<sub>x</sub>` 画成 `<sub>x</sub>` 这七个字符。信息一个都不少,
 * 而且人一眼看得出「这里有个我没渲染的东西」,比悄悄吞掉诚实得多。
 *
 * 这也是 `image` 与脚注角标今天的归宿:词汇表里没有它们,P1 不为它们扩词汇
 * (扩词汇是拍板件),于是原文可见。
 */
export function toInline(nodes: readonly PhrasingContent[], source: string): InlineNode[] {
  const out: InlineNode[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        push(out, { type: 'text', text: node.value })
        break

      case 'inlineCode':
        out.push({ type: 'code', text: node.value })
        break

      case 'strong':
        out.push({ type: 'emphasis', strong: true, children: toInline(node.children, source) })
        break

      case 'emphasis':
        out.push({ type: 'emphasis', strong: false, children: toInline(node.children, source) })
        break

      case 'delete':
        out.push({ type: 'strike', children: toInline(node.children, source) })
        break

      case 'link':
        out.push({ type: 'link', href: node.url, children: toInline(node.children, source) })
        break

      case 'break':
        // 硬换行(行尾两个空格 / 反斜杠)。段落是 `white-space: pre-wrap` 画的,
        // 所以一个 `\n` 就是它 —— 不需要为它造一个 `<br>` 节点变体。
        push(out, { type: 'text', text: '\n' })
        break

      default:
        push(out, { type: 'text', text: rawText(node, source) })
        break
    }
  }
  return out
}

/**
 * 相邻文字并成一格。
 *
 * 不是为了省内存:行内树要参与**深比**(块模型不可变 + memo 浅比,上一层靠引用,
 * 单测靠 `toEqual`),`['a','b']` 与 `['ab']` 在屏幕上逐像素相同却比不相等,
 * 会让「同一段文本重解析出同一棵树」这条断言时灵时不灵。
 */
function push(out: InlineNode[], node: InlineNode & { type: 'text' }): void {
  const last = out[out.length - 1]
  if (last && last.type === 'text') {
    out[out.length - 1] = { type: 'text', text: last.text + node.text }
    return
  }
  out.push(node)
}

/** 一个节点在源文本里的原话。位置信息缺席时(极少见)退回它自己的 `value`。 */
function rawText(node: PhrasingContent, source: string): string {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (typeof start === 'number' && typeof end === 'number') return source.slice(start, end)
  return 'value' in node && typeof node.value === 'string' ? node.value : ''
}
