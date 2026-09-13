import type { CodeLine } from './CodeLines'

/**
 * **两份原文 → 一串行**(2026-09-13 批 ③-b;正本 `docs/changes-file-view-2026-09.md` §1)。
 *
 * 零 React、零 DOM、零 I/O:进去两个字符串数组,出来 `CodeLine[]` 加一张改动块表。
 * 改动面那条「整文件」路由它撑着 —— 后端只交两份原文(`git:` 的 `file` 读法),
 * **算法在壳里**。
 *
 * ── 为什么自己写,而不是用仓里那个 `diff` 包 ────────────────────────────────
 * `diff@8` 确实在仓根的 `dependencies` 里(runtime / backend 用 `structuredPatch` 与
 * `createTwoFilesPatch`),但**这只壳的 `package.json` 没有声明它** —— 今天能 import
 * 到只是因为 `apps/desktop-react` 不是 workspace 成员、解析会往上找。补一行声明就要在
 * 这只 app 下装一次,而这个 worktree 的 `node_modules` 是指回用户主检出的符号链接农场
 * (用户的桌面正跑在那上面),在这儿装东西是去动别人的机器。
 * 何况就算用了它,`diffLines` 交的是「一段一段的增删」,两个行号计数器、`mark`、
 * 以及下面那张块表还是要在这里再写一遍 —— 省下的只有 LCS 那一段。
 * 所以:自己写一段 Myers,**零新依赖、零打包面**。(`packages/core` 连 `diff` 都禁,
 * 那条判词的精神在这里同样适用:一件基础件不该为一段一百行的算法拖一个包进来。)
 *
 * ── 算法:Myers 的贪心 O(ND),外加两道闸 ───────────────────────────────────
 * ① **先剥掉公共的头和尾**。真实的改动几乎总是「一份几千行的文件动了十几行」,
 *    剥完之后要真算的那一段往往只有几十行 —— 这一步把绝大多数调用变成了 O(1)。
 * ② **行先哈希成整数再比**。字符串比较在 20000×20000 的内层循环里是实打实的钱。
 * ③ **两道预算闸**:编辑距离超过 `MAX_EDIT_DISTANCE`、或者走过的格子超过
 *    `MAX_STEPS` 时,**中间那一段整体判成「换掉了」**(全删 + 全增)。
 *    这不是偷懒的降级,而是一个诚实的答案:一份两千行里改了一千五百行的文件,
 *    逐行对齐画出来的东西人也读不出结构。**代价写在这儿**:那时会丢掉中间恰好
 *    没变的那几行的 ctx 身份。两道闸都是为了**最坏情况有上界**:回溯要存的 trace
 *    是 O(D²),没有上界的话一份全换的两万行文件会去要几百 MB。
 */

/** 一行的坐标与身份都在 `CodeLine` 里(`content/code/CodeLines.tsx`)。 */
export interface LineDiffResult {
  readonly lines: CodeLine[]
  /**
   * 每个**改动块**首行的下标。块 = 连续的一段 add/del 行(中间不夹未改行)。
   * 檐上的 `k / N` 与右缘那张改动地图读的都是它,`↑ / ↓` 也是在这张表上走。
   */
  readonly blocks: number[]
}

/**
 * 编辑距离的上界。2500 时回溯 trace 最多 (2500+1)² 个 int32 ≈ 25MB(瞬时,算完就还),
 * 而真实文件的 D 几乎总在两位数。
 */
const MAX_EDIT_DISTANCE = 2500

/** 走过的格子上界 —— D 有界不等于时间有界(蛇可以很长)。 */
const MAX_STEPS = 8_000_000

export function lineDiff(oldLines: readonly string[], newLines: readonly string[]): LineDiffResult {
  const lines: CodeLine[] = []
  let oldNo = 1
  let newNo = 1
  const ctx = (text: string) => {
    lines.push({ text, oldNo: oldNo++, newNo: newNo++ })
  }
  const del = (text: string) => {
    lines.push({ text, oldNo: oldNo++, mark: 'del' })
  }
  const add = (text: string) => {
    lines.push({ text, newNo: newNo++, mark: 'add' })
  }

  /* ── ① 剥公共头尾 ──────────────────────────────────────────────────────── */
  let head = 0
  const maxHead = Math.min(oldLines.length, newLines.length)
  while (head < maxHead && oldLines[head] === newLines[head]) head += 1
  let tail = 0
  while (
    tail < maxHead - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail += 1
  }

  for (let i = 0; i < head; i += 1) ctx(oldLines[i])

  const midOld = oldLines.slice(head, oldLines.length - tail)
  const midNew = newLines.slice(head, newLines.length - tail)

  /* ── ②③ 中间那一段:Myers,超预算就整体换掉 ────────────────────────────── */
  const script = diffMiddle(midOld, midNew)
  for (const step of script) {
    if (step.kind === 'ctx') ctx(midOld[step.oldAt])
    else if (step.kind === 'del') del(midOld[step.oldAt])
    else add(midNew[step.newAt])
  }

  for (let i = oldLines.length - tail; i < oldLines.length; i += 1) ctx(oldLines[i])

  return { lines, blocks: blocksOf(lines) }
}

/** 一段编辑脚本里的一步。下标是**中间那一段**里的下标。 */
type Step =
  | { kind: 'ctx'; oldAt: number }
  | { kind: 'del'; oldAt: number }
  | { kind: 'add'; newAt: number }

function diffMiddle(a: readonly string[], b: readonly string[]): Step[] {
  if (a.length === 0 && b.length === 0) return []
  if (a.length === 0) return b.map((_, newAt) => ({ kind: 'add', newAt }) as Step)
  if (b.length === 0) return a.map((_, oldAt) => ({ kind: 'del', oldAt }) as Step)

  const ids = internLines(a, b)
  const script = myers(ids.a, ids.b)
  if (script) return script
  // 超预算:整体换掉(判词在文件头 ③)。
  return [
    ...a.map((_, oldAt) => ({ kind: 'del', oldAt }) as Step),
    ...b.map((_, newAt) => ({ kind: 'add', newAt }) as Step),
  ]
}

/** ② 行 → 整数。同一段文本永远拿到同一个号,于是内层循环比的是数。 */
function internLines(a: readonly string[], b: readonly string[]): { a: Int32Array; b: Int32Array } {
  const table = new Map<string, number>()
  const idOf = (text: string) => {
    const seen = table.get(text)
    if (seen !== undefined) return seen
    const id = table.size
    table.set(text, id)
    return id
  }
  const ia = new Int32Array(a.length)
  const ib = new Int32Array(b.length)
  for (let i = 0; i < a.length; i += 1) ia[i] = idOf(a[i])
  for (let i = 0; i < b.length; i += 1) ib[i] = idOf(b[i])
  return { a: ia, b: ib }
}

/**
 * Myers 1986 的贪心版:一圈一圈放大编辑距离 `d`,每一圈沿对角线 `k` 走最远的那条蛇。
 * 每一圈把 `V` 存一份,末了从终点倒着走回去还原编辑脚本。
 *
 * 超预算回 `undefined`(调用方据此整体换掉)——**不抛**:一份特别难对齐的文件不是
 * 一次错误,是一种答案。
 */
function myers(a: Int32Array, b: Int32Array): Step[] | undefined {
  const n = a.length
  const m = b.length
  const max = Math.min(n + m, MAX_EDIT_DISTANCE)
  const offset = max
  const v = new Int32Array(2 * max + 2)
  const trace: Int32Array[] = []
  let steps = 0

  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(0, 2 * max + 2))
    for (let k = -d; k <= d; k += 2) {
      // 往下(= 吃掉 b 的一行 = 新增)还是往右(= 吃掉 a 的一行 = 删除)。
      const down = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])
      let x = down ? v[k + 1 + offset] : v[k - 1 + offset] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
        steps += 1
        if (steps > MAX_STEPS) return undefined
      }
      v[k + offset] = x
      if (x >= n && y >= m) return backtrack(trace, a, b, d, offset)
    }
    steps += d + 1
    if (steps > MAX_STEPS) return undefined
  }
  return undefined
}

/** 沿着每一圈存下来的 `V` 倒着走回原点,把路还原成一串步骤。 */
function backtrack(
  trace: Int32Array[],
  a: Int32Array,
  b: Int32Array,
  d: number,
  offset: number,
): Step[] {
  const out: Step[] = []
  let x = a.length
  let y = b.length
  for (let round = d; round > 0; round -= 1) {
    const v = trace[round]
    const k = x - y
    const down = k === -round || (k !== round && v[k - 1 + offset] < v[k + 1 + offset])
    const prevK = down ? k + 1 : k - 1
    const prevX = v[prevK + offset]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x -= 1
      y -= 1
      out.push({ kind: 'ctx', oldAt: x })
    }
    if (down) {
      y -= 1
      out.push({ kind: 'add', newAt: y })
    } else {
      x -= 1
      out.push({ kind: 'del', oldAt: x })
    }
  }
  while (x > 0 && y > 0) {
    x -= 1
    y -= 1
    out.push({ kind: 'ctx', oldAt: x })
  }
  return out.reverse()
}

/**
 * 改动块 = **连续的一段 add/del 行**。
 *
 * 「删掉三行再加进两行」是**一处**改动不是两处 —— 人读 diff 时把它们看成一件事,
 * 所以 ↑↓ 也该把它们当一格跳过去。
 */
export function blocksOf(lines: readonly CodeLine[]): number[] {
  const blocks: number[] = []
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].mark && (i === 0 || !lines[i - 1].mark)) blocks.push(i)
  }
  return blocks
}
