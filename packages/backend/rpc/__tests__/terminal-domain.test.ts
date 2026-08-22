/**
 * terminal 域,端到端穿过 dispatcher(结构债 P4 终态批 D2)。
 *
 * 接的是被删掉的两处转发的测试位:`apps/electron/src/ipc/terminal.ts` 那只可移植
 * 工厂与 `@main/ipc/terminal.ts` 的七条壳适配。值得钉的是:
 *  - **ipc 分支**七条都真的落到服务上,参数解包与错误包装逐字沿用旧壳适配
 *    (`create` / `list` / `attach` 折结构化失败,`list` 额外带空表;
 *    `write` / `resize` / `kill` 恒 `{success:true}`;`ack` 补一条空回执);
 *  - **http 分支**七条一律结构化拒绝,而且**一次都不求值 `getTerminalService()`**
 *    —— 懒单例因此仍然不会在 server / CLI 上 load node-pty,这正是能力位默认关
 *    背后的那条硬保证。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcDispatchContext, RpcResponse } from '@shared/ipc/rpc.js'

const IPC: RpcDispatchContext = { transport: 'ipc' }
const HTTP: RpcDispatchContext = {
  transport: 'http',
  ownerUid: 'alice',
  workspaceId: 'w1',
  sandboxRoot: '/sandbox/alice/w1',
}

const service = {
  create: vi.fn(),
  list: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn(),
  attach: vi.fn(),
  ack: vi.fn(),
}
const getTerminalService = vi.fn(() => service)

vi.mock('@onething/runtime/terminal/service.wiring', () => ({
  getTerminalService: () => getTerminalService(),
}))

function unwrap(response: RpcResponse): Record<string, unknown> {
  if (!response.ok) throw new Error(`dispatch failed: ${response.error.message}`)
  return response.data as Record<string, unknown>
}

const TERMINAL_INFO = {
  id: 't-1',
  title: 'zsh',
  cwd: '/repo',
  shell: '/bin/zsh',
  cols: 80,
  rows: 24,
  createdAt: 1,
}

describe('terminal RPC domain', () => {
  let dispatchRpc: typeof import('../registry.js')['dispatchRpc']
  let dispose: (() => void) | undefined
  let desktopOnlyError: string

  beforeEach(async () => {
    const [registry, domain] = await Promise.all([
      import('../registry.js'),
      import('../domains/terminal.js'),
    ])
    dispatchRpc = registry.dispatchRpc
    registry.resetRpcRegistryForTests()
    dispose = domain.registerTerminalRpcDomain()
    desktopOnlyError = domain.TERMINAL_DESKTOP_ONLY_ERROR
    getTerminalService.mockClear()
    for (const fn of Object.values(service)) fn.mockReset()
    service.create.mockReturnValue(TERMINAL_INFO)
    service.list.mockReturnValue([TERMINAL_INFO])
    service.attach.mockReturnValue({
      success: true,
      info: TERMINAL_INFO,
      chunks: [{ seq: 1, data: 'hi' }],
      lastSeq: 1,
      generation: 3,
    })
  })

  afterEach(() => {
    dispose?.()
    dispose = undefined
  })

  const call = (method: string, payload: unknown, context: RpcDispatchContext) =>
    dispatchRpc({ domain: 'terminal', method, payload }, context)

  describe('ipc: every method reaches the service', () => {
    it('creates a terminal and returns its info', async () => {
      const data = unwrap(await call('create', { cwd: '/repo', sessionId: 's1' }, IPC))
      expect(service.create).toHaveBeenCalledWith({ cwd: '/repo', sessionId: 's1' })
      expect(data).toEqual({ success: true, terminal: TERMINAL_INFO })
    })

    it('folds a create failure into a structured error', async () => {
      service.create.mockImplementation(() => {
        throw new Error('node-pty missing')
      })
      expect(unwrap(await call('create', {}, IPC))).toEqual({
        success: false,
        error: 'node-pty missing',
      })
    })

    it('lists terminals', async () => {
      expect(unwrap(await call('list', {}, IPC))).toEqual({
        success: true,
        terminals: [TERMINAL_INFO],
      })
    })

    it('folds a list failure into a structured error with an empty table', async () => {
      service.list.mockImplementation(() => {
        throw new Error('boom')
      })
      expect(unwrap(await call('list', {}, IPC))).toEqual({
        success: false,
        terminals: [],
        error: 'boom',
      })
    })

    it('unpacks write / resize / kill positionally, as the old shell did', async () => {
      expect(unwrap(await call('write', { terminalId: 't-1', data: 'ls\n' }, IPC)))
        .toEqual({ success: true })
      expect(service.write).toHaveBeenCalledWith('t-1', 'ls\n')

      expect(unwrap(await call('resize', { terminalId: 't-1', cols: 120, rows: 40 }, IPC)))
        .toEqual({ success: true })
      expect(service.resize).toHaveBeenCalledWith('t-1', 120, 40)

      expect(unwrap(await call('kill', { terminalId: 't-1' }, IPC))).toEqual({ success: true })
      expect(service.kill).toHaveBeenCalledWith('t-1')
    })

    it('returns the attach snapshot verbatim', async () => {
      const data = unwrap(await call('attach', { terminalId: 't-1' }, IPC))
      expect(service.attach).toHaveBeenCalledWith('t-1')
      expect(data).toMatchObject({ success: true, generation: 3, lastSeq: 1 })
    })

    it('folds an attach failure into a structured error', async () => {
      service.attach.mockImplementation(() => {
        throw new Error('no such terminal')
      })
      expect(unwrap(await call('attach', { terminalId: 'gone' }, IPC))).toEqual({
        success: false,
        error: 'no such terminal',
      })
    })

    it('answers the flow-control ack with an empty receipt', async () => {
      expect(
        unwrap(await call('ack', { terminalId: 't-1', bytes: 42, generation: 3 }, IPC)),
      ).toEqual({ success: true })
      expect(service.ack).toHaveBeenCalledWith('t-1', 42, 3)
    })
  })

  describe('http: all seven refuse without touching the service', () => {
    it('refuses every method with the same structured error', async () => {
      const answers = await Promise.all([
        call('create', {}, HTTP),
        call('write', { terminalId: 't-1', data: 'x' }, HTTP),
        call('resize', { terminalId: 't-1', cols: 1, rows: 1 }, HTTP),
        call('kill', { terminalId: 't-1' }, HTTP),
        call('attach', { terminalId: 't-1' }, HTTP),
        call('ack', { terminalId: 't-1', bytes: 1, generation: 0 }, HTTP),
      ])
      for (const answer of answers) {
        expect(unwrap(answer)).toEqual({ success: false, error: desktopOnlyError })
      }
      // `list` 的失败信封多一格空表(逐字沿用旧壳适配的形状)。
      expect(unwrap(await call('list', {}, HTTP))).toEqual({
        success: false,
        terminals: [],
        error: desktopOnlyError,
      })
    })

    it('never evaluates the lazy service singleton on the http path', async () => {
      await call('create', {}, HTTP)
      await call('list', {}, HTTP)
      await call('attach', { terminalId: 't-1' }, HTTP)
      expect(getTerminalService).not.toHaveBeenCalled()
      for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled()
    })
  })
})
