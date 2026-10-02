/**
 * 插件在 onDispose 里存盘(收官修复)。
 *
 * 这是**第三方插件必踩、内置插件恰好绕开**的一条:内置插件只在 onDispose 里关流,
 * 所以整套测试都是绿的,而任何想"收尾时把状态存下来"的插件都会撞上拆除闩,
 * 数据静默丢失,报的错还把排查引向"插件已拆除"。
 *
 * 用例刻意走**真 API**(createPluginAPI → api.onDispose → api.storage/api.store),
 * 不用裸句柄手搓 state —— 上一版就是那样写的,于是把三个源文件全回退它照样全绿,
 * 一条没有判别力的测试。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { PluginState } from '../api.js'

const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-ondispose-'))
const previousStorePath = process.env.ONETHING_STORE_PATH
process.env.ONETHING_STORE_PATH = storeRoot
const cleanups: Array<() => Promise<void>> = []

function ownState(state: PluginState, expectedError?: Error) {
  cleanups.push(async () => {
    const { disposePlugin, drainPlugin } = await import('../api.js')
    disposePlugin(state)
    if (expectedError) await expect(drainPlugin(state)).rejects.toBe(expectedError)
    else await drainPlugin(state)
  })
}

afterAll(async () => {
  try {
    const results = await Promise.allSettled(cleanups.map(cleanup => cleanup()))
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Plugin test cleanup failed')
    fs.rmSync(storeRoot, { recursive: true, force: true })
  } finally {
    if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
    else process.env.ONETHING_STORE_PATH = previousStorePath
  }
})

const bus = { emitGlobal: () => {}, onGlobal: () => () => {}, onAnySession: () => () => {} }

describe('onDispose persistence through the real plugin API', () => {
  it('lets a plugin write through BOTH storage and the KV store while tearing down', async () => {
    const { createPluginAPI, disposePlugin } = await import('../api.js')
    const { api, state } = createPluginAPI('closer', bus as never, {} as never)
    ownState(state)

    const failures: Record<string, unknown> = {}
    api.onDispose(() => {
      // 两个写面都要能用 —— 插件用哪一半就在哪一半丢数据,只开一半等于没修。
      try {
        api.storage.writeJson('final.json', { closedAt: 1 })
      } catch (error) {
        failures.storage = error
      }
      try {
        api.store.set('lastSeen', 42)
      } catch (error) {
        failures.store = error
      }
    })

    disposePlugin(state)

    expect(failures.storage, `storage.writeJson was rejected: ${String(failures.storage)}`).toBeUndefined()
    expect(failures.store, `store.set was rejected: ${String(failures.store)}`).toBeUndefined()

    // 真的落盘了 —— 不是"没抛错"就算数(KV 那侧只 console.error 不抛,
    // 光看异常永远发现不了它在丢数据)。P1 之后住家目录(§7.1)。
    const homeDir = path.join(storeRoot, 'plugins', 'closer')
    expect(JSON.parse(fs.readFileSync(path.join(homeDir, 'storage', 'final.json'), 'utf-8'))).toEqual({ closedAt: 1 })

    const kvPath = path.join(homeDir, 'kv.json')
    expect(fs.existsSync(kvPath), 'the KV write must reach disk, not just avoid throwing').toBe(true)
    expect(JSON.parse(fs.readFileSync(kvPath, 'utf-8'))).toMatchObject({ lastSeen: 42 })
  })

  it('still refuses both write faces once teardown has finished', async () => {
    const { createPluginAPI, disposePlugin } = await import('../api.js')
    const { api, state } = createPluginAPI('late-writer', bus as never, {} as never)
    ownState(state)

    disposePlugin(state)

    // 窗口关上之后照旧拒绝:晚到的异步回调不该把已归档的目录复活成鬼目录。
    expect(() => api.storage.writeJson('too-late.json', {})).toThrow()
    api.store.set('too-late', 1)

    const homeDir = path.join(storeRoot, 'plugins', 'late-writer')
    expect(fs.existsSync(path.join(homeDir, 'storage', 'too-late.json'))).toBe(false)
    const kvPath = path.join(homeDir, 'kv.json')
    if (fs.existsSync(kvPath)) {
      expect(JSON.parse(fs.readFileSync(kvPath, 'utf-8'))).not.toHaveProperty('too-late')
    }
  })

  it('waits for async cleanup, saves both write faces after an await, and closes them exactly once', async () => {
    const { createPluginAPI, disposePlugin, drainPlugin } = await import('../api.js')
    const { api, state } = createPluginAPI('async-closer', bus as never, {} as never)
    ownState(state)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    api.onDispose(async () => {
      calls++
      await gate
      api.storage.writeJson('final.json', { saved: true })
      api.store.set('final', 7)
    })
    disposePlugin(state)
    disposePlugin(state)
    let drained = false
    const completion = drainPlugin(state).then(() => { drained = true })
    try {
      await Promise.resolve()
      expect(calls).toBe(1)
      expect(drained).toBe(false)
      expect(fs.existsSync(path.join(storeRoot, 'plugins/async-closer/storage/final.json'))).toBe(false)
    } finally { release() }
    await completion
    const home = path.join(storeRoot, 'plugins/async-closer')
    expect(JSON.parse(fs.readFileSync(path.join(home, 'storage/final.json'), 'utf8'))).toEqual({ saved: true })
    expect(JSON.parse(fs.readFileSync(path.join(home, 'kv.json'), 'utf8'))).toMatchObject({ final: 7 })
    expect(() => api.storage.writeJson('late.json', {})).toThrow()
    api.store.set('final', 99)
    expect(JSON.parse(fs.readFileSync(path.join(home, 'kv.json'), 'utf8'))).toMatchObject({ final: 7 })
  })

  it('keeps the first cleanup failure but waits for another callback to finish saving', async () => {
    const { createPluginAPI, disposePlugin, drainPlugin } = await import('../api.js')
    const { api, state } = createPluginAPI('failed-closer', bus as never, {} as never)
    const failure = new Error('first cleanup failed')
    ownState(state, failure)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    api.onDispose(() => { throw failure })
    api.onDispose(async () => {
      await gate
      api.storage.writeJson('other-cleanup.json', { saved: true })
    })
    disposePlugin(state)
    let drained = false
    const completion = drainPlugin(state).then(
      () => { drained = true; return undefined },
      error => { drained = true; return error },
    )
    try {
      await Promise.resolve()
      expect(drained).toBe(false)
    } finally { release() }
    expect(await completion).toBe(failure)
    expect(JSON.parse(fs.readFileSync(path.join(storeRoot, 'plugins/failed-closer/storage/other-cleanup.json'), 'utf8'))).toEqual({ saved: true })
    expect(() => api.storage.writeJson('late.json', {})).toThrow()
    await expect(drainPlugin(state)).rejects.toBe(failure)
  })
})
