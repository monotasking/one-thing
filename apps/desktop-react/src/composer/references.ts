/**
 * **从外面往输入框里落一枚引用** —— 唯一那条缝(B3-b)。
 *
 * ── 它为什么存在(而不是「给 @ 面加一族住户」)────────────────────────────
 * 派工单要求先查清 `@` 面今天有没有「来源」扩展点。**没有**,而且这不是疏漏,
 * 是它今天的形:抽屉的住户是一个**闭合联合** `DrawerKind = 'files' | 'commands'
 * | 'model' | 'status' | null`,`TokenHit.kind` 是它的两格子集,`@` → `files`
 * 那条映射写死在 `transitions.parseToken` 的正则里,`usePickDrawer` 与
 * `DrawerPickList` 各按这两格分支。加一族「打开的网页」要动**五处枚举点**
 * (联合 / token 判据 / hook 的两条分支 / 抽屉的画法 / 选中后的插入),而那正是
 * 仓根 CLAUDE.md「凡『按能力枚举』的地方改成『能力自述、别人读表』」点名的形状
 * —— 在一个功能单里现造那次重构,是把「加功能」做成了「改骨架」。
 *
 * 所以走的是派工单给的**第二条路**:动作留在浏览器叶自己的右键菜单里
 * (「动作单产地 = 右键上下文菜单」),落点是这条缝。
 *
 * ── 落的是**一枚 chip,不是一段正文** ─────────────────────────────────────
 * chip 身上挂着 `data-token`,而草稿读出来的是那截 token(`{{page:<tabId>}}`)。
 * 于是这条路与 `@` 选一个文件**逐字同一条出站路**:token 在草稿里占位,
 * 交出去那一刻由 `data/chat-port` 的**唯一那道展开**物化。点击那一刻**不取正文**
 * —— 20k 字进 store 会跟着草稿一起被存进每条会话的稿里,而人也许根本没发出去。
 *
 * ── 为什么是一格「登记 + 调用」,不是一个 store ────────────────────────────
 * 这里要的不是一格**状态**(没有人需要订阅「有没有人能收引用」),而是一次
 * **调用**:把一枚 chip 递给此刻挂着的那块输入面。与 `composer/sink.ts` 恰好
 * 相反的方向 —— 那边是输入面把一句话交出去,这边是外面把一枚引用交进来。
 * 两条缝都极窄,而且都只有一个真实现。
 *
 * ── 三张状态表 ────────────────────────────────────────────────────────────
 * ① 生命周期:`Composer` 挂载时登记、卸载时撤销(它自己那只 effect);这个模块
 *    自身只有一格 `let`,寿命 = 模块实例,所以配 HMR dispose。
 * ② UI 生命状态:**没有输入面**(壳里此刻没挂 Composer)= `insertComposerReference`
 *    答 `false`,调用方据此说一句人话,而不是静默吞掉。
 * ③ UI 交互状态:不归这里(chip 的形在 `ComposerInput`)。
 */

/** 一枚要落进输入框的引用。 */
export interface ComposerReference {
  /** 屏幕上那枚 chip 写什么(页标题 → 主机名)。 */
  label: string
  /** 草稿里它真正代表的那截文本(`{{page:<tabId>}}`)。 */
  token: string
  /** 鼠标停上去说的整句(页面 URL)。缺席 = 不挂提示。 */
  tip?: string
}

export type ComposerReferenceSink = (reference: ComposerReference) => void

let sink: ComposerReferenceSink | undefined

/**
 * 登记 / 撤销。`Composer` 挂载时调一次,返回撤销 —— **撤销只在还是自己占着那
 * 一格时才清**,不然两块输入面交替挂载时后挂的会被先卸的抹掉。
 */
export function configureComposerReferenceSink(next: ComposerReferenceSink): () => void {
  sink = next
  return () => {
    if (sink === next) sink = undefined
  }
}

/**
 * 往输入框里落一枚引用。答 `false` = 此刻没有输入面(壳里没挂 Composer),
 * 调用方据此说一句人话。
 */
export function insertComposerReference(reference: ComposerReference): boolean {
  if (!sink) return false
  sink(reference)
  return true
}

/** 测试与 HMR 用:回到「没有输入面」。 */
export function resetComposerReferenceSink(): void {
  sink = undefined
}

if (import.meta.hot) {
  import.meta.hot.dispose(resetComposerReferenceSink)
}
