/**
 * `dm` 的 `to` 指的是谁(docs/design/agent-dm-user.md §3.1)。
 *
 * 此前 `to` 只认 agent —— 用户没有 agentId,于是 `dm to:"用户"` 必然解析失败。
 * 这个模块在 `resolveCollabAgentHandle` **之前**加一档用户匹配,而不是改写它:
 * 那个函数的语义是"从同事名册里找一个人",给它塞进一个不是 agent 的返回值会
 * 污染它另外两个调用点(board 的 assignee、say 的 mentions)——用户既不能被
 * 指派卡,也不在 mentions[] 里。
 *
 * 匹配顺序是"先用户后同事",冲突则**双双拒绝**:用户的名字或句柄撞上某个
 * agent 时,两个答案都成立,而 dm 发错人是不可撤销的。与既有的 agent 重名
 * 拒绝同款措辞——列出候选,让模型用精确写法再说一次(A1「绝不 default 冒充」)。
 */
import {
  collabIdentityAnswersTo,
  collabUserIdentity,
  formatCollabAgentHandle,
  resolveCollabAgentHandle,
  splitCollabHandleQuery,
  type CollabAgentLike,
} from '@onething/runtime/collab'
import { resolveUserIdentity } from './user-identity.js'

export type CollabDmTarget =
  | { kind: 'user' }
  | { kind: 'agent'; agentId: string }

export type CollabDmTargetResolution =
  | { ok: true; target: CollabDmTarget }
  | { ok: false; error: string }

/**
 * 这个写法指的是用户吗。
 *
 * 三份匹配实现的收口(架构审查 B8):此前这里自己 `lastIndexOf('#')` 切一遍、
 * 自己抄一份常量词表比对,于是"什么算名字、名字对不上算不算否决"这两件事
 * 在同事档与用户档各有一套。现在语法切分走 `splitCollabHandleQuery`(与
 * `resolveCollabAgentHandle` 同一份),名实相符走 `collabIdentityAnswersTo`
 * (别名表就是 `collabUserIdentity` 的 aliases,不再有第二份常量词表)。
 *
 * 判定本身一字未改:
 *  - 裸写 —— 常量词(用户 / user)或本名,别名表说了算;
 *  - `#句柄` / 裸句柄 / `名字#句柄` —— **以句柄为准**,名字只当显示,与同事档
 *    逐字同构;但名字写了就不能是别人的(写成「小李#我的句柄」不算指用户)。
 */
function matchesUser(raw: string, identity: { label: string; handle: string }): boolean {
  const self = collabUserIdentity(identity.label, identity.handle)
  const query = splitCollabHandleQuery(raw)

  // 裸写:整串直接问别名表。`一天` / `用户` / `USER` 都在这一格答完。
  if (!query.hashed && collabIdentityAnswersTo(self, query.raw)) return true

  const handle = self.handle.toLowerCase()
  // 空句柄不该匹配任何东西 —— 否则一个没配过资料的用户会认领掉 `#`(以及裸写
  // 的空串)。既有实现在这里是漏的,收口顺手补上。
  if (!handle || query.handle.toLowerCase() !== handle) return false
  return !query.name || collabIdentityAnswersTo(self, query.name)
}

export function resolveDmTarget(
  query: string | undefined | null,
  agents: readonly CollabAgentLike[],
): CollabDmTargetResolution {
  const { raw } = splitCollabHandleQuery(query)
  if (!raw) return { ok: false, error: '要发给谁?to 填花名册里的写法「名字#句柄」,发给用户本人就写「用户」。' }

  const identity = resolveUserIdentity()
  if (!matchesUser(raw, identity)) {
    const resolved = resolveCollabAgentHandle(raw, agents)
    return resolved.ok
      ? { ok: true, target: { kind: 'agent', agentId: resolved.agentId } }
      : { ok: false, error: resolved.error }
  }

  // 命中用户 —— 但同一个写法也可能指向某位同事。两边都成立时不选,只报。
  const clashing = resolveCollabAgentHandle(raw, agents)
  if (clashing.ok) {
    const agent = agents.find(candidate => candidate.id === clashing.agentId)
    const agentLabel = agent ? formatCollabAgentHandle(agent.id, agent.name) : clashing.agentId
    return {
      ok: false,
      error: `「${raw}」既是用户本人,也是同事${agentLabel} —— 说清是哪一个:发给用户写「用户」,发给同事写「#${agentLabel.split('#')[1] ?? ''}」。`,
    }
  }

  return { ok: true, target: { kind: 'user' } }
}
