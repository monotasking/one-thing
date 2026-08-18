/**
 * §3 内核 —— `AbortScope`:取消的**唯一**语义(尺子③)。
 *
 * 今天取消有四种写法:传 `signal` 给 fetch、在循环里查 `signal.aborted`、包一层
 * `Promise.race`、以及靠 catch 到的错误消息猜。结果是同一次 Ctrl-C 在不同工具里
 * 分别落成 failed / ok / 卡死。这里把这四件事收成一个对象:
 *
 *   - `throwIfAborted()` 查点
 *   - `race(promise)` 把任何不认识信号的 Promise 变成可掐的
 *   - `child({timeoutMs})` 给子进程/fetch 一个更严的子作用域,且与父信号联动
 *   - `onAbort(cb)` 撤回登记(交互工具撤回 pending 提问用)
 *
 * 抛出的错误一律来自 `core/tools/abort.ts` 的 `createToolAbortError` —— 分类靠
 * 错误对象,不靠消息文本(那份文件的头注释讲了为什么不能靠文本)。
 *
 * `dispose()` 必须摘干净所有监听器:一次调用会开出若干子作用域,监听器不摘 =
 * 长会话里父信号上挂着成百上千个死回调。
 *
 * **超时不是取消。** 子作用域到点触发时抛的是 `ToolTimeoutError`(它同时也满足
 * `isToolAbortError`,因为对被掐的执行体来说两者一样),但结局判定看的是父作用域
 * 有没有响 —— 一页 fetch 超时是工具的失败,不是用户按了停止。见 outcome.ts。
 *
 * 工具拿到的是 `AbortView`(abort-scope.ts 里另一个接口):有 race / onAbort /
 * child,**没有 `abort()` 和 `dispose()`**。作用域的所有权归 Runner:让工具能掐
 * 自己没什么用,却能让"这次调用为什么是 aborted"变得没法回答。
 */

import { createToolAbortError, isToolAbortError } from '../tools/abort.js'

/**
 * 超时。刻意也带上 `aborted: true`:对正在跑的执行体来说,超时和取消是同一件事
 * (信号响了),差别只在**归因**,而归因是 Outcome 的事,不是执行体的事。
 */
export interface ToolTimeoutError extends Error {
  aborted: true
  timeout: true
}

export const TOOL_TIMEOUT_ERROR_NAME = 'TimeoutError'

export function createToolTimeoutError(message: string): ToolTimeoutError {
  const error = new Error(message) as ToolTimeoutError
  error.name = TOOL_TIMEOUT_ERROR_NAME
  error.aborted = true
  error.timeout = true
  return error
}

export function isToolTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  return (error as { timeout?: unknown }).timeout === true
}

/**
 * 工具视角的作用域:能查、能包、能登记撤回、能开子作用域,但掐不了自己也
 * 销毁不了自己。`AbortScope` 结构上满足它。
 */
export interface AbortView {
  readonly aborted: boolean
  readonly reason: string | undefined
  readonly timedOut: boolean
  readonly signal: AbortSignal
  throwIfAborted(): void
  race<T>(promise: PromiseLike<T>): Promise<T>
  onAbort(callback: () => void): () => void
  child(options?: AbortScopeOptions): AbortView
}

export interface AbortScopeOptions {
  /** 到点自动取消。与父信号是"谁先响算谁"的关系。 */
  timeoutMs?: number
  /** 自身超时/取消时给出的原因文本。 */
  reason?: string
}

function reasonOfSignal(signal: AbortSignal): string | undefined {
  const reason: unknown = signal.reason
  if (typeof reason === 'string') return reason
  if (reason instanceof Error) return reason.message
  return undefined
}

export class AbortScope implements AbortView {
  private readonly controller = new AbortController()
  private readonly listeners = new Set<() => void>()
  private readonly children = new Set<AbortScope>()
  private parentScope?: AbortScope
  private detachParent?: () => void
  private timer?: ReturnType<typeof setTimeout>
  private reasonText?: string
  private timedOutFlag = false
  private disposed = false

  constructor(parent?: AbortSignal, options: AbortScopeOptions = {}) {
    if (parent) {
      if (parent.aborted) {
        this.abort(options.reason ?? reasonOfSignal(parent))
      } else {
        const onParentAbort = () => this.abort(reasonOfSignal(parent))
        parent.addEventListener('abort', onParentAbort)
        this.detachParent = () => parent.removeEventListener('abort', onParentAbort)
      }
    }

    if (options.timeoutMs !== undefined && !this.aborted) {
      this.timer = setTimeout(
        () => this.abortWith(options.reason ?? `Timed out after ${options.timeoutMs}ms`, true),
        options.timeoutMs,
      )
      // 一个待触发的超时不该吊住 Node 进程退出。
      ;(this.timer as unknown as { unref?: () => void }).unref?.()
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get aborted(): boolean {
    return this.controller.signal.aborted
  }

  get reason(): string | undefined {
    return this.reasonText
  }

  /** 这个作用域是被超时掐的(而不是被上游信号掐的)。 */
  get timedOut(): boolean {
    return this.timedOutFlag
  }

  /** 只有作用域的**所有者**(Runner / 宿主)该调它 —— 工具拿到的是 AbortView。 */
  abort(reason?: string): void {
    this.abortWith(reason, false)
  }

  private abortWith(reason: string | undefined, timedOut: boolean): void {
    if (this.aborted) return
    this.reasonText = reason
    this.timedOutFlag = timedOut
    this.clearTimer()
    this.controller.abort(this.failure())
    // 子作用域挂在 this.signal 上,会由上面这一句自动级联。
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // 撤回回调自己炸了不该改变取消的结局。
      }
    }
    this.listeners.clear()
  }

  throwIfAborted(): void {
    if (this.aborted) throw this.failure()
  }

  /** 抛出物的形状带着归因:超时是 TimeoutError,其余是 AbortError。 */
  private failure(): Error {
    const message = this.reasonText ?? 'Operation aborted'
    return this.timedOutFlag ? createToolTimeoutError(message) : createToolAbortError(message)
  }

  /** 已经取消时立即回调(不然"注册得太晚"就等于没注册)。返回摘除函数。 */
  onAbort(callback: () => void): () => void {
    if (this.aborted) {
      callback()
      return () => {}
    }
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  /**
   * 让一个不认识信号的 Promise 变成可掐的。注意:被掐掉之后原 Promise 仍在跑 ——
   * 内核管不了别人的执行体,它只保证**结果**恒为 aborted。
   */
  race<T>(promise: PromiseLike<T>): Promise<T> {
    if (this.aborted) {
      // 即使已经取消,也必须认领掉源 Promise:被掐掉的执行体往往稍后才自己 reject
      // (子进程 exit 1、fetch 抛 TypeError),没人接就是一条 unhandled rejection
      // —— 在 Node 里那是一条会刷屏、甚至能杀进程的假警报。
      void Promise.resolve(promise).catch(() => {})
      return Promise.reject(this.failure())
    }
    return new Promise<T>((resolve, reject) => {
      const off = this.onAbort(() => reject(this.failure()))
      promise.then(
        value => {
          off()
          resolve(value)
        },
        error => {
          off()
          reject(error)
        },
      )
    })
  }

  child(options: AbortScopeOptions = {}): AbortScope {
    const scope = new AbortScope(this.signal, options)
    scope.parentScope = this
    this.children.add(scope)
    return scope
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimer()
    this.detachParent?.()
    this.detachParent = undefined
    this.listeners.clear()
    for (const child of [...this.children]) child.dispose()
    this.children.clear()
    this.parentScope?.children.delete(this)
    this.parentScope = undefined
  }

  private clearTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }
}

export { createToolAbortError, isToolAbortError }
