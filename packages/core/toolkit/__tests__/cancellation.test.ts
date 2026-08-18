/**
 * 尺子③ —— 取消是一个语义,不是四种写法。
 *
 * 同一个工具,信号在四个不同时机响,`runner.run` 的结局必须**恒为 `aborted`**:
 * 不是 failed(那会进事故统计并触发重试),也不是 ok(那会让模型以为事情做完了)。
 */

import { describe, expect, it, vi } from 'vitest'

import { Decision, Intent } from '../intent.js'
import { ToolRunner } from '../runner.js'
import { textResult } from '../result.js'
import {
  allowAuthorizer,
  makeInvocation,
  passthroughValidator,
  RecordingObserver,
  ScriptedTool,
} from './fakes.js'

function never<T>(): Promise<T> {
  return new Promise<T>(() => {})
}

function makeRunner(authorizer = allowAuthorizer) {
  return new ToolRunner({ authorizer, observer: new RecordingObserver(), validator: passthroughValidator })
}

describe('取消的唯一语义', () => {
  it('① plan 之前信号就已经响了', async () => {
    const plan = vi.fn(async () => Intent.none(null))
    const controller = new AbortController()
    controller.abort()
    const outcome = await makeRunner().run(new ScriptedTool({ plan }), makeInvocation(), controller.signal)
    expect(outcome.kind).toBe('aborted')
    expect(plan).not.toHaveBeenCalled()
  })

  it('② plan 跑到一半被掐', async () => {
    const controller = new AbortController()
    const tool = new ScriptedTool({
      plan: async () => {
        controller.abort()
        return await never<Intent<unknown>>()
      },
    })
    const outcome = await makeRunner().run(tool, makeInvocation(), controller.signal)
    expect(outcome.kind).toBe('aborted')
  })

  it('③ 正等着人回答审批时被掐', async () => {
    const controller = new AbortController()
    const apply = vi.fn(async () => textResult('should not happen'))
    const authorizer = {
      async decide(): Promise<Decision> {
        controller.abort()
        return await never<Decision>()
      },
    }
    const outcome = await makeRunner(authorizer).run(new ScriptedTool({ apply }), makeInvocation(), controller.signal)
    expect(outcome.kind).toBe('aborted')
    expect(apply).not.toHaveBeenCalled()
  })

  it('③b 审批答完了,但答完之前信号已经响过', async () => {
    const controller = new AbortController()
    const apply = vi.fn(async () => textResult('should not happen'))
    const authorizer = {
      async decide(): Promise<Decision> {
        controller.abort()
        return Decision.allow()
      },
    }
    const outcome = await makeRunner(authorizer).run(new ScriptedTool({ apply }), makeInvocation(), controller.signal)
    expect(outcome.kind).toBe('aborted')
    expect(apply).not.toHaveBeenCalled()
  })

  it('④ apply 跑到一半被掐', async () => {
    const controller = new AbortController()
    const tool = new ScriptedTool({
      apply: async () => {
        controller.abort()
        return await never<ReturnType<typeof textResult>>()
      },
    })
    const outcome = await makeRunner().run(tool, makeInvocation(), controller.signal)
    expect(outcome.kind).toBe('aborted')
  })

  it('④b 被掐之后工具抛的是自己的错(子进程 exit 1 / fetch TypeError)—— 仍是 aborted', async () => {
    const controller = new AbortController()
    const tool = new ScriptedTool({
      apply: async () => {
        controller.abort()
        await new Promise(resolve => setTimeout(resolve, 0))
        throw new Error('command failed with exit code 1')
      },
    })
    const outcome = await makeRunner().run(tool, makeInvocation(), controller.signal)
    expect(outcome.kind).toBe('aborted')
  })

  it('工具可以用 ctx.abort 登记撤回,信号一响就被回调', async () => {
    const controller = new AbortController()
    const withdraw = vi.fn()
    const tool = new ScriptedTool({
      apply: async (_intent, ctx) => {
        ctx.abort.onAbort(withdraw)
        controller.abort()
        return await never<ReturnType<typeof textResult>>()
      },
    })
    const outcome = await makeRunner().run(tool, makeInvocation(), controller.signal)
    expect(outcome.kind).toBe('aborted')
    expect(withdraw).toHaveBeenCalledTimes(1)
  })
})
