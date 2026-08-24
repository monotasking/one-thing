/**
 * 引擎的**装配层薄片**(P3'e-A2a)。
 *
 * 引擎本体已经归位到 `@onething/runtime/engine`;这里剩下的全部工作是把
 * `ProductStreamEnginePorts` 的五个端口接到后端脊柱与各域接线上,然后
 * `new ProductStreamEngine(runtime, ports)`。没有子类、没有第二条路径 ——
 * 判断逻辑一行都不许住在这里,一住进来就又是一个「引擎在装配层」。
 *
 * 五个端口在 `runtime/src/engine/ports.ts` 里逐条写了**缺席行为**;这里五个全填,
 * 所以桌面/服务端/CLI 三宿主的行为与归位前逐字相同。
 */
import {
	ProductStreamEngine,
	type EngineMessageOrigin,
	type EngineRoutedSession,
	type ProductStreamEnginePorts,
	type StreamEngineAgentBindingPort,
	type StreamEnginePluginInterceptPort,
	type StreamEngineRoomIngressPort,
	type StreamEngineSessionRouterPort,
	type StreamEngineSteeringDeliveryPort,
} from "@onething/runtime/engine";
import type { MessageOrigin } from "@shared/ipc.js";
import type { EventBus } from "../../events/event-bus.js";
import { getChannelSessionRouter } from "../../channel/index.js";
import {
	handleCollabRoomSendMessage,
	isCollabCoordinatorDrivenSession,
	isCollabRoomSession,
	type CollabRoomInboundCommand,
} from "../collab/ingress.js";
import {
	pluginPostInterceptReply,
	type PluginInterceptSteerPort,
} from "../plugins/sessions.js";
import { resolveAgentProfileForSession } from "../agents/profile.js";
import { takeExternalAgentSteering } from "../external-agents/index.js";
import { defaultAgent, findAgent } from "@onething/runtime/agents/store-bound.wiring";
import {
	createMainStreamEngineRuntime,
	type MainStreamEngineRuntime,
} from "./stream-engine-runtime.js";

export type {
	BindableStreamSender,
	StreamSender,
	StreamSenderPayload,
} from "@onething/runtime/engine";

/** 后端这一侧的引擎类型名(全仓 88 处 `StreamEngine` 说的就是它)。 */
export type StreamEngine = ProductStreamEngine<EventBus>;

export function createBoundStreamEngine(
	streamRuntime: MainStreamEngineRuntime = createMainStreamEngineRuntime(),
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

	const ports: ProductStreamEnginePorts = {
		router,
		roomIngress,
		pluginIntercept,
		agentBinding,
		steeringDelivery,
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
