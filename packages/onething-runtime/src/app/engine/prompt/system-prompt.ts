import {
  type CoreBuildPromptContextOptions,
  type CoreBuildPromptResult,
  type CorePromptRequestMessage,
} from '@onething/core/engine'
import type { AgentProviderData } from '@onething/core/agent-loop'
import type { SkillDefinition, AppSettings } from '@shared/ipc.js'
import type { JsonObject, JsonObjectProperty } from '@shared/json.js'
import {
  buildOnethingPrompt,
  buildOnethingSystemPrompt,
  builtinPromptSource,
  loadAgentsMdInstructions,
  PROMPT_BLOCK_TOOL_GUIDELINES,
  PROMPT_BLOCK_TOOL_WORKSPACE_RULES,
  PromptComposer,
  promptFragments,
  VariableBoardSource,
  type BuildOnethingPromptContextOptions,
  type ComposedPrompt,
} from '@onething/runtime/prompts'
import { toolPromptSource } from '../../tools/registry.js'
import { buildStateVariablesPromptText } from '../../variables/index.js'
import { pluginPromptSource } from './plugin-context.js'
import { getMacOSAutomationDocsPath } from '../../stores/paths.js'
import { getTodoPlanDirectory } from '../../todo-plan/store.js'
import { defaultAgent, findAgent } from '../../agents/index.js'
import * as store from '../../store.js'
import {
  buildCollabRoomSystemPrompt,
  buildCollabWorkContext,
  isAgentPairDmRoom,
  isUserDmRoom,
} from '@onething/runtime/collab'
import { collabRoomMembers } from '../../collab/members.js'
import { collabUserPromptFields } from '../../collab/user-identity.js'
import type { PromptProviderConfig } from './plugin-context.js'
import type { PromptActiveProject, PromptKnownProjects } from './types.js'

export interface BuildPromptContextOptions extends Omit<CoreBuildPromptContextOptions, 'settings' | 'skills' | 'activeProject' | 'knownProjects'> {
  settings?: AppSettings
  skills: SkillDefinition[]
  activeProject?: PromptActiveProject
  knownProjects?: PromptKnownProjects
}

type PromptMessageContent = JsonObjectProperty | object
type PromptToolCall = { toolCallId: string; toolName: string; args: JsonObject }

export type PromptRequestMessage =
  | { role: 'system' | 'developer' | 'user'; content: PromptMessageContent }
  | {
      role: 'assistant'
      content: PromptMessageContent
      reasoningContent?: string
      providerData?: AgentProviderData[]
      toolCalls?: PromptToolCall[]
    }
  | {
      role: 'tool'
      content: Array<{ type: 'tool-result'; toolCallId: string; toolName: string; result: PromptMessageContent }>
    }

export interface BuildPromptOptions extends BuildPromptContextOptions {
  providerId: string
  providerConfig?: PromptProviderConfig
  historyMessages: PromptRequestMessage[]
}

export interface BuildPromptResult extends Omit<CoreBuildPromptResult, 'messages'> {
  messages: PromptRequestMessage[]
}

/**
 * Room turns get a persona-only system prompt (docs/multi-agent-collab.md D3,
 * 评审修订「模拟房间」): the product prompt's assistant identity + tool/memory/
 * workspace sections make the model "an app assistant simulating a chat",
 * not the person itself. baseSystemPrompt becomes the persona + roster, and
 * every product developer section (plugin-contributed rules included — they
 * must not leak into personas) is disabled. Mirrors the probe-validated setup.
 */
function collabRoomOverrides(
  ctx: BuildPromptContextOptions,
): Partial<BuildOnethingPromptContextOptions> | null {
  const sessionId = (ctx as { sessionId?: string }).sessionId
  if (!sessionId) return null
  const session = store.getSession(sessionId)
  if (!session) return null

  /**
   * W18: the turn runs in the agent's execution session, so the room material
   * (persona, roster, room name, taskFacts) comes from the room that session is
   * currently answering — the drive wrote that pointer before emitting. The
   * session being built is NOT where the roster lives any more.
   */
  const roomSessionId = session.kind === 'agent'
    ? session.collab?.roomSessionId
    : session.kind === 'room' ? session.id : undefined
  if (!roomSessionId) return null
  const room = roomSessionId === session.id ? session : store.getSession(roomSessionId)
  if (room?.kind !== 'room' || !room.room) return null

  const selfAgent = session.agentId ? findAgent(session.agentId) : null
  if (!selfAgent) return null
  /**
   * 提示词里的花名册。带 `description`(模型据此判断这件事该找谁),且**退休的
   * 照列**(`includeRetired`)—— 与激活面相反,因为转录里还有它说过的话,花名册
   * 里没有它的话,模型读到那些发言会以为房间里混进了外人。
   *
   * 投影本身走 `collab/members.ts` 的单一点(架构审查 B8)。
   */
  const members = collabRoomMembers(room.room.memberAgentIds, {
    withDescription: true,
    includeRetired: true,
  })
  if (members.length === 0) return null

  return {
    baseSystemPrompt: buildCollabRoomSystemPrompt({
      self: {
        id: selfAgent.id,
        name: selfAgent.name,
        title: selfAgent.title,
        description: selfAgent.description,
        avatar: selfAgent.avatar,
        avatarImage: selfAgent.avatarImage,
      },
      members,
      roomName: room.name,
      // agent-dm-user.md §2.3:用户不再是匿名的「用户」——花名册里 TA 和同事
      // 同一书写法(`一天#yitian(用户)`),情况说明里的称呼也是 TA 的名字。
      ...collabUserPromptFields(),
      personaPrompt: selfAgent.systemPrompt || `你是${selfAgent.name}。`,
      // collab-team-v2 §8: the shared rules ride along on a real turn only —
      // the willingness judgement calls the same builder and needs none of it.
      includeCommonRules: true,
      // 花名册回到 system prompt(collab-turn-protocol-and-identity.md B)。
      // 它曾被搬进 `<ChatRoom><Members>`,而 v3 V2 删掉了那块载荷 —— 名单从此
      // 指向一段不存在的文本,模型于是把用户与花名册上的名字数成两个人。
      // members 与用户行(`一天#yitian(用户)`)都在手边,零新数据搬运。
      rosterInSystemPrompt: true,
      // 真回合的消息以 `<message from>` 信封到达,未读裹在 `<Notification>` 里 ——
      // 视野说明因此常开。它与花名册在哪是两个正交的事实,别再合成一个开关。
      driveEnvelope: true,
      // agent-im-dm.md §2.3:单成员 dm 房换成私聊那一版情况说明(群房零改动)。
      // 判定读的是**房**的配置,与工具面那条推导同源(app/agents/profile.ts)。
      dm: isUserDmRoom(room.room),
      // §3.1/D4:双成员 dm 房再换一版 —— 群版会把用户说成"群成员",而这间房里
      // 用户是**旁观者**。透明制要进 agent 的认知,不然它会以为这是暗通道。
      dmPair: isAgentPairDmRoom(room.room),
    }),
    // 禁用整批产品段的理由是「插件贡献的规则不得渗入 persona」——
    // 防的是**产品说明文案**污染 persona。而 `<context-variables>` 不是产品说明,
    // 它是通往运行时状态板的那句指路,正是群聊里最该有的东西
    // (agent-self-state-variables.md §5):此前群房里模型看不到任何变量的值,
    // 却握着 `variable` 工具,而那个工具当时唯一的读法是全量 list —— 既没有被动
    // 可见性,主动读的代价又最高。`context-update-convention` 一并解禁:否则状态
    // 块进来了,却没有任何文案告诉模型那是什么。
    disabledSections: [
      'agent', // persona already IS the system prompt — no duplicate section
      // 工具自带的守则条目(edit/write 的 `Tool Guidelines:`)是产品说明,不进 persona。
      // 工具自带的**段落**不在此列 —— `context-variables` 正是靠这一点留下来的。
      PROMPT_BLOCK_TOOL_GUIDELINES,
      // 工作目录守则跟着守则走(它此前是 `# Work Directory` 段的尾巴,靠禁用
      // `workdir` 一并消失;那一段搬去回合通道后,块要自己点名才禁得掉)。
      PROMPT_BLOCK_TOOL_WORKSPACE_RULES,
      'voice',
      'runtime-context',
      'active-project',
      'known-projects',
      'skills',
      'os',
      'todo',
      'agents-md',
      'plugins',
    ],
  }
}

/**
 * 工作台会话(kind='work')的那一支(架构收敛 C3-5,审计 A3 后半)。
 *
 * **与房版是两种改法,不能合并。** 房间回合把整个 system prompt 换成 persona +
 * 情况说明(D3「模拟房间」:产品段会让模型变成"一个在模拟聊天的助理"),而工作
 * 会话恰恰需要那整份产品提示词 —— 它在真的读文件、跑命令、写产出。所以这里
 * 只**追加**一段工作身份,一个产品段都不禁。
 *
 * 追加的位置是 persona 段(`agentSystemPrompt`)。它是全篇唯一一处"这一轮的你是
 * 谁",而工作身份正是这个语境里那句话的后半段:你是这位同事,你在为这张卡干活。
 *
 * 取材全部来自**会话 meta**(`collab.roomSessionId` / `taskId` / `taskTitle`),
 * 不读看板:这一段每一轮都要重建,而看板是一次磁盘读;更要紧的是 meta 的三个
 * 字段就是 `spawnWork` 钉进去的那份快照,压缩摘要化碰不到它 —— 这正是把身份从
 * briefing 搬出来的全部理由。
 */
function collabWorkOverrides(
  ctx: BuildPromptContextOptions,
): Partial<BuildOnethingPromptContextOptions> | null {
  const sessionId = (ctx as { sessionId?: string }).sessionId
  if (!sessionId) return null
  const session = store.getSession(sessionId)
  if (session?.kind !== 'work') return null
  const roomSessionId = session.collab?.roomSessionId
  if (!roomSessionId) return null
  // 房没了(被删)也照给身份:卡框架与「产出经 board 回报」都还成立,而一个
  // 半身份比没有身份好 —— 房名退回一个中性词,不编一个不存在的房。
  const roomName = store.getSession(roomSessionId)?.name?.trim() || '群聊'

  // persona 与 builder 的取法逐字一致(prompts/builder.ts coreOptions):调用方
  // 显式给的优先,否则查 agent。查不到就只剩工作身份 —— 那也比落回"通用助理"好。
  const persona = (
    ctx.agentSystemPrompt
    ?? findAgent(ctx.agentId ?? session.agentId)?.systemPrompt
    ?? ''
  ).trim()

  const work = buildCollabWorkContext({
    roomName,
    ...(session.collab?.taskId ? { taskId: session.collab.taskId } : {}),
    ...(session.collab?.taskTitle ? { taskTitle: session.collab.taskTitle } : {}),
  })

  return { agentSystemPrompt: [persona, work].filter(Boolean).join('\n\n') }
}

/**
 * The desktop composer — the sources, in tie-break order:
 *
 * 1. `builtinPromptSource` — the product's own section table;
 * 2. `toolPromptSource` — what the tools **on this turn's surface** declared
 *    (`ToolInfo.prompt`), read off the app tool registry per build; a tool
 *    that is registered but off the surface does not talk;
 * 3. `promptFragments` — what runtime features / hosts registered, with
 *    disposers (they gate themselves with `requiresTools` when they need to);
 * 4. `variableBoardSource` — the session's context-variable board, one `turn`
 *    block. It used to be a private hook inside the stream engine; as a source
 *    it goes through the same filter/order/dedupe path as everything else;
 * 5. `pluginPromptSource` — plugin providers, with the desktop's breaker
 *    callbacks (before this object existed the build path called the bare
 *    runtime collector and the promptContext breaker lane was never fed).
 */
const variableBoardSource = new VariableBoardSource({
  render: (sessionId: string) => buildStateVariablesPromptText(sessionId),
})

export const desktopPromptComposer: PromptComposer = new PromptComposer([
  builtinPromptSource,
  toolPromptSource,
  promptFragments,
  variableBoardSource,
  pluginPromptSource,
])

function coreOptions(ctx: BuildPromptContextOptions): BuildOnethingPromptContextOptions {
  return {
    ...ctx,
    host: {
      // persona 功能兜底(域模型 §3.3):无 agentId / 查无此人 → default persona。
      getAgent: (agentId: string | undefined) => findAgent(agentId) ?? defaultAgent(),
      getMacOSAutomationDocsPath,
      getTodoPlanDirectory,
    },
    // 两支互斥(一条会话只有一个 kind),顺序因此不构成优先级 —— 房版返回 null
    // 的那些会话里,只有 kind='work' 会被下一支接住。
    ...(collabRoomOverrides(ctx) ?? {}),
    ...(collabWorkOverrides(ctx) ?? {}),
  }
}

export async function buildSystemPrompt(
  ctx: BuildPromptContextOptions,
): Promise<ComposedPrompt> {
  return buildOnethingSystemPrompt(coreOptions(ctx), desktopPromptComposer)
}

export async function buildPrompt(options: BuildPromptOptions): Promise<BuildPromptResult> {
  return buildOnethingPrompt({
    ...coreOptions(options),
    providerId: options.providerId,
    historyMessages: options.historyMessages as CorePromptRequestMessage[],
  }, desktopPromptComposer) as Promise<BuildPromptResult>
}

export {
  loadAgentsMdInstructions,
}
