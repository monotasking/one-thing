import { create } from 'zustand'
import type { BackendHostState } from '@shared/contracts/client-action'
import { formatUptime } from '../format/quantity'
import { t } from '../i18n'
import { notify, retractNotify } from '../services/notify'
import { backendHostPort } from './backend-host-port'
import { createMutation, createQuery } from './kernel'

/**
 * **后端进程在壳上的样子**(第④步批 2b,`docs/design/two-process-2026-10.md` §2.3 第 3 条与决策 D11)。
 *
 * 后端是桌面拉起的子进程之后,「它在不在、跑了多久、要不要重启、是不是崩了」只有主进程答得出。主进程每次
 * 状态变了就经 preload 推一次(`host:backend-state`),这一层把它接到壳上,三个读者:
 *
 *  1. **设置 → 通用**的状态行与「重启后端」(`useBackendHostState()` + `backendStatusLine()` + `restartBackendMutation`);
 *  2. **重拉期间的提示**「正在重新连接后端。」—— 走连接失败那条路的同一种呈现(`notify` 一条 warn),
 *     回到 `running` 收掉;
 *  3. **三次都没起来的横幅**「后端已停止。」—— 一条不自动消失的 error,两道门「重启」「查看日志」。
 *
 * 另有一格设置「退出 onething 后让后端继续运行」(`general.backendKeepRunningAfterQuit`),读写经后端的
 * `settings` 域(整份写回),读它的是主进程(退出那一刻)。
 *
 * ── 寿命 ────────────────────────────────────────────────────────────────
 * 一条模块级订阅,`startBackendHost()` 起(幂等;浏览器壳没有那条口 = 什么都不起),HMR 退役复用
 * `stopBackendHost()`。状态表三张在施工记录里(批 2b 汇报)。
 */

interface BackendHostStore {
  /** 主进程最近一次说的样子;还没问到 / 浏览器壳是 null(三行不画)。 */
  state: BackendHostState | null
}

export const useBackendHost = create<BackendHostStore>(() => ({ state: null }))

export function useBackendHostState(): BackendHostState | null {
  return useBackendHost((store) => store.state)
}

/** 状态行里「已运行」那一格多久重算一次(只在设置页那几行挂着时走)。 */
export const BACKEND_UPTIME_TICK_MS = 30_000

/**
 * 状态行那一句。`null` = 这一刻不画状态行(还没问到 / 收尾中 / 没有后端)。
 * `startedAt` 缺席就不编时长 —— 少一格读数比一个假的「已运行 0s」诚实。
 */
export function backendStatusLine(state: BackendHostState | null, now: number = Date.now()): string | null {
  if (!state) return null
  switch (state.phase) {
    case 'running': {
      if (state.port === undefined) return t('backend.statusStarting')
      if (!state.startedAt) return t('backend.statusRunningNoUptime', { port: state.port })
      return t('backend.statusRunning', { port: state.port, duration: formatUptime(now - state.startedAt) })
    }
    case 'starting':
      return t('backend.statusStarting')
    case 'restarting':
      return t('backend.reconnecting')
    case 'stopped':
      return t('backend.stoppedBanner')
    default:
      return null
  }
}

/** 「重启后端」此刻点不点得动:别处起的 `server:start` 不归这台桌面重启;正在起 / 正在收尾时也不点。 */
export function canRestartBackend(state: BackendHostState | null): boolean {
  if (!state || state.ownedByDesktop === false) return false
  return state.phase === 'running' || state.phase === 'stopped' || state.phase === 'idle'
}

export const restartBackendMutation = createMutation<void, void>('backendHost.restart', {
  run: async () => {
    const done = await (await backendHostPort()).restart()
    if (!done.ok) throw new Error(done.error || t('backend.restartFailed'))
  },
})

/* ── 「退出后继续运行」那一格 ──────────────────────────────────────────────── */

export const backendKeepRunningQuery = createQuery('backendHost.keepRunning', async () => {
  const response = await (await backendHostPort()).readSettings()
  if (!response.success || !response.settings) throw new Error(response.error || t('backend.keepRunningLoadFailed'))
  return response.settings.general?.backendKeepRunningAfterQuit === true
})

export const saveKeepRunningMutation = createMutation<boolean, boolean>('backendHost.keepRunning.save', {
  run: async (on) => {
    const p = await backendHostPort()
    // 当场读一份新的 → 合一格 → 整份写回(别的格逐字不变)。
    const current = await p.readSettings()
    if (!current.success || !current.settings) throw new Error(current.error || t('backend.keepRunningLoadFailed'))
    const response = await p.saveSettings({
      ...current.settings,
      general: { ...current.settings.general, backendKeepRunningAfterQuit: on },
    })
    if (!response.success) throw new Error(response.error || t('backend.keepRunningSaveFailed'))
    return response.settings?.general?.backendKeepRunningAfterQuit === true
  },
  optimistic: (on) => backendKeepRunningQuery.patch(on),
  settle: (saved) => { backendKeepRunningQuery.patch(saved) },
})

/* ── 横幅与重连提示 ───────────────────────────────────────────────────────── */

const toasts: { reconnecting: string | null; stopped: string | null } = { reconnecting: null, stopped: null }

function retract(which: keyof typeof toasts): void {
  const id = toasts[which]
  if (id) retractNotify(id)
  toasts[which] = null
}

function showStopped(state: BackendHostState): void {
  if (toasts.stopped) return
  toasts.stopped = notify(
    {
      level: 'error',
      title: t('backend.stoppedBanner'),
      ...(state.error ? { body: state.error } : {}),
      source: 'backend-host',
    },
    {
      action: { label: t('backend.restartShort'), onClick: () => void restartBackendMutation.run() },
      secondaryAction: {
        label: t('backend.viewLog'),
        onClick: () => { void backendHostPort().then((p) => p.revealLog()).catch(() => undefined) },
      },
    },
  )
}

/** 收下一份状态:落表、按相位收放提示与横幅。导出给测试。 */
export function receiveBackendHostState(state: BackendHostState): void {
  useBackendHost.setState({ state })
  if (state.phase === 'restarting') {
    retract('stopped')
    if (!toasts.reconnecting) {
      toasts.reconnecting = notify({ level: 'warn', title: t('backend.reconnecting'), source: 'backend-host' })
    }
    return
  }
  retract('reconnecting')
  if (state.phase === 'stopped') showStopped(state)
  else retract('stopped')
}

let unsubscribe: (() => void) | undefined
let starting: Promise<void> | undefined

/** 启动时起:先订推送再问一次。幂等;浏览器壳(没有那条口)什么都不起。 */
export function startBackendHost(): Promise<void> {
  if (unsubscribe || starting) return starting ?? Promise.resolve()
  starting = (async () => {
    try {
      const p = await backendHostPort()
      if (!p.available()) return
      unsubscribe = p.onState(receiveBackendHostState)
      const state = await p.readState()
      // 推送可能先到了一份更新的:只在表还空着时落问来的那一份。
      if (state && !useBackendHost.getState().state) receiveBackendHostState(state)
    } catch {
      // 问不到 = 这一台壳看不见后端进程的样子;其余一切照旧。
    } finally {
      starting = undefined
    }
  })()
  return starting
}

/** 退订、收提示与横幅、清表。测试与 HMR 用;幂等。 */
export function stopBackendHost(): void {
  unsubscribe?.()
  unsubscribe = undefined
  starting = undefined
  retract('reconnecting')
  retract('stopped')
  useBackendHost.setState({ state: null })
  restartBackendMutation.reset()
  saveKeepRunningMutation.reset()
  backendKeepRunningQuery.reset()
}

if (import.meta.hot) {
  import.meta.hot.dispose(stopBackendHost)
}
