/**
 * 真 runner 的**取消**那一半(P5,`docs/design/notes-obsidian-cli-2026-09.md` §4.3)。
 *
 * 这几条**起真子进程**,因为要证的正是「abort 那一下子进程真的死了」—— 一个假
 * runner 证不了这件事(它本来就没有进程可杀)。用的是 `node -e`:这台机器上
 * 一定有,而且它自己退出得干净。
 *
 * 契约上 `NoteLiveSearchOptions.signal` 在 P1 只是一格**留着的参数**(注里写着
 * 「今天不生效」);这一批是把它接上的那一批,所以判据要落在「进程没了」上,
 * 而不是「promise 拒绝了」——后者光靠丢掉答案也能装出来。
 */
import { describe, expect, it } from 'vitest'
import { NoteProcessAborted, createNodeProcessRunner } from '../process-runner.js'

/** 一条会跑很久的命令。**不落盘、不联网** —— 它唯一的本事是活着。 */
const SLEEP = ['-e', 'setTimeout(() => {}, 60_000)']

describe('createNodeProcessRunner:换词即 kill', () => {
  it('跑到一半 abort → 子进程死掉,`done` 以 NoteProcessAborted 落定', async () => {
    const runner = createNodeProcessRunner()
    const controller = new AbortController()
    const handle = runner.spawn({
      command: process.execPath,
      args: SLEEP,
      signal: controller.signal,
    })
    // 让子进程真的起来再撤 —— 「起来之前就撤」是下一条用例。
    await new Promise(resolve => setTimeout(resolve, 50))
    controller.abort()
    await expect(handle.done).rejects.toThrowError(NoteProcessAborted)
  }, 10_000)

  it('已经取消了 → **一次 spawn 都不发生**', async () => {
    const runner = createNodeProcessRunner()
    const controller = new AbortController()
    controller.abort()
    const started = Date.now()
    await expect(runner.run({
      command: process.execPath,
      args: SLEEP,
      signal: controller.signal,
    })).rejects.toThrowError(NoteProcessAborted)
    // 60 秒的命令,立刻就回来了 —— 它根本没被起过。
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('不给 signal 的调用一格都不变(缺省路仍然只认 `timeoutMs`)', async () => {
    const runner = createNodeProcessRunner()
    const result = await runner.run({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ok")'],
    })
    expect(result.stdout).toBe('ok')
    expect(result.code).toBe(0)
  }, 10_000)
})
