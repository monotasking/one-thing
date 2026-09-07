/**
 * `ProductStreamEngine` —— 产品层的流引擎(P3'e-A2a 从 `packages/backend/engine/`
 * 归位到这里)。
 *
 * 它在 core 的 `CoreStreamEngine` 之上加的**只有产品决策**:谁的消息、落到哪条
 * 会话、要不要被插件接管、这一回合套哪个 agent 的绑定。它对装配层的每一处需要
 * 都走 `ProductStreamEnginePorts` 的可选端口(`ports.ts` 里逐条写了缺席行为),
 * 所以这个文件零装配层依赖、零 shared IPC 契约依赖。
 *
 * 装配层那一薄片在 `packages/backend/wiring/engine/stream-engine-bound.ts`。
 */
import {
	CoreStreamEngine,
	resolveStreamPermissionMode,
	type CoreEventBusEmitterLike,
	type CoreExecutionOptions,
	type CoreInitialToolChoice,
	type CoreStreamEngineRuntime,
	type CoreStreamPermissionModeSession,
	type CoreStreamPermissionModeSettings,
} from "@onething/core/engine";
import type {
	BindableOnethingStreamSender,
	OnethingStreamSender,
	OnethingStreamSenderPayload,
} from "../stream-sender.js";
import { isSystemInternalSource } from "./message-sources.js";
import { isTrustedCollabDrive } from "../collab/drive-guard.js";
import { runPluginInputIntercept } from "../plugins/input-intercept-bound.js";
import { mintTurnPrincipal } from "./turn-principal.js";
import { composeAgentPermissionMode } from "../agents/index.js";
import { getLogger } from "../logging/index.js";
import type {
	EngineMessageOrigin,
	EngineOriginTransport,
	EngineRoutedSession,
	ProductStreamEnginePorts,
} from "./ports.js";

const log = getLogger('engine.stream')


export type StreamSenderPayload = OnethingStreamSenderPayload;
export type StreamSender = OnethingStreamSender;
export type BindableStreamSender = BindableOnethingStreamSender;

/** 引擎读得到的 send-message 命令面。shared 的 `SessionCommand` 结构上可赋给它。 */
export interface ProductSendMessageCommand {
	type?: string;
	channel?: string;
	source?: string;
	content: string;
	attachments?: unknown[];
	voice?: unknown;
	origin?: EngineMessageOrigin;
	replyTo?: unknown;
	/** Picked @mentions (W14a); consumed by the room ingress gate. */
	mentions?: unknown[];
	/**
	 * W23: the room message a collab drive answers. Pure passthrough to
	 * the core engine, which persists it onto the drive's user message.
	 */
	collabSourceMessageId?: string;
	/**
	 * P2-8: proof this command came from the live coordinator. Consumed by
	 * the room/exec gate below and by the ingress gate; never persisted.
	 */
	collabDriveToken?: string;
	/**
	 * The actor the sender CLAIMS. Honoured only when the drive token
	 * proves the claim (see mintTurnPrincipal); otherwise overwritten.
	 * apps/server forwards commands whole, so this field is reachable
	 * from the network — treating it as trusted would hand any caller a
	 * chosen identity.
	 */
	principal?: unknown;
	/** Billing attribution passthrough (W13.3); default 'chat'. */
	usageSource?: string;
	/**
	 * Force the first model call of this turn into a (named) tool call
	 * — W18b, narrowed to `say` by name in W22. Set by the collab room
	 * drive only; rides straight through to the agent loop.
	 */
	initialToolChoice?: CoreInitialToolChoice;
	/** Per-command model override; an explicit one outranks the agent binding. */
	providerId?: string;
	model?: string;
	thinking?: boolean;
	thinkingEffort?: string;
}

/** 引擎读得到的 edit-and-resend 命令面。 */
export interface ProductEditAndResendCommand {
	type?: string;
	channel?: string;
	source?: string;
	messageId: string;
	newContent: string;
	origin?: EngineMessageOrigin;
}

export class ProductStreamEngine<
	TEventBus extends CoreEventBusEmitterLike = CoreEventBusEmitterLike,
> extends CoreStreamEngine<TEventBus, StreamSender> {
	constructor(
		runtime: CoreStreamEngineRuntime,
		protected readonly ports: ProductStreamEnginePorts = {},
	) {
		super(runtime, { assertAccepting: ports.assertAccepting, prepareSession: ports.prepareSession, authorizeExecution: ports.authorizeExecution });
	}

	/**
	 * session/settings chain (core) composed with the agent's declared mode by
	 * STRICTNESS — an agent that asks to be asked is not silenced by a session
	 * that turned approvals off. An agent that declares nothing does not
	 * participate, so the collab worker's inherited auto-approve still holds.
	 *
	 * Read live rather than off the turn snapshot: this runs per `Permission.ask`
	 * via the callback wired in backend.ts, and permissions go strict-and-fresh.
	 */
	getPermissionMode(sessionId: string): string {
		const session = this.store.getSession(sessionId);
		const base = resolveStreamPermissionMode(
			session as CoreStreamPermissionModeSession | undefined,
			this.store.getSettings() as CoreStreamPermissionModeSettings | undefined,
		);
		// persona/能力功能兜底(域模型 §3.3),与 profile.ts 同一条规则。
		// 端口缺席 = agent 什么都没声明 = 这条链的结果就是 base。
		const declaration = this.ports.agentBinding?.resolvePermissionDeclaration(
			session?.agentId,
		);
		return composeAgentPermissionMode(declaration?.permissionMode, base, undefined, {
			agentId: declaration?.agentId,
		});
	}

	bind(sender: BindableStreamSender): void {
		this.bindCommandTarget(sender, clear => sender.on("destroyed", clear));
	}

	hasBoundSender(): boolean {
		return this.hasCommandTarget(sender => !sender.isDestroyed());
	}

	override handleSendMessage(sessionId: string, command: ProductSendMessageCommand, sender: StreamSender, options: CoreExecutionOptions = {}): Promise<void> {
		return this.trackSessionExecution(sessionId, () => this.performProductSendMessage(sessionId, command, sender, options));
	}

	private async performProductSendMessage(
		sessionId: string,
		command: ProductSendMessageCommand,
		sender: StreamSender,
		options: CoreExecutionOptions,
	): Promise<void> {
		/*
		 * 授权与收活闸,一条发送**各判一次**(工单 5 §4,triage B8/D4)。
		 *
		 * 从前这两句之后 `super.handleSendMessage` 会再经公开入口跑一遍 track +
		 * 授权,`prepareSessionExecution` 前后再各一遍 —— 同一个谓词一次发送跑三到
		 * 四遍。现在产品层接的是父类的**模板步骤** `performSendMessage`,于是
		 * 「入口一层」这句话在代码里就是真的:track 一层、授权一次。
		 *
		 * `this.assertAccepting()`(父类的,读 `options.assertAccepting`)与
		 * `this.ports.assertAccepting?.()` 本是同一个闭包的两个名字 —— 统一走父类
		 * 那一个,产品层不再自己拿端口调一遍。
		 */
		this.authorizeExecution(sessionId, options.executionContext);
		this.assertAccepting(sessionId);
		// System-internal re-drives (goal continuations, ...) have no channel
		// identity behind them. The router would resolve their `api` origin to
		// an anonymous channel identity, remap the command into an identity
		// session and overwrite the session's memory-profile metadata — so
		// they bypass routing entirely, like the in-run goal injection. The
		// source set is shared with the counterpart-identity scans.
		if (isSystemInternalSource(command.source)) {
			// Only the coordinator's own drives may stream a room — or, since W18,
			// an agent's execution session, which is where the turn actually runs.
			// Other internal emitters (goal retry kicks, radio) targeting one would
			// bypass the coordinator entirely: a turn with the last activated
			// persona, no mention resolution, and none of the three gates.
			//
			// P2-8: the test is the drive TOKEN, not the source string. `source`
			// says what a command claims to be; only the coordinator that minted
			// this process's token can prove it (drive-guard.ts).
			if (
				this.ports.roomIngress?.isCoordinatorDrivenSession(sessionId)
				&& !(command.source === "collab" && isTrustedCollabDrive(command))
			) {
				log.warn("internal source refused on coordinator-driven session", {
					sessionId,
					source: command.source,
				});
				return;
			}
			await super.performSendMessage(
				sessionId,
				this.withAgentModelBinding(sessionId, {
					...command,
					principal: mintTurnPrincipal(command, command.origin),
				}),
				sender,
				options,
			);
			return;
		}

		// Room ingress gate (docs/multi-agent-collab.md D2): user messages into a
		// room persist WITHOUT streaming — the engine's auto-drive would reply
		// with the stale persona and supersede-abort the coordinator. The
		// coordinator observes message:user-created and decides activations; its
		// own drives carry source 'collab' and take the system-internal branch.
		if (await this.ports.roomIngress?.handleRoomSendMessage(sessionId, command)) {
			return;
		}

		const routed = this.route({
			sessionId,
			origin: command.origin,
			fallbackTransport: fallbackTransportForCommand(command),
			preserveSessionId: shouldPreserveSessionId(command),
		});

		// 路由把这条命令换到了另一条会话上:写的是**那一条**,所以那一条也要判一次。
		// 不换(桌面 / web / 每一条非网关路径)就是零次 —— 一次发送恰好一次授权。
		if (routed.sessionId !== sessionId) this.authorizeExecution(routed.sessionId, options.executionContext);

		// ── N2: the plugin input-intercept chain ───────────────────────────────
		//
		// THE hook point for "rewrite / take over before sending". It sits here,
		// and only here, for four reasons:
		//
		//  1. Every real user send funnels through this one method — desktop IPC,
		//     the floating panel, voice, the search window, apps/server's HTTP
		//     command forward. One hook point covers them all; a per-entry hook
		//     would have to be re-added at every future entry.
		//  2. It is AFTER the system-internal early return, so goal / radio /
		//     collab drives and `plugin:<id>` pushes (N1) never enter the chain.
		//     Otherwise one plugin would silently rewrite another's delivery and
		//     nothing on record could say who wrote the text.
		//  3. It is AFTER the collab room gate: room messages are driven by the
		//     coordinator, and "handled" there has no meaning (nothing was going
		//     to stream anyway).
		//  4. It is AFTER routing, so `ctx.sessionId` is the session the message
		//     actually lands in — a gateway message remapped onto an identity
		//     session must not report the pre-routing id.
		//
		// fail-open is enforced inside runPluginInputIntercept: it never throws,
		// and a broken plugin degrades to "the message goes out untouched".
		const intercepted = await runPluginInputIntercept({
			sessionId: routed.sessionId,
			text: command.content,
			source: "user",
		});
		const interceptedOrigin: EngineMessageOrigin = intercepted.transformedBy.length
			? { ...routed.origin, inputTransformed: { by: intercepted.transformedBy } }
			: routed.origin;

		const nextCommand = {
			...command,
			// The transform result IS the truth: what is persisted, what the model
			// sees and what edit-and-resend reconstructs are the same bytes. The
			// original is not kept — only who rewrote it (see InputTransformStamp).
			content: intercepted.text,
			origin: interceptedOrigin,
			source: command.source || routed.origin.source,
			channel: command.channel || channelForOrigin(routed.origin),
			// Minted AFTER routing: the router is what resolves a gateway message
			// to a channel identity, and that identity is the actor.
			principal: mintTurnPrincipal(command, routed.origin),
		};

		if (intercepted.handled) {
			// The user said it, so it is persisted and displayed like any other
			// user message — but nothing answers it. `persistOnly` is the engine
			// word for exactly that (no provider resolution, no title call, no
			// stream): "handled" must cost zero tokens or the whole point of a
			// local macro is gone.
			await super.performSendMessage(
				routed.sessionId,
				{ ...nextCommand, persistOnly: true },
				sender,
				options,
			);
			if (intercepted.reply && intercepted.handledBy) {
				this.ports.pluginIntercept?.postReply(
					intercepted.handledBy,
					routed.sessionId,
					intercepted.reply,
				);
			}
			return;
		}

		await super.performSendMessage(
			routed.sessionId,
			this.withAgentModelBinding(routed.sessionId, nextCommand),
			sender,
			options,
		);
	}

	/**
	 * 路由端口的唯一调用点。**缺席 = 不路由**:会话 id 原样、origin 用命令自带的
	 * 那一份(没有就按 fallback transport 现造一个),与系统内部驱动走的那条旁路
	 * 同形。
	 */
	private route(input: {
		sessionId: string;
		origin?: EngineMessageOrigin;
		fallbackTransport?: EngineOriginTransport;
		preserveSessionId?: boolean;
	}): EngineRoutedSession {
		const router = this.ports.router;
		if (router) return router.route(input);
		return {
			sessionId: input.sessionId,
			origin: input.origin ?? {
				transport: input.fallbackTransport ?? "desktop",
				source: "text",
				receivedAt: Date.now(),
			},
		};
	}

	/**
	 * Apply the agent's model binding when nothing more specific asked for a
	 * model (A1.4). Two things outrank it and both are already decided by the
	 * time a command reaches here: an explicit per-command override (the
	 * renderer's picker result, a collab drive's own stamp) and a session the
	 * user pinned by hand — the agent-binding port drops the binding for a
	 * pinned session, so this only ever fills a genuine blank.
	 *
	 * Stamped onto the command rather than folded into
	 * getEffectiveProviderConfig, keeping the store.ts contract that an agent's
	 * model is never part of that resolution chain.
	 */
	private withAgentModelBinding<
		TCommand extends {
			providerId?: string;
			model?: string;
			thinking?: boolean;
			thinkingEffort?: string;
		},
	>(sessionId: string, command: TCommand): TCommand {
		if (command.providerId) return command;
		const binding = this.ports.agentBinding?.resolveModelForSession(sessionId);
		if (!binding?.providerId) return command;
		return {
			...command,
			providerId: binding.providerId,
			...(binding.modelId ? { model: binding.modelId } : {}),
			...(binding.thinking
				? { thinking: true, thinkingEffort: binding.thinking }
				: {}),
		};
	}

	override handleEditAndResend(sessionId: string, command: ProductEditAndResendCommand, sender: StreamSender, options: CoreExecutionOptions = {}): Promise<void> {
		return this.trackSessionExecution(sessionId, () => this.performProductEditAndResend(sessionId, command, sender, options));
	}

	private async performProductEditAndResend(
		sessionId: string,
		command: ProductEditAndResendCommand,
		sender: StreamSender,
		options: CoreExecutionOptions,
	): Promise<void> {
		this.authorizeExecution(sessionId, options.executionContext);
		this.assertAccepting(sessionId);
		// P0: edit/retry semantics in rooms are undefined (a retry would replay
		// with the CURRENT session persona, not the message's original one).
		// The renderer hides these affordances; this is the engine backstop —
		// and it must be OBSERVABLE: the renderer latches sessionLoading before
		// emitting, so a silent return would wedge the composer.
		if (this.ports.roomIngress?.isRoomSession(sessionId)) {
			this.refuseCollab(sessionId, "群聊房间不支持编辑重发");
			return;
		}
		const routed = this.route({
			sessionId,
			origin: command.origin,
			fallbackTransport: fallbackTransportForCommand(command),
			preserveSessionId: shouldPreserveSessionId(command),
		});
		const nextCommand = {
			...command,
			origin: routed.origin,
			source: command.source || routed.origin.source,
			channel: command.channel || channelForOrigin(routed.origin),
		};
		await super.performEditAndResend(routed.sessionId, nextCommand, sender, options);
	}

	override handleRetryMessage(sessionId: string, command: Parameters<CoreStreamEngine<TEventBus, StreamSender>["handleRetryMessage"]>[1], sender: StreamSender, options: CoreExecutionOptions = {}): Promise<void> {
		return this.trackSessionExecution(sessionId, () => this.performProductRetryMessage(sessionId, command, sender, options));
	}

	private async performProductRetryMessage(
		sessionId: string,
		command: Parameters<CoreStreamEngine<TEventBus, StreamSender>["handleRetryMessage"]>[1],
		sender: StreamSender,
		options: CoreExecutionOptions,
	): Promise<void> {
		this.authorizeExecution(sessionId, options.executionContext);
		this.assertAccepting(sessionId);
		if (this.ports.roomIngress?.isRoomSession(sessionId)) {
			this.refuseCollab(sessionId, "群聊房间不支持重试");
			return;
		}
		await super.performRetryMessage(sessionId, command, sender, options);
	}

	override steerMessage(
		sessionId: string,
		content: string,
		source = "api",
		origin?: EngineMessageOrigin,
	): void {
		this.assertAccepting(sessionId);
		// Same bypass as handleSendMessage, same reason: a system-internal
		// injection (goal / radio / collab / plugin push) has no channel identity
		// behind it, and the router would resolve its origin to an anonymous one,
		// remap the queue onto an identity session and overwrite the session's
		// memory-profile metadata. N1's plugin messenger relies on this: a plugin
		// steering session X must land in X.
		if (isSystemInternalSource(source)) {
			super.steerMessage(sessionId, content, source, origin);
			return;
		}
		const routed = this.route({
			sessionId,
			origin,
			fallbackTransport: fallbackTransportForCommand({ source }),
			preserveSessionId: source === "gateway",
		});
		super.steerMessage(
			routed.sessionId,
			content,
			source || routed.origin.source,
			routed.origin,
		);
	}

	override followUpMessage(
		sessionId: string,
		content: string,
		source = "api",
		origin?: EngineMessageOrigin,
	): void {
		this.assertAccepting(sessionId);
		// See steerMessage: system-internal injections bypass routing.
		if (isSystemInternalSource(source)) {
			super.followUpMessage(sessionId, content, source, origin);
			return;
		}
		const routed = this.route({
			sessionId,
			origin,
			fallbackTransport: fallbackTransportForCommand({ source }),
			preserveSessionId: source === "gateway",
		});
		super.followUpMessage(
			routed.sessionId,
			content,
			source || routed.origin.source,
			routed.origin,
		);
	}

	/**
	 * 外部会话的中途追话**就地送进去**(2026-08-12)。
	 *
	 * core 的钩子默认返回 false(照旧入队);端口是它唯一的实现。判据全在装配层
	 * 填进来的那一面里:没有正在跑的外部回合就还是 false,于是原生会话与空闲的
	 * 外部会话行为一字不变。端口缺席也是 false —— 与 core 的默认同义。
	 */
	protected override takeSteeringDelivery(sessionId: string, content: string): boolean {
		return this.ports.steeringDelivery?.take(sessionId, content) ?? false;
	}

	/**
	 * 房间里没有定义的编辑/重试:落一条 `stream:error`,渲染层据此解掉
	 * sessionLoading。事件本体走继承来的 `emitStreamError`(同一个 `stream:error`
	 * + `data.error` 形状),这里只多留那一行 warn。
	 */
	private refuseCollab(sessionId: string, error: string): void {
		log.warn("collab refusal", { sessionId, reason: error });
		this.emitStreamError(sessionId, error);
	}

	protected override onShutdown(): void {
		super.onShutdown();
		log.info("stream engine shut down");
	}
}

function fallbackTransportForCommand(command: {
	channel?: string;
	source?: string;
}): EngineOriginTransport {
	if (command.source === "voice" || command.channel === "voice") return "voice";
	if (command.source === "api" || command.channel === "api") return "api";
	if (
		command.channel &&
		command.channel !== "ipc" &&
		command.channel !== "desktop"
	)
		return "im";
	return "desktop";
}

function channelForOrigin(origin: EngineMessageOrigin): string {
	if (origin.transport === "im") {
		return (
			origin.conversation?.connector || origin.replyTarget?.connector || "im"
		);
	}
	return origin.transport === "desktop" ? "ipc" : origin.transport;
}

function shouldPreserveSessionId(command: { source?: string }): boolean {
	return command.source === "gateway";
}
