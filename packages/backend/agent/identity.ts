/**
 * Agent 派生 id 的唯一属主(M6,docs/design/agent-domain-model.md §5)。
 *
 * 每一个 `agent-*` 形状的会话/房间 id 都在这里造出来,别处一律 import,不再
 * 各自拼字符串。收口的动机不是洁癖:IM 化(docs/design/agent-im-dm.md §2.1/
 * §3.1)一次新增了两族 id(用户私聊房、agent 互聊房),而 `agent-exec-` 一族
 * 的字面量已经在换过一次形态时(W18 全局 → collab-team-v2 per-room)散落到
 * 多个文件里。约定散着写 = 下一次换形态要靠 grep 记性。
 *
 * ## 纪律:只有构造,没有解析
 *
 * 本模块**永不**提供 `parseAgentIdFrom(sessionId)` 之类的反函数,这不是"还没
 * 写",而是 API 形状上的禁令:
 *
 *  - 派生 id 的唯一职责是**幂等键**——同一个(agent × 房间)永远算出同一个 id,
 *    于是 "ensure" 是 `get(id) ?? create(id)`,不需要注册表;
 *  - **归属**永远读结构化字段:执行会话属于哪个房间读 `collab.roomSessionId`,
 *    房间有哪些成员读 `room.memberAgentIds`,会话属主读 `session.agentId`。
 *
 * 理由是 agentId 本身可以含任意横线(`agent-research`、nanoid),所以任何反解
 * 都得靠"猜分隔符在哪"——猜对了是巧合,猜错了是把两个 agent 的历史合成一个人。
 * 结构化字段是被写进去的事实,反解是对事实的重新发明。构造+比对(把算出来的
 * id 与手上的 session id 相等比较)是允许的,那还是把 id 当幂等键用。
 *
 * 产品层模块:零依赖、Electron-free、纯字符串函数。
 */

/** 每条 agent 执行会话 id 的前缀。稳定值 —— 它被持久化了。 */
export const AGENT_EXEC_SESSION_PREFIX = 'agent-exec-'

/** 用户 ↔ agent 托管私聊房(单成员 dm 房)的前缀。agent-im-dm.md §2.1。 */
export const AGENT_DM_ROOM_PREFIX = 'agent-dm-'

/**
 * agent ↔ agent 私聊房(双成员 dm 房)的前缀。agent-im-dm.md §3.1。
 *
 * 刻意是 `AGENT_DM_ROOM_PREFIX` 的子命名空间,于是"这是不是 dm 房"一个前缀
 * 就判完。代价是一个 id 为 `room-x--y` 的 agent 的私聊房会与 agent 对
 * (`x`,`y`)的房间同形 —— 约定由设计定稿拍板,这里只如实记下这道残余歧义
 * (真实 agentId 由 UI 生成,不长这样;真要撞上也只是两间房共用一个幂等键,
 * 而不是归属被认错——归属读成员表)。
 */
export const AGENT_DM_PAIR_ROOM_PREFIX = `${AGENT_DM_ROOM_PREFIX}room-`

/**
 * 双成员 dm 房 id 里两个 agentId 之间的分隔符。
 *
 * 双横线:agentId 自身可以含单横线,单横线分隔会让 `a-b` + `c` 与 `a` +
 * `b-c` 撞成同一间房。
 */
export const AGENT_DM_PAIR_SEPARATOR = '--'

/** 空白归一:空 id 没有派生 id(调用方本该先解析出真 agent)。 */
function normalizeId(value: string | undefined | null): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 一个 agent 在某个房间里跑回合的执行会话 id
 * (collab-team-v2 §1.1:每群每 agent 一条常驻会话)。
 *
 * 派生而非随机:ensure 就是 `getSession(id) ?? create(id)`,永不需要 agent →
 * session 的映射表。空/空白 agentId 没有会话,返回 null。
 *
 * ## 为什么 id 里要带房间
 *
 * W18 给每个 agent 一条全局执行会话,于是同一个 agent 在两个群里共用一条流,
 * 而 `collab.roomSessionId` 这个指针每次 drive 前都可能被后到者改写。W18 的锁
 * 注释里记着由此而来的三类事故(supersede、半个回合、指针被写坏)。把房间编进
 * id 之后,指针从"会被改写的动态路由"降级成"创建时写一次的恒定归属标记",
 * 第三类事故在结构上消失,前两类退回同一条会话内部的常规竞争。
 *
 * 顺带两件事免费拿到:`withAgentSessionLock` 的 key 本来就是这个 id,于是串行
 * 粒度自动从 per-agent 降到 per(agent×群)——两个群同时激活同一个 agent 不再
 * 互等;预算按会话求和时,一条执行会话只属于一个房间,跨房重复计消失。
 *
 * 省略 roomSessionId 时返回的是**旧的全局形态**,只为两件事保留:迁移期扫描
 * 旧转录(§1.4),以及只按前缀判断"这是不是执行会话"的读者。新回合一律带房间。
 */
export function execSessionId(agentId: string, roomSessionId?: string): string | null {
  const id = normalizeId(agentId)
  if (!id) return null
  const room = normalizeId(roomSessionId)
  return room
    ? `${AGENT_EXEC_SESSION_PREFIX}${id}-${room}`
    : `${AGENT_EXEC_SESSION_PREFIX}${id}`
}

/**
 * 迁移期要扫的执行会话集合(collab-team-v2 §1.4)。
 *
 * W23 的二级去重靠扫执行会话转录里的 drive 戳记来决定"这条房间消息是不是已经
 * 被应答过"。换 id 形态之后,戳记分散在新旧两处:不并集扫,升级后的第一次 boot
 * 会把旧会话里已应答过的消息当成没应答过,整屋子重放一遍。
 *
 * ## 什么时候可以只扫新集
 *
 * 判据不是"发过一个版本"(那只是时间流逝,与哪台机器上还留着什么无关),而是
 * **存储里再没有旧形态的会话**:`<store>/sessions/` 下不存在任何形如
 * `agent-exec-<agentId>`(**不带**房间后缀)的会话目录。
 *
 * 那一天到了,这个函数与 `execSessionId` 的无房间重载一起撤,两个消费点
 * (`app/collab/budget.ts`、`app/collab/queue.ts`)改成直接调 `execSessionId`。
 * 在那之前少扫一处 = 整间房重放一遍,代价远大于多读一条不存在的会话。
 */
export function execSessionIdsForScan(agentId: string, roomSessionId: string): string[] {
  const scoped = execSessionId(agentId, roomSessionId)
  const legacy = execSessionId(agentId)
  return [scoped, legacy].filter((id): id is string => Boolean(id))
}

/**
 * 用户 ↔ agent 托管私聊房的 id(agent-im-dm.md §2.1,D1)。
 *
 * 惰性建房用的幂等键:联系人第一次点开时 `get(id) ?? create(id)`,同一个 agent
 * 永远同一间房。**本期没有消费方**——IM P1 才接线;约定先于消费收口,是为了
 * 让接线那天没有"再造一次字面量"的机会。
 */
export function userDmRoomId(agentId: string): string | null {
  const id = normalizeId(agentId)
  if (!id) return null
  return `${AGENT_DM_ROOM_PREFIX}${id}`
}

/**
 * agent ↔ agent 私聊房的 id(agent-im-dm.md §3.1,D3)。
 *
 * 两个 agentId 按 UTF-16 码元序排序后用双横线拼接,于是同一对 agent 无论谁发起
 * 都落在同一间房(幂等)。刻意不用 `localeCompare`:那玩意儿依赖 locale,同一
 * 对 agent 在两台机器上可能算出两个 id,而这个 id 是要落库的。
 *
 * 同一个 agent 与自己没有私聊房,返回 null;任一侧为空同样返回 null。
 * **本期没有消费方**(IM P3 才接线)。
 */
export function agentDmRoomId(agentIdA: string, agentIdB: string): string | null {
  const a = normalizeId(agentIdA)
  const b = normalizeId(agentIdB)
  if (!a || !b || a === b) return null
  const [first, second] = a < b ? [a, b] : [b, a]
  return `${AGENT_DM_PAIR_ROOM_PREFIX}${first}${AGENT_DM_PAIR_SEPARATOR}${second}`
}

/** 这个 id 是 agent 执行会话吗?(只看 id,不查 store。) */
export function isAgentExecSessionId(sessionId: string | undefined | null): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith(AGENT_EXEC_SESSION_PREFIX)
}

/**
 * 这个 id 是 dm 房吗?单成员(用户私聊)与双成员(agent 互聊)都算 —— 后者的
 * 前缀是前者的子命名空间,故一次判完。
 */
export function isAgentDmRoomId(sessionId: string | undefined | null): boolean {
  return typeof sessionId === 'string' && sessionId.startsWith(AGENT_DM_ROOM_PREFIX)
}

/**
 * 这个 id 属于 agent 基础设施族吗?(执行会话 + dm 房。)
 *
 * 前缀判断的唯一收口点:"哪些会话不该出现在普通列表里"这类问题从此只有一个
 * 答案。注意这仍然只是 id 层的启发式 —— 真正决定一条会话是什么的是它的
 * `kind`(renderer 的 `isAgentExecutionSession` 就明确以 kind 为准)。本函数是
 * 给"手上只有一个 id"的场景用的。
 */
export function isAgentInfraSessionId(sessionId: string | undefined | null): boolean {
  return isAgentExecSessionId(sessionId) || isAgentDmRoomId(sessionId)
}
