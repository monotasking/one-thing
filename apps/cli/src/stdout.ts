import { RefTagPlainTextStream } from '@onething/core/references'

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

/**
 * 助手正文的**人读**出口(设计正本 `docs/design/reference-tag-2026-09.md` §2.8)。
 *
 * 终端里没有可点的东西,所以 `<ref/>` 在这里投影成它指着的那几个字;而正文是
 * 逐 token 到的,标签会被切成两半,所以扣尾这件事必须有状态 —— 一个回合一只。
 *
 * `--json` 那条路**不经过这里**:管道要的是原样的事件,不是给人看的投影。
 */
export class AssistantTextOut {
  private readonly stream = new RefTagPlainTextStream()

  write(text: string): void {
    const ready = this.stream.push(text)
    if (ready) stdoutRaw(ready)
  }

  /** 回合结束:还扣着的那半截从来就不是标签,原样放行(不补换行,那是调用方的事)。 */
  end(): void {
    const held = this.stream.flush()
    if (held) stdoutRaw(held)
  }
}
