/**
 * W14b 说话即行动 — the pure half.
 *
 * The load-bearing thing here is the EPOCH MATRIX: three kinds of assistant
 * message coexist in one transcript (say / thinking / pre-W14b), the rule is a
 * marker rather than a migration, and every consumer — projection, willingness
 * window, chain accounting, quote gap — has to read that marker the same way.
 * A mutation in any single predicate has to fail a test here.
 */
import { describe, expect, it } from "vitest";
import {
	COLLAB_SAY_MAX_CHARS,
	COLLAB_SAY_REFUSED_BUDGET,
	COLLAB_SAY_REFUSED_FROZEN,
	COLLAB_SAY_SOURCE,
	COLLAB_SEND_MESSAGE_LEGACY_TOOL_NAME,
	COLLAB_SEND_MESSAGE_TOOL_NAME,
	COLLAB_TURN_SOURCE,
	formatCollabDmReceipt,
	formatCollabSayReceipt,
	formatCollabThinkingTraceLabel,
	formatCollabWakePoke,
	isCollabSayMessage,
	isCollabSendIntoRoom,
	isCollabThinkingMessage,
	normalizeCollabSayContent,
	resolveCollabSayMentions,
	resolveCollabSendChannel,
	resolveCollabSendChannelFromArgs,
} from "../say.js";
import {
	collabMessageCountsTowardChain,
	computeCollabChainCount,
} from "../chain.js";
import { collabChainGateAllows } from "../activation.js";
import { COLLAB_MESSAGE_SOURCE, isCollabDriveMessage } from "../collab-types.js";
import { projectRoomHistory } from "../projection.js";
import { buildWillingnessWindow } from "../willingness.js";
import {
	isCollabVisibleRoomMessage,
	shouldAttachCollabReplyTo,
} from "../reply-quote.js";
import { buildCollabRoomContext } from "../roster.js";
import { buildCollabSilentDeliveryLine } from "../system-lines.js";
import {
	COLLAB_ROOM_TOOLS,
	COLLAB_WORK_REQUIRED_TOOLS,
} from "../tool-surface.js";
// 「这一回合能用哪些工具」只有一处实现(C2「工具面单点」),collab 这边只留地板表。
import { resolveAgentToolSurface } from "../../agent/profile.js";
import type { CollabAgentLike, CollabMessageLike } from "../collab-types.js";

const MEMBERS: CollabAgentLike[] = [
	{ id: "pm", name: "阿明", title: "产品" },
	{ id: "fe", name: "小李", title: "前端" },
];

/** The three epochs, as one transcript. */
const SAY: CollabMessageLike = {
	role: "assistant",
	agentId: "fe",
	content: "登录页明天下班前",
	source: COLLAB_SAY_SOURCE,
};
const THINKING: CollabMessageLike = {
	role: "assistant",
	agentId: "fe",
	content: "先看排期,再决定说不说",
	source: COLLAB_TURN_SOURCE,
};
const LEGACY: CollabMessageLike = {
	role: "assistant",
	agentId: "fe",
	content: "旧转录里,这条就是发言",
};

describe("epoch markers", () => {
	it("tells the three epochs apart", () => {
		expect(isCollabSayMessage(SAY)).toBe(true);
		expect(isCollabThinkingMessage(SAY)).toBe(false);

		expect(isCollabThinkingMessage(THINKING)).toBe(true);
		expect(isCollabSayMessage(THINKING)).toBe(false);

		expect(isCollabSayMessage(LEGACY)).toBe(false);
		expect(isCollabThinkingMessage(LEGACY)).toBe(false);
	});

	it("reads the marker off origin.source too (both writers, one rule)", () => {
		expect(
			isCollabSayMessage({
				role: "assistant",
				origin: { source: COLLAB_SAY_SOURCE },
			}),
		).toBe(true);
		expect(
			isCollabThinkingMessage({
				role: "assistant",
				origin: { source: COLLAB_TURN_SOURCE },
			}),
		).toBe(true);
	});

	it("never claims a non-assistant message", () => {
		expect(
			isCollabSayMessage({ role: "user", source: COLLAB_SAY_SOURCE }),
		).toBe(false);
		expect(
			isCollabThinkingMessage({ role: "system", source: COLLAB_TURN_SOURCE }),
		).toBe(false);
	});
});

describe("epoch matrix — chain accounting", () => {
	it("counts speech, ignores thinking, keeps the old epoch intact", () => {
		expect(collabMessageCountsTowardChain(SAY)).toBe(true);
		expect(collabMessageCountsTowardChain(THINKING)).toBe(false);
		expect(collabMessageCountsTowardChain(LEGACY)).toBe(true);
		expect(
			collabMessageCountsTowardChain({ ...LEGACY, content: "[pass]" }),
		).toBe(false);
		// A say IS speech even if its text looks like the retired sentinel: the
		// marker outranks the words (pass 退役).
		expect(collabMessageCountsTowardChain({ ...SAY, content: "[pass]" })).toBe(
			true,
		);
	});

	it("counts one per utterance, so live and replay agree", () => {
		// One turn: a thinking record and three things actually said.
		const transcript: CollabMessageLike[] = [
			{ role: "user", content: "大家看看" },
			THINKING,
			{ ...SAY, content: "一" },
			{ ...SAY, content: "二" },
			{ ...SAY, content: "三" },
		];
		expect(computeCollabChainCount(transcript)).toBe(3);
	});

	it("still resets on a human message", () => {
		expect(
			computeCollabChainCount([SAY, SAY, { role: "user", content: "停" }, SAY]),
		).toBe(1);
	});

	/**
	 * A2:没有人类在场的房间(agent ⇄ agent pair 房)靠**外部注入**解冻,而注入
	 * 此前只清 live 那一侧的计数 —— 重启一次,重算值必然 ≥ live 值,顶格冻死。
	 */
	it("resets on a marked external injection — and the marked message itself counts zero", () => {
		const injected = { ...SAY, collabChainReset: true, content: "别处让我来说一句" };
		// live 侧:注入把计数清成 0,注入这条自己不计(它不是这间房某个回合的
		// 产物),随后那一轮说了一句 = 1。重算必须落在同一个数上。
		expect(computeCollabChainCount([SAY, SAY, injected])).toBe(0);
		expect(computeCollabChainCount([SAY, SAY, injected, SAY])).toBe(1);
	});

	it("an unmarked transcript is unchanged — the marker is a rule, not a migration", () => {
		expect(computeCollabChainCount([SAY, SAY, SAY])).toBe(3);
	});
});

/**
 * 链闸的唯一判据(A1)。五处判定共用这一条公式,`occupied` 是并行化补上的那半:
 * 过了闸还没说话的每一条按至少一句预占一格。
 */
describe("chain gate — one formula, five call sites", () => {
	it("counts what was said plus what already holds the floor", () => {
		const gate = (chainCount: number, occupied: number) =>
			collabChainGateAllows({
				reason: "mention",
				chainCount,
				maxChain: 3,
				occupied,
			});
		expect(gate(2, 0)).toBe(true);
		// 两条已经过闸的回合各占一格 —— 第三条撞闸,而只看 chainCount 会放它过去。
		expect(gate(1, 2)).toBe(false);
		expect(gate(3, 0)).toBe(false);
	});

	it("keeps the task-event exemption and the 0 = 不限 convention", () => {
		expect(
			collabChainGateAllows({
				reason: "task-event",
				chainCount: 99,
				maxChain: 3,
				occupied: 5,
			}),
		).toBe(true);
		// maxChain 的 0/负数归一在 `maxChainFor` 那一层完成,闸拿到的已经是
		// Infinity —— 这里钉的是"拿到 Infinity 就永远放行"。
		expect(
			collabChainGateAllows({
				reason: "self-elected",
				chainCount: 99,
				maxChain: Number.POSITIVE_INFINITY,
			}),
		).toBe(true);
	});
});

describe("epoch matrix — projection", () => {
	const transcript: CollabMessageLike[] = [
		{ role: "user", content: "登录页什么时候能好?" },
		THINKING,
		SAY,
		LEGACY,
	];

	it("projects what was said and drops the thinking record — for other members", () => {
		const projected = projectRoomHistory({
			messages: transcript,
			selfAgentId: "pm",
			agents: MEMBERS,
		});
		const text = projected.map((entry) => entry.content).join("\n");
		expect(text).toContain('<message from="小李#fe">登录页明天下班前');
		expect(text).toContain("旧转录里,这条就是发言");
		expect(text).not.toContain("先看排期");
	});

	it("drops it for its OWN author too — an agent does not re-read its thoughts", () => {
		const projected = projectRoomHistory({
			messages: transcript,
			selfAgentId: "fe",
			agents: MEMBERS,
		});
		// 房间侧只有一块 `<ChatRoom>`(collab-chatroom-payload.md):自己说过的话
		// 在 History 里,自己的思考记录哪儿都没有。
		expect(projected).toHaveLength(1);
		expect(projected[0].content).toContain(
			'<message from="小李#fe">登录页明天下班前',
		);
		expect(projected[0].content).not.toContain("先看排期");
	});
});

describe("epoch matrix — willingness window", () => {
	it("windows speech only", () => {
		const lines = buildWillingnessWindow({
			recent: [{ role: "user", content: "在吗" }, THINKING, SAY],
			members: MEMBERS,
		});
		expect(lines).toEqual(["用户: 在吗", "小李#fe: 登录页明天下班前"]);
	});
});

describe("epoch matrix — quote gap", () => {
	it("does not count a thinking trace as a row the room saw", () => {
		expect(isCollabVisibleRoomMessage(SAY)).toBe(true);
		expect(isCollabVisibleRoomMessage(LEGACY)).toBe(true);
		expect(isCollabVisibleRoomMessage(THINKING)).toBe(false);
	});

	it("so a reply that only had a thinking record between it and the trigger stays bare", () => {
		const messages = [
			{
				...({ role: "user", content: "@小李 登录页?" } as CollabMessageLike),
				id: "trigger",
			},
			{ ...THINKING, id: "think" },
			{ ...SAY, id: "reply" },
		];
		expect(
			shouldAttachCollabReplyTo({
				messages,
				triggerMessageId: "trigger",
				replyMessageId: "reply",
				reply: SAY,
			}),
		).toBe(false);
	});
});

describe("say mentions", () => {
	it("whitelists ids against the roster and re-labels from it (防冒名)", () => {
		expect(
			resolveCollabSayMentions({
				content: "拍个板",
				mentionAgentIds: ["pm", "ghost"],
				members: MEMBERS,
			}),
		).toEqual([{ agentId: "pm", label: "阿明" }]);
	});

	it("falls back to the prose scan for a bare @名字", () => {
		expect(
			resolveCollabSayMentions({ content: "@小李 你看一下", members: MEMBERS }),
		).toEqual([{ agentId: "fe", label: "小李" }]);
	});

	it("merges both without duplicating anyone", () => {
		expect(
			resolveCollabSayMentions({
				content: "@小李 你看一下",
				mentionAgentIds: ["pm", "fe"],
				members: MEMBERS,
			}),
		).toEqual([
			{ agentId: "pm", label: "阿明" },
			{ agentId: "fe", label: "小李" },
		]);
	});

	/**
	 * 句柄(collab-agent-handle.md §2.4)。这一组钉的是**优先级**:显式 id >
	 * 正文句柄 > 裸名字 —— 而最要紧的一条是重名那两位不能被一起叫醒。
	 */
	it("认正文里的 @名字#句柄,而且比裸名字精确", () => {
		const twins = [
			{ id: "fe-1", name: "小李" },
			{ id: "fe-2", name: "小李" },
		];
		// 裸名字:文本分辨不了,两位都被点到(W14a 既有口径,不变)。
		expect(
			resolveCollabSayMentions({
				content: "@小李 你看一下",
				members: twins,
			}).map((m) => m.agentId),
		).toEqual(["fe-1", "fe-2"]);
		// 带句柄:精确到一个 —— 这正是句柄存在的理由。
		expect(
			resolveCollabSayMentions({
				content: "@小李#fe-2 你看一下",
				members: twins,
			}),
		).toEqual([{ agentId: "fe-2", label: "小李" }]);
	});

	it("句柄写错时退回裸名字兜底,而不是谁都点不到", () => {
		expect(
			resolveCollabSayMentions({
				content: "@小李#deadbeef 在吗",
				members: MEMBERS,
			}),
		).toEqual([{ agentId: "fe", label: "小李" }]);
	});

	it("ignores garbage in the parameter instead of failing the utterance", () => {
		expect(
			resolveCollabSayMentions({
				content: "没点名",
				mentionAgentIds: "nope",
				members: MEMBERS,
			}),
		).toEqual([]);
		expect(
			resolveCollabSayMentions({
				content: "没点名",
				mentionAgentIds: [null, 7],
				members: MEMBERS,
			}),
		).toEqual([]);
	});
});

describe("say content", () => {
	it("rejects nothing-to-say", () => {
		expect(normalizeCollabSayContent("")).toBeNull();
		expect(normalizeCollabSayContent("   \n ")).toBeNull();
		expect(normalizeCollabSayContent(undefined)).toBeNull();
	});

	it("trims and caps", () => {
		expect(normalizeCollabSayContent("  你好  ")).toBe("你好");
		expect(
			normalizeCollabSayContent("x".repeat(COLLAB_SAY_MAX_CHARS + 50)),
		).toHaveLength(COLLAB_SAY_MAX_CHARS);
	});
});

describe("copy the agent reads", () => {
	it("names the failure as a DELIVERY failure, not an error code", () => {
		expect(COLLAB_SAY_REFUSED_FROZEN).toContain("未送达");
		expect(COLLAB_SAY_REFUSED_BUDGET).toContain("未送达");
	});

	it("hands the message id back so a follow-up can quote it", () => {
		expect(formatCollabSayReceipt("m-9")).toContain("m-9");
	});

	it("labels the trace with its step count", () => {
		expect(formatCollabThinkingTraceLabel(2)).toBe("思考过程 · 2 步");
		expect(formatCollabThinkingTraceLabel(0)).toBe("思考过程");
		expect(formatCollabThinkingTraceLabel(Number.NaN)).toBe("思考过程");
	});
});

describe("情况说明 — send_message is stated as a FACT (v3 铁律)", () => {
	const note = buildCollabRoomContext({
		self: MEMBERS[1],
		members: MEMBERS,
		roomName: "官网改版组",
	});

	it("states the mechanism: send_message delivers, multiple calls allowed, params exist", () => {
		expect(note).toContain("send_message");
		expect(note).toContain("as many times");
		expect(note).toContain("replyTo");
		// 点名走正文里的「@名字#句柄」,不再提 mentions 参数(collab-agent-handle.md
		// §2.4):那个参数要 agent id,而 agent 从来拿不到 id —— 说明书上写着一个
		// 它按不到的按钮,比不写更糟。
		expect(note).toContain("@name#handle");
		expect(note).not.toContain("mentions 参数");
	});

	it("states that not sending is fine, and that thinking stays private", () => {
		// 措辞从「沉默是合法结局」换成「没什么可回的就不回」(A.3):speak/silence
		// 那一组词属于发言权隐喻,而机制是聊天应用的发送按钮。
		expect(note).toContain("Not sending anything is fine");
		expect(note).toContain("reasoning");
	});

	/**
	 * 2026-08-02 换隐喻(A.2 ③):工位 + 推送通知 + 发送按钮。旧版那张图
	 * (「你不在聊天窗口里 / 这是后台会话」)与工具名 `say` 一起把回合正文说成
	 * "我的发言",而那正是「写而未发」的病根。
	 */
	it("states the desk-and-notifications picture, not a background-session disclaimer", () => {
		expect(note).toContain("You are at your own desk");
		expect(note).toContain("delivered to you here, like notifications");
		expect(note).toContain("not a chat input box");
		expect(note).toContain("there is no other send button");
		// 「nothing sends on its own」曾经跟在后面 —— 收养式兜底(A6)之后那是
		// 一句假话:被收养的那一轮里,确实有东西替它发了。改成如实说出兜底,
		// 并钉成**补救**(a repair after the fact)而不是第二个可选出口。
		expect(note).not.toContain("nothing sends on its own");
		expect(note).toContain("the system delivers that text for you");
		expect(note).toContain("not a second way to send");
		// 「turn text」这个自造行话全仓退役 —— 工位上的字就是笔记。
		expect(note).not.toContain("turn text");
	});

	it("never mentions stay_silent — the tool is retired (W22)", () => {
		// 退役清单的提示层一条:群里没有的工具不该出现在情况说明里,否则模型会
		// 去调一个不存在的名字,把一轮浪费在 "Tool not available" 上。
		expect(note).not.toContain("stay_silent");
		// …and the inventory line matches the union surface: own tools stay
		// available in a room turn (2026-07-30 收紧同日撤销),轻重活分界仍在。
		expect(note).toContain("Everything you normally have works here too");
		// 重活口径收敛成事实句,动作建议归 `<rules>`(D.2)。
		expect(note).toContain("Sizeable work belongs on the board");
		expect(note).not.toContain("assign it to whoever fits");
	});

	it("keeps the board fact and adds no instruction", () => {
		expect(note).toContain("board");
		expect(note).not.toContain("你应该");
		expect(note).not.toContain("请务必");
	});
});

describe("工具面(D5 + W14b,union 语义)", () => {
	it("UNIONs send_message + board into a room turn, keeping the agent tools", () => {
		// Union(collab-team-v2 §2.1;2026-07-30 曾收紧为 replace,同日应用户
		// 要求撤销):配了白名单 → own ∪ {send_message, board},轻活可以在群回合直接做。
		expect(
			resolveAgentToolSurface({ sessionKind: "room", ownTools: ["read"] }),
		).toEqual(["read", "send_message", "board", "history"]);
		// 没配白名单 = 跟随全局 = 不限制。
		expect(resolveAgentToolSurface({ sessionKind: "room" })).toBeNull();
		expect(resolveAgentToolSurface({ sessionKind: "agent" })).toBeNull();
		// D6-a:kind='agent' 是 v3 心智回合的落点,地板比房面多一格笔记。
		expect(
			resolveAgentToolSurface({
				sessionKind: "agent",
				ownTools: ["read", "render_preview"],
			}),
		).toEqual(["read", "render_preview", "send_message", "board", "history", "notebook"]);
	});

	it("UNIONs send_message + board into a work session whitelist, keeping its real tools", () => {
		expect(
			resolveAgentToolSurface({ sessionKind: "work", ownTools: ["read"] }),
		).toEqual(["read", "board", "send_message", "notebook"]);
		expect(
			resolveAgentToolSurface({ sessionKind: "work", ownTools: ["read", "send_message"] }),
		).toEqual(["read", "send_message", "board", "notebook"]);
	});

	it("offers stay_silent to NOBODY — the tool is retired (W22 退役清单)", () => {
		// 事故形状:一个惰性工具 + 一个「必须调工具」的开局 = 永不终止的落点。
		// 断路器是兜底,这里是根除:任何会话的工具面里都不该再出现这个名字。
		expect(COLLAB_ROOM_TOOLS).not.toContain("stay_silent");
		expect(COLLAB_WORK_REQUIRED_TOOLS).not.toContain("stay_silent");
		for (const kind of ["room", "agent", "work", "chat"]) {
			expect(
				resolveAgentToolSurface({ sessionKind: kind, ownTools: ["read"] }) ?? [],
			).not.toContain("stay_silent");
		}
	});

	it("leaves a work session with no whitelist unrestricted, and never touches chats", () => {
		expect(
			resolveAgentToolSurface({ sessionKind: "work", ownTools: null }),
		).toBeNull();
		expect(
			resolveAgentToolSurface({ sessionKind: "chat", ownTools: null }),
		).toBeNull();
		expect(
			resolveAgentToolSurface({ sessionKind: "chat", ownTools: ["read"] }),
		).toEqual(["read"]);
	});
});

describe("epoch 判别的变异锁", () => {
	it("marker outranks content — a say is speech no matter what it says", () => {
		// Mutation: falling through to the pass-sentinel check for say messages.
		expect(collabMessageCountsTowardChain({ ...SAY, content: "[pass]" })).toBe(
			true,
		);
		expect(isCollabVisibleRoomMessage({ ...SAY, content: "  " })).toBe(false); // empty is still empty
	});

	it("thinking wins over say when a message somehow carries both", () => {
		// Mutation: checking the say marker first would let a mislabelled record
		// count toward the chain and enter the projection.
		const both: CollabMessageLike = {
			...SAY,
			origin: { source: COLLAB_TURN_SOURCE },
		};
		expect(collabMessageCountsTowardChain(both)).toBe(false);
		expect(
			projectRoomHistory({
				messages: [both],
				selfAgentId: "pm",
				agents: MEMBERS,
			}),
		).toEqual([]);
	});

	it("an unmarked assistant message is never treated as thinking", () => {
		// Mutation: defaulting to "thinking" would erase every pre-W14b room.
		expect(isCollabThinkingMessage(LEGACY)).toBe(false);
		expect(collabMessageCountsTowardChain(LEGACY)).toBe(true);
		expect(
			projectRoomHistory({
				messages: [LEGACY],
				selfAgentId: "pm",
				agents: MEMBERS,
			}),
		).toHaveLength(1);
	});

	it("the marker is scoped to collab: a lookalike source on a user message is inert", () => {
		expect(
			isCollabThinkingMessage({ role: "user", source: COLLAB_TURN_SOURCE }),
		).toBe(false);
		expect(
			collabMessageCountsTowardChain({
				role: "user",
				agentId: "fe",
				content: "x",
			}),
		).toBe(false);
	});
});

describe("驱动消息不进投影、不计链", () => {
	const DRIVE: CollabMessageLike = {
		role: "user",
		content:
			"(小李 · 主动接话)\n(You execute this turn in the background: nothing you produce — text, reasoning, tool calls — appears in the chat unless you send it via the say tool. Call the say tool as many times as you like; end the turn when done.)",
		source: COLLAB_MESSAGE_SOURCE,
	};

	it("rides the drive marker, so it never enters anyone projection", () => {
		expect(isCollabDriveMessage(DRIVE)).toBe(true);
		expect(
			projectRoomHistory({
				messages: [
					{ role: "user", content: "@小李 登录页?" },
					DRIVE,
					THINKING,
					SAY,
				],
				selfAgentId: "fe",
				agents: MEMBERS,
			})
				.map((entry) => entry.content)
				.join("\n"),
		).not.toContain("说完直接结束");
	});

	it("does not reset the chain the way a human message does", () => {
		// Mutation: a drive that counted as human input would hand the room an
		// extra chain budget every turn.
		expect(computeCollabChainCount([SAY, SAY, DRIVE, SAY])).toBe(3);
	});
});

describe("worker 交付兜底行(不冒名)", () => {
	it("says who did not speak, and carries the report anyway", () => {
		const line = buildCollabSilentDeliveryLine({
			title: "加 status.txt",
			assigneeName: "小李",
			summary: "文件已写入,内容为 ok",
			kind: "delivery",
		});
		expect(line).toContain("小李");
		expect(line).toContain("没有在群里说明");
		expect(line).toContain("文件已写入");
	});

	it("has a distinct progress wording", () => {
		expect(
			buildCollabSilentDeliveryLine({ title: "x", kind: "progress" }),
		).toContain("本轮结束");
	});
});

/**
 * 旧名 `say` 的静默别名(collab-turn-protocol-and-identity.md A.3)。
 *
 * 别名的**路由**由 core 的退役名表负责(packages/backend/agent-loop/agent-loop-runner.test.ts
 * 守着"旧名被执行、且不进请求 tools 参数"),这里守的是另一半:它绝不能从任何
 * 一条"模型看得见"的通道漏出去 —— 一进工具面就成了两个同义工具。
 */
describe("旧名静默别名", () => {
	it("旧名不在工具面里,也不在任何一段情况说明里", () => {
		expect(COLLAB_SEND_MESSAGE_TOOL_NAME).toBe("send_message");
		expect(COLLAB_SEND_MESSAGE_LEGACY_TOOL_NAME).toBe("say");
		expect(COLLAB_ROOM_TOOLS).not.toContain(COLLAB_SEND_MESSAGE_LEGACY_TOOL_NAME);
		expect(COLLAB_ROOM_TOOLS).toContain(COLLAB_SEND_MESSAGE_TOOL_NAME);
		expect(COLLAB_WORK_REQUIRED_TOOLS).not.toContain(
			COLLAB_SEND_MESSAGE_LEGACY_TOOL_NAME,
		);
		for (const options of [{}, { dm: true }, { dmPair: true }]) {
			const note = buildCollabRoomContext({
				self: MEMBERS[1],
				members: MEMBERS,
				roomName: "官网改版组",
				...options,
			});
			expect(note).not.toContain("`say`");
		}
	});

	it("回执是中性的 —— 同一个执行器既发群也发私聊", () => {
		// 「已发进群里」在私聊房是句假话(一致性审计 P2-8)。
		expect(formatCollabSayReceipt("m-1")).not.toContain("群");
		expect(formatCollabSayReceipt("m-1")).toContain("已发出");
	});
});

/**
 * 统一发送面的纯规则(collab-send-channel-and-wake.md §2.1)。
 *
 * 推断规则本期覆盖全部两档,所以模型可以完全不写 channel —— 这组用例守的就是
 * "不写也对"这件事,以及三个消费方(工具路由、打字灯、断路器)读的是同一张表。
 */
describe("channel 推断与判据", () => {
	it("有 to = 私聊档,没有 = 房间档", () => {
		expect(resolveCollabSendChannelFromArgs({ to: "阿明" })).toBe("dm");
		expect(resolveCollabSendChannelFromArgs({})).toBe("room");
		// 空白的 to 不是收件人。
		expect(resolveCollabSendChannelFromArgs({ to: "   " })).toBe("room");
	});

	it("显式 channel 压过推断;认不出的写法在校验版变成一句可操作的拒绝", () => {
		expect(resolveCollabSendChannelFromArgs({ channel: "gateway" })).toBe("gateway");
		expect(resolveCollabSendChannelFromArgs({ channel: "群聊" })).toBeNull();
		const refused = resolveCollabSendChannel({ content: "一", channel: "群聊" } as never);
		expect(refused.ok).toBe(false);
	});

	it("isCollabSendIntoRoom:私聊档、以及指向别的房的调用都不是「发进这间房」", () => {
		expect(isCollabSendIntoRoom({}, "room-1")).toBe(true);
		expect(isCollabSendIntoRoom({ room: "room-1" }, "room-1")).toBe(true);
		expect(isCollabSendIntoRoom({ room: "room-2" }, "room-1")).toBe(false);
		expect(isCollabSendIntoRoom({ to: "阿明" }, "room-1")).toBe(false);
		// 不知道自己挂在哪间房时不做跨房判断(只挡得住私聊档)。
		expect(isCollabSendIntoRoom({ room: "room-2" }, undefined)).toBe(true);
	});

	it("wake 的回执说清那一声 @ 会落在哪个群", () => {
		expect(formatCollabDmReceipt({ targetKind: "agent", peerName: "小明" }))
			.not.toContain("@");
		const withWake = formatCollabDmReceipt({
			targetKind: "agent",
			peerName: "小明",
			wakeRoomName: "狼人杀",
		});
		expect(withWake).toContain("小明");
		expect(withWake).toContain("「狼人杀」");
	});

	it("poke 是固定模板 —— 不可自定义(内容永不跨房)", () => {
		expect(formatCollabWakePoke("小明#3f9c")).toBe(
			"@小明#3f9c 我在私聊里给你发了消息 —— 看完后请回到这里回应。",
		);
	});
});
