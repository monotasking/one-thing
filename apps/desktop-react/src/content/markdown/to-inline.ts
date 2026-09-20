import { isRefCloseTag, parseRefOpenTag, parseRefTag } from '@onething/core/references'
import type { PhrasingContent } from 'mdast'
/* 显式引一次扩展包的节点型 —— 理由与 to-blocks.ts 顶上那一段逐字相同。 */
import type { InlineMath } from 'mdast-util-math'
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
 * 这是脚注角标与 `imageReference`(`![alt][id]`)今天的归宿:词汇表里没有它们,
 * 于是原文可见。
 *
 * `image` 从 2026-09-13 起**有词汇了**(正本 §1):它不再原文照抄,而是翻译成行内
 * image 节点 —— 画法(一颗芯片)在 `blocks/inline/InlineImage.tsx`。
 *
 * `html` 从 2026-09-20 起**有一格词汇**(B2,正本
 * `docs/design/reference-tag-2026-09.md` §2.5):`<ref …/>` 翻成一格 `ref` 节点。
 * **别的 html 一个字不变**,照旧原文可见 —— 这一支只多认了一种标签名,而认不出
 * 的那几条走的仍是本文件头那条总纪律。
 */
export function toInline(nodes: readonly PhrasingContent[], source: string): InlineNode[] {
  const out: InlineNode[] = []
  /*
   * 手写游标而不是 `for…of`:宽容形 `<ref …>文字</ref>` 在 mdast 里是**三个兄弟
   * 节点**(开标签的 html、文字、闭标签的 html),认下它要往后**吃掉**几个节点。
   */
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]

    if (node.type === 'html') {
      const eaten = takeRefTag(nodes, index, source, out)
      if (eaten > 0) {
        index += eaten - 1
        continue
      }
    }

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

      case 'image':
        /*
         * 地址**原样透传,不在这里解码**:`%20` 是不是一个空格、相对路径相对谁,
         * 都要知道「这份文档在哪儿」才答得出,而翻译表不知道 —— 那是资产层
         * (`blocks/asset/resolve.ts`)的问题。翻译表只负责把作者写的那三格
         * (地址 / alt / title)搬进词汇,一个字节都不改。
         *
         * `imageReference`(`![alt][id]` 引用式)仍走 default 支原文可见:它要一张
         * 定义表才解得开,那是另一件事(正本 §6 的 P3)。
         */
        out.push({
          type: 'image',
          ref: { kind: 'url', url: node.url },
          alt: node.alt ?? '',
          title: node.title ?? undefined,
        })
        break

      case 'inlineMath':
        /*
         * 行内公式。词法认得宽(单 `$` 是扩展的缺省),所以**判据在这里**。
         *
         * 过不了判据的原文照抄成文字 —— 走的就是下面 default 那条路,一个字不多写:
         * 「解析器认出了一个东西,而我们认为作者不是那个意思」与「解析器认出了一个
         * 我们没画法的东西」在屏幕上是同一件事,失败语义只该有一个样子。
         */
        if (isTextMath(node, source)) {
          out.push({ type: 'math', tex: node.value })
        } else {
          push(out, { type: 'text', text: rawText(node, source) })
        }
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
 * **从 `at` 这个 html 节点起,认一枚 `<ref/>`**;认出来就 push 一格 `ref` 并答
 * 「吃掉了几个节点」,认不出答 0(调用方照旧走总纪律,原文可见)。
 *
 * 两形:
 *  · **自闭合** —— 一个 html 节点就是全部,吃 1 个;
 *  · **宽容形** `<ref …>文字</ref>` —— 往后找**同级**的那一个闭标签 html 节点,
 *    把**源文本里那一整段**切出来交给 `parseRefTag`。切源文而不是把中间节点的
 *    文字拼起来,是因为实体解码只该有一个产地:`&amp;` 怎么读由编解码器说了算,
 *    拼节点文字等于在这里再写一份解码(而 mdast 的 text 节点已经解过一轮实体,
 *    再交给编解码器解第二轮就会把 `&amp;lt;` 读成 `<`)。
 *
 * 找不到闭标签 = **原文照抄**(本文件头那条总纪律),所以答 0。
 */
function takeRefTag(
  nodes: readonly PhrasingContent[],
  at: number,
  source: string,
  out: InlineNode[],
): number {
  const open = parseRefOpenTag((nodes[at] as { value: string }).value)
  if (!open) return 0

  if (open.selfClosing) {
    out.push({ type: 'ref', tag: open.tag })
    return 1
  }

  for (let i = at + 1; i < nodes.length; i += 1) {
    const node = nodes[i]
    if (node.type !== 'html') continue
    if (!isRefCloseTag(node.value)) break
    const from = nodes[at].position?.start.offset
    const to = node.position?.end.offset
    if (typeof from !== 'number' || typeof to !== 'number') break
    const tag = parseRefTag(source.slice(from, to))
    if (!tag) break
    out.push({ type: 'ref', tag })
    return i - at + 1
  }
  return 0
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

/**
 * 这一处 `$…$` 真的是公式吗 —— **pandoc 的四条**。
 *
 * 起因是钱:「花了 $5 和 $10」在词法层是一段合法的行内公式(`$` … `$`,中间是
 * `5 和 `),而作者说的是两个价钱。pandoc 给过一组判据,这里逐条照搬:
 *
 *  ① 内容非空(`$$` 不是公式,是两个美元符号);
 *  ② 内容首字符不是空白(`$ x$` 里那个 `$` 是货币符号,后面跟着一个词);
 *  ③ 内容末字符不是空白(上面那句「$5 和 $」正是折在这一条上);
 *  ④ 闭合的 `$` 后面一位不是数字(`$5 和 $10` 折在这一条上,两条各挡一半)。
 *
 * **只对单个 `$` 设这道闸**。`$$…$$` 与归一来的 `\(…\)`(下标上仍是 `\(`)写出两个
 * 字符的人已经表明了意图,再判一次只会把真公式挡在外面。
 *
 * 判据读的是**原文**(归一等长,下标一一对应),而不是 `node.value` —— 后者被扩展
 * 剥过一层空白 padding(`$ x $` 的值是 `x`),拿它判 ②③ 等于判在一份已经被改过的
 * 东西上。
 */
function isTextMath(node: InlineMath, source: string): boolean {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  // 没有位置就没有判据可言(极少见):按解析器说的算。
  if (start === undefined || end === undefined) return true

  const head = source.slice(start, start + 2)
  if (head === '\\(' || head === '\\[') return true

  let run = 0
  while (source[start + run] === '$') run += 1
  if (run !== 1) return true

  const inner = source.slice(start + 1, end - 1)
  if (inner === '') return false
  if (/\s/.test(inner[0]) || /\s/.test(inner[inner.length - 1])) return false
  const after = source[end]
  return after === undefined || !/[0-9]/.test(after)
}

/** 一个节点在源文本里的原话。位置信息缺席时(极少见)退回它自己的 `value`。 */
function rawText(node: PhrasingContent, source: string): string {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (typeof start === 'number' && typeof end === 'number') return source.slice(start, end)
  return 'value' in node && typeof node.value === 'string' ? node.value : ''
}
