import { create } from 'zustand'
import type { ACPAgentState } from '@shared/ipc/acp'
import { t } from '../../i18n'
import { requestDirectory } from '../files/open-dir-hub'

/**
 * **「从 Agent 导入…」那扇小窗开着没有、开在哪一步**(A5-b,正本
 * `docs/design/acp-integration-2026-09.md` §3.7 / §11.6 A5)。
 *
 * 与 `files/open-dir-hub.ts` 逐字同一个体例:发起方(会话侧栏那一行)只按一下开关,窗自己挂在
 * 外壳上(`components/AppShell` 里挨着 `OpenDirDialog` 那一句)。
 *
 * ── 两步,中间夹一次「挑目录」────────────────────────────────────────────
 *  ① `agents`:几台能导入的 agent 里挑一台(**只有一台时这一步跳过**,入口那一行直接写它的名字);
 *  ② 挑目录 —— 走全壳唯一那一处 `requestDirectory`(系统对话框优先,没有才开路径输入窗)。
 *     **挑之前先把这扇窗关掉**:路径输入窗也是一扇 `ui/Dialog`,两扇模态叠着的话 Esc 退哪一层
 *     说不清;系统对话框点了取消就是取消,不再把这扇窗弹回来(与 `requestDirectory` 同一条);
 *  ③ `sessions`:那台 agent 在那个目录下存着的会话,点一条认领。
 * 步与参数都是**一次打开的状态**,不是偏好:关掉就清。
 */

export type AcpImportStep = { kind: 'agents' } | { kind: 'sessions'; agentId: string; cwd: string }

interface AcpImportState {
  open: boolean
  step: AcpImportStep
  /** 开在第一步(挑 agent)。 */
  showAgents: () => void
  /** 开在第二步(列会话)。 */
  showSessions: (agentId: string, cwd: string) => void
  close: () => void
}

export const useAcpImport = create<AcpImportState>()((set) => ({
  open: false,
  step: { kind: 'agents' },
  showAgents: () => set({ open: true, step: { kind: 'agents' } }),
  showSessions: (agentId, cwd) => set({ open: true, step: { kind: 'sessions', agentId, cwd } }),
  close: () => set({ open: false, step: { kind: 'agents' } }),
}))

export function agentNameOf(state: ACPAgentState): string {
  return state.config.name || state.manifest?.name || state.config.id
}

/** 选定一台之后:关窗 → 挑目录 → 挑完开在第二步。 */
export function pickDirectoryFor(agent: ACPAgentState): void {
  useAcpImport.getState().close()
  void requestDirectory((cwd) => useAcpImport.getState().showSessions(agent.config.id, cwd), {
    title: t('acpImport.dirTitle', { name: agentNameOf(agent) }),
  })
}

/** 入口那一行按下去:一台就直接挑目录,几台先挑 agent。 */
export function startAcpImport(candidates: readonly ACPAgentState[]): void {
  if (candidates.length === 1) {
    pickDirectoryFor(candidates[0]!)
    return
  }
  useAcpImport.getState().showAgents()
}
