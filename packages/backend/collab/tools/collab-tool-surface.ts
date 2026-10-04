/**
 * 房面 / 工作台面的**工具地板**(D5 + W14b §4.5)——两张常量表,不是一条规则。
 *
 * 这里只答一件事:一间房、一个工作台会话**至少**要有哪几个工具。答「这一回合
 * 最终能用哪些工具」的是 `agents/profile.ts`:这两张表在那边登记成 capability
 * grant(`AGENT_TOOL_GRANTS`),由 `resolveAgentToolSurface` 一处做并集 —— union
 * 语义(collab-team-v2 §2.1)也归它:地板叠在 agent 自己的白名单上,没配白名单
 * 就是不限制,agent 的真工具永远不会被顶掉。
 *
 * 2026-08-03(架构收敛 C2「工具面单点」)之前,这个文件里还有一份
 * `resolveCollabToolAllowlist`,把同一条 kind → 工具面的规则又写了一遍,两个文件
 * 在注释里互相要求对方保持一致。生产链路早就只走 profile.ts 那一份,这一份只剩
 * 测试在引用;而那份人肉对齐的义务**真的漂移过一次**(房面加 `history` 时只有
 * 一边跟上了)。函数已删,表留下:一条规则一处实现,漂不动才是对齐。
 */

// 场子本身(类型、归一化、按会话取场子)住在 session(越层清零 A2);这里只答「哪个协作工具在哪个场子成立」。
import { collabVenueOf, type CollabVenue, type CollabVenueSession } from '@onething/backend/session'

/**
 * The tools every room turn must have, whatever else the agent carries.
 *
 * `say` + `board` are the original pair, and W22 is why it was not three for a
 * while. W18b briefly added `stay_silent` so that the forced opening call would
 * leave silence reachable; the model then looped on it (77 calls in four turns,
 * 真机 2026-07-28) because an inert tool whose result says "now stop" is still a
 * legal next move. The tool stayed retired when the forced opening call itself
 * was removed (2026-07-30, see turn.ts): silence is now simply "call nothing",
 * which leaves a turn no landing spot to spin on at all.
 *
 * `dm` joined on 2026-07-30 (agent-im-dm.md §3.4 / D5) and left again on
 * 2026-08-02: it is now the `to` parameter of `send_message`
 * (collab-send-channel-and-wake.md §2 —— 一个带 channel 的发送面)。旧名保留为
 * **隐藏真工具**(`tools/builtin/dm.ts`),刻意不在这张表里 —— 进来就等于进
 * 请求的 tools 参数,模型会看见两个同义工具,而合并的全部意义就是只有一个。
 */
/**
 * `history` 于 2026-08-02 加入(collab-history-search.md),取代同年 08-01 那个
 * 只查当前房折叠段的 `room_history`。它先是**按天折叠的配套**——投影不再逐字带
 * 四天历史了,那就必须留一条翻回去的路,否则折叠就是静默截断;取消默认隔离之后
 * 它同时是**跨房的那条路**:同一位同事在群里、在私聊里说过的话,查得回来。
 *
 * 进 floor 是安全的,因为它只读、且授权由数据推(`collabRoomVisibleUntil`):
 * 它能查的恒等于「我在场过的房」,别人之间的对话对它不存在。
 */
/**
 * `say` 于 2026-08-02 改名 `send_message`(collab-turn-protocol-and-identity.md A)。
 * 旧名保留为**静默别名**(`COLLAB_SEND_MESSAGE_LEGACY_TOOL_NAME`),但它刻意
 * **不进这张表** —— 进来就等于进请求的 tools 参数,模型会看见两个同义工具。
 */
export const COLLAB_ROOM_TOOLS: readonly string[] = ['send_message', 'board', 'history']

/**
 * Tools a work session must have on top of whatever its agent was given:
 * 交付协议要 `board`(complete/block),而 W14b 把交付本身变成了 worker 自己的
 * 话,所以 `send_message` 也是必需的。同样是**加**在白名单上,不是替换它。
 */
export const COLLAB_WORK_REQUIRED_TOOLS: readonly string[] = ['board', 'send_message']

/**
 * 跨房笔记的工具面(Collab v3 D2,docs/design/collab-actor-v3.md §1.2)。
 *
 * **单独一格,不并进 `COLLAB_ROOM_TOOLS`**:那张表是 v2 房回合的地板,而 v2 的
 * 调度链到 D6 才退役 —— 把 notebook 并进去,今天每一个 v2 房回合的请求里都会多
 * 一个工具,而写下的笔记要等到 v3 接线才有人读。「只加不改」这条纪律在这里的
 * 形态就是:表加一格,但先不挂到任何一个 session kind 上(见 `agents/profile.ts`
 * 的 `collab-notebook` 那一行)。
 */
export const COLLAB_NOTEBOOK_TOOLS: readonly string[] = ['notebook']

/** 有场子门的协作工具。用工具**注册名**,与模型看到的那个名字逐字一致。 */
export type CollabVenueTool = 'send_message' | 'board' | 'history' | 'notebook'

/**
 * **一览表**:每个协作工具在哪些场子里成立。
 *
 * 三个工具今天允许的场子完全相同,而表仍然一工具一行 —— 合并成一句「协作工具都
 * 是这三格」会把「碰巧相同」写成「按定义相同」,下一次某个工具要单独收紧时,改的
 * 人就得先把这句话拆回来,而拆错了没有任何东西会报错。
 *
 * `dm` 不在表里:它已经不是工具,是 `send_message` 的 `to` 参数
 * (collab-send-channel-and-wake.md §2),门自然共用 `send_message` 那一行。
 *
 * **为什么不从 `agents/profile.ts` 的工具地板推**(C3-6 原方案设想的「一处声明
 * 两面消费」):地板答的是「这个场子**至少**发几个工具」,门答的是「这个工具**至多**
 * 在哪些场子里成立」,两者不是互逆。实证:`COLLAB_WORK_REQUIRED_TOOLS` 里没有
 * `history`(工作台不需要框架硬塞给它),而工作台会话**是**可以查历史的 —— 按地板
 * 推门会把工作台的 history 静静地关掉。硬融的代价是一次静默收紧,所以留成独立小表。
 */
export const COLLAB_TOOL_VENUES: Readonly<Record<CollabVenueTool, readonly CollabVenue[]>> = {
  send_message: ['room', 'agent', 'work'],
  board: ['room', 'agent', 'work'],
  history: ['room', 'agent', 'work'],
  // notebook 少一格 `room`,而这**不是**手滑:W18 之后房回合跑在执行会话里
  // (`agent` 场子),`room` 场子的会话本身早就不承载回合了。给它开一格没有回合
  // 的场子,等于给一条谁都不会走的路留一道门 —— 而每一道多余的门都是下一次
  // 授权审计要重新论证的东西。普通对话(`chat`)同理不给:那里没有「别的房」,
  // 一本跨房笔记在那个语境里只会是一个多出来的旋钮。
  notebook: ['agent', 'work'],
}

/** 门本身。拒绝**文案**不在这里 —— 每个工具的那句话是它自己的资产(见各执行器)。 */
export function isCollabToolAllowedInVenue(tool: CollabVenueTool, venue: CollabVenue): boolean {
  return COLLAB_TOOL_VENUES[tool].includes(venue)
}

/**
 * 门:这条会话能不能调这个工具(越层清零 A2 从 `collab/collab-venue.ts` 逐字搬来 —— 它带着场子门,
 * 所以随工具留在协作,不随场子判据去 session)。
 */
export function collabToolAllowedInSession(
  session: CollabVenueSession | null | undefined,
  tool: CollabVenueTool,
): boolean {
  return isCollabToolAllowedInVenue(tool, collabVenueOf(session))
}
