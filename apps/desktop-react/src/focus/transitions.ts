import { findCommand, matchCombo } from '../keymap/transitions'
import type { CommandId, KeymapPlatform } from '../keymap/types'
import { FOCUS_SCOPES } from './scopes'
import type { ComboEvent } from '../keymap/types'
import type {
  ActivePath,
  FocusInstanceId,
  FocusTreeNodes,
  KeyRoute,
  ScopeNode,
} from './types'

/**
 * **响应链的四个问题,四只纯函数**(设计 §4.2 / §4.3 / §4.4 / §4.5)。
 *
 * 这只文件不认识 React、不查 `document`、不改任何东西。它只读传进来的那张
 * 不可变 `Map<instanceId, ScopeNode>` 与一条路径,回一个答案。有状态的那一头
 * 是 `registry.ts` 里的 `FocusTree`,组件层只是把这里的答案落到 DOM 上。
 *
 * 这样分的理由不是洁癖:「活动路径怎么算」「键归谁」「Esc 退哪一层」「卸载后
 * 回哪儿」这四件事在旧的八套机制里各自散在四个组件的 effect 里,谁都测不到 ——
 * 08-30 → 09-01 那三轮 Esc 相位改法之所以要靠真机反复试,正是因为判据从来没有
 * 一个能单独跑的形状。
 *
 * ── 元素引用与「纯」 ────────────────────────────────────────────────────
 * `ScopeNode.root` / `.lastFocused` 是元素引用,这里会读它们的 `.isConnected`
 * 与 `.contains()`。那仍然是纯的:答案只由**传进来的东西**决定,不问 `document`、
 * 不问 `window`、不问哪个元素此刻有焦点。单测里造真 DOM 元素就能钉。
 * ──────────────────────────────────────────────────────────────────────────
 */

/** 这个节点**自己**此刻可不可以当第一响应者。`inert` 由注册表算好(§4.7)。 */
export function isInteractive(node: ScopeNode | null | undefined): node is ScopeNode {
  return Boolean(node) && !node!.inert
}

/**
 * 这个节点**连同它的祖先链**此刻可不可以接焦点 —— 「路径经过 inert 就在那儿截断」
 * (`registry.ts` 文件头那张表)在纯函数这一头的字面兑现。
 *
 * ── 为什么要有第二只(2026-09-12「收起 ≠ 关闭」抓的)──────────────────────
 * `isInteractive` 只看节点自己那一格旗。从前它够用,因为「祖先 inert 而孩子自己
 * 不 inert」这一形在树上**活不到被问**:架子收起来把整层卸载,层里那些节点连表都
 * 不在。架子收起改成保挂载之后,`shelf-layer` 打了 `inert`,它底下那片 `leaf` 自己
 * 的旗还是干净的 —— 归还从 `search` 往上走,第一个碰到的就是这片 `leaf`,于是把
 * 焦点送进了一块 `inert` 的面:浏览器对 inert 子树里的 `focus()` 是**空动作**,
 * 焦点留在原地,随后被 Chromium 的 focus fixup 扔回 body,I1 收回再把它捡到 root
 * (`gate:focus` 场景 17 ④-b 逐字量到的就是这一条)。
 *
 * 父不在表上是**合法的中间态**(同一次提交里父子一起挂载,子先登记),走到就停,
 * 按「没人说它不行」算 —— 与 `activePathOf` 那条边界同一个判据。
 */
export function isReachablyInteractive(
  nodes: FocusTreeNodes,
  node: ScopeNode | null | undefined,
): node is ScopeNode {
  if (!isInteractive(node)) return false
  const seen = new Set<FocusInstanceId>()
  let at = node.parent
  while (at && !seen.has(at)) {
    seen.add(at)
    const ancestor = nodes.get(at)
    if (!ancestor) return true
    if (ancestor.inert) return false
    at = ancestor.parent
  }
  return true
}

/**
 * 一个元素此刻**收不收得下焦点**:仍连通,且不在任何 `inert` 子树里(含自己)。
 *
 * 树上的判据(上面那只)与 DOM 上的判据是两条,缺一条都会漏:`lastFocused` /
 * `restingTarget` / `root` 记的是**元素**,而元素可能躺在一个树上没登记的
 * `inert` 容器里(架子的树身那只 div 不是作用域,它的 `inert` 只有 DOM 知道)。
 * 仍然是纯的:只读传进来的那个元素自己的属性与祖先链,不问 `document`。
 */
export function acceptsFocus(el: HTMLElement | null | undefined): el is HTMLElement {
  return Boolean(el) && el!.isConnected && el!.closest('[inert]') === null
}

/**
 * 从第一响应者出发,顺着**逻辑父**走到根,回一条**根在前**的路径。
 *
 * 三种要答对的边界:
 *  · 传进来的实例不在树上(刚卸载)→ 空路径,由调用方去缩;
 *  · 父不在树上 —— **合法的中间态**:React 的 effect 子先于父跑,同一次提交里
 *    一起挂载的父子,子登记的那一刻父还没登记。走到就停,回已经走到的那一段,
 *    不抛也不假装它是根(等父登记完,下一次读就完整了);
 *  · 环(不该有,但一个环会让这里死循环)→ 见过的实例就停。
 */
export function activePathOf(
  nodes: FocusTreeNodes,
  focused: FocusInstanceId | null,
): ActivePath {
  if (!focused) return []
  const chain: FocusInstanceId[] = []
  const seen = new Set<FocusInstanceId>()
  let at: FocusInstanceId | null = focused
  while (at && !seen.has(at)) {
    const node = nodes.get(at)
    if (!node) break
    seen.add(at)
    chain.push(at)
    at = node.parent
  }
  return chain.reverse()
}

/**
 * 路径**缩到最近一个仍可交互的祖先**(§4.2 来源 3)。
 *
 * 判据从根往深走:碰到第一个「不在树上了」或「不可交互(inert)」的节点就在
 * 那儿截断 —— 它和它下面的一切都不再是响应者。
 *
 * 为什么从根往深、而不是从深往浅找第一个活着的:一个 inert 的**祖先**下面
 * 可能还挂着一个自己没被打 inert 的孩子(架子切 tab:旧层打 inert,层里那块面
 * 自己没打)。从深往浅找会把那个孩子选成第一响应者,而它整块都看不见了。
 */
export function shrinkPath(nodes: FocusTreeNodes, path: ActivePath): ActivePath {
  const out: FocusInstanceId[] = []
  for (const id of path) {
    if (!isInteractive(nodes.get(id))) break
    out.push(id)
  }
  return out
}

/**
 * 一次按键归谁(§4.3;K0 起走的是**候选命令集**)。
 *
 * 顺序,由深到浅沿活动路径:
 *  ① 这一格**认领**了这个键(`FOCUS_SCOPES[scope].claims`)→ 回 `claim`,
 *    调用方不 `preventDefault`、不再往外问,事件原样交给里面那台程序;
 *  ② 这一格**答得出**候选里的某一条(`node.commands[c]`)→ 回 `scope`;
 *  ③ 路径走完 → 候选里 `app: true` 的那一条走 `root`(应用层兜底);
 *  ④ 还没有 → null,放行(页面 / PTY / 系统菜单接着走)。
 *
 * 「局部先接、没接住放行全局」这条裁定一个字没变,变的是它靠什么成立:
 * 最早靠 DOM 冒泡序(事件先经过面域根、才到 window),R2 起靠树的深度,
 * K0 起把「全局」这个词换成了「有应用层兜底的那一条命令」—— 同一件事,
 * 但现在它是命令表上的**一格数据**,派发器一行都不读命令名。
 * 用户报的 ⌘F 就死在最早那条判据上 —— 查看器在活动路径上,但那一下按键
 * 没有经过它的根,于是局部键根本没被问到。
 *
 * `candidates` 是算好递进来的(`keymap/transitions.lookupCommands`):候选要读
 * 用户的改绑(zustand store),那是有状态的东西,不该长进这只文件。
 *
 * 候选里有、那一格**没有注入处理器** → 当作没命中,继续往浅走。理由:声明与
 * 落点分叉时,宁可让键落到应用层(可预期),也不要吞掉这一下(表现为
 * 「按了没反应」)。
 */
export function routeKey(
  nodes: FocusTreeNodes,
  path: ActivePath,
  event: ComboEvent,
  candidates: readonly CommandId[],
  /**
   * 「主修饰键是哪一枚物理键」(T1-fix)。**必填** —— 判词整段在
   * `keymap/transitions.matchCombo` 上:给它一个默认值,忘了传的调用点就会悄悄
   * 回到「⌘ 与 Ctrl 两枚皆可」那条老路,而那正是这一改要治的病。
   * 纯函数照旧不读 `navigator`:量它的是派发器(`focus/dispatch.ts`)。
   *
   * 候选那一半已经解释过平台了,这里还要它是因为 `claims` 是**组合**不是命令
   * (认领不进命令表,判词在 `FocusScopeSpec.claims` 上)。
   */
  platform: KeymapPlatform,
): KeyRoute {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const node = nodes.get(path[i])
    if (!isInteractive(node)) continue
    const spec = FOCUS_SCOPES[node.scope]
    if (node.claiming !== false && spec.claims?.some((c) => matchCombo(event, c, platform))) {
      return { target: 'claim', instanceId: node.instanceId, scope: node.scope }
    }
    for (const command of candidates) {
      if (!nodeAnswers(node, command)) continue
      return { target: 'scope', instanceId: node.instanceId, scope: node.scope, command }
    }
  }
  for (const command of candidates) {
    if (findCommand(command)?.app) return { target: 'root', command }
  }
  return null
}

/**
 * **这一格此刻答得出这条命令吗** —— 判据只有这一句,`routeKey` 与
 * `routeCommand` 共用它(K4)。
 *
 * `commands[id]` 是**动态**的:叶没有活动 tab 时 `tab.close` 是 `undefined`,
 * 浏览器刚开那一格没有历史时 `nav.back` 是 `undefined`(K3 判例)。所以
 * 「声明里有」与「此刻交得出」是两件事,而这里问的永远是后者。
 */
function nodeAnswers(node: ScopeNode, command: CommandId): boolean {
  return Boolean(node.commands?.[command])
}

/**
 * **一条命令此刻归谁做**(K4)—— 与 `routeKey` 同一条判据,少了「按键」那一半。
 *
 * 菜单栏上点一项、以及菜单项画不画灰,两处都问它。为什么不是直接调 `routeKey`:
 *  · `routeKey` 要一个 `ComboEvent`,而菜单点击**没有按键** —— 造一个假事件出来
 *    只为了喂给它,等于让「这一下是哪个键」凭空多一个说法;
 *  · `claims`(「这几个键归里面那台程序」)是**按键**这一层的概念:它说的是
 *    「别截这个键」,而不是「别做这件事」。用户在菜单栏上点「查找」,终端没有
 *    理由把它当成一次要让给 PTY 的按键。
 * 剩下那两问 —— 由深到浅找第一个答得出的响应者、再落到应用层兜底 —— 逐字是
 * 同一段代码(`nodeAnswers` + `findCommand(...).app`),所以菜单画灰与按键不响
 * 永远是同一件事。
 */
export function routeCommand(
  nodes: FocusTreeNodes,
  path: ActivePath,
  command: CommandId,
): KeyRoute {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const node = nodes.get(path[i])
    if (!isInteractive(node)) continue
    if (!nodeAnswers(node, command)) continue
    return { target: 'scope', instanceId: node.instanceId, scope: node.scope, command }
  }
  return findCommand(command)?.app ? { target: 'root', command } : null
}

/**
 * Esc 沿路径**由深到浅**的候选序(§4.4)。回的是**节点表**而不是「谁答了 true」——
 * `onEscape()` 会关掉一扇浮层(有后果),纯函数不许调它。真正一个个问下去的是
 * `dispatch.ts`,它拿到这张表按序问,第一个答 true 的消费掉这一下。
 *
 * 不可交互的那几格直接不进表:一块 inert 的面不该吃掉这一下 Esc。
 */
export function routeEscape(nodes: FocusTreeNodes, path: ActivePath): readonly ScopeNode[] {
  const out: ScopeNode[] = []
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const node = nodes.get(path[i])
    if (!isInteractive(node)) continue
    if (!node.onEscape) continue
    out.push(node)
  }
  return out
}

/**
 * **Tab 该被圈在哪一格里**(§4.1 `modal` 那一行的内置行为)。
 *
 * 判据分两步,第二步是有病历的:
 *  ① 活动路径上**最深**的那个 modal —— 正常情形(焦点在模态里),
 *    「对话框里开一张菜单,Tab 圈在菜单里」由深度回答。
 *  ② 路径上一个 modal 都没有,但树上有 —— **焦点跑到模态外面去了**。
 *    这一步不能省:`ui/a11y/focus-trap` 那只退役的 hook 把监听挂在 document 上
 *    而不是容器上,理由逐字是「焦点万一已经跑到容器外面,挂容器就再也收不到
 *    这一下 Tab,圈禁当场失效」。只按路径判等于把那条判例丢掉:一次程序置焦、
 *    一次点击落在浮层背后,模态就再也圈不住键盘了。
 *    模态的意思本来就是「这块面在,键盘不许走开」,所以它不该取决于焦点此刻
 *    恰好在哪儿。
 *
 * 两步都取**树深最大**的那一个:同时有两格模态时(对话框 + 它里面的菜单),
 * 深的那一个赢 —— 与①同一个口径,不引入第二种说法。
 * 没铺根元素的不算(还没到位的东西圈不住任何东西)。
 */
export function modalTrapNode(nodes: FocusTreeNodes, path: ActivePath): ScopeNode | null {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const node = nodes.get(path[i])
    if (node && node.kind === 'modal' && isInteractive(node) && node.root) return node
  }
  let best: ScopeNode | null = null
  let bestDepth = -1
  for (const node of nodes.values()) {
    if (node.kind !== 'modal' || !isInteractive(node) || !node.root) continue
    let depth = 0
    const seen = new Set<FocusInstanceId>()
    let up: FocusInstanceId | null = node.parent
    while (up && !seen.has(up)) {
      seen.add(up)
      depth += 1
      up = nodes.get(up)?.parent ?? null
    }
    if (depth > bestDepth) {
      best = node
      bestDepth = depth
    }
  }
  return best
}

/**
 * 一个节点最近的**仍可交互的祖先**(§4.2 来源 3 的**结构**那一半)。
 *
 * 它与 `returnTargetOf` 是两件事,必须分开:前者答「路径缩到谁」,后者答
 * 「焦点落到哪个元素」。合成一件的后果被单测逮住过 —— 祖先此刻还没铺上根元素
 * (合法中间态)时,`returnTargetOf` 答不出元素,于是**整条路径被清空**,
 * 第一响应者凭空消失。路径是结构,不该因为一个元素还没到就没了。
 */
export function nearestInteractiveAncestorOf(
  nodes: FocusTreeNodes,
  node: ScopeNode | undefined,
): ScopeNode | null {
  const seen = new Set<FocusInstanceId>()
  let at = node?.parent ?? null
  while (at && !seen.has(at)) {
    seen.add(at)
    const ancestor = nodes.get(at)
    if (!ancestor) return null
    /*
     * 先把「下一站」取出来再判:`isInteractive` 是个类型谓词,它的**假分支**
     * 会把 `ancestor` 收窄成 `never`(这一支永远 return,所以只剩那一支),
     * 于是判完再读 `.parent` 编译不过。取值与判定分两句是最省事的写法。
     */
    const up = ancestor.parent
    // 连同祖先链一起判:架子收起保挂载之后,层里的叶自己的旗是干净的(判词在 `isReachablyInteractive` 上)。
    if (isReachablyInteractive(nodes, ancestor)) return ancestor
    at = up
  }
  return null
}

/** 焦点该落回的那个位置。 */
export interface FocusReturnTarget {
  instanceId: FocusInstanceId
  element: HTMLElement
}

/**
 * 一个作用域卸载 / 变得不可交互之后,焦点回哪儿(§4.5)。
 *
 * ── ① `returnTo`:兄弟之间的那一格(R2 落地 §4.5 的 R1 审查裁定)────────────
 * 「关掉什么,焦点回打开它的地方」(§3.5 规则 5)与「缩回父」不是一回事:⌘P 开
 * 出来的检索面与它之前那块输入面板是**兄弟**,父链到不了。所以先问树替这一格
 * 记下的上一任第一响应者,三条判据缺一不可:
 *  · 那一格**仍在树上**(它自己可能已经先卸载了);
 *  · 仍**可交互**(架子切 tab 之后它可能正 inert —— 往一块看不见的面送焦点比
 *    孤儿焦点更难排查);
 *  · 记下的那个元素**仍连通**(往一个已经离开文档的节点 focus,浏览器把焦点
 *    扔回 body,那正是 I1 要根治的东西)。
 * 任一条不成立就**退回父链**(下面那三格),不去猜第二个候选 —— 记的是一格,
 * 不是一条链(§10「不做焦点历史」)。
 *
 * ── ② 父链:从它的**父**开始往上,第一个可交互的祖先接手,顺序是:
 *  ① 那个祖先「上次焦点所在」的元素 —— 前提是它**仍然连通**且**仍在那个祖先里**
 *    (跳转条卸载后回查看器上次那一行,就是这一格);
 *  ② 它声明的落点(`restingTarget()`);
 *  ③ 它的根元素。
 * 三格都答不出就再往上一层。全树都答不出回 null —— 调用方此时什么都不做,
 * 而不是把焦点扔给 body(那正是 I1 要根治的孤儿焦点)。
 *
 * 「仍在那个祖先里」这条判据不能省:`lastFocused` 记的是一个元素,而那个元素
 * 完全可能是刚被卸载的那块面里的东西(祖先的 lastFocused 在孩子接管焦点时
 * 也会被更新)—— 往一个已经不在树里的节点上 focus,浏览器会把焦点扔回 body。
 */
export function returnTargetOf(
  nodes: FocusTreeNodes,
  node: ScopeNode | undefined,
): FocusReturnTarget | null {
  const seat = node?.returnTo
  if (seat) {
    const back = nodes.get(seat.instanceId)
    if (isReachablyInteractive(nodes, back) && acceptsFocus(seat.element)) {
      return { instanceId: back.instanceId, element: seat.element }
    }
  }
  const seen = new Set<FocusInstanceId>()
  let at = node?.parent ?? null
  while (at && !seen.has(at)) {
    seen.add(at)
    const ancestor = nodes.get(at)
    if (!ancestor) return null
    /*
     * 树上「可交互」连祖先链一起判,元素候选再过一道 DOM 的 `inert`(两条判据的
     * 判词在 `isReachablyInteractive` / `acceptsFocus` 上)。三格候选的**顺序**
     * 一个字没动:上次焦点所在 → 声明的落点 → 根。
     */
    if (isReachablyInteractive(nodes, ancestor)) {
      const last = ancestor.lastFocused
      if (acceptsFocus(last) && ancestor.root?.contains(last)) {
        return { instanceId: ancestor.instanceId, element: last }
      }
      const resting = ancestor.restingTarget?.() ?? null
      if (acceptsFocus(resting)) {
        return { instanceId: ancestor.instanceId, element: resting }
      }
      if (acceptsFocus(ancestor.root)) {
        return { instanceId: ancestor.instanceId, element: ancestor.root }
      }
    }
    at = ancestor.parent
  }
  return null
}

/**
 * 一个作用域此刻的落点(焦点进来时落在哪)。声明优先,否则根。
 * `float` / `modal` 常常声明它(输入框 / 首项),`region` 多半就是根。
 */
export function restingElementOf(node: ScopeNode | undefined): HTMLElement | null {
  if (!node) return null
  const declared = node.restingTarget?.() ?? null
  if (declared && declared.isConnected) return declared
  return node.root && node.root.isConnected ? node.root : null
}

/**
 * 一个元素落在哪个作用域里 —— **最内层**那一个。
 *
 * 判据是 DOM 包含,不是树:焦点是 DOM 的事实,而 portal 出去的浮层在 DOM 上
 * 自成一棵,它的根照样 `contains` 自己里面那个输入框。多个作用域同时包含时取
 * 「根元素最深」的那个(祖先的根一定包含后代的根,所以最深 = 最内层)。
 */
export function scopeAtElement(
  nodes: FocusTreeNodes,
  el: Node | null,
): ScopeNode | null {
  if (!el) return null
  let best: ScopeNode | null = null
  let bestDepth = -1
  let bestTreeDepth = -1
  for (const node of nodes.values()) {
    const root = node.root
    if (!root || !root.contains(el)) continue
    let depth = 0
    for (let p: Node | null = root.parentNode; p; p = p.parentNode) depth += 1
    /*
     * 两格作用域**共用同一个根元素**时(比如某一层与住在它里面的那块面铺在
     * 同一个 div 上)DOM 深度打平,这时按**树深**分:里面那一格赢。
     * 不分的话答案会变成「谁先登记谁赢」,而登记序是 React 的实现细节。
     */
    let treeDepth = 0
    const seen = new Set<FocusInstanceId>()
    let up: FocusInstanceId | null = node.parent
    while (up && !seen.has(up)) {
      seen.add(up)
      treeDepth += 1
      up = nodes.get(up)?.parent ?? null
    }
    if (depth > bestDepth || (depth === bestDepth && treeDepth > bestTreeDepth)) {
      best = node
      bestDepth = depth
      bestTreeDepth = treeDepth
    }
  }
  return best
}
