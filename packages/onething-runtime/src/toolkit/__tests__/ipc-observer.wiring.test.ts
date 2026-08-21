/**
 * `IpcProjector` 的钉子:**六只工具跑一遍,投影出来的形状就是渲染器与历史重建
 * 读的那一份**。
 *
 * R2a 时这里比的是"新路 vs 旧 `executeToolDirectly` 的结果"(旧路在同一个文件里
 * 真跑一遍)。R4b 把旧路删了,于是那几格换成快照 —— 快照里记的就是当时那份旧
 * 形状(删除前这条对拍是绿的)。钉的仍是 `data.title` / `data.output` /
 * `data.metadata` / `data.attachments` 与三个失败位(`aborted` / `rejected` /
 * `rejectionReason`)。
 *
 * 临时目录在快照里被换成 `<DIR>`。
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Decision, Outcome, ToolRunner, textResult } from '@onething/core/toolkit'
import type { Authorizer, Invocation, Job, JobRegistry, JobSpec, Tool } from '@onething/core/toolkit'
import {
  BashTool,
  EditTool,
  ReadTool,
  TimeTool,
  VariableTool,
  WriteTool,
  ZodValidator,
} from '../index.js'
import type {
  RuntimeContextVariable,
  RuntimeVariableRegistry,
  RuntimeVariableSetInput,
} from '../index.js'
import type { BashOperations } from '../../tools/bash-executor.js'
import { IpcProjector, splitResultContent, stepFromEvent } from '../ipc-observer.wiring.js'

// ── 夹具 ────────────────────────────────────────────────────────────────────

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-toolkit-ipc-'))
  dirs.push(await fs.realpath(dir))
  return dirs[dirs.length - 1]
}

function invocationFor(toolId: string, input: unknown, dir?: string): Invocation {
  return {
    callId: 'test-call',
    toolId,
    input,
    sessionId: 'test-session',
    messageId: 'test-message',
    principal: { kind: 'user', userId: 'local' },
    cwd: dir,
    workspaceRoot: dir,
    workingDirectoryRoots: dir ? [dir] : undefined,
  }
}

const allowAll: Authorizer = { async decide() { return Decision.allow() } }

interface NewRunOptions {
  dir?: string
  authorizer?: Authorizer
  jobs?: JobRegistry
  signal?: AbortSignal
}

async function runNew(tool: Tool, input: unknown, options: NewRunOptions = {}) {
  const projector = new IpcProjector({}, { now: () => 1_000 })
  const runner = new ToolRunner({
    authorizer: options.authorizer ?? allowAll,
    observer: projector,
    validator: new ZodValidator(),
    jobs: options.jobs,
  })
  const outcome = await runner.run(tool, invocationFor(tool.spec.id, input, options.dir), options.signal)
  return { outcome, projector, projected: projector.toExecutionResult(outcome) }
}

/** 快照里的临时目录归一(路径每次都不一样,别的字节一个都不动)。 */
function redact(value: unknown, dir?: string): unknown {
  if (!dir) return value
  const json = JSON.stringify(value ?? null)
  return JSON.parse(json.split(JSON.stringify(dir).slice(1, -1)).join('<DIR>')) as unknown
}

// ── read ────────────────────────────────────────────────────────────────────

describe('IpcProjector · 六只工具的结果投影形状', () => {
  it('read:文本文件 —— title / output / metadata 三样都对得上', async () => {
    const dir = await tempDir()
    await fs.writeFile(path.join(dir, 'note.txt'), 'alpha\nbeta\n')
    const args = { path: 'note.txt' }

    const { projected } = await runNew(new ReadTool({}), args, { dir })

    expect(projected.success).toBe(true)
    expect(redact(projected.data, dir)).toMatchSnapshot('read text')
  })

  it('read:图片 —— 附件从 content 拆回 data.attachments,output 里没有 [Image: …] 占位', async () => {
    const dir = await tempDir()
    // 1x1 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    await fs.writeFile(path.join(dir, 'dot.png'), png)
    const args = { path: 'dot.png' }

    const { projected } = await runNew(new ReadTool({}), args, { dir })

    const data = projected.data as { output: string; attachments?: unknown }
    expect(redact(data.output, dir)).toMatchSnapshot('read image output')
    expect(data.output).not.toContain('[Image:')
    expect(redact(data.attachments, dir)).toMatchSnapshot('read image attachments')
  })

  it('write:结果带一个 file 附件,output 是那一句话本身', async () => {
    const dir = await tempDir()
    const adapters = { getFileMutationsDir: () => path.join(dir, '.audit') }
    const args = { path: 'a.txt', content: 'hello\n' }

    const { projected } = await runNew(new WriteTool(adapters), args, { dir })

    const data = projected.data as { output: string; attachments?: unknown; metadata: Record<string, unknown> }
    expect(redact(data.output, dir)).toMatchSnapshot('write output')
    expect(data.attachments).toEqual([{ type: 'file', path: path.join(dir, 'a.txt'), mimeType: undefined }])
    expect(data.metadata.diff).toBeDefined()
  })

  it('edit:同上,外加 title 来自最后一条带标题的 annotate', async () => {
    const dir = await tempDir()
    const adapters = { getFileMutationsDir: () => path.join(dir, '.audit') }
    const args = { path: 'a.ts', edits: [{ oldText: 'const a = 1', newText: 'const a = 2' }] }

    await fs.writeFile(path.join(dir, 'a.ts'), 'const a = 1\n')
    const { projected } = await runNew(new EditTool(adapters), args, { dir })

    const data = projected.data as { title: string; output: string }
    expect(redact(data.output, dir)).toMatchSnapshot('edit output')
    expect(redact(data.title, dir)).toMatchSnapshot('edit title')
  })

  it('time:纯文本结果,没有附件', async () => {
    const args = { action: 'now', timezone: 'UTC', format: 'iso' }
    const { projected } = await runNew(new TimeTool(), args)

    const data = projected.data as { title: string; output: string; attachments?: unknown }
    // 时间在走,只钉形状与标题。
    expect(data.attachments).toBeUndefined()
    expect(data.title).toMatchSnapshot('time title')
    expect(typeof data.output).toBe('string')
  })

  it('variable:title 是最后一条 annotate 的标题,metadata 钉住', async () => {
    const seed: RuntimeContextVariable[] = [{ name: 'topic', value: 'toolkit', scope: 'session' }]
    const registry = (): RuntimeVariableRegistry => {
      const rows = seed.map(row => ({ ...row }))
      const upsert = (input: RuntimeVariableSetInput) => {
        const existing = rows.find(row => row.name === input.name)
        const next = { ...(existing ?? { name: input.name }), ...input }
        if (existing) Object.assign(existing, next)
        else rows.push(next)
        return next
      }
      return {
        list: () => rows.map(row => ({ ...row })),
        set: (_ctx, input) => upsert(input),
        append: (_ctx, input) => upsert(input),
        remove: (_ctx, input) => upsert(input),
        delete: () => {},
      }
    }
    const args = { action: 'list' }

    const { projected } = await runNew(new VariableTool({ getRegistry: registry }), args)
    expect(projected.data).toMatchSnapshot('variable list')
  })

  it('bash:前台命令 —— output / metadata 钉住', async () => {
    const dir = await tempDir()
    const ops: BashOperations = {
      exec: async (_command, _cwd, { onData }) => {
        onData(Buffer.from('hello\n'))
        return { exitCode: 0 }
      },
    }
    const adapters = { getToolOutputsDir: () => dir, createOperations: () => ops }
    const args = { command: 'echo hello' }

    const { projected } = await runNew(new BashTool(adapters), args, { dir })
    expect(redact(projected.data, dir)).toMatchSnapshot('bash foreground')
  })
})

// ── 五态 ────────────────────────────────────────────────────────────────────

describe('IpcProjector · Outcome 五态 → 旧结果形状', () => {
  it('invalid → { success:false, error } 且没有 aborted / rejected 位', async () => {
    const { projected } = await runNew(new TimeTool(), { action: 'yesterday' })
    expect(projected.success).toBe(false)
    expect(projected.error).toContain('Invalid arguments')
    expect(projected.aborted).toBeUndefined()
    expect(projected.rejected).toBeUndefined()
  })

  it('用户拒绝 → rejected + rejectionReason(靠 Decision.byUser,不靠嗅字符串)', async () => {
    const authorizer: Authorizer = {
      async decide() {
        return Decision.deny('The user rejected permission for this tool. Reason: not now', {
          asked: true, byUser: true, rejectionReason: 'not now',
        })
      },
    }
    const dir = await tempDir()
    const { projected } = await runNew(
      new WriteTool({ getFileMutationsDir: () => path.join(dir, '.audit') }),
      { path: 'a.txt', content: 'x' },
      { dir, authorizer },
    )
    expect(projected).toEqual({
      success: false,
      error: 'The user rejected permission for this tool. Reason: not now',
      rejected: true,
      rejectionReason: 'not now',
    })
  })

  it('策略/插件挡下 → 一条普通工具错误,不带 rejected 位', async () => {
    const authorizer: Authorizer = { async decide() { return Decision.deny('blocked by plugin "guard"') } }
    const dir = await tempDir()
    const { projected } = await runNew(
      new WriteTool({ getFileMutationsDir: () => path.join(dir, '.audit') }),
      { path: 'a.txt', content: 'x' },
      { dir, authorizer },
    )
    expect(projected).toEqual({ success: false, error: 'blocked by plugin "guard"' })
  })

  it('aborted → aborted:true,文案带上决定④ 的 <partial_output> 尾巴', async () => {
    const dir = await tempDir()
    const controller = new AbortController()
    const ops: BashOperations = {
      exec: async (_command, _cwd, { onData, signal }) => {
        onData(Buffer.from('partial\n'))
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 3_000)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          }, { once: true })
        })
        return { exitCode: 0 }
      },
    }
    setTimeout(() => controller.abort(), 20)
    const { projected } = await runNew(
      new BashTool({ getToolOutputsDir: () => dir, createOperations: () => ops }),
      { command: 'sleep 100' },
      { dir, signal: controller.signal },
    )

    expect(projected.success).toBe(false)
    expect(projected.aborted).toBe(true)
    expect(projected.error).toContain('Tool execution was cancelled.')
    expect(projected.error).toContain('<partial_output>')
    expect(projected.error).toContain('partial')
  })

  it('failed → { success:false, error }', async () => {
    const dir = await tempDir()
    const { projected } = await runNew(new ReadTool({}), { path: 'missing.txt' }, { dir })
    expect(projected.success).toBe(false)
    expect(projected.error).toContain('File not found')
    expect(projected.aborted).toBeUndefined()
  })
})

// ── 回调与纯函数 ────────────────────────────────────────────────────────────

describe('IpcProjector · 回调转发', () => {
  it('annotate → onMetadata,partial → onPartialResult,step → onStepStart/Complete', async () => {
    const seen: string[] = []
    const projector = new IpcProjector({
      onMetadata: update => seen.push(`metadata:${update.title ?? '-'}`),
      onPartialResult: () => seen.push('partial'),
      onStepStart: step => seen.push(`start:${step.id}`),
      onStepComplete: step => seen.push(`complete:${step.id}:${step.status}`),
    }, { now: () => 1_000 })

    const invocation = invocationFor('bash', {})
    projector.on(invocation, { type: 'step', phase: 'start', id: 'spawn', title: 'spawn' })
    projector.on(invocation, { type: 'partial', result: textResult('line') })
    projector.on(invocation, { type: 'annotate', title: 'Bash', details: { exitCode: 0 } })
    projector.on(invocation, { type: 'step', phase: 'end', id: 'spawn' })
    // 旧契约里没有出口的两条:静默略过,而不是给渲染器发明一个字段。
    projector.on(invocation, { type: 'progress', message: 'half way' })

    expect(seen).toEqual(['start:test-call:spawn', 'partial', 'metadata:Bash', 'complete:test-call:spawn:completed'])
  })

  it('收尾时那条只带 metadata 的 annotate 不会把标题清空', () => {
    const projector = new IpcProjector()
    const invocation = invocationFor('write', {})
    projector.on(invocation, { type: 'annotate', title: 'a.txt', details: { path: '/a.txt' } })
    projector.on(invocation, { type: 'annotate', details: { path: '/a.txt', auditId: 'x' } })
    expect(projector.title).toBe('a.txt')
  })

  it('step 的 id 带上 callId —— 渲染器的 step 流是跨调用的', () => {
    const step = stepFromEvent(
      { type: 'step', phase: 'end', id: 'spawn', error: 'boom' },
      invocationFor('bash', {}),
      1_000,
    )
    expect(step).toEqual({
      id: 'test-call:spawn',
      type: 'tool-call',
      title: 'bash',
      status: 'failed',
      timestamp: 1_000,
      toolCallId: 'test-call',
      error: 'boom',
    })
  })

  it('splitResultContent 是 toolResultToStructured 的逆运算', () => {
    expect(splitResultContent({
      content: [
        { type: 'text', text: 'line 1' },
        { type: 'text', text: 'line 2' },
        { type: 'image', path: '/tmp/a.png', data: 'BASE64', mimeType: 'image/png' },
        { type: 'file', path: '/tmp/a.txt' },
      ],
      details: { kept: true },
    })).toEqual({
      output: 'line 1\nline 2',
      attachments: [
        { type: 'image', path: '/tmp/a.png', content: 'BASE64', mimeType: 'image/png' },
        { type: 'file', path: '/tmp/a.txt', mimeType: undefined },
      ],
      metadata: { kept: true },
    })
  })

  it('terminate 透传(N6:工具要求本回合收束)', () => {
    const projector = new IpcProjector()
    const projected = projector.toExecutionResult(
      Outcome.ok({ content: [{ type: 'text', text: 'done' }], terminate: true }),
    )
    expect(projected).toMatchObject({ success: true, terminate: true })
  })
})

// ── 后台 job 的端口在这条路上也走得通 ────────────────────────────────────────

describe('IpcProjector · bash 后台句柄', () => {
  it('spawned 事件不进旧回调,但 job 的字段照样出现在 output 里', async () => {
    const dir = await tempDir()
    const spawned: JobSpec[] = []
    const jobs: JobRegistry = {
      async spawn(spec) {
        spawned.push(spec)
        const job: Job = {
          id: 'bg-1',
          owner: spec.owner,
          status: 'running',
          label: spec.label,
          log: '/tmp/bg-1.log',
          metadata: { pid: 4242 },
          events: async function* () {},
          kill: async () => {},
        }
        return job
      },
      get: () => undefined,
      list: () => [],
    }

    const ops: BashOperations = { exec: async () => ({ exitCode: 0 }) }
    const { projected } = await runNew(
      new BashTool({ getToolOutputsDir: () => dir, createOperations: () => ops }),
      { command: 'npm run dev', run_in_background: true },
      { dir, jobs },
    )

    const data = projected.data as { output: string }
    expect(data.output).toContain('Started background job bg-1')
    expect(data.output).toContain('Background job: bg-1 (pid 4242)')
    expect(data.output).toContain('Log file: /tmp/bg-1.log')
    expect(spawned[0]?.owner).toEqual({ sessionId: 'test-session', toolCallId: 'test-call' })
  }, 10_000)
})
