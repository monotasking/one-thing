import type { BlockModel, DiffHunk, DiffLine } from '../../../model/blocks'

/**
 * 统一 diff 文本 → `diff` 块的结构(纯函数,零 React)。
 *
 * ── 为什么是一个纯函数,而且住在这里 ──────────────────────────────────
 * 它有**两个产地**:markdown 的 ```diff 围栏(`markdown/fence.ts`)和 edit/write
 * 工具的 `changes.diff`(`tools/presenters/edit.ts`)。两边必须解析成同一份结构,
 * 否则同一段 diff 在正文里和在抽屉里会长成两种东西 —— 这正是 P2 留账要求「两个
 * 产地同批接」的原因。所以解析器跟着**块**走(kinds/diff/),不跟着任何一个产地走。
 *
 * ── 一条纪律:解析不动的行原样透传 ────────────────────────────────────
 * 认得的行归类(add / del / ctx),认不得的行**照抄成 ctx**,一个字符都不丢。
 * diff 文本的方言很多(git 扩展头、`\ No newline at end of file`、被工具截断的
 * 碎片),猜不中的那些如果被静默吞掉,屏幕上就是「有几行凭空消失了」——
 * 那是最难发现的一类错。块自己还另存一份 `source` 原文(见 model/blocks.ts),
 * 于是「透传」有两道保险。
 *
 * ── 认不出来就说认不出来 ──────────────────────────────────────────────
 * 返回 `undefined` = 这段文本不像 diff。调用方的正确反应是退回 `code(lang:'diff')`,
 * 不是画一个空的 diff 卡片。判据只有一条:**既没有 `@@` 头,也没有一行加减** ——
 * 那它就只是一段恰好被标成 diff 的普通文字。
 */

/** 解析结果 = `diff` 块除去 `kind` 的那几格。调用方摊开就是一个块。 */
export type ParsedDiff = Omit<Extract<BlockModel, { kind: 'diff' }>, 'kind'>

/** `@@ -12,7 +12,9 @@ 后面可能还挂着所属函数名`。行数那一格可缺席(`@@ -1 +1 @@`)。 */
const HUNK_HEADER = /^@@+\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/

export function parseUnifiedDiff(text: string): ParsedDiff | undefined {
  if (!text.trim()) return undefined

  const lines = splitDiffLines(text)
  const hunks: DiffHunk[] = []
  let current: DiffHunk | undefined
  let file: string | undefined
  let sawHunkHeader = false
  let add = 0
  let del = 0

  const openHunk = (init: Omit<DiffHunk, 'lines'>): DiffHunk => {
    const hunk: DiffHunk = { ...init, lines: [] }
    hunks.push(hunk)
    current = hunk
    return hunk
  }
  const pushLine = (line: DiffLine) => {
    ;(current ?? openHunk({})).lines.push(line)
  }

  for (const raw of lines) {
    const header = HUNK_HEADER.exec(raw)
    if (header) {
      sawHunkHeader = true
      openHunk({ header: raw, oldStart: Number(header[1]), newStart: Number(header[2]) })
      continue
    }

    // 文件头只在**还没进 hunk 时**成立。进了 hunk 之后,`--- x` 是一行删掉的内容
    // (`-- x`),不是头 —— 两者字面上无法区分,只能靠位置。标准结构里头永远在前。
    if (current === undefined) {
      const consumed = readFileHeader(raw)
      if (consumed) {
        file = consumed.file ?? file
        continue
      }
    }

    const first = raw.charAt(0)
    if (first === '+') {
      add += 1
      pushLine({ kind: 'add', text: raw.slice(1) })
    } else if (first === '-') {
      del += 1
      pushLine({ kind: 'del', text: raw.slice(1) })
    } else if (first === ' ') {
      pushLine({ kind: 'ctx', text: raw.slice(1) })
    } else {
      // 空行、`\ No newline…`、认不出的方言:整行照抄(**不**削第一个字符 ——
      // 那个字符是内容的一部分,不是标记)。
      pushLine({ kind: 'ctx', text: raw })
    }
  }

  if (hunks.length === 0) return undefined
  if (!sawHunkHeader && add + del === 0) return undefined

  return { ...(file ? { file } : {}), source: text, hunks, stat: { add, del } }
}

/**
 * 切行。
 *
 * 末尾那个 `\n` 切出来的空串不是一行内容 —— 留着它会在每段 diff 屁股上多画一行空
 * 行(而且它会被算进 ctx)。只削**一个**:两个 `\n` 结尾时最后那一行空行是真的。
 */
function splitDiffLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * git / unified 的文件头族。返回 `undefined` = 这不是头(交给内容分支)。
 *
 * `file` 只从带路径的那几种里取,取到就**后写覆盖先写** —— `+++ b/x` 在 `--- a/x`
 * 之后,而新文件名才是这段 diff 说的那个文件。`/dev/null`(新增/删除文件的那一侧)
 * 不是路径,跳过。
 */
function readFileHeader(raw: string): { file?: string } | undefined {
  const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw)
  if (git) return { file: git[2] }

  const minus = /^--- (?:a\/)?(.*)$/.exec(raw)
  if (minus) return headerPath(minus[1])

  const plus = /^\+\+\+ (?:b\/)?(.*)$/.exec(raw)
  if (plus) return headerPath(plus[1])

  // 带不来路径、但确实是头的那几行:吃掉,不进正文。
  if (/^(index [0-9a-f]+\.\.|old mode |new mode |deleted file mode |new file mode |similarity index |rename (from|to) |copy (from|to) |Binary files )/.test(raw)) {
    return {}
  }
  return undefined
}

/** `--- a/x\t2026-01-01 10:00:00` —— 路径后面那截时间戳由 tab 隔开,不属于路径。 */
function headerPath(rest: string): { file?: string } {
  const path = rest.replace(/\t.*$/, '').trim()
  return !path || path === '/dev/null' ? {} : { file: path }
}
