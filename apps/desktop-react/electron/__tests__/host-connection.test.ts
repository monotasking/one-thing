import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HostConnectionGate } from '../host-connection'

/**
 * **连接那一格是一个开窗之前就存在的承诺**(2026-09-15 启动次序)。
 *
 * 四条,对着 `host-connection.ts` 文件头那四句判词各钉一条:待定时不落地、
 * 落定后同一个 promise 给出那个值、第二次 resolve 被忽略、`ok:false` 也算落地。
 *
 * 外加**接线还在**那一条(与 `terminal-reload.test.ts` 同一个体例):本单的反证
 * 落在 `main.ts` 的 handler 上 —— 把它改回从前那句三元
 * (`connectionReady ? connectionReady : { ok:false, error:'core 尚未连接' }`)
 * 就会让「装配途中问进来」拿到一句永久的假话,而 `main.ts` 在 import 那一刻就
 * `app.whenReady()`、注册 IPC、开窗,拿不进 vitest。所以这里读它的**源文本**,
 * 问三句:handler 交的是不是 `connection.promise`、那句假话还在不在、开窗有没有
 * 排在装配之前。源文本断言是下策,用在这里是有意的:它只钉「有没有接上」,
 * 行为由上面四条钉。
 */

const mainSource = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../main.ts'),
  'utf-8',
)

describe('HostConnectionGate', () => {
  it('构造即待定:没人 resolve 之前那个 promise 不落地', async () => {
    const gate = new HostConnectionGate()
    expect(gate.settled).toBe(false)
    // 一个 macrotask 都过去了它还没落地 —— 这正是「答案还没到」该有的样子。
    const raced = await Promise.race([
      gate.promise,
      new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 0) }),
    ])
    expect(raced).toBe('pending')
  })

  it('resolve 之后,同一个 promise 落到那个值(早问的人与晚问的人拿到同一个答案)', async () => {
    const gate = new HostConnectionGate()
    // 「早问的人」:在答案之前就拿走了 promise。
    const asked = gate.promise
    expect(gate.resolve({ ok: true, baseUrl: 'http://127.0.0.1:8787', token: 't' })).toBe(true)
    expect(gate.settled).toBe(true)
    // 「晚问的人」:落定之后才来。两次拿到的是同一个 promise 对象。
    expect(gate.promise).toBe(asked)
    await expect(asked).resolves.toEqual({ ok: true, baseUrl: 'http://127.0.0.1:8787', token: 't' })
    await expect(gate.promise).resolves.toEqual({ ok: true, baseUrl: 'http://127.0.0.1:8787', token: 't' })
  })

  it('第二次 resolve 静默忽略:答案只有一个,先到的算数', async () => {
    const gate = new HostConnectionGate()
    expect(gate.resolve({ ok: true, baseUrl: 'http://127.0.0.1:1', token: 'first' })).toBe(true)
    expect(gate.resolve({ ok: false, error: '后到的那个' })).toBe(false)
    expect(gate.resolve({ ok: true, baseUrl: 'http://127.0.0.1:2' })).toBe(false)
    await expect(gate.promise).resolves.toEqual({ ok: true, baseUrl: 'http://127.0.0.1:1', token: 'first' })
  })

  it('`ok:false` 也是一种落地:连不上不是异常,promise 永不 reject', async () => {
    const gate = new HostConnectionGate()
    expect(gate.resolve({ ok: false, error: '挂面失败' })).toBe(true)
    expect(gate.settled).toBe(true)
    await expect(gate.promise).resolves.toEqual({ ok: false, error: '挂面失败' })
    // 落定之后的覆盖同样无效 —— 失败的答案与成功的答案同一条规矩。
    expect(gate.resolve({ ok: true, baseUrl: 'http://127.0.0.1:3' })).toBe(false)
    await expect(gate.promise).resolves.toEqual({ ok: false, error: '挂面失败' })
  })
})

describe('main.ts 的接线', () => {
  it('`host:connection` 交回 gate 的那一个 promise,从前那句三元假话不在了', () => {
    expect(mainSource).toContain("ipcMain.handle('host:connection'")
    expect(mainSource).toContain('connection.promise')
    // 反证的落点:这句话回来 = 装配途中问进来的人拿到一条永久的假话。
    expect(mainSource).not.toContain('core 尚未连接')
  })

  it('开窗排在装配之前(两者并行跑,这一批的全部意义)', () => {
    const openedAt = mainSource.indexOf('  createWindow()\n\n  const existing = readDiscovery()')
    const assembledAt = mainSource.indexOf('ownCoreAssembly = assembleOwnCore()')
    expect(openedAt).toBeGreaterThan(-1)
    expect(assembledAt).toBeGreaterThan(-1)
    expect(openedAt).toBeLessThan(assembledAt)
  })
})
