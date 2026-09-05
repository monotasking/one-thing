import { CENTER_REGION } from '../workbench/regions'
import { refId } from '../workbench/kinds'
import { findLeaf, leavesOf } from '../workbench/tree'
import type { ContentRef } from '../workbench/kinds'
import type { PaneLeafNode, PaneNode } from '../workbench/tree'

/**
 * **「会话」这一种内容的词汇表**(W5-b,设计 §1.1 / §8 W5;裁定 1)。
 *
 * ── 为什么它单独一只文件,而不是长在 `content/kinds/session.tsx` 里 ────────
 * 三个互不相识的地方要说同一句话:**这一格 tab 代表哪条会话**——
 *  · 那一种内容自己(`content/kinds/session.tsx`,它 render 的就是这条会话);
 *  · 投影(`content/session-projection.ts`:焦点叶 → `currentSessionId`);
 *  · 一堆入口(会话列表点一行、⌘N、拖一行会话进某片叶)。
 * 让它们互相 import 会拉出一条环(投影 → 那一种内容 → ChatStream → 数据源 →
 * expose store → 投影),而这台壳里同一种环有三处白纸黑字的病历
 * (`workbench/store.ts` / `workspace/layout-scope.ts` / `stage/store.ts` 末尾)。
 * 所以词汇表住在一只**零 store 依赖**的叶子文件里:它只 import 树的纯函数。
 *
 * ── 保留键 `new`(裁定 1)───────────────────────────────────────────────
 * `session:new` = 「还没绑会话的那片会话叶」——也就是今天 `currentSessionId === ''`
 * 那一态的落点(冷启动、上一条会话被删)。第一条消息把会话建出来之后,由
 * `workbench.replaceRef` **原位**把它换成 `session:<真 id>`(叶不重挂)。
 *
 * `new` 是**这一种内容自己的约定**:`workbench/*` 一个字都不认识它
 * (那两只文件里 grep `'session'` / `'new'` 零命中,是本批的自证之一)。
 * 翻译只有这一对函数,两头都不许再拼一次字符串。
 */

/** 种类名。登记在 `content/kinds/session.tsx`。 */
export const SESSION_KIND = 'session'

/** 「还没绑会话」的那一格的 key(见文件头)。 */
export const NEW_SESSION_KEY = 'new'

/** 会话 id → ref。空串(还没有会话)= 保留键那一格。 */
export function sessionRefOf(sessionId: string): ContentRef {
  return { kind: SESSION_KIND, key: sessionId || NEW_SESSION_KEY }
}

/** 会话 id → refId(焦点作用域的 owner、live-title 的键都用它)。 */
export function sessionRefIdOf(sessionId: string): string {
  return refId(sessionRefOf(sessionId))
}

/**
 * ref → 会话 id。**不是会话那一种就答 null**(「这一格根本不是会话」),
 * 保留键答空串(「是会话叶,但还没绑」)—— 两者在调用方那里从来不是一件事。
 */
export function sessionIdOfRef(ref: ContentRef): string | null {
  if (ref.kind !== SESSION_KIND) return null
  return ref.key === NEW_SESSION_KEY ? '' : ref.key
}

/**
 * 这片叶此刻代表**哪一格**会话:活动格是会话就是它,否则叶里第一格会话。
 * 都没有 = null。这条梯子只写这一遍 —— `leafSessionOf`(答会话 id)与
 * `session-open`(答那一格 ref,原位换要用它)读的是同一句话。
 */
export function leafSessionTabOf(leaf: PaneLeafNode): ContentRef | null {
  const active = leaf.tabs[leaf.active]
  if (active && sessionIdOfRef(active) !== null) return active
  return leaf.tabs.find((tab) => sessionIdOfRef(tab) !== null) ?? null
}

/** 这片叶此刻代表哪条会话(同上那条梯子,答的是 id)。 */
export function leafSessionOf(leaf: PaneLeafNode): string | null {
  const tab = leafSessionTabOf(leaf)
  return tab === null ? null : sessionIdOfRef(tab)
}

/** 这片叶装着会话吗(粘性判据:焦点落到**文件叶**时环境会话不换根)。 */
export function leafHoldsSession(
  regions: Readonly<Record<string, PaneNode>>,
  leafId: string | null,
): boolean {
  const leaf = leafOf(regions, leafId)
  return leaf !== null && leafSessionOf(leaf) !== null
}

/**
 * **投影的判据本体**(裁定 3):此刻屏幕上「当前那条会话」是哪一条。
 *
 * 一条从窄到宽的梯子,**每一级都是树自己答得出的**(零粘性、零隐藏状态 ——
 * 粘的那一格是 `envSessionId`,判词在 `content/session-projection.ts`):
 *  ① 焦点叶的活动格是会话 → 它;
 *  ② 焦点叶里还有别的会话格 → 第一格(在一片叶里切到文件 tab 不该让
 *    输入框失去目标 —— 那条会话就在同一片叶里摆着);
 *  ③ 焦点叶根本不装会话(焦点在文件叶 / 架子上某块面)→ **中央区先问**,
 *    再按区域名序问别的区域,取阅读序第一片装着会话的叶;
 *  ④ 全壳一格会话都没有 → 空串(= 今天「还没有当前会话」那一态)。
 *
 * ③ 这一级是「一直有一个答案」的结构保证:会话那一种是 `resident`,中央区里
 * 至少留一格,所以④ 只在树还没播种的那一瞬(用例夹具)成立。
 */
export function currentSessionOf(
  regions: Readonly<Record<string, PaneNode>>,
  focusLeafId: string | null,
): string {
  const focused = leafOf(regions, focusLeafId)
  if (focused) {
    const mine = leafSessionOf(focused)
    if (mine !== null) return mine
  }
  for (const region of regionReadOrder(regions)) {
    const tree = regions[region]
    if (!tree) continue
    for (const leaf of leavesOf(tree)) {
      const id = leafSessionOf(leaf)
      if (id !== null) return id
    }
  }
  return ''
}

/**
 * 全壳此刻**摆着**哪些会话(树里的 + 藏起来的)。
 *
 * 它是聊天数据机器那本引用账的输入(`content/session-projection.ts`):
 * 在这张表上 = 这条会话的机器活着、继续收流(哪怕它此刻是隐藏的、或者在
 * 另一片没获得焦点的叶里);不在 = 松手。保留键那一格不算 —— 它没有会话可收。
 */
export function openSessionIdsIn(
  regions: Readonly<Record<string, PaneNode>>,
  hidden: readonly { ref: ContentRef }[],
): string[] {
  const out = new Set<string>()
  for (const tree of Object.values(regions)) {
    for (const leaf of leavesOf(tree)) {
      for (const tab of leaf.tabs) {
        const id = sessionIdOfRef(tab)
        if (id) out.add(id)
      }
    }
  }
  for (const entry of hidden) {
    const id = sessionIdOfRef(entry.ref)
    if (id) out.add(id)
  }
  return [...out]
}

/**
 * 「这一格会话还活着吗」——死会话清洗那一口 `alive` 的判据本体(裁定 5)。
 *
 * **只对会话那一种说话**:别的种类一律答 true(清洗不该顺手动文件 tab)。
 * 保留键恒活(它不是一条会话,是「还没绑」)。
 */
export function sessionRefAlive(ref: ContentRef, liveIds: ReadonlySet<string>): boolean {
  const id = sessionIdOfRef(ref)
  if (id === null) return true
  if (id === '') return true
  return liveIds.has(id)
}

/** 焦点叶(指名的那一片;答不出 = null)。 */
function leafOf(
  regions: Readonly<Record<string, PaneNode>>,
  leafId: string | null,
): PaneLeafNode | null {
  if (!leafId) return null
  for (const tree of Object.values(regions)) {
    const leaf = findLeaf(tree, leafId)
    if (leaf) return leaf
  }
  return null
}

/**
 * 问区域的次序:**中央区先**,其余按名字排序。
 * 排序是为了让 ③ 那一级**可复现** —— `Object.keys` 的次序是插入序,而区域是
 * 一格一格建出来的,同一棵树在两台机器上会给出不同的答案。
 */
export function regionReadOrder(regions: Readonly<Record<string, PaneNode>>): string[] {
  const rest = Object.keys(regions).filter((region) => region !== CENTER_REGION).sort()
  return [CENTER_REGION, ...rest]
}
