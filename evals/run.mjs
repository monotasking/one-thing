#!/usr/bin/env bun

/**
 * Evals Runner (CLI Shell)
 *
 * Thin CLI shell that delegates to the shared runner core in
 * packages/backend/runtime/evals/runner.ts.
 *
 * CLI uses an OpenAI-compatible fetch as the model caller;
 * the desktop app injects its own provider-stack caller via IPC.
 *
 * Usage: bun evals/run.mjs [--case <id>] [--runs <k>] [--disable <section>]
 *
 * Configuration via environment variables:
 *   EVALS_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY  - API key
 *   EVALS_BASE_URL  - Base URL (default: https://api.deepseek.com)
 *   EVALS_MODEL     - Model name (default: deepseek-v4-pro)
 */

import { parseArgs } from "node:util";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(__dirname, "..");

function getConfig() {
	return {
		apiKey:
			process.env.EVALS_API_KEY ||
			process.env.DEEPSEEK_API_KEY ||
			process.env.OPENAI_API_KEY ||
			"",
		baseUrl: process.env.EVALS_BASE_URL || "https://api.deepseek.com",
		model: process.env.EVALS_MODEL || "deepseek-v4-pro",
	};
}

async function main() {
	const { values } = parseArgs({
		options: {
			case: { type: "string", short: "c" },
			runs: { type: "string", short: "r", default: "3" },
			disable: { type: "string", multiple: true, default: [] },
			full: { type: "boolean", default: false },
		},
	});

	const numRuns = Math.min(parseInt(values.runs, 10) || 3, 10);
	const filterId = values.case || null;
	const disabledSections = Array.isArray(values.disable)
		? values.disable
		: [values.disable].filter(Boolean);
	const includeSentinel = values.full;

	const config = getConfig();
	console.log(`\nEvals Runner (CLI → runner.ts)`);
	console.log(`Model: ${config.model} | Base URL: ${config.baseUrl}`);
	console.log(`Runs per case: ${numRuns}`);
	if (!config.apiKey) {
		console.error(
			`⚠️  No API key configured ($EVALS_API_KEY / $DEEPSEEK_API_KEY / $OPENAI_API_KEY) — aborting before any model call`,
		);
		process.exit(1);
	}

	// Build injected model caller (OpenAI-compatible fetch)
	const callModel = async (opts) => {
		const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;

		const body = {
			model: config.model,
			messages: opts.messages.map((m) => {
				// Full tool-calling protocol so agent-loop replay is faithful
				if (m.role === "tool") {
					return {
						role: "tool",
						tool_call_id: m.toolCallId,
						content: m.content,
					};
				}
				const base = {
					role: m.role === "developer" ? "system" : m.role,
					content: m.content,
				};
				if (m.role === "assistant" && m.toolCalls?.length) {
					base.tool_calls = m.toolCalls.map((tc) => ({
						id: tc.id,
						type: "function",
						function: { name: tc.name, arguments: tc.argsJson },
					}));
				}
				return base;
			}),
			max_tokens: opts.maxTokens ?? 2048,
		};

		// Mirror the production deepseek rule: thinking-enabled requests carry
		// thinking/reasoning_effort and OMIT temperature.
		if (opts.thinking) {
			body.thinking = { type: opts.thinking };
			if (opts.thinking === "enabled" && opts.reasoningEffort) {
				body.reasoning_effort = opts.reasoningEffort;
			}
		}
		if (opts.thinking !== "enabled") {
			body.temperature = opts.temperature ?? 0;
		}

		if (opts.tools && opts.tools.length > 0) {
			body.tools = opts.tools.map((t) => ({
				type: "function",
				function: {
					name: t.name,
					description: t.description || "",
					parameters: t.parameters || { type: "object", properties: {} },
				},
			}));
			body.tool_choice = "auto";
		}

		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${config.apiKey}`,
			},
			body: JSON.stringify(body),
			signal: opts.signal,
		});

		if (!response.ok) {
			const text = await response.text();
			throw new Error(`API error ${response.status}: ${text.slice(0, 200)}`);
		}

		const data = await response.json();
		const choice = data.choices?.[0];
		if (!choice) throw new Error("No choices in response");

		const message = choice.message || {};
		return {
			content: message.content || "",
			toolCalls: (message.tool_calls || []).map((tc) => ({
				id: tc.id,
				name: tc.function?.name || "unknown",
				args: (() => {
					try {
						return JSON.parse(tc.function?.arguments || "{}");
					} catch {
						return {};
					}
				})(),
			})),
			finishReason: choice.finish_reason || "stop",
		};
	};

	const { runEvals } = await import("@onething/backend/runtime");

	const entry = await runEvals({
		repoDir: REPO_DIR,
		caseIds: filterId ? [filterId] : undefined,
		runs: numRuns,
		disabledSections,
		includeSentinel,
		callModel,
		providerLabel: "cli",
		modelLabel: config.model,
		onProgress: (event) => {
			if (event.type === "case-start") {
				console.log(`\n[${event.caseId}]`);
			} else if (event.type === "attempt-done") {
				const icon = event.pass ? "PASS" : "FAIL";
				console.log(`  [${icon}] ${event.caseId}: ${event.reason}`);
			} else if (event.type === "case-done") {
				const pct = ((event.score ?? 0) * 100).toFixed(0);
				const icon =
					event.score === 1
						? "\u2705"
						: event.score && event.score >= 0.8
							? "\u26A0\uFE0F"
							: "\u274C";
				console.log(`  ${icon} Score: ${pct}%`);
			} else if (event.type === "run-done") {
				const meanPct = ((event.entry?.mean ?? 0) * 100).toFixed(0);
				console.log(`\n---`);
				console.log(
					`Active mean: ${meanPct}% (${event.entry?.evalSetSize} cases)`,
				);
				if (event.entry?.sentinelScores) {
					console.log(
						`Sentinel: ${Object.keys(event.entry.sentinelScores).join(", ")}`,
					);
				}
			} else if (event.type === "error") {
				console.error(`Error: ${event.error}`);
			}
		},
	});

	// Comparison with previous run
	const resultsPath = join(REPO_DIR, "evals", "results.jsonl");
	const { existsSync, readFileSync } = await import("node:fs");
	if (existsSync(resultsPath)) {
		const content = readFileSync(resultsPath, "utf-8").trim();
		if (content) {
			const history = content
				.split("\n")
				.filter(Boolean)
				.map((l) => {
					try {
						return JSON.parse(l);
					} catch {
						return null;
					}
				})
				.filter((h) => h !== null);
			if (history.length >= 2) {
				const prev = history[history.length - 2];
				console.log(`\nComparison vs. previous run:`);
				for (const [id, score] of Object.entries(entry.scores)) {
					const prevScore = prev.scores?.[id];
					if (prevScore !== undefined) {
						const delta = score - prevScore;
						const arrow =
							delta > 0 ? "\u2191" : delta < 0 ? "\u2193" : "\u2192";
						const sign = delta > 0 ? "+" : "";
						console.log(
							`  ${id}: ${prevScore.toFixed(2)} \u2192 ${score.toFixed(2)} ${arrow}${sign}${delta.toFixed(2)}`,
						);
					}
				}
			}
		}
	}
}

main().catch(console.error);
