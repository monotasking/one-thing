import { createTwoFilesPatch } from "diff";
import { basenamePath } from "@onething/backend/storage";

/**
 * Edit failures are read by a model *and* by a one-line UI row. Both need the
 * same shape: a short first line that names the failure category and the file,
 * then the detail (full path, retry guidance, closest-match snippet) from the
 * second line on. The collapsed tool row shows only the first line, so it must
 * stay inside one row's width.
 */
const EDIT_FAILURE_FIRST_LINE_MAX = 80;

export function editFailureError(firstLine: string, detail: string): Error {
	const head =
		firstLine.length > EDIT_FAILURE_FIRST_LINE_MAX
			? `${firstLine.slice(0, EDIT_FAILURE_FIRST_LINE_MAX - 1)}…`
			: firstLine;
	return new Error(detail ? `${head}\n${detail}` : head);
}

export interface ExactEdit {
	oldText: string;
	newText: string;
	replaceAll?: boolean;
}

export interface ExactEditApplyResult {
	baseContent: string;
	newContent: string;
}

export interface ExactEditPreviewContentResult extends ExactEditApplyResult {
	finalContent: string;
	bom: string;
	lineEnding: "\r\n" | "\n";
}

export interface ExactEditPreviewResult extends ExactEditPreviewContentResult {
	diff: string;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

interface TextMatch {
	matchIndex: number;
	matchLength: number;
	matchedText: string;
	strategy: "exact" | "line-trim";
}

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(
	text: string,
	ending: "\r\n" | "\n",
): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF")
		? { bom: "\uFEFF", text: content.slice(1) }
		: { bom: "", text: content };
}

function findExactMatches(content: string, oldText: string): TextMatch[] {
	if (!oldText) return [];
	const matches: TextMatch[] = [];
	let index = 0;
	while (true) {
		const next = content.indexOf(oldText, index);
		if (next === -1) return matches;
		matches.push({
			matchIndex: next,
			matchLength: oldText.length,
			matchedText: oldText,
			strategy: "exact",
		});
		index = next + oldText.length;
	}
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildLineTrimPattern(oldText: string): RegExp | null {
	const withoutOuterBlankLines = oldText.replace(/^\n+|\n+$/g, "");
	const lines = withoutOuterBlankLines.split("\n");
	if (!lines.some((line) => line.trim())) return null;

	const linePatterns = lines.map((line) => {
		const trimmed = line.trim();
		return trimmed ? `[ \\t]*${escapeRegExp(trimmed)}[ \\t]*` : "[ \\t]*";
	});

	return new RegExp(`^${linePatterns.join("\\n")}(?=\\n|$)`, "gm");
}

function findLineTrimMatches(content: string, oldText: string): TextMatch[] {
	const pattern = buildLineTrimPattern(oldText);
	if (!pattern) return [];

	const matches: TextMatch[] = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(content)) !== null) {
		if (match[0].length === 0) {
			pattern.lastIndex++;
			continue;
		}
		matches.push({
			matchIndex: match.index,
			matchLength: match[0].length,
			matchedText: match[0],
			strategy: "line-trim",
		});
	}
	return matches;
}

function firstNonEmptyIndent(text: string): string {
	const line = text.split("\n").find((item) => item.trim().length > 0);
	return line?.match(/^[ \t]*/)?.[0] ?? "";
}

function applyMatchedIndent(
	newText: string,
	oldText: string,
	matchedText: string,
): string {
	const oldIndent = firstNonEmptyIndent(oldText);
	const matchedIndent = firstNonEmptyIndent(matchedText);
	const newIndent = firstNonEmptyIndent(newText);

	if (matchedIndent === oldIndent || newIndent === matchedIndent) {
		return newText;
	}

	return newText
		.split("\n")
		.map((line) => {
			if (!line.trim()) return line;
			if (oldIndent && line.startsWith(oldIndent)) {
				return matchedIndent + line.slice(oldIndent.length);
			}
			if (!oldIndent) {
				return matchedIndent + line;
			}
			return matchedIndent + line.trimStart();
		})
		.join("\n");
}

function findReplacementMatches(content: string, oldText: string): TextMatch[] {
	const exactMatches = findExactMatches(content, oldText);
	return exactMatches.length > 0
		? exactMatches
		: findLineTrimMatches(content, oldText);
}

function getEmptyOldTextError(
	filePath: string,
	editIndex: number,
	totalEdits: number,
): Error {
	const base = basenamePath(filePath);
	return totalEdits === 1
		? editFailureError(
				`Edit failed: empty oldText in ${base}.`,
				`oldText must not be empty in ${filePath}.`,
			)
		: editFailureError(
				`Edit failed: empty oldText in edits[${editIndex}] of ${base}.`,
				`edits[${editIndex}].oldText must not be empty in ${filePath}. No changes were written to the file.`,
			);
}

function characterBigrams(text: string): Set<string> {
	const grams = new Set<string>();
	for (let i = 0; i < text.length - 1; i++) grams.add(text.slice(i, i + 2));
	return grams;
}

function diceSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	const gramsA = characterBigrams(a);
	const gramsB = characterBigrams(b);
	let shared = 0;
	for (const gram of gramsA) if (gramsB.has(gram)) shared++;
	return (2 * shared) / (gramsA.size + gramsB.size);
}

const CLOSEST_MATCH_MIN_SCORE = 0.4;
const CLOSEST_MATCH_MAX_SNIPPET_CHARS = 2400;

/**
 * When oldText matches nothing, locate the region of the file that most
 * resembles it and return a line-numbered snippet. The failure message then
 * carries the *current* text of the likely target, so the model can retry
 * with real content instead of guessing again from stale memory (the
 * observed failure spiral: stale oldText → edit fails → bash/python fallback
 * → file drifts further).
 */
export function findClosestRegionSnippet(
	content: string,
	oldText: string,
): string | null {
	const contentLines = content.split("\n");
	const anchorLines = normalizeToLF(oldText)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length >= 4)
		.slice(0, 5);
	if (anchorLines.length === 0) return null;

	let bestScore = 0;
	let bestLine = -1;
	for (let i = 0; i < contentLines.length; i++) {
		const line = contentLines[i].trim();
		if (!line) continue;
		for (const anchor of anchorLines) {
			let score: number;
			if (line === anchor) score = 1;
			else if (line.includes(anchor) || anchor.includes(line)) score = 0.9;
			else score = diceSimilarity(line, anchor);
			if (score > bestScore) {
				bestScore = score;
				bestLine = i;
			}
		}
		if (bestScore === 1) break;
	}
	if (bestLine === -1 || bestScore < CLOSEST_MATCH_MIN_SCORE) return null;

	const halfWindow = Math.min(
		12,
		Math.max(4, Math.ceil(oldText.split("\n").length / 2) + 2),
	);
	const start = Math.max(0, bestLine - halfWindow);
	const end = Math.min(contentLines.length, bestLine + halfWindow + 1);
	const numbered: string[] = [];
	for (let i = start; i < end; i++)
		numbered.push(`${i + 1}→${contentLines[i]}`);
	let snippet = numbered.join("\n");
	if (snippet.length > CLOSEST_MATCH_MAX_SNIPPET_CHARS) {
		snippet = `${snippet.slice(0, CLOSEST_MATCH_MAX_SNIPPET_CHARS)}\n…`;
	}
	return `Closest match in the current file (lines ${start + 1}-${end}):\n${snippet}`;
}

function getNotFoundError(
	filePath: string,
	editIndex: number,
	totalEdits: number,
	content?: string,
	oldText?: string,
): Error {
	const fileName = basenamePath(filePath);
	const firstLine =
		totalEdits === 1
			? `Edit failed: target text not found in ${fileName}.`
			: `Edit failed: edits[${editIndex}] target text not found in ${fileName}.`;
	const snippet =
		content !== undefined && oldText !== undefined
			? findClosestRegionSnippet(content, oldText)
			: null;
	const atomicity =
		totalEdits > 1 ? "No changes were written to the file. " : "";
	const guidance =
		totalEdits === 1
			? `Re-read ${fileName} and use its current text as oldText.`
			: `${atomicity}Re-read ${fileName} and fix edits[${editIndex}].oldText with the current file content, then retry all ${totalEdits} edits together.`;
	const detail = snippet
		? `${snippet}\n\n${guidance}`
		: `${guidance}\nThe file at ${filePath} no longer contains the text you tried to replace.`;
	return editFailureError(firstLine, detail);
}

function getDuplicateError(
	filePath: string,
	editIndex: number,
	totalEdits: number,
	occurrences: number,
): Error {
	const fileName = basenamePath(filePath);
	const hint =
		"The text must be unique. Provide more surrounding context to narrow it to one match, or set replaceAll: true to replace every occurrence.";
	return totalEdits === 1
		? editFailureError(
				`Edit failed: text matches ${occurrences} places in ${fileName}.`,
				`Found ${occurrences} occurrences of the text in ${filePath}. ${hint}`,
			)
		: editFailureError(
				`Edit failed: edits[${editIndex}] matches ${occurrences} places in ${fileName}.`,
				`Found ${occurrences} occurrences of edits[${editIndex}] in ${filePath}. No changes were written to the file. ${hint}`,
			);
}

function getNoChangeError(filePath: string, totalEdits: number): Error {
	const fileName = basenamePath(filePath);
	const atomicity =
		totalEdits > 1 ? "No changes were written to the file. " : "";
	return editFailureError(
		`Edit failed: replacement produced no change in ${fileName}.`,
		totalEdits === 1
			? `The oldText and newText produced identical file content in ${filePath}. Verify both values.`
			: `${atomicity}The edits produced identical file content in ${filePath}. Verify each oldText/newText pair.`,
	);
}

/**
 * Apply one or more exact replacements to LF-normalized content.
 *
 * Each edit is matched against the original content, not incrementally. All
 * oldText values must be non-empty and non-overlapping. An oldText must occur
 * exactly once unless the edit sets replaceAll, in which case every occurrence
 * is replaced.
 */
export function applyExactEditsToNormalizedContent(
	normalizedContent: string,
	edits: ExactEdit[],
	filePath: string,
): ExactEditApplyResult {
	if (!Array.isArray(edits) || edits.length === 0) {
		throw editFailureError(
			`Edit failed: no replacements provided for ${basenamePath(filePath)}.`,
			"Edit input is invalid. edits must contain at least one replacement.",
		);
	}

	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
		replaceAll: edit.replaceAll === true,
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(filePath, i, normalizedEdits.length);
		}
	}

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matches = findReplacementMatches(normalizedContent, edit.oldText);
		if (matches.length === 0) {
			throw getNotFoundError(
				filePath,
				i,
				normalizedEdits.length,
				normalizedContent,
				edit.oldText,
			);
		}
		if (matches.length > 1 && !edit.replaceAll) {
			throw getDuplicateError(
				filePath,
				i,
				normalizedEdits.length,
				matches.length,
			);
		}

		for (const match of matches) {
			matchedEdits.push({
				editIndex: i,
				matchIndex: match.matchIndex,
				matchLength: match.matchLength,
				newText:
					match.strategy === "line-trim"
						? applyMatchedIndent(edit.newText, edit.oldText, match.matchedText)
						: edit.newText,
			});
		}
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw editFailureError(
				`Edit failed: edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${basenamePath(filePath)}.`,
				`The matched regions for edits[${previous.editIndex}] and edits[${current.editIndex}] overlap. No changes were written to the file. Merge both changes into a single edit or target non-overlapping portions of the file.`,
			);
		}
	}

	let newContent = normalizedContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		newContent =
			newContent.slice(0, edit.matchIndex) +
			edit.newText +
			newContent.slice(edit.matchIndex + edit.matchLength);
	}

	if (newContent === normalizedContent) {
		throw getNoChangeError(filePath, normalizedEdits.length);
	}

	return { baseContent: normalizedContent, newContent };
}

export function prepareExactEditPreview(
	rawContent: string,
	edits: ExactEdit[],
	filePath: string,
): ExactEditPreviewContentResult {
	const { bom, text } = stripBom(rawContent);
	const lineEnding = detectLineEnding(text);
	const normalizedContent = normalizeToLF(text);
	const { baseContent, newContent } = applyExactEditsToNormalizedContent(
		normalizedContent,
		edits,
		filePath,
	);
	const finalContent = bom + restoreLineEndings(newContent, lineEnding);
	return { baseContent, newContent, finalContent, bom, lineEnding };
}

export function previewExactEdits(
	rawContent: string,
	edits: ExactEdit[],
	filePath: string,
): ExactEditPreviewResult {
	const preview = prepareExactEditPreview(rawContent, edits, filePath);
	const diff = createTwoFilesPatch(
		filePath,
		filePath,
		preview.baseContent,
		preview.newContent,
	);
	return { ...preview, diff };
}
