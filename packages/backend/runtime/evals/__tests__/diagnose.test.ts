/**
 * Diagnosis orchestration test (workbench W5): a scripted model that only
 * behaves badly when the known-projects section is present must yield a
 * "section-implicated" conclusion via the ablation matrix, with report and
 * incident status persisted.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createIncidentBundle, readIncident } from "../incident.js";
import { diagnoseIncident } from "../diagnose.js";
import { hashSections } from "../section-hash.js";
import type { EvalModelCaller } from "../model-call.js";

let tmpDir: string;
let storeOptions: { storePath: string };

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-diagnose-"));
	storeOptions = { storePath: tmpDir };
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedIncident(): string {
	const sections = [
		{ name: "system", content: "You are a bot." },
		{ name: "known-projects", content: "# Known Projects\n- transreader" },
	];
	const { incidentId } = createIncidentBundle({
		origin: "downvote",
		note: "应该先切到 transreader 目录",
		sessionId: "sess-1",
		turnId: "turn-abc",
		provider: "eval",
		model: "mock-model",
		userMessage: "帮我改 transreader 的超时",
		assistantText: "直接改了当前目录的文件",
		promptCapture: {
			systemPrompt: sections.map((s) => s.content).join("\n\n"),
			sections,
			sectionHashes: hashSections(sections).sectionHashes,
			requestMessages: [
				{ role: "user", content: "帮我改 transreader 的超时" },
			] as never,
		},
		turnTrace: [
			{
				content: "直接改了当前目录的文件",
				toolCalls: [
					{ name: "edit", args: { path: "/wrong" }, result: "edited" },
				],
			},
		],
		fixtureContext: {
			workingDirectory: "/repo/start-electron",
			knownProjects: {
				hasAny: true,
				entries: [
					{
						path: "/repo/transreader",
						displayPath: "~/transreader",
						description: "translation app",
					},
				],
			},
			skills: [],
			toolNames: ["edit"],
			hasTools: true,
			platform: "darwin",
		} as never,
		storeOptions,
	});
	return incidentId;
}

/**
 * Replay model: behaves BADLY (echoes the wrong-dir behavior) when the
 * known-projects section is in the system prompt, GOOD otherwise —
 * so ablating known-projects flips the verdict.
 */
const replayModel: EvalModelCaller = async ({ messages }) => {
	// The whole request, not just the system message: `known-projects` moved to
	// the turn channel (prompt-channels 2026-08-18) and now arrives in the
	// `<context-update>` tail of the user message. Ablation is about whether
	// the model SAW the section, not about which message carried it.
	const request = messages.map((m) => m.content ?? "").join("\n");
	const bad = request.includes("Known Projects");
	return {
		content: bad ? "BAD: 直接在当前目录改" : "GOOD: 先切到 transreader 目录再改",
		toolCalls: [],
		finishReason: "stop",
	};
};

/** Judge model: passes iff the transcript contains GOOD behavior. */
const judgeModel: EvalModelCaller = async ({ messages }) => {
	const user = messages.find((m) => m.role === "user")?.content ?? "";
	const pass = user.includes("GOOD:");
	return {
		content: JSON.stringify({ pass, reason: pass ? "切了目录" : "没切目录" }),
		toolCalls: [],
		finishReason: "stop",
	};
};

describe("diagnoseIncident", () => {
	it("implicates the section whose ablation flips the verdict", async () => {
		const incidentId = seedIncident();

		const result = await diagnoseIncident({
			incidentId,
			callModel: replayModel,
			analysis: { callModel: judgeModel, model: "judge" },
			quick: true,
			storeOptions,
		});

		expect(result.conclusion).toBe("section-implicated");
		expect(result.implicatedSections).toEqual(["known-projects"]);
		// Baseline reproduces (all attempts fail with the section present)
		expect(result.reproduce.failures).toBe(result.reproduce.attempts);

		// Report persisted with the ablation matrix
		const report = fs.readFileSync(result.reportPath, "utf-8");
		expect(report).toContain("消融矩阵");
		expect(report).toContain("known-projects");

		// Incident status/diagnosis updated
		const incident = readIncident(incidentId, storeOptions);
		expect(incident?.status).toBe("diagnosed");
		expect(incident?.diagnosis?.conclusion).toBe("section-implicated");
	});

	it("concludes not-reproducible when the replay always satisfies the rubric", async () => {
		const incidentId = seedIncident();
		const alwaysGood: EvalModelCaller = async () => ({
			content: "GOOD: 先切到 transreader 目录再改",
			toolCalls: [],
			finishReason: "stop",
		});

		const result = await diagnoseIncident({
			incidentId,
			callModel: alwaysGood,
			analysis: { callModel: judgeModel, model: "judge" },
			quick: true,
			storeOptions,
		});

		expect(result.conclusion).toBe("not-reproducible");
		expect(readIncident(incidentId, storeOptions)?.status).toBe(
			"not-reproducible",
		);
	});
});
