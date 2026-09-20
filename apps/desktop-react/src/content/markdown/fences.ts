/**
 * **围栏一张表** —— 代码围栏与数学围栏,开与关各一条判据。
 *
 * 立这张表的理由只有一条:同一句话不许有两个产地。「哪一行开了一道围栏、哪一行
 * 关上了它」这件事有两个读者 —— 稳定切点(`stable-cut.ts`:围栏里的空行不是块边界)
 * 与定界符归一(`math-delimiters.ts`:围栏里的 `\(` 一个字都不许换)。两处各写一份
 * 正则,迟早会分叉成两种「什么算围栏」,而分叉的后果是屏幕上出现一份和最终解析
 * 不一样的东西(§6 顶在最前面那条不对称)。
 *
 * ── 为什么是「表」而不是 if 链 ────────────────────────────────────────────
 * 加一种围栏(将来的 `:::` 容器、frontmatter 的 `---`)= 这张表多一行,两个读者
 * 一个字都不改。读者手里只有 `openFence(line)` 与 `closeFence(line, fence)` 两口,
 * 它们不认识「代码」也不认识「数学」。
 *
 * ── 判据逐条 ──────────────────────────────────────────────────────────────
 * **代码**(逐字照搬 `stable-cut.ts` 从前那两条正则,行为一个字没变):开 = 0–3 空格
 * 缩进 + 三个以上的 ` 或 ~;关 = 同样的起手式,而且后面只许空白,**且首字符与开它
 * 的那个记号同字符**(` 关不掉 ~)。CommonMark 还要求收尾围栏不短于开它的那一道,
 * 这里**没有**这一条 —— 它是既有行为,这一批只搬家不改判据。
 *
 * **数学**:开有两形 —— 一行 `^ {0,3}\$\$` 且该行其余部分不含 `$`(带 `$` 的那种是
 * 行内公式,不是围栏;micromark 的 math flow 对 meta 段的要求逐字相同),或者 trim
 * 之后**恰好**是 `\[`。关也有两形 —— 一行光秃秃的 `$$`(不论谁开的,因为归一之后
 * `\[` 就是 `$$`,真解析里它确实关得掉),或者 trim 之后恰好是 `\]`,而**后者只对
 * `\[` 开的那一道生效**:一段真 `$$` 公式里写了一行 `\]` 是它自己的内容,认成收尾
 * 会把那个块从中间劈开。
 */

export type FenceId = 'code' | 'math'

/** 一道开着的围栏:哪一种 + 开它的那个记号原文(收尾要拿它比对)。 */
export interface OpenFence {
  readonly id: FenceId
  readonly marker: string
}

interface FenceKindDef {
  readonly id: FenceId
  /** 这一行开了这种围栏吗?开了就交出它的记号。 */
  open(line: string): string | undefined
  /** 这一行关上了它吗?`marker` 是开它的那个记号。 */
  close(line: string, marker: string): boolean
}

/** 围栏行:0–3 空格缩进 + 三个以上的 ` 或 ~。 */
const CODE_FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/
/** 收尾围栏:同上,而且后面只许空白(带 info string 的那行只能开,不能关)。 */
const CODE_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/** `$$` 围栏行:整行除了那串 `$` 之外不许再有 `$`(有的话它是一段行内公式)。 */
const MATH_FENCE_LINE = /^ {0,3}(\$\$+)[^$]*$/
/** 收尾 `$$`:后面只许空白。 */
const MATH_FENCE_CLOSE = /^ {0,3}\$\$+[ \t]*$/

/** TeX 风格的块定界符,单独成行的那两形 —— 归一器要按它们原地换成 `$$`。 */
export const TEX_BLOCK_OPEN = '\\['
export const TEX_BLOCK_CLOSE = '\\]'

const CODE: FenceKindDef = {
  id: 'code',
  open: (line) => CODE_FENCE_LINE.exec(line)?.[1],
  close: (line, marker) => CODE_FENCE_CLOSE.test(line) && line.trimStart()[0] === marker[0],
}

const MATH: FenceKindDef = {
  id: 'math',
  open: (line) => {
    if (line.trim() === TEX_BLOCK_OPEN) return TEX_BLOCK_OPEN
    return MATH_FENCE_LINE.exec(line)?.[1]
  },
  close: (line, marker) => {
    if (MATH_FENCE_CLOSE.test(line)) return true
    return marker === TEX_BLOCK_OPEN && line.trim() === TEX_BLOCK_CLOSE
  },
}

/**
 * 表本身。顺序有意义:一行先问代码围栏 —— ``` 与 `$$` 的起手式互不相交,但把代码
 * 排在前面是纪律(代码围栏里的一切都不算数,包括别的围栏的起手式)。
 */
const FENCE_KINDS: readonly FenceKindDef[] = [CODE, MATH]

/** 这一行开了哪一道围栏?一道都没开就是 undefined。 */
export function openFence(line: string): OpenFence | undefined {
  for (const kind of FENCE_KINDS) {
    const marker = kind.open(line)
    if (marker !== undefined) return { id: kind.id, marker }
  }
  return undefined
}

/** 这一行关上了那道开着的围栏吗? */
export function closeFence(line: string, fence: OpenFence): boolean {
  const kind = FENCE_KINDS.find((entry) => entry.id === fence.id)
  return kind !== undefined && kind.close(line, fence.marker)
}
