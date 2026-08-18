/**
 * R1 对拍 —— `bash`。旧 `tools/builtin/bash.ts` vs 新 `toolkit/builtin/bash.ts`。
 *
 * 两边共用同一个假 `BashOperations`,所以比的是工具壳与三态判定,不是子进程。
 * 假执行器**同时**满足新旧两条判据:旧路靠 `options.timeout` 抛 `timeout:<ms>`,
 * 新路靠 `options.signal`(来自 `ctx.abort.child({timeoutMs})`)—— 这正是这次移植
 * 要证明的事:同一条命令、同一个结局,旧的靠字符串,新的靠作用域。
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createToolAbortError, isToolAbortError } from '@onething/core/tools'
import { createBashTool as createLegacyBashTool } from '../../../tools/builtin/bash.js'
import type { BashOperations } from '../../../tools/bash-executor.js'
import { zodToJsonSchema } from '../../../tools/tool.js'
import { createBashTool, BashInputSchema } from '../../builtin/bash.js'
import { Outcome } from '@onething/core/toolkit'
import type { Job, JobRegistry, JobSpec } from '@onething/core/toolkit'
import {
  annotationsOf,
  legacyContext,
  modelTextOf,
  normalizeEffects,
  partialsOf,
  runNewTool,
} from '../support.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'toolkit-bash-'))
  dirs.push(await fs.realpath(dir))
  return dirs[dirs.length - 1]
}

interface Script {
  chunks?: string[]
  exitCode?: number | null
  hangMs?: number
  backgroundJobIds?: string[]
}

function fakeOps(script: Script): BashOperations {
  return {
    exec: async (_command, _cwd, { onData, signal, timeout }) => {
      for (const chunk of script.chunks ?? []) onData(Buffer.from(chunk))
      if (script.hangMs) {
        await new Promise<void>((resolve, reject) => {
          const finish = setTimeout(resolve, script.hangMs)
          const deadline = timeout !== undefined && timeout > 0
            ? setTimeout(() => {
                clearTimeout(finish)
                reject(new Error(`timeout:${timeout}`))
              }, timeout)
            : undefined
          signal?.addEventListener('abort', () => {
            clearTimeout(finish)
            if (deadline) clearTimeout(deadline)
            reject(createToolAbortError('aborted'))
          }, { once: true })
        })
      }
      if (signal?.aborted) throw createToolAbortError('aborted')
      return { exitCode: script.exitCode ?? 0, backgroundJobIds: script.backgroundJobIds }
    },
    execBackground: async () => ({ jobId: 'job-parity-1', pid: 4242, logPath: '/tmp/job-parity-1.log' }),
  }
}

/**
 * 后台分离的端口(R2a 决定 B5:`ProcessTool` 现在只认 `ctx.jobs.spawn`)。
 *
 * 这里包的是**同一个假执行器**,所以新旧两条路仍然拿到同一个 jobId / pid /
 * 日志路径,句柄文本可以逐字对拍。真正的 `BackgroundJobRegistry`(包
 * `tools/background-jobs.ts` + 真 spawn)有它自己的测试,住在装配层
 * (`app/toolkit/__tests__/jobs.test.ts`)—— 产品层的测试不认识装配层。
 */
function fakeJobRegistry(ops: BashOperations): JobRegistry {
  const jobs = new Map<string, Job>()
  return {
    async spawn(spec: JobSpec): Promise<Job> {
      const launch = await ops.execBackground!(spec.command ?? '', spec.cwd ?? '')
      const job: Job = {
        id: launch.jobId,
        owner: spec.owner,
        status: 'running',
        label: spec.label,
        log: launch.logPath,
        metadata: { pid: launch.pid },
        events: async function* () {},
        kill: async () => {},
      }
      jobs.set(job.id, job)
      return job
    },
    get: id => jobs.get(id),
    list: () => [...jobs.values()],
  }
}

async function pair(script: Script) {
  const outputs = await tempDir()
  const ops = fakeOps(script)
  const adapters = {
    getToolOutputsDir: () => outputs,
    createOperations: () => ops,
  }
  return {
    outputs,
    legacyTool: createLegacyBashTool(adapters),
    newTool: createBashTool(adapters),
    jobs: fakeJobRegistry(ops),
  }
}

async function bothRuns(script: Script, args: Record<string, unknown>, dir: string) {
  const { legacyTool, newTool, jobs } = await pair(script)
  const options = { workingDirectory: dir, workingDirectoryRoots: [dir], jobs }
  const { ctx, record } = legacyContext(options)
  const legacy = await (async () => {
    try {
      const analysis = await Promise.resolve(legacyTool.analyze!(args as never, ctx as never))
      ctx.approvedAnalysis = analysis
      const result = await legacyTool.execute(args as never, ctx as never)
      return { analysis, result, error: undefined }
    } catch (error) {
      return { analysis: undefined, result: undefined, error: error as Error }
    }
  })()
  const run = await runNewTool(newTool, args, options)
  return { legacy, record, run }
}

describe('parity: bash', () => {
  it('spec is pinned to the legacy tool', async () => {
    const { legacyTool, newTool } = await pair({})
    expect(newTool.spec.description).toBe(legacyTool.description)
    expect(newTool.spec.input).toEqual(zodToJsonSchema(BashInputSchema))
    expect(newTool.spec.input).toEqual(zodToJsonSchema(legacyTool.parameters))
    expect(newTool.spec.concurrency).toBe('sequential')
    expect(newTool.spec.presentation.kind).toBe('bash')
    expect([...newTool.spec.effects].sort()).toEqual(['bash', 'external_directory'])
  })

  it('normal: a successful command matches output, title and metadata', async () => {
    const dir = await tempDir()
    const { legacy, record, run } = await bothRuns(
      { chunks: ['hello\n'], exitCode: 0 }, { command: 'echo hello' }, dir,
    )

    expect(modelTextOf(run.outcome)).toBe(legacy.result!.output)
    expect(modelTextOf(run.outcome)).toBe('hello\n')
    // (b) 白名单命令不报效果 —— 空 effects 在策略门那边等于直接放行
    expect(normalizeEffects(run.intent.effects)).toEqual(normalizeEffects(legacy.analysis!.effects))
    expect(run.intent.effects).toEqual([])
    expect(run.intent.preview).toEqual(legacy.analysis!.preview)
    // (d) 标题与 metadata
    const titles = annotationsOf(run).map(entry => entry.title)
    expect(titles).toContain(record.metadataCalls[0]?.title)
    expect(titles).toContain(legacy.result!.title)
    expect(annotationsOf(run).at(-1)?.details).toEqual(legacy.result!.metadata)
    // 流式:输出经过 partial 事件
    expect(partialsOf(run).some(result => result.content[0]?.text === 'hello\n')).toBe(true)
  })

  it('boundary: a non-zero exit appends the same <bash_metadata> block', async () => {
    const dir = await tempDir()
    const { legacy, run } = await bothRuns(
      { chunks: ['boom\n'], exitCode: 2 }, { command: 'echo boom' }, dir,
    )
    expect(modelTextOf(run.outcome)).toBe(legacy.result!.output)
    expect(modelTextOf(run.outcome)).toContain('<bash_metadata>\nExit code: 2\n</bash_metadata>')
  })

  it('boundary: output truncation appends the same note and spills to the same dir', async () => {
    const dir = await tempDir()
    const big = `${'x'.repeat(120)}\n`.repeat(400)
    const { legacy, run } = await bothRuns(
      { chunks: [big], exitCode: 0 }, { command: 'cat big.txt' }, dir,
    )
    expect(legacy.result!.output).toContain('Output truncated (')
    // spill 路径是随机名,比到"除路径外逐字相同"为止。
    const strip = (text: string) => text.replace(/Full output saved to: .*\n/, 'Full output saved to: <path>\n')
    expect(strip(modelTextOf(run.outcome))).toBe(strip(legacy.result!.output))
  })

  it('boundary: run_in_background returns the same handle text', async () => {
    const dir = await tempDir()
    const { legacy, run } = await bothRuns(
      {}, { command: 'npm run dev', run_in_background: true }, dir,
    )
    expect(modelTextOf(run.outcome)).toBe(legacy.result!.output)
    expect(modelTextOf(run.outcome)).toContain('Background job: job-parity-1 (pid 4242)')
    // 分离执行体也进了事件流,归属由系统填(工具连 owner 参数都拿不到)。
    const spawned = run.events.find(event => event.type === 'spawned')
    expect(spawned).toMatchObject({
      type: 'spawned',
      job: {
        id: 'job-parity-1',
        log: '/tmp/job-parity-1.log',
        owner: { sessionId: 'test-session', toolCallId: 'test-call' },
        metadata: { pid: 4242 },
      },
    })
  })

  it('permission input: an ask-classified command reports the same bash effect', async () => {
    const dir = await tempDir()
    const { legacy, run } = await bothRuns({ exitCode: 0 }, { command: 'rm -rf ./dist' }, dir)
    expect(normalizeEffects(run.intent.effects)).toEqual(normalizeEffects(legacy.analysis!.effects))
    expect(run.intent.preview).toEqual(legacy.analysis!.preview)
    expect(legacy.analysis!.effects[0]?.kind).toBe('bash')
  })

  it('permission input: a cd outside the sandbox reports external_directory identically', async () => {
    const dir = await tempDir()
    const { legacyTool, newTool } = await pair({ exitCode: 0 })
    const args = { command: 'cd /outside/project && find . -type f' }
    const options = { workingDirectory: dir, workingDirectoryRoots: [dir] }
    const { ctx } = legacyContext(options)
    const analysis = await legacyTool.analyze!(args as never, ctx as never)
    const run = await runNewTool(newTool, args, options)

    expect(normalizeEffects(run.intent.effects)).toEqual(normalizeEffects(analysis.effects))
    expect(analysis.effects[0]).toMatchObject({ kind: 'external_directory', external: true })
  })

  it('error: a forbidden command fails with the same message', async () => {
    const dir = await tempDir()
    const { legacy, run } = await bothRuns({ exitCode: 0 }, { command: 'rm -rf /' }, dir)
    expect(legacy.error).toBeInstanceOf(Error)
    expect(run.outcome.kind).toBe('failed')
    expect(run.outcome.kind === 'failed' && run.outcome.message).toBe(legacy.error!.message)
  })

  it('error: a timeout appends the same <bash_metadata> block and exit -1', async () => {
    const dir = await tempDir()
    const { legacy, run } = await bothRuns(
      { chunks: ['starting\n'], hangMs: 5_000 }, { command: 'sleep 100', timeout: 50 }, dir,
    )
    expect(modelTextOf(run.outcome)).toBe(legacy.result!.output)
    expect(modelTextOf(run.outcome)).toContain('<bash_metadata>\nCommand timed out after 50 ms\n</bash_metadata>')
    expect(annotationsOf(run).at(-1)?.details).toEqual(legacy.result!.metadata)
    expect(legacy.result!.metadata.exitCode).toBe(-1)
  })

  it('error: illegal arguments reuse the tool-specific wording', async () => {
    const dir = await tempDir()
    const { legacyTool, newTool } = await pair({})
    const parsed = legacyTool.parameters.safeParse({ command: '' })
    const legacyMessage = legacyTool.formatValidationError!(parsed.success ? (undefined as never) : parsed.error)

    const run = await runNewTool(newTool, { command: '' }, { workingDirectory: dir })
    expect(run.outcome.kind).toBe('invalid')
    // R2a 决定③:invalid 的模型文本就是工具自己的文案,内核不再加
    // `Invalid tool input: ` 前缀 —— 所以这里比的是 toModelText,不是 message。
    expect(Outcome.toModelText(run.outcome)).toBe(legacyMessage)
    expect(legacyMessage).toContain('Invalid bash parameters:')
  })

  it('cancels mid-run: the new path is `aborted`, the old path throws an abort error', async () => {
    const dir = await tempDir()
    const { legacyTool, newTool } = await pair({ chunks: ['partial\n'], hangMs: 3_000 })
    const args = { command: 'sleep 100' }
    const options = { workingDirectory: dir, workingDirectoryRoots: [dir] }

    const legacyController = new AbortController()
    const { ctx } = legacyContext({ ...options, signal: legacyController.signal })
    ctx.approvedAnalysis = await legacyTool.analyze!(args as never, ctx as never)
    const legacyPromise = legacyTool.execute(args as never, ctx as never)
    setTimeout(() => legacyController.abort(), 20)
    const legacyError = await legacyPromise.then(() => undefined, (error: Error) => error)
    expect(legacyError && isToolAbortError(legacyError)).toBe(true)
    // 旧的把已收到的输出塞进了取消错误的消息里。
    expect(legacyError!.message).toContain('partial')

    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    const run = await runNewTool(newTool, args, { ...options, signal: controller.signal })

    expect(run.outcome.kind).toBe('aborted')
    // 部分输出照旧走 partial 事件流出去。
    expect(partialsOf(run).some(result => (result.content[0]?.text ?? '').includes('partial'))).toBe(true)
    // R2a 决定④:它同时被附在取消结局上 —— 旧路把它塞在错误消息里,新路给它一个
    // 有名字的字段,信息不丢,措辞与结局分家。
    expect(run.outcome.kind === 'aborted' && run.outcome.partial?.content[0]?.text).toContain('partial')
    expect(Outcome.toModelText(run.outcome)).toContain('<partial_output>')
    expect(Outcome.toModelText(run.outcome)).toContain('partial')
  })
})
