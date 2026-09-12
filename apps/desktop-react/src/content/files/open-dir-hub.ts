import { create } from 'zustand'

/**
 * **「打开目录…」那扇小窗开着没有**(W6-a,设计 `workbench-tabs-2026-09.md` §3)。
 *
 * 与 `workspace/components/palette-hub.ts` 逐字同一个体例:发起方(Dock 上「目录」
 * 那块瓦的右键菜单)只按一下开关,窗自己挂在外壳上(`components/AppShell` 里那一句)
 * —— 菜单一关就卸载的东西里挂不住一扇要收字的窗。
 *
 * ── 为什么今天它是一个输入框,不是系统对话框 ──────────────────────────────
 * 设计写的是「目录选择走宿主对话框:先查 `plugins` 宿主口的 `pickFile` 能否
 * `openDirectory`,能就复用,不能就在 `shell` 路由加一格 `pickDirectory`」。
 * 实测:①`pickFile` 收的是 `PickPluginFileRequest`,它做的事是「选一个文件、拷进
 * 插件的 storage、答一个 `storage:` 地址」——`openDirectory` 不在它的语义里;
 * ②`shell` 那条路加得了一格 `pickDirectory`,**但这台 React 壳今天注入的是
 * `shell: null`**(`apps/desktop-react/electron/host-ports.ts`),而
 * `configureShellHost` 是一格**闩**:一旦声明,`hasShellHost()` 当场翻真,
 * `GET /api/capabilities` 的 `shellTools` 与 oauth 域的 `openExternal` 两处判据
 * 跟着变 —— 那是这一批之外的、用户可感知的行为改动(「行为裁定须先问」)。
 *
 * 所以 W6-a 落的是设计里那句**结构化降级**:一个路径输入框,每一台宿主上都一样。
 * 原生对话框那一格连同它的理由记在交卷报的留账里,等拍板。
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
