import { create } from 'zustand'

/**
 * 「顶栏那枚 agent 切换器的菜单开着没有」—— 一个布尔的家。
 *
 * 它单独成一个 store 而不是 AgentChip 内部的 useState,理由只有一条:
 * **有两个产地**。点那枚徽是一个,⌘J 是另一个(keymap 派发器不认识组件,
 * 也不该认识 —— 它只会把命令交给一个具名的开关)。两个产地共一个开关,
 * 才不会出现「按了 ⌘J 菜单开了,再点徽却先关后开」这种两份真相的毛病。
 *
 * 定位不在这里:菜单挂在触发器下缘,那是 AgentChip 量自己 DOM 的事,
 * 一个布尔不该知道屏幕坐标。
 */
interface AgentMenuState {
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

export const useAgentMenu = create<AgentMenuState>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}))
