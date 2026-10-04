/**
 * Incident bundle tests (workbench W1): complete scene persistence,
 * turn-trace extraction with REAL tool results, template cover rendering,
 * and read/update round-trips.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
	createIncidentBundle,
	extractTurnTrace,
	listIncidents,
	readIncident,
	updateIncident,
	readIncidentTurnTrace,
	getIncidentDir,
} from "../eval-incident.js";
import type { CorePromptCapture } from "@onething/backend/agent-loop";
import { hashSections } from "../eval-section-hash.js";

let tmpDir: string;
let storeOptions: { storePath: string };

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-incident-"));
	storeOptions = { storePath: tmpDir };
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeCapture(): CorePromptCapture {
	const sections = [
		{ name: "system", content: "You are a bot." },
		{ name: "known-projects", content: "# Known Projects\n- transreader" },
	];
	return {
		systemPrompt: sections.map((s) => s.content).join("\n\n"),
		sections,
		sectionHashes: hashSections(sections).sectionHashes,
		requestMessages: [
			{ role: "user", content: "帮我改 transreader 的超时" },
		] as CorePromptCapture["requestMessages"],
		rawRequest: {
			model: "deepseek-v4-pro",
			systemPrompt: "…",
			messages: [],
			tools: [
				{
					type: "function",
					function: {
						name: "edit",
						description: "Edit a file",
						parameters: { type: "object", properties: { path: {} } },
					},
				},
			],
			temperature: 0.7,
			maxTokens: 2048,
		},
	};
}

describe("createIncidentBundle", () => {
	it("persists the complete scene: prompt/context/tools/params/trace/fixture", () => {
		const result = createIncidentBundle({
			origin: "downvote",
			note: "应该先切到 transreader 目录",
			sessionId: "sess-1",
			turnId: "msg-abcdef12",
			provider: "deepseek",
			model: "deepseek-v4-pro",
			userMessage: "帮我改 transreader 的超时",
			assistantText: "我直接改了 start-electron 里的文件",
			promptCapture: makeCapture(),
			turnTrace: [
				{
					content: "我来修改配置",
					toolCalls: [
						{
							name: "edit",
							args: { path: "/wrong/config.ts" },
							result: "edited 3 lines",
							status: "completed",
						},
					],
				},
			],
			fixtureContext: {
				workingDirectory: "/repo/start-electron",
				skills: [],
				toolNames: ["edit", "read"],
				hasTools: true,
				platform: "darwin",
			},
			explicitDown: true,
			storeOptions,
		});

		const dir = result.incidentDir;
		expect(result.meta.scene).toEqual({
			prompt: true,
			context: true,
			tools: true,
			params: true,
			turnTrace: true,
			fixture: true,
		});

		// scene/tools.json carries the REAL tool schema
		const tools = JSON.parse(
			fs.readFileSync(path.join(dir, "scene", "tools.json"), "utf-8"),
		);
		expect(tools.tools[0].function.name).toBe("edit");
		expect(tools.tools[0].function.parameters.properties).toBeDefined();

		// scene/params.json carries the call params
		const params = JSON.parse(
			fs.readFileSync(path.join(dir, "scene", "params.json"), "utf-8"),
		);
		expect(params.model).toBe("deepseek-v4-pro");
		expect(params.temperature).toBe(0.7);

		// turn-trace keeps the REAL tool result (the mock replay tape)
		const trace = readIncidentTurnTrace(result.incidentId, storeOptions);
		expect(trace[0].toolCalls[0].result).toBe("edited 3 lines");

		// The human cover answers "what happened / what was expected"
		const md = fs.readFileSync(path.join(dir, "incident.md"), "utf-8");
		expect(md).toContain("帮我改 transreader 的超时");
		expect(md).toContain("应该先切到 transreader 目录");
		expect(md).toContain("edit(");
	});

	it("lists and updates incidents", () => {
		const { incidentId } = createIncidentBundle({
			origin: "auto",
			sessionId: "s",
			turnId: "turn-1234",
			provider: "deepseek",
			model: "m",
			userMessage: "hello",
			promptCapture: makeCapture(),
			storeOptions,
		});

		const listed = listIncidents({ storeOptions });
		expect(listed).toHaveLength(1);
		expect(listed[0].id).toBe(incidentId);
		expect(listed[0].status).toBe("new");

		const updated = updateIncident(
			incidentId,
			{ status: "diagnosed", rubric: "应先切目录" },
			storeOptions,
		);
		expect(updated?.status).toBe("diagnosed");
		expect(readIncident(incidentId, storeOptions)?.rubric).toBe("应先切目录");
	});

	it("resolves incident dir defensively against path escape", () => {
		const dir = getIncidentDir("../../etc/passwd", storeOptions);
		expect(dir).not.toContain("..");
	});
});

describe("extractTurnTrace", () => {
	const messages = [
		{ id: "u1", role: "user", content: "第一问" },
		{ id: "a1", role: "assistant", content: "第一答" },
		{ id: "u2", role: "user", content: "改超时" },
		{
			id: "a2",
			role: "assistant",
			content: "改好了",
			toolCalls: [
				{ toolName: "edit", arguments: { path: "x" }, result: "ok", status: "completed" },
			],
		},
	];

	it("extracts the turn's assistant block by turnId with tool results", () => {
		const trace = extractTurnTrace(messages, "a2");
		expect(trace).toHaveLength(1);
		expect(trace[0].content).toBe("改好了");
		expect(trace[0].toolCalls[0]).toMatchObject({
			name: "edit",
			result: "ok",
		});
	});

	it("does not leak earlier turns into the trace", () => {
		const trace = extractTurnTrace(messages, "a2");
		expect(trace.some((e) => e.content === "第一答")).toBe(false);
	});

	it("falls back to the trailing assistant block without turnId", () => {
		const trace = extractTurnTrace(messages);
		expect(trace[0].content).toBe("改好了");
	});
});
