/**
 * **半截 JSON 的容错前缀解析**(§6.2 参数生成中那一段)。
 *
 * 参数是逐 delta 流过来的,任何一刻手里都是一段**语法不完整**的 JSON
 * (`{"command": "rg -n \"follo`)。`JSON.parse` 对它只会抛,而屏幕上那一行正在等
 * ——「工具名 + 半截 JSON」是今天的形,本稿要的是「命令逐字长出来」。
 *
 * 判据只有一条:**已经能确定的才说**。
 *
 *  · 值已经闭合的顶层字段 → 进 `values`,它此后不会再变;
 *  · **最后那个还开着的字符串**值 → 进 `openKey` / `openValue`,它还在长
 *    (行上那枚打字光标说的就是这一格);
 *  · 数字 / true / false / null 只有在后面见到 `,` 或 `}` 时才算数 ——
 *    半截的 `12` 下一片可能是 `3`,把 12 说出去就是**说错**,不是说少;
 *  · 嵌套的对象 / 数组要么整段闭合、要么整段不算 —— 一棵长了一半的树没有
 *    「已到达的内容」这种读法(它的形还没定),硬画等于猜。
 *
 * 它是纯函数、零依赖:presenter 拿它取自己那几个字段(bash 取 command、
 * read/edit/write 取 path、web_search 取 query),取不到就退回今天的原始 JSON 尾巴。
 */

export interface PartialJson {
  /** 值已经闭合的顶层字段。 */
  values: Record<string, unknown>
  /** 最后那个**还没闭合**的字符串字段的键(有的话)。 */
  openKey?: string
  /** 那个字段目前已经到达的内容(转义已还原;末尾悬空的 `\` 不算一个字)。 */
  openValue?: string
}

const EMPTY: PartialJson = { values: {} }

export function parsePartialJson(text: string): PartialJson {
  if (!text) return EMPTY
  const values: Record<string, unknown> = {}
  let i = 0

  const skipSpace = () => {
    while (i < text.length && /\s/.test(text[i])) i += 1
  }

  skipSpace()
  // 顶层不是对象就没有「字段」这个概念可谈(工具参数按合同永远是对象)。
  if (text[i] !== '{') return EMPTY
  i += 1

  for (;;) {
    skipSpace()
    if (i >= text.length) return { values }
    if (text[i] === '}') return { values }
    if (text[i] === ',') {
      i += 1
      continue
    }
    if (text[i] !== '"') return { values }

    const key = readString(text, i)
    // 键自己都没说完 —— 这一格连名字都还不知道,更谈不上值。
    if (!key.closed) return { values }
    i = key.next
    skipSpace()
    if (text[i] !== ':') return { values }
    i += 1
    skipSpace()
    if (i >= text.length) return { values }

    const ch = text[i]
    if (ch === '"') {
      const value = readString(text, i)
      if (!value.closed) {
        // 还在长的那一格:说出「到目前为止」,并让调用方知道它没说完。
        return { values, openKey: key.value, openValue: value.value }
      }
      values[key.value] = value.value
      i = value.next
      continue
    }

    if (ch === '{' || ch === '[') {
      const end = scanContainer(text, i)
      // 半棵树没有「已到达的内容」这种读法:它的形还没定。
      if (end < 0) return { values }
      try {
        values[key.value] = JSON.parse(text.slice(i, end)) as unknown
      } catch {
        return { values }
      }
      i = end
      continue
    }

    // 字面量(数字 / true / false / null):**必须**见到分隔符才算收口。
    let j = i
    while (j < text.length && !/[,}\s]/.test(text[j])) j += 1
    if (j >= text.length) return { values }
    try {
      values[key.value] = JSON.parse(text.slice(i, j)) as unknown
    } catch {
      return { values }
    }
    i = j
  }
}

/**
 * 取一格:**闭合的优先,没有就退到还开着的那一截**。
 *
 * 两种来源在这里合流,是因为调用方要的永远是同一件事 ——「这个字段此刻是什么」。
 * 让每个 presenter 自己写一遍 `values[k] ?? (openKey === k ? openValue : undefined)`
 * 就是把这条判据抄了四份。
 */
export function partialString(parsed: PartialJson, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = parsed.values[key]
    if (typeof value === 'string') return value
    if (parsed.openKey === key) return parsed.openValue ?? ''
  }
  return undefined
}

interface ReadString {
  value: string
  closed: boolean
  next: number
}

/** 从 `at`(一定是 `"`)读一个 JSON 字符串;没读到收尾引号就是**还在长**。 */
function readString(text: string, at: number): ReadString {
  let out = ''
  let i = at + 1
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      // 悬空的反斜杠是**半个转义**,不是一个字符 —— 不吐出来。
      if (i + 1 >= text.length) return { value: out, closed: false, next: i }
      const escaped = text[i + 1]
      if (escaped === 'u') {
        if (i + 6 > text.length) return { value: out, closed: false, next: i }
        const code = Number.parseInt(text.slice(i + 2, i + 6), 16)
        out += Number.isNaN(code) ? '' : String.fromCharCode(code)
        i += 6
        continue
      }
      out += ESCAPES[escaped] ?? escaped
      i += 2
      continue
    }
    if (ch === '"') return { value: out, closed: true, next: i + 1 }
    out += ch
    i += 1
  }
  return { value: out, closed: false, next: i }
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
}

/** 从 `at`(`{` 或 `[`)找配对的收口;找不到返回 -1。字符串里的括号不算数。 */
function scanContainer(text: string, at: number): number {
  let depth = 0
  let i = at
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      const read = readString(text, i)
      if (!read.closed) return -1
      i = read.next
      continue
    }
    if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') {
      depth -= 1
      if (depth === 0) return i + 1
    }
    i += 1
  }
  return -1
}
