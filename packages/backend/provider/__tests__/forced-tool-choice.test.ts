/**
 * W18b/W22 强制首调用 — the provider half of the 透传链.
 *
 * `initialToolChoice` is only worth anything if it survives all the way onto
 * the wire, in the dialect the endpoint actually speaks, and ONLY on the opening
 * call. DeepSeek is the load-bearing case (自测房跑的就是它), so it is driven
 * end-to-end through the real agent loop with a fake fetch and the request
 * bodies are read back; the others are checked at their mapping boundary
 * because their dialects differ, and a provider that never declared the
 * capability must come out of the loop unchanged.
 *
 * W22 moved the room drive from `'required'` (some tool, model's pick) to a
 * NAMED choice (`say`). Every dialect spells that differently — nested under
 * `function` for Chat Completions, flat for the Responses API, `{type:'tool'}`
 * for Anthropic, `ANY` + `allowedFunctionNames` for Gemini — so each one gets
 * its own assertion. Both forms are covered: 'required' is still the shape a
 * caller may hand in.
 */
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "@onething/backend/agent-loop/agent-loop-primitives";
import type { AgentProvider, AgentTool } from "@onething/backend/agent-loop/agent-loop-primitives";
import { createClaudeAgentProvider } from "../vendors/claude/claude-agent-provider.js";
import { toCodexToolChoice } from "../vendors/codex/codex-agent-provider.js";
import { createDeepSeekAgentProvider } from "../vendors/deepseek/deepseek-agent-provider.js";
import { createGeminiAgentProvider } from "../vendors/gemini/gemini-agent-provider.js";

function sseResponse(dataLines: string[]): Response {
	return new Response(
		[...dataLines.map((line) => `data: ${line}`), "data: [DONE]", ""].join("\n\n"),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

const TOOL_CALL_CHUNK = JSON.stringify({
	choices: [
		{
			delta: {
				tool_calls: [
					{
						index: 0,
						id: "call_1",
						type: "function",
						function: { name: "say", arguments: '{"content":"来了"}' },
					},
				],
			},
			finish_reason: "tool_calls",
		},
	],
});

const TEXT_CHUNK = JSON.stringify({
	choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
});

const sayTool: AgentTool = {
	name: "say",
	parameters: { type: "object" },
	async execute() {
		return { content: "已发进群里。" };
	},
};

/** The named choice the collab room drive actually sends since W22. */
const FORCED_SAY = { type: "function", function: { name: "say" } } as const;

/** Every request body the loop pushed at the endpoint, in order. */
async function runDeepSeekLoop(
	initialToolChoice?: "required" | typeof FORCED_SAY,
	thinking?: "enabled",
): Promise<Array<Record<string, unknown>>> {
	const bodies: Array<Record<string, unknown>> = [];
	let call = 0;
	const provider = createDeepSeekAgentProvider({
		apiKey: "test-key",
		fetchImpl: async (_url, init) => {
			bodies.push(JSON.parse(String((init as RequestInit).body)));
			call += 1;
			return sseResponse([call === 1 ? TOOL_CALL_CHUNK : TEXT_CHUNK]);
		},
	});

	await runAgentLoop({
		provider,
		model: "deepseek-chat",
		messages: [{ role: "user", content: "群里有人叫你" }],
		tools: [sayTool],
		sessionId: "session-1",
		messageId: "message-1",
		maxTurns: 3,
		...(initialToolChoice ? { initialToolChoice } : {}),
		...(thinking ? { thinking, reasoningEffort: "high" as const } : {}),
	});

	return bodies;
}

describe("deepseek — forced opening call lands on the wire", () => {
	it("sends the NAMED say choice on the FIRST request and auto afterwards (W22)", async () => {
		const bodies = await runDeepSeekLoop(FORCED_SAY);

		expect(bodies).toHaveLength(2);
		// The OpenAI Chat Completions dialect nests the name under `function`.
		// A flattened `{type:'function',name:'say'}` is a 400 here, and a
		// stringified 'required' silently gives the model back its choice of
		// tool — the door the 77-call incident walked through.
		expect(bodies[0]?.tool_choice).toEqual({
			type: "function",
			function: { name: "say" },
		});
		expect(bodies[1]?.tool_choice).toBe("auto");
	});

	it("keeps thinking off for a NAMED forced run too — pairing is by forced-ness", async () => {
		// The 配对规则 is written against "is this run forced", not against the
		// literal 'required'. A rule that pattern-matched the string would send
		// thinking:enabled with a named choice and reproduce 真机 400 #1.
		const bodies = await runDeepSeekLoop(FORCED_SAY, "enabled");

		expect(bodies.map((body) => body.thinking)).toEqual([
			{ type: "disabled" },
			{ type: "disabled" },
		]);
		expect(bodies.map((body) => body.reasoning_effort)).toEqual([
			undefined,
			undefined,
		]);
	});

	it("sends tool_choice 'required' on the FIRST request and auto afterwards", async () => {
		const bodies = await runDeepSeekLoop("required");

		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.tool_choice).toBe("required");
		// The mutation this locks: a standing 'required' would oblige round 2 to
		// call another tool, and the loop could never reach a tool-less round —
		// the run would only ever stop at maxTurns.
		expect(bodies[1]?.tool_choice).toBe("auto");
	});

	it("keeps thinking off for the whole run, not just the forced call (两个真机 400)", async () => {
		// 400 #1 — on the forced call itself:
		//   `Thinking mode does not support this tool_choice`
		// 400 #2 — on the round after it, if thinking is restored:
		//   `The reasoning_content in the thinking mode must be passed back to
		//    the API.`
		// The forced round wrote its tool-call message with reasoning off, so
		// there is no reasoning_content for round 2 to replay. One run, one
		// mode. reasoning_effort travels with it — the deepseek body writes it
		// from `request.reasoningEffort` on a line of its own.
		const bodies = await runDeepSeekLoop("required", "enabled");

		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toMatchObject({ tool_choice: "required" });
		expect(bodies[0]?.thinking).toEqual({ type: "disabled" });
		expect(bodies[0]?.reasoning_effort).toBeUndefined();

		// Round 2 is no longer forced — and still un-thinking. MUTATION LOCK on
		// the SCOPE: a per-request rule passes the first three assertions and
		// fails right here, which is exactly how 真机 failed.
		expect(bodies[1]).toMatchObject({ tool_choice: "auto" });
		expect(bodies[1]?.thinking).toEqual({ type: "disabled" });
		expect(bodies[1]?.reasoning_effort).toBeUndefined();
	});

	it("leaves an unforced thinking run entirely alone (对照)", async () => {
		const bodies = await runDeepSeekLoop(undefined, "enabled");

		expect(bodies.map((body) => body.thinking)).toEqual([
			{ type: "enabled" },
			{ type: "enabled" },
		]);
		expect(bodies.map((body) => body.reasoning_effort)).toEqual(["high", "high"]);
		expect(bodies.map((body) => body.tool_choice)).toEqual(["auto", "auto"]);
	});

	it("sends nothing new when the caller does not ask for it", async () => {
		const bodies = await runDeepSeekLoop();

		expect(bodies.map((body) => body.tool_choice)).toEqual(["auto", "auto"]);
	});
});

describe("per-provider dialects for 'required'", () => {
	async function claudeBody(
		toolChoice: "required" | typeof FORCED_SAY,
	): Promise<Record<string, unknown> | undefined> {
		let body: Record<string, unknown> | undefined;
		const provider = createClaudeAgentProvider({
			apiKey: "test-key",
			fetchImpl: async (_url, init) => {
				body = JSON.parse(String((init as RequestInit).body));
				return sseResponse([]);
			},
		});

		for await (const _event of provider.streamTurn!({
			turn: 1,
			model: "claude-test",
			messages: [{ role: "user", content: "hi" }],
			tools: [sayTool],
			toolChoice,
		})) {
			// drain
		}
		return body;
	}

	it("claude sends tool_choice { type: 'any' }", async () => {
		expect((await claudeBody("required"))?.tool_choice).toEqual({ type: "any" });
	});

	it("claude names it { type: 'tool', name } (W22)", async () => {
		expect((await claudeBody(FORCED_SAY))?.tool_choice).toEqual({
			type: "tool",
			name: "say",
		});
	});

	async function geminiBody(
		toolChoice: "required" | typeof FORCED_SAY,
	): Promise<Record<string, unknown> | undefined> {
		let body: Record<string, unknown> | undefined;
		const provider = createGeminiAgentProvider({
			apiKey: "test-key",
			fetchImpl: async (_url, init) => {
				body = JSON.parse(String((init as RequestInit).body));
				return sseResponse([]);
			},
		});

		for await (const _event of provider.streamTurn!({
			turn: 1,
			model: "gemini-test",
			messages: [{ role: "user", content: "hi" }],
			tools: [sayTool],
			toolChoice,
		})) {
			// drain
		}
		return body;
	}

	it("gemini sends functionCallingConfig ANY with no name narrowing", async () => {
		// ANY + allowedFunctionNames is how a SPECIFIC tool is forced; the
		// unnarrowed ANY is "some tool, your pick".
		expect((await geminiBody("required"))?.toolConfig).toEqual({
			functionCallingConfig: { mode: "ANY" },
		});
	});

	it("gemini narrows ANY with allowedFunctionNames (W22)", async () => {
		expect((await geminiBody(FORCED_SAY))?.toolConfig).toEqual({
			functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["say"] },
		});
	});

	it("codex flattens the name — Responses API dialect (W22)", async () => {
		// Chat Completions nests under `function`; the Responses API does not.
		// Passing the nested shape through unchanged is a 400.
		expect(toCodexToolChoice(FORCED_SAY)).toEqual({
			type: "function",
			name: "say",
		});
		expect(toCodexToolChoice("required")).toBe("required");
		expect(toCodexToolChoice(undefined)).toBe("auto");
	});
});

describe("capability declarations", () => {
	async function capabilitiesOf(provider: AgentProvider) {
		return provider.getModelCapabilities?.("m") ?? provider.capabilities;
	}

	it("deepseek / claude / gemini all advertise forced tool use", async () => {
		const providers = [
			createDeepSeekAgentProvider({ apiKey: "k", fetchImpl: async () => sseResponse([]) }),
			createClaudeAgentProvider({ apiKey: "k", fetchImpl: async () => sseResponse([]) }),
			createGeminiAgentProvider({ apiKey: "k", fetchImpl: async () => sseResponse([]) }),
		];

		for (const provider of providers) {
			expect((await capabilitiesOf(provider))?.supportsForcedToolUse).toBe(true);
		}
	});
});
