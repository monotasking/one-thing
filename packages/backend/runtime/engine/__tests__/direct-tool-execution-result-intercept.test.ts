/**
 * N5 —— **挂点**验收:工具结果改写与工具执行链的先后。
 *
 * 这一份不管链内部的两态(那在 `packages/backend/runtime/plugins/__tests__/tool-result-intercept.test.ts`),
 * 只钉死挂点的几件事:
 *  1. 结果改写排在工具执行**之后**(analyze → permission → execute → resultIntercept);
 *  2. N5 只过工具**真正产出**的结果 —— N4 的 block、权限拒绝、用户 abort 都不进;
 *  3. N4(执行前拦截)与 N5(执行后改写)在同一个函数里**互不干扰**:一个改入参、
 *     一个改结果,各管各的。
 */
import { describe, expect, it } from 'vitest'

import type { JsonObject } from '@shared/json.js'
import {
  executeCoreDirectTool,
  type CoreDirectToolInterceptVerdict,
  type CoreDirectToolResultVerdict,
} from '../direct-tool-execution.js'

interface Trace {
  order: string[]
  resultSeen: Array<{ content: string; isError: boolean }>
}

function run(options: {
  args?: JsonObject
  isMCP?: boolean
  executeResult?: unknown
  executeThrows?: Error
  permissionThrows?: Error
  intercept?: (input: JsonObject) => CoreDirectToolInterceptVerdict
  interceptResult?: (result: { content: string; isError: boolean }) => CoreDirectToolResultVerdict
}) {
  const trace: Trace = { order: [], resultSeen: [] }
  const promise = executeCoreDirectTool<any, any>({
    toolName: 'bash',
    args: options.args ?? { command: 'ls' },
    context: { sessionId: 's1', messageId: 'm1', toolCallId: 'call-1' },
    isMCPTool: () => Boolean(options.isMCP),
    executeMCPTool: async (_name, args) => {
      trace.order.push('mcp')
      return options.executeResult ?? { rows: args }
    },
    analyzeTool: async () => {
      trace.order.push('analyze')
      return { success: true, effects: [] }
    },
    executeTool: async () => {
      trace.order.push('execute')
      if (options.executeThrows) throw options.executeThrows
      return (options.executeResult ?? { success: true, data: 'RAW' }) as never
    },
    enforcePermission: async () => {
      trace.order.push('permission')
      if (options.permissionThrows) throw options.permissionThrows
    },
    interceptToolCall: options.intercept
      ? async ({ input }) => {
          trace.order.push('intercept')
          return options.intercept!(input)
        }
      : undefined,
    interceptToolResult: options.interceptResult
      ? async ({ result }) => {
          trace.order.push('resultIntercept')
          trace.resultSeen.push(result)
          return options.interceptResult!(result)
        }
      : undefined,
    createExecutionContext: ctx => ({ ...ctx }) as never,
    formatFailure: failure => failure.rejectionReason ?? failure.error ?? 'failed',
  })
  return promise.then(result => ({ result, trace }))
}

describe('挂点次序:结果改写排在工具执行之后', () => {
  it('内置工具:analyze → permission → execute → resultIntercept', async () => {
    const { trace } = await run({
      interceptResult: () => ({ action: 'keep' }),
    })
    expect(trace.order).toEqual(['analyze', 'permission', 'execute', 'resultIntercept'])
  })

  it('改写口看到的是工具产出的结果视图(content + isError)', async () => {
    const { trace } = await run({
      executeResult: { success: true, data: 'the raw output' },
      interceptResult: () => ({ action: 'keep' }),
    })
    expect(trace.resultSeen).toEqual([{ content: 'the raw output', isError: false }])
  })

  it('replace:结果文本被顶替,并可翻转错误态', async () => {
    const { result } = await run({
      executeResult: { success: true, data: 'sk-leaked-secret-key' },
      interceptResult: () => ({ action: 'replace', content: '[REDACTED]', isError: false }),
    })
    expect(result).toMatchObject({ success: true, data: '[REDACTED]' })
  })

  it('replace 翻成错误态:清掉 data、把 content 放进 error', async () => {
    const { result } = await run({
      executeResult: { success: true, data: '/home/me/.ssh/id_rsa' },
      interceptResult: () => ({ action: 'replace', content: 'path hidden', isError: true }),
    })
    expect(result).toMatchObject({ success: false, error: 'path hidden' })
    expect((result as { data?: unknown }).data).toBeUndefined()
  })

  it('keep = 一字不改的旧结果', async () => {
    const { result } = await run({
      executeResult: { success: true, data: 'untouched' },
      interceptResult: () => ({ action: 'keep' }),
    })
    expect(result).toMatchObject({ success: true, data: 'untouched' })
  })

  it('不注入改写口 = 一字不改的旧行为', async () => {
    const { result, trace } = await run({ executeResult: { success: true, data: 'x' } })
    expect(trace.order).toEqual(['analyze', 'permission', 'execute'])
    expect(result).toMatchObject({ success: true, data: 'x' })
  })

  it('MCP 结果也进改写链(一处覆盖两族)', async () => {
    const { result, trace } = await run({
      isMCP: true,
      executeResult: { hit: 1 },
      interceptResult: () => ({ action: 'replace', content: 'mcp-redacted', isError: false }),
    })
    // MCP 分支:permission(有 plan)→ mcp → resultIntercept。改写排在最后。
    expect(trace.order).toEqual(['permission', 'mcp', 'resultIntercept'])
    expect(result).toMatchObject({ success: true, data: 'mcp-redacted' })
  })

  it('工具**自身抛出**的错误也进改写链(脱敏错误里的路径)', async () => {
    const { result, trace } = await run({
      executeThrows: new Error('cannot read /home/me/.env'),
      interceptResult: (r) => ({ action: 'replace', content: `redacted: ${r.content.replace(/\/home\/\S+/, '[path]')}`, isError: true }),
    })
    expect(trace.order).toEqual(['analyze', 'permission', 'execute', 'resultIntercept'])
    expect(result).toMatchObject({ success: false })
    expect((result as { error: string }).error).toContain('[path]')
  })
})

describe('N5 只过工具真正产出的结果 —— 与 N4 在同一函数里互不干扰', () => {
  it('N4 block 时 N5 不跑:block 不是工具产出的结果', async () => {
    const { result, trace } = await run({
      intercept: () => ({ action: 'block', reason: 'Blocked by plugin "guard": nope' }),
      interceptResult: () => ({ action: 'replace', content: 'should-not-run', isError: false }),
    })
    // 只跑了 N4 拦截;execute / resultIntercept 都没跑。
    expect(trace.order).toEqual(['intercept'])
    expect(result).toEqual({ success: false, error: 'Blocked by plugin "guard": nope' })
  })

  it('权限拒绝时 N5 不跑:那是权限系统的结果,不是工具的', async () => {
    const rejected = Object.assign(new Error('user said no'), { name: 'PermissionRejectedError' })
    const { result, trace } = await run({
      permissionThrows: rejected,
      interceptResult: () => ({ action: 'replace', content: 'should-not-run', isError: false }),
    })
    expect(trace.order).toEqual(['analyze', 'permission'])
    expect(result).toMatchObject({ success: false, rejected: true })
  })

  it('N4 改入参 + N5 改结果:一个改执行前、一个改执行后,各自生效', async () => {
    const { result, trace } = await run({
      args: { command: 'ls' },
      intercept: () => ({ action: 'allow', input: { command: 'ls -l' } }),
      executeResult: { success: true, data: 'raw listing' },
      interceptResult: (r) => ({ action: 'replace', content: `summary of: ${r.content}`, isError: false }),
    })
    // N4 排在执行前,N5 排在执行后,两道闸都在,不打架。
    expect(trace.order).toEqual(['intercept', 'analyze', 'permission', 'execute', 'resultIntercept'])
    expect(result).toMatchObject({ success: true, data: 'summary of: raw listing' })
  })
})
