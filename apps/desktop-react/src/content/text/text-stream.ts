/**
 * **一段不断追加的纯文本 → 冻住的块 + 活动尾**(正本 `docs/thinking-stream-2026-09.md` §2)。
 *
 * ── 为什么要有这一件 ──────────────────────────────────────────────────
 * 一段字塞进一个 `<p>` 里,每帧换一次完整文本,浏览器就把整段重排一遍。正本 §0 在
 * 真桌面上量过同一份样式同一个宽度:2,000 字一次重排 0.7ms,163,775 字一次 71–136ms。
 * 所以**不是「思考段太长」,是「一个节点太长」** —— 治法与正文那边 R4 立的
 * 「稳定前缀 + 活动尾」逐字同一条:切点之前冻住(同 id、同实例,DOM 不再碰),
 * 每帧只换活动尾那一小块。
 *
 * ── 它为什么不认识思考 ────────────────────────────────────────────────
 * 这里没有「思考」两个字,也没有一行 UI:进来的是 `(id, text, live)`,出去的是
 * 块与尾。正本 §2 的陌生能力演练说得很直白 —— 下一个要流长纯文本的段
 * (那条会话里 tool-input 就有 124,794 字)= 它自己的段模块 + `SegmentView` 里
 * 自己那一个 case,**这个文件一行不改**。与 `markdown/incremental.ts` 的
 * `MarkdownStream` 同形同寿命:一个类、一张按 id 分的表、一口 `forget`、一口 `reset`。
 *
 * ── 与 markdown 那一份的差别只有「切点判据」 ──────────────────────────
 * 正文的切点要问 markdown 语法(`markdown/stable-cut.ts` 的六种跨空行续块);
 * 纯文本没有语法,判据退化成一条:**换行**。那条不对称原样继承(见 `stableTextCut`)。
 */

/** 一个冻住的块。`id` 冻住后永不变 —— 它就是 React 的 key。 */
export interface TextBlock {
  readonly id: string
  readonly text: string
}

export interface TextFrame {
  readonly blocks: readonly TextBlock[]
  /** 冻住的字数(= 所有块的长度之和);`tail = text.slice(cut)`。 */
  readonly cut: number
  readonly tail: string
}

/**
 * 活动尾的字数上限。**代价上限由这个数钉死**:正本 §1 量到 2,000 字一次重排 0.7ms,
 * 4,000 字因此 ≤ 1.5ms —— 一帧 16ms 的预算里它只占一成。
 */
export const TAIL_LIMIT = 4000

/**
 * 强切时最早允许落刀的位置(距上一个切点)。
 *
 * 不从 0 起找空白:那会把一个刚开头的活动尾切得粉碎(每来几个字就多一个块,
 * 块多到几万个之后 React 的 diff 自己就是负担)。2,000 是「切出来的块值得单独存在」
 * 与「离上限还有一半余量」两头折中出来的数。
 */
export const FORCE_CUT_FLOOR = 2000

/**
 * **切点**(纯函数,正本 §2 的四条规则里的前三条;第四条 `live === false` 归 `frame`,
 * 因为它说的是「这一条流结束了」而不是「这份文本该切在哪」)。
 *
 * ── 一步只走一格 ──────────────────────────────────────────────────────
 * 它返回**下一个**切点,不是最终切点 —— 循环在 `frame` 里跑。理由是
 * **块边界必须等于切点**:把循环收进这里的话,一帧里连跳三格只会得到一个三格宽的
 * 块,「切点」与「块」当场变成两件事,而这一件的全部意义就是它们是同一件事。
 * 返回值 ≤ 入参时 `frame` 停手,所以「不推进」是合法答案,不是错误。
 *
 * ── 那条不对称(与 `markdown/stable-cut.ts` 逐字同一条)──────────────
 * **只在 `prevCut` 之后往前找,从不回退**。切少了的代价是活动尾多算一点;
 * 切错了的代价是屏幕上已经画定的字被换掉。两边不对等,所以宁可切少。
 */
export function stableTextCut(text: string, prevCut: number): number {
  const from = prevCut < 0 ? 0 : prevCut > text.length ? text.length : prevCut

  /*
   * ② 候选 = 最后一个 `\n` 的后一位。
   *
   * 用 `lastIndexOf` 而不是「`from` 之后的第一个换行」:一帧里可能来了十行,
   * 一次冻住十行比冻十次便宜,而冻住的东西再也不动,冻多少都不影响活动尾的代价。
   * 这一刀之后活动尾里**结构上不可能再有 `\n`**(它要么在最后一个换行之后,要么
   * 整段就在 `from` 之后而最后一个换行还在 `from` 之前),所以正本规则 ③ 里
   * 「且其中没有 `\n`」那半句在这里是自动成立的,不必再判一次。
   */
  const nl = text.lastIndexOf('\n')
  const cut = nl + 1 > from ? nl + 1 : from

  // ③ 活动尾还是太长(一整段没有换行的长叙述):强切。
  if (text.length - cut <= TAIL_LIMIT) return cut
  return forceCut(text, cut)
}

/**
 * 强切:`FORCE_CUT_FLOOR` 之后第一个空白处落刀;整段没有空白(无空格的长 token、
 * 或者中日韩正文)就在 `TAIL_LIMIT` 处硬切。
 *
 * 空白算进**前面那一块**(`i + 1`),不是留给尾巴 —— 块与尾首尾相接、一个字符不丢,
 * 是「拼起来逐字等于原文」那条断言的前提。
 */
function forceCut(text: string, cut: number): number {
  const limit = Math.min(cut + TAIL_LIMIT, text.length)
  for (let i = cut + FORCE_CUT_FLOOR; i < limit; i += 1) {
    if (/\s/.test(text[i]!)) return i + 1
  }
  return limit
}

interface Entry {
  text: string
  live: boolean
  blocks: readonly TextBlock[]
  cut: number
}

export class TextStream {
  private readonly entries = new Map<string, Entry>()

  /**
   * @param id   这段文本的身份(消息 id + 段序号)。缓存按它分,块 id 由它派生。
   * @param live 还在长吗。`false` = 全部冻住,尾清空(正本 §2 规则 ④)。
   *
   * 同 id 连续调用 = 增量:**前缀块的实例原样交回**(不是等值的新对象),
   * 于是 `memo` 的那一层连比都不用比,React 连 diff 都不必做。
   */
  frame(id: string, text: string, live: boolean): TextFrame {
    const prev = this.entries.get(id)
    // 同一份文本、同一个活死档再问一次:上一帧的答案逐字有效(React 重渲染很常见)。
    if (prev && prev.text === text && prev.live === live) {
      return { blocks: prev.blocks, cut: prev.cut, tail: text.slice(prev.cut) }
    }

    /*
     * 沿用上一帧的前提是**新文本以旧文本开头**。不是的话(重试换了内容、id 被复用)
     * 从 0 重来 —— 这不违反「从不回退」:那条说的是同一份不断追加的文本里切点不后退,
     * 换了一份文本就是换了一条流。
     */
    const appended = prev !== undefined && text.startsWith(prev.text)
    const blocks: TextBlock[] = appended ? prev.blocks.slice() : []
    let cut = appended ? prev.cut : 0

    if (live) {
      for (;;) {
        const next = stableTextCut(text, cut)
        if (next <= cut) break
        blocks.push({ id: `${id}#${blocks.length}`, text: text.slice(cut, next) })
        cut = next
      }
    } else if (cut < text.length) {
      // ④ 全冻:余下的整段变成最后一块。**冻住的那些块一个不动** —— 流结束那一刻
      // 屏幕上不该有任何东西换身份(换身份 = React 重挂 = 已经画好的字闪一下)。
      blocks.push({ id: `${id}#${blocks.length}`, text: text.slice(cut) })
      cut = text.length
    }

    this.entries.set(id, { text, live, blocks, cut })
    return { blocks, cut, tail: text.slice(cut) }
  }

  /** 这段文本不流了(或者被换掉了):把它的账丢掉。 */
  forget(id: string): void {
    this.entries.delete(id)
  }

  /** 整份丢掉 —— 唯一的一口拆卸(HMR 退役复用它,不写第二套)。 */
  reset(): void {
    this.entries.clear()
  }
}
