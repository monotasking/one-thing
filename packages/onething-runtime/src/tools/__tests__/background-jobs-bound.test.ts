import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const testPaths = vi.hoisted(() => ({
  toolOutputsDir: '',
}))

vi.mock('@onething/runtime/storage', () => ({
  getOnethingToolOutputsDir: () => testPaths.toolOutputsDir,
}))

import { createLocalBashOperations } from '../bash-executor.js'
import { clearBackgroundJobsForTests, listBackgroundJobs, stopBackgroundJob } from '../background-jobs-bound.js'
import { configureAppBackgroundJobs } from '../background-jobs-bound.js'

// Adapter wiring is an explicit assembly step now (no import-time config).
configureAppBackgroundJobs()


async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

async function listBackgroundLogFiles(): Promise<string[]> {
  try {
    const dir = path.join(testPaths.toolOutputsDir, 'background-jobs')
    return (await fs.readdir(dir))
      .filter(name => /^background-\d+-[a-z0-9]+\.log$/.test(name))
      .sort()
  } catch {
    return []
  }
}

describe('background bash jobs', () => {
  beforeEach(async () => {
    testPaths.toolOutputsDir = await makeTempDir('onething-bg-outputs-')
    clearBackgroundJobsForTests()
  })

  afterEach(async () => {
    for (const job of listBackgroundJobs({ includeInactive: true })) {
      if (job.status === 'running') stopBackgroundJob(job.id)
    }
    clearBackgroundJobsForTests()
    await fs.rm(testPaths.toolOutputsDir, { recursive: true, force: true })
  })

  it('does not leave background log files for foreground command output', async () => {
    const cwd = await makeTempDir('onething-bg-cwd-')
    const ops = createLocalBashOperations()
    const chunks: Buffer[] = []

    const result = await ops.exec('printf "hello\\n"', cwd, {
      onData: data => chunks.push(data),
      timeout: 5000,
    })

    expect(result.exitCode).toBe(0)
    expect(result.backgroundJobIds).toBeUndefined()
    expect(Buffer.concat(chunks).toString('utf-8')).toContain('hello')
    expect(await listBackgroundLogFiles()).toEqual([])
  })

  it('removes orphaned legacy background logs when jobs are listed', async () => {
    const logDir = path.join(testPaths.toolOutputsDir, 'background-jobs')
    const orphanLog = path.join(logDir, 'background-123456-abcdef.log')

    await fs.mkdir(logDir, { recursive: true })
    await fs.writeFile(orphanLog, 'orphaned startup output')

    expect(await listBackgroundLogFiles()).toEqual(['background-123456-abcdef.log'])
    expect(listBackgroundJobs({ includeInactive: true })).toEqual([])
    expect(await listBackgroundLogFiles()).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('registers and stops a detached background process group with a retained startup log', async () => {
    const cwd = await makeTempDir('onething-bg-cwd-')
    const ops = createLocalBashOperations()
    const chunks: Buffer[] = []

    const result = await ops.exec('printf "ready\\n"; sleep 30 &', cwd, {
      onData: data => chunks.push(data),
      timeout: 5000,
    })

    expect(result.exitCode).toBe(0)
    expect(result.backgroundJobIds?.length).toBe(1)
    expect(Buffer.concat(chunks).toString('utf-8')).toContain('ready')

    const [job] = listBackgroundJobs()
    expect(job).toBeDefined()
    expect(job.status).toBe('running')
    expect(job.childPids.length).toBeGreaterThan(0)
    expect(job.logPath).toBeTruthy()
    await expect(fs.readFile(job.logPath!, 'utf-8')).resolves.toContain('ready')
    expect(await listBackgroundLogFiles()).toHaveLength(1)
    expect(stopBackgroundJob(job.id)).toBe(true)
  })
})
