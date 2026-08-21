import type {
	ChatMessageMention,
	ChatMessageReplyTo,
	MessageAttachment,
	PermissionMode,
	VoiceTranscriptMetadata,
} from "@shared/ipc.js";
import type { MessageOrigin } from "@shared/ipc.js";
import {
	type CoreInitialToolChoice,
	type CoreStreamEngineRuntime,
} from "@onething/core/engine";
import {
	OnethingStreamEngine,
	type BindableOnethingStreamSender,
	type OnethingStreamSender,
	type OnethingStreamSenderPayload,
} from "@onething/runtime/stream-engine";
import type { EventBus } from "../events/event-bus.js";
import {
	createMainStreamEngineRuntime,
	type MainStreamEngineRuntime,
} from "./stream-engine-runtime.js";
import { getChannelSessionRouter } from "../channel/index.js";
import { isSystemInternalSource } from "../channel/origin.js";
import {
	handleCollabRoomSendMessage,
	isCollabCoordinatorDrivenSession,
	isCollabRoomSession,
} from "../collab/ingress.js";
import { isTrustedCollabDrive } from "../collab/drive-guard.js";
import { runPluginInputIntercept } from "../plugins/input-intercept.js";
import { pluginPostInterceptReply } from "../plugins/sessions.js";
import { mintTurnPrincipal } from "./turn-principal.js";
import { getEventBus } from "../events/index.js";
import { composeAgentPermissionMode } from "@onething/runtime/agents";
import { defaultAgent, findAgent } from "@onething/runtime/agents/store-bound.wiring";
import { resolveAgentProfileForSession } from "../agents/profile.js";
import { getSession } from "../stores/sessions.js";
import { takeExternalAgentSteering } from "../external-agents/index.js";

import { SESSION_EVENT_TYPES } from "@shared/events/index.js";
import { getLogger } from '../logging/index.js'

const log = getLogger('engine.stream')


export type StreamSenderPayload = OnethingStreamSenderPayload;
export type StreamSender = OnethingStreamSender;
export type BindableStreamSender = BindableOnethingStreamSender;

export class StreamEngine extends OnethingStreamEngine<EventBus, StreamSender> {
	constructor(
		private readonly mainRuntime: MainStreamEngineRuntime = createMainStreamEngineRuntime(),
	) {
		super(mainRuntime as unknown as CoreStreamEngineRuntime);
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
	getPermissionMode(sessionId: string): PermissionMode {
		const base = super.getPermissionMode(sessionId);
		// persona/能力功能兜底(域模型 §3.3),与 profile.ts 同一条规则。
		const agent = findAgent(getSession(sessionId)?.agentId) ?? defaultAgent();
		return composeAgentPermissionMode(agent?.permissionMode, base, undefined, {
			agentId: agent?.id,
		}) as PermissionMode;
	}

	bind(sender: BindableStreamSender): void {
		super.bind(sender);
	}

	override async handleSendMessage(
		sessionId: string,
		command: {
			type?: string;
			channel?: string;
			source?: string;
			content: string;
			attachments?: MessageAttachment[];
			voice?: VoiceTranscriptMetadata;
			origin?: MessageOrigin;
			replyTo?: ChatMessageReplyTo;
			/** Picked @mentions (W14a); consumed by the room ingress gate. */
			mentions?: ChatMessageMention[];
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
		},
		sender: StreamSender,
	): Promise<void> {
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
				isCollabCoordinatorDrivenSession(sessionId)
				&& !(command.source === "collab" && isTrustedCollabDrive(command))
			) {
				log.warn("internal source refused on coordinator-driven session", {
					sessionId,
					source: command.source,
				});
				return;
			}
			await super.handleSendMessage(
				sessionId,
				this.withAgentModelBinding(sessionId, {
					...command,
					principal: mintTurnPrincipal(command, command.origin),
				}),
				sender,
			);
			return;
		}

		// Room ingress gate (docs/multi-agent-collab.md D2): user messages into a
		// room persist WITHOUT streaming — the engine's auto-drive would reply
		// with the stale persona and supersede-abort the coordinator. The
		// coordinator observes message:user-created and decides activations; its
		// own drives carry source 'collab' and take the system-internal branch.
		if (await handleCollabRoomSendMessage(sessionId, command)) {
			return;
		}

		const routed = getChannelSessionRouter().route({
			sessionId,
			origin: command.origin,
			fallbackTransport: fallbackTransportForCommand(command),
			preserveSessionId: shouldPreserveSessionId(command),
		});

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
		const interceptedOrigin: MessageOrigin = intercepted.transformedBy.length
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
			await super.handleSendMessage(
				routed.sessionId,
				{ ...nextCommand, persistOnly: true },
				sender,
			);
			if (intercepted.reply && intercepted.handledBy) {
				pluginPostInterceptReply(
					{ streamEngine: this },
					intercepted.handledBy,
					routed.sessionId,
					intercepted.reply,
				);
			}
			return;
		}

		await super.handleSendMessage(
			routed.sessionId,
			this.withAgentModelBinding(routed.sessionId, nextCommand),
			sender,
		);
	}

	/**
	 * Apply the agent's model binding when nothing more specific asked for a
	 * model (A1.4). Two things outrank it and both are already decided by the
	 * time a command reaches here: an explicit per-command override (the
	 * renderer's picker result, a collab drive's own stamp) and a session the
	 * user pinned by hand — `resolveAgentProfileForSession` drops the binding
	 * for a pinned session, so this only ever fills a genuine blank.
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
		const binding = resolveAgentProfileForSession(sessionId).model;
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

	override async handleEditAndResend(
		sessionId: string,
		command: {
			type?: string;
			channel?: string;
			source?: string;
			messageId: string;
			newContent: string;
			origin?: MessageOrigin;
		},
		sender: StreamSender,
	): Promise<void> {
		// P0: edit/retry semantics in rooms are undefined (a retry would replay
		// with the CURRENT session persona, not the message's original one).
		// The renderer hides these affordances; this is the engine backstop —
		// and it must be OBSERVABLE: the renderer latches sessionLoading before
		// emitting, so a silent return would wedge the composer.
		if (isCollabRoomSession(sessionId)) {
			await emitCollabRefusal(sessionId, "群聊房间不支持编辑重发");
			return;
		}
		const routed = getChannelSessionRouter().route({
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
		await super.handleEditAndResend(routed.sessionId, nextCommand, sender);
	}

	override async handleRetryMessage(
		sessionId: string,
		command: Parameters<OnethingStreamEngine<EventBus, StreamSender>["handleRetryMessage"]>[1],
		sender: StreamSender,
	): Promise<void> {
		if (isCollabRoomSession(sessionId)) {
			await emitCollabRefusal(sessionId, "群聊房间不支持重试");
			return;
		}
		await super.handleRetryMessage(sessionId, command, sender);
	}

	override steerMessage(
		sessionId: string,
		content: string,
		source = "api",
		origin?: MessageOrigin,
	): void {
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
		const routed = getChannelSessionRouter().route({
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
		origin?: MessageOrigin,
	): void {
		// See steerMessage: system-internal injections bypass routing.
		if (isSystemInternalSource(source)) {
			super.followUpMessage(sessionId, content, source, origin);
			return;
		}
		const routed = getChannelSessionRouter().route({
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
	 * core 的钩子默认返回 false(照旧入队);这里是它唯一的实现。判据全在
	 * `takeExternalAgentSteering` 里:没有正在跑的外部回合就还是 false,于是原生
	 * 会话与空闲的外部会话行为一字不变。
	 */
	protected override takeSteeringDelivery(sessionId: string, content: string): boolean {
		return takeExternalAgentSteering(sessionId, content);
	}

	protected override onShutdown(): void {
		super.onShutdown();
		log.info("stream engine shut down");
	}
}

async function emitCollabRefusal(sessionId: string, error: string): Promise<void> {
	log.warn("collab refusal", { sessionId, reason: error });
	try {
		await getEventBus().emit(sessionId, {
			type: SESSION_EVENT_TYPES.STREAM_ERROR,
			data: { error },
		} as Parameters<ReturnType<typeof getEventBus>["emit"]>[1]);
	} catch (cause) {
		log.error("emit collab refusal failed", { sessionId }, cause);
	}
}

function fallbackTransportForCommand(command: {
	channel?: string;
	source?: string;
}): MessageOrigin["transport"] {
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

function channelForOrigin(origin: MessageOrigin): string {
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
