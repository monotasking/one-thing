import { useMemo } from 'react'
import { TAB_SELECT_SLOTS, tabSelectCommandId } from '../keymap/tab-commands'
import { canSpawnContent, refId, restoreContent, spawnContent } from './kinds'
import { useCloseLeafTab } from './leaf-tabs'
import { seatOfRefIn } from './tree'
import { useWorkbenchStore } from './store'
import type { CommandId } from '../keymap/types'
import type { ContentRef } from './kinds'
import type { PaneLeafNode } from './tree'

/**
 * **一片叶答得出的那几条命令**(K2,方案
 * `apps/desktop-react/docs/keymap-responder-2026-09.md` §5 K2)。
 *
 * ── 为什么它是一只文件,而不是两处各写一遍 ──────────────────────────────
 * 一片叶的标签条**有两个住处**:中央区那一组画在窗口顶栏(`TopBarTabs`),其余
 * 区域画在叶身上(`PaneLeaf`)—— 两处各挂一份 `<FocusScope scope="leaf">`,
 * **同一个 owner、两份实例**(判词在 `PaneLeaf` 的 `leafKeys` 上:焦点在叶的
 * 身体里还是在它的标签上,⌘W 都得关得掉)。K0 之前那张表只有一条 ⌘W,抄两遍
 * 还看得住;K2 起它是十四条(新标签 / 新建这一种 / 重开 / 上下一格 / 九格直达
 * / 关),抄两遍就是「两个产地迟早分叉」的教科书形状。
 *
 * 「基础件先行」那条纪律在非视觉件上的读法就是这一句:行为也有产地。
 *
 * ── 表里一个种类名都没有 ────────────────────────────────────────────────
 * 「能不能再开一格同类」问的是 `ContentKind.spawn`,「关掉的那一格怎么重开」问
 * 的是 `snapshot` / `restore` —— 都是**种类自述**。所以新增一种内容(PDF 阅读器)
 * 要改的文件是它自己那一只 manifest,这里零改动。
 *
 * ── 「此刻答不答得出」全部落在 `undefined` 上 ──────────────────────────────
 * `ScopeNode.commands[id]` 缺席 = 派发器当没命中,继续往浅走、最后放行。所以
 * 单格叶交不出 `tab.next`、空栈交不出 `tab.reopen`、活动 tab 那一种没有 `spawn`
 * 就交不出 `tab.new` —— 它们**不是**「按了什么都不发生」,而是这一下根本没被
 * 这片叶接住(⌘T 落在一片查看器叶上时,页面 / 系统照旧收得到它)。
 */

/* ── 纯算术(三只,与 React 无关,所以能单独测)────────────────────────── */

/**
 * 下一格。**环绕** —— 最后一格的下一格是第一格(浏览器 / 终端 / 编辑器三家
 * 一致)。`count <= 1` = `null`:一片只有一格的叶上「下一个」是个哑键,
 * 而不是一个原地打转的键。
 */
export function nextTabIndex(count: number, active: number): number | null {
  if (count <= 1) return null
  return (Math.max(0, active) + 1) % count
}

/** 上一格。同样环绕(第一格的上一格是最后一格)。 */
export function prevTabIndex(count: number, active: number): number | null {
  if (count <= 1) return null
  return (Math.max(0, active) - 1 + count) % count
}

/**
 * 第 n 格(n 从 1 起)。**第 9 格 = 最后一格**,不管一共有几格 —— 那是浏览器
 * 三十年的惯例,也是这一族键唯一一处「n 不等于下标 + 1」的地方。
 *
 * n 超过这一排的格数 = `null`(那一格不存在,键就该是哑的);空叶同理。
 */
export function tabIndexForSlot(count: number, slot: number): number | null {
  if (count <= 0 || slot < 1) return null
  if (slot >= TAB_SELECT_SLOTS) return count - 1
  return slot <= count ? slot - 1 : null
}

/* ── 两件动作(叫得动 store,所以不是纯的;两处消费,所以住在这儿)────────── */

/**
 * **同类再开一格,摆到它旁边**(⌘T,以及浏览器叶檐上那颗 `+`)。
 *
 * 次序即语义:**先创建(种类自己顺手点名),再摆** —— 落焦走的是
 * 「开的人点名、被开的那一格挂载时自己取走」那条判例(`requestTerminalFocus` /
 * `requestBrowserFocus`),而不是摆完之后在外面 `activateScope`:后者真机上落空,
 * 病历整段写在 `content/browser/focus-request.ts` 上(叶是 `lazy` 进来的,
 * 「微任务 + 一帧」够不着它)。所以这只函数**不碰焦点**,它只管摆。
 *
 * 开不出来(种类没自述 `spawn` / 后端拒绝 / 一次创建已经在飞)就什么都不做。
 */
export async function spawnTabNextTo(ref: ContentRef, leafId: string, index: number): Promise<void> {
  const made = await spawnContent(ref)
  if (!made) return
  useWorkbenchStore.getState().moveRefIntoLeaf(made, leafId, { at: index + 1, activate: true })
}

/**
 * **屏幕上那一格坐在哪,就往它旁边开一格同类**(浏览器叶檐那颗 `+` 用的口)。
 *
 * 它与 `spawnTabNextTo` 是同一条路的两个入口:那一只收座位(叶自己知道),
 * 这一只自己去找座位(一格内容只认得自己的 ref)。不在任何一棵树上 = 没有
 * 「旁边」可言,什么都不做。
 */
export async function spawnTabNextToRef(ref: ContentRef): Promise<void> {
  const seat = seatOfRefIn(useWorkbenchStore.getState().regions, refId(ref))
  if (!seat) return
  await spawnTabNextTo(ref, seat.leafId, seat.index)
}

/**
 * **重开这片叶最近关掉的那一格**(⌘⇧T)。
 *
 * 摆回**原来那一格**(`index`);那一排此刻短了(又关了几格)就落末尾 ——
 * `moveRefIntoLeaf` 的 `at` 越界时 `insertTab` 自己夹到末尾,这里不再判一遍。
 */
export async function reopenClosedTab(leafId: string): Promise<void> {
  const entry = useWorkbenchStore.getState().takeClosedTab(leafId)
  if (!entry) return
  const ref = await restoreContent(entry.kind, entry.snapshot)
  if (!ref) return
  useWorkbenchStore.getState().moveRefIntoLeaf(ref, leafId, { at: entry.index, activate: true })
}

/* ── 那张表 ──────────────────────────────────────────────────────────────── */

export type LeafCommands = Partial<Record<CommandId, (() => void) | undefined>>

/**
 * 这片叶**此刻**答得出的那几条。两处 `<FocusScope scope="leaf">` 各调一次
 * (同一个 owner,两份实例),所以这只 hook 就是那张表的唯一产地。
 *
 * `content.new`(⌘N)与 `tab.new`(⌘T)在这里是**同一个 handler**:一片叶上
 * 「新建这一种内容」与「同类再开一格」摆法相同(都是这一排里的下一格)。两个
 * 键仍然是两条命令 —— 区别活在**别的响应者**身上:会话总览与 composer 只答
 * `content.new`(新会话),不答 `tab.new`(它们没有「这一排」)。
 */
export function useLeafCommands(leaf: PaneLeafNode): LeafCommands {
  const closeAt = useCloseLeafTab(leaf)
  const reopenable = useWorkbenchStore((st) => (st.closedTabs[leaf.id]?.length ?? 0) > 0)
  const active = leaf.tabs[leaf.active] ?? null
  const count = leaf.tabs.length
  return useMemo(() => {
    const spawnable = active !== null && canSpawnContent(active)
    const newTab = spawnable && active
      ? () => void spawnTabNextTo(active, leaf.id, leaf.active)
      : undefined
    const activateAt = (at: number | null) =>
      at === null ? undefined : () => useWorkbenchStore.getState().activateTab(leaf.id, at)
    const table: LeafCommands = {
      'tab.close': active ? () => void closeAt(leaf.active) : undefined,
      'tab.new': newTab,
      'content.new': newTab,
      'tab.reopen': reopenable ? () => void reopenClosedTab(leaf.id) : undefined,
      'tab.next': activateAt(nextTabIndex(count, leaf.active)),
      'tab.prev': activateAt(prevTabIndex(count, leaf.active)),
    }
    for (let slot = 1; slot <= TAB_SELECT_SLOTS; slot += 1) {
      table[tabSelectCommandId(slot)] = activateAt(tabIndexForSlot(count, slot))
    }
    return table
  }, [active, closeAt, count, leaf.active, leaf.id, reopenable])
}
