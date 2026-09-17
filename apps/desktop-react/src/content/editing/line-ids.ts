/**
 * 每一行一个**跟着行走**的身份(待办 B 形 U5,500 项清单上回车出 86ms 长帧那一笔)。
 *
 * 从前一项的 React key 是它的起始行号:在第 250 行回车,后面 250 项的行号全挪一格,key 全换,
 * React 把它们整排卸掉重建(DOM、innerHTML、排版)。行号是「此刻在第几行」,不是「它是谁」。
 *
 * 判据:新旧两份行按**公共前缀 + 公共后缀**对齐,两头的行保留身份;中间那一段按位置把旧身份
 * 依次交给新行(改了字的那一行还是它自己 —— 正在编辑的那一格不许因为打了一个字就被重建),
 * 多出来的新行领新身份。O(n),不做 LCS:一次编辑只动一小段,这就够了。
 */
export interface LineIdentity {
  readonly lines: readonly string[]
  readonly ids: readonly string[]
}

let counter = 0

function fresh(): string {
  counter += 1
  return `l${counter.toString(36)}`
}

export function initialLineIds(lines: readonly string[]): LineIdentity {
  return { lines, ids: lines.map(fresh) }
}

export function nextLineIds(previous: LineIdentity, lines: readonly string[]): LineIdentity {
  if (previous.lines === lines) return previous
  const before = previous.lines
  const ids = previous.ids
  let head = 0
  const limit = Math.min(before.length, lines.length)
  while (head < limit && before[head] === lines[head]) head++
  let tail = 0
  while (tail < limit - head && before[before.length - 1 - tail] === lines[lines.length - 1 - tail]) tail++
  const oldMiddle = before.length - head - tail
  const newMiddle = lines.length - head - tail
  const next: string[] = ids.slice(0, head)
  for (let i = 0; i < newMiddle; i++) next.push(i < oldMiddle ? ids[head + i] : fresh())
  for (let i = tail; i > 0; i--) next.push(ids[ids.length - i])
  return { lines, ids: next }
}
