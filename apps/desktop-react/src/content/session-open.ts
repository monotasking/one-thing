import { hasComposerDraft } from '../composer/drafts'
import { useSessionOpenMode } from '../data/session-open-mode'
import { CENTER_REGION } from '../workbench/regions'
import { regionOfLeafIn, useWorkbenchStore } from '../workbench/store'
import { leavesOf, previewIndexOf, seatOfRefIn } from '../workbench/tree'
import { refId } from '../workbench/kinds'
import { parkSessionSwap } from './session-park'
import {
  leafSessionOf,
  leafSessionTabOf,
  regionReadOrder,
  sessionIdOfRef,
  sessionRefOf,
} from './session-ref'
import type { SessionOpenMode } from '../data/session-open-mode'
import type { ContentRef } from '../workbench/kinds'
import type { RegionId } from '../workbench/regions'
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
 *  ② 焦点叶(或者按同一条梯子回落到的那片会话叶)装着会话 → **按打开方式那档
 *    偏好办**(C2,下面那一节);
 *  ③ 全壳一片会话叶都没有(理论上到不了 —— 会话是常驻那一种)→ 在中央区
 *    开一格。
 *
 * ── 第二档的三档(C2,正本 `docs/session-continuity-2026-09.md` §4)───────
 * 用户 09-09 原话:「点击一个 session 的行为还是覆盖,好像没有地方能够控制。」
 * 从前第二档写死了「原位换 ref」,那正是他说的**覆盖**。今天它读
 * `data/session-open-mode.ts` 那一格 per-space 偏好 —— 报障的重点是**没有地方能改**,
 * 不是「覆盖」这个行为本身,所以三档齐备之后 09-10 用户把缺省判回了覆盖那一档
 * (原话与理由整段在 `data/session-open-mode.ts` 文件头):
 *
 *   `replace`(出厂) 原位换 ref。被换掉的那条**两个池子各留一份** —— C1 的数据
 *                    停靠池留着它折出来的树(不重载),视图停靠池留着它那棵已经
 *                    造好的 React 树(不重挂,`content/session-park.ts`),所以
 *                    「覆盖」只是屏幕上少一格标签,不是把它丢了;
 *   `newTab`         永远在焦点会话叶**末尾**新开一格;
 *   `preview`        这片叶至多一格**预览位**:有就原位换它(叶不重挂,标记留着);
 *                    没有就在活动格**旁边**开一格并标成预览。预览格**转正**之后
 *                    下一次点别的会话会在它旁边新开一格预览。
 *
 * ── 保留键那一格三档都**原位换**(不是三档各判一遍)────────────────────
 * `session:new`(还没绑会话的那一格,判词在 `session-ref.ts`)是**播种出来的**,
 * 不是谁打开的:它里面没有任何人做过任何事。所以三档一律先把它换掉,而不是在
 * 它旁边再开一格 —— 否则每次冷启动点第一条会话都会留下一个点开是空脸的
 * 「新会话」标签。`preview` 档里它顺带**就是**那一格预览位(「随手翻翻」的语义
 * 对一格空脸恒成立),于是「只开着一条,在列表里来回切着看」标签不增。
 *
 * ── 转正的四条路(设计 §4.1)在代码里各自的落点 ──────────────────────────
 *  ① **发了一句话** → `promoteSessionSeat`,由 `composer/useComposerSend` 在发送
 *     成功那一点上调(那是全壳唯一一处「一句话真的交出去了」);
 *  ② **输入框有草稿** → 下面 `previewSeatOf` 里那一句 `hasComposerDraft`:要换掉
 *     预览格之前先问它,有稿就**先把它转正**再另开一格预览。**留账**:草稿只在
 *     换会话 / 卸载那两拍才存进表(`composer/components/Composer.tsx`),所以
 *     「刚打了字、一个字都还没存下来就点了别的会话」这一次仍旧会被换掉 ——
 *     补它要一口「此刻输入框里有没有字」的活读口,而那一口的产地在输入面板
 *     那只组件上(C1 的地盘),不在这一批里开;
 *  ③ **把标签拖过** → **结构保证**,一行代码都没有:跨叶搬家与同叶换序都是
 *     「摘一格再插一格」,而 `tree.removeTab` 摘掉预览格时标记当场就没了
 *     (判词写在那只纯函数上);
 *  ④ **右键「保留」** → `workbench/LeafActions` 那张表里的一行,调 `promoteTab`。
 */

/** 进一条会话:按上面那三档办。答「落在哪片叶上」(答不出 = 什么都没做)。 */
export function enterSessionInWorkbench(sessionId: string): string | null {
  const store = useWorkbenchStore.getState()
  const ref = sessionRefOf(sessionId)
  const seat = seatOfRefIn(store.regions, refId(ref))
  if (seat) {
    store.activateTab(seat.leafId, seat.index)
    return seat.leafId
  }
  const host = focusSessionLeafOf(store.regions, store.focusLeafId)
  if (host) {
    const region = regionOfLeafIn(store.regions, host.id)
    if (region && openIntoSessionLeaf(host, region, ref, useSessionOpenMode.getState().mode)) {
      return host.id
    }
  }
  store.openRef(ref, { region: CENTER_REGION })
  return useWorkbenchStore.getState().focusLeafId
}

/**
 * 第二档的三档(判词在文件头)。答 `false` = 这片叶接不下(空叶 / 没有会话格),
 * 由调用方退到第三档。
 */
function openIntoSessionLeaf(
  host: PaneLeafNode,
  region: RegionId,
  ref: ContentRef,
  mode: SessionOpenMode,
): boolean {
  const store = useWorkbenchStore.getState()
  // 保留键那一格三档一律原位换(判词在文件头)。`preview` 档里它就是那格预览位。
  const seed = placeholderIndexOf(host)
  if (seed >= 0) {
    /*
     * 保留键那一格**不进视图停靠池**:它里面没有任何人做过任何事,停一棵空树
     * 只是白占堆(判词在 `session-park.parkable` 上)。
     */
    parkSessionSwap(host.id, null, ref)
    store.replaceRef(host.id, host.tabs[seed], ref)
    if (mode === 'preview') store.previewTab(host.id, seed)
    return true
  }
  if (mode === 'newTab') {
    store.openRef(ref, { region, leafId: host.id })
    return true
  }
  if (mode === 'preview') {
    const at = previewSeatOf(host)
    if (at !== null) {
      parkSessionSwap(host.id, host.tabs[at], ref)
      store.replaceRef(host.id, host.tabs[at], ref)
      return true
    }
    // 没有预览位:在**活动格旁边**开一格并标成预览(不是排到末尾 ——
    // 「刚点开的这一条」该紧挨着人此刻在看的那一条)。
    store.openRef(ref, { region, leafId: host.id, at: host.active + 1, preview: true })
    return true
  }
  const current = leafSessionTabOf(host)
  if (!current) return false
  /*
   * **`replace` 那一档的落点**(C2′ 之后是出厂缺省)。停靠只从这三处进来 ——
   * 关掉 / 新开一格标签 / 拖一格过来一格都不产生停靠,判词整段在
   * `content/session-park.ts` 的「为什么『切走』是显式的」。
   */
  parkSessionSwap(host.id, current, ref)
  store.replaceRef(host.id, current, ref)
  return true
}

/**
 * 这片叶那格「还没绑会话」的保留键在第几(没有 = -1)。
 * 判据问的是 `session-ref` 那对翻译函数,这只文件不拼字符串。
 */
function placeholderIndexOf(leaf: PaneLeafNode): number {
  return leaf.tabs.findIndex((tab) => sessionIdOfRef(tab) === '')
}

/**
 * **这片叶此刻的预览位**(`preview` 档要换掉的那一格)。答 `null` = 没有,该另开一格。
 *
 * 里面藏着转正路径②:标着预览的那一格如果**已经有草稿**,它就不再是「随手翻翻」
 * 的那一格了 —— 当场把它转正,并答 `null`(于是调用方另开一格预览,那一格稿子
 * 连同它的标签一起留在屏幕上)。
 */
function previewSeatOf(leaf: PaneLeafNode): number | null {
  const at = previewIndexOf(leaf)
  if (at === undefined) return null
  const occupant = sessionIdOfRef(leaf.tabs[at])
  if (occupant && hasComposerDraft(occupant)) {
    useWorkbenchStore.getState().promoteTab(leaf.id, at)
    return null
  }
  return at
}

/**
 * **转正:这条会话此刻坐的那一格不再是预览格**(设计 §4.1 转正之一)。
 *
 * 唯一调用点是 `composer/useComposerSend` 发送成功那一点 —— 「在它里面发了一句话」
 * 这件事全壳只有那一处知道。它自己会先判「那一格是不是预览格」(`promoteTab` 的
 * `index` 那一格),所以这里不必再问一遍;哪儿都没开着 = 恒等。
 */
export function promoteSessionSeat(sessionId: string): void {
  const store = useWorkbenchStore.getState()
  const seat = seatOfRefIn(store.regions, refId(sessionRefOf(sessionId)))
  if (!seat) return
  store.promoteTab(seat.leafId, seat.index)
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
  /*
   * ⌘N 也是一次原位换会话 —— 被换掉的那条进停靠池,于是「按了 ⌘N 又想回去看
   * 刚才那条」不必重渲一遍(那条路上返回的那口「换回去」调的是 `replaceRef`,
   * 它换回来时对账会把那一格从池子里摘掉,层照旧不重挂)。
   */
  parkSessionSwap(host.id, current, placeholder)
  store.replaceRef(host.id, current, placeholder)
  return () => {
    const now = useWorkbenchStore.getState()
    const seat = wholeTabSeatOf(now.regions, placeholder)
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
  const seat = wholeTabSeatOf(store.regions, placeholder)
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

/**
 * **这一格此刻坐在哪** —— 转调全壳唯一那只(`workbench/tree.seatOfRefIn`,
 * W7-p 修一轮裁定 2),外加一格过滤:**只认它自己就是一格标签**的那种座位。
 *
 * 为什么要那格过滤:这只文件的三个调用点里有两个(开保留键、把保留键绑成真 id)
 * 接着要 `workbench.replaceRef` —— 而那一口改的是**顶层标签**。座位落在一格
 * 二合一(`pair:`)的某一侧时 `replaceRef` 是空动作,于是保留键永远绑不上真 id,
 * 屏幕上那片会话停在空态。所以这一格是**过滤,不是第二只查找器**:查找只有一处,
 * 「这条路要哪一种座位」由用它的人说。
 */
function wholeTabSeatOf(
  regions: Readonly<Record<string, PaneNode>>,
  ref: ContentRef,
): { leafId: string; index: number } | null {
  const seat = seatOfRefIn(regions, refId(ref))
  return seat && seat.partIndex === null ? { leafId: seat.leafId, index: seat.index } : null
}
