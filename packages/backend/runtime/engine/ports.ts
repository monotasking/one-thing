/**
 * 产品层引擎对**后端**的全部需要,一张表(P3'e-A2a)。
 *
 * `ProductStreamEngine` 的产品语义(历史重建、provider 解析、压缩、标题……)已经
 * 走 `CoreStreamEngineRuntime` 的 12 槽;剩下的是四件**装配层**能力 —— 渠道路由、
 * 群聊房间入口闸、插件旁路回投、agent 绑定 —— 加上外部会话的就地追话。它们各自
 * 是一个可选端口。
 *
 * **每个端口都是 optional,缺席 = 那条能力不存在**(不路由 / 不拒房间 / 不回投 /
 * 不套 agent 绑定 / 追话照旧入队),而不是"换个默认实现"。这条纪律是整个归位能
 * 逐字保行为的原因:桌面装配层把五个端口全填上,行为与归位前一模一样;
 * 一个只想要引擎的宿主一个都不填,拿到的就是 core 引擎加产品语义。
 *
 * 端口里**不出现 shared 的跨进程类型**:`MessageOrigin` 之流是 IPC 契约,产品层
 * 读不到。这里只声明引擎真正读写的那几格(`EngineMessageOrigin`),shared 的
 * `MessageOrigin` 结构上可赋给它 —— 装配层把真身传进来,类型自然对上。
 */

/** shared `OriginTransport` 的镜像。四个字面量,加一个就两边都要加。 */
export type EngineOriginTransport = 'desktop' | 'voice' | 'api' | 'im'

/**
 * 引擎**真正读写**的 origin 子集。
 *
 * 刻意不是 `MessageOrigin` 的别名:那是 shared 的跨进程 IPC 契约,产品层禁 import。
 * 每一格都是引擎自己用到的(`transport` 决定 channel 名、`resolvedIdentity.userId`
 * 决定 principal、`inputTransformed` 是 N2 的归因戳),多一格就是多一条没人读的耦合。
 */
export interface EngineMessageOrigin {
  transport: string
  source: string
  receivedAt: number
  conversation?: { connector?: string; workspaceId?: string }
  replyTarget?: { connector?: string; workspaceId?: string }
  resolvedIdentity?: { userId?: string }
  /** 发送前被插件改写(N2)。缺席 = 这就是用户逐字打出来的。 */
  inputTransformed?: { by: string[] }
}

export interface EngineRoutedSession {
  sessionId: string
  origin: EngineMessageOrigin
}

/**
 * 渠道会话路由:把一条带渠道身份的消息解析到「它真正属于的那条会话」。
 *
 * 缺席 = **不路由**:会话 id 原样、origin 用命令自带的那份(没有就按 fallback
 * transport 现造一个)。系统内部驱动本来就走旁路,所以缺席这条端口的宿主拿到的
 * 是「所有消息都像系统内部驱动那样直达」——正是"无此能力"该有的样子。
 */
export interface StreamEngineSessionRouterPort {
  route(input: {
    sessionId: string
    origin?: EngineMessageOrigin
    fallbackTransport?: EngineOriginTransport
    preserveSessionId?: boolean
  }): EngineRoutedSession
}

/**
 * 群聊房间入口闸(docs/multi-agent-collab.md D2)。
 *
 * 缺席 = 这个宿主没有房间:没有房间会话、没有协调器驱动的会话、房间投递永远
 * "没接管"。三个判定各自独立,因为引擎在三个不同位置问三个不同的问题。
 */
export interface StreamEngineRoomIngressPort {
  /** 这条会话是群聊房间吗(编辑/重试在房里没有定义)。 */
  isRoomSession(sessionId: string): boolean
  /** 这条会话由协调器驱动吗(只有它自己的驱动可以流式驱动房间)。 */
  isCoordinatorDrivenSession(sessionId: string): boolean
  /**
   * 房间入口闸接管了这条用户消息吗。`true` = 已经落库、不要起流。
   * 命令原样透传(`mentions` / `collabDriveToken` 都在里面),这一面自己解析。
   */
  handleRoomSendMessage(sessionId: string, command: unknown): Promise<boolean>
}

/**
 * 插件输入旁路的**回投**半边(N2 `handled` 分支)。改写那半边是纯产品逻辑
 * (`plugins/input-intercept-bound.ts`),不走端口。
 *
 * 缺席 = 插件可以接管消息,但接管后说不出话(消息照样落库、照样零 token)。
 */
export interface StreamEnginePluginInterceptPort {
  postReply(pluginId: string, sessionId: string, content: string): void
}

/** agent 绑到这一回合的模型(A1.4)。 */
export interface EngineAgentModelBinding {
  providerId?: string
  modelId?: string
  thinking?: string
}

/**
 * agent 绑定。两问各自独立:模型绑定按**会话**解析(要看会话有没有手钉),
 * 权限声明按 **agentId** 解析(每次 `Permission.ask` 现读,不吃回合快照)。
 *
 * 缺席 = 没有 agent 这回事:命令的 provider/model 不被填空(留给会话自己的解析
 * 链),权限模式就是 session/settings 那条链的结果(`composeAgentPermissionMode`
 * 传 `undefined` 时 agent 不参与,与"agent 什么都没声明"逐字同义)。
 */
export interface StreamEngineAgentBindingPort {
  resolveModelForSession(sessionId: string): EngineAgentModelBinding | undefined
  /**
   * 这条会话的 agent 声明了什么权限模式。返回 `{ agentId, permissionMode }`,
   * 两者都可缺 —— 与 `composeAgentPermissionMode(agentMode, base, undefined, { agentId })`
   * 的两个入参一一对应。
   */
  resolvePermissionDeclaration(
    agentId: string | undefined,
  ): { agentId?: string; permissionMode?: string } | undefined
}

/**
 * 中途追话的**就地投递**。返回 `true` = 已经送进去了,不要入队。
 *
 * 缺席 = core 的默认:一律入队(原生会话与空闲的外部会话本来就是这个行为)。
 */
export interface StreamEngineSteeringDeliveryPort {
  take(sessionId: string, content: string): boolean
}

export interface ProductStreamEnginePorts {
  assertAccepting?: (sessionId?: string) => void
  prepareSession?: (sessionId: string) => Promise<void>
  authorizeExecution?: (sessionId: string, executionContext: unknown) => void
  router?: StreamEngineSessionRouterPort
  roomIngress?: StreamEngineRoomIngressPort
  pluginIntercept?: StreamEnginePluginInterceptPort
  agentBinding?: StreamEngineAgentBindingPort
  steeringDelivery?: StreamEngineSteeringDeliveryPort
}
