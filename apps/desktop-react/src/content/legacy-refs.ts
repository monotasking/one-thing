import { NEW_SESSION_KEY, SESSION_KIND } from './session-ref'
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
 * 幂等由形状自证:`session` / `dir` 这两种都不在这张表的**左边**,翻译过的档案
 * 再翻一遍原样交回(引用恒等靠最后那句 `return ref`,而不是靠调用方少调一次)。
 */
export const rewriteLegacyContentRef: RefRewrite = (ref: ContentRef): ContentRef | null => {
  if (ref.kind === LEGACY_CHAT_KIND) {
    return { kind: SESSION_KIND, key: ref.key === LEGACY_CHAT_KEY ? NEW_SESSION_KEY : ref.key }
  }
  if (ref.kind === LEGACY_DIR_KIND) return { kind: DIR_KIND, key: ref.key }
  return ref
}

/** W1 那一种的名字(它今天叫 `session`)。只在这只文件里出现。 */
const LEGACY_CHAT_KIND = 'chat'
/** W1 那一格死的 key(它今天是会话 id)。 */
const LEGACY_CHAT_KEY = 'main'
/** 目录那一种 W3–K2b-1 之间的名字(它今天叫 `dir`)。只在这只文件里出现。 */
const LEGACY_DIR_KIND = 'files-root'
