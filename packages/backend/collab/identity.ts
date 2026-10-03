/**
 * 可被指认的身份 —— 句柄编解码的**共用真源**
 * (docs/design/collab-handle-codec.md §2.1)。
 *
 * ## 这个模块存在的理由:识别与授权分家
 *
 * 句柄机制是一对编解码:出站把身份写成 `名字#句柄`,入站认出来、搬进
 * `mentions[]`、把 `#句柄` 删掉。它成立的唯一条件是
 * **`解码(编码(x))` 对身份域里每一个 x 都成立**。
 *
 * 此前不成立,而且缺口是结构性的:解码用的名单是 `roomMembers()`,而那份名单
 * 同时扛着两个互不相干的职责 ——
 *
 *  1. **谁能被识别**(这串字符是不是一个真身份);
 *  2. **谁能被激活**(把谁的模型拉起来答话)。
 *
 * 第 2 条理应严格(在职、在本房),于是第 1 条被一起收窄了 —— 用户、退休成员、
 * 非本房成员统统"编码发了、解码不认",句柄原样落进转录。**识别面被授权面
 * 绑架**,这是那一整类泄漏的来源。
 *
 * 这个模块只负责第 1 条。它收得越全,清理得越干净;而放宽它**不会**让任何人
 * 被误唤醒 —— 激活侧本来就各自 `.filter(memberIds.has(agentId))`
 * (`activation.ts`),非成员进不了队列。授权仍旧归成员名单管。
 *
 * ## 用户为什么在这里
 *
 * 用户没有 agent id,但**有**句柄(`agent-dm-user.md` §2.3:花名册里那行
 * `名字#句柄(用户)` 与同事行同形)。既然出站发了,解码就必须认得 —— 否则
 * 它是这套系统里泄漏最多的那一个 token(实测 35 处里占 17)。
 */
import type { CollabAgentLike } from './types.js'
import { collabAgentHandle } from './handle-format.js'

/**
 * 永远能指到用户本人的两个词。**即使用户从没配置过资料**,`dm to:"用户"` 也
 * 必须可达 —— 一个只在配置之后才存在的通道等于没有通道。
 *
 * 单一属主:`dm-target.ts` 的收件人匹配与裸句柄的"名实相符"判据共用这一份,
 * 两处各抄一份的下场是可预见的(改一处、另一处安静地不认)。
 */
export const COLLAB_USER_CONSTANT_WORDS = ['用户', 'user'] as const

/**
 * 一个可被指认的身份。
 *
 * `agentId` 只有 agent 有 —— 用户这一格就是**缺席**,不造一个合成 id。造假 id
 * 的代价是它迟早会被某个人当真拿去 `findAgent`,而那一次失败会发生在离这里
 * 很远的地方。
 */
export interface CollabIdentity {
  kind: 'agent' | 'user'
  /** agent 的花名册 id。用户没有。 */
  agentId?: string
  /** 模型面的定位符(`名字#句柄` 里 `#` 后面那一截)。 */
  handle: string
  /** 主名:显示用,也是"名实相符"判据的第一候选。 */
  label: string
  /** 还能用什么写法指认 TA。用户是那两个常量词;agent 只有本名(即 label)。 */
  aliases: readonly string[]
}

/** agent → 身份。句柄是 id 的纯函数,所以这里不需要任何上下文。 */
export function collabIdentityFromAgent(agent: CollabAgentLike): CollabIdentity {
  const label = agent.name?.trim() || agent.id
  return {
    kind: 'agent',
    agentId: agent.id,
    handle: collabAgentHandle(agent.id),
    label,
    aliases: [],
  }
}

/** 用户 → 身份。label 走档案名(缺省「用户」),handle 走 `resolveUserIdentity`。 */
export function collabUserIdentity(label: string, handle: string): CollabIdentity {
  return {
    kind: 'user',
    handle: handle.trim(),
    label: label.trim() || COLLAB_USER_CONSTANT_WORDS[0],
    aliases: COLLAB_USER_CONSTANT_WORDS,
  }
}

/** 一批 agent → 目录。给只关心同事的调用点(测试、纯 agent 场景)用。 */
export function collabIdentitiesFromAgents(
  agents: readonly CollabAgentLike[],
): CollabIdentity[] {
  return agents
    .filter(agent => Boolean(agent?.id?.trim()))
    .map(collabIdentityFromAgent)
}

/**
 * 这个写法指的是这个身份吗 —— 「名实相符」判据用的那一问。
 *
 * 真实调用点是 `app/collab/dm-target.ts` 的用户档匹配:`dm to:` 写的那个名字
 * 认不认得是这一问,而它此前自己抄了一份别名表比对(架构审查 B8 的三份匹配
 * 实现之一)。
 *
 * 与 `handles.ts#matchTrailingName` 的分工:那边扫的是正文,要的是**命中的
 * 那个写法本身**(剥句柄时得知道删掉多长一截),所以它做的是后缀匹配、返回
 * 字符串;这边收到的已经是切好的一截,只需回答是或不是。同一条判据的两种
 * 返回形状,不是两份判据。
 *
 * 大小写:英文常量词与十六进制按小写比,中文名按原文比(中文没有大小写,
 * `toLowerCase` 对它是恒等变换,所以一律小写化是安全的)。
 */
export function collabIdentityAnswersTo(identity: CollabIdentity, name: string): boolean {
  const probe = name.trim()
  if (!probe) return false
  if (probe === identity.label) return true
  const lower = probe.toLowerCase()
  if (lower === identity.label.toLowerCase()) return true
  return identity.aliases.some(alias => alias.toLowerCase() === lower)
}
