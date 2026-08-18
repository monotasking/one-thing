/**
 * PromptComposer — the one object that turns prompt sources into a system prompt.
 *
 * A **source** is anything that can answer "what fragments do you have for this
 * build?" (`PromptSource.collect`). The composer holds an ordered list of them
 * and does the only work that is nobody else's: filter (disabled? gated by the
 * turn's tool surface? `when`?), sort (order, then source order), render, and
 * place each fragment in its slot. It never names a tool, a plugin or a
 * feature; it does not know what a source is behind the interface.
 *
 * Who is a source (all implement `PromptSource`):
 * - `builtinPromptSource` (`builder.ts`) — the product's own section table;
 * - `OnethingToolRegistry` (`tools/registry.ts`) — the prompt the tools **on
 *   the turn's surface** declared next to their definitions;
 * - `PromptFragmentRegistry` (`fragments.ts`) — what runtime features / hosts
 *   registered, with disposers;
 * - `PluginPromptContextSource` (`plugin-context.ts`) — plugin providers,
 *   with timeout + breaker callbacks the host injects.
 *
 * Which sources a host wires is the host's decision (`app/engine/prompt/`
 * builds the desktop composer; `builder.ts` exports a default one without
 * tools for callers that have no registry). Tests build a composer with a
 * `StaticPromptSource` instead of poking fragments through the context.
 */
import {
	CORE_PROMPT_ORDER_TOOL,
	corePromptToolSurface,
	isCorePromptFragmentActive,
	renderCorePromptFragment,
	type CoreBuildPromptContextOptions,
	type CoreBuildPromptOptions,
	type CoreBuildPromptResult,
	type CorePromptFragment,
	type PromptSection,
	type TurnBlock,
} from "@onething/core/engine";

export interface PromptSource {
	/** Diagnostics only (which source said what); never branched on. */
	readonly name: string;
	collect(
		ctx: CoreBuildPromptContextOptions,
	): readonly CorePromptFragment[] | Promise<readonly CorePromptFragment[]>;
}

/** A source over a fixed list — tests, evals, one-off hosts. */
export class StaticPromptSource implements PromptSource {
	constructor(
		readonly name: string,
		private readonly fragments: readonly CorePromptFragment[],
	) {}

	collect(): readonly CorePromptFragment[] {
		return this.fragments;
	}
}

/**
 * The two composite blocks that are not fragments of their own but can still be
 * switched off by name through `disabledSections`: the `Tool Guidelines:` list
 * inside the core system block, and the `## Tool Workspace Rules` section.
 * Bullets for both come from fragments (mostly tools).
 */
export const PROMPT_BLOCK_TOOL_GUIDELINES = "tool-guidelines";
export const PROMPT_BLOCK_TOOL_WORKSPACE_RULES = "tool-workspace-rules";

/**
 * Where the `## Tool Workspace Rules` block sits among the sections. It used to
 * be appended to the tail of `# Work Directory`; that section moved to the turn
 * channel (the path is a session fact) while the rules themselves are static
 * ("read/edit/write/bash resolve against the current work directory"), so they
 * became a system section of their own at the position the workdir section had.
 */
const WORKSPACE_RULES_ORDER = 500;

export interface ComposedPrompt {
	system: string;
	developer: string[];
	sections: PromptSection[];
	/**
	 * Blocks for the turn channel: delivered in the `<context-update>` tail of
	 * the latest user message, deduped per block by `TurnContextLedger`. Never
	 * part of `system` / `developer` / `sections`.
	 */
	turn: TurnBlock[];
}

interface RenderedFragment {
	fragment: CorePromptFragment;
	text: string;
}

/**
 * The slots, with the section slot split by channel: a `section` fragment that
 * declared `channel: 'turn'` never reaches the system prefix.
 */
type BucketId = CorePromptFragment["slot"] | "turn";
type SlotBuckets = Record<BucketId, RenderedFragment[]>;

export class PromptComposer {
	private readonly sources: readonly PromptSource[];

	constructor(sources: readonly PromptSource[]) {
		this.sources = sources;
	}

	/** A new composer with more sources appended (the original is untouched). */
	with(...sources: PromptSource[]): PromptComposer {
		return new PromptComposer([...this.sources, ...sources]);
	}

	get sourceNames(): string[] {
		return this.sources.map((source) => source.name);
	}

	/** system block + developer sections + turn blocks, ready to be delivered. */
	async compose(ctx: CoreBuildPromptContextOptions): Promise<ComposedPrompt> {
		const fragments = await this.collectAll(ctx);
		const bySlot = this.resolve(ctx, fragments);

		const system = coreSystemBlock(ctx, bullets(bySlot.guidelines));

		const developer: string[] = [];
		const sections: PromptSection[] = [{ name: "system", content: system }];
		const sectionIndex = new Map<string, number>();
		for (const { fragment, text } of this.systemSections(bySlot)) {
			developer.push(text);
			// Same-named sections merge into one named section for snapshots /
			// hashing; developer messages stay separate — the historical shape.
			const at = sectionIndex.get(fragment.id);
			if (at === undefined) {
				sectionIndex.set(fragment.id, sections.length);
				sections.push({ name: fragment.id, content: text });
			} else {
				sections[at] = {
					name: fragment.id,
					content: `${sections[at].content}\n\n${text}`,
				};
			}
		}

		// Turn blocks: same merge rule, but the id is the ledger's dedupe key —
		// two fragments sharing one id are one block that changes together.
		const turn: TurnBlock[] = [];
		const turnIndex = new Map<string, number>();
		for (const { fragment, text } of bySlot.turn) {
			const at = turnIndex.get(fragment.id);
			if (at === undefined) {
				turnIndex.set(fragment.id, turn.length);
				turn.push({ id: fragment.id, content: text });
			} else {
				turn[at] = {
					id: fragment.id,
					content: `${turn[at].content}\n\n${text}`,
				};
			}
		}

		return { system, developer, sections, turn };
	}

	/**
	 * The system-channel sections in order, with the synthetic
	 * `## Tool Workspace Rules` section spliced in at its historical position.
	 * It is not a fragment of its own: the bullets come from whichever tools are
	 * on the surface, so the block exists only when at least one of them spoke.
	 */
	private systemSections(bySlot: SlotBuckets): RenderedFragment[] {
		const workspaceRules = bullets(bySlot["workspace-rules"]);
		if (workspaceRules.length === 0) return bySlot.section;
		const block: RenderedFragment = {
			fragment: {
				id: PROMPT_BLOCK_TOOL_WORKSPACE_RULES,
				slot: "section",
				source: "builtin",
				order: WORKSPACE_RULES_ORDER,
				content: "",
			},
			text: ["## Tool Workspace Rules", ...workspaceRules].join("\n"),
		};
		const at = bySlot.section.findIndex(
			(entry) => (entry.fragment.order ?? CORE_PROMPT_ORDER_TOOL) > WORKSPACE_RULES_ORDER,
		);
		const out = [...bySlot.section];
		out.splice(at === -1 ? out.length : at, 0, block);
		return out;
	}

	/** Full request messages: merged system, or system + developer split. */
	async build(options: CoreBuildPromptOptions): Promise<CoreBuildPromptResult> {
		const { system, developer, sections, turn } = await this.compose(options);
		const systemPrompt = [system, ...developer].filter(Boolean).join("\n\n");

		if (options.separateDeveloperMessages) {
			return {
				messages: [
					{ role: "system", content: system },
					...developer.map((content) => ({
						role: "developer" as const,
						content,
					})),
					...options.historyMessages,
				],
				systemPrompt,
				sections,
				turn,
			};
		}
		return {
			messages: [
				{ role: "system", content: systemPrompt },
				...options.historyMessages,
			],
			systemPrompt,
			sections,
			turn,
		};
	}

	private async collectAll(
		ctx: CoreBuildPromptContextOptions,
	): Promise<CorePromptFragment[]> {
		const out: CorePromptFragment[] = [];
		// Sequential on purpose: source order is the tie-breaker inside a slot,
		// and the plugin source is the only async one (it has its own timeout).
		for (const source of this.sources) out.push(...(await source.collect(ctx)));
		return out;
	}

	/**
	 * Filter → sort → render → bucket by slot. `disabledSections` matches
	 * fragment ids (a section name or a bullet id) and the two block names.
	 */
	private resolve(
		ctx: CoreBuildPromptContextOptions,
		fragments: readonly CorePromptFragment[],
	): SlotBuckets {
		const disabled = new Set(ctx.disabledSections ?? []);
		if (disabled.has(PROMPT_BLOCK_TOOL_GUIDELINES)) disabled.add("guidelines");
		if (disabled.has(PROMPT_BLOCK_TOOL_WORKSPACE_RULES))
			disabled.add("workspace-rules");
		const surface = corePromptToolSurface(ctx);
		const bySlot: SlotBuckets = {
			guidelines: [],
			"workspace-rules": [],
			section: [],
			turn: [],
		};

		// Stable sort by order; ties keep source/insertion order. No order =
		// "after the builtin table" (CORE_PROMPT_ORDER_TOOL), never "first".
		const orderOf = (fragment: CorePromptFragment) =>
			fragment.order ?? CORE_PROMPT_ORDER_TOOL;
		const ordered = fragments
			.map((fragment, index) => ({ fragment, index }))
			.sort(
				(a, b) =>
					orderOf(a.fragment) - orderOf(b.fragment) || a.index - b.index,
			);

		for (const { fragment } of ordered) {
			if (disabled.has(fragment.id) || disabled.has(fragment.slot)) continue;
			// A group name switches off a whole family at once — plugin providers
			// carry per-provider ids so they dedupe separately, yet
			// `disabledSections: ['plugins']` must still silence all of them.
			if (fragment.group && disabled.has(fragment.group)) continue;
			if (!isCorePromptFragmentActive(fragment, ctx, surface)) continue;
			const text = renderCorePromptFragment(fragment, ctx);
			if (!text) continue;
			// Only sections have a channel; a bullet is a standing rule.
			const bucket: BucketId =
				fragment.slot === "section" && fragment.channel === "turn"
					? "turn"
					: fragment.slot;
			bySlot[bucket].push({ fragment, text });
		}
		return bySlot;
	}
}

/** Bullets: dedupe identical text (two tools may state the same rule). */
function bullets(items: RenderedFragment[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const { text } of items) {
		if (seen.has(text)) continue;
		seen.add(text);
		out.push(text.startsWith("- ") ? text : `- ${text}`);
	}
	return out;
}

/** The core system block: persona + guideline bullets. Constant per agent. */
function coreSystemBlock(
	ctx: CoreBuildPromptContextOptions,
	guidelines: string[],
): string {
	const baseSystemPrompt =
		ctx.baseSystemPrompt?.trim() ||
		"You are an AI assistant. Help users by reading context, using available tools, and producing clear, useful answers.";
	// No `Current date:` line: it changed every day and took the whole static
	// prefix (and the KV cache behind it) with it, while the `datetime` variable
	// on the board already gives the model the date at hour granularity.
	return [
		baseSystemPrompt,
		...(guidelines.length ? ["", "Tool Guidelines:", ...guidelines] : []),
	].join("\n");
}
