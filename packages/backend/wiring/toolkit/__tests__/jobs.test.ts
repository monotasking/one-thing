/**
 * R2a —— `BackgroundJobRegistry` 的钉子。**真 spawn**(echo + sleep),真日志文件,
 * 真 kill:这个端口的全部价值就是它包着的那张真表,拿假执行器测它等于什么都没测。
 *
 * 日志根指向临时目录(`configureCoreBackgroundJobs`),所以不碰用户的 store。
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JobEvent } from '@onething/core/toolkit'
import {
  clearBackgroundJobsForTests,
  configureCoreBackgroundJobs,
} from '@onething/runtime/tools/background-jobs'
import { createLocalBashOperations } from '@onething/runtime/tools/bash-executor'
import { BackgroundJobRegistry } from '../jobs.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-toolkit-jobs-'))
  dirs.push(await fs.realpath(dir))
  return dirs[dirs.length - 1]
}

function registryFor(): BackgroundJobRegistry {
  return new BackgroundJobRegistry({
    createOperations: options => createLocalBashOperations({ sessionId: options.sessionId }),
    pollIntervalMs: 50,
  })
}

async function settle(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

beforeEach(() => {
  clearBackgroundJobsForTests()
})

afterEach(async () => {
  clearBackgroundJobsForTests()
  configureCoreBackgroundJobs({})
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })))
})

describe('BackgroundJobRegistry', () => {
  it('spawn 起一个真进程:句柄带 id / 日志路径 / pid,归属由调用方填', async () => {
    const dir = await tempDir()
    configureCoreBackgroundJobs({ getLogRootDir: () => dir })

    const registry = registryFor()
    const job = await registry.spawn({
      owner: { sessionId: 'session-1', toolCallId: 'call-1' },
      label: 'dev server',
      command: 'echo hello && sleep 5',
      cwd: dir,
    })

    expect(job.id).toMatch(/^bg-\d+$/)
    expect(job.owner).toEqual({ sessionId: 'session-1', toolCallId: 'call-1' })
    expect(job.label).toBe('dev server')
    expect(typeof job.log).toBe('string')
    expect(Number(job.metadata?.pid)).toBeGreaterThan(0)

    await job.kill()
  })

  it('events():日志增量读 + 状态轮询,进程被停掉时以一条 exit 收尾', async () => {
    const dir = await tempDir()
    configureCoreBackgroundJobs({ getLogRootDir: () => dir })

    const registry = registryFor()
    const job = await registry.spawn({
      owner: { sessionId: 'session-1', toolCallId: 'call-1' },
      command: 'echo hello && sleep 30',
      cwd: dir,
    })

    // 让进程有机会吐出启动输出。
    await settle(400)

    const events: JobEvent[] = []
    const drain = (async () => {
      for await (const event of job.events()) {
        events.push(event)
        if (event.type === 'exit') break
      }
    })()

    await settle(300)
    await job.kill()
    await drain

    expect(events.some(event => event.type === 'output' && event.chunk.includes('hello'))).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'exit', status: 'killed' })
  }, 20_000)

  it('kill 把状态翻成 killed', async () => {
    const dir = await tempDir()
    configureCoreBackgroundJobs({ getLogRootDir: () => dir })

    const registry = registryFor()
    const job = await registry.spawn({
      owner: { sessionId: 'session-1', toolCallId: 'call-1' },
      command: 'sleep 30',
      cwd: dir,
    })
    await settle(300)
    expect(job.status).toBe('running')

    await job.kill()
    expect(job.status).toBe('killed')
  }, 20_000)

  it('list(owner) 按 sessionId 过滤 —— 别的会话的 job 不在这一份清单里', async () => {
    const dir = await tempDir()
    configureCoreBackgroundJobs({ getLogRootDir: () => dir })

    const registry = registryFor()
    const mine = await registry.spawn({
      owner: { sessionId: 'session-1', toolCallId: 'call-1' },
      command: 'sleep 30',
      cwd: dir,
    })
    const theirs = await registry.spawn({
      owner: { sessionId: 'session-2', toolCallId: 'call-2' },
      command: 'sleep 30',
      cwd: dir,
    })
    await settle(300)

    expect(registry.list({ sessionId: 'session-1' }).map(job => job.id)).toEqual([mine.id])
    expect(registry.list({ sessionId: 'session-2' }).map(job => job.id)).toEqual([theirs.id])
    expect(registry.list().map(job => job.id).sort()).toEqual([mine.id, theirs.id].sort())
    // toolCallId 也过滤:同一个会话里两次调用各管各的后台进程。
    expect(registry.list({ sessionId: 'session-1', toolCallId: 'call-2' })).toEqual([])

    await Promise.all([mine.kill(), theirs.kill()])
  }, 20_000)

  it('get(id) 拿得回同一个句柄;不认识的 id 是 undefined', async () => {
    const dir = await tempDir()
    configureCoreBackgroundJobs({ getLogRootDir: () => dir })

    const registry = registryFor()
    const job = await registry.spawn({
      owner: { sessionId: 'session-1', toolCallId: 'call-1' },
      command: 'sleep 30',
      cwd: dir,
    })
    expect(registry.get(job.id)).toBe(job)
    expect(registry.get('bg-does-not-exist')).toBeUndefined()
    await job.kill()
  }, 20_000)

  it('缺 command / cwd 时报一句人话,而不是 spawn 一个空壳', async () => {
    const registry = registryFor()
    await expect(registry.spawn({ owner: { sessionId: 's', toolCallId: 'c' } }))
      .rejects.toThrow(/needs a command/)
    await expect(registry.spawn({ owner: { sessionId: 's', toolCallId: 'c' }, command: 'ls' }))
      .rejects.toThrow(/needs a working directory/)
  })

  it('执行器不支持后台时报一句人话', async () => {
    const registry = new BackgroundJobRegistry({
      createOperations: () => ({ exec: async () => ({ exitCode: 0 }) }),
    })
    await expect(registry.spawn({
      owner: { sessionId: 's', toolCallId: 'c' },
      command: 'ls',
      cwd: '/tmp',
    })).rejects.toThrow(/Background execution is not supported/)
  })
})
