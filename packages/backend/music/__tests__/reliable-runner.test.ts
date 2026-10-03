import { describe, expect, it, vi } from 'vitest'
import {
  createOnethingMusicReliableRunner,
  OnethingMusicCommandError,
} from '../reliable-runner.js'
import type {
  OnethingMusicProcessResult,
  OnethingMusicProcessRunner,
} from '../types.js'

const ok = (stdout: string): OnethingMusicProcessResult => ({ code: 0, stdout, stderr: '' })

const playingState = (title = '岁月神偷', position = 12) =>
  JSON.stringify({ state: { status: 'playing', title, position, duration: 244, queueLength: 2 } })

function fakeRunner(script: Array<OnethingMusicProcessResult | Error>): {
  runner: OnethingMusicProcessRunner
  calls: string[][]
} {
  const calls: string[][] = []
  return {
    calls,
    runner: {
      async run(options) {
        calls.push(options.args ?? [])
        const next = script.shift()
        if (!next) throw new Error('script exhausted')
        if (next instanceof Error) throw next
        return next
      },
      spawn() {
        throw new Error('not used')
      },
    },
  }
}

const noSleep = () => Promise.resolve()

describe('music reliable runner', () => {
  it('treats a {success:false} envelope with exit 0 as failure', async () => {
    const { runner } = fakeRunner([
      ok('{"success": false, "message": "当前无播放进程，请先使用 play 命令开始播放"}'),
    ])
    const reliable = createOnethingMusicReliableRunner({ runner, sleep: noSleep })
    await expect(reliable.run('read', ['state'])).rejects.toThrow('当前无播放进程')
  })

  it('retries server commands twice and then succeeds', async () => {
    const { runner, calls } = fakeRunner([
      new Error('ETIMEDOUT'),
      new Error('ETIMEDOUT'),
      ok('{"code": 200, "data": {}}'),
    ])
    const reliable = createOnethingMusicReliableRunner({ runner, sleep: noSleep })
    await expect(reliable.run('server', ['search', 'song'])).resolves.toContain('200')
    expect(calls).toHaveLength(3)
  })

  it('gives read commands no retries', async () => {
    const { runner, calls } = fakeRunner([new Error('boom')])
    const reliable = createOnethingMusicReliableRunner({ runner, sleep: noSleep })
    await expect(reliable.run('read', ['state'])).rejects.toThrow('boom')
    expect(calls).toHaveLength(1)
  })

  it('runVerified accepts when the read-back agrees', async () => {
    const { runner, calls } = fakeRunner([
      ok('{"success": true}'), // pause
      ok(JSON.stringify({ state: { status: 'stopped', position: 42, queueLength: 1 } })), // paused = stopped + frozen position
    ])
    const reliable = createOnethingMusicReliableRunner({ runner, sleep: noSleep })
    const state = await reliable.runVerified(['pause'], now => now?.status === 'paused')
    expect(state?.status).toBe('paused')
    expect(calls).toEqual([['pause'], ['state']])
  })

  it('runVerified retries once when the command claims success but state disagrees', async () => {
    const { runner, calls } = fakeRunner([
      ok('{"success": true}'), // pause claims ok
      ok(playingState()), // …but still playing
      ok('{"success": true}'), // retry pause
      ok(JSON.stringify({ state: { status: 'stopped', position: 42, queueLength: 1 } })),
    ])
    const reliable = createOnethingMusicReliableRunner({ runner, sleep: noSleep })
    const state = await reliable.runVerified(['pause'], now => now?.status === 'paused')
    expect(state?.status).toBe('paused')
    expect(calls.map(args => args[0])).toEqual(['pause', 'state', 'pause', 'state'])
  })

  it('runVerified fails loudly when state never agrees', async () => {
    const { runner } = fakeRunner([
      ok('{"success": true}'),
      ok(playingState()),
      ok('{"success": true}'),
      ok(playingState()),
    ])
    const reliable = createOnethingMusicReliableRunner({ runner, sleep: noSleep })
    await expect(
      reliable.runVerified(['pause'], now => now?.status === 'paused'),
    ).rejects.toBeInstanceOf(OnethingMusicCommandError)
  })

  it('readState parses the paused-as-stopped tell', async () => {
    const { runner } = fakeRunner([
      ok(JSON.stringify({ state: { status: 'stopped', position: 7, queueLength: 1 } })),
    ])
    const reliable = createOnethingMusicReliableRunner({ runner, sleep: noSleep })
    await expect(reliable.readState()).resolves.toMatchObject({ status: 'paused', position: 7 })
  })

  it('backs off between retries via the injected sleep', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const { runner } = fakeRunner([new Error('x'), new Error('x'), ok('{"code":200}')])
    const reliable = createOnethingMusicReliableRunner({ runner, sleep })
    await reliable.run('server', ['user', 'history'])
    expect(sleep.mock.calls.map(call => call[0])).toEqual([500, 1000])
  })
})
