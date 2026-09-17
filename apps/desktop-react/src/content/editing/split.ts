import type { Analysis, Group } from './inline-tokens'

/**
 * 在光标处把一段原文拆成两半(回车拆项用),**不许把行内元素劈成两截坏的 markdown**。
 *
 * 09-17 真机报障:在 `` `elcc_real_product="Premier"` `` 中间回车,上一项留下半个反引号,
 * 下一项从 `elcc…` 起、末尾挂着孤零零的 `` ` ``,两项的格式一起乱掉。规则:
 *
 *  · 光标落在某个元素的**记号上**(开头那几个 `**` 里、结尾那个 `` ` `` 前)→ 挪到元素外面再拆;
 *  · 光标在元素**正文里、两边都有字** → 左半补上结尾记号、右半补上开头记号(粗体、斜体、
 *    删除线、行内码都是「一对记号包一段字」,各自包一半仍是合法的同一种元素);
 *  · 链接不拆(地址只有一份,劈开之后必有一半是坏的)→ 挪到链接后面再拆。
 */
export function splitValueAt(analysis: Analysis, value: string, pos: number): { left: string; right: string; at: number } {
  let at = Math.max(0, Math.min(value.length, pos))

  // 先把光标挪出「不能从中间拆」的地方:链接整体、以及任何元素的记号区。
  for (let guard = 0; guard < 8; guard++) {
    const moved = moveOutOfMarks(analysis, at)
    if (moved === at) break
    at = moved
  }

  const wrapping = analysis.groups
    .filter(g => isPairKind(g) && g.start < at && at < g.end)
    .sort((x, y) => (y.end - y.start) - (x.end - x.start)) // 由外到内
  const opens = wrapping.map(g => value.slice(g.start, openEnd(analysis, g)))
  const closes = wrapping.map(g => value.slice(closeStart(analysis, g), g.end))
  const left = value.slice(0, at) + [...closes].reverse().join('')
  const right = opens.join('') + value.slice(at)
  return { left, right, at }
}

function isPairKind(g: Group): boolean {
  return g.kind === 'strong' || g.kind === 'emphasis' || g.kind === 'delete' || g.kind === 'code'
}

/** 这个元素开头那段记号在哪儿结束(它自己名下、从 `start` 起连着的记号)。 */
function openEnd(analysis: Analysis, g: Group): number {
  let end = g.start
  for (const token of analysis.tokens) {
    if (token.kind === 'mark' && token.groups[token.groups.length - 1] === g.id && token.from === end) end = token.to
  }
  return end
}

/** 这个元素结尾那段记号从哪儿开始。 */
function closeStart(analysis: Analysis, g: Group): number {
  let start = g.end
  for (const token of [...analysis.tokens].reverse()) {
    if (token.kind === 'mark' && token.groups[token.groups.length - 1] === g.id && token.to === start) start = token.from
  }
  return start
}

function moveOutOfMarks(analysis: Analysis, at: number): number {
  for (const g of analysis.groups) {
    if (!(g.start < at && at < g.end)) continue
    if (g.kind === 'link') return g.end
    if (!isPairKind(g)) continue
    const inner = openEnd(analysis, g)
    const tail = closeStart(analysis, g)
    // 光标在开头记号里,或正文一个字都还没有 → 整个元素归右半(拆在元素前面)。
    if (at <= inner) return g.start
    // 光标在结尾记号里,或正文已经到头 → 整个元素归左半(拆在元素后面)。
    if (at >= tail) return g.end
  }
  return at
}
