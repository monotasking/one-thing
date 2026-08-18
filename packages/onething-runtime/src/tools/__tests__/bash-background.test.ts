import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  clearBackgroundJobsForTests,
  configureCoreBackgroundJobs,
  listBackgroundJobs,
  readBackgroundJobOutput,
  registerBackgroundJob,
  stopBackgroundJob,
} from '../background-jobs.js'
import { createLocalBashOperations } from '../bash-executor.js'
import { createBashTool } from '../builtin/bash.js'
import type { ToolContext } from '../tool.js'

let outputRoot = ''
let cwd = ''

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 's1',
    messageId: 'm1',
    toolCallId: 'tc1',
    workingDirectory: cwd,
    metadata: () => {},
    ...overrides,
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('bash background jobs', () => {
  beforeEach(async () => {
    outputRoot = await makeTempDir('onething-bash-bg-outputs-')
    cwd = await makeTempDir('onething-bash-bg-cwd-')
    configureCoreBackgroundJobs({ getLogRootDir: () => outputRoot })
    clearBackgroundJobsForTests()
  })

  afterEach(async () => {
    for (const job of listBackgroundJobs({ includeInactive: true })) {
      if (job.status === 'running') stopBackgroundJob(job.id)
    }
    clearBackgroundJobsForTests()
    configureCoreBackgroundJobs()
    await fs.rm(outputRoot, { recursive: true, force: true })
    await fs.rm(cwd, { recursive: true, force: true })
  })

  it('readBackgroundJobOutput reads incrementally and advances the cursor', async () => {
    const logPath = path.join(outputRoot, 'job.log')
    await fs.writeFile(logPath, 'first chunk\n')
    const job = registerBackgroundJob({
      command: 'fake-service',
      cwd,
      shellPid: 0,
      pgid: 0,
      childPids: [],
      logPath,
    })

    const first = readBackgroundJobOutput(job.id)
    expect(first?.output).toContain('first chunk')

    const nothingNew = readBackgroundJobOutput(job.id)
    expect(nothingNew?.output).toBe('')

    await fs.appendFile(logPath, 'second chunk\n')
    const second = readBackgroundJobOutput(job.id)
    expect(second?.output).toContain('second chunk')
    expect(second?.output).not.toContain('first chunk')

    const fromStart = readBackgroundJobOutput(job.id, { fromStart: true })
    expect(fromStart?.output).toContain('first chunk')
    expect(fromStart?.output).toContain('second chunk')

    expect(readBackgroundJobOutput('bg-unknown')).toBeUndefined()
  })

  it('execBackground launches a managed job whose log keeps receiving output', async () => {
    const ops = createLocalBashOperations()
    expect(ops.execBackground).toBeDefined()

    const launch = await ops.execBackground!(
      'echo started; sleep 0.3; echo later-output; sleep 30',
      cwd,
    )
    expect(launch.jobId).toMatch(/^bg-/)
    expect(launch.pid).toBeGreaterThan(0)

    await wait(150)
    const early = readBackgroundJobOutput(launch.jobId, { fromStart: true })
    expect(early?.output).toContain('started')
    expect(early?.job.status).toBe('running')

    await wait(400)
    const later = readBackgroundJobOutput(launch.jobId)
    expect(later?.output).toContain('later-output')

    stopBackgroundJob(launch.jobId)
  })

  it('bash tool run_in_background returns immediately with a job id and startup output', async () => {
    const tool = createBashTool({
      getToolOutputsDir: () => outputRoot,
      createOperations: () => createLocalBashOperations(),
    })

    const result = await tool.execute(
      { command: 'echo booting; sleep 30', run_in_background: true },
      makeCtx(),
    )

    expect(result.metadata.backgroundJobIds).toHaveLength(1)
    const jobId = result.metadata.backgroundJobIds![0]
    expect(result.output).toContain(`Background job: ${jobId}`)
    expect(result.output).toContain('booting')
    expect(result.title).toContain('background')

    stopBackgroundJob(jobId)
  })

  it('a background launch tells the model the log path and pid, and the job can be read and stopped', async () => {
    const ops = createLocalBashOperations()
    const launch = await ops.execBackground!('echo hello-from-job; sleep 30', cwd)
    await wait(150)

    // 没有 bash_output / kill_bash 了(2026-08-18):读日志与停任务并回 bash 本身,
    // 所以启动结果必须把日志路径与 pid 都交给模型。
    const read = readBackgroundJobOutput(launch.jobId, { fromStart: true })
    expect(read?.output).toContain('hello-from-job')
    expect(read?.job.status).toBe('running')
    expect(launch.logPath).toBeTruthy()
    expect(launch.pid).toBeGreaterThan(0)

    expect(stopBackgroundJob(launch.jobId)).toBe(true)
    expect(listBackgroundJobs({ includeInactive: true }).find(job => job.id === launch.jobId)?.status).toBe('killed')
  })
})
