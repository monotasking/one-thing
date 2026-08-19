/**
 * `bash` 的行为金标(R1 起的对拍 suite,R4b 转成金标 —— 见 time.test.ts 的
 * 头注释)。
 *
 * 假 `BashOperations` 让钉住的是工具壳与三态判定,不是子进程。超时靠
 * `options.signal`(来自 `ctx.abort.child({timeoutMs})`)—— 旧路靠
 * `options.timeout` 抛 `timeout:<ms>` 字符串,那条判据随旧工具删除,假执行器
 * 两条都留着(多留一条不影响新路)。
 */

import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createToolAbortError } from '@onething/core/tools'
import type { BashOperations } from '../../../tools/bash-executor.js'
import { zodToJsonSchema } from '../../contract.js'
import { createBashTool, BashInputSchema } from '../../builtin/bash.js'
import { Outcome } from '@onething/core/toolkit'
import type { Job, JobRegistry, JobSpec } from '@onething/core/toolkit'
import {
  annotationsOf,
  modelTextOf,
  partialsOf,
  redactPaths,
  redactText,
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
    newTool: createBashTool(adapters),
    jobs: fakeJobRegistry(ops),
  }
}

async function runBash(script: Script, args: Record<string, unknown>, dir: string) {
  const { newTool, jobs } = await pair(script)
  return runNewTool(newTool, args, { workingDirectory: dir, workingDirectoryRoots: [dir], jobs })
}

describe('golden: bash', () => {
  it('spec 钉住', async () => {
    const { newTool } = await pair({})
    expect(newTool.spec.description).toMatchSnapshot('description')
    expect(newTool.spec.input).toEqual(zodToJsonSchema(BashInputSchema))
    expect(newTool.spec.concurrency).toBe('sequential')
    expect(newTool.spec.presentation.kind).toBe('bash')
    expect([...newTool.spec.effects].sort()).toEqual(['bash', 'external_directory'])
  })

  it('normal: a successful command — output, title and metadata', async () => {
    const dir = await tempDir()
    const run = await runBash({ chunks: ['hello\n'], exitCode: 0 }, { command: 'echo hello' }, dir)

    expect(modelTextOf(run.outcome)).toBe('hello\n')
    // 白名单命令不报效果 —— 空 effects 在策略门那边等于直接放行
    expect(run.intent.effects).toEqual([])
    expect(redactPaths(run.intent.preview, dir)).toMatchSnapshot('preview')
    // 标题与 metadata
    expect(redactPaths(annotationsOf(run).map(entry => entry.title), dir)).toMatchSnapshot('annotation titles')
    expect(redactPaths(annotationsOf(run).at(-1)?.details, dir)).toMatchSnapshot('metadata')
    // 流式:输出经过 partial 事件
    expect(partialsOf(run).some(result => result.content[0]?.text === 'hello\n')).toBe(true)
  })

  it('boundary: a non-zero exit appends the same <bash_metadata> block', async () => {
    const dir = await tempDir()
    const run = await runBash({ chunks: ['boom\n'], exitCode: 2 }, { command: 'echo boom' }, dir)
    expect(redactText(modelTextOf(run.outcome), dir)).toMatchSnapshot('model text')
    expect(modelTextOf(run.outcome)).toContain('<bash_metadata>\nExit code: 2\n</bash_metadata>')
  })

  it('boundary: output truncation appends the note and spills to a file', async () => {
    const dir = await tempDir()
    const big = `${'x'.repeat(120)}\n`.repeat(400)
    const run = await runBash({ chunks: [big], exitCode: 0 }, { command: 'cat big.txt' }, dir)
    const text = modelTextOf(run.outcome)
    expect(text).toContain('Output truncated (')
    // spill 路径是随机名,钉的是"除路径外逐字相同"。
    const strip = (value: string) => value.replace(/Full output saved to: .*\n/, 'Full output saved to: <path>\n')
    expect(strip(text).slice(-400)).toMatchSnapshot('truncation tail')
  })

  it('boundary: run_in_background returns the same handle text', async () => {
    const dir = await tempDir()
    const run = await runBash({}, { command: 'npm run dev', run_in_background: true }, dir)
    expect(redactText(modelTextOf(run.outcome), dir)).toMatchSnapshot('handle text')
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

  it('permission input: an ask-classified command reports a bash effect', async () => {
    const dir = await tempDir()
    const run = await runBash({ exitCode: 0 }, { command: 'rm -rf ./dist' }, dir)
    expect(run.intent.effects[0]?.kind).toBe('bash')
    expect(redactPaths(run.intent.effects, dir)).toMatchSnapshot('effects')
    expect(redactPaths(run.intent.preview, dir)).toMatchSnapshot('preview')
  })

  it('permission input: a cd outside the sandbox reports external_directory', async () => {
    const dir = await tempDir()
    const run = await runBash({ exitCode: 0 }, { command: 'cd /outside/project && find . -type f' }, dir)
    expect(run.intent.effects[0]).toMatchObject({ kind: 'external_directory', external: true })
    expect(redactPaths(run.intent.effects, dir)).toMatchSnapshot('effects')
  })

  it('error: a forbidden command fails', async () => {
    const dir = await tempDir()
    const run = await runBash({ exitCode: 0 }, { command: 'rm -rf /' }, dir)
    expect(run.outcome.kind).toBe('failed')
    expect(redactText(run.outcome.kind === 'failed' ? run.outcome.message : '', dir))
      .toMatchSnapshot('forbidden command')
  })

  it('error: a timeout appends the <bash_metadata> block and exit -1', async () => {
    const dir = await tempDir()
    const run = await runBash(
      { chunks: ['starting\n'], hangMs: 5_000 }, { command: 'sleep 100', timeout: 50 }, dir,
    )
    expect(redactText(modelTextOf(run.outcome), dir)).toMatchSnapshot('model text')
    expect(modelTextOf(run.outcome)).toContain('<bash_metadata>\nCommand timed out after 50 ms\n</bash_metadata>')
    expect(redactPaths(annotationsOf(run).at(-1)?.details, dir)).toMatchSnapshot('metadata')
    expect((annotationsOf(run).at(-1)?.details as { exitCode?: number })?.exitCode).toBe(-1)
  })

  it('error: illegal arguments reuse the tool-specific wording', async () => {
    const dir = await tempDir()
    const { newTool } = await pair({})
    const run = await runNewTool(newTool, { command: '' }, { workingDirectory: dir })
    expect(run.outcome.kind).toBe('invalid')
    // R2a 决定③:invalid 的模型文本就是工具自己的文案,内核不再加
    // `Invalid tool input: ` 前缀 —— 所以这里钉的是 toModelText,不是 message。
    const text = Outcome.toModelText(run.outcome)
    expect(text).toContain('Invalid bash parameters:')
    expect(text).toMatchSnapshot('validation wording')
  })

  it('cancels mid-run: `aborted`, with the partial output attached', async () => {
    const dir = await tempDir()
    const { newTool } = await pair({ chunks: ['partial\n'], hangMs: 3_000 })
    const args = { command: 'sleep 100' }
    const options = { workingDirectory: dir, workingDirectoryRoots: [dir] }

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
