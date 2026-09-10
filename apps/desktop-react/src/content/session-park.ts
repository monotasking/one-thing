import { flattenContent, refId } from '../workbench/kinds'
import { leavesOf } from '../workbench/tree'
import { keptContentLeafIds, resetKeptContents, setKeptContents } from '../workbench/kept-contents'
import { onSessionsDeleted } from '../data/sessions-source'
import { sessionIdOfRef } from './session-ref'
import type { ContentRef } from '../workbench/kinds'
import type { PaneNode } from '../workbench/tree'

/**
 * **视图停靠池 —— 切走的那条会话藏起来,不卸载**(2026-09-10,交互预算第三单;
 * 正本 `docs/session-continuity-2026-09.md` §5 的第二半)。
 *
 * ── 两个池,两件事,别混为一谈 ──────────────────────────────────────────
 *   `data/chat-source.ts` 的停靠池(C1,上限 8)保的是**数据机器** —— 折出来的
 *   那棵树、水位、活尾巴。它治的是「切回来还要再拉一遍账本」。
 *   这一只保的是 **React 组件树** —— 已经造出来的那几万个 DOM 节点。它治的是
 *   C1 留账 ③:「停靠池保住了数据机器,没保住组件树 —— 换会话时整片聊天连同
 *   工具卡一起卸载再重挂」。真机读数:那一次紧急提交本身 prod 18–71ms /
 *   dev 102–244ms,里面已经没有 `/src/` 热点,全是 React 造节点 + GC。
 *
 * ── 怎么做到「不卸载」──────────────────────────────────────────────────
 * 一格都没有新机器:`PaneLeaf` 本来就给这片叶的**每一格 tab** 各挂一层、切 tab
 * 只翻显形。这只文件做的只是往那张名单里**多塞几格没有标签的**(经
 * `workbench/kept-contents.ts` 那张与能力无关的表),于是「原位换 ref」从
 * 「卸载 A 的层 + 挂载 B 的层」变成「A 的层翻 `on=false`、B 的层翻 `on=true`」——
 * key 没变、位置没变(出生序)、槽没变,DOM 一个节点都没搬。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① **视图的三态**
 *    活动    这片叶的活动标签就是它 —— 正常显示、可交互、在活动路径上
 *    停靠    `content-visibility: hidden`(保留排版状态,`display:none` 不保留)
 *            + `inert` + `aria-hidden` + `pointer-events:none`;React 照旧挂着,
 *            流照收、空闲扩窗照跑,几何相关的活自己停(判词在 `ChatStream` 上)
 *    被逐出  真的卸载 —— 数据机器落进 C1 那个 8 格池,切回来是「池命中冷渲」
 * ② **四条路**
 *    切走      `parkSessionSwap(leafId, 旧, 新)`,由 `content/session-open.ts`
 *              在**每一处原位换会话之前**叫一次(见下面「为什么是显式的」)
 *    切回      新的那一格进了标签 → 对账把它从停靠名单里摘掉 → 它的层翻 `on=true`
 *    真删      `onSessionsDeleted`(**不是** `onSessionsRemoved`,与 C1 停靠池
 *              同一条接缝,理由整段在 `chat-source.forget` 上)→ 卸载
 *    换工作区  `clearSessionParks()`,由 `workspace/layout-scope.ts` 在拼贴树换装
 *              **之前**叫一次(判词在那儿)
 * ③ **停靠期间**:流式 delta 照旧进 store(块级 memo 让重渲只落在活消息上);
 *    `useTailWindow` 的空闲扩窗**继续**(后台把窗补全,切回来就是全量);
 *    `stick` / 两只 ResizeObserver / `scheduleAnchorSave` 三样量几何的活**停手**
 *    —— 判据是「容器此刻没有排版」(`clientHeight === 0`),落点在 `ChatStream`。
 *
 * ── 与数据池的两条不变量 ────────────────────────────────────────────────
 *  · **停靠的视图必然持有数据引用**:那棵树里挂着 `ChatStream`,它的
 *    `chatSources.acquire` effect 与 `useChatSourceOf` 的租约都还在,所以那台
 *    机器 `refs > 0`、**在册**,压根进不了 `docked` 那张表 —— `evict`(池满逐出)
 *    与它结构上不可能相遇。视图上限 3 < 数据上限 8 这句话因此不是巧合,是余量:
 *    就算三条全停靠着,数据池仍有 8 格空着给别处的会话用。
 *  · **真删那一拍视图必须先没**:`forget → evict` 对一台在册的机器是恒等,所以
 *    删掉一条正停靠着的会话时,拆机器这件事只能由**视图卸载 → 引用归零**去完成。
 *    所以这只文件自己订 `onSessionsDeleted`,不指望别人代劳。
 *
 * ── 为什么「切走」是显式的,不是从树上算出来的 ──────────────────────────
 * 从树上算(「上一拍还在标签里、这一拍不在了 = 停靠」)会把**关掉**也算进去,
 * 而关掉是有明确语义的另一件事:`ContentKind.dispose` 当场丢草稿,「关掉 = 丢
 * 实例」。把它停靠起来等于让一条被关掉的会话在看不见的地方继续挂着、继续持有
 * 引用。所以停靠只从**原位换会话**那三处进来;别的路(关掉 / 新开一格标签 /
 * 拖一格过来)一格都不产生停靠 —— `openMode: 'newTab'` 开出来的那条**自己有
 * 标签**,本来就在 keep-alive 名单上,不必也不该再进这里。
 *
 * ── 对账为什么还是必要的 ────────────────────────────────────────────────
 * 显式那一头只答得出「谁进来」,答不出「谁该出去」:一片叶被关掉(分屏收起、
 * 整区收掉)、一格停靠着的会话被人从别处拖成了标签、换工作区整棵树换掉 ——
 * 三条路都不经过这只文件。所以照 `session-projection` 那本引用账的体例,
 * 每一次拼贴台 store 变化做一次**集合差**(它自己也是在那一遍里被叫的,
 * 三件事读同一份树,一遍算完)。
 */

/**
 * **一片叶最多停靠几条**(缺省 3)。
 *
 * 它是一个**内存上限**:一格停靠 = 一棵已经造出来的 React 树(尾窗 24 条 +
 * 空闲补全之后可能是整份 400 条 / 900 张工具卡),连同它们的 DOM 节点一直占着
 * 渲染进程的堆。3 是「在两三条会话之间来回切」这个真实用法的覆盖面,再往上加
 * 换来的是越来越少的命中率与线性增长的堆。
 *
 * 它**不进 `styles/tokens.css` 也不进 `components/motion.ts`**:那两张表分别是
 * 「视觉量」与「JS 时长」的唯一产地,而这是一个**条数**。同族的先例三条,判词
 * 各写在自己身上:`chat-source.CHAT_SOURCE_DOCK_LIMIT`(数据池 8)、
 * `chat-window.CHAT_TAIL_WINDOW`(尾窗 24,「它是条数不是时长,所以不进
 * motion.ts」)、`ChatStream.ANCHOR_RESETTLE_ROUNDS`(轮数)。把一个内存上限
 * 写进 CSS 变量表会让它看起来像一个可以随主题换的视觉量,那是说谎。
 * 改这个数是一次拍板(与数据池那个 8 同一句)。
 */
export const SESSION_VIEW_PARK_LIMIT = 3

/**
 * 叶 id → 停靠着的那几格,**最近切走的排在最前**(数组次序 = LRU 序,与
 * `chat-source` 那张 Map 的插入序同一手,只是方向相反 —— 这里 `unshift`,
 * 逐出从**队尾**走)。
 *
 * 它是这个模块实例替拼贴台记的一本账,不是可渲染状态;可渲染的那一份是
 * `workbench/kept-contents` 那张表,由下面 `publish` 一处写。
 */
const parks = new Map<string, ContentRef[]>()

/** 写出去。**唯一产地** —— 这只文件里改完 `parks` 一律经它。 */
function publish(leafId: string): void {
  const list = parks.get(leafId)
  if (!list || list.length === 0) {
    parks.delete(leafId)
    setKeptContents(leafId, [])
    return
  }
  setKeptContents(leafId, [...list])
}

/**
 * 「这一格值得停靠吗」——**只有绑着真会话的那一种**。
 *
 * 保留键(`session:new`)答空串,不停:它里面没有任何人做过任何事,而它的草稿
 * 有自己的产地(`composer/drafts`)。不是会话那一种答 null,更不停 —— 这只文件
 * 只认识会话。
 */
function parkable(ref: ContentRef | null | undefined): boolean {
  if (!ref) return false
  const id = sessionIdOfRef(ref)
  return typeof id === 'string' && id !== ''
}

/**
 * **原位换会话那一拍**:把 `outgoing` 停进这片叶的池子,把 `incoming` 从池子里
 * 摘掉(它就要变成标签了,留着就是同一格内容两个层)。
 *
 * 调用点在 `content/session-open.ts` 的每一处 `store.replaceRef` **之前** ——
 * 之前而不是之后,是因为这一句要读的是「换之前那一格是谁」,而调用方手上正好
 * 有它;换完再去树上找已经找不到了。两句在同一个事件处理里,React 自动批处理
 * 把它们合成一次提交(所以屏幕上不会有「A 既是标签又是停靠」的中间帧)。
 */
export function parkSessionSwap(
  leafId: string,
  outgoing: ContentRef | null | undefined,
  incoming: ContentRef | null | undefined,
): void {
  ensureRosterHook()
  const list = parks.get(leafId) ?? []
  const drop = new Set<string>()
  if (incoming) drop.add(refId(incoming))
  if (parkable(outgoing)) drop.add(refId(outgoing as ContentRef))
  const next = list.filter((ref) => !drop.has(refId(ref)))
  if (parkable(outgoing)) next.unshift(outgoing as ContentRef)
  // 超了从**队尾**逐出:那是最早切走的一条(数组头是最近的)。被逐出的那一格
  // 下一次提交就卸载,它的数据机器随引用归零落进 C1 那个 8 格池。
  next.length = Math.min(next.length, SESSION_VIEW_PARK_LIMIT)
  parks.set(leafId, next)
  publish(leafId)
}

/**
 * **集合差**(判词在文件头「对账为什么还是必要的」)。幂等 —— 什么都没变时
 * `publish` 那一句被 `setKept` 的「没变就不 set」挡下,零重渲。
 *
 * 两条判据,各答一件事:
 *  · **这片叶还在吗** —— 不在(分屏收起 / 整区收掉 / 换了一棵树)就整格丢掉;
 *  · **这一格已经是标签了吗** —— 是就摘掉。问的是**全壳所有叶**而不是只问这
 *    一片:`workbench/content-slots` 那张配对表按 refId 一格一份,同一格内容
 *    在两处各挂一层会互相抢 holder(那是存量约束,不是本单引入的)。所以
 *    「A 停靠在这片叶,而人又在隔壁叶把 A 开成了标签」必须当场让停靠让位。
 */
export function reconcileSessionParks(regions: Readonly<Record<string, PaneNode>>): void {
  if (parks.size === 0 && keptContentLeafIds().length === 0) return
  const liveLeaves = new Set<string>()
  const tabbed = new Set<string>()
  for (const tree of Object.values(regions)) {
    for (const leaf of leavesOf(tree)) {
      liveLeaves.add(leaf.id)
      for (const tab of leaf.tabs) for (const part of flattenContent(tab)) tabbed.add(refId(part))
    }
  }
  for (const leafId of [...parks.keys()]) {
    if (!liveLeaves.has(leafId)) {
      parks.delete(leafId)
      setKeptContents(leafId, [])
      continue
    }
    const list = parks.get(leafId) as ContentRef[]
    const next = list.filter((ref) => !tabbed.has(refId(ref)))
    if (next.length !== list.length) parks.set(leafId, next)
    publish(leafId)
  }
  // 表上还挂着、而这本账里已经没有的那几片(热更 / 用例的半途状态)一并清干净。
  for (const leafId of keptContentLeafIds()) {
    if (!parks.has(leafId)) setKeptContents(leafId, [])
  }
}

/**
 * 停靠着的那些会话 id(去重)。**引用账的第三份输入**:
 * `session-projection` 把它并进「树里 ∪ 隐藏表里」那个集合,于是一条只停靠着的
 * 会话照样 `acquire`,照样收流 —— 与那本账上「hidden 的会话叶实例留着继续收流」
 * 逐字同一条理由。
 */
export function parkedSessionIds(): string[] {
  const out = new Set<string>()
  for (const list of parks.values()) {
    for (const ref of list) {
      const id = sessionIdOfRef(ref)
      if (id) out.add(id)
    }
  }
  return [...out]
}

/** 只给测试:这片叶此刻停靠着哪几条(最近的在前)。 */
export function parkedSessionIdsOf(leafId: string): readonly string[] {
  return (parks.get(leafId) ?? []).map((ref) => sessionIdOfRef(ref) ?? '')
}

/**
 * **一批会话真的被删了** —— 停靠着的那几格立刻卸载。
 *
 * 订的是 `onSessionsDeleted`(只从名册的 `deleted` 那一支发),**不是**
 * `onSessionsRemoved`:后者把「被删」与「离开这个工作区」说成同一句话,而换
 * 工作区那一条这只文件另有出口(`clearSessionParks`,由 layout-scope 按次序叫)。
 * 判词整段在 `data/chat-source.ts` 的 `forget` 头上 —— 两处订同一条接缝。
 */
function forgetParkedSessions(sessionIds: readonly string[]): void {
  const dead = new Set(sessionIds)
  for (const [leafId, list] of [...parks.entries()]) {
    const next = list.filter((ref) => !dead.has(sessionIdOfRef(ref) ?? ''))
    if (next.length === list.length) continue
    parks.set(leafId, next)
    publish(leafId)
  }
}

/**
 * 接上名册那条「真的被删了」的接缝。**惰性**(第一次真的停靠时才接)——
 * 模块作用域里接线会在这台壳那条存量 import 环上读到 TDZ(判例写在
 * `content/session-projection.ts` 头上),而第一次停靠一定发生在树跑起来之后。
 */
let stopRoster: (() => void) | undefined
function ensureRosterHook(): void {
  if (stopRoster) return
  stopRoster = onSessionsDeleted(forgetParkedSessions)
}

/**
 * **整池清掉**。两个调用点:换工作区那一拍(`workspace/layout-scope.ts`,排在
 * 拼贴树换装之前 —— 判词在那儿)与模块退役 / 测试。
 *
 * 换工作区为什么是「一起卸载」而不是「随叶走」:整棵树换掉之后那些叶 id 属于
 * 上一个空间,停靠着的会话也属于上一个空间;留着它们等于让另一个空间的几万个
 * DOM 节点在新空间里白占着堆。**数据那一侧照旧留着** —— C1 那个 8 格池换工作区
 * 不清(d22f5865 的判例),所以切回去仍旧是零 `listRaw`,只是要重渲一屏。
 */
export function clearSessionParks(): void {
  parks.clear()
  resetKeptContents()
}

/** 模块退役:连名册那条订阅一起还回去(复用已有那口拆卸,不写第二套)。 */
export function stopSessionParks(): void {
  clearSessionParks()
  stopRoster?.()
  stopRoster = undefined
}

/*
 * 模块级可变状态(那本账 + 名册订阅)= 这个模块实例的寿命(09-01 立法)。
 * 幂等;生产构建里 `import.meta.hot` 是 undefined,整段被 tree-shake。
 */
if (import.meta.hot) import.meta.hot.dispose(stopSessionParks)
