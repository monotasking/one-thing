import type { RuntimeRequestContext } from '@onething/core'
import { createToolAbortError } from '@onething/core/toolkit'
import { KeyedAdmissionGate, type KeyedWork } from '@onething/core/lifecycle'
import { ownerMatchesContext, requestSessionOwner, type SessionAccess, type SessionAccessContext } from '../../session/access.js'
import { getCurrentBackendSafe } from '../../current.js'

export interface ToolExecutionControl {
  readonly signal: AbortSignal
  assertActive(): void
  /** Keep the actual operation owned even when ToolRunner's abort race has returned. */
  track<T>(operation: Promise<T>): Promise<T>
}

interface ActiveExecution extends KeyedWork {
  readonly sessionId: string
  readonly toolCallId: string
  readonly owner: Readonly<RuntimeRequestContext>
  /** 这一件彻底落定(工具返回 **且** 它 track 过的后续都结清)之后 settle。 */
  readonly settled: Promise<void>
}

/** Backend-owned calls, including preparation, tool work and cancellation cleanup. */
export class ToolExecutionRegistry {
  /* 按键寻址的入场闸(工单 5 §1),与评估任务同一只 core 原语。 */
  private readonly active = new KeyedAdmissionGate<ActiveExecution>(
    () => createToolAbortError('Tool execution is shutting down'),
  )

  constructor(private readonly access: SessionAccess) {}

  async run<T>(input: {
    sessionId: string
    toolCallId: string
    executionContext: RuntimeRequestContext
    signal?: AbortSignal
  }, run: (control: ToolExecutionControl) => Promise<T>): Promise<T> {
    this.active.assertAccepting()
    this.access.resolve(input.executionContext, input.sessionId, 'write')
    const key = JSON.stringify([input.sessionId, input.toolCallId])
    if (this.active.has(key)) throw new Error('Tool call is already executing')

    const controller = new AbortController()
    const onParentAbort = () => controller.abort(input.signal?.reason)
    if (input.signal?.aborted) onParentAbort()
    else input.signal?.addEventListener('abort', onParentAbort, { once: true })
    const pending = new Set<Promise<unknown>>()
    let returned = false
    let resolveDrained!: () => void
    const drained = new Promise<void>(resolve => { resolveDrained = resolve })
    const entry: ActiveExecution = {
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      owner: Object.freeze(requestSessionOwner(input.executionContext)),
      abort: reason => controller.abort(reason),
      settled: drained,
    }
    const settle = () => {
      if (!returned || pending.size) return
      input.signal?.removeEventListener('abort', onParentAbort)
      this.active.remove(key, entry)
      resolveDrained()
    }
    this.active.add(key, entry)
    const control: ToolExecutionControl = {
      signal: controller.signal,
      assertActive: () => {
        if (controller.signal.aborted) throw createToolAbortError('Tool cancelled')
        this.access.resolve(entry.owner, entry.sessionId, 'write')
      },
      track(operation) {
        pending.add(operation)
        const settled = () => { pending.delete(operation); settle() }
        void operation.then(settled, settled)
        return operation
      },
    }
    try {
      return await run(control)
    } finally {
      returned = true
      settle()
    }
  }

  /** Missing, foreign, finished and ambiguous call IDs have the same answer. */
  async cancel(request: { toolCallId: string; sessionId?: string }, context: SessionAccessContext): Promise<boolean> {
    if (this.active.closed || !request.toolCallId) return false
    const candidates = [...this.active.values()].filter(entry =>
      entry.toolCallId === request.toolCallId
      && (request.sessionId === undefined || entry.sessionId === request.sessionId)
      && ownerMatchesContext(entry.owner, context),
    )
    const authorized = candidates.filter(entry => {
      try { this.access.resolve(context, entry.sessionId, 'abort'); return true }
      catch { return false }
    })
    if (authorized.length !== 1) return false
    const entry = authorized[0]!
    entry.abort(createToolAbortError('Tool cancelled'))
    await entry.settled
    return true
  }

  /** Used by the already-authorized session deletion owner. */
  async abortAndDrain(sessionId: string): Promise<void> {
    const targets = [...this.active.values()].filter(entry => entry.sessionId === sessionId)
    for (const entry of targets) entry.abort(createToolAbortError('Session stopped'))
    await Promise.all(targets.map(entry => entry.settled))
  }

  /** 取消理由**每件一份** —— 错误对象带栈,共享一份等于把第一件的栈按到所有件上。 */
  quiesce(): void { this.active.quiesce(() => createToolAbortError('Backend stopped')) }

  drain(): Promise<void> { return this.active.drain() }
}

/*
 * `cancelToolkitTool` —— **已删**(工单 4 B1)。
 *
 * 它是 `tools.cancelTool` 那条真取消路唯一的接线;那条路按默认口径回了旧的空操作,
 * 于是这个包装器零消费者。`ToolExecutionRegistry.cancel` 自己留着(有生命周期用例
 * 钉着,也是那个独立小单要重新接上的那一格),完整实现在 tag `gpt-wip-2026-09-07`。
 */
