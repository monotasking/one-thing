/**
 * **一本只为一颗按钮存在的小账本**(T1,方案 §2.1-5)。
 *
 * 一格终端死了(进程退出 / 重启之后账上残留),屏幕上要给一条出路:
 * 「在**同一个目录**再开一个」。而那时 `terminal.attach` 已经答不出 `info.cwd`
 * —— 那格 PTY 不在了。所以壳自己记一笔 `id → cwd`。
 *
 * ── 它为什么可以住在 localStorage,而浏览器那本不行 ─────────────────────
 * 深查 **9-5** 把浏览器的 tab 表判回了主进程:那是**真源的一半**被搬进了壳。
 * 这里不是 —— PTY 真的死了,没有第二份真相可言;这一格只是「上一次它在哪」,
 * 一句用完就该忘的提示。丢了的后果是那颗钮退成「在主目录再开一个」,不是
 * 数据不一致。判词写在 9-5 的末句上(「终端那条本地小账本不改」)。
 *
 * 封顶 32 条,先进先出。**只在建一格时写**,不在每次 attach 时写:cwd 是
 * spawn 时定的,shell 里 `cd` 之后那格 PTY 的 cwd 会变,但「再开一个」要的
 * 是**当初在哪开的**这条人能预期的事实,不是一个跟着跑的游标。
 */

const KEY = 'onething.terminal.cwd.v1'
/** 记到 32 格为止。判词见文件头。 */
export const TERMINAL_MEMORY_LIMIT = 32

type Book = { id: string; cwd: string }[]

function read(): Book {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (row): row is { id: string; cwd: string } =>
        !!row
        && typeof row === 'object'
        && typeof (row as { id?: unknown }).id === 'string'
        && typeof (row as { cwd?: unknown }).cwd === 'string',
    )
  } catch {
    // 私密窗口 / 存储被禁 / 存进去的那串坏了 —— 一律当成「没记过」。
    return []
  }
}

function write(book: Book): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(book))
  } catch {
    /* 存不进去只是下次那颗钮退一档,不值得让开终端这件事失败 */
  }
}

/** 记一笔。同一个 id 覆盖(不重复长),超出封顶丢最旧的。 */
export function rememberTerminalCwd(id: string, cwd: string): void {
  if (!id || !cwd) return
  const book = read().filter((row) => row.id !== id)
  book.push({ id, cwd })
  write(book.slice(-TERMINAL_MEMORY_LIMIT))
}

/** 这格终端当初在哪开的。没记过 = undefined。 */
export function terminalCwdOf(id: string): string | undefined {
  return read().find((row) => row.id === id)?.cwd
}

/** 忘掉一笔(这一格被关掉之后)。 */
export function forgetTerminalCwd(id: string): void {
  const book = read()
  const next = book.filter((row) => row.id !== id)
  if (next.length !== book.length) write(next)
}

/** 测试用:清空。 */
export function resetTerminalMemory(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 同 write */
  }
}
