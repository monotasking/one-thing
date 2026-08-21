import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createDefaultSettings,
	DEFAULT_CHAT_SETTINGS,
} from "@shared/defaults/settings.js";
import type {
	AppSettings,
	SkillDefinition,
	ToolDefinition,
	ToolSettings,
} from "@shared/ipc.js";
import type {
	AgentMessage,
	AgentProvider,
	AgentTool,
	AgentTurnRequest,
} from "@onething/core/agent-loop";
import type { JsonObject } from "@shared/json.js";
import { Catalog, Intent, Tool as ToolkitTool } from "@onething/core/toolkit";
import type { Result, ToolSpec } from "@onething/core/toolkit";
import { configureToolkitCatalog } from "@onething/runtime/toolkit";
import type { HistoryMessage } from "../message-helpers.js";
import type { BuildPromptOptions } from "../../prompt/system-prompt.js";
import type { StreamSender } from "../stream-processor.js";
import type {
	ProviderConfigWithKey,
	StreamExecutionParams,
} from "../stream-executor.js";

type RecordedAgentRequest = Omit<AgentTurnRequest, "messages"> & {
	messages: AgentMessage[];
};

function cloneAgentMessage(message: AgentMessage): AgentMessage {
	return { ...message };
}

function recordAgentRequest(request: AgentTurnRequest): RecordedAgentRequest {
	return {
		...request,
		messages: request.messages.map(cloneAgentMessage),
	};
}

function messageContents(
	request: RecordedAgentRequest,
): AgentMessage["content"][] {
	return request.messages.map((message) => message.content);
}

function testSender(): StreamSender {
	return {
		isDestroyed: () => false,
		send: mocks.senderSend,
	};
}

function testProviderConfig(
	overrides: Partial<ProviderConfigWithKey> = {},
): ProviderConfigWithKey {
	return {
		apiKey: "key",
		model: "test-model",
		selectedModels: ["test-model"],
		...overrides,
	};
}

function testSettings(enableToolCalls = false): AppSettings {
	const settings = createDefaultSettings();
	return {
		...settings,
		chat: {
			...DEFAULT_CHAT_SETTINGS,
			agentLoopStream: true,
		},
		skills: {
			enableSkills: false,
			skills: {},
		},
		tools: {
			...settings.tools,
			enableToolCalls,
			tools: {},
		},
	};
}

function testToolSettings(enableToolCalls = false): ToolSettings {
	return {
		enableToolCalls,
		tools: {},
	};
}


/**
 * R4b:这一回合模型看得见哪些内置工具,来源从旧的 `getEnabledToolsAsync` 换成
 * **目录**(`Surface.resolve`)。这个替身只填工具面要的那三格。
 */
class StubCatalogTool extends ToolkitTool<Record<string, never>, undefined> {
	readonly spec: ToolSpec;

	constructor(id: string, description: string, properties: Record<string, { type: string; description?: string }> = {}) {
		super();
		this.spec = {
			id,
			title: id,
			description,
			input: { type: "object", properties } as ToolSpec["input"],
			effects: [],
			presentation: { kind: "text", shell: "default" },
			concurrency: "parallel",
		};
	}

	async plan(): Promise<Intent<undefined>> {
		return Intent.none(undefined);
	}

	async apply(): Promise<Result> {
		return { content: [{ type: "text", text: "" }] };
	}
}

function useCatalogTools(...tools: StubCatalogTool[]): void {
	configureToolkitCatalog(new Catalog());
	const catalog = new Catalog();
	for (const tool of tools) catalog.register(tool);
	configureToolkitCatalog(catalog);
}

function settingsWithTools(tools: ToolSettings["tools"] = {}): AppSettings {
	return {
		...testSettings(true),
		tools: {
			...testSettings(true).tools,
			enableToolCalls: true,
			tools,
		},
	};
}

const mocks = vi.hoisted(() => ({
	engine: {
		registerController: vi.fn(),
		removeController: vi.fn(),
		getSteeringQueue: vi.fn(() => undefined),
		getFollowUpQueue: vi.fn(() => undefined),
	},
	eventBusEmit: vi.fn(async () => undefined),
	streamPush: vi.fn(),
	senderSend: vi.fn(),
	modelSupportsImageGeneration: vi.fn(async () => false),
	getModelContextLength: vi.fn(async () => 128000),
	getModelMaxOutputTokens: vi.fn(async () => 4096),
	requiredAppFetch: vi.fn<typeof globalThis.fetch>(),
	processImageGenerationStream: vi.fn(async () => true),
	buildPrompt: vi.fn(async ({ historyMessages }) => ({
		systemPrompt: "system prompt",
		messages: [
			{ role: "system", content: "system prompt" },
			...historyMessages,
		],
	})),
	updateSessionUsage: vi.fn(),
	triggerRunPostResponse: vi.fn(async () => undefined),
	runAfterAssistantResponseHooks: vi.fn(async () => undefined),
	getSkillsForSession: vi.fn<() => SkillDefinition[]>(() => []),
	getMCPRouterToolDefinition: vi.fn<() => ToolDefinition | null>(() => null),
	getMCPToolDefinitionsForModel: vi.fn<() => ToolDefinition[]>(() => []),
	executeToolDirectly: vi.fn(),
	acpStreamPrompt: vi.fn(),
	buildProjectDirsPromptVars: vi.fn(() => ({ active: undefined, known: [] })),
	getContextCompactReason: vi.fn(() => null),
	shouldSkipAutoCompactForProviderUsageMismatch: vi.fn(() => false),
	store: {
		addMessage: vi.fn(),
		addMessageContentPart: vi.fn(),
		addMessageStep: vi.fn(),
		updateMessageStep: vi.fn(),
		updateMessageContent: vi.fn(),
		updateMessageReasoning: vi.fn(),
		updateMessageToolCalls: vi.fn(),
		updateMessageUsage: vi.fn(),
		updateStepsUsageByTurn: vi.fn(),
		updateMessageStreaming: vi.fn(),
		updateMessageError: vi.fn(),
		updateSessionContextSize: vi.fn(),
		updateMessageSkill: vi.fn(),
		flushSessionSave: vi.fn(async () => undefined),
		getSession: vi.fn(() => ({
			id: "s1",
			name: "Session",
			messages: [],
			createdAt: 1,
			updatedAt: 1,
			workingDirectory: "/tmp/project",
		})),
	},
}));

vi.mock("../../index.js", () => ({
	getStreamEngine: () => mocks.engine,
}));

vi.mock("../../../../events/index.js", () => ({
	getEventBus: () => ({ emit: mocks.eventBusEmit }),
	getStreamChannel: () => ({ push: mocks.streamPush }),
}));

vi.mock("../../../../store.js", () => ({
	...mocks.store,
}));

vi.mock("../../../providers/model-registry.js", () => ({
	modelSupportsImageGeneration: mocks.modelSupportsImageGeneration,
	getModelContextLength: mocks.getModelContextLength,
	getModelMaxOutputTokens: mocks.getModelMaxOutputTokens,
}));

vi.mock("../../../../provider-binding/bound-fetch.js", () => ({
	createRequiredAppFetch: () => mocks.requiredAppFetch,
}));

vi.mock("../image-stream.js", () => ({
	processImageGenerationStream: mocks.processImageGenerationStream,
}));

vi.mock("../tool-execution.js", () => ({
	executeToolDirectly: mocks.executeToolDirectly,
}));

vi.mock("../../prompt/system-prompt.js", () => ({
	buildPrompt: mocks.buildPrompt,
}));

vi.mock("../../../../session/usage.js", () => ({
	updateSessionUsage: mocks.updateSessionUsage,
}));

vi.mock("../../triggers/index.js", () => ({
	triggerManager: {
		runPostResponse: mocks.triggerRunPostResponse,
	},
}));

vi.mock("@onething/runtime/plugins/lifecycle.wiring", () => ({
	runAfterAssistantResponseHooks: mocks.runAfterAssistantResponseHooks,
}));

vi.mock("../../../skills/session-skills.js", () => ({
	getSkillsForSession: mocks.getSkillsForSession,
}));

vi.mock("@onething/runtime/mcp/index.wiring", () => ({
	getMCPRouterToolDefinition: mocks.getMCPRouterToolDefinition,
	getMCPToolDefinitionsForModel: mocks.getMCPToolDefinitionsForModel,
	isMCPTool: vi.fn(() => false),
	parseMCPToolId: vi.fn(() => null),
	findMCPToolIdByShortName: vi.fn(() => null),
	MCPManager: {
		getServerState: vi.fn(() => null),
	},
}));

vi.mock("../../../wiring/tools/index.js", () => ({
	createToolCall: vi.fn(
		(toolId: string, toolName: string, args: JsonObject) => ({
			id: `call_${toolId}`,
			toolId,
			toolName,
			arguments: args,
			status: "pending",
			timestamp: 1,
		}),
	),
}));

vi.mock("../../../variables/index.js", () => ({
}));

vi.mock("../../../project-dirs/index.js", () => ({
	buildProjectDirsPromptVars: mocks.buildProjectDirsPromptVars,
}));

vi.mock("../../context-compact.js", () => ({
	compactSessionContext: vi.fn(),
	getContextCompactReason: mocks.getContextCompactReason,
	shouldSkipAutoCompactForProviderUsageMismatch:
		mocks.shouldSkipAutoCompactForProviderUsageMismatch,
}));

vi.mock("@onething/runtime/prompts/resolver.wiring", () => ({
	resolvePromptReferences: vi.fn((content: string) => ({
		modelContent: content,
		displayContent: content,
		contentParts: undefined,
	})),
}));

vi.mock("@onething/runtime/acp", () => ({
	ACPManager: {
		streamPrompt: mocks.acpStreamPrompt,
	},
}));

const { registerAgentProviderRuntime } = await import(
	"../../../agent-loop/index.js"
);
const { executeMessageStream } = await import("../stream-executor.js");

function params(
	overrides: Partial<StreamExecutionParams> = {},
): StreamExecutionParams {
	return {
		sender: testSender(),
		sessionId: "s1",
		assistantMessageId: "m1",
		messageContent: "hello",
		historyMessages: [{ role: "user", content: "hello" }],
		configWithApiKey: testProviderConfig(),
		providerId: "test-agent",
		settings: testSettings(false),
		toolSettings: testToolSettings(false),
		sessionName: "Session",
		...overrides,
	};
}

describe("agent-loop stream entry integration", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("runs executeMessageStream through the real agent-loop runtime and executor for registered providers", async () => {
		const providerRequests: RecordedAgentRequest[] = [];
		const unregister = registerAgentProviderRuntime(
			"test-agent",
			() =>
				({
					id: "test-agent",
					capabilities: {
						capabilities: ["text-input", "text-output", "streaming"],
						inputModalities: ["text"],
						outputModalities: ["text"],
						supportsStreaming: true,
					},
					async *streamTurn(request) {
						providerRequests.push(recordAgentRequest(request));
						yield {
							type: "text-delta",
							turn: request.turn,
							delta: "agent says hi",
						};
						yield {
							type: "finish",
							turn: request.turn,
							finishReason: "stop",
							usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
						};
					},
				}) satisfies AgentProvider,
		);

		try {
			const result = await executeMessageStream(params());

			expect(result).toEqual({
				handled: true,
				isImageGeneration: false,
				pausedForConfirmation: false,
			});
			expect(providerRequests).toHaveLength(1);
			expect(messageContents(providerRequests[0])).toEqual([
				"system prompt",
				"hello",
			]);
			expect(providerRequests[0].tools).toEqual([]);
			expect(providerRequests[0].toolChoice).toBe("none");
			// 关掉工具开关时目录根本不该被问 —— 这一格由下面 `tools: []` 与
			// `toolChoice: 'none'` 两条断言一起钉住(R4b:旧的 spy 随口径删除)。
			expect(mocks.store.updateMessageContent).toHaveBeenCalledWith(
				"s1",
				"m1",
				"agent says hi",
			);
			expect(mocks.streamPush).toHaveBeenCalledWith("s1", {
				type: "text-delta",
				text: "agent says hi",
				turnIndex: 1,
			});
			expect(mocks.store.updateMessageUsage).toHaveBeenCalledWith(
				"s1",
				"m1",
				expect.objectContaining({
					inputTokens: 3,
					outputTokens: 4,
					totalTokens: 7,
				}),
			);
			expect(mocks.updateSessionUsage).toHaveBeenCalledWith(
				"s1",
				expect.objectContaining({ totalTokens: 7 }),
				expect.objectContaining({ inputTokens: 3, outputTokens: 4 }),
			);
			expect(mocks.eventBusEmit).toHaveBeenCalledWith(
				"s1",
				expect.objectContaining({
					type: "stream:complete",
				}),
			);
			expect(mocks.engine.removeController).toHaveBeenCalledWith("s1");
			expect(mocks.triggerRunPostResponse).toHaveBeenCalled();
			expect(mocks.runAfterAssistantResponseHooks).toHaveBeenCalled();
		} finally {
			unregister();
		}
	});

	it("emits reasoning and text stream chunks before stream completion", async () => {
		const eventOrder: string[] = [];
		mocks.streamPush.mockImplementation((_sessionId, chunk) => {
			if (chunk.type === "reasoning-delta")
				eventOrder.push(`reasoning:${chunk.reasoning}`);
			if (chunk.type === "text-delta") eventOrder.push(`text:${chunk.text}`);
		});
		(
			mocks.eventBusEmit as unknown as {
				mockImplementation: (
					implementation: (
						sessionId: string,
						event: { type: string },
					) => Promise<void>,
				) => void;
			}
		).mockImplementation(async (_sessionId, event) => {
			if (event.type === "stream:complete") eventOrder.push("complete");
		});

		const unregister = registerAgentProviderRuntime(
			"test-agent-realtime",
			() =>
				({
					id: "test-agent-realtime",
					capabilities: {
						capabilities: [
							"text-input",
							"text-output",
							"streaming",
							"reasoning",
						],
						inputModalities: ["text"],
						outputModalities: ["text"],
						supportsStreaming: true,
						supportsReasoning: true,
					},
					async *streamTurn(request) {
						yield {
							type: "reasoning-delta",
							turn: request.turn,
							delta: "think",
						};
						await Promise.resolve();
						yield { type: "text-delta", turn: request.turn, delta: "answer" };
						await Promise.resolve();
						yield { type: "finish", turn: request.turn, finishReason: "stop" };
					},
				}) satisfies AgentProvider,
		);

		try {
			await executeMessageStream(
				params({
					providerId: "test-agent-realtime",
					configWithApiKey: testProviderConfig({
						model: "test-agent-realtime-model",
						selectedModels: ["test-agent-realtime-model"],
					}),
				}),
			);

			expect(eventOrder).toEqual([
				"reasoning:think",
				"text:answer",
				"complete",
			]);
		} finally {
			unregister();
		}
	});

	it("streams DeepSeek reasoning and text in realtime while honoring thinking disabled", async () => {
		const eventOrder: string[] = [];
		let requestBody = "";
		mocks.requiredAppFetch.mockImplementation(async (_input, init) => {
			requestBody = typeof init?.body === "string" ? init.body : "";
			return new Response(
				[
					'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"},"finish_reason":null}],"usage":null}',
					"",
					'data: {"choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":null}],"usage":null}',
					"",
					'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
					"",
					"data: [DONE]",
					"",
				].join("\n"),
				{
					status: 200,
					headers: { "content-type": "text/event-stream" },
				},
			);
		});

		mocks.streamPush.mockImplementation((_sessionId, chunk) => {
			if (chunk.type === "reasoning-delta")
				eventOrder.push(`reasoning:${chunk.reasoning}`);
			if (chunk.type === "text-delta") eventOrder.push(`text:${chunk.text}`);
		});
		(
			mocks.eventBusEmit as unknown as {
				mockImplementation: (
					implementation: (
						sessionId: string,
						event: { type: string },
					) => Promise<void>,
				) => void;
			}
		).mockImplementation(async (_sessionId, event) => {
			if (event.type === "stream:complete") eventOrder.push("complete");
		});

		await executeMessageStream(
			params({
				providerId: "deepseek",
				configWithApiKey: testProviderConfig({
					apiKey: "deepseek-key",
					baseUrl: "https://deepseek.test",
					model: "deepseek-v4-pro",
					selectedModels: ["deepseek-v4-pro"],
					thinkingByModel: { "deepseek-v4-pro": false },
					models: {
						"deepseek-v4-pro": {
							id: "deepseek-v4-pro",
							name: "DeepSeek V4 Pro",
							provider: "deepseek",
							contextLength: 1_000_000,
							maxOutputTokens: 384_000,
							supportsTools: true,
							supportsVision: false,
							supportsReasoning: true,
							supportsImageOutput: false,
							supportsTemperature: true,
							inputModalities: ["text"],
							outputModalities: ["text"],
							pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					},
				}),
				toolSettings: testToolSettings(false),
			}),
		);

		const body = JSON.parse(requestBody) as {
			thinking?: { type?: string };
			reasoning_effort?: string;
		};
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body.reasoning_effort).toBeUndefined();
		expect(eventOrder).toEqual(["reasoning:think", "text:answer", "complete"]);
	});

	it("routes built-in ACP providers through the agent-loop stream entry", async () => {
		const abortController = new AbortController();
		mocks.acpStreamPrompt.mockImplementationOnce(async function* () {
			yield {
				type: "update",
				notification: {
					update: {
						sessionUpdate: "agent_thought_chunk",
						content: { type: "text", text: "planning " },
					},
				},
			};
			yield {
				type: "update",
				notification: {
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: "acp answer" },
					},
				},
			};
			yield {
				type: "finish",
				stopReason: "end_turn",
				usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
			};
		});

		const result = await executeMessageStream(
			params({
				providerId: "acp",
				configWithApiKey: testProviderConfig({
					apiKey: "",
					model: "codex-acp",
					selectedModels: ["codex-acp"],
				}),
			}),
			abortController,
		);

		expect(result).toEqual({
			handled: true,
			isImageGeneration: false,
			pausedForConfirmation: false,
		});
		expect(mocks.acpStreamPrompt).toHaveBeenCalledWith("codex-acp", {
			localSessionId: "s1",
			prompt: "hello",
			cwd: "/tmp/project",
			abortSignal: abortController.signal,
		});
		expect(mocks.store.updateMessageReasoning).toHaveBeenCalledWith(
			"s1",
			"m1",
			"planning ",
		);
		expect(mocks.store.updateMessageContent).toHaveBeenCalledWith(
			"s1",
			"m1",
			"acp answer",
		);
		expect(mocks.updateSessionUsage).toHaveBeenCalledWith(
			"s1",
			expect.objectContaining({ totalTokens: 12 }),
			expect.objectContaining({ inputTokens: 8, outputTokens: 4 }),
		);
		expect(mocks.engine.removeController).toHaveBeenCalledWith("s1");
	});

	it("emits aborted and skips completion when the agent-loop stream is stopped mid-turn", async () => {
		const abortController = new AbortController();
		const unregister = registerAgentProviderRuntime(
			"test-agent-abort",
			() =>
				({
					id: "test-agent-abort",
					capabilities: {
						capabilities: ["text-input", "text-output", "streaming"],
						inputModalities: ["text"],
						outputModalities: ["text"],
						supportsStreaming: true,
					},
					async *streamTurn(request) {
						yield {
							type: "text-delta",
							turn: request.turn,
							delta: "partial text",
						};
						abortController.abort();
						yield { type: "finish", turn: request.turn, finishReason: "stop" };
					},
				}) satisfies AgentProvider,
		);

		try {
			const result = await executeMessageStream(
				params({
					providerId: "test-agent-abort",
					configWithApiKey: testProviderConfig({
						model: "test-abort-model",
						selectedModels: ["test-abort-model"],
					}),
				}),
				abortController,
			);

			expect(result).toEqual({
				handled: true,
				isImageGeneration: false,
				pausedForConfirmation: false,
			});
			expect(mocks.store.updateMessageContent).toHaveBeenCalledWith(
				"s1",
				"m1",
				"partial text",
			);
			expect(mocks.eventBusEmit).toHaveBeenCalledWith(
				"s1",
				expect.objectContaining({
					type: "stream:aborted",
					reason: "User cancelled",
				}),
			);
			expect(mocks.eventBusEmit).not.toHaveBeenCalledWith(
				"s1",
				expect.objectContaining({
					type: "stream:complete",
				}),
			);
			expect(mocks.triggerRunPostResponse).not.toHaveBeenCalled();
			expect(mocks.runAfterAssistantResponseHooks).not.toHaveBeenCalled();
			expect(mocks.engine.removeController).toHaveBeenCalledWith("s1");
		} finally {
			unregister();
		}
	});

	it("passes skill-aware dynamic prompt messages from buildPrompt into the agent-loop provider", async () => {
		const providerRequests: RecordedAgentRequest[] = [];
		const skill: SkillDefinition = {
			id: "skill_repo",
			name: "repo-skill",
			description: "Repo workflow",
			instructions: "Always inspect the repo first.",
			source: "user",
			path: "/skills/repo-skill/SKILL.md",
			directoryPath: "/skills/repo-skill",
			enabled: true,
		};
		mocks.getSkillsForSession.mockReturnValueOnce([skill]);
		mocks.buildPrompt.mockImplementationOnce(
			async (input: BuildPromptOptions) => {
				expect(input.skills).toEqual([skill]);
				return {
					systemPrompt: "system prompt with repo-skill and branch=agent-loop",
					messages: [
						{ role: "system", content: "system prompt with repo-skill" },
						{ role: "system", content: "dynamic context: branch=agent-loop" },
						...input.historyMessages,
					],
				};
			},
		);

		const unregister = registerAgentProviderRuntime(
			"test-agent-skills",
			() =>
				({
					id: "test-agent-skills",
					capabilities: {
						capabilities: ["text-input", "text-output", "streaming"],
						inputModalities: ["text"],
						outputModalities: ["text"],
						supportsStreaming: true,
					},
					async *streamTurn(request) {
						providerRequests.push(recordAgentRequest(request));
						yield {
							type: "text-delta",
							turn: request.turn,
							delta: "skill prompt ok",
						};
						yield { type: "finish", turn: request.turn, finishReason: "stop" };
					},
				}) satisfies AgentProvider,
		);

		try {
			const result = await executeMessageStream(
				params({
					providerId: "test-agent-skills",
					configWithApiKey: testProviderConfig({
						model: "test-skill-model",
						selectedModels: ["test-skill-model"],
					}),
					settings: {
						...testSettings(false),
						skills: { enableSkills: true, skills: {} },
					},
				}),
			);

			expect(result.pausedForConfirmation).toBe(false);
			expect(mocks.getSkillsForSession).toHaveBeenCalledWith("/tmp/project", undefined);
			expect(providerRequests).toHaveLength(1);
			expect(messageContents(providerRequests[0])).toEqual([
				"system prompt with repo-skill",
				"dynamic context: branch=agent-loop",
				"hello",
			]);
			expect(
				providerRequests[0].messages.filter((message) =>
					String(message.content).includes("repo-skill"),
				),
			).toHaveLength(1);
			expect(mocks.store.updateMessageContent).toHaveBeenCalledWith(
				"s1",
				"m1",
				"skill prompt ok",
			);
			expect(mocks.engine.removeController).toHaveBeenCalledWith("s1");
		} finally {
			unregister();
		}
	});

	it("preserves multimodal image content for capable agent-loop providers", async () => {
		const providerRequests: RecordedAgentRequest[] = [];
		const imageContent = [
			{ type: "text" as const, text: "look at this" },
			{
				type: "image" as const,
				image: "data:image/png;base64,abc",
				mediaType: "image/png",
			},
		];
		const historyMessages: HistoryMessage[] = [
			{ role: "user", content: imageContent },
		];
		const unregister = registerAgentProviderRuntime(
			"test-agent-vision",
			() =>
				({
					id: "test-agent-vision",
					capabilities: {
						capabilities: [
							"text-input",
							"vision-input",
							"text-output",
							"streaming",
						],
						inputModalities: ["text", "image"],
						outputModalities: ["text"],
						supportsStreaming: true,
					},
					async *streamTurn(request) {
						providerRequests.push(recordAgentRequest(request));
						yield {
							type: "text-delta",
							turn: request.turn,
							delta: "vision ok",
						};
						yield { type: "finish", turn: request.turn, finishReason: "stop" };
					},
				}) satisfies AgentProvider,
		);

		try {
			const result = await executeMessageStream(
				params({
					providerId: "test-agent-vision",
					messageContent: "look at this",
					historyMessages,
					configWithApiKey: testProviderConfig({
						model: "test-vision-model",
						selectedModels: ["test-vision-model"],
					}),
				}),
			);

			expect(result.pausedForConfirmation).toBe(false);
			expect(providerRequests).toHaveLength(1);
			expect(messageContents(providerRequests[0])).toEqual([
				"system prompt",
				imageContent,
			]);
			expect(mocks.store.updateMessageContent).toHaveBeenCalledWith(
				"s1",
				"m1",
				"vision ok",
			);
			expect(mocks.engine.removeController).toHaveBeenCalledWith("s1");
		} finally {
			unregister();
		}
	});

	it("degrades unsupported multimodal content to text placeholders for text-only providers", async () => {
		const streamTurn = vi.fn(async function* () {
			yield {
				type: "text-delta" as const,
				turn: 1,
				delta: "text-only response",
			};
			yield { type: "finish" as const, turn: 1, finishReason: "stop" as const };
		});
		const imageContent = [
			{ type: "text" as const, text: "look at this" },
			{
				type: "image" as const,
				image: "data:image/png;base64,abc",
				mediaType: "image/png",
			},
		];
		const historyMessages: HistoryMessage[] = [
			{ role: "user", content: imageContent },
		];
		const unregister = registerAgentProviderRuntime(
			"test-agent-text-only",
			() =>
				({
					id: "test-agent-text-only",
					capabilities: {
						capabilities: ["text-input", "text-output", "streaming"],
						inputModalities: ["text"],
						outputModalities: ["text"],
						supportsStreaming: true,
					},
					streamTurn,
				}) satisfies AgentProvider,
		);

		try {
			const result = await executeMessageStream(
				params({
					providerId: "test-agent-text-only",
					messageContent: "look at this",
					historyMessages,
					configWithApiKey: testProviderConfig({
						model: "test-text-only-model",
						selectedModels: ["test-text-only-model"],
					}),
				}),
			);

			// Unsupported image parts are degraded to [Image] text placeholders
			// so the stream proceeds instead of failing.
			expect(result.pausedForConfirmation).toBe(false);
			expect(streamTurn).toHaveBeenCalled();
			expect(mocks.store.updateMessageContent).toHaveBeenCalledWith(
				"s1",
				"m1",
				"text-only response",
			);
			expect(mocks.engine.removeController).toHaveBeenCalledWith("s1");
		} finally {
			unregister();
		}
	});

	it("executes model-requested tools through the real agent-loop entry path", async () => {
		const providerRequests: RecordedAgentRequest[] = [];
		useCatalogTools(
			new StubCatalogTool("lookup", "Lookup facts", {
				query: { type: "string", description: "Search query" },
			}),
		);
		mocks.executeToolDirectly.mockResolvedValueOnce({
			success: true,
			data: { output: "lookup result: moon" },
		});

		const unregister = registerAgentProviderRuntime(
			"test-agent-tools",
			() =>
				({
					id: "test-agent-tools",
					capabilities: {
						capabilities: [
							"text-input",
							"text-output",
							"streaming",
							"tool-calls",
						],
						inputModalities: ["text"],
						outputModalities: ["text"],
						supportsStreaming: true,
						supportsTools: true,
					},
					async *streamTurn(request) {
						providerRequests.push(recordAgentRequest(request));
						if (request.turn === 1) {
							yield {
								type: "tool-call-start",
								turn: 1,
								toolCallId: "call_lookup",
								toolName: "lookup",
							};
							yield {
								type: "tool-call-delta",
								turn: 1,
								toolCallId: "call_lookup",
								toolName: "lookup",
								argumentsDelta: '{"query":"moon"}',
							};
							yield {
								type: "tool-call-done",
								turn: 1,
								toolCall: {
									id: "call_lookup",
									name: "lookup",
									arguments: '{"query":"moon"}',
								},
							};
							yield { type: "finish", turn: 1, finishReason: "tool_calls" };
							return;
						}

						expect(request.messages.at(-1)).toEqual({
							role: "tool",
							toolCallId: "call_lookup",
							content: "lookup result: moon",
						});
						yield { type: "text-delta", turn: 2, delta: "final with lookup" };
						yield {
							type: "finish",
							turn: 2,
							finishReason: "stop",
							usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 },
						};
					},
				}) satisfies AgentProvider,
		);

		try {
			const result = await executeMessageStream(
				params({
					providerId: "test-agent-tools",
					configWithApiKey: testProviderConfig({
						model: "test-tool-model",
						selectedModels: ["test-tool-model"],
					}),
					settings: settingsWithTools(),
					toolSettings: testToolSettings(true),
				}),
			);

			expect(result).toEqual({
				handled: true,
				isImageGeneration: false,
				pausedForConfirmation: false,
			});
			expect(providerRequests).toHaveLength(2);
			expect(providerRequests[0]).toMatchObject({
				turn: 1,
				toolChoice: "auto",
			});
			expect(
				providerRequests[0].tools?.map((tool: AgentTool) => tool.name),
			).toEqual(["lookup"]);
			expect(providerRequests[1].messages.at(-1)).toEqual({
				role: "tool",
				toolCallId: "call_lookup",
				content: "lookup result: moon",
			});
			expect(mocks.executeToolDirectly).toHaveBeenCalledWith(
				"lookup",
				{ query: "moon" },
				expect.objectContaining({
					sessionId: "s1",
					messageId: "m1",
					toolCallId: "call_lookup",
					workingDirectory: "/tmp/project",
				}),
			);
			expect(mocks.eventBusEmit).toHaveBeenCalledWith(
				"s1",
				expect.objectContaining({
					type: "tool:input-start",
					toolCallId: "call_lookup",
					toolName: "lookup",
				}),
			);
			expect(mocks.eventBusEmit).toHaveBeenCalledWith(
				"s1",
				expect.objectContaining({
					type: "tool:execution-start",
					toolCallId: "call_lookup",
					toolName: "lookup",
					args: { query: "moon" },
				}),
			);
			expect(mocks.eventBusEmit).toHaveBeenCalledWith(
				"s1",
				expect.objectContaining({
					type: "tool:result",
					toolCall: expect.objectContaining({
						id: "call_lookup",
						status: "completed",
						result: { output: "lookup result: moon" },
					}),
				}),
			);
			expect(mocks.streamPush).toHaveBeenCalledWith("s1", {
				type: "tool-input-delta",
				toolCallId: "call_lookup",
				argsTextDelta: '{"query":"moon"}',
			});
			expect(mocks.streamPush).toHaveBeenCalledWith("s1", {
				type: "text-delta",
				text: "final with lookup",
				turnIndex: 2,
			});
			expect(mocks.store.updateMessageContent).toHaveBeenCalledWith(
				"s1",
				"m1",
				"final with lookup",
			);
			expect(mocks.engine.removeController).toHaveBeenCalledWith("s1");
		} finally {
			unregister();
		}
	});

	it("uses settings.tools as the default tool switch when stream toolSettings are omitted", async () => {
		const providerRequests: RecordedAgentRequest[] = [];
		const configuredTools = {
			lookup: { enabled: true, autoExecute: true },
		};
		useCatalogTools(new StubCatalogTool("lookup", "Lookup facts"));

		const unregister = registerAgentProviderRuntime(
			"test-agent-default-tools",
			() =>
				({
					id: "test-agent-default-tools",
					capabilities: {
						capabilities: [
							"text-input",
							"text-output",
							"streaming",
							"tool-calls",
						],
						inputModalities: ["text"],
						outputModalities: ["text"],
						supportsStreaming: true,
						supportsTools: true,
					},
					async *streamTurn(request) {
						providerRequests.push(recordAgentRequest(request));
						yield { type: "text-delta", turn: 1, delta: "no tool needed" };
						yield { type: "finish", turn: 1, finishReason: "stop" };
					},
				}) satisfies AgentProvider,
		);

		try {
			const result = await executeMessageStream(
				params({
					providerId: "test-agent-default-tools",
					configWithApiKey: testProviderConfig({
						model: "test-default-tools-model",
						selectedModels: ["test-default-tools-model"],
					}),
					settings: settingsWithTools(configuredTools),
					toolSettings: undefined,
				}),
			);

			expect(result).toMatchObject({
				handled: true,
				isImageGeneration: false,
				pausedForConfirmation: false,
			});
			expect(providerRequests).toHaveLength(1);
			expect(providerRequests[0].toolChoice).toBe("auto");
			expect(providerRequests[0].tools?.map((tool) => tool.name)).toEqual([
				"lookup",
			]);
			expect(mocks.executeToolDirectly).not.toHaveBeenCalled();
		} finally {
			unregister();
		}
	});

	it("pauses and keeps the stream open when an agent-loop tool requires confirmation", async () => {
		const providerRequests: RecordedAgentRequest[] = [];
		useCatalogTools(
			new StubCatalogTool("dangerous", "Dangerous command", {
				cmd: { type: "string", description: "Command" },
			}),
		);
		mocks.executeToolDirectly.mockResolvedValueOnce({
			success: false,
			error: "Needs approval",
			requiresConfirmation: true,
			commandType: "dangerous",
		});

		const unregister = registerAgentProviderRuntime(
			"test-agent-confirm",
			() =>
				({
					id: "test-agent-confirm",
					capabilities: {
						capabilities: [
							"text-input",
							"text-output",
							"streaming",
							"tool-calls",
						],
						inputModalities: ["text"],
						outputModalities: ["text"],
						supportsStreaming: true,
						supportsTools: true,
					},
					async *streamTurn(request) {
						providerRequests.push(recordAgentRequest(request));

						if (request.turn !== 1) {
							throw new Error(
								"should not request another provider turn before confirmation",
							);
						}

						yield {
							type: "tool-call-start",
							turn: 1,
							toolCallId: "call_danger",
							toolName: "dangerous",
						};
						yield {
							type: "tool-call-delta",
							turn: 1,
							toolCallId: "call_danger",
							toolName: "dangerous",
							argumentsDelta: '{"cmd":"rm -rf tmp"}',
						};
						yield {
							type: "tool-call-done",
							turn: 1,
							toolCall: {
								id: "call_danger",
								name: "dangerous",
								arguments: '{"cmd":"rm -rf tmp"}',
							},
						};
						yield { type: "finish", turn: 1, finishReason: "tool_calls" };
					},
				}) satisfies AgentProvider,
		);

		try {
			const result = await executeMessageStream(
				params({
					providerId: "test-agent-confirm",
					configWithApiKey: testProviderConfig({
						model: "test-confirm-model",
						selectedModels: ["test-confirm-model"],
					}),
					settings: settingsWithTools(),
					toolSettings: testToolSettings(true),
				}),
			);

			expect(result).toEqual({
				handled: true,
				isImageGeneration: false,
				pausedForConfirmation: true,
			});
			expect(providerRequests).toHaveLength(1);
			expect(providerRequests[0]).toMatchObject({
				turn: 1,
				toolChoice: "auto",
			});
			expect(providerRequests[0].tools?.map((tool) => tool.name)).toEqual([
				"dangerous",
			]);
			expect(mocks.executeToolDirectly).toHaveBeenCalledWith(
				"dangerous",
				{ cmd: "rm -rf tmp" },
				expect.objectContaining({
					sessionId: "s1",
					messageId: "m1",
					toolCallId: "call_danger",
					workingDirectory: "/tmp/project",
				}),
			);
			expect(mocks.eventBusEmit).toHaveBeenCalledWith(
				"s1",
				expect.objectContaining({
					type: "tool:result",
					toolCall: expect.objectContaining({
						id: "call_danger",
						status: "pending",
						requiresConfirmation: true,
						commandType: "dangerous",
						error: "Needs approval",
					}),
				}),
			);
			expect(mocks.eventBusEmit).toHaveBeenCalledWith(
				"s1",
				expect.objectContaining({
					type: "step:updated",
					updates: expect.objectContaining({
						status: "awaiting-confirmation",
						error: "Needs approval",
						toolCall: expect.objectContaining({
							id: "call_danger",
							requiresConfirmation: true,
						}),
					}),
				}),
			);
			expect(mocks.eventBusEmit).not.toHaveBeenCalledWith(
				"s1",
				expect.objectContaining({
					type: "stream:complete",
				}),
			);
			expect(mocks.engine.removeController).not.toHaveBeenCalled();
		} finally {
			unregister();
		}
	});
});
