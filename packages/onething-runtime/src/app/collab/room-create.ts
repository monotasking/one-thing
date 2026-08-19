/**
 * 建群房的唯一入口(架构收敛 2026-08 C3 §4)。
 *
 * 在这个文件出现之前,「建一间群房」的规则书有两本:Electron 的 CREATE_SESSION
 * handler 里内联一套(成员过滤、agentExists、PM 在册、budgets 归一),CLI daemon
 * 的 `collabRoomNew` 里另抄一套。两本都不是完整的那一本 —— **创建**路径从来不检查
 * 退休,而**更新**路径(`setCollabRoomConfig`)从第一天起就拒绝把退休的人拉进房。
 * 于是同一个问题("能不能把已退休的小李拉进一间房")在两条路上有两个答案:新建时
 * 可以,建完再加就不行。规则书分家的代价永远是这个形状。
 *
 * 这里把两本合成一本,以**更新路径**为准(更严的那本):校验、错误文案、退休纪律
 * 全部与 `setCollabRoomConfig` 逐字一致。壳层(IPC handler / daemon 方法)从此只
 * 负责把线上的形状递进来,一条业务规则都不留。
 *
 * ## 落库的原子性
 *
 * 一间房是两次写:`createSession`(会话本体)+ `updateSessionCollab`(kind/room)。
 * 更好的形态是给 store 一个「一步带 kind/room 建会话」的能力,但那要改到
 * `session-repository` 与 core 的 `createSessionWithAdapters`(两处都在本期作用域
 * 之外),所以这里退到第二方案:**检查第二次写的返回值,失败就把半成品会话删掉再
 * 报错**。半成品尤其毒 —— 一条 `kind` 缺失的会话在会话列表里就是一条普通聊天,
 * 用户点进去看到的是一间"没有成员的群",而没人知道它是怎么来的。
 */
import { isActiveAgent, type ChatSession } from '@shared/ipc.js'
import * as store from '../store.js'
import { findAgent } from '../agents/index.js'
import { emitCollabRoomUpdated } from './room-runtime.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('collab.room')


/** 房间配置的落库形状。`RoomConfig` 没进 `@shared/ipc` 的桶,从会话类型上取更稳。 */
type RoomConfig = NonNullable<ChatSession['room']>

/**
 * 线上递过来的房间配置 —— 全部按 `unknown` 收,因为这些值来自渲染进程/CLI,
 * 「调用方已经校验过了」这句话在这一层不成立。
 */
export interface CollabGroupRoomInput {
  memberAgentIds?: unknown
  pmAgentId?: unknown
  budgets?: unknown
  /** 私聊标记(agent-im-dm.md D1/D3)。人数即形态,这里只认字面 true。 */
  dm?: unknown
}

export interface EnsureCollabGroupRoomOptions {
  /**
   * 会话 id。渲染层的 draft id **就是**未来的会话 id(草稿期到落库期身份不变),
   * 所以那条路会把自己的 id 递进来;缺省时由调用方给一个新 UUID。
   */
  sessionId: string
}

export interface EnsureCollabGroupRoomResult {
  success: boolean
  error?: string
  session?: ChatSession
}

/** budgets 的归一规则与 `setCollabRoomBudgets` 同款:非有限数/负数一律忽略,整数闸取整。 */
function normalizeBudgets(raw: unknown): RoomConfig['budgets'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const source = raw as Record<string, unknown>
  const budgets: NonNullable<RoomConfig['budgets']> = {}
  const dailyCostUSD = source.dailyCostUSD
  if (typeof dailyCostUSD === 'number' && Number.isFinite(dailyCostUSD) && dailyCostUSD >= 0) {
    budgets.dailyCostUSD = dailyCostUSD
  }
  // 整数闸:0 = 关闭该闸,与设置面板那条路一字不差。
  for (const key of ['maxChain', 'maxConcurrentWork', 'maxTurnToolCalls', 'maxTurnSayCalls', 'maxConcurrentTurns'] as const) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      budgets[key] = Math.floor(value)
    }
  }
  return Object.keys(budgets).length > 0 ? budgets : undefined
}

/**
 * 校验并建出一间群房(或 UUID id 的 dm 房)。
 *
 * 校验次序与文案刻意与 `setCollabRoomConfig` 对齐 —— 「同一个问题在创建与更新两条
 * 路上必须得到同一个答案」是这个函数存在的理由,测试也是按这条钉的。
 */
export function ensureCollabGroupRoom(
  name: string,
  roomConfig: CollabGroupRoomInput | undefined,
  options: EnsureCollabGroupRoomOptions,
): EnsureCollabGroupRoomResult {
  const requested = Array.isArray(roomConfig?.memberAgentIds) ? roomConfig.memberAgentIds : []
  const memberAgentIds = [
    ...new Set(requested.filter((id): id is string => typeof id === 'string' && id.length > 0)),
  ]
  if (memberAgentIds.length === 0) {
    return { success: false, error: 'Room needs at least one member agent' }
  }
  for (const agentId of memberAgentIds) {
    const agent = findAgent(agentId)
    if (!agent) return { success: false, error: `Unknown agent: ${agentId}` }
    // 退休的人不能被拉进房(域模型 §3.2)。更新路径为"已在册的原样通过"开了个口子,
    // 那是为了不让一间旧房因为某个成员退休而整体改不动;**新建**没有"已在册"这回事,
    // 所以这里是无条件的。
    if (!isActiveAgent(agent)) {
      return { success: false, error: `Agent is retired: ${agent.name}` }
    }
  }

  const pmAgentId = typeof roomConfig?.pmAgentId === 'string' && roomConfig.pmAgentId
    ? roomConfig.pmAgentId
    : undefined
  if (pmAgentId && !memberAgentIds.includes(pmAgentId)) {
    return { success: false, error: 'PM must be a room member' }
  }

  const budgets = normalizeBudgets(roomConfig?.budgets)
  const room: RoomConfig = {
    memberAgentIds,
    ...(pmAgentId ? { pmAgentId } : {}),
    ...(budgets ? { budgets } : {}),
    // 只认字面 true(白名单式透传:这个字段会改变房间的激活语义,「随便什么真值
    // 都算」不是这里该有的宽容)。用户 ↔ agent 的托管私聊走 ensureUserDmRoom
    // (id 是派生的、不是 UUID),这条路径留给 UUID id 的 dm 房与手工建房。
    ...(roomConfig?.dm === true ? { dm: true as const } : {}),
  }

  let session: ChatSession
  try {
    // 幕后落库,不动用户正在看的标签页:界面上"新建群"之后的切换由渲染层显式
    // 发起(workspace.openSession),从来不是靠这次写入的副作用。
    session = store.createSessionWithoutFocus(options.sessionId, name)
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }

  if (!store.updateSessionCollab(session.id, { kind: 'room', room })) {
    // 半成品回滚:见文件头「落库的原子性」。删不掉也照样报错 —— 报一条假的成功
    // 比留一条孤儿会话更贵。
    try {
      store.deleteSession(session.id)
    } catch (error) {
      log.error('room create rollback failed', { sessionId: session.id }, error)
    }
    return { success: false, error: 'Failed to write room config' }
  }

  // 房间配置已经落库 —— 播一份全量小快照(架构收敛 C4 §3)。
  //
  // 建房这条路上它是**补充**而不是替代:一间刚出生的房还不在渲染层的会话表里,
  // 而这条事件是"就地合并某个已知会话",合并不出一行新的。调用方(建房对话框、
  // 联系人开私聊)照旧要把新会话拿进列表才打得开。
  emitCollabRoomUpdated(session.id)
  return { success: true, session: store.getSession(session.id) ?? session }
}
