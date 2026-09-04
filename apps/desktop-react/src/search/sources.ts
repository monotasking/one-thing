/**
 * **壳自带产地的那几类**(S4a)。
 *
 * 设计 `docs/design/search-index-2026-09.md` §9 说 tab / 次序全由自述算,结果行按
 * `target.kind` 取渲染器。那两件本批都做到了。**这个文件是第三件事的诚实记账**:
 * 壳这一侧对三类命中有**自己的产地**,不走 `search.query`——
 *
 * | 能力 | 壳里的产地 | 为什么不走通用查询 |
 * | --- | --- | --- |
 * | `chats` | 整张 `sessions.listMeta` 在手,本地滤 | 零延迟;而且会话名的**唯一产地**是壳那张表(改名走 SSE 增量),再要一份必然漂 |
 * | `messages` | `search.query` 的 `category:'messages'`(`data/message-search-source.ts`) | 它**已经**是通用查询的一档;这里列出来是因为壳对它另有一层「当前空间投影」 |
 * | `files` | `files.list`(`data/files-source.ts`) | 文件命中在壳里是按名字找文件,与检索能力那一路同源但走的是文件域的口 |
 *
 * 别的能力(`prompts` / `daily` / `actions`,以及将来任何一个插件能力)**没有**
 * 壳自带产地 —— 它们走通用路:`search.query` + 目标渲染注册表。加一类能搜的东西
 * 因此**不用碰这个文件**,那正是 §4.0 的硬指标。
 *
 * ── 为什么能力 id 允许出现在这里 ────────────────────────────────────────
 * `__tests__/no-capability-literals.test.ts` 那道闸禁的是「面板 / tab 条 / 分组 /
 * 分页 / 状态行里出现能力 id」—— 骨架不许认识能力。这个文件不是骨架,它是
 * **「壳对这三类另有产地」这个事实本身**,和 `targets/<kind>.tsx` 一样属于
 * §4.0 允许动的那两处之一。三个 id 写在这里一次,别处一律读它。
 *
 * ── 什么时候这个文件会消失 ──────────────────────────────────────────────
 * 当壳这一侧的会话表 / 文件表也从同一条 `search.query` 上来的时候(S4b 之后)。
 * 那不是本批的事:换掉 `chats` 的产地会一并换掉命中的口径(本地子串 vs 索引词元)、
 * 章节命中、当前空间投影 —— 那是一次可感知的行为变化,要单独拍。
 */

/** 会话(标题 / 预览 / 章节)。壳的产地是整张 listMeta。 */
export const CHATS_CAPABILITY = 'chats'

/** 消息正文。壳的产地是 `search.query` 的这一档 + 一层当前空间投影。 */
export const MESSAGES_CAPABILITY = 'messages'

/** 文件名。壳的产地是 `files.list`。 */
export const FILES_CAPABILITY = 'files'

/**
 * 壳自带产地的那三个 id。**唯一用途是「这一档要不要发通用查询」** ——
 * 在表里 = 有自己的产地,不在 = 走通用路。
 */
export const NATIVE_SOURCE_CAPABILITIES: readonly string[] = [
  CHATS_CAPABILITY,
  MESSAGES_CAPABILITY,
  FILES_CAPABILITY,
]

/** 这一档有没有壳自带的产地。`all` 档同时吃两边,所以判据只对单类档有意义。 */
export function hasNativeSource(capability: string): boolean {
  return NATIVE_SOURCE_CAPABILITIES.includes(capability)
}
