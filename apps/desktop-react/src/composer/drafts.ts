import type { Attachment } from './types'

/**
 * **一条会话一份草稿**(W7-t / B2,设计 `workbench-2026-09.md` §8 W5)。
 *
 * ── 报障与病根 ────────────────────────────────────────────────────────
 * 真机读数(审计 B 第 79 条):A、B 两格会话并排,在 A 里打字 → 切到 B,B 的
 * 输入框里躺着 A 的稿;在 B 里接着打 → 回到 A,A 的稿已经被顶掉了
 * (`leak: true, aOverwritten: true`)。
 *
 * 病根是**输入框是外壳级的一件、而它的内容没有主人**:草稿住在那块
 * contenteditable 的 DOM 里,附件住在一格模块级 store 里,两样都只有一份,
 * 而屏幕上会话有好几条。W5-a 治过同型的一遍(聊天数据机器从模块级单例改成
 * 「一条会话一台 + 一张注册表」),这一格走的是同一条路:
 *
 *  · **按 `sessionId` 键**的一张表 —— 一条会话一份稿;
 *  · W7-t/B2 时 `.composerDock` 那只输入框组件**只有一个**(路线 B:它在
 *    `.center` 上不进树),渲染的是当前活动会话那份:换会话时先把旧那份存下来,
 *    再把新那份铺上去(接线在 `composer/components/Composer.tsx` 那一句
 *    layout effect 上)。**W5-c 路线 A 之后一片会话叶一只**,`sessionId` 是叶递
 *    下来的 prop、一格叶一辈子不变,于是那句接线在生产上只剩「挂载铺稿 / 卸载
 *    存稿」两条边 —— 这张表因此比从前更简单,而它一行都没改;
 *  · 丢弃时机只有一个 —— **那条会话被真的关掉**(`ContentKind.dispose`,
 *    在 `content/kinds/session.tsx` 上)。藏起来的会话叶照样留着稿。
 *
 * ── 为什么存 HTML 而不是纯文本 ────────────────────────────────────────
 * 那块可编辑区里 `@` 引用是**真节点**(不可编辑的 chip,真正代表的那截文本挂在
 * `data-token` 上,判词在 `ComposerInput.readDraft`)。存纯文本等于换一格会话
 * 回来 chip 就散成几个字 —— 而它散掉之后发送出去的那句话与人看见的不再是同一句。
 *
 * ── 「输入框高度」那一格 ──────────────────────────────────────────────
 * 它不是一格状态:那块可编辑区的高由内容自己撑(`Composer.module.css`),
 * 所以把 HTML 铺回去,高度当场跟着回来。这里因此没有它的位置。
 *
 * ── 寿命 ──────────────────────────────────────────────────────────────
 * 这张 Map 的寿命是「这个模块实例」,所以配一段 HMR 退役(09-01 立法);
 * 退役复用 `resetComposerDrafts()` 那一口,不写第二套。
 */

export interface ComposerDraft {
  /** 那块可编辑区的 `innerHTML`(chip 是真节点,见文件头)。 */
  html: string
  /** 这条会话上挂着还没发出去的附件。对象 URL 跟着它走 —— 丢弃时才 revoke。 */
  attachments: readonly Attachment[]
  /** 拍立得摞是展开着的吗。 */
  attOpen: boolean
}

const DRAFTS = new Map<string, ComposerDraft>()

/** 一份空稿。**同一个常量**,免得三处各写一遍 `{ html: '', … }` 而漏一格。 */
export const EMPTY_DRAFT: ComposerDraft = { html: '', attachments: [], attOpen: false }

/** 这一份是不是「什么都没有」—— 空稿不进表(表里躺着一堆空壳没有意义)。 */
function isEmpty(draft: ComposerDraft): boolean {
  return draft.html.trim().length === 0 && draft.attachments.length === 0
}

/**
 * 存下这条会话的稿。**空稿等于删掉**:一格会话打完字又清空,表里不该留一具空壳。
 * `sessionId` 空串 = 「还没绑会话」那一态,它照样是一格合法的键(首开草稿态的
 * 那些字要留得住),所以这里**不**拿空串当缺席。
 */
export function saveComposerDraft(sessionId: string, draft: ComposerDraft): void {
  if (isEmpty(draft)) {
    dropComposerDraft(sessionId)
    return
  }
  DRAFTS.set(sessionId, draft)
}

/** 读这条会话的稿。没有 = 一份空稿(调用方不必判 undefined)。 */
export function readComposerDraft(sessionId: string): ComposerDraft {
  return DRAFTS.get(sessionId) ?? EMPTY_DRAFT
}

/**
 * **这条会话此刻有没有一份还没发出去的稿**(C2 转正之二的读口)。
 *
 * 它是**一句谓词**而不是让调用方自己去比 `readComposerDraft(id).html.trim()`:
 * 「什么算空稿」在这只文件里已经有一个产地(`isEmpty` —— 存稿那一口也读它),
 * 而外面再写一遍的下场是草稿多一格字段时两处判据分叉。
 *
 * 唯一调用点是 `content/session-open.previewSeatOf`:要换掉预览格之前先问一句
 * ——「里面有人打了字」就把它转正,另开一格预览。**留账**:稿只在换会话 / 卸载
 * 那两拍才进这张表(`components/Composer.tsx` 那两条 layout effect),所以
 * 「刚打完字、一个字都还没存下来就点了别的会话」这一次问不到 —— 补它要一口
 * 「输入框此刻有没有字」的**活**读口,那一口的产地在那只组件上。
 */
export function hasComposerDraft(sessionId: string): boolean {
  const draft = DRAFTS.get(sessionId)
  return draft !== undefined && !isEmpty(draft)
}

/**
 * 丢掉这条会话的稿(会话被关掉 / 稿被清空)。
 * **对象 URL 谁造谁销**:附件的 URL 是 `composer/store` 造的,这里只是它的
 * 第三个销点 —— 所以销那一句由调用方注入(`configureDraftRevoke`),
 * 这只文件不认识 `URL.revokeObjectURL`。
 */
export function dropComposerDraft(sessionId: string): void {
  const gone = DRAFTS.get(sessionId)
  if (!gone) return
  DRAFTS.delete(sessionId)
  revoke?.(gone.attachments)
}

/**
 * **销附件 URL 那一口由 `composer/store` 注入**。理由是「谁造谁销」:URL 是那只
 * store 造的,它自己那两处(删一枚 / 发出去)已经在销了,这里是第三处 ——
 * 三处调同一只函数,而不是这只文件自己再写一遍 `URL.revokeObjectURL`。
 * 单产地的另一半好处:jsdom / 非浏览器宿主的缺席判据也只有一份。
 */
let revoke: ((atts: readonly Attachment[]) => void) | undefined
export function configureDraftRevoke(fn: (atts: readonly Attachment[]) => void): void {
  revoke = fn
}

/** 只给测试与整台壳重置:把这张表清空(附件 URL 一并销掉)。 */
export function resetComposerDrafts(): void {
  for (const id of [...DRAFTS.keys()]) dropComposerDraft(id)
  DRAFTS.clear()
}

/** 只给测试:表里此刻记着哪几条会话。 */
export function composerDraftKeys(): readonly string[] {
  return [...DRAFTS.keys()]
}

/*
 * 模块级可变状态的 HMR 退役(09-01 立法)。复用已有那口拆卸,不写第二套。
 */
if (import.meta.hot) import.meta.hot.dispose(() => resetComposerDrafts())
