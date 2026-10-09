/**
 * 看着父进程:父进程没了就告诉调用者一次(10-09 孤儿后端修复)。
 *
 * 为什么要它:桌面拉起的后端是 `detached` 的(自己一个进程组,终端里的 Ctrl+C 不打到它),收尾全靠 Electron 主进程
 * 发 SIGTERM。Electron 一旦不是正常退出(被 dev 链强杀、崩溃、`kill -9`),就没人通知后端,它成了孤儿。这里只做
 * 「发现父进程没了」这一件事,发现之后怎么办由调用者决定(进程档位那一格,`backend-launcher.ts`)。
 *
 * 判据(两条任一成立就算没了):
 *   - `process.ppid` 变了 —— 父进程退出后子进程被过继给 init / launchd,`ppid` 当场变成另一个数(实测是 1);
 *   - `process.kill(原 ppid, 0)` 抛 `ESRCH` —— 防着过继给的是某个子收割者(subreaper)、`ppid` 碰巧没读出变化。
 *   `EPERM` 表示那个 pid 还有人用着,按「还在」算(宁可多留一台,也不误退)。
 * 起点的 `ppid` 已经是 1 = 拉起者在我们起来之前就走了,第一拍就答「没了」。
 *
 * 只答一次:报过之后计时器当场停掉,调用者不必自己去重。计时器 `unref()`,不撑着事件循环。
 * 不认识任何产品概念,所以住在 L0 的 lifecycle 里。
 */

/** 可替换的几样(测试用);缺省就是真进程与真计时器。 */
export interface ParentWatchOptions {
  /** 父进程没了时调一次。参数是起点记下的那个父进程 pid。 */
  readonly onGone: (parentPid: number) => void
  /** 多久查一次,缺省 1000ms。 */
  readonly intervalMs?: number
  readonly readPpid?: () => number
  readonly isAlive?: (pid: number) => boolean
  readonly setInterval?: (tick: () => void, ms: number) => { unref?: () => void }
  readonly clearInterval?: (handle: { unref?: () => void }) => void
}

/** 起点记下的父进程,与停掉看守的函数。停掉之后再调是空操作。 */
export interface ParentWatch {
  readonly parentPid: number
  stop(): void
}

export const PARENT_WATCH_INTERVAL_MS = 1000

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/** 起一只看守。起点读一次 `ppid`,之后每 `intervalMs` 查一次。 */
export function watchParentProcess(options: ParentWatchOptions): ParentWatch {
  const readPpid = options.readPpid ?? (() => process.ppid)
  const isAlive = options.isAlive ?? processIsAlive
  const schedule = options.setInterval ?? ((tick, ms) => setInterval(tick, ms))
  const cancel = options.clearInterval ?? (handle => clearInterval(handle as ReturnType<typeof setInterval>))
  const parentPid = readPpid()
  const state: { handle: { unref?: () => void } | undefined } = { handle: undefined }

  const stop = (): void => {
    const handle = state.handle
    state.handle = undefined
    if (handle) cancel(handle)
  }
  const tick = (): void => {
    if (!state.handle) return
    const gone = parentPid <= 1 || readPpid() !== parentPid || !isAlive(parentPid)
    if (!gone) return
    stop()
    options.onGone(parentPid)
  }

  state.handle = schedule(tick, options.intervalMs ?? PARENT_WATCH_INTERVAL_MS)
  state.handle.unref?.()
  return { parentPid, stop }
}
