import { NEW_SESSION_KEY, SESSION_KIND } from './session-ref'
import { PANEL_KIND } from '../stage/panel-ref'
import { DIR_KIND } from './kinds/dir-ref'
import type { ContentRef } from '../workbench/kinds'
import type { RefRewrite } from '../workbench/persist-migrate'

/**
 * **改过名的那些内容种类**(W5-b 裁定 1 / 裁定 2)。
 *
 * 这是「一种内容改了名字之后,存量档案怎么翻译」的**唯一**产地。它住在内容层
 * (种类名的地盘),走档案那一遍由 `workbench/persist-migrate.ts` 做 —— 那只文件
 * 知道档案长什么形,却一个种类名都不知道。分家的判据与全批一致:
 * **核心层不出现任何一种内容的名字**。
 *
 * ── v1 → v2:`chat:main` → `session:new` ─────────────────────────────────
 * W1 的聊天区是一格单例 `chat:main`(全应用一份);W5-b 它改名 `session`、
 * `key` 换成**会话 id**。存量档案里那一格于是翻成保留键 `session:new`
 * (「还没绑会话的那片会话叶」)。
 *
 * **为什么恒是保留键、而不是「上次那条会话」**:当前会话**不跨启动持久化**——
 * 理由白纸黑字写在 expose 那一槽的 `partialize` 上(「记一个可能已被删掉的 id,
 * 换来的是一个指向空气的标题」)。所以档案里根本没有那个 id 可读;开机后
 * 投影会立刻把这一格换成真正该看的那条(`enterSession` / `seed()` 各管一路)。
 *
 * ── v3 → v4:`files-root:<路径>` → `dir:<路径>`(K2b-1)────────────────────
 * `docs/design/atom-2026-09.md` §7 盲点 2 点名的那次改名:壳与 core 用同一张
 * scheme 表,目录那一格在那张表里叫 `dir`。**key 一个字不动** —— 改的只是种类名,
 * 它装的仍旧是同一条绝对路径。
 *
 * ── v5 → v6:`panel:diff` **丢掉**(「改动」面)────────────────────────────
 * 这是这张表上第一条**答 `null`** 的规则,而 `null` 那一档从 W5-b 立表那天就在
 * (`RefRewrite` 的注:「答 `null` = 这一格该整个丢掉」)—— 今天它有了第一个消费者。
 *
 * 改动那块瓦降格成启动瓦之后,`renderContent('diff')` 答 `null`。存量档案里那一格
 * `panel:diff` 于是变成**一格画不出东西的 tab**:标签还在(`panel` 那一种认得它,
 * `sanitize` 的 `known` 判的是**种类**不是瓦 id),点开是一块空白。留着不是无害的
 * —— 它与 stage v8 清 `viewer` 那一段是同一个病(「开机恢复出一块查不到内容的瓦」),
 * 判词逐字抄那儿。
 *
 * **不翻成 `diff:<something>`**:这一格档案里没有任何一个目录可读(从前那块瓦是
 * 单例,它的 key 就是死的 `'diff'`),编一个出来只会开出一格指着别人目录的面。
 * 丢掉之后那块瓦照旧在 Dock 上,点一下就是新的那条路。
 *
 * 幂等由形状自证:`session` / `dir` 这两种都不在这张表的**左边**,而 `panel:diff`
 * 丢过一次就不在档案里了 —— 翻译过的档案再翻一遍原样交回(引用恒等靠最后那句
 * `return ref`,而不是靠调用方少调一次)。
 */
export const rewriteLegacyContentRef: RefRewrite = (ref: ContentRef): ContentRef | null => {
  if (ref.kind === LEGACY_CHAT_KIND) {
    return { kind: SESSION_KIND, key: ref.key === LEGACY_CHAT_KEY ? NEW_SESSION_KEY : ref.key }
  }
  if (ref.kind === LEGACY_DIR_KIND) return { kind: DIR_KIND, key: ref.key }
  if (ref.kind === PANEL_KIND && ref.key === RETIRED_DIFF_PANEL_ID) return null
  return ref
}

/** W1 那一种的名字(它今天叫 `session`)。只在这只文件里出现。 */
const LEGACY_CHAT_KIND = 'chat'
/** W1 那一格死的 key(它今天是会话 id)。 */
const LEGACY_CHAT_KEY = 'main'
/** 目录那一种 W3–K2b-1 之间的名字(它今天叫 `dir`)。只在这只文件里出现。 */
const LEGACY_DIR_KIND = 'files-root'
/**
 * 「改动」那块瓦**当面板**时的 key(它今天是一块启动瓦,面在 `diff:<workdir>`)。
 *
 * **写成本地常量,不从 `diff-launcher` import**:那只文件在模块作用域里跑
 * `registerStageLauncher(...)`,import 它就是把「改动瓦是启动瓦」这句登记装进调用
 * 方的世界 —— 而这只文件被 `workbench/store` 的 persist 迁移吃着。判词整段在
 * `content/dir-open.ts` 的文件头上(09-12 那桩真事故:`summon-entries.test.ts` 5 红)。
 * 上面那两个 `LEGACY_*` 是同一条纪律的前两次落地。
 */
const RETIRED_DIFF_PANEL_ID = 'diff'
