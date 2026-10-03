/**
 * N4 —— **挂点**验收:插件拦截与工具执行链的先后。
 *
 * 这一份不管链内部的三态(那在 `packages/backend/plugin/__tests__/tool-call-intercept.test.ts`),
 * 只钉死一件事:**拦截排在 analyze / permission 之前,改写后的参数才是被授权、
 * 被执行的那一份**;block 走既有的工具错误结果路径,而权限闸一步不少。
 *
 * 这个次序与规格给的"权限 → 拦截"相反,理由写在 `direct-tool-execution.ts`
 * 的挂点注释里:改写若排在授权之后,用户点头的和真正跑的就是两份参数,那正是
 * "插件绕过用户授权"本身。
 */
import { describe, expect, it } from 'vitest'

import type { JsonObject } from '@shared/json.js'
import { executeCoreDirectTool, type CoreDirectToolInterceptVerdict } from '../agent-loop-direct-tool-execution.js'

interface Trace {
  order: string[]
  analyzed: unknown[]
  permitted: unknown[]
  executed: unknown[]
}

function run(options: {
  args: JsonObject
  intercept?: (input: JsonObject) => CoreDirectToolInterceptVerdict
  isMCP?: boolean
}) {
  const trace: Trace = { order: [], analyzed: [], permitted: [], executed: [] }
  const promise = executeCoreDirectTool<any, any>({
    toolName: 'bash',
    args: options.args,
    context: { sessionId: 's1', messageId: 'm1', toolCallId: 'call-1' },
    isMCPTool: () => Boolean(options.isMCP),
    executeMCPTool: async (_name, args) => {
      trace.order.push('mcp')
      trace.executed.push(args)
      return { ok: true }
    },
    analyzeTool: async (_name, args) => {
      trace.order.push('analyze')
      trace.analyzed.push(args)
      return { success: true, effects: [] }
    },
    executeTool: async (_name, args) => {
      trace.order.push('execute')
      trace.executed.push(args)
      return { success: true } as never
    },
    enforcePermission: async (input) => {
      trace.order.push('permission')
      trace.permitted.push(input)
    },
    interceptToolCall: options.intercept
      ? async ({ input }) => {
          trace.order.push('intercept')
          return options.intercept!(input)
        }
      : undefined,
    createExecutionContext: ctx => ({ ...ctx }) as never,
    formatFailure: failure => failure.error ?? 'failed',
  })
  return promise.then(result => ({ result, trace }))
}

describe('挂点次序:拦截 → analyze → permission → execute', () => {
  it('拦截排在最前:allow 之后 analyze / permission / execute 一步不少', async () => {
    const { result, trace } = await run({
      args: { command: 'ls' },
      intercept: () => ({ action: 'allow', input: { command: 'ls' } }),
    })
    expect(result).toMatchObject({ success: true })
    expect(trace.order).toEqual(['intercept', 'analyze', 'permission', 'execute'])
  })

  it('**改写后的参数才是被授权、被执行的那一份**(否则改写就是越权)', async () => {
    const { trace } = await run({
      args: { command: 'ls' },
      intercept: () => ({ action: 'allow', input: { command: 'ls -l' } }),
    })
    expect(trace.analyzed).toEqual([{ command: 'ls -l' }])
    expect(trace.executed).toEqual([{ command: 'ls -l' }])
    // 权限卡上的 effects/preview 来自改写后那次 analyze —— 用户点头的与真正
    // 跑的是同一份参数。
    expect(trace.permitted).toHaveLength(1)
  })

  it('block:走工具错误结果这条既有路径,且 analyze / permission / execute 全不跑', async () => {
    const { result, trace } = await run({
      args: { command: 'rm -rf /' },
      intercept: () => ({ action: 'block', reason: 'Blocked by plugin "tool-guard": nope' }),
    })
    expect(result).toEqual({ success: false, error: 'Blocked by plugin "tool-guard": nope' })
    expect(trace.order).toEqual(['intercept'])
  })

  it('MCP 工具走同一道闸(一处覆盖两族)', async () => {
    const { result, trace } = await run({
      args: { q: 'x' },
      isMCP: true,
      intercept: () => ({ action: 'block', reason: 'no mcp today' }),
    })
    expect(result).toMatchObject({ success: false, error: 'no mcp today' })
    expect(trace.order).toEqual(['intercept'])
  })

  it('不注入拦截口 = 一字不改的旧行为', async () => {
    const { trace } = await run({ args: { command: 'ls' } })
    expect(trace.order).toEqual(['analyze', 'permission', 'execute'])
  })
})

describe('拦截不替代权限系统', () => {
  it('allow 只是"我不干预":权限拒绝照样把这次调用挡下来', async () => {
    const trace: string[] = []
    const rejected = Object.assign(new Error('user said no'), { name: 'PermissionRejectedError' })
    const result = await executeCoreDirectTool<any, any>({
      toolName: 'bash',
      args: { command: 'ls' },
      context: { sessionId: 's1', messageId: 'm1' },
      isMCPTool: () => false,
      executeMCPTool: async () => ({}),
      analyzeTool: async () => ({ success: true, effects: [] }),
      executeTool: async () => { trace.push('execute'); return { success: true } as never },
      enforcePermission: async () => { throw rejected },
      interceptToolCall: async ({ input }) => {
        trace.push('intercept')
        return { action: 'allow', input }
      },
      createExecutionContext: ctx => ({ ...ctx }) as never,
      formatFailure: failure => failure.rejectionReason ?? failure.error ?? 'failed',
    })
    expect(trace).toEqual(['intercept'])
    expect(result).toMatchObject({ success: false, rejected: true })
  })
})
