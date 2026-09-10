import { companionSeedOf, isCompanionRef, refId } from './kinds'
import { regionReadRank } from './regions'
import * as T from './tree'
import { nextLeafId } from './ids'
import type { CompanionEnv, ContentRef, ContentRefId } from './kinds'
import type { RegionId } from './regions'
import type { PaneNode } from './tree'

/**
 * **伴随面:收 / 放 / 继承三件事的纯函数半边**(C3,正本
 * `apps/desktop-react/docs/session-continuity-2026-09.md` §3)。
 *
 * 用户原话:「同一工作区里,切会话时上一条会话挂着的目录要留着;切回去还能回到
 * 我看到哪个文件、看到哪一行」。于是目录 / 文件 / 改动这三种内容不再是「工作区的
 * 家具」,而是**某条会话的**:在哪条会话是环境会话的时候开出来,就归哪条会话。
 *
 * ── 这只文件里一个种类名都没有 ────────────────────────────────────────────
 * 「它算不算伴随面」问的是 `kinds.isCompanionRef`(种类自述),「没记录时该给
 * 进场会话开哪一格」问的是 `kinds.companionSeedOf`。所以 `'dir'` / `'file'` /
 * `'diff'` 在这只文件与 `store.ts` 里 grep 零命中 —— 与 `tree.ts` 同一条纪律。
 *
 * ── 为什么是纯函数,而不是 store 里的一段 ──────────────────────────────────
 * 「切会话那一拍」有四条判据(收谁 / 摘的次序 / 放回哪儿 / 没记录时继承什么),
 * 每一条都要能脱开 React 与 zustand 单测;store 那一头只剩「一次 `set`」。
 * 与 `drop-commit` / `tree` 的分工逐字同源。
 *
 * ── 开一格伴随面时**不记账**,这是有意的(与派工单的字面不同) ──────────────
 * 派工单写的是「`files-launcher` 与 `dir` 开格时把归属记进当前会话记录」。真按那句
 * 写会有**两份真相**:一格伴随面此刻在不在、在哪儿,树上写得清清楚楚,而账上再记
 * 一份就要在**六条**路上各同步一次(开 / 关 / 拖到别片叶 / 换序 / 藏起来 / 死会话
 * 清洗)—— 那正是 `session-projection` 头上「六条各写一遍 release 的下场是它们迟早
 * 漏一条」那段判例的同一个形。
 *
 * 所以这里的账**只描述不在场的那些会话**:在场的那条由树自己说,离场那一拍现收
 * (`companionSeatsIn` 就是那一次「集合差」),进场那一拍销掉(判词在
 * `store.swapCompanions` ③)。派工单要的那三件事因此全都成立,而且是结构保证:
 *  · 「关掉一格伴随面 = 切回来不会再冒出来」——它离场时压根不在树上,收不到;
 *  · 「拖到另一片叶」——收的时候读的是它此刻真正坐的那一格,不是开它时那一格;
 *  · 「退出应用时它还开着」——它留在落盘的 `regions` 里,下次启动照旧是那条会话的
 *    (第一次离场时才会被收进账)。
 */

/** 一格伴随面此刻坐在哪(区域 + 叶 + 叶内位次)。 */
export interface CompanionSeat {
  readonly ref: ContentRef
  readonly region: RegionId
  readonly leafId: string
  readonly index: number
}

/**
 * 一条会话的伴随面记录。
 *
 * `active` 是 `refId` 而不是下标:下标只在**那一刻那棵树**里有意义,而这份记录
 * 要活过别的会话在同一片叶上进进出出(以及一次重启)。
 *
 * **`view` 那一格没有**,这是有意的 —— 判词整段在文件末尾的留账里。
 */
export interface CompanionRecord {
  readonly seats: readonly CompanionSeat[]
  readonly active: ContentRefId | null
}

/** 会话 id → 那条会话的伴随面记录。住在 workbench 的 per-space 家具里,落盘。 */
export type CompanionLedger = Record<string, CompanionRecord>

/** 空记录 —— 「这条会话什么都没开着」与「从来没记过」是两句不同的话(见 store)。 */
export const EMPTY_COMPANION_RECORD: CompanionRecord = { seats: [], active: null }

/* ── ① 离场收 ─────────────────────────────────────────────────────────── */

/**
 * **树上此刻有哪些伴随面**,连坐标一起。**钉住的不算** —— 那正是钉住的定义
 * (设计 §3.4:「钉住的格不算伴随面,不随会话收放」)。
 *
 * `active` = 「最后看的是哪一格」:焦点叶上那一格露脸的伴随面优先,没有就取
 * 阅读序里第一格露脸的。一格都没露脸(它们都被别的标签盖着)= null,
 * 放回去的时候就谁都不激活 —— 那与「我离开时没在看伴随面」是同一件事。
 */
export function companionSeatsIn(
  regions: Readonly<Record<string, PaneNode>>,
  focusLeafId: string | null,
): { seats: CompanionSeat[]; active: ContentRefId | null } {
  const seats: CompanionSeat[] = []
  let active: ContentRefId | null = null
  let activeFromFocusLeaf = false
  for (const region of readOrder(regions)) {
    const tree = regions[region]
    if (!tree) continue
    for (const leaf of T.leavesOf(tree)) {
      const pinned = T.pinnedIdsOf(leaf)
      leaf.tabs.forEach((ref, index) => {
        if (!isCompanionRef(ref)) return
        const id = refId(ref)
        if (pinned.includes(id)) return
        seats.push({ ref, region: region as RegionId, leafId: leaf.id, index })
        if (leaf.active !== index) return
        // 焦点叶上那一格说了算;它没有的话,阅读序里第一格露脸的顶上。
        if (leaf.id === focusLeafId) {
          if (!activeFromFocusLeaf) {
            active = id
            activeFromFocusLeaf = true
          }
        } else if (active === null) {
          active = id
        }
      })
    }
  }
  return { seats, active }
}

/**
 * **把这些格从树上摘掉**。
 *
 * 摘的次序是**每片叶内下标从大到小** —— 逐格从小往大摘会让后面那些的下标一路
 * 往前塌,摘的就成了别人(与 `store.hideRegion` 那段「先按原状折下来再一次性
 * 摘掉」是同一个坑的两种写法)。
 *
 * **不 prune**:剪不剪由调用方决定(中央区那棵永远至少一片叶,而那句话住在 store)。
 * 一格都没摘到时原样交回同一份 regions。
 */
export function withoutCompanionSeats(
  regions: Readonly<Record<string, PaneNode>>,
  seats: readonly CompanionSeat[],
): Record<string, PaneNode> {
  if (seats.length === 0) return regions as Record<string, PaneNode>
  const out: Record<string, PaneNode> = { ...regions }
  const byRegion = new Map<string, CompanionSeat[]>()
  for (const seat of seats) {
    const rows = byRegion.get(seat.region) ?? []
    rows.push(seat)
    byRegion.set(seat.region, rows)
  }
  for (const [region, rows] of byRegion) {
    let tree = out[region]
    if (!tree) continue
    for (const seat of [...rows].sort((a, b) => b.index - a.index)) {
      tree = T.removeTab(tree, seat.leafId, seat.index)
    }
    out[region] = tree
  }
  return out
}

/* ── ② 进场放 ─────────────────────────────────────────────────────────── */

/**
 * **按记录逐格放回**,并把 `activeId` 那一格点亮。
 *
 * 四条判据:
 *  · **同一格只放一份**(设计 §3.4「两条会话同 workdir」):这份内容已经在树上
 *    (被钉住的那一格、或者刚放回去的同一格)就跳过 —— 一个内容在一个区域里
 *    只出现一次是不变量 1,而两条会话记着同一棵目录树是常态;
 *  · **原区域原位次**:`insertTab` 自己会把下标钳进范围;
 *  · **叶没了 → 落到同区域第一片叶末尾**(设计 §3.3);
 *  · **区域没了 → 当场建回来**(与 `store.restoreHidden` 那句「区域没了就把它
 *    建回来」逐字同一条:关掉一扇浮窗之后再切回这条会话,它该回到一扇浮窗里,
 *    而不是凭空掉进中央区)。
 *
 * **不碰焦点叶** —— 设计 §3.3 末句「焦点不动(还在 B 的输入框)」。
 * 一格都没放时原样交回同一份 regions(引用恒等)。
 */
export function withCompanionSeats(
  regions: Readonly<Record<string, PaneNode>>,
  seats: readonly CompanionSeat[],
  activeId: ContentRefId | null,
): Record<string, PaneNode> {
  if (seats.length === 0) return regions as Record<string, PaneNode>
  let changed = false
  const out: Record<string, PaneNode> = { ...regions }
  // 位次小的先插:后面那些的落点是按**放回之后**那张表说的。
  for (const seat of [...seats].sort((a, b) => a.index - b.index)) {
    const id = refId(seat.ref)
    if (locate(out, id)) continue
    const tree = out[seat.region] ?? T.makeLeaf(nextLeafId())
    const leaf = T.findLeaf(tree, seat.leafId) ?? T.leavesOf(tree)[0]
    if (!leaf) continue
    const at = leaf.id === seat.leafId ? seat.index : undefined
    // `activate: false` —— 放回来不该顺手把每一片叶露脸的那一格换掉;
    // 该点亮的只有 `activeId` 那一格,下面统一点一次。
    out[seat.region] = T.insertTab(tree, leaf.id, seat.ref, { at, activate: false })
    changed = true
  }
  if (!changed) return regions as Record<string, PaneNode>
  if (activeId) {
    const at = locate(out, activeId)
    if (at) out[at.region] = T.activate(out[at.region], at.leafId, at.index)
  }
  return out
}

/* ── ③ 继承:种类跟过去,内容不跟 ───────────────────────────────────────── */

/**
 * **没记录时给进场会话开什么**(设计 §3.3 / 拍点 2)。
 *
 * 拿离场那一拍收下来的**种类**(去重、保持阅读序)逐个问它自己:
 * 「给这条会话开哪一格?」——目录那一种答「它自己 workdir 的那棵树」,
 * 文件那一种不答(那是上一条会话在看的文件,与进场这条无关),
 * 会话没绑 workdir 时目录那一种也答不出 → 什么都不开。
 *
 * 落点用**那一种离场时坐的第一格**的坐标:同一个地方,换成它自己的内容。
 * 这只函数一个种类名都不点 —— 它只把 `seat.ref.kind` 递回注册表。
 */
export function inheritedCompanionSeats(
  taken: readonly CompanionSeat[],
  env: CompanionEnv,
): CompanionSeat[] {
  const out: CompanionSeat[] = []
  const done = new Set<string>()
  for (const seat of taken) {
    if (done.has(seat.ref.kind)) continue
    done.add(seat.ref.kind)
    const ref = companionSeedOf(seat.ref.kind, env)
    if (!ref) continue
    out.push({ ref, region: seat.region, leafId: seat.leafId, index: seat.index })
  }
  return out
}

/* ── 账:一张表的写法 ────────────────────────────────────────────────────── */

/**
 * 记一条会话的伴随面。**一模一样就原样交回同一张表**(引用恒等)——
 * 没有这一条,每一次切会话都会写一份「内容相同、身份不同」的家具账,
 * 而 zustand 的每一次 `set` 后面跟着一次 `partialize` 写盘。
 */
export function withCompanionRecord(
  ledger: CompanionLedger,
  sessionId: string,
  record: CompanionRecord,
): CompanionLedger {
  if (!sessionId) return ledger
  if (sameRecord(ledger[sessionId], record)) return ledger
  return { ...ledger, [sessionId]: record }
}

/** 这几条会话的记录一起删(会话被删那一拍)。一条都没删到时原样交回。 */
export function withoutCompanionRecords(
  ledger: CompanionLedger,
  sessionIds: readonly string[],
): CompanionLedger {
  const gone = sessionIds.filter((id) => id && id in ledger)
  if (gone.length === 0) return ledger
  const out = { ...ledger }
  for (const id of gone) delete out[id]
  return out
}

/**
 * 落盘那份账的**形状闸**(存量档案可能是任何东西:手改过、版本对不上、被截断)。
 * 与 `store.normalizeHiddenShape` 同一体例:**只问形状,不问种类** ——
 * 水合那一刻种类表还是空的,拿 `isCompanionRef` 去筛会把整张账清空。
 */
export function normalizeCompanionLedger(value: unknown): CompanionLedger {
  if (!value || typeof value !== 'object') return {}
  const out: CompanionLedger = {}
  for (const [sessionId, row] of Object.entries(value as Record<string, unknown>)) {
    if (!sessionId || !row || typeof row !== 'object') continue
    const record = row as Partial<CompanionRecord>
    const seats: CompanionSeat[] = []
    for (const seat of Array.isArray(record.seats) ? record.seats : []) {
      if (!isSeatShape(seat)) continue
      seats.push(seat)
    }
    out[sessionId] = {
      seats,
      active: typeof record.active === 'string' && record.active ? record.active : null,
    }
  }
  return out
}

function isSeatShape(value: unknown): value is CompanionSeat {
  if (!value || typeof value !== 'object') return false
  const seat = value as Partial<CompanionSeat>
  return (
    typeof seat.region === 'string'
    && typeof seat.leafId === 'string'
    && typeof seat.index === 'number'
    && Number.isInteger(seat.index)
    && seat.index >= 0
    && !!seat.ref
    && typeof seat.ref.kind === 'string'
    && typeof seat.ref.key === 'string'
  )
}

function sameRecord(a: CompanionRecord | undefined, b: CompanionRecord): boolean {
  if (!a) return false
  if (a === b) return true
  if (a.active !== b.active || a.seats.length !== b.seats.length) return false
  return a.seats.every((seat, at) => {
    const other = b.seats[at]
    return (
      seat.region === other.region
      && seat.leafId === other.leafId
      && seat.index === other.index
      && seat.ref.kind === other.ref.kind
      && seat.ref.key === other.ref.key
    )
  })
}

/* ── 小工具 ───────────────────────────────────────────────────────────── */

/** 区域的阅读序(中央 → 四条边 → 浮窗)。判据在 `regions.regionReadRank` 上。 */
function readOrder(regions: Readonly<Record<string, PaneNode>>): string[] {
  return [...Object.keys(regions)].sort((a, b) => regionReadRank(a) - regionReadRank(b))
}

/** 这个 refId 此刻在哪一格。**顶层标签**那一层就够了(伴随面不进复合标签的内层)。 */
function locate(
  regions: Readonly<Record<string, PaneNode>>,
  id: ContentRefId,
): { region: string; leafId: string; index: number } | null {
  for (const region of readOrder(regions)) {
    const tree = regions[region]
    if (!tree) continue
    const at = T.locateRef(tree, region as RegionId, id)
    if (at) return { region, leafId: at.leafId, index: at.index }
  }
  return null
}

/*
 * ── 留账 ────────────────────────────────────────────────────────────────
 * ① **`view` 那一格没记,而且今天不该记**(设计 §3.2 列了它)。先查了它们住哪:
 *    · 目录树的**展开态**住在 `data/files-source` 那张**按绝对路径**记的平表里,
 *      而那张表本身就是 per-space 家具(`FILES_PER_SPACE`)—— 收放伴随面不碰它,
 *      切回来展开的还是那几层。再抄一份进 `view` 就是同一件事两个产地,
 *      而那正是 `data/session-view-state.ts` 文件头上「不记草稿」的同一条判例;
 *    · 查看器的**行号与滚动位**住在 `data/viewer-source` 的 `instances[path]` /
 *      `scrolls[path]`,而收放走的是「摘一格」不是「关一格」(`dispose` 只在关闭
 *      那条路上跑),所以那份实例状态一路留着,切回来自己就贴回去了;
 *    · 目录树的**选中行**是 `FilesPanel` 里一格组件级 `useState` —— **外面没有键
 *      可记**。要记它得先给它一个有主的键,那是另一单(与 C1 留账里「工具卡折叠态」
 *      逐字同一笔:不为这一单硬改面板内部的状态归属)。
 *    于是这一批**不立 `view` 这一格**:一个谁都不写的字段落进档案,是下一个人的
 *    陷阱(判例:persist v3 删 `preview` 那一段)。真要记「选中行」时,它该与
 *    折叠态一起立成一张按内容 refId 记的视图表,而不是塞进这份坐标记录里。
 * ② **改动面板(`diff`)还进不来**:它今天是一块**单例**瓦(`panel:diff`),
 *    全应用一份、没有按会话分的 key —— 一份单例内容当不了「每条会话各一格」的
 *    伴随面。留的口是 `ContentKind.companion.matches`(判词在那儿),它自述那天
 *    这只文件一个字不改。
 */
