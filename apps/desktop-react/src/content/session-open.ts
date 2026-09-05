import { CENTER_REGION } from '../workbench/regions'
import { useWorkbenchStore } from '../workbench/store'
import { leavesOf } from '../workbench/tree'
import { leafSessionOf, leafSessionTabOf, regionReadOrder, sessionRefOf } from './session-ref'
import type { ContentRef } from '../workbench/kinds'
import type { PaneLeafNode, PaneNode } from '../workbench/tree'

/**
 * **「进一条会话」在拼贴台这一侧的全部动作**(W5-b 裁定 3)。
 *
 * 它住在内容层而不是 `expose/store` 里,理由与 `workbench/drop-commit.ts` 文件头
 * 那段逐字相同:这句话要同时认识**会话这一种内容**与**树**,而 `expose/store`
 * 里再多一条指向树的边会把「形态机 / 数据源 / 拼贴台」三台机器焊在一起。
 * 反过来这只文件谁都不认识它(只有 expose 那层壳与 composer 那条接缝调它)。
 *
 * ── 三档,次序即语义 ────────────────────────────────────────────────────
 *  ① 这条会话**已经开着**(某片叶里有它)→ 点亮那一格 + 焦点叶指过去。
 *    不去原位换:那会在两片叶里各留一份同一条会话,而用户的意思是「去看它」;
 *  ② 焦点叶(或者按同一条梯子回落到的那片会话叶)**装着会话** → **原位换 ref**
 *    (`workbench.replaceRef`)。这就是列表里点一行的语义:换的是这片叶看哪条,
 *    不是多开一片。叶不重挂,兄弟叶一动不动;
 *  ③ 全壳一片会话叶都没有(理论上到不了 —— 会话是常驻那一种)→ 在中央区
 *    开一格。
 */

/** 进一条会话:按上面那三档办。答「落在哪片叶上」(答不出 = 什么都没做)。 */
export function enterSessionInWorkbench(sessionId: string): string | null {
  const store = useWorkbenchStore.getState()
  const ref = sessionRefOf(sessionId)
  const seat = seatOfRef(store.regions, ref)
  if (seat) {
    store.activateTab(seat.leafId, seat.index)
    return seat.leafId
  }
  const host = focusSessionLeafOf(store.regions, store.focusLeafId)
  const current = host ? leafSessionTabOf(host) : null
  if (host && current) {
    store.replaceRef(host.id, current, ref)
    return host.id
  }
  store.openRef(ref, { region: CENTER_REGION })
  return useWorkbenchStore.getState().focusLeafId
}

/**
 * **在焦点会话叶原位开一片「还没绑会话」的空会话**(⌘N 那条路,裁定 1 / 交付 3)。
 *
 * ⌘N 的语义是「在**这一片**开一条新的」,不是「再多开一片」——所以它原位换成
 * 保留键:屏幕当场就是一片空会话,人可以立刻开始打字,而建会话那一发还在飞。
 *
 * 答一口**换回去**(建不成时用)。没有这一口的话,后端拒了这一发,用户看着的
 * 那条会话就凭空没了 —— 而他只是按了一下 ⌘N。焦点叶已经是保留键(首开草稿态)
 * 时整件是恒等变换,答 null。
 */
export function openNewSessionPlaceholder(): (() => void) | null {
  const store = useWorkbenchStore.getState()
  const host = focusSessionLeafOf(store.regions, store.focusLeafId)
  const current = host ? leafSessionTabOf(host) : null
  if (!host || !current) return null
  const placeholder = sessionRefOf('')
  if (current.kind === placeholder.kind && current.key === placeholder.key) return null
  store.replaceRef(host.id, current, placeholder)
  return () => {
    const now = useWorkbenchStore.getState()
    const seat = seatOfRef(now.regions, placeholder)
    if (seat) now.replaceRef(seat.leafId, placeholder, current)
  }
}

/**
 * **把「还没绑会话」那一格绑成真 id**(裁定 1 的后半句)。
 *
 * 首开草稿态发出第一句话 → 会话建出来了 → 这一格从 `session:new` 原位换成
 * `session:<真 id>`。**必须是原位换**:走「关一格再开一格」会把那片叶剪掉重建,
 * 刚打完字的那台聊天区连同兄弟叶一起重挂。
 *
 * 找哪一格:整棵树上那一格保留键。找不到(用户中途把它关了)就退成 `enter`。
 */
export function bindNewSessionRef(sessionId: string): string | null {
  const store = useWorkbenchStore.getState()
  const placeholder = sessionRefOf('')
  const seat = seatOfRef(store.regions, placeholder)
  if (!seat) return enterSessionInWorkbench(sessionId)
  store.replaceRef(seat.leafId, placeholder, sessionRefOf(sessionId))
  return seat.leafId
}

/**
 * **焦点会话叶此刻坐在哪**(区域 + 叶 id)。会话行右键菜单的「在右侧 / 在下方」
 * 拿它当落点。
 *
 * 为什么不直接用 `workbench.focusLeafId`:焦点叶可能是**别的东西**那一片 ——
 * 打开会话总览之后焦点就在总览那块面的叶上,而「把这条会话开到右边」的意思
 * 显然是「开在**会话**旁边」,不是「把总览劈成两半」。判据因此复用
 * `enterSessionInWorkbench` 那条同一条梯子(焦点叶装着会话就是它,否则阅读序
 * 第一片装着会话的),两处不许分叉。
 *
 * 一片会话叶都没有 = null(那时没有「旁边」可言)。
 */
export function focusSessionSeat(): { region: string; leafId: string } | null {
  const { regions, focusLeafId } = useWorkbenchStore.getState()
  const leaf = focusSessionLeafOf(regions, focusLeafId)
  if (!leaf) return null
  for (const [region, tree] of Object.entries(regions)) {
    if (leavesOf(tree).some((node) => node.id === leaf.id)) return { region, leafId: leaf.id }
  }
  return null
}

/**
 * **焦点会话叶**:焦点叶自己装着会话就是它,否则按阅读序取第一片装着会话的。
 * 与 `session-ref.currentSessionOf` 那条梯子同源 —— 它答「哪条会话」,
 * 这一只答「哪片叶」,两处不许分叉,所以判据都写在那条梯子上。
 */
function focusSessionLeafOf(
  regions: Readonly<Record<string, PaneNode>>,
  focusLeafId: string | null,
): PaneLeafNode | null {
  if (focusLeafId) {
    for (const region of regionReadOrder(regions)) {
      const tree = regions[region]
      if (!tree) continue
      for (const leaf of leavesOf(tree)) {
        // 焦点叶自己装着会话才算数;不装(它是一片文件叶)就**往下落**到梯子第二级。
        if (leaf.id === focusLeafId && leafSessionOf(leaf) !== null) return leaf
      }
    }
  }
  for (const region of regionReadOrder(regions)) {
    const tree = regions[region]
    if (!tree) continue
    for (const leaf of leavesOf(tree)) {
      if (leafSessionOf(leaf) !== null) return leaf
    }
  }
  return null
}

/** 这一格此刻在哪(区域 + 叶 + 叶内下标)。哪棵树都不在 = null。 */
function seatOfRef(
  regions: Readonly<Record<string, PaneNode>>,
  ref: ContentRef,
): { leafId: string; index: number } | null {
  for (const tree of Object.values(regions)) {
    for (const leaf of leavesOf(tree)) {
      const at = leaf.tabs.findIndex((tab) => tab.kind === ref.kind && tab.key === ref.key)
      if (at >= 0) return { leafId: leaf.id, index: at }
    }
  }
  return null
}
