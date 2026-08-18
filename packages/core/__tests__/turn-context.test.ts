import { describe, expect, it } from "vitest";
import {
	LEGACY_TURN_CONTEXT_SECTION_ID,
	TurnContextLedger,
	renderContextUpdateBlock,
	visibleMessagesAfterSummary,
	type TurnBlock,
	type TurnContextCarrier,
} from "../engine/turn-context.js";

const ledger = new TurnContextLedger();

function blocks(...pairs: Array<[string, string]>): TurnBlock[] {
	return pairs.map(([id, content]) => ({ id, content }));
}

describe("TurnContextLedger.diff — per block, not per board", () => {
	it("sends every block on the first turn", () => {
		expect(ledger.diff([], blocks(["variables", "a"], ["todo", "b"]))).toEqual({
			set: { variables: "a", todo: "b" },
		});
	});

	it("sends only the block whose bytes moved", () => {
		const history: TurnContextCarrier[] = [
			{ turnContext: { set: { variables: "a", todo: "b", "agents-md": "big" } } },
		];
		expect(
			ledger.diff(
				history,
				blocks(["variables", "a2"], ["todo", "b"], ["agents-md", "big"]),
			),
		).toEqual({ set: { variables: "a2" } });
	});

	it("attaches nothing when no block changed", () => {
		const history: TurnContextCarrier[] = [
			{ turnContext: { set: { variables: "a" } } },
		];
		expect(ledger.diff(history, blocks(["variables", "a"]))).toBeUndefined();
	});

	it("ignores empty blocks and trims", () => {
		expect(ledger.diff([], blocks(["variables", "   \n"]))).toBeUndefined();
		expect(ledger.diff([], blocks(["variables", " a \n"]))).toEqual({
			set: { variables: "a" },
		});
	});

	it("reads the latest version of a block, not the first", () => {
		const history: TurnContextCarrier[] = [
			{ turnContext: { set: { variables: "old" } } },
			{},
			{ turnContext: { set: { variables: "new" } } },
		];
		expect(ledger.diff(history, blocks(["variables", "new"]))).toBeUndefined();
		expect(ledger.diff(history, blocks(["variables", "old"]))).toEqual({
			set: { variables: "old" },
		});
	});
});

describe("TurnContextLedger.diff — tombstones", () => {
	it("emits `removed` for a block that was present and is now absent", () => {
		const history: TurnContextCarrier[] = [
			{ turnContext: { set: { variables: "a", voice: "speak" } } },
		];
		expect(ledger.diff(history, blocks(["variables", "a"]))).toEqual({
			removed: ["voice"],
		});
	});

	it("a removed block can be delivered again later", () => {
		const history: TurnContextCarrier[] = [
			{ turnContext: { set: { voice: "speak" } } },
			{ turnContext: { removed: ["voice"] } },
		];
		expect(ledger.diff(history, blocks(["voice", "speak"]))).toEqual({
			set: { voice: "speak" },
		});
	});

	it("mixes set and removed in one delta", () => {
		const history: TurnContextCarrier[] = [
			{ turnContext: { set: { variables: "a", voice: "speak" } } },
		];
		expect(ledger.diff(history, blocks(["variables", "b"]))).toEqual({
			set: { variables: "b" },
			removed: ["voice"],
		});
	});
});

describe("TurnContextLedger — legacy compatibility", () => {
	it("reads a bare contextUpdate string as the variables section", () => {
		expect(TurnContextLedger.fromLegacy("- datetime: 10:00")).toEqual({
			set: { [LEGACY_TURN_CONTEXT_SECTION_ID]: "- datetime: 10:00" },
		});
	});

	it("does not re-send a board an old session already delivered", () => {
		const history: TurnContextCarrier[] = [
			{ contextUpdate: "- datetime: 10:00" },
		];
		expect(
			ledger.diff(history, blocks(["variables", "- datetime: 10:00"])),
		).toBeUndefined();
		expect(
			ledger.diff(history, blocks(["variables", "- datetime: 11:00"])),
		).toEqual({ set: { variables: "- datetime: 11:00" } });
	});

	it("prefers the structured field when a message carries both", () => {
		expect(
			TurnContextLedger.deltaOf({
				contextUpdate: "legacy",
				turnContext: { set: { todo: "t" } },
			}),
		).toEqual({ set: { todo: "t" } });
	});
});

describe("TurnContextLedger.render", () => {
	it("wraps each section, byte-stable", () => {
		expect(
			ledger.render("hello", { set: { variables: "<var/>", todo: "# Todo" } }),
		).toBe(
			'hello\n\n<context-update>\n<section name="variables">\n<var/>\n</section>\n<section name="todo">\n# Todo\n</section>\n</context-update>',
		);
	});

	it("renders a tombstone as a self-closing section", () => {
		expect(ledger.render("hi", { removed: ["voice"] })).toBe(
			'hi\n\n<context-update>\n<section name="voice" removed="true"/>\n</context-update>',
		);
	});

	it("leaves the content alone for an empty delta", () => {
		expect(ledger.render("hi", {})).toBe("hi");
	});

	it("replays identically for the same delta", () => {
		const delta = { set: { variables: "a" }, removed: ["voice"] };
		expect(ledger.render("x", delta)).toBe(ledger.render("x", delta));
	});
});

describe("renderContextUpdateBlock — the legacy replay path", () => {
	it("renders a legacy string exactly as it always did (no <section> wrapper)", () => {
		expect(renderContextUpdateBlock("hello", "- datetime: 10:00")).toBe(
			"hello\n\n<context-update>\n- datetime: 10:00\n</context-update>",
		);
	});
});

describe("visibleMessagesAfterSummary", () => {
	const messages = [
		{ id: "m1", turnContext: { set: { variables: "main" } } },
		{ id: "m2" },
		{ id: "m3", turnContext: { set: { variables: "feature/x" } } },
		{ id: "m4" },
	];

	it("returns everything when there is no summary anchor", () => {
		expect(visibleMessagesAfterSummary(messages, undefined)).toEqual(messages);
		expect(visibleMessagesAfterSummary(messages, "missing")).toEqual(messages);
	});

	it("drops messages the model no longer sees after compaction", () => {
		expect(visibleMessagesAfterSummary(messages, "m3")).toEqual([{ id: "m4" }]);
	});

	it("re-injects a block that was summarized away", () => {
		const visible = visibleMessagesAfterSummary(messages, "m3");
		expect(ledger.diff(visible, blocks(["variables", "feature/x"]))).toEqual({
			set: { variables: "feature/x" },
		});
		// Without compaction the same block would be deduped away.
		expect(
			ledger.diff(messages, blocks(["variables", "feature/x"])),
		).toBeUndefined();
	});
});
