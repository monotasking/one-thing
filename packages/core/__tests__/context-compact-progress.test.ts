/**
 * C6 分块进度事件(docs/design/context-compact-capability-2026-08.md §C6)。
 *
 * `compactSessionContext` 只管回调,**转发到 eventBus 是调用方的事**。核心引擎
 * 的两条路(手动 /compact 与发送前自动压)都经过 `runContextCompact`,所以接线
 * 只此一处;这份测试钉的就是那一处对两条路都真的生效。
 *
 * (第三条路 —— 回合中的 agent-loop adapters —— 不经过本文件,由
 * `app/engine/stream/__tests__/agent-loop-runtime-compact.test.ts` 钉住。)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoreStreamEngine } from "../engine/core-stream-engine.js";

interface FakeMessage {
	id: string;
	role: string;
	content?: string;
	timestamp: number;
}

function createHarness(options: { compactReasons?: Array<string | null> } = {}) {
	const messages: FakeMessage[] = [];
	const emitted: Array<{ sessionId: string; event: Record<string, unknown> }> =
		[];
	const compactOptionsSeen: Array<Record<string, unknown>> = [];
	const reasons = [...(options.compactReasons ?? [])];

	const settings = {
		chat: {
			contextCompactEnabled: true,
			contextCompactKeepRecentTurns: 6,
			contextCompactThreshold: 85,
			maxTokens: 1024,
		},
		tools: {},
		skills: { enableSkills: false },
	};

	const session = {
		id: "s1",
		name: "Session",
		messages,
		createdAt: 0,
		updatedAt: 0,
		contextSize: 10,
	};

	let idSeq = 0;

	const runtime = {
		store: {
			getSettings: () => settings,
			getSession: () => session,
			listMessages: () => session.messages,
			getMessage: (_sessionId: string, messageId: string) =>
				session.messages.find((message: FakeMessage) => message.id === messageId),
			addMessage: (_sessionId: string, message: FakeMessage) => {
				messages.push(message);
			},
			renameSession: () => {},
			updateMessageAndTruncate: () => true,
			deleteMessageAndTruncate: () => true,
			deleteMessage: () => true,
		},
		ids: { createId: () => `id-${++idSeq}` },
		clock: { now: () => 1_700_000_000_000 },
		permission: { clearSession: () => {} },
		skills: { getForSession: () => [] },
		prompts: {
			resolveReferences: (content: string) => ({
				modelContent: content,
				displayContent: content,
			}),
		},
		media: { ingestMessageAttachments: () => {} },
		provider: {
			getEffectiveConfig: () => ({
				providerId: "openai",
				providerConfig: { model: "gpt-x", selectedModels: ["gpt-x"] },
				model: "gpt-x",
			}),
			resolveAuth: async () => ({ kind: "api-key", apiKey: "sk" }),
			getApiType: () => "openai",
			isSupported: () => true,
			requiresOAuth: () => false,
		},
		models: {
			getModelContextLength: async () => 200_000,
		},
		history: {
			buildMessages: () => [],
			buildResumeAfterToolConfirmation: () => [],
		},
		streams: {
			executeMessageStream: async () => {},
			executeAgentLoopStreamGeneration: async () => ({}),
		},
		compaction: {
			compactSessionContext: async (
				compactOptions: Record<string, unknown> & {
					onProgress?: (progress: {
						chunk: number;
						totalChunks: number;
					}) => void | Promise<void>;
				},
			) => {
				compactOptionsSeen.push(compactOptions);
				// 两块摘要:每块完成回调一次(单块压缩根本不会调这个回调)。
				await compactOptions.onProgress?.({ chunk: 1, totalChunks: 2 });
				await compactOptions.onProgress?.({ chunk: 2, totalChunks: 2 });
				return { success: true, summary: "compacted", retainedContextSize: 5 };
			},
			getContextCompactReason: () =>
				reasons.length > 0 ? reasons.shift() : null,
			shouldSkipAutoCompactForProviderUsageMismatch: () => false,
		},
	};

	const engine = new CoreStreamEngine(runtime as never);
	engine.setEventBus({
		onAnySession: () => () => {},
		emit: async (sessionId: string, event: Record<string, unknown>) => {
			emitted.push({ sessionId, event });
		},
	} as never);

	return { engine, emitted, compactOptionsSeen };
}

function progressEvents(
	emitted: Array<{ event: Record<string, unknown> }>,
): Array<Record<string, unknown>> {
	return emitted
		.map((entry) => entry.event)
		.filter((event) => event.type === "context:compact-progress");
}

describe("C6 context:compact-progress", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("手动 /compact:每块完成发一条 progress,夹在 started 与 completed 之间", async () => {
		const harness = createHarness();

		await harness.engine.handleCompactContext("s1", {
			requestId: "req-1",
		} as never);

		expect(progressEvents(harness.emitted)).toEqual([
			{ type: "context:compact-progress", chunk: 1, totalChunks: 2 },
			{ type: "context:compact-progress", chunk: 2, totalChunks: 2 },
		]);

		const types = harness.emitted.map((entry) => String(entry.event.type));
		expect(types.indexOf("context:compact-started")).toBeLessThan(
			types.indexOf("context:compact-progress"),
		);
		expect(types.lastIndexOf("context:compact-progress")).toBeLessThan(
			types.indexOf("context:compact-completed"),
		);
	});

	it("发送前自动压:同一条接线,progress 一样出得来", async () => {
		const harness = createHarness({ compactReasons: ["threshold"] });

		await harness.engine.handleSendMessage(
			"s1",
			{ content: "hello", suppressTitleGeneration: true } as never,
			{} as never,
		);

		expect(progressEvents(harness.emitted)).toEqual([
			{ type: "context:compact-progress", chunk: 1, totalChunks: 2 },
			{ type: "context:compact-progress", chunk: 2, totalChunks: 2 },
		]);
	});

	it("onProgress 作为选项传进 compactSessionContext,原有选项一个不少", async () => {
		const harness = createHarness();

		await harness.engine.handleCompactContext("s1", {} as never);

		const seen = harness.compactOptionsSeen[0];
		expect(typeof seen.onProgress).toBe("function");
		expect(seen.sessionId).toBe("s1");
		expect(seen.providerId).toBe("openai");
		expect(typeof seen.onMessageCreated).toBe("function");
		expect(typeof seen.onMessageUpdated).toBe("function");
	});
});
