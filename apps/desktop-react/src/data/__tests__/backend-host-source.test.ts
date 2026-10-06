import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '@shared/ipc/settings'
import type { BackendHostState } from '@shared/contracts/client-action'
import { useToastHub } from '../../ui/Toast'
import { useNotifyStore } from '../../services/notify-store'
import { useStageStore } from '../../stage/store'
import { configureBackendHostPort, type BackendHostPort } from '../backend-host-port'
import {
  backendKeepRunningQuery,
  backendStatusLine,
  canRestartBackend,
  receiveBackendHostState,
  restartBackendMutation,
  saveKeepRunningMutation,
  startBackendHost,
  stopBackendHost,
  useBackendHost,
} from '../backend-host-source'

/**
 * 后端进程在壳上的样子(第④步批 2b,决策 D11)。守五件事:
 *
 *  1. 状态行逐字是派工单那一句;`startedAt` 缺席不编时长;
 *  2. 重拉期间一条「正在重新连接后端。」,回到 running 收掉,不重复弹;
 *  3. 三次都没起来:一条不自动消失的「后端已停止。」,两道门「重启」「查看日志」,点了真打到宿主;
 *  4. 别处起的后端不许重启;
 *  5. 「退出后继续运行」整份写回,只动那一格。
 */
const RUNNING: BackendHostState = { phase: 'running', pid: 42, port: 8787, startedAt: 1_000, launchedHere: true, ownedByDesktop: true }

function toasts() {
  return useToastHub.getState().toasts
}

function fakePort(overrides: Partial<BackendHostPort> = {}): BackendHostPort & { saved: AppSettings[]; calls: string[] } {
  const saved: AppSettings[] = []
  const calls: string[] = []
  const settings = { general: { colorTheme: 'x', backendKeepRunningAfterQuit: false }, theme: 'dark' } as unknown as AppSettings
  return {
    saved,
    calls,
    available: () => true,
    readState: async () => RUNNING,
    onState: () => () => {},
    restart: async () => { calls.push('restart'); return { ok: true } },
    revealLog: async () => { calls.push('log'); return { ok: true } },
    readSettings: async () => ({ success: true, settings }),
    saveSettings: async (next) => { saved.push(next); return { success: true, settings: next } },
    ...overrides,
  }
}

beforeEach(() => {
  useStageStore.setState({ locale: 'zh' })
  useToastHub.setState({ toasts: [], folded: 0 })
  useNotifyStore.setState({ items: [] })
})

afterEach(() => {
  stopBackendHost()
  configureBackendHostPort(undefined)
  vi.restoreAllMocks()
})

describe('状态行', () => {
  it('运行中:端口与已运行时长;startedAt 缺席不编时长', () => {
    expect(backendStatusLine(RUNNING, 1_000 + 3 * 3600_000 + 5 * 60_000)).toBe('后端:运行中 · 端口 8787 · 已运行 3h 05m')
    expect(backendStatusLine({ ...RUNNING, startedAt: undefined }, 0)).toBe('后端:运行中 · 端口 8787')
    expect(backendStatusLine({ ...RUNNING, startedAt: 1_000 }, 1_000 + 2 * 86_400_000 + 3_600_000)).toBe('后端:运行中 · 端口 8787 · 已运行 2d 1h')
  })

  it('别的相位各一句;收尾中 / 没有后端 / 还没问到不画', () => {
    expect(backendStatusLine({ phase: 'starting' })).toBe('后端:正在启动')
    expect(backendStatusLine({ phase: 'restarting' })).toBe('正在重新连接后端。')
    expect(backendStatusLine({ phase: 'stopped' })).toBe('后端已停止。')
    expect(backendStatusLine({ phase: 'stopping' })).toBeNull()
    expect(backendStatusLine({ phase: 'idle' })).toBeNull()
    expect(backendStatusLine(null)).toBeNull()
  })

  it('别处起的后端不许重启;正在起 / 正在收尾时也不许', () => {
    expect(canRestartBackend(RUNNING)).toBe(true)
    expect(canRestartBackend({ ...RUNNING, ownedByDesktop: false })).toBe(false)
    expect(canRestartBackend({ phase: 'restarting', ownedByDesktop: true })).toBe(false)
    expect(canRestartBackend({ phase: 'stopped', ownedByDesktop: true })).toBe(true)
    expect(canRestartBackend(null)).toBe(false)
  })
})

describe('重连提示与停止横幅', () => {
  it('重拉期间一条提示,不重复弹;回到 running 收掉', () => {
    receiveBackendHostState({ phase: 'restarting' })
    receiveBackendHostState({ phase: 'restarting' })
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0]!.title).toBe('正在重新连接后端。')
    receiveBackendHostState(RUNNING)
    expect(toasts()).toHaveLength(0)
  })

  it('三次都没起来:不自动消失的横幅,两道门打到宿主', async () => {
    const port = fakePort()
    configureBackendHostPort(port)
    receiveBackendHostState({ phase: 'restarting' })
    receiveBackendHostState({ phase: 'stopped', error: 'the backend exited (code 1)' })
    expect(toasts()).toHaveLength(1)
    const toast = toasts()[0]!
    expect(toast.title).toBe('后端已停止。')
    expect(toast.body).toBe('the backend exited (code 1)')
    expect(toast.lifeMs).toBeNull()
    expect(toast.action?.label).toBe('重启')
    expect(toast.secondaryAction?.label).toBe('查看日志')
    toast.secondaryAction!.onClick()
    toast.action!.onClick()
    await vi.waitFor(() => expect(port.calls).toEqual(['log', 'restart']))
    // 重启成功、主进程推回 running:横幅收掉。
    receiveBackendHostState(RUNNING)
    expect(toasts()).toHaveLength(0)
  })

  it('重启被拒(别处起的后端):mutation 记下原话,不抛', async () => {
    configureBackendHostPort(fakePort({ restart: async () => ({ ok: false, error: 'not ours' }) }))
    await restartBackendMutation.run()
    expect(restartBackendMutation.get().error).toContain('not ours')
  })
})

describe('启动', () => {
  it('浏览器壳(没有那条口):什么都不起', async () => {
    const onState = vi.fn(() => () => {})
    configureBackendHostPort(fakePort({ available: () => false, onState }))
    await startBackendHost()
    expect(onState).not.toHaveBeenCalled()
    expect(useBackendHost.getState().state).toBeNull()
  })

  it('先订推送再问一次;推送先到了就不拿问来的旧值盖它', async () => {
    let push: ((state: BackendHostState) => void) | undefined
    configureBackendHostPort(fakePort({
      onState: (listener) => { push = listener; return () => {} },
      readState: async () => { push?.({ phase: 'restarting' }); return RUNNING },
    }))
    await startBackendHost()
    expect(useBackendHost.getState().state?.phase).toBe('restarting')
  })
})

describe('「退出后继续运行」', () => {
  it('当场读一份新的、只合那一格、整份写回', async () => {
    const port = fakePort()
    configureBackendHostPort(port)
    await backendKeepRunningQuery.ensure()
    expect(backendKeepRunningQuery.get().data).toBe(false)
    await saveKeepRunningMutation.run(true)
    expect(port.saved).toHaveLength(1)
    expect(port.saved[0]!.general).toEqual({ colorTheme: 'x', backendKeepRunningAfterQuit: true })
    expect(port.saved[0]!.theme).toBe('dark')
    expect(backendKeepRunningQuery.get().data).toBe(true)
  })
})
