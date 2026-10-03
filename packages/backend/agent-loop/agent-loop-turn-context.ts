/**
 * The turn channel: what the model is told **in the tail of the latest user
 * message** instead of in the static system prefix.
 *
 * The prefix must be byte-identical across every session of the same agent —
 * anything session- or turn-level (working directory, projects, skills, todo,
 * AGENTS.md, the voice flag, plugin providers, the variable board) invalidates
 * the whole prompt cache when it lands there. Those facts ride the
 * `<context-update>` block instead: appended to the newest user message,
 * persisted on it, and replayed verbatim on every history rebuild.
 *
 * The block is a set of named **sections**, one per contributed block, and the
 * ledger below is what decides which of them this turn has to (re)send:
 * a section is written only when its bytes differ from the last version the
 * model can still see, and a section that disappeared gets a `removed`
 * tombstone. Cost model: AGENTS.md is sent once per session (twice if the file
 * changes), todo once, the board only when a value moves.
 *
 * Pure and dependency-free: the delta is data, the render is a string, and
 * persistence belongs to the caller (`SessionTurnContext` in the app layer).
 */

/** One rendered block from the composer: a section id and its content. */
export interface TurnBlock {
	id: string;
	content: string;
}

/**
 * What gets persisted on the user message: the sections this message
 * (re)delivered, and the sections it retired. Absent sections are unchanged —
 * whatever an earlier visible message said still stands.
 */
export interface TurnContextDelta {
	set?: Record<string, string>;
	removed?: string[];
}

/** The shape the ledger reads off history: either field, or neither. */
export interface TurnContextCarrier {
	/** Legacy whole-block text (pre-2026-08-18 sessions). */
	contextUpdate?: unknown;
	turnContext?: TurnContextDelta;
}

/**
 * The section id a legacy `contextUpdate` string is read as. The legacy block
 * only ever carried the variable board, so reading it as the `variables`
 * section makes an old session dedupe correctly against a new build instead of
 * re-sending the board once on upgrade.
 */
export const LEGACY_TURN_CONTEXT_SECTION_ID = "variables";

/**
 * Slice a session's messages down to what the model actually sees after
 * context compaction: everything after the summary anchor. The dedupe below
 * must compare against blocks the model can still see — a block that was
 * summarized away no longer counts as "already injected".
 */
export function visibleMessagesAfterSummary<T extends { id?: string }>(
	messages: ReadonlyArray<T>,
	summaryUpToMessageId: string | undefined,
): ReadonlyArray<T> {
	if (!summaryUpToMessageId) return messages;
	const anchor = messages.findIndex(
		(message) => message.id === summaryUpToMessageId,
	);
	return anchor === -1 ? messages : messages.slice(anchor + 1);
}

export class TurnContextLedger {
	/**
	 * A legacy whole-block string read as a delta. Kept as a static so both
	 * readers (the diff here, the replay in the app's history builder) agree on
	 * one interpretation.
	 */
	static fromLegacy(contextUpdate: string): TurnContextDelta {
		return { set: { [LEGACY_TURN_CONTEXT_SECTION_ID]: contextUpdate } };
	}

	/** The delta a history message carries, whichever field holds it. */
	static deltaOf(message: TurnContextCarrier): TurnContextDelta | undefined {
		if (message.turnContext) return message.turnContext;
		const legacy = message.contextUpdate;
		return typeof legacy === "string" && legacy
			? TurnContextLedger.fromLegacy(legacy)
			: undefined;
	}

	/**
	 * Fold the visible history into "what the model currently believes": section
	 * id → the bytes it last saw. Later messages win; a `removed` tombstone
	 * drops the entry so the same content can be delivered again later.
	 */
	private deliveredState(
		visible: ReadonlyArray<TurnContextCarrier>,
	): Map<string, string> {
		const state = new Map<string, string>();
		for (const message of visible) {
			const delta = TurnContextLedger.deltaOf(message);
			if (!delta) continue;
			for (const [id, content] of Object.entries(delta.set ?? {})) {
				state.set(id, content);
			}
			for (const id of delta.removed ?? []) state.delete(id);
		}
		return state;
	}

	/**
	 * Per-block dedupe against the visible history. Returns the sections that
	 * have to travel this turn, or `undefined` when nothing changed (no block is
	 * attached at all in that case — history stays append-only and the cache
	 * prefix intact).
	 */
	diff(
		visible: ReadonlyArray<TurnContextCarrier>,
		blocks: readonly TurnBlock[],
	): TurnContextDelta | undefined {
		const delivered = this.deliveredState(visible);
		const set: Record<string, string> = {};
		const present = new Set<string>();

		for (const block of blocks) {
			const content = block.content?.trim();
			if (!content) continue;
			present.add(block.id);
			if (delivered.get(block.id) !== content) set[block.id] = content;
		}
		const removed = [...delivered.keys()].filter((id) => !present.has(id));

		const hasSet = Object.keys(set).length > 0;
		if (!hasSet && removed.length === 0) return undefined;
		return {
			...(hasSet ? { set } : {}),
			...(removed.length > 0 ? { removed } : {}),
		};
	}

	/**
	 * Apply a delta to **built** message content — a plain string, or the
	 * multimodal parts array the history builder produced. This is the one
	 * placement rule both routes share (the first build's attach and every later
	 * build's replay), so they agree by construction: string → appended; parts
	 * whose first part is text → rendered into that part; parts that do not
	 * start with text (attachment-only message) → a new first text part.
	 * Returns the input untouched when the delta has nothing to say.
	 */
	applyTo<TContent>(content: TContent, delta: TurnContextDelta): TContent {
		if (typeof content === "string") {
			return this.render(content, delta) as unknown as TContent;
		}
		if (!Array.isArray(content)) return content;
		const body = this.renderBody(delta);
		if (!body) return content;
		const out = [...content] as unknown[];
		const first = out[0] as { type?: string; text?: unknown } | undefined;
		if (first?.type === "text" && typeof first.text === "string") {
			out[0] = { ...first, text: renderContextUpdateBlock(first.text, body) };
		} else {
			out.unshift({ type: "text", text: renderContextUpdateBlock("", body) });
		}
		return out as unknown as TContent;
	}

	/**
	 * Render a persisted delta into model-facing message content. Byte-stable:
	 * a rebuild replays the stored delta and produces the same string.
	 */
	render(content: string, delta: TurnContextDelta): string {
		const body = this.renderBody(delta);
		return body ? renderContextUpdateBlock(content, body) : content;
	}

	/** The `<context-update>` body: sections in delivery order, tombstones last. */
	private renderBody(delta: TurnContextDelta): string {
		const lines: string[] = [];
		for (const [id, sectionContent] of Object.entries(delta.set ?? {})) {
			lines.push(`<section name="${id}">`, sectionContent, "</section>");
		}
		for (const id of delta.removed ?? []) {
			lines.push(`<section name="${id}" removed="true"/>`);
		}
		return lines.join("\n");
	}
}

/**
 * Render a turn-context body into model-facing message content. Must stay
 * byte-stable: legacy messages (a bare `contextUpdate` string) replay through
 * this function exactly as they did before the block gained sections.
 */
export function renderContextUpdateBlock(content: string, body: string): string {
	return `${content}\n\n<context-update>\n${body}\n</context-update>`;
}
