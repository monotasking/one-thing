/**
 * `SessionTurnContext` — delivery and persistence for the turn channel.
 *
 * The composer says *what* this turn's blocks are; `TurnContextLedger` says
 * *which of them changed*; this object is the only place that writes the answer
 * down and puts it in front of the model.
 *
 * It runs at **request build** time, not at message-creation time. The material
 * a turn block is computed from — the tool surface, the working directory,
 * skills, projects, AGENTS.md, the voice flag — is exactly the context the
 * prompt was just built with; deciding the block earlier (as the engine's old
 * `resolveTurnContextUpdate` hook did) means computing the same facts twice
 * from different inputs, which is a fork waiting to happen.
 *
 * Idempotence is what makes the tool loop cache-safe: the first build of a turn
 * writes `turnContext` onto the newest user message and rewrites that message
 * in *this* request; every later build in the same turn finds the field already
 * there, changes nothing, and the history rebuild replays identical bytes. A
 * steering / follow-up message arrives as a new user message with no field of
 * its own, so it gets its own diff — which is the correct behaviour, not an
 * exception.
 */
import {
	TurnContextLedger,
	visibleMessagesAfterSummary,
	type CorePromptRequestMessage,
	type TurnBlock,
	type TurnContextCarrier,
	type TurnContextDelta,
} from '@onething/core/engine'
import type { ChatMessage } from '@shared/ipc.js'

/**
 * 这个对象与会话的全部往来:一次读、一次读会话级字段、一次写。P0.2 区 ②
 * 把它从「整会话 store」收窄成三个具名端口 —— 生产接的是
 * `sessionReads.listMessages` / `sessionReads.getSession` /
 * `sessionCommands.patchMessage`,三个都是**同步**的,`attach()` 也因此仍是同步、
 * 仍然靠持久化的 `turnContext` 字段做幂等闸。
 */
export interface SessionTurnContextStore {
	/** 这条会话当前的消息(只读视图) */
	listMessages(sessionId: string): readonly ChatMessage[]
	/** 会话级字段;**不含 messages**(消息一律走 `listMessages`) */
	getSessionMeta(sessionId: string): { summaryUpToMessageId?: string } | undefined | null
	updateMessageTurnContext(
		sessionId: string,
		messageId: string,
		turnContext: NonNullable<ChatMessage['turnContext']>,
	): boolean
}

/** The message a block is attached to: the newest one the user sent. */
function latestUserMessage(messages: readonly ChatMessage[]): ChatMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === 'user') return messages[index]
	}
	return undefined
}

/**
 * How many "decided" message ids to remember. One entry per user message the
 * process has built a prompt for; the oldest are forgotten first. Forgetting
 * one only means a later build in that same turn would re-run the diff — the
 * persisted field still wins when there was something to say.
 */
const DECIDED_CAPACITY = 4096

export class SessionTurnContext {
	private readonly ledger = new TurnContextLedger()
	/**
	 * Messages whose turn context has been decided in this process, whether or
	 * not anything was attached. The persisted field marks "attached"; this set
	 * marks "evaluated, nothing to attach" — without it a turn whose first
	 * build had nothing new would re-diff on every tool-loop call, and a board
	 * value that moves mid-turn (datetime crossing the hour) would rewrite the
	 * user message halfway through the loop, breaking the request bytes that
	 * the loop must keep identical.
	 */
	private readonly decided = new Set<string>()

	constructor(
		private readonly store: SessionTurnContextStore,
		private readonly logger: { error(...args: unknown[]): void } = console,
	) {}

	/**
	 * Attach this turn's blocks to the request. Returns the messages to send —
	 * the same array when there is nothing to deliver (the common case once a
	 * session has settled).
	 */
	attach<TMessage extends CorePromptRequestMessage>(
		sessionId: string | undefined,
		messages: TMessage[],
		blocks: readonly TurnBlock[],
	): TMessage[] {
		if (!sessionId) return messages
		try {
			const sessionMessages = this.store.listMessages(sessionId)
			if (sessionMessages.length === 0) return messages

			const target = latestUserMessage(sessionMessages)
			// Nothing to hang the block on. Happens on the very first build of a
			// session whose user message is not persisted yet — the next build
			// (there always is one, the turn cannot run without a user message)
			// picks it up.
			if (!target?.id) return messages
			// Already delivered on this message: the field is the record, and the
			// history rebuild has rendered it. Touching it again would rewrite
			// history bytes mid-turn.
			if (target.turnContext || target.contextUpdate) return messages
			// Already evaluated with nothing to say: same answer for the rest of
			// the turn, even if a block moved in the meantime.
			const decidedKey = `${sessionId}\u0001${target.id}`
			if (this.decided.has(decidedKey)) return messages

			const visible = visibleMessagesAfterSummary(
				sessionMessages,
				this.store.getSessionMeta(sessionId)?.summaryUpToMessageId,
			) as ReadonlyArray<ChatMessage & TurnContextCarrier>
			const delta = this.ledger.diff(visible, blocks)
			this.remember(decidedKey)
			if (!delta) return messages

			this.store.updateMessageTurnContext(sessionId, target.id, delta)
			return this.renderInto(messages, delta)
		} catch (error) {
			// A turn context that cannot be attached is a degraded prompt, never a
			// failed turn: the model loses a paragraph, the user still gets an answer.
			this.logger.error('[turn-context] attach failed:', error)
			return messages
		}
	}

	private remember(key: string): void {
		this.decided.add(key)
		if (this.decided.size <= DECIDED_CAPACITY) return
		// Set iterates in insertion order: the first entry is the oldest.
		for (const oldest of this.decided) {
			this.decided.delete(oldest)
			break
		}
	}

	/**
	 * Rewrite the last user message of *this* request so the block travels now.
	 * Later builds do not come through here — they replay the persisted field
	 * via the history builder, which applies the same `TurnContextLedger.applyTo`
	 * placement rule to the same built content and produces the same bytes.
	 */
	private renderInto<TMessage extends CorePromptRequestMessage>(
		messages: TMessage[],
		delta: TurnContextDelta,
	): TMessage[] {
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]
			if (message.role !== 'user') continue
			const out = [...messages]
			out[index] = { ...message, content: this.ledger.applyTo(message.content, delta) } as TMessage
			return out
		}
		return messages
	}
}
