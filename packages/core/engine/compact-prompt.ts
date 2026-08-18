import compactRaw from "./content/compact.md?raw";
import compactUpdateRaw from "./content/compact-update.md?raw";

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
): string {
	const instructions = normalize(
		previousSummary ? compactUpdateRaw : compactRaw,
	);
	const parts = [`<conversation>\n${messages}\n</conversation>`];
	if (previousSummary) {
		parts.push(`<previous-summary>\n${previousSummary}\n</previous-summary>`);
	}
	parts.push(instructions);
	return parts.join("\n\n");
}
