import { create } from 'zustand'

/**
 * 「工作区命令面板开着没有」—— 一个布尔的家,形状与 components/agent-menu.ts 逐字相同。
 *
 * 它单独成一个 store 而不是面板内部的 useState,理由也逐字相同:**有两个产地**。
 * ⌘⇧O 是一个(keymap 派发器不认识组件,只把命令交给一个具名的开关),
 * 面板自己的 Esc / 落定后自关是另一个。两个产地共一个开关,才不会出现
 * 「按了 ⌘⇧O 面板开了,再按一次却先关后开」这种两份真相的毛病。
 *
 * 它单独一个文件而不是并进 WorkspacePalette.tsx:派发器 import 组件文件的话,
 * 键盘这条路会把整棵面板树(以及它的 CSS)拖进外壳的首屏图 —— 一个布尔不值这个价。
 */
interface WorkspacePaletteState {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

export const useWorkspacePalette = create<WorkspacePaletteState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}))
