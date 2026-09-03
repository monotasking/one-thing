/**
 * CLI 的**用户输出**口(不是日志)。
 *
 * `onething` 这条命令的 stdout 是产品界面的一部分:管道给别的程序、给人看的表格
 * 与提示。它天然该走 `process.stdout`,不该进 `app.jsonl`,也不该被 `no-console`
 * 与 `log:gate` 棘轮计数 —— 所以它有自己的名字,而不是散落的 `console.log`。
 *
 * 判据一句话:**给人/管道看的 = stdout();给排障看的 = getLogger(ns)。**
 */

export function stdout(line = ''): void {
  process.stdout.write(`${line}\n`)
}

export function stderr(line = ''): void {
  process.stderr.write(`${line}\n`)
}

/** 已经带好换行 / 需要逐字输出(JSON 管道)时用它。 */
export function stdoutRaw(text: string): void {
  process.stdout.write(text)
}
