/**
 * 回合工具面的**场景表**(2026-08-18 工具梳理)。
 *
 * 注册表是目录,这里答的是「这一回合把哪些工具**放进请求**」。同一个进程里同时
 * 跑着普通对话、群房回合、派工出去的工作会话,注册表只有一份,所以「进哪个场景
 * 才给哪些工具」不能靠注册/注销来做 —— 只能在回合入口按场景算。
 *
 * 表是**减法**:默认全给,列在这里的工具只在对应场景亮起,其余场景从工具面
 * 上摘掉。摘掉而不是执行时拒绝(与 `tasks/index.ts` 的 `sessionHiddenToolIds`
 * 同一条理由):摆在工具表里的工具模型会去调,调了被拒是一次纯浪费的往返;而
 * 每一份描述都在每一回合花 token。执行期的闸(协作场子门、派工套娃闸)原样保留
 * —— 工具面是给模型看的,闸才是不能被绕过的。
 *
 * 四条规则,四个来源,一处合成:
 * 1. **协作工具**(send_message / board / history / notebook)—— 场子表
 *    `COLLAB_TOOL_VENUES` 是唯一事实,普通对话(`chat`)一个都不给。
 * 2. **goal** —— 只在会话有 `active` 目标的回合出现;协议行也只在 active 时注入
 *    (`goals/render.ts`),没有目标的回合带着它只会引来一次误调。
 * 3. **task** —— 工作会话看不见(禁止套娃),复用 `sessionHiddenToolIds`。
 * 4. **skill 场景工具** —— 一组工具由某个 skill「带进来」:该 skill 在本回合
 *    启用时可见,否则不见。今天只有一格:自进化的 feature_* 三件套挂在
 *    `onething-self-evolution` 上(该 skill 默认关闭,在 设置 → Skills 打开
 *    即进入场景)。
 *
 * 与 `agents/profile.ts` 的 `resolveAgentToolSurface`(agent 白名单 ∪ 地板)是
 * 两层:那层答「这个 agent 能用哪些」,这层答「这个场景里哪些根本不成立」。
 * 两层都是过滤,先摘场景再套白名单,所以地板加回来的工具也过不了场景 ——
 * 地板给房回合的三个工具本来就在房场子里,不冲突。
 */
import {
  COLLAB_TOOL_VENUES,
  resolveCollabVenue,
  type CollabVenueTool,
} from '../collab/tool-surface.js'
import { sessionHiddenToolIds, type TaskSessionLike } from '../tasks/index.js'

export const GOAL_TOOL_ID = 'goal'

/**
 * skill → 它带进来的工具。键是 skill **名字**(SKILL.md frontmatter `name`),
 * 不是带 source 前缀的 id:同一个 skill 从 builtin 根或用户根装进来都该认。
 */
export const SKILL_SCENE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'onething-self-evolution': ['feature_mount', 'feature_unmount', 'feature_inspect'],
}

/** 场景表读的那一小片会话形状(结构类型 —— 产品层不认 IPC 契约包)。 */
export interface SceneSurfaceSessionLike extends TaskSessionLike {
  kind?: string | null
  goal?: { status?: string } | null
}

export interface ResolveSceneHiddenToolIdsInput {
  session?: SceneSurfaceSessionLike | null
  /** 本回合启用的 skill 名字(不是 id)。 */
  enabledSkillNames?: Iterable<string> | null
}

/** 这一回合从工具面上摘掉哪些工具 id。 */
export function resolveSceneHiddenToolIds(input: ResolveSceneHiddenToolIdsInput): string[] {
  const hidden = new Set<string>()
  const session = input.session ?? null

  // 1. 协作工具:按场子表,不在本场子的一律摘掉(chat 场子四个全摘)。
  const venue = resolveCollabVenue(session?.kind)
  for (const [tool, venues] of Object.entries(COLLAB_TOOL_VENUES) as Array<[CollabVenueTool, readonly string[]]>) {
    if (!venues.includes(venue)) hidden.add(tool)
  }

  // 2. goal:只在 active 目标的回合出现。
  if (session?.goal?.status !== 'active') hidden.add(GOAL_TOOL_ID)

  // 3. task:工作会话禁止套娃。
  for (const id of sessionHiddenToolIds(session)) hidden.add(id)

  // 4. skill 场景工具:该 skill 没启用就摘。
  const skillNames = new Set(input.enabledSkillNames ?? [])
  for (const [skillName, tools] of Object.entries(SKILL_SCENE_TOOLS)) {
    if (skillNames.has(skillName)) continue
    for (const id of tools) hidden.add(id)
  }

  return [...hidden]
}
