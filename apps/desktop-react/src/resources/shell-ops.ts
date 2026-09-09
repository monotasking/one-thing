import { parseRefId, refId, mayCloseContent, type ContentRef } from '../workbench/kinds'
import { useWorkbenchStore } from '../workbench/store'
import { seatOfRefIn, leavesOf, type PaneNode } from '../workbench/tree'
import { regionReadRank, type RegionId } from '../workbench/regions'
import { canDetachTabAt } from '../workbench/leaf-tabs'
import { dropRef } from '../workbench/drop-commit'
import { summonStageItem } from '../stage/open-item'

/**
 * **`workbench:` 那七条做法与三条读法的落点表**(原子 K2b-2b)。
 *
 * 与 `keymap/run-command.ts` 同一条纪律,一字不差:**模块级纯函数,`getState()`
 * 取动作不订阅**。它跑在一条 SSE 推来的命令里,压根不在 React 树上 —— 一个订阅
 * 在这里既没有宿主可挂,也没有重渲染可触发。
 *
 * ── 它与 `run-command.ts` 为什么是两张表,不是一张 ─────────────────────────
 * 那张表的键是**命令 id**(`toggle:files` / `workbench.toggleFull`),它是**键位表
 * 的落点** —— 一格一格对着用户可以改绑的那张表。这张表的键是**做法名**
 * (`open` / `move`),它是**自述的落点** —— 一格一格对着 `workbench-spec.ts`。
 * 两张表恰好在 `summon` 那一格重叠,而重叠处的做法是**各自直接调那只共同的落点**
 * (`stage/open-item.summonStageItem`),不是让这张表去调那张表:
 * 让 AI 的路绕一次快捷键的表,等于把「用户改绑了 `toggle:files`」这件与 AI 无关
 * 的事变成 AI 行为的一部分。共同的落点只有一个,那就够了。
 *
 * ── 结局怎么说 ────────────────────────────────────────────────────────────
 * 跑成了回一句话(它会成为 `Outcome.ok` 的文本,模型读到的就是这一句);跑不成
 * **抛** —— `shell-host` 把抛出来的折成回执的 `{ kind: 'failed', message }`,
 * core 那边落成 `ShellCommandFailedError`。**不静默**:一个「认得这条命令、但这
 * 一下什么都没发生」的空动作,在键盘那条路上是「一个按不响的键」(可以接受,
 * 用户自己看得见屏幕),在 AI 这条路上是一句谎话(它只有回执可读)。所以凡是
 * 屏幕上不会有变化的那几档,这里一律说出来。
 */

/* ── 地址与区域 ──────────────────────────────────────────────────────────── */

/** 参数里那格 `target` → 一条内容地址。不成形就抛(是请求写错了,不是一次失败)。 */
function targetOf(params: Record<string, unknown>): ContentRef {
  const raw = params.target
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new TypeError('workbench: this op needs a "target" content address')
  }
  const ref = parseRefId(raw)
  if (!ref) throw new TypeError(`workbench: ${JSON.stringify(raw)} is not a content address`)
  return ref
}

/**
 * **这一下落在哪个区域**。次序只此一处:显式参数 → 地址的 path → 交给 store 的缺省。
 *
 * 地址那一格是「这次调用说的是哪个区域」(`workbench:center`),参数那一格是
 * 「搬到哪个区域」—— `move` 的 `region` 是目的地,与地址不是一回事,所以显式的
 * 那一格永远赢。认不得的区域名当场抛:悄悄落回中央区就是「做了另一件事」。
 */
function regionOf(refPath: string, params: Record<string, unknown>): RegionId | undefined {
  const raw = typeof params.region === 'string' && params.region ? params.region : refPath
  if (!raw) return undefined
  // 三种区域的形只有 `regions.ts` 说得出,判据因此只该问它(`regionReadRank` 对
  // 认不得的答 3)——在这里抄一遍 `'edge:'` 这三个字就是第二个产地。
  if (regionReadRank(raw) >= 3) throw new TypeError(`workbench: ${JSON.stringify(raw)} is not a region`)
  return raw as RegionId
}

/** 这格内容此刻坐在哪。找不到就抛 —— 「它没开着」是 AI 要听见的一句话。 */
function seatOf(ref: ContentRef) {
  const id = refId(ref)
  const seat = seatOfRefIn(useWorkbenchStore.getState().regions, id)
  if (!seat) throw new Error(`workbench: ${id} is not open`)
  return seat
}

/* ── 读:整棵树的投影 ────────────────────────────────────────────────────── */

interface LeafView {
  leafId: string
  tabs: string[]
  active: string | null
}

/** 一棵树 → 它的叶子们。**只交 refId 与哪一格活动** —— 分屏比例、预览这些是视图状态。 */
function leafViews(tree: PaneNode): LeafView[] {
  return leavesOf(tree).map((leaf) => ({
    leafId: leaf.id,
    tabs: leaf.tabs.map(refId),
    active: leaf.tabs[leaf.active] ? refId(leaf.tabs[leaf.active]) : null,
  }))
}

/**
 * 整棵树。区域按**阅读序**排(中央 → 四条边 → 浮窗)——`Object.keys` 的次序
 * 不是判据,而一份每次调用都换个顺序的读数会让调用方以为屏幕变了。
 */
function readLayout(): unknown {
  const st = useWorkbenchStore.getState()
  const regions = [...Object.keys(st.regions)]
    .sort((a, b) => regionReadRank(a) - regionReadRank(b))
    .map((region) => ({ region, leaves: leafViews(st.regions[region]) }))
  return {
    regions,
    focusLeafId: st.focusLeafId,
    full: st.full ? refId(st.full.ref) : null,
    hidden: st.hidden.map((entry) => refId(entry.ref)),
  }
}

function readTabs(refPath: string, query: Record<string, unknown>): unknown {
  const region = regionOf(refPath, query)
  if (!region) throw new TypeError('workbench: tabs needs a region (in the address or as a query field)')
  const tree = useWorkbenchStore.getState().regions[region]
  // 「这个区域还没有树」是一个正常答案(架子没开过),不是一次失败 —— 空表。
  return { region, leaves: tree ? leafViews(tree) : [] }
}

function readFocus(): unknown {
  const st = useWorkbenchStore.getState()
  const leafId = st.focusLeafId
  for (const region of Object.keys(st.regions)) {
    for (const leaf of leavesOf(st.regions[region])) {
      if (leaf.id !== leafId) continue
      const active = leaf.tabs[leaf.active]
      return { region, leafId, active: active ? refId(active) : null }
    }
  }
  return { region: null, leafId, active: null }
}

/**
 * 一条读法。`name` 是自述 `reads` 里的名字;认不得就抛(内核那边其实已经先挡了
 * 一层 —— `ResourceInputValidator` 只放行自述里有的名字 —— 这一句是**这只文件
 * 自己的**闸,免得将来有人绕过内核直接调它)。
 */
export function readWorkbench(name: string, refPath: string, query: Record<string, unknown>): unknown {
  if (name === 'layout') return readLayout()
  if (name === 'tabs') return readTabs(refPath, query)
  if (name === 'focus') return readFocus()
  throw new TypeError(`workbench: unknown read ${JSON.stringify(name)}`)
}

/* ── 做:七条 ────────────────────────────────────────────────────────────── */

/**
 * 一条做法。跑成了回一句给模型读的话,跑不成抛(见文件头)。
 *
 * 它是 `async` 只为了 `close` 那一条:`beforeClose`(`mayCloseContent`)是一次
 * 真的询问,可能要等用户回答。别的六条都是同步的一次 `set`。
 */
export async function runWorkbenchOp(
  op: string,
  refPath: string,
  params: Record<string, unknown>,
): Promise<string> {
  const store = useWorkbenchStore.getState()

  if (op === 'open') {
    const ref = targetOf(params)
    const region = regionOf(refPath, params)
    store.openRef(ref, region ? { region } : {})
    return `opened ${refId(ref)}`
  }

  if (op === 'activate') {
    const ref = targetOf(params)
    const seat = seatOf(ref)
    store.activateTab(seat.leafId, seat.index)
    return `activated ${refId(ref)}`
  }

  if (op === 'close') {
    const ref = targetOf(params)
    const seat = seatOf(ref)
    /*
     * 三步与 `leaf-tabs.useCloseLeafTab` **同源**:同一只 `canDetachTabAt`
     * (种类自述,不是种类名)、同一只 `mayCloseContent`。不同的只有「怎么告诉
     * 提问的人」—— 那条路上是一句 `announce`(屏幕上还有别的证据),这条路上
     * 只有回执,所以是一次 `failed`。判据没有第二份,措辞才有两份。
     */
    if (!canDetachTabAt(store.regions, seat.leafId, seat.index)) {
      throw new Error(`workbench: ${refId(ref)} cannot be closed here`)
    }
    if (!(await mayCloseContent(ref))) throw new Error(`workbench: closing ${refId(ref)} was declined`)
    // `await` 之后重读:那一问期间树可能已经动过(命令是 COW 的,同 P0 那条坑)。
    const live = useWorkbenchStore.getState()
    const fresh = seatOfRefIn(live.regions, refId(ref))
    if (!fresh) return `${refId(ref)} was already closed`
    live.closeTab(fresh.leafId, fresh.index)
    return `closed ${refId(ref)}`
  }

  if (op === 'move') {
    const ref = targetOf(params)
    const raw = typeof params.region === 'string' ? params.region : ''
    if (!raw) throw new TypeError('workbench: move needs a destination "region"')
    const region = regionOf('', { region: raw })
    if (!region) throw new TypeError('workbench: move needs a destination "region"')
    const at = typeof params.at === 'number' ? params.at : undefined
    store.moveRef(ref, region, at === undefined ? {} : { at })
    return `moved ${refId(ref)} to ${region}`
  }

  if (op === 'float') {
    const ref = targetOf(params)
    // 与右键菜单里那一行「撕成浮窗」**同一只落点**(`drop-commit.dropRef`,拖拽
    // 落定也走它)—— 所以窗号怎么铸、身量怎么给、落定之后焦点跟不跟,三条路一个
    // 字都不会分叉。
    seatOf(ref)
    dropRef(ref, { kind: 'float' })
    return `floated ${refId(ref)}`
  }

  if (op === 'full') {
    const ref = targetOf(params)
    /*
     * ── 与派工令的字面写法有一处出入,理由在此 ────────────────────────────
     * 派工令写的是 `full { target }` → `toggleFull`。两半对不上:`toggleFull()`
     * 作用在**焦点叶的活动 tab** 上、不收目标,而这条做法自述了一格 `target`。
     * 照字面走 = 那格参数被无声地丢掉,自述从此说谎。所以取的是**参数那一半**
     * (它才是 AI 手里的契约),落点是收目标的那一只 `enterFull(ref)`。
     *
     * 「这一种不许全屏」在 store 里是**静默空动作**(判词写在 `enterFull` 上:
     * 它还有别的调用方,对那些静默才是对的)。这条路上不行 —— 所以做完回头问
     * 一次树:没铺上就说出来。
     */
    store.enterFull(ref)
    const full = useWorkbenchStore.getState().full
    if (!full || refId(full.ref) !== refId(ref)) {
      throw new Error(`workbench: ${refId(ref)} cannot fill the window`)
    }
    return `${refId(ref)} now fills the window`
  }

  if (op === 'exitFull') {
    // 没铺着是**空动作**,而且这一档不算失败:「让它退出全屏」在没有全屏时
    // 想要的结果已经成立了(与 `close` 那条「已经关掉了」同一句话)。
    const was = store.full ? refId(store.full.ref) : null
    store.exitFull()
    return was ? `left full-window mode (${was})` : 'nothing was filling the window'
  }

  if (op === 'summon') {
    const item = params.item
    if (typeof item !== 'string' || item.length === 0) {
      throw new TypeError('workbench: summon needs an "item" (a Dock tile id)')
    }
    // Dock 点瓦、`toggle:<面>` 快捷键、这一条,三个入口**同一只落点**。
    summonStageItem(item)
    return `summoned ${item}`
  }

  throw new TypeError(`workbench: unknown op ${JSON.stringify(op)}`)
}
