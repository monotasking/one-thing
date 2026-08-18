/**
 * Stateless delivery of the turn channel.
 *
 * A live session dedupes its turn blocks against history and persists the delta
 * (`SessionTurnContext`, assembly layer). A caller with no session — an eval
 * replay, a one-shot host, a diagnostic — has no history to dedupe against, so
 * every block is new: it renders all of them onto the last user message. That
 * is exactly what the model receives on the first turn of a session, which is
 * the state an eval is trying to reproduce.
 *
 * Without this, a rebuilt prompt would silently lose every section that moved
 * to the turn channel (skills, projects, todo, AGENTS.md, plugin context) and
 * an ablation matrix over those names would compare two identical requests.
 */
import { TurnContextLedger, type TurnBlock } from "@onething/core/engine";

const ledger = new TurnContextLedger();

/** The `<context-update>` block for these blocks, or `undefined` if empty. */
export function renderTurnBlocksTail(content: string, blocks: readonly TurnBlock[]): string {
	const delta = ledger.diff([], blocks);
	return delta ? ledger.render(content, delta) : content;
}

/**
 * Append the turn blocks to the last user message of a request. Returns the
 * same array when there is nothing to deliver or no user message to carry it.
 */
export function attachTurnBlocksToLastUserMessage<
	TMessage extends { role: string; content: unknown },
>(messages: TMessage[], blocks: readonly TurnBlock[] | undefined): TMessage[] {
	if (!blocks?.length) return messages;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user" || typeof message.content !== "string") continue;
		const out = [...messages];
		out[index] = {
			...message,
			content: renderTurnBlocksTail(message.content, blocks),
		};
		return out;
	}
	return messages;
}
