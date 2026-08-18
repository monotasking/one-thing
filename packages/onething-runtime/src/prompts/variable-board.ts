/**
 * The variable board as an ordinary prompt source.
 *
 * The board used to be wired straight into the stream engine: `handleSendMessage`
 * asked a `variables` adapter for one string, deduped it whole, and stapled it
 * onto the user message. That was a second opinion on "what does this turn have
 * to tell the model", computed from different material than the prompt itself,
 * and it was the only tenant of the `<context-update>` channel.
 *
 * Here it is just a source that contributes one `turn` fragment. The composer
 * treats it like every other contributor, and `TurnContextLedger` dedupes it
 * per block — so the board re-sends only when a value actually moves, and it
 * shares the block with todo, skills, AGENTS.md and the rest.
 *
 * The rendered text is untouched: the section body is byte-for-byte what the
 * engine used to attach.
 */
import {
	type CoreBuildPromptContextOptions,
	type CorePromptFragment,
} from "@onething/core/engine";
import type { PromptSource } from "./composer.js";

/** The one thing this source needs: text for a session's board. */
export interface VariableBoardRenderer {
	render(sessionId: string): Promise<string> | string;
}

/** The section id the board occupies in the turn block. */
export const VARIABLE_BOARD_SECTION_ID = "variables";

/** Sorted first inside the turn block, as it was the only block before. */
export const VARIABLE_BOARD_ORDER = 0;

export class VariableBoardSource implements PromptSource {
	readonly name = "variables";

	constructor(private readonly board: VariableBoardRenderer) {}

	async collect(
		ctx: CoreBuildPromptContextOptions,
	): Promise<CorePromptFragment[]> {
		// No session = no board (evals, prompt-version hashing, snapshots of a
		// hypothetical prompt): the board is a per-session fact by definition.
		if (!ctx.sessionId) return [];
		const text = (await this.board.render(ctx.sessionId))?.trim();
		if (!text) return [];
		return [
			{
				id: VARIABLE_BOARD_SECTION_ID,
				slot: "section",
				channel: "turn",
				source: "variables",
				order: VARIABLE_BOARD_ORDER,
				content: text,
			},
		];
	}
}
