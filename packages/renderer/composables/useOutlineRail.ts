/**
 * 大纲轨宿主 —— 外壳布局收敛 L3(`docs/design/shell-layout-2026-08.md` §L3)。
 *
 * Message 模式的大纲(当前这条长回复的标题轨)由**聊天面**的 `MessageList` 画,
 * 却要落在**右栏**那条 outline 页签里 —— 两者在组件树上隔着整个外壳。
 *
 * L3 之前这件事靠一条 prop 链走:
 *   `ChatSidePanel` → emit → `ChatContainer` → `PanelTree` → `ChatWindow` →
 *   `ChatPanel` → `MessageList`(五层透传一个 DOM 元素)。
 * 大纲栏并入右栏之后那条链的起点跑到了另一棵子树上,再往上抬只会更长。
 *
 * 这里把它换成**一枚模块级 ref**(与 `useShellLayout` 的运行时输入同型):
 *  · 右栏的 outline 页签挂载时登记自己的宿主元素,卸载时交还;
 *  · 聊天面每一格自己判断"轮不轮得到我"(`panelFocused`),轮到了才把宿主拿去用。
 *
 * **判定留在聊天面**是刻意的:分屏时同一时刻只有聚焦的那一格该把轨投进右栏,
 * 而"哪一格聚焦"只有 `PanelTree` 那一层知道(它本来就在算)。宿主这一侧只回答
 * "右栏此刻有没有一块地方接它",不回答"该谁去接"。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'

/** 右栏 outline 页签登记的宿主元素;null = 右栏此刻没有大纲位。 */
const outlineRailHost = ref<HTMLElement | null>(null)

/** 登记宿主(outline 页签挂载 / 切到 message 模式时)。 */
export function setOutlineRailHost(host: HTMLElement | null): void {
  outlineRailHost.value = host ?? null
}

/**
 * 交还宿主。**只在它仍是当前那一枚时**才清空 —— 页签重建时新的一枚可能已经
 * 登记进来,后卸载的旧组件若无条件清空就会把新宿主抹掉(经典的卸载竞态)。
 */
export function releaseOutlineRailHost(host: HTMLElement | null): void {
  if (!host || outlineRailHost.value === host) outlineRailHost.value = null
}

/** 测试夹具用:把模块级宿主拨回初值。 */
export function resetOutlineRailHost(): void {
  outlineRailHost.value = null
}

export interface UseOutlineRailResult {
  /** 右栏此刻的大纲宿主(只读视图)。 */
  outlineRailHost: Ref<HTMLElement | null>
  /** 这一格该不该把轨投进右栏 —— `active` 为假时恒 null。 */
  outlineRailTarget: (active: () => boolean) => ComputedRef<HTMLElement | null>
  setOutlineRailHost: (host: HTMLElement | null) => void
  releaseOutlineRailHost: (host: HTMLElement | null) => void
}

export function useOutlineRail(): UseOutlineRailResult {
  return {
    outlineRailHost,
    outlineRailTarget: (active: () => boolean) =>
      computed(() => (active() ? outlineRailHost.value : null)),
    setOutlineRailHost,
    releaseOutlineRailHost,
  }
}
