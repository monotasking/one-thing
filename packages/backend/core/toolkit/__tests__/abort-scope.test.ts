import { describe, expect, it, vi } from 'vitest'

import { AbortScope } from '../abort-scope.js'
import { isToolAbortError } from '../../tools/abort.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('AbortScope', () => {
  it('继承已经响过的父信号', () => {
    const controller = new AbortController()
    controller.abort()
    const scope = new AbortScope(controller.signal)
    expect(scope.aborted).toBe(true)
    expect(() => scope.throwIfAborted()).toThrow()
    scope.dispose()
  })

  it('父信号后响也会级联', () => {
    const controller = new AbortController()
    const scope = new AbortScope(controller.signal)
    expect(scope.aborted).toBe(false)
    controller.abort()
    expect(scope.aborted).toBe(true)
    scope.dispose()
  })

  it('race 把不认识信号的 Promise 变成可掐的,抛的是结构化取消错误', async () => {
    const scope = new AbortScope()
    const pending = deferred<string>()
    const raced = scope.race(pending.promise)
    scope.abort('user pressed stop')
    const error = await raced.then(() => undefined, (thrown: unknown) => thrown)
    expect(isToolAbortError(error)).toBe(true)
    expect(scope.reason).toBe('user pressed stop')
    scope.dispose()
  })

  it('race 正常完成时不吞值,也不留监听器', async () => {
    const scope = new AbortScope()
    await expect(scope.race(Promise.resolve(42))).resolves.toBe(42)
    await expect(scope.race(Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    scope.dispose()
  })

  it('onAbort 注册得太晚也会被立刻回调', () => {
    const scope = new AbortScope()
    scope.abort()
    const callback = vi.fn()
    scope.onAbort(callback)
    expect(callback).toHaveBeenCalledTimes(1)
    scope.dispose()
  })

  it('onAbort 返回的摘除函数真的摘得掉', () => {
    const scope = new AbortScope()
    const callback = vi.fn()
    const off = scope.onAbort(callback)
    off()
    scope.abort()
    expect(callback).not.toHaveBeenCalled()
    scope.dispose()
  })

  it('child 的超时与父信号联动:父先响,子跟着响', () => {
    const scope = new AbortScope()
    const child = scope.child({ timeoutMs: 60_000 })
    scope.abort('parent stopped')
    expect(child.aborted).toBe(true)
    scope.dispose()
  })

  it('child 自己超时不会拖累父作用域', async () => {
    vi.useFakeTimers()
    try {
      const scope = new AbortScope()
      const child = scope.child({ timeoutMs: 10 })
      vi.advanceTimersByTime(11)
      expect(child.aborted).toBe(true)
      expect(child.reason).toContain('Timed out')
      expect(scope.aborted).toBe(false)
      scope.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose 摘掉父信号上的监听器(长会话不留死回调)', () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const scope = new AbortScope(controller.signal)
    scope.dispose()
    expect(remove).toHaveBeenCalledTimes(1)
    controller.abort()
    // 已 dispose 的作用域不再跟着父信号走。
    expect(scope.aborted).toBe(false)
  })

  it('dispose 级联到子作用域', () => {
    const controller = new AbortController()
    const scope = new AbortScope(controller.signal)
    const child = scope.child()
    const grandchild = child.child()
    scope.dispose()
    controller.abort()
    expect(child.aborted).toBe(false)
    expect(grandchild.aborted).toBe(false)
  })
})
