import { create } from 'zustand'
import { pickDirectoryNative } from '../../data/dialog-port'
import { openDirectoryPanel } from '../dir-open'

/**
 * **「打开目录…」那扇小窗开着没有**(W6-a,设计 `workbench-tabs-2026-09.md` §3)。
 *
 * 与 `workspace/components/palette-hub.ts` 逐字同一个体例:发起方(Dock 上「目录」
 * 那块瓦的右键菜单)只按一下开关,窗自己挂在外壳上(`components/AppShell` 里那一句)
 * —— 菜单一关就卸载的东西里挂不住一扇要收字的窗。
 *
 * ── 系统对话框优先,输入框是退路(2026-09-24)──────────────────────────────
 * 挑目录一律走 `requestDirectory`:先问宿主的原生对话框(`dialog` RPC 域,桌面主进程
 * 注入 `dialog` 端口);宿主答「没有对话框」(独立 server / 浏览器壳连的 core)才开
 * 这扇路径输入窗。用户在系统对话框里点了取消就是取消,不再追一扇输入窗。
 *
 * 它没有走 `shell` 那一格:`configureShellHost` 是一格闩,声明了会顺手翻动
 * `capabilities.shellTools` 与 oauth 的 `openExternal` —— 挑目录不该改那三处判据。
 */

/**
 * ── 「挑完了拿它去干什么」为什么住在这里(T1,2026-09-12)─────────────────
 * 终端那块启动瓦也要一条「在目录…新建」。全壳只有这一处「挑一个目录」的面
 * (动作单产地),所以**不再开第二扇窗** —— 发起方把「挑完了做什么」一起递
 * 进来。缺席 = 老语义(开一份目录面板),`files-launcher` 因此一个字不改。
 *
 * 它是**一次调用的参数**,不是一份偏好:窗关掉就跟着清掉(否则下一个从别处
 * 开出来的「打开目录…」会落进上一次那个动作里)。
 */
export type OpenDirPick = (path: string) => void

interface OpenDirDialogState {
  open: boolean
  /** 这一次挑完了做什么。缺席 = 开一份目录面板(见上)。 */
  onPick?: OpenDirPick
  setOpen: (open: boolean, onPick?: OpenDirPick) => void
}

export const useOpenDirDialog = create<OpenDirDialogState>()((set) => ({
  open: false,
  onPick: undefined,
  setOpen: (open, onPick) => set({ open, onPick: open ? onPick : undefined }),
}))

/**
 * **挑一个目录**的唯一入口:系统对话框优先,没有对话框才开路径输入窗(判词见文件头)。
 * `onPick` 缺席 = 老语义(开一份目录面板)。
 */
export async function requestDirectory(
  onPick?: OpenDirPick,
  options: { title?: string; defaultPath?: string } = {},
): Promise<void> {
  const outcome = await pickDirectoryNative(options)
  if (outcome.kind === 'picked') {
    const run = onPick ?? openDirectoryPanel
    run(outcome.path)
    return
  }
  if (outcome.kind === 'unavailable') useOpenDirDialog.getState().setOpen(true, onPick)
}
