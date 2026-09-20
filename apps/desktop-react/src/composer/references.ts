import { useExposeStore } from '../expose/store'

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
 * chip 的宿主节点身上挂着 `data-ref`,而草稿读出来的是那一枚引用本身,
 * 交出去那一刻投影成那截 token(`{{page:<tabId>}}`)。
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
 * ── 一格槽 → **一张按会话键的表**(W5-c-2)────────────────────────────────
 * 路线 A 之后屏幕上有几片会话叶就有几块输入面板,「此刻挂着的那一块」不再是一句
 * 说得清的话。所以登记按 `sessionId` 分格 —— 而**投递目标仍旧是投影**
 * (`expose.currentSessionId`,焦点那片会话叶在看的那条):从浏览器右键菜单
 * 「把这一页交给对话」按下去时,人心里的收件人就是他正看着的那块面板,
 * 那正是投影这个词的意思。语义与改前逐字相同,只是「哪一块」从「唯一那一块」
 * 变成了「焦点那一块」。
 *
 * ── 三张状态表 ────────────────────────────────────────────────────────────
 * ① 生命周期:`Composer` 挂载时登记自己那一格、卸载时撤销(它自己那只 effect);
 *    这张表的寿命 = 模块实例,所以配 HMR dispose。
 * ② UI 生命状态:**没有输入面**(焦点那条会话此刻没有一块挂着的面板 —— 壳里一片
 *    会话叶都没有,或者焦点叶是终端 / 浏览器)= `insertComposerReference`
 *    答 `false`,调用方据此说一句人话,而不是静默吞掉。
 * ③ UI 交互状态:不归这里(chip 的形在 `ComposerInput`)。
 */

/**
 * 一枚要落进输入框的引用。
 *
 * ── 09-14:两格,而且两格都是**表上的东西** ──────────────────────────────
 * 从前这里是 `{label, token, tip}` —— 调用方自己拼「chip 上写什么」「提示说
 * 什么」,于是网页那一种在表上有一份自述、在这条缝上又有一份手写的形。今天它
 * 只说**哪一种**和**哪一枚**:记号由那一种的 `draft.token(ref)` 算,画成什么由
 * 它的 `render(ref)` 说。这条缝因此一个种类名都不认得(与抽屉那条路同一个形)。
 */
export interface ComposerReference {
  /** 注册表上的种类 id。 */
  kindId: string
  /** 那一种自述里的 Ref(形由它自己说 —— 这条缝不看里面有什么)。 */
  ref: unknown
}

export type ComposerReferenceSink = (reference: ComposerReference) => void

/** 一条会话一格。键 = `sessionId`(保留键那片叶是空串,与草稿表同一条口径)。 */
const sinks = new Map<string, ComposerReferenceSink>()

/**
 * 登记 / 撤销。`Composer` 挂载时调一次,返回撤销 —— **撤销只在还是自己占着那
 * 一格时才清**,不然同一条会话的两块输入面交替挂载时(换宿主、StrictMode 重挂)
 * 后挂的会被先卸的抹掉。
 */
export function configureComposerReferenceSink(
  sessionId: string,
  next: ComposerReferenceSink,
): () => void {
  sinks.set(sessionId, next)
  return () => {
    if (sinks.get(sessionId) === next) sinks.delete(sessionId)
  }
}

/**
 * 往输入框里落一枚引用。
 *
 * ── 收件人:**点名的那一条 ▷ 焦点那一条**(B2)────────────────────────────
 * 缺省仍是「焦点那片会话叶的那一块面板」—— 从浏览器右键菜单「把这一页交给对话」
 * 按下去时,人心里的收件人就是他正看着的那块面板(判词整段在文件头)。
 *
 * 而从**一条消息里的一枚 chip** 点进来时不是这样:人点的是那条消息里的东西,
 * 收件人就是**那条消息所在的会话**,哪怕焦点此刻在别处(同屏两片会话叶是 W5-c
 * 之后的常态)。所以 `sessionId` 是一格可选的点名 —— 给了就照它投,不给才问
 * 焦点。**不做「点名的不在就退回焦点」那一档**:那会让一枚指着 A 会话的 chip
 * 把字填进 B 会话的输入框,比什么都不做坏得多。
 *
 * 答 `false` = 收件人此刻没有输入面(那条会话没有挂着的面板 / 壳里一片会话叶都
 * 没有),调用方据此说一句人话。
 */
export function insertComposerReference(
  reference: ComposerReference,
  sessionId?: string,
): boolean {
  const target = sessionId ?? useExposeStore.getState().currentSessionId
  const sink = sinks.get(target)
  if (!sink) return false
  sink(reference)
  return true
}

/** 测试与 HMR 用:回到「没有输入面」。 */
export function resetComposerReferenceSink(): void {
  sinks.clear()
}

if (import.meta.hot) {
  import.meta.hot.dispose(resetComposerReferenceSink)
}
