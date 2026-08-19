/**
 * Case File Parser & Generator
 *
 * Hand-written mini-YAML parser/generator for eval case files.
 * The parser must match what evals/run.mjs's parseCaseFile() produces;
 * the generator must produce output that the parser can round-trip.
 *
 * Supported YAML subset:
 *   - `key: plain_value` (single-line scalar)
 *   - `key: "quoted string"` (double-quoted, \" escaping)
 *   - `key: >` (folded block scalar, indented continuation)
 *   - `key: |` (literal block scalar, indented continuation)
 *   - 2-space nesting for `expect` sub-keys
 *   - Comments starting with `# ` (preserved in generation)
 */

import fs from "node:fs";
import { KNOWN_EXPECT_KEYS } from "./evaluator.js";

import { getLogger } from '../logging/index.js'

const log = getLogger('evals')

export interface CaseDefinition {
	id: string;
	description: string;
	fixture: string;
	/** Optional context snapshot file (.context.jsonl) for multi-turn replay. */
	context?: string;
	userMessage: string;
	expect: Record<string, unknown>;
	/** Human-readable notes about the case (parsed from expect-block comments). */
	notes?: string;
	/** Scene bundle dir (relative to the case file) — runs via the replay engine. */
	scene?: string;
	/** Judgeable expectation for rubric judging (scene cases). */
	rubric?: string;
	/** Provenance: the incident this case was promoted from. */
	incidentRef?: string;
}

/**
 * Parse a single YAML case file into a CaseDefinition.
 * Matches the parser originally in evals/run.mjs.
 */
export function parseCaseFile(filePath: string): CaseDefinition {
	const content = fs.readFileSync(filePath, "utf-8");
	return parseCaseYaml(content);
}

/**
 * Parse case YAML content string.
 */
export function parseCaseYaml(content: string): CaseDefinition {
	const lines = content.split("\n");
	const result: Record<string, unknown> = { expect: {} };

	let key = "";
	let valueLines: string[] = [];
	let inBlock = false;
	let inExpect = false;
	let expectKey = "";
	const noteLines: string[] = [];

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Collect notes (comments) within the expect block
		if (inExpect && !inBlock && line.match(/^\s{2}#\s?(.*)/)) {
			const noteText = line.replace(/^\s{2}#\s?/, "");
			if (noteText) noteLines.push(noteText);
			continue;
		}

		// Skip top-level comments (not in expect block)
		if (!inBlock && !inExpect && line.startsWith("#") && !line.startsWith("# "))
			continue;

		if (!inBlock) {
			const m = line.match(/^(\w[\w-]*):\s*(.*)/);
			if (m) {
				key = m[1];
				const val = m[2].trim();
				if (val === ">" || val === "|") {
					inBlock = true;
					valueLines = [];
					inExpect = false;
				} else {
					if (key === "expect" && val === "") {
						inExpect = true;
					} else if (key === "context" && val !== "") {
						result[key] = parseScalar(val);
					} else {
						result[key] = parseScalar(val);
					}
				}
			} else if (inExpect) {
				const em = line.match(/^\s{2}(\w[\w-]*):\s*(.*)/);
				if (em) {
					expectKey = em[1];
					const ev = em[2].trim();
					if (ev === ">" || ev === "|") {
						valueLines = [];
						inBlock = true;
					} else {
						(result.expect as Record<string, unknown>)[expectKey] =
							parseScalar(ev);
					}
				}
			}
		} else {
			const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
			if (indent >= 2 || line.trim() === "") {
				valueLines.push(line.replace(/^\s{2}/, ""));
			} else {
				const val = valueLines.join("\n").trim();
				if (inExpect && expectKey) {
					(result.expect as Record<string, unknown>)[expectKey] = val;
				} else {
					result[key] = val;
				}
				inBlock = false;
				inExpect = false;
				i--; // Re-process this line as a new key
			}
		}
	}

	if (inBlock) {
		const val = valueLines.join("\n").trim();
		if (inExpect && expectKey) {
			(result.expect as Record<string, unknown>)[expectKey] = val;
		} else {
			result[key] = val;
		}
	}

	// Store collected notes
	if (noteLines.length > 0) {
		result.notes = noteLines.join("\n");
	}

	// Validate expect keys
	const expectObj = result.expect as Record<string, unknown>;
	for (const eKey of Object.keys(expectObj)) {
		if (eKey === "notes") continue;
		if (!KNOWN_EXPECT_KEYS.has(eKey)) {
			log.warn("case has unknown expect key", {
				caseId: result.id || "(unknown)",
				key: eKey,
			});
		}
	}

	return result as unknown as CaseDefinition;
}

/**
 * Parse a scalar value (strip double quotes if present).
 */
function parseScalar(val: string): string {
	if (val.startsWith('"') && val.endsWith('"')) {
		return val.slice(1, -1).replace(/\\"/g, '"');
	}
	return val;
}

/**
 * Generate YAML content from a CaseDefinition.
 * Produces output that can be round-tripped through parseCaseYaml().
 */
export function generateCaseYaml(def: CaseDefinition): string {
	let yaml = "";

	// id
	yaml += `# ${def.id} - ${def.description.split("\n")[0].slice(0, 80)}\n`;
	yaml += `id: ${def.id}\n`;

	// description (use folded block scalar for multi-line)
	if (def.description.includes("\n")) {
		yaml += `description: >\n`;
		for (const descLine of def.description.split("\n")) {
			yaml += `  ${descLine}\n`;
		}
	} else {
		yaml += `description: ${def.description}\n`;
	}

	// fixture
	yaml += `fixture: ${def.fixture}\n`;

	// context (multi-turn replay, optional)
	if (def.context) {
		yaml += `context: ${def.context}\n`;
	}

	// userMessage — the mini-parser is line-based, so a raw newline inside a
	// quoted scalar would corrupt the file; multi-line values must use a
	// block scalar (which the parser round-trips with newlines preserved).
	if (def.userMessage) {
		if (def.userMessage.includes("\n")) {
			yaml += `userMessage: >\n`;
			for (const msgLine of def.userMessage.split("\n")) {
				yaml += `  ${msgLine}\n`;
			}
		} else if (def.userMessage.includes('"')) {
			yaml += `userMessage: "${def.userMessage.replace(/"/g, '\\"')}"\n`;
		} else {
			yaml += `userMessage: "${def.userMessage}"\n`;
		}
	}

	// expect block
	yaml += `expect:\n`;
	const expectObj = def.expect as Record<string, unknown>;
	for (const [subKey, subVal] of Object.entries(expectObj)) {
		if (subKey === "notes") {
			// Notes are comments in the expect block
			if (typeof subVal === "string" && subVal.includes("\n")) {
				for (const noteLine of subVal.split("\n")) {
					yaml += `  # ${noteLine}\n`;
				}
			} else {
				yaml += `  # ${String(subVal)}\n`;
			}
			continue;
		}

		const valStr = String(subVal);
		if (valStr.includes("\n")) {
			yaml += `  ${subKey}: >\n`;
			for (const vLine of valStr.split("\n")) {
				yaml += `    ${vLine}\n`;
			}
		} else {
			yaml += `  ${subKey}: ${valStr}\n`;
		}
	}

	return yaml;
}
