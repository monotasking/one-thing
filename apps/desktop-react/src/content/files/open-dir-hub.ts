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

interface OpenDirDialogState {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useOpenDirDialog = create<OpenDirDialogState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))
