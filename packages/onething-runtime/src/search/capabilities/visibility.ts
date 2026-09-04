/**
 * 「这个主体能看见哪几条会话」—— 会话域能力的可见范围(S6,拍点辛 a)。
 *
 * 设计:docs/design/search-index-2026-09.md §0 拍点辛 / §6.4b(授权是查询的输入)/
 * §14.2(可见范围那一段)。
 *
 * ## 为什么是一个端口,而不是一段判据
 *
 * 拍点辛 a 那句话是「当前空间里的**非协作**会话 + 自己是**成员**的协作房」。这两个
 * 词——空间归属、协作成员——都是**会话仓的知识**:前者住 `SessionMeta.workspaceId`,
 * 后者住 `SessionMeta.room.memberAgentIds`,而判据本身(`collabRoomVisibleUntil` /
 * `resolveCollabVenue`)是协作域的资产。检索能力不该认识它们中的任何一个:
 *
 *  - 让 manifest 自己去读会话表 = 检索域长出一份第二手的成员名单,而
 *    `identity-directory.ts` 的文件头记着上一次「第二份名单」造成的泄漏;
 *  - 让 core 认识「协作」= 直接破 §3 那条法(core 里不出现能力名,也不出现产品
 *    形态名)。
 *
 * 所以这里只留**形**:主体 → 一串会话号 → `{ sessionId: [...] }`。谁是成员、哪个
 * 空间、什么叫「非协作」,全部由装配层注入的那一件答(`backend/wiring/search/
 * visibility.ts`)。**这个文件的代码里**一个协作 / 房 / 空间的概念都读不到 —— 上面这段
 * 注释提到它们,只是为了说明它们为什么不在下面。
 *
 * ## 缺省是**关**,不是开
 *
 * 端口没装 = 这台宿主答不出「谁是成员」。那时 agent / plugin 得到的是**空清单**
 * (一条都看不见),不是「不限」—— 一个答不出授权的宿主放行,那不是降级,是绕过
 * (与 `core/permission/principal.ts` 的 `systemPrincipal` 同一条纪律)。
 * 用户主体不经这条路:它恒为全可见(§6.4b 的缺省规则)。
 *
 * ## 空清单在底下是「恒不命中」,不是语法错
 *
 * `{ sessionId: [] }` 走到 SqliteIndex 的 `facetClause` 是 `filter.length === 0
 * → null`(恒不命中),不是 `IN ()`;core 的 `matchesFacetFilter` 对空数组同样恒假。
 * 两侧一致,所以「看不见任何东西」是一个**能被表达**的范围,不是一个洞。
 */

import type { SearchPrincipal, VisibilityScope } from '@onething/core/search'

/**
 * 会话可见范围的产地。装配层实现它,这里只声明形。
 *
 * **同步**:`VisibilityRule` 是 `(principal) => VisibilityScope`,fanout 在调
 * `search()` 之前同步算好塞进 filters(§6.4b)。宿主那一侧读的是已经在内存里的
 * 会话列表投影,所以同步是够的 —— 要是哪天它变成一次 IO,该改的是 core 的规则
 * 签名,不是在这里偷偷起一个缓存。
 */
export interface SearchVisibilityPort {
  /**
   * 这个主体能看见哪些会话。
   *
   * 返回的是**允许清单**(`FacetFilter` 的数组形 = 属于)。空数组 = 一条都看不见。
   * 主体是用户时这条路根本不会被问到(见 `sessionScopeVisibility`)。
   */
  visibleSessionIds(principal: SearchPrincipal): readonly string[]
}

let port: SearchVisibilityPort | null = null

/**
 * 装上产地;返回**还原**函数(不是「清空」)。
 *
 * 还原而不是清空,与 `backend/server/search-providers.ts` 同一条判例:桌面内嵌
 * 的那份与 `server:start` 那份可能在同一个进程里先后起落,后者落地时不该把前者
 * 的槽一起带走。
 */
export function configureSearchVisibilityPort(next: SearchVisibilityPort | null): () => void {
  const previous = port
  port = next
  return () => {
    if (port === next) port = previous
  }
}

export function getSearchVisibilityPort(): SearchVisibilityPort | null {
  return port
}

/**
 * 会话域能力(messages / chats)共用的那条 `visibility` 规则。
 *
 * 三个主体各一支,逐条对着 §6.4b 末段的缺省规则:
 *
 *  | 主体 | 范围 | 依据 |
 *  | --- | --- | --- |
 *  | `user` | 全可见(`{}`) | §6.4b「用户 → 全可见」 |
 *  | `agent` | 端口给的那串会话号 | 拍点辛 a |
 *  | `plugin` | 空 —— 只见自己产的文档,而本批没有任何插件产会话文档 | §6.4b「插件 → 只见自己产的」 |
 *
 * 插件那一支给空集而不是全可见:今天没有插件在往会话域里写文档,所以「只见自己
 * 产的」在这一格上的**真值**就是零条。等哪天插件能产会话文档了,这一支要换成
 * 「按产地过滤」,那时它需要文档上多一格 `producer` facet —— 那是另一件事,不是
 * 今天先放行再说的理由。
 */
export function sessionScopeVisibility(principal: SearchPrincipal): VisibilityScope {
  if (principal.kind === 'user') return {}
  if (principal.kind === 'plugin') return { sessionId: [] }
  const configured = port
  if (configured === null) return { sessionId: [] }
  return { sessionId: [...configured.visibleSessionIds(principal)] }
}
