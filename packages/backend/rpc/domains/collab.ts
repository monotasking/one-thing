/**
 * collab(多 agent 协作房)域 —— 结构债 P4a 的第三个域(前两个是 spaces、practice)。
 *
 * 替换主进程里那十五条裸 handle(`apps/electron/src/main/ipc/collab.ts` 因此
 * **整只删掉** —— 与 spaces / practice 不同,这个域一条推送都没有,所以手写 IPC
 * 那一侧什么也不剩);渲染侧的十五个 `platformApi.xxxCollabXxx` 方法与
 * `packages/renderer/platform/web.ts` 里那批 `unsupported()` 名单条目一起删掉。
 * **server 侧零改动**:域挂上 router 之后就经 `POST /api/rpc` 自动可达。
 *
 * 这里只做一件事:**把请求原样递给 `@onething/backend/wiring/collab` 的服务函数**。判定
 * 全在那边 —— 看板动作合不合法是纯 reducer 的事、`expectedEpoch` 那道乐观并发
 * 前置是 v3 房账的事、表情在不在调色板里是 reactions 的事、私聊房开不开得成是
 * user-dm-room 的事。传输面不许自己加分支;逐条对着旧文件抄的正是这几处形状:
 *  - **整体透传**:请求减去它的**地址**(roomSessionId)就是 patch,所以
 *    `roomUpdate` / `roomSetBudgets` 只做一次解构,一个字段名都不出现。逐字段
 *    手抄的那一版活生生丢过一个字段(budgets 的 `maxConcurrentTurns` 抄漏了几个月
 *    且不报错),测试里那两条 keyof 穷尽就是为它立的。
 *  - **可操作的失败不翻译成 `error`**:`roomRevokeLease` 的 `epoch-stale` /
 *    `not-found` / `not-a-room` 是**结果**不是异常,原样回给界面。
 *  - `boardAct` 缺 `action` 时当场拒绝,不惊动 app 层(旧行为逐字保留)。
 *  - `roomClearHistory` 把 `includeMemberDms` 归一化成布尔 —— 不让 undefined 过河。
 *  - `schedulerLogTail` 的 `limit` / `types` 缺席就是缺席,缺省交给读账函数自己。
 *
 * **actor 钉死在这里,和从前一模一样**:`messageReact` 刻意**忽略** wire 上的
 * `actor` 字段,一律按 `{ type: 'user' }` 记账。表情回应携带的是**归属**(房间
 * 把一位沉默成员的 emoji 读作它的回答,§3.5 B),所以渲染层若能指定 actor,就能把
 * 一句话安在别人名下。router 的 dispatch context 里没有「我是谁」这一格,因此这颗
 * 钉子必须继续由处理者自己钉 —— 请求上那个字段是**被无视**而不是被校验。
 * (`boardAct` 同理:它的入参里根本没有 actor 的位置,人的身份由 app 层的
 * `applyUserCollabBoardAction` 这个函数名本身钉住。)
 *
 * 不在这条路上的:看板 / 协调器 / agent 的实时更新与表情写完之后的回灌,走的是
 * `collab:*-changed` 与 `message:updated` 会话事件 —— 推送面,而 router 今天只有
 * 请求/响应面。
 */
import type { RouteHandlers } from '@onething/core/ipc'
import {
  collabRouter,
  type CollabRoutes,
  type CollabSchedulerLogEntry,
} from '@shared/ipc/collab.js'
import { loadCollabBoard } from '../../wiring/collab/board-store.js'
import {
  applyUserCollabBoardAction,
  clearCollabRoomHistory,
  ensureUserDmRoom,
  getCollabAgentActivity,
  getCollabCoordinatorState,
  getCollabRoomSpend,
  listCollabRoomFolder,
  reactToCollabMessage,
  readCollabSchedulerLogTail,
  revokeCollabRoomLease,
  setCollabRoomBudgets,
  setCollabRoomConfig,
  setCollabRoomFrozen,
  stopCollabTaskWork,
  type CollabSchedulerLogTailOptions,
} from '../../wiring/collab/index.js'
import { registerRouterHandlers } from '../registry.js'

/** 时间轴过滤的类型表属主在纯层;这里只是把 wire 上那串裸字符串接回去。 */
type CollabSchedulerLogTailTypes = NonNullable<CollabSchedulerLogTailOptions['types']>

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const collabRpcHandlers: RouteHandlers<CollabRoutes> = {
  async boardGet(request) {
    try {
      return { success: true, board: loadCollabBoard(request.roomSessionId) }
    } catch (error) {
      return { success: false, error: message(error) }
    }
  },

  // 看板写入。动作**原样过河** —— 什么合法(状态机、rev 前置、「只有承办人能
  // 完成它」)是纯 reducer 的裁量,在这里复述一遍就是第二本会漂的规则。
  async boardAct(request) {
    try {
      if (!request?.action) return { success: false, error: 'Missing board action' }
      return await applyUserCollabBoardAction(request.roomSessionId, request.action)
    } catch (error) {
      return { success: false, error: message(error) }
    }
  },

  // 卡级停止(collab-team-v2 §5.1 入口②)。刻意不是一个 board action:动作表
  // 描述的是卡在状态机里怎么走,而「停掉正在跑的那条流」是运行时的事,让模型
  // 也能调它等于给了它一个停别人活的开关。
  async taskStop(request) {
    try {
      const stopped = await stopCollabTaskWork(request.roomSessionId, request.taskId)
      return { success: true, stopped }
    } catch (error) {
      return { success: false, error: message(error) }
    }
  },

  /**
   * 人级停止(E5)。三级停止里唯一此前不可达的一级 —— 房级换代把在外的牌一起
   * 作废,卡级停一只手,而「停下 TA」在这条通道之前只能拿房级喊停冒充。
   *
   * **整体透传**:请求原样递下去,一个字段名都不在中转里出现。`expectedEpoch`
   * 那道乐观并发的前置条件属于 app 层 —— 在这儿抢先判一次,就是第二本会漂的规则。
   *
   * 失败原因不翻译成 `error`:`epoch-stale` / `not-found` / `not-a-room` 三条都是
   * **可操作的**结果,不是异常。真异常(运行时炸了)才走下面那条。
   */
  async roomRevokeLease(request) {
    try {
      return { success: true, result: await revokeCollabRoomLease(request) }
    } catch (error) {
      return { success: false, error: message(error) }
    }
  },

  // 协调器状态条的冷启动读取。纯读 —— 快照是从运行时现算的,不碰磁盘。
  async coordinatorGet(request) {
    try {
      const state = getCollabCoordinatorState(request.roomSessionId)
      return state ? { success: true, state } : { success: false, error: 'Not a room session' }
    } catch (error) {
      return { success: false, error: message(error) }
    }
  },

  /**
   * Agent 活动快照的冷启动补水(D8 §3.1)。纯读 —— 九格全部从运行时现算,不碰磁盘。
   *
   * 整体透传:`agentIds` 缺席就是缺席,处理者不替调用方决定「缺席等于全要」还是
   * 「缺席等于零个」—— 那条语义在 app 层(`getCollabAgentActivity`)。
   */
  async agentActivityGet(request) {
    try {
      return { success: true, activities: getCollabAgentActivity(request?.agentIds) }
    } catch (error) {
      return { success: false, error: message(error) }
    }
  },

  /**
   * 调度时间轴的尾读(D8 §3.3)。纯读 —— 读的是账文件,不经运行时。
   *
   * `types` 原样递下去:哪几类行合法是纯层那张 14 类表的事,这里再抄一份就是第二本
   * 会漂的枚举。递一个不存在的类型的后果是「过滤出空」,不是错误 —— 而那正是想要
   * 的失败模式。
   */
  async schedulerLogTail(request) {
    try {
      if (!request?.roomSessionId) return { success: false, error: 'Missing roomSessionId' }
      const rows = readCollabSchedulerLogTail(request.roomSessionId, {
        ...(typeof request.limit === 'number' ? { limit: request.limit } : {}),
        ...(request.types?.length ? { types: request.types as CollabSchedulerLogTailTypes } : {}),
      })
      // 契约层的行是**松投影**(`{ at, type } & Record<string, unknown>`):判别
      // 联合的属主在纯层,契约只钉住每一行都有的两格。判别成员没有索引签名,所以
      // 这一步得显式说一句"按松投影读" —— 旧的手写通道没有返回类型,这句话是
      // 信封化之后才浮出来的,不是新增的宽松。
      return { success: true, rows: rows as unknown as CollabSchedulerLogEntry[] }
    } catch (error) {
      return { success: false, error: message(error) }
    }
  },

  async roomSetFrozen(request) {
    const success = setCollabRoomFrozen(request.roomSessionId, request.frozen)
    return success ? { success } : { success, error: 'Not a room session' }
  },

  // 整体透传:请求减去它的**地址**就是 patch,所以这里只做一次解构,一个字段名
  // 都不出现。逐字段手抄的那一版活生生丢过一个字段(`maxConcurrentTurns`),而且
  // 不报错 —— 于是「同时发言上限」从桌面端根本写不进去。
  async roomSetBudgets(request) {
    try {
      const { roomSessionId, ...patch } = request ?? ({} as CollabRoutes['roomSetBudgets']['input'])
      const success = setCollabRoomBudgets(roomSessionId, patch)
      return success ? { success } : { success, error: 'Not a room session' }
    } catch (error) {
      return { success: false, error: message(error) }
    }
  },

  // 房间已花预算(W13.5):只读,设置面板打开时一次。刻意是**自己的一个方法**而
  // 不是 `boardGet` 上的一格 —— 看板补水是热路径,不该每次都付一遍账本扫描。
  async roomSpendGet(request) {
    return getCollabRoomSpend(request.roomSessionId)
  },

  // 群设置(W6):改名 / 名册 / PM / 权限档。校验与那条入群公告都在 app 层 ——
  // 这里只把 patch 带过去,好让 CLI/daemon 接同一个函数时行为逐字一致。
  //
  // 同样是整体透传。逐字段的那一版还额外维护了一条「undefined 不要过河」的规矩,
  // 而 app 层的每一处判据本来就是 `patch.x !== undefined` —— 那条规矩什么也没保护,
  // 只是让每加一个字段就得记着回来补一行。
  async roomUpdate(request) {
    try {
      const { roomSessionId, ...patch } = request ?? ({} as CollabRoutes['roomUpdate']['input'])
      return setCollabRoomConfig(roomSessionId, patch)
    } catch (error) {
      return { success: false, error: message(error) }
    }
  },

  // 清空聊天记录。次序(先停后删再播)与「到底清哪几处」全在 app 层 —— 这里只把
  // 房间 id 带过去,并把 `includeMemberDms` 归一化成布尔(不让 undefined 过河)。
  async roomClearHistory(request) {
    try {
      return await clearCollabRoomHistory(request?.roomSessionId, {
        includeMemberDms: request?.includeMemberDms === true,
      })
    } catch (error) {
      return { success: false, error: message(error) }
    }
  },

  // 托管私聊房的 get-or-create(agent-im-dm.md D1)。校验(同事、在职、查得到)
  // 全在 app 层;这里只把「开不了房」翻译成一句用户读得懂的失败。
  async dmRoomEnsure(request) {
    try {
      const roomSessionId = ensureUserDmRoom(request?.agentId)
      return roomSessionId
        ? { success: true, roomSessionId }
        : { success: false, error: '这个 agent 不能开私聊(已退休、不是同事,或者查无此人)' }
    } catch (error) {
      return { success: false, error: message(error) }
    }
  },

  // 群 folder 的只读列目录(agent-im-chat-ui.md §3.2)。folder 的位置只有 app 层
  // 算得出(workingDirectory ?? <store>/rooms/<id>),所以这是个按房间 id 问的
  // 方法,而不是让渲染进程拿 file:list-directory 去猜路径。只读:没有建/删/写。
  async roomFolderList(request) {
    try {
      const listing = listCollabRoomFolder(request?.roomSessionId)
      return { success: true, ...listing }
    } catch (error) {
      return { success: false, error: message(error) }
    }
  },

  /**
   * 表情回应(W8):toggle 语义,调色板校验在 app 层。写完之后那条消息以
   * `message:updated` 播出去,所以这个回复只为调用方自己的错误处理而存在 ——
   * 界面是跟着事件更新的。
   *
   * **actor 钉死在这里**,理由与 `boardAct` 把人钉成用户是同一条:渲染层永远
   * 不该能以某位 agent 的身份行动。表情携带的是归属,房间会把一位沉默成员的
   * emoji 读作它的回答(§3.5 B),所以从 wire 上取 actor 就等于让界面把一个表态
   * 安在别人名下。请求上那个字段是**被刻意无视**的,不是被校验的。
   */
  async messageReact(request) {
    try {
      return reactToCollabMessage(
        request.roomSessionId,
        request.messageId,
        request.emoji,
        { type: 'user' },
      )
    } catch (error) {
      return { success: false, error: message(error) }
    }
  },
}

export function registerCollabRpcDomain(): () => void {
  return registerRouterHandlers(collabRouter, collabRpcHandlers)
}
