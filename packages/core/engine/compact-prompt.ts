import compactRaw from "./content/compact.md?raw";
import compactUpdateRaw from "./content/compact-update.md?raw";
import compactMergeRaw from "./content/compact-merge.md?raw";

// Normalize all trailing newlines so the .md file can have any number of
// trailing blank lines without changing the assembled prompt.
const normalize = (s: string) => s.replace(/\n+$/, "");

/**
 * C5(2026-08-14):**指令后置**。转录先进 `<conversation>`,已有摘要再进
 * `<previous-summary>`,指令块排在最后 —— 指令占 recency 位,长转录不再把它
 * 挤到注意力的另一头。有无 previousSummary 决定用 CREATE 还是 UPDATE 指令:
 * 两份规则不该塞进一份提示词里让模型自己挑。
 */
export function buildContextCompactPrompt(
	messages: string,
	previousSummary?: string,
	part?: ContextCompactPromptPart,
): string {
	const instructions = normalize(
		previousSummary ? compactUpdateRaw : compactRaw,
	);
	const parts: string[] = [];
	// 多块并行(2026-08-21):部分摘要必须知道自己只看到了一段,否则它会把
	// 一段中途截断的转录当成完整对话。**无 part 时输出与从前逐字相同**。
	if (part) {
		parts.push(
			`<part index="${part.index}" total="${part.total}">This is part ${part.index} of ${part.total} of one longer conversation. Summarize only what this part shows; work may be continued in other parts.</part>`,
		);
	}
	parts.push(`<conversation>\n${messages}\n</conversation>`);
	if (previousSummary) {
		parts.push(`<previous-summary>\n${previousSummary}\n</previous-summary>`);
	}
	parts.push(instructions);
	return parts.join("\n\n");
}

export interface ContextCompactPromptPart {
	index: number;
	total: number;
}

/**
 * map-reduce 的 reduce 那一半:把按块顺序给出的多份部分摘要合成一份独立成立
 * 的摘要。指令同样后置;有 `previousSummary` 时合并指令里额外套用 UPDATE 的
 * PRESERVE / 移动 / 重写 Next Steps 规则。
 */
export function buildContextCompactMergePrompt(
	partials: readonly string[],
	previousSummary?: string,
): string {
	const body = partials
		.map((partial, index) => `<part index="${index + 1}">\n${partial}\n</part>`)
		.join("\n");
	const parts = [`<partial-summaries>\n${body}\n</partial-summaries>`];
	if (previousSummary) {
		parts.push(`<previous-summary>\n${previousSummary}\n</previous-summary>`);
	}
	parts.push(normalize(compactMergeRaw));
	return parts.join("\n\n");
}
