/**
 * 事故包(incident bundle)的装配 —— 结构债 P4c 第四批从 `@main/ipc/evals.ts`
 * 整只搬过来,一行逻辑没改。
 *
 * 为什么搬:它的两个调用方现在分处两侧 —— 👎 仍在 `@main/ipc/evals.ts`,而
 * 「重试 / 编辑重发是一次迟到的负信号」这条自动补写随命令总线一起进了
 * `backend/rpc/domains/session-command.ts`。函数体本来就一句 electron 也不碰
 * (store / sessionReads / wiring 技能表 / `@onething/runtime` 的投影全在装配层
 * 够得着的地方),留在宿主里只会逼着装配层去 import `@main`。
 *
 * 它是**迟到负信号的唯一入口**:两个调用点都在这里汇合,现场保真那一套
 * (LRU 抓包 → 磁盘环 → 按生产管线重建 send view → 最后才手搓存储视图)
 * 因此只有一份。
 */
import { getSkillsForSession } from '../skills/session-skills.js'
import { sessionReads } from '../../session/reads.js'
import * as store from '../../store.js'
import { getLogger } from '../logging/index.js'

const log = getLogger('evals.incident')

/**
 * Build a complete incident bundle for a turn: prompt capture from the LRU,
 * turn trace (with REAL tool results) from the persisted session messages,
 * builder inputs for replay. Returns null when the turn can't be located.
 *
 * This is the single entry point for late negative signals — the downvote
 * handler and the retry/edit amend interceptor both call it.
 */
export async function createIncidentForTurn(options: {
	sessionId: string;
	turnId: string;
	origin: "downvote" | "auto";
	note?: string;
	userMessage?: string;
	explicitDown?: boolean;
	signals?: { retried?: boolean; editResent?: boolean };
}): Promise<{
	incidentId: string;
	userMessage: string;
	assistantText: string;
} | null> {
	const {
		createIncidentBundle,
		extractTurnTrace,
		synthesizeContextFromMessages,
		promptCaptureCache,
		loadCaptureFromDisk,
		getSkeletonVersion,
	} = await import("@onething/runtime");

	const session = store.getSession(options.sessionId);
	const messages = [...sessionReads.listMessages(options.sessionId).messages] as Array<{
		id: string;
		role: string;
		content?: unknown;
		toolCalls?: Array<{
			toolName?: string;
			arguments?: Record<string, unknown>;
			result?: unknown;
			status?: string;
			durationMs?: number;
		}>;
	}>;

	// Locate the turn's assistant message and its preceding user message.
	const anchorIdx = messages.findIndex(
		(m) => m.id === options.turnId && m.role === "assistant",
	);
	let userMessage = options.userMessage ?? "";
	let assistantText = "";
	if (anchorIdx >= 0) {
		assistantText =
			typeof messages[anchorIdx].content === "string"
				? (messages[anchorIdx].content as string)
				: "";
		for (let i = anchorIdx - 1; i >= 0; i--) {
			if (messages[i].role === "user") {
				userMessage =
					typeof messages[i].content === "string"
						? (messages[i].content as string)
						: userMessage;
				break;
			}
		}
	}

	const workingDirectory = session?.workingDirectory;
	const skills = getSkillsForSession(workingDirectory);
	// Capture resolution: memory LRU (fast) → disk ring (Route B, survives
	// restarts and covers ~200 turns).
	const capture =
		promptCaptureCache.get(options.turnId) ??
		loadCaptureFromDisk(options.turnId) ??
		undefined;
	const turnTrace = extractTurnTrace(messages, options.turnId);

	// Without either a capture or a locatable turn there is no scene to save.
	if (!capture && anchorIdx < 0) return null;

	// Context resolution when the capture has no request messages (never
	// captured, or slimmed by the disk ring's size cap):
	// Route A — rebuild the SEND VIEW from the persisted session jsonl
	// through the production pipeline (dehydration + compaction + image
	// handling, same code the live request went through).
	// Last resort — hand-rolled storage-view synthesis.
	let synthesizedContext: Array<Record<string, unknown>> | undefined;
	let synthesizedContextOrigin: "rebuilt" | "synthesized" = "rebuilt";
	if (!capture?.requestMessages?.length && anchorIdx >= 0) {
		try {
			const { buildHistoryMessages } = await import(
				"../engine/stream/message-helpers.js"
			);
			// History up to and including the turn's user message — mirrors
			// what the live request carried.
			let userIdx = anchorIdx - 1;
			while (userIdx >= 0 && messages[userIdx].role !== "user") userIdx--;
			const turnStartMessages = messages.slice(
				0,
				(userIdx >= 0 ? userIdx : anchorIdx) + 1,
			);
			const sendView = buildHistoryMessages(
				turnStartMessages as Parameters<typeof buildHistoryMessages>[0],
				{
					id: options.sessionId,
					summary: session?.summary,
					summaryUpToMessageId: session?.summaryUpToMessageId,
				},
			);
			synthesizedContext = JSON.parse(
				JSON.stringify(sendView),
			) as Array<Record<string, unknown>>;
		} catch (error) {
			log.warn("send-view rebuild failed, using storage view", undefined, error);
			synthesizedContext = synthesizeContextFromMessages(
				messages,
				options.turnId,
			);
			synthesizedContextOrigin = "synthesized";
		}
	}

	const bundle = createIncidentBundle({
		origin: options.origin,
		note: options.note,
		sessionId: options.sessionId,
		turnId: options.turnId,
		provider: session?.lastProvider ?? "unknown",
		model: session?.lastModel ?? "unknown",
		userMessage,
		assistantText,
		explicitDown: options.explicitDown,
		signals: options.signals,
		promptCapture: capture,
		turnTrace,
		synthesizedContext,
		synthesizedContextOrigin,
		fixtureContext: {
			workingDirectory,
			workingDirectoryRoots: session?.workingDirectoryRoots,
			skills: skills
				.filter((s) => s.enabled !== false)
				.map((s) => ({
					name: s.name,
					description: s.description,
					source: s.source,
					category: s.category,
					enabled: s.enabled,
					path: s.path,
				})),
			toolNames: [],
			hasTools: true,
			platform: process.platform,
		},
		skeletonVersion: getSkeletonVersion(),
		storeOptions: {},
	});
	return { incidentId: bundle.incidentId, userMessage, assistantText };
}
