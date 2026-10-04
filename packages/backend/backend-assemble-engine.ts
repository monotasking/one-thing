/**
 * 装引擎:`backend.ts` 里「建引擎」那一步的全部拆件,住在包根(D21「包根 = 几只组装文件」)。
 *
 * 三件事,各一个函数:
 *  - `createStreamEngineLayer()` 造引擎与它的 runtime,把这一层留下的尾巴(出站派发器的 start、
 *    频道提示词供给的注册)收进返回的 `dispose`;
 *  - `createBoundStreamEngine()` 把 `ProductStreamEnginePorts` 的端口接到后端各功能上
 *    (渠道路由、群聊房间入口、插件回投、agent 绑定、外部会话追话、协作驱动验票),然后
 *    `new ProductStreamEngine(runtime, ports)` —— 判断逻辑一行都不住在这里;
 *  - `registerBuiltinTriggers()` 往内核那张触发器表里登记内置的三只。
 *
 * 2026-10 engine 归位(决策 D27)之前,这三件是 `engine/` 里的 `engine-layer.ts`、
 * `stream-engine-bound.ts`、`triggers/index.ts`;引擎本体从此不再引用这只文件。
 * 读当前引擎请用 `current.ts` 的 `getStreamEngine()` / `getStreamEngineSafe()`(只读槽)。
 */

import type { StreamChunk } from '@shared/events/index.js'
import type { MessageOrigin } from '@shared/ipc.js'
import {
	createMainStreamEngineRuntime,
	createTurnEvaluationTrigger,
	ProductStreamEngine,
	type BindableStreamSender,
	type MainStreamEngineRuntime,
	type StreamEngine,
	type StreamSender,
	type StreamSenderPayload,
} from '@onething/backend/engine'
import {
	triggerManager,
	type CoreStreamEngineRuntime as CoreRuntime,
	type EngineMessageOrigin,
	type EngineRoutedSession,
	type ProductStreamEnginePorts,
	type StreamEngineAgentBindingPort,
	type StreamEngineCollabDrivePort,
	type StreamEnginePluginInterceptPort,
	type StreamEngineRoomIngressPort,
	type StreamEngineSessionRouterPort,
	type StreamEngineSteeringDeliveryPort,
	type Trigger,
} from '@onething/backend/agent-loop'
import {
  createOnethingRuntimeFromStreamRuntime,
  type OnethingRuntime,
} from './gateway/gateway-onething-runtime.js'
import type { CoreConversationRuntime } from '@onething/backend/gateway/gateway-conversation-runtime'
import type { EventBus } from '@onething/backend/event/event-session-bus'
import type { StreamChannel } from '@onething/backend/event/event-session-stream-channel'
import {
	DEFAULT_SESSION_OWNER,
	ensureSessionWritable,
	getSessionManager,
	sessionAccess,
} from '@onething/backend/session'
import { fixedExecutionContext } from './session/session.js'
import * as store from '@onething/backend/session'
// 渠道的会话路由、出站回复与给模型的渠道上下文住 gateway(包根归位 B,2026-10-04 从包根 `channel/` 搬来)。
// 这里直取那三只文件,不走 gateway 的 `index.ts`:那只入口同时是独立网关进程的启动文件(被当成主模块执行时就起网关),
// 打进单文件包以后 `import.meta.url` 与进程入口相同,装配一 import 它就会起一台网关。拆出网关的功能入口是留账。
import { getChannelSessionRouter } from './gateway/gateway-channel-session-router.js'
import { OutboundReplyDispatcher } from './gateway/gateway-outbound-reply-dispatcher.js'
import {
  registerChannelPromptContextProvider,
  unregisterChannelPromptContextProvider,
} from './gateway/gateway-channel-prompt-context.js'
import {
  handleCollabRoomSendMessage,
  isCollabRoomSession,
  type CollabRoomInboundCommand,
} from '@onething/backend/collab/collab-ingress'
import {
  isCollabCoordinatorDrivenSession,
} from '@onething/backend/session'
import { isTrustedCollabDrive } from '@onething/backend/collab/collab-drive-guard'
import { findCollabV3Turn } from '@onething/backend/collab/actors/collab-actors-turn-context'
import { configureExternalAgentTurnLookup } from '@onething/backend/external-agent'
import {
  pluginPostInterceptReply,
  type PluginInterceptSteerPort,
} from '@onething/backend/plugin/plugin-session-messenger'
import { resolveAgentProfileForSession } from '@onething/backend/agent/agent-profile-for-session'
import { takeExternalAgentSteering } from '@onething/backend/external-agent/external-agent-connector-registry'
import { defaultAgent, findAgent } from '@onething/backend/agent/agent-store-bound'
import { createGoalContinuationTrigger } from './goal/goal-continuation-trigger.js'
import { getCurrentBackend } from '@onething/backend/backend-current.js'
import { getLogger } from './logging/logging.js'

export type { BindableStreamSender, StreamEngine, StreamSender, StreamSenderPayload }

const log = getLogger('engine.stream')

export type MainOnethingRuntime = OnethingRuntime<
  EventBus,
  StreamSender,
  StreamChunk,
  StreamEngine
>

export function getOnethingRuntime(): MainOnethingRuntime {
  return getCurrentBackend('runtime').runtime
}

export function getConversationRuntime(): CoreConversationRuntime<StreamChunk> {
  return getOnethingRuntime().conversationRuntime
}

/**
 * 造引擎层。纯工厂:造完把引擎、runtime 与**它自己留下的收尾**一起交出去。
 *
 * 两件尾巴写在这里而不是散在关机链上:频道提示词供给是这一层注册的,出站回复
 * 派发器是这一层 start 的 —— 起它的那一行与关它的那一行因此看得见彼此。
 *
 * `runtime` 与派发器两处 try/catch 保持 A2 之前的形状:上游单测把事件系统整个
 * mock 成空对象,那种场景下这两步失败是预期的,而引擎本身照样要交得出来。
 */
export function createStreamEngineLayer(deps: {
  eventBus: EventBus
  streamChannel: StreamChannel
  assertAccepting?: (sessionId?: string) => void
}): {
  engine: StreamEngine
  runtime: MainOnethingRuntime | undefined
  quiesceOutboundReplies: () => void
  drainOutboundReplies: () => Promise<void>
  dispose: () => Promise<void>
} {
  const streamRuntime = createMainStreamEngineRuntime()
  registerChannelPromptContextProvider()
  const engine = createBoundStreamEngine(streamRuntime, deps.assertAccepting, ensureSessionWritable,
    (sessionId, executionContext) => sessionAccess.resolve(fixedExecutionContext(executionContext), sessionId, 'write'))

  let runtime: MainOnethingRuntime | undefined
  try {
    runtime = createOnethingRuntimeFromStreamRuntime<
      EventBus,
      StreamSender,
      StreamChunk,
      StreamEngine
    >({
      streamRuntime: streamRuntime as unknown as CoreRuntime,
      eventBus: deps.eventBus,
      streamChannel: deps.streamChannel,
      createEngine: () => engine,
      sessionRuntime: {
        ensureSession: sessionId => {
          ensurePersistentGatewaySession(sessionId)
          getSessionManager().getOrCreate(sessionId)
        },
        destroySession: sessionId => {
          getSessionManager().destroySession(sessionId)
        },
        setSessionPermissionMode: (sessionId, mode) => {
          sessionAccess.resolve(DEFAULT_SESSION_OWNER, sessionId, 'permission')
          store.updateSessionPermissionMode(sessionId, mode)
        },
      },
    })
  } catch {
    // EventBus may not be initialized yet in test scenarios
  }
  const outboundReplies = new OutboundReplyDispatcher()
  try {
    outboundReplies.start(deps.eventBus)
  } catch {
    // EventBus may not be initialized yet in test scenarios
  }
  log.info('stream engine initialized')

  let disposed = false
  return {
    engine,
    runtime,
    quiesceOutboundReplies: () => outboundReplies.quiesce(),
    drainOutboundReplies: () => outboundReplies.drain(),
    dispose: async () => {
      if (disposed) return
      disposed = true
      await outboundReplies.stop()
      unregisterChannelPromptContextProvider()
      engine.shutdown()
    },
  }
}

function ensurePersistentGatewaySession(sessionId: string): void {
  if (!sessionId.startsWith('gateway:')) return
  // Gateway currently serves one local operator. IM identities are message
  // origins, not product-account principals.
  if (store.getSession(sessionId)) {
    sessionAccess.resolve(DEFAULT_SESSION_OWNER, sessionId, 'write')
    return
  }

  const currentSessionId = store.getCurrentSessionId()
  store.createSession(sessionId, createGatewaySessionName(sessionId), { initialOwner: DEFAULT_SESSION_OWNER })
  if (currentSessionId) {
    store.setCurrentSessionId(currentSessionId)
  }
}

function createGatewaySessionName(sessionId: string): string {
  const [, channelId, userId] = /^gateway:([^:]+):(.+)$/.exec(sessionId) ?? []
  if (!channelId || !userId) return sessionId

  const channelName = channelId === 'wechat' ? 'WeChat' : channelId
  return `${channelName} - ${userId}`
}

/**
 * 把 `ProductStreamEnginePorts` 的端口全部接到后端各功能上,然后 `new ProductStreamEngine(runtime, ports)`。
 *
 * 各端口的**缺席行为**在 `agent-loop/agent-loop-engine-ports.ts` 里逐条写着;这里全填,所以桌面 /
 * 服务端 / CLI 三宿主的行为与归位前逐字相同。
 */
export function createBoundStreamEngine(
	streamRuntime: MainStreamEngineRuntime = createMainStreamEngineRuntime(),
	assertAccepting?: (sessionId?: string) => void,
	prepareSession?: (sessionId: string) => Promise<void>,
	authorizeExecution?: (sessionId: string, executionContext: unknown) => void,
): StreamEngine {
	// 回投端口要调引擎自己的 steerMessage,而引擎此刻还没造出来 —— 端口在回合中
	// 才被调用,所以这里留一个惰性引用,而不是把引擎塞进端口的签名里。
	let engine: StreamEngine | null = null;
	// 插件回投只用得上「追话」这一个动作(`PluginInterceptSteerPort`),所以惰性
	// 引用收在这一个箭头函数里,端口本体不再需要空档判断。
	const steer: PluginInterceptSteerPort['steer'] = (sessionId, content, source, origin) => {
		engine?.steerMessage(sessionId, content, source, origin);
	};

	// 五个端口各自提成带类型标注的 const(S2/I4-缝收口):就地字面量只有 contextual
	// type 认亲,tsserver 的 Go to Implementation 走不过去;标注在这里,缝就有声明边。
	const router: StreamEngineSessionRouterPort = {
		route: (input): EngineRoutedSession =>
			getChannelSessionRouter().route({
				sessionId: input.sessionId,
				origin: input.origin as MessageOrigin | undefined,
				fallbackTransport: input.fallbackTransport,
				preserveSessionId: input.preserveSessionId,
			}) as EngineRoutedSession,
	};
	const roomIngress: StreamEngineRoomIngressPort = {
		isRoomSession: isCollabRoomSession,
		isCoordinatorDrivenSession: isCollabCoordinatorDrivenSession,
		handleRoomSendMessage: (sessionId, command) =>
			handleCollabRoomSendMessage(sessionId, command as CollabRoomInboundCommand),
	};
	const pluginIntercept: StreamEnginePluginInterceptPort = {
		postReply: (pluginId, sessionId, content) =>
			pluginPostInterceptReply({ steer }, pluginId, sessionId, content),
	};
	const agentBinding: StreamEngineAgentBindingPort = {
		resolveModelForSession: sessionId =>
			resolveAgentProfileForSession(sessionId).model,
		// persona/能力功能兜底(域模型 §3.3),与 profile.ts 同一条规则:现读,
		// 不吃回合快照 —— 权限走严格且新鲜。
		resolvePermissionDeclaration: agentId => {
			const agent = findAgent(agentId) ?? defaultAgent();
			return { agentId: agent?.id, permissionMode: agent?.permissionMode };
		},
	};
	const steeringDelivery: StreamEngineSteeringDeliveryPort = {
		take: takeExternalAgentSteering,
	};
	// 协作驱动验票:内核铸回合主体时只经这个端口问(从前 `turn-principal.ts` 直接 import 协作的 drive-guard)。
	const collabDrive: StreamEngineCollabDrivePort = {
		isTrusted: isTrustedCollabDrive,
	};
	// 外部 agent 宿主工具面的牌位查询(越层清零 A5③):从前 external-agent 直接 import 协作 v3 的回合
	// 登记簿,现在在这里与上面几只协作端口一起填。幂等 —— 每次造引擎填的都是同一个函数;它只在外部
	// agent 的回合里被读,而那一定在引擎造好之后。
	configureExternalAgentTurnLookup(findCollabV3Turn);

	const ports: ProductStreamEnginePorts = {
		assertAccepting,
		prepareSession,
		authorizeExecution,
		router,
		roomIngress,
		pluginIntercept,
		agentBinding,
		steeringDelivery,
		collabDrive,
	};

	engine = new ProductStreamEngine<EventBus>(
		streamRuntime as unknown as ConstructorParameters<typeof ProductStreamEngine>[0],
		ports,
	);
	return engine;
}

/** `EngineMessageOrigin` 是 shared `MessageOrigin` 的结构子集 —— 编译期钉住这句话。 */
const _originIsAssignable: EngineMessageOrigin = undefined as unknown as MessageOrigin;
void _originIsAssignable;

let builtinTriggersRegistered = false;

/**
 * A3(`docs/design/backend-composition-root-2026-09.md` §2.5,(b) 类闩):注册
 * 返回 disposer,由 `assembleSteps` 的 `own()` 接住。
 *
 * 从前这个闩是单向的:`triggerManager` 是**模块级**单例,而它挂着的三只触发器
 * 里有引擎与总线的引用。装配 → dispose → 再装配时闩还是 true,于是第二份装配
 * 一只都不注册 —— 表里留着的是第一份的尸体,`runPostResponse` 会拿着已经关掉的
 * 总线跑。现在 dispose 把三只摘干净并把闩放回去,第二份装配注册的是新的三只。
 *
 * `unregister` 按 id 摘(`CoreTriggerManager.unregister`),所以摘的只有
 * 这三只 —— 别人(feature / 插件)往同一张表里注册的不受影响。
 */
export function registerBuiltinTriggers(options: { sessionToc: Trigger }): () => void {
  if (builtinTriggersRegistered) return () => {}
  builtinTriggersRegistered = true
  // Skill review is intentionally not registered: createSkillReviewTrigger()
  // still exists in skill/skill-review-trigger.ts — re-add it to the
  // list below to bring it back.
  const triggers = [
    createGoalContinuationTrigger(),
    createTurnEvaluationTrigger(),
    options.sessionToc,
  ]
  for (const trigger of triggers) triggerManager.register(trigger)
  return () => {
    for (const trigger of triggers) triggerManager.unregister(trigger.id)
    builtinTriggersRegistered = false
  }
}
