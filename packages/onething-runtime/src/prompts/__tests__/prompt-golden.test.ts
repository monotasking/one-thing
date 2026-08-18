import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { TurnBlock } from "@onething/core/engine";
import { buildOnethingSystemPrompt, buildOnethingPrompt } from "../builder.js";
import { testPromptComposer } from "./fixtures/tool-prompts.js";
import {
	scenarios,
	type SegmentId,
	SEGMENTS,
	estimateTokens,
} from "./fixtures/scenarios.js";
import {
	initPromptVersion,
	getPromptVersion,
	computeStaticPromptVersion,
} from "../../evals/fixture.js";

const GOLDEN_DIR = path.resolve(__dirname, "golden");
const BUDGET_PATH = path.join(GOLDEN_DIR, "_budget.json");

interface SegmentBudget {
	chars: number;
	estimatedTokens: number;
}

interface SceneBudget {
	totalChars: number;
	totalTokens: number;
	segments: Partial<Record<SegmentId, SegmentBudget>>;
}

type BudgetMap = Record<string, SceneBudget>;

/**
 * Rough segmentation of the prompt by known section headers.
 * Each regex targets a known section from the builder output.
 */
function segmentPrompt(prompt: string): Partial<Record<SegmentId, string>> {
	const result: Partial<Record<SegmentId, string>> = {};

	const patterns: Array<{ id: SegmentId; pattern: RegExp }> = [
		{
			id: "agent",
			pattern:
				/# Agent: [^\n]+\n[\s\S]*?(?=\n# |\n## |\n<project_context>|\n<available_skills>|$)/,
		},
		{ id: "voice", pattern: /## Voice Speak Mode[\s\S]*?(?=\n# |$)/ },
		{
			id: "runtime-context",
			pattern: /# Runtime Context[\s\S]*?(?=\n# [^R]|$)/,
		},
		{ id: "workdir", pattern: /# Work Directory[\s\S]*?(?=\n# |$)/ },
		{ id: "active-project", pattern: /# Active Project[\s\S]*?(?=\n# [^A]|$)/ },
		{ id: "known-projects", pattern: /# Known Projects[\s\S]*?(?=\n# [^K]|$)/ },
		{ id: "skills", pattern: /# Skills[\s\S]*?(?=\n# [^S]|$)/ },
		{
			id: "os",
			pattern:
				/You are running on (?:macOS|Windows|Linux)[\s\S]*?(?=\n# |\n<project_context>|$)/,
		},
		{
			id: "agents-md",
			pattern: /<project_context>[\s\S]*?<\/project_context>/,
		},
		{
			id: "context-variables",
			pattern: /<context-variables>[\s\S]*?(?:<\/context-variables>|$)/,
		},
		{ id: "plugins", pattern: /# Plugins[\s\S]*$/ },
	];

	for (const { id, pattern } of patterns) {
		const match = prompt.match(pattern);
		if (match) {
			result[id] = match[0];
		}
	}

	// core = everything before first agent/voice/workdir/active-project section
	const coreEnd = Math.min(
		prompt.indexOf("\n# Agent:") === -1
			? Infinity
			: prompt.indexOf("\n# Agent:"),
		prompt.indexOf("\n## Voice Speak Mode") === -1
			? Infinity
			: prompt.indexOf("\n## Voice Speak Mode"),
		prompt.indexOf("\n# Work Directory") === -1
			? Infinity
			: prompt.indexOf("\n# Work Directory"),
		prompt.indexOf("\n# Active Project") === -1
			? Infinity
			: prompt.indexOf("\n# Active Project"),
		prompt.indexOf("\n# Runtime Context") === -1
			? Infinity
			: prompt.indexOf("\n# Runtime Context"),
	);
	if (coreEnd < Infinity) {
		result.core = prompt.slice(0, coreEnd).trimEnd();
	} else {
		result.core = prompt;
	}

	return result;
}

function computeBudget(_sceneName: string, prompt: string): SceneBudget {
	const segments = segmentPrompt(prompt);
	const segmentBudgets: Partial<Record<SegmentId, SegmentBudget>> = {};

	for (const segId of SEGMENTS) {
		const segText = segments[segId];
		if (segText) {
			segmentBudgets[segId] = {
				chars: segText.length,
				estimatedTokens: estimateTokens(segText.length),
			};
		}
	}

	return {
		totalChars: prompt.length,
		totalTokens: estimateTokens(prompt.length),
		segments: segmentBudgets,
	};
}

/**
 * The turn-channel appendix (prompt-channels 2026-08-18). The scenes have to
 * keep capturing the WHOLE picture: half the product's sections now travel in
 * the `<context-update>` tail of the user message instead of the system prefix,
 * and a golden file that only showed the prefix would silently stop covering
 * them. The appendix is not what the model receives verbatim — the ledger wraps
 * each block in `<section name="…">` and only sends the ones that changed — but
 * it is the exact content each block carries this turn.
 */
function turnAppendix(turn: TurnBlock[]): string {
	if (turn.length === 0) return "";
	return [
		"--- turn ---",
		...turn.map((block) => `## ${block.id}\n${block.content}`),
	].join("\n\n");
}

async function buildGoldenForScene(name: string): Promise<string> {
	const sceneList = scenarios();
	const scene = sceneList.find((s) => s.name === name);
	if (!scene) throw new Error(`Unknown scene: ${name}`);

	// The scenes go through the same composer shape the desktop uses (builtin
	// + tool prompts + registry + plugins), so the snapshot is what gets sent.
	// For codex scene, use buildOnethingPrompt with separate developer messages
	if (name === "codex-split") {
		const result = await buildOnethingPrompt({
			...scene.ctx,
			providerId: "codex",
			model: "gpt-5-codex",
			historyMessages: [{ role: "user", content: "hello" }],
		}, testPromptComposer);
		return [result.systemPrompt, turnAppendix(result.turn ?? [])]
			.filter(Boolean)
			.join("\n\n");
	}

	const result = await buildOnethingSystemPrompt(scene.ctx, testPromptComposer);
	return [result.system, ...result.developer, turnAppendix(result.turn)]
		.filter(Boolean)
		.join("\n\n");
}

describe("prompt golden snapshots", () => {
	const sceneList = scenarios();

	for (const scene of sceneList) {
		it(`matches golden snapshot for "${scene.name}"`, async () => {
			const prompt = await buildGoldenForScene(scene.name);
			await expect(prompt).toMatchFileSnapshot(
				path.join(GOLDEN_DIR, `${scene.name}.md`),
			);
		});
	}

	it("computes and saves budget snapshot", async () => {
		const budgetMap: BudgetMap = {};

		for (const scene of sceneList) {
			const prompt = await buildGoldenForScene(scene.name);
			budgetMap[scene.name] = computeBudget(scene.name, prompt);
		}

		fs.mkdirSync(GOLDEN_DIR, { recursive: true });
		fs.writeFileSync(BUDGET_PATH, JSON.stringify(budgetMap, null, 2), "utf-8");

		// Assert total token budget for desktop-full
		const desktopFull = budgetMap["desktop-full"];
		const MAX_TOTAL_TOKENS = 3000;
		expect(
			desktopFull.totalTokens,
			`desktop-full total tokens ${desktopFull.totalTokens} exceeds limit ${MAX_TOTAL_TOKENS}`,
		).toBeLessThanOrEqual(MAX_TOTAL_TOKENS);

		// Assert single segment doesn't exceed quota (skills should be reasonable)
		const skillsTokens = desktopFull.segments.skills?.estimatedTokens ?? 0;
		const MAX_SKILLS_TOKENS = 800;
		expect(
			skillsTokens,
			`skills segment tokens ${skillsTokens} exceeds limit ${MAX_SKILLS_TOKENS}`,
		).toBeLessThan(MAX_SKILLS_TOKENS);
	});

	it("initializes promptVersion from minimal scene output (design G1)", async () => {
		const minimalPrompt = await buildGoldenForScene("minimal");
		initPromptVersion(minimalPrompt);
		const version = getPromptVersion();

		// Version should be 8 hex chars
		expect(version).toMatch(/^[a-f0-9]{8}$/);

		// Static fallback should differ (different hash source)
		const staticVersion = computeStaticPromptVersion();
		expect(staticVersion).toMatch(/^[a-f0-9]{8}$/);

		// Re-initialize with same content should give same version
		initPromptVersion(minimalPrompt);
		expect(getPromptVersion()).toBe(version);
	});

	it("returns named sections from buildOnethingPrompt (S1: sections exposure)", async () => {
		const sceneList = scenarios();
		const scene = sceneList.find((s) => s.name === "desktop-full");
		if (!scene) throw new Error("desktop-full scene not found");

		const result = await buildOnethingPrompt({
			...scene.ctx,
			providerId: "openai",
			model: "gpt-4o",
			historyMessages: [{ role: "user", content: "hello" }],
		});

		// Sections must be present and non-empty
		expect(result.sections).toBeDefined();
		expect(result.sections!.length).toBeGreaterThan(0);

		// Verify known section names are present
		const sectionNames = result.sections!.map((s) => s.name);
		expect(sectionNames).toContain("system");

		// Verify each section has content
		for (const section of result.sections!) {
			expect(section.content.length).toBeGreaterThan(0);
		}

		// Verify sections produce stable hashes
		const { hashSections } = await import("../../evals/section-hash.js");
		const hashes1 = hashSections(result.sections!);
		const hashes2 = hashSections(result.sections!);
		expect(hashes1.promptVersion).toBe(hashes2.promptVersion);
		expect(hashes1.promptVersion).toMatch(/^[a-f0-9]{8}$/);

		// Section hashes should differ across sections
		const uniqueHashes = new Set(Object.values(hashes1.sectionHashes));
		expect(uniqueHashes.size).toBeGreaterThan(1);
	});
});
