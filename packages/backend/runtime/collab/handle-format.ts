/**
 * 句柄的**形状** —— 这套编解码里唯一一段不认识"身份"的代码
 * (docs/design/collab-agent-handle.md §2.1)。
 *
 * 单独成模块只为一件事:打断依赖环。`identity.ts` 造身份时要算句柄,而
 * `handles.ts` 解码时要问身份"你答不答应这个名字" —— 两边互相 import 就成环。
 * 句柄格式是它们共同的**叶子**:它只认识字符串,不认识 agent、不认识用户。
 *
 * `handles.ts` 原样 re-export 这三个名字,所以既有 import 路径一个都不用改。
 */

/** 句柄默认位数。与看板短卡号 `#<8位>` 同为 8 是善意:让模型只需记一种长度。 */
export const COLLAB_AGENT_HANDLE_CHARS = 8

/** id 去掉 `agent-` 前缀后的那一段:句柄从它切,解析也拿它比。 */
export function collabAgentIdKey(agentId: string): string {
  return agentId.trim().replace(/^agent-/, '')
}

/**
 * 句柄 = id 的**纯函数**。没有"按本次名册消解冲突"那一步,这是刻意的 ——
 * 唯一性范围随调用点变化的话,一个**写对了**的句柄会在别处解析失败,而这种
 * 失败没有任何线索可循。确定性 > 理论唯一性。
 *
 * 内置 default agent 的 id 是字面量 `'default'`(不是 uuid),所以规则不能写死
 * 「切 8 位」:短 id 原样用,否则 `defaul` 这种半截词又难认又难解析。
 */
export function collabAgentHandle(agentId: string): string {
  const key = collabAgentIdKey(agentId)
  return key.length <= COLLAB_AGENT_HANDLE_CHARS ? key : key.slice(0, COLLAB_AGENT_HANDLE_CHARS)
}
