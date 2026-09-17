/**
 * 行编辑与对账(正本 `apps/desktop-react/docs/todo-editor-2026-09.md` §3.1)。
 *
 * 一份按行组织的文本(待办 markdown)同时有两个写者:界面(经 `todo:` 资源)与 AI(经普通的
 * 写文件工具,不认识任何锁)。所以界面的每一次改动都不是「整份写回」,而是一条
 * 「从第几行起、我以为原来是哪几行、换成哪几行」的行编辑;真正落盘前先按这份**当前**
 * 的原文对账 —— 行号挪了就按原文找回来,找不回来就如实说冲突,绝不写半截。
 *
 * 纯函数,零依赖、零 node 引用:壳做乐观补丁与后端真写文件用的是同一份代码,
 * 两边的判断永远一致。
 */

export interface LineEdit {
  /** 从第几行起(0 起)。 */
  readonly start: number
  /** 调用方以为 `start` 起的这几行现在是什么。空数组 = 纯插入。 */
  readonly expect: readonly string[]
  /** 换成什么。空数组 = 删除。 */
  readonly lines: readonly string[]
  /**
   * 纯插入(`expect` 为空)时插入点**上一行**的原文。缺席 = 插在第 0 行之前,
   * 那一处不需要锚:文件开头只有一个。
   */
  readonly anchor?: string
}

export type Located = { readonly ok: true; readonly start: number } | { readonly ok: false; readonly reason: 'conflict' }

function matchesAt(doc: readonly string[], at: number, expect: readonly string[]): boolean {
  if (at < 0 || at + expect.length > doc.length) return false
  for (let i = 0; i < expect.length; i++) if (doc[at + i] !== expect[i]) return false
  return true
}

function uniqueMatch(doc: readonly string[], expect: readonly string[]): number | null {
  let found: number | null = null
  for (let at = 0; at + expect.length <= doc.length; at++) {
    if (!matchesAt(doc, at, expect)) continue
    if (found !== null) return null
    found = at
  }
  return found
}

/**
 * 这条编辑在 `doc` 里该落在哪。
 *
 *  1. `start` 处恰好是 `expect` → 就在这里;
 *  2. 否则全文找「连续几行恰好等于 `expect`」,恰好一处 → 在那里(别人在上面插删了行);
 *  3. 纯插入按 `anchor` 找上一行,规则同上;
 *  4. 零处或多处 → 冲突。
 */
export function locate(doc: readonly string[], edit: LineEdit): Located {
  if (edit.expect.length > 0) {
    if (matchesAt(doc, edit.start, edit.expect)) return { ok: true, start: edit.start }
    const at = uniqueMatch(doc, edit.expect)
    return at === null ? { ok: false, reason: 'conflict' } : { ok: true, start: at }
  }
  if (edit.anchor === undefined) {
    return edit.start === 0 ? { ok: true, start: 0 } : { ok: false, reason: 'conflict' }
  }
  if (edit.start > 0 && doc[edit.start - 1] === edit.anchor) return { ok: true, start: edit.start }
  const at = uniqueMatch(doc, [edit.anchor])
  return at === null ? { ok: false, reason: 'conflict' } : { ok: true, start: at + 1 }
}

export function applyAt(doc: readonly string[], edit: LineEdit, at: number): string[] {
  const next = doc.slice()
  next.splice(at, edit.expect.length, ...edit.lines)
  return next
}

/** 反向编辑:把 `applyAt(before, edit, at)` 撤回去。撤销走的也是一次普通对账。 */
export function invert(before: readonly string[], edit: LineEdit, at: number): LineEdit {
  return {
    start: at,
    expect: edit.lines.slice(),
    lines: edit.expect.slice(),
    ...(edit.lines.length === 0 && at > 0 ? { anchor: before[at - 1] } : {}),
  }
}

export type BatchResult =
  | { readonly ok: true; readonly lines: string[]; readonly applied: readonly { edit: LineEdit; at: number }[] }
  | { readonly ok: false; readonly reason: 'conflict'; readonly index: number }

/** 一批编辑按顺序对账;任何一条冲突,整批不算(调用方据此决定整批不写)。 */
export function applyBatch(doc: readonly string[], edits: readonly LineEdit[]): BatchResult {
  let current = doc.slice()
  const applied: { edit: LineEdit; at: number }[] = []
  for (let i = 0; i < edits.length; i++) {
    const found = locate(current, edits[i])
    if (!found.ok) return { ok: false, reason: 'conflict', index: i }
    current = applyAt(current, edits[i], found.start)
    applied.push({ edit: edits[i], at: found.start })
  }
  return { ok: true, lines: current, applied }
}

/** 按行切 / 拼。`\r\n` 统一当 `\n`:待办文件是给人和 AI 读的 markdown,行尾风格不是语义。 */
export function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n')
}

export function joinLines(lines: readonly string[]): string {
  return lines.join('\n')
}
