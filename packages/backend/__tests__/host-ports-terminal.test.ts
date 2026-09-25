/**
 * 宿主表里 `terminal` 那一格的**收尾**(T0,方案
 * `apps/desktop-react/docs/terminal-browser-2026-09.md` §2.1-3)。
 *
 * 这一格从 A1 建表起就是 `null`(没有任何宿主注入过),于是它的还原口从来没被
 * 走过一遍 —— 只摘端口、不杀 PTY 也没人看得出来。T0 让 React 壳真的注入它之后
 * 那笔账变成真的:`backend.dispose()` 若只摘广播器,node-pty spawn 出来的 shell
 * 不随父进程走,会变成没人认领的孤儿子进程,而且还在往一个没有消费者的 ring 里写。
 *
 * 钉三件:
 *   ① 注入 → `hasTerminalHost()` 真(七条 RPC 与能力位读的就是它)。
 *   ② 还原 → `killAllTerminals()` **被调过**。
 *   ③ **顺序**:杀在摘之前。判据写在 `killAllTerminals` 的桩里 —— 它被调到的那
 *      一刻 `hasTerminalHost()` 必须还是真。反过来(先摘端口再杀)最后那批 exit
 *      事件就没有出口了。
 *
 * 走的是 `applyHostPorts` 的返回值本身,不起整只 backend:`assemble` 把它
 * `own('hostPorts', 'restore')` 起来,`dispose()` 跑的就是这一只函数
 * (`backend.ts` 那一行),而起一台真 backend 要一两分钟。
 *
 * 只桩 `killAllTerminals` 一件:`configureTerminalBroadcaster` / `hasTerminalHost`
 * 用真的 —— ③ 那条断言问的正是真端口此刻的状态。
 */
import { afterAll, describe, expect, it, vi } from 'vitest'

const killCalls: Array<{ hostStillInjected: boolean }> = []

vi.mock('@onething/runtime/terminal/service.wiring', async importOriginal => {
  const actual = await importOriginal<typeof import('@onething/runtime/terminal/service.wiring')>()
  return {
    ...actual,
    killAllTerminals: async () => {
      killCalls.push({ hostStillInjected: actual.hasTerminalHost() })
    },
  }
})

import { configureTerminalBroadcaster, hasTerminalHost } from '@onething/runtime/terminal/service.wiring'
import { applyHostPorts, type OnethingHostPorts } from '../host-ports.js'

const BASE: OnethingHostPorts = {
  storePath: {},
  sandbox: {},
  auth: null,
  logging: null,
  shell: null,
  voice: null,
  terminal: null,
  skillsEnvironment: null,
  todoPlan: null,
  scratchpad: null,
  plugins: null,
  gateway: null,
  settings: null,
  evals: null,
  mcp: null,
  localTrust: null,
  speechOutput: null,
  dialog: null,
}

describe('宿主表 terminal 那一格的收尾(T0)', () => {
  it('注入 → hasTerminalHost 真;还原 → 先杀 PTY 再摘端口', async () => {
    killCalls.length = 0
    expect(hasTerminalHost()).toBe(false)

    const restore = applyHostPorts({
      ...BASE,
      terminal: { broadcaster: { sendData: () => {}, sendExit: () => {} } },
    })
    expect(hasTerminalHost()).toBe(true)

    await restore()

    // ② 杀过一次。反证:把 `applyHostPorts` 里那句 `await killAllTerminals()`
    //    拆掉 → 这一条红(`killCalls` 是空的)。
    expect(killCalls).toHaveLength(1)
    // ③ 杀的那一刻端口还在。反证:把两句对调 → 这一条红。
    expect(killCalls[0]!.hostStillInjected).toBe(true)
    // ①' 还原之后这台宿主重新变成"没有终端"。
    expect(hasTerminalHost()).toBe(false)
  })

  it('没注入的那一档:还原一次也不杀', async () => {
    killCalls.length = 0
    const restore = applyHostPorts(BASE)
    expect(hasTerminalHost()).toBe(false)

    await restore()

    expect(killCalls).toHaveLength(0)
    expect(hasTerminalHost()).toBe(false)
  })

  afterAll(() => {
    configureTerminalBroadcaster(null)
  })
})
