/**
 * P2 互斥补洞(docs/design/context-compact-fix-2026-08.md §4)。
 *
 * 修的是三个洞:
 *  (a) 用户消息**先落库**再撞 activeCompactions → 那一轮永无回应;
 *  (b) `contextCompactEnabled === false` / provider 自管窗口时守卫被整个跳过
 *      → 手动 compact 与新 stream 真并发;
 *  (c) `handleCompactContext` 查 activeStreams 之后还有 await(TOCTOU)。
 *
 * 语义是**等待而不是拒绝**:闸打开时消息一条都不该丢,压缩收尾后照常落库、
 * 照常得到回应。而 finally 的 resolve 必须无条件 —— 那是本方案唯一新增的
 * 阻塞点,压缩抛错/中断都不能把会话卡死。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoreStreamEngine } from "../engine/core-stream-engine.js";

interface FakeMessage {
	id: string;
	role: string;
	content?: string;
	timestamp: number;
	isStreaming?: boolean;
	provider?: string;
	model?: string;
}

function createHarness(
	options: {
		contextCompactEnabled?: boolean;
		compact?: (sessionId: string) => Promise<unknown>;
	} = {},
) {
	const messages: FakeMessage[] = [];
	const emitted: Array<{ sessionId: string; event: Record<string, unknown> }> =
		[];
	const streamCalls: Array<Record<string, unknown>> = [];

	const settings = {
		chat: {
			contextCompactEnabled: options.contextCompactEnabled ?? true,
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
			executeMessageStream: async (call: Record<string, unknown>) => {
				streamCalls.push(call);
			},
			executeAgentLoopStreamGeneration: async () => ({}),
		},
		compaction: {
			compactSessionContext: async (compactOptions: { sessionId: string }) =>
				options.compact
					? await options.compact(compactOptions.sessionId)
					: { success: true, summary: "compacted", retainedContextSize: 5 },
			// 阈值判定一律"不用压":自动压缩不是这一份测试的对象,闸才是。
			getContextCompactReason: () => null,
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

	return { engine, messages, emitted, streamCalls };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function eventTypes(
	emitted: Array<{ event: Record<string, unknown> }>,
): string[] {
	return emitted.map((entry) => String(entry.event.type));
}

async function settle(times = 6) {
	for (let index = 0; index < times; index++) {
		await Promise.resolve();
	}
}

describe("P2 压缩闸:压缩进行中发消息", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	it("用户消息等到 compact 收尾后才落库,并照常得到回应", async () => {
		const hold = deferred<unknown>();
		const harness = createHarness({
			compact: async () => await hold.promise,
		});

		const compacting = harness.engine.handleCompactContext("s1", {
			requestId: "req-1",
		} as never);
		await settle();

		// 压缩已开跑:started 出去了,而 provider 还在等。
		expect(eventTypes(harness.emitted)).toContain("context:compact-started");
		expect(harness.emitted[0]?.event.requestId).toBe("req-1");

		const sending = harness.engine.handleSendMessage(
			"s1",
			{ content: "hello", suppressTitleGeneration: true } as never,
			{} as never,
		);
		await settle();

		// 关键:一条都还没落库(从前是先落库再撞 activeCompactions)。
		expect(harness.messages).toHaveLength(0);
		expect(harness.streamCalls).toHaveLength(0);

		hold.resolve({
			success: true,
			summary: "compacted",
			retainedContextSize: 5,
		});
		await compacting;
		await sending;

		// 压缩结束后消息才落库,而且真的开了流 —— 不是被拒绝掉。
		expect(harness.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
		expect(harness.streamCalls).toHaveLength(1);
		expect(eventTypes(harness.emitted)).toContain("context:compact-completed");
		expect(
			harness.emitted.some(
				(entry) => entry.event.type === "stream:error",
			),
		).toBe(false);
	});

	it("contextCompactEnabled=false 时闸同样生效(那个开关只管要不要自动压)", async () => {
		const hold = deferred<unknown>();
		const harness = createHarness({
			contextCompactEnabled: false,
			compact: async () => await hold.promise,
		});

		const compacting = harness.engine.handleCompactContext("s1", {
			requestId: "req-2",
		} as never);
		await settle();

		const sending = harness.engine.handleSendMessage(
			"s1",
			{ content: "hello", suppressTitleGeneration: true } as never,
			{} as never,
		);
		await settle();

		expect(harness.messages).toHaveLength(0);

		hold.resolve({ success: true, summary: "compacted" });
		await compacting;
		await sending;

		expect(harness.messages).toHaveLength(2);
		expect(harness.streamCalls).toHaveLength(1);
	});

	it("edit-and-resend / retry / resume 三个入口也过闸", async () => {
		for (const run of [
			(engine: CoreStreamEngine) =>
				engine.handleEditAndResend(
					"s1",
					{ messageId: "m1", newContent: "edited" } as never,
					{} as never,
				),
			(engine: CoreStreamEngine) =>
				engine.handleRetryMessage(
					"s1",
					{ messageId: "m1" } as never,
					{} as never,
				),
			(engine: CoreStreamEngine) =>
				engine.handleResumeAfterConfirm(
					"s1",
					{ messageId: "m1" } as never,
					{} as never,
				),
		]) {
			const hold = deferred<unknown>();
			const harness = createHarness({ compact: async () => await hold.promise });

			const compacting = harness.engine.handleCompactContext("s1", {} as never);
			await settle();

			let settled = false;
			const running = run(harness.engine).then(() => {
				settled = true;
			});
			await settle();

			// 闸挡住了:三个入口都还没走到自己的第一步。
			expect(settled).toBe(false);

			hold.resolve({ success: true, summary: "compacted" });
			await compacting;
			await running;
			expect(settled).toBe(true);
		}
	});

	it("compact 抛错也必然开闸(finally 无条件 resolve),不死锁", async () => {
		const hold = deferred<unknown>();
		const harness = createHarness({
			compact: async () => {
				await hold.promise;
				throw new Error("provider exploded");
			},
		});

		const compacting = harness.engine
			.handleCompactContext("s1", { requestId: "req-3" } as never)
			.catch(() => {});
		await settle();

		const sending = harness.engine.handleSendMessage(
			"s1",
			{ content: "after failure", suppressTitleGeneration: true } as never,
			{} as never,
		);
		await settle();
		expect(harness.messages).toHaveLength(0);

		hold.resolve(undefined);
		await compacting;
		await sending;

		expect(harness.messages).toHaveLength(2);
	});

	it("compact 与 compact 互斥保持既有报错(入口同步登记,消除 TOCTOU)", async () => {
		const hold = deferred<unknown>();
		const harness = createHarness({ compact: async () => await hold.promise });

		const first = harness.engine.handleCompactContext("s1", {
			requestId: "req-a",
		} as never);
		// 不 await settle:第二条紧跟着发,打的正是 resolveProvider 那个 await 窗口。
		const second = harness.engine.handleCompactContext("s1", {
			requestId: "req-b",
		} as never);

		await second;

		const rejected = harness.emitted.find(
			(entry) =>
				entry.event.type === "context:compact-completed" &&
				entry.event.requestId === "req-b",
		);
		expect(rejected?.event).toMatchObject({
			success: false,
			error: "Context compact is already running.",
		});

		hold.resolve({ success: true, summary: "compacted" });
		await first;
	});
});
