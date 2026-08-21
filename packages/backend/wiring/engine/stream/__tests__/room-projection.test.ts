/**
 * The PRODUCTION room projection (buildHistoryMessages over a kind='room'
 * session). The rules are specified in @onething/runtime/collab projection.ts;
 * this file guards the ChatMessage-level adapter that actually feeds the
 * provider — the 2026-07-28 incident lived exactly in the gap between the two
 * (W9.1: system lines were dropped here, so the reviewer only ever saw what
 * the executor claimed).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../agents/index.js", () => ({
	findAgent: (agentId: string) => {
		const names: Record<string, string> = { fe: "小李", pm: "阿明" };
		const titles: Record<string, string> = { fe: "前端工程师", pm: "产品经理" };
		return names[agentId]
			? { id: agentId, name: names[agentId], title: titles[agentId] }
			: null;
	},
}));

/** W18: an execution session's history IS the room's, so the projection has to
 *  go and read it. */
const rooms = new Map<string, unknown>();
vi.mock("../../../../store.js", () => ({
	getSession: (id: string) => rooms.get(id),
	// 用户消息的信封署名现取「我的资料」(agent-dm-user.md §2.3);空资料 =
	// 回退到「用户」,也就是这些断言里的既有文案。
	getSettings: () => ({ general: {} }),
}));

import {
	buildHistoryMessages,
	projectRoomMessagesForModel,
} from "../message-helpers.js";
import { projectRoomHistory } from "@onething/runtime/collab";
import type { ChatMessage } from "@shared/ipc.js";

/**
 * 断言前把 `time="…"` 剥掉。
 *
 * 夹具的 timestamp 是真实时钟(ChatMessage 必带),把它写进断言等于让这一整个
 * 文件在下一分钟变红。时间**本身**由下面那条专门的用例钉住形状,其余用例关心
 * 的是信封与正文,不该跟着时钟走。
 */
const stripTime = (text: string): string => text.replace(/ time="[^"]*"/g, "");

const ROOM = {
	id: "room-1",
	kind: "room",
	agentId: "pm",
	name: "官网改版组",
	room: { memberAgentIds: ["pm", "fe"] },
};

function message(
	partial: Partial<ChatMessage> & Pick<ChatMessage, "role">,
): ChatMessage {
	return {
		id: Math.random().toString(36).slice(2),
		timestamp: Date.now(),
		content: "",
		...partial,
	} as ChatMessage;
}

describe("room projection for the model (W9.1)", () => {
	it("gives the reviewer the task facts and hides the operational noise", () => {
		const history = buildHistoryMessages(
			[
				message({ role: "user", content: "@小李 给项目加个 notes.txt" }),
				message({
					role: "user",
					content: "(小李 · 被 @ 激活)",
					source: "collab",
				}),
				message({
					role: "system",
					content: "「加 notes.txt」→ 小李 开始执行(看板可查看现场)",
					source: "collab-task",
				}),
				message({
					role: "system",
					content: "「加 notes.txt」排队等待执行(并发上限)",
					source: "collab",
				}),
				message({
					role: "system",
					content:
						"「加 notes.txt」受阻:小李 无法继续,任务未交付(原因见看板任务卡)",
					source: "collab-task",
				}),
				message({
					role: "assistant",
					agentId: "fe",
					content: "已交付。notes.txt 写好了",
				}),
			],
			ROOM,
		);

		const text = stripTime(history.map((entry) => String(entry.content)).join("\n"));
		expect(text).toContain('<message from="系统">「加 notes.txt」→ 小李 开始执行');
		expect(text).toContain(
			'<message from="系统">「加 notes.txt」受阻:小李 无法继续,任务未交付',
		);
		expect(text).toContain('<message from="小李#fe">已交付。notes.txt 写好了');
		// Drive lines and operational noise never reach the model.
		expect(text).not.toContain("被 @ 激活");
		expect(text).not.toContain("排队等待执行");
		// Everything above is one merged user-side block for the activated PM.
		expect(history).toHaveLength(1);
		expect(history[0].role).toBe("user");
	});

	it("keeps unmarked system lines out entirely (they are display-only)", () => {
		const history = buildHistoryMessages(
			[
				message({ role: "user", content: "继续" }),
				message({
					role: "system",
					content: "今天这个房间已花费 $5.00,达到日预算 $5",
					source: "collab",
				}),
			],
			ROOM,
		);
		expect(
			stripTime(history.map((entry) => String(entry.content)).join("\n")),
		).not.toContain("日预算");
	});

	it("carries the quote reply into the model view, quote line above the speech (W7)", () => {
		// Same two-line shape the pure spec asserts (collab/projection.ts) — this
		// is the adapter that actually feeds the provider, so both must agree.
		const history = buildHistoryMessages(
			[
				message({
					role: "assistant",
					agentId: "fe",
					content: "先做接口再做页面",
				}),
				message({
					role: "user",
					content: "就按这个来",
					replyTo: {
						messageId: "m1",
						authorLabel: "小李",
						excerpt: "先做接口再做页面",
					},
				}),
			],
			ROOM,
		);

		const text = stripTime(history.map((entry) => String(entry.content)).join("\n"));
		expect(text).toContain(
			'<message from="用户#user">> 小李: 先做接口再做页面\n就按这个来',
		);
	});

	// W13.2: the coordinator hangs quotes on AGENT replies after the fact, so
	// the adapter must emit the quote line for another member's speech too —
	// W7 only ever exercised the user's own quoted message here.
	it("carries a quote hung on another agent’s reply (W13.2 补挂)", () => {
		const history = buildHistoryMessages(
			[
				message({ role: "user", content: "登录页什么时候能好?" }),
				message({
					role: "assistant",
					agentId: "pm",
					content: "我这边排期留了位置",
				}),
				message({
					role: "assistant",
					agentId: "fe",
					content: "明天下班前",
					replyTo: {
						messageId: "m1",
						authorLabel: "用户",
						excerpt: "登录页什么时候能好?",
					},
				}),
			],
			ROOM,
		);

		const text = stripTime(history.map((entry) => String(entry.content)).join("\n"));
		expect(text).toContain(
			'<message from="小李#fe">> 用户: 登录页什么时候能好?\n明天下班前',
		);
	});

	it("never decorates the activated agent’s OWN quoted message", () => {
		// Self messages stay structural: an agent reading a quote line it never
		// wrote back into its own past output is words put in its mouth.
		// ROOM.agentId is 'pm' — this message is the activated agent's own.
		const history = buildHistoryMessages(
			[
				message({
					role: "assistant",
					agentId: "pm",
					content: "明天下班前",
					replyTo: {
						messageId: "m1",
						authorLabel: "用户",
						excerpt: "登录页什么时候能好?",
					},
				}),
			],
			ROOM,
		);

		const text = stripTime(history.map((entry) => String(entry.content)).join("\n"));
		expect(text).not.toContain("> 用户:");
		expect(text).toContain("明天下班前");
	});

	it("tail-annotates reacted messages with the same tally the spec asserts (W8)", () => {
		const history = buildHistoryMessages(
			[
				message({
					role: "assistant",
					agentId: "fe",
					content: "接口写完了",
					reactions: [
						{
							emoji: "👍",
							by: [{ type: "user" }, { type: "agent", agentId: "pm" }],
						},
					],
				}),
				message({
					role: "user",
					content: "辛苦",
					reactions: [{ emoji: "🎉", by: [{ type: "agent", agentId: "fe" }] }],
				}),
			],
			ROOM,
		);

		const text = stripTime(history.map((entry) => String(entry.content)).join("\n"));
		expect(text).toContain('<message from="小李#fe">接口写完了 (👍×2)');
		expect(text).toContain('<message from="用户#user">辛苦 (🎉)');
	});

	it("never annotates the activated agent’s own messages", () => {
		// ROOM's agentId is 'pm', so this line is the activated agent's own —
		// appending a tally would put words it never wrote into its own transcript.
		const history = buildHistoryMessages(
			[
				message({
					role: "assistant",
					agentId: "pm",
					content: "我来评审",
					reactions: [{ emoji: "👍", by: [{ type: "user" }] }],
				}),
			],
			ROOM,
		);
		const text = stripTime(history.map((entry) => String(entry.content)).join("\n"));
		expect(text).toContain('<message from="阿明#pm">我来评审</message>');
		expect(text).not.toContain("👍");
	});

	/**
	 * 载荷的形状本身(docs/design/collab-chatroom-payload.md §1)。整间房是一条
	 * user 消息 —— 房间侧一个 assistant 轮都没有,上下文里因此没有「该你接话」
	 * 的槽位:要产生任何效果只能调工具。
	 */
	describe("<ChatRoom> 载荷", () => {
		it("整间房是一条 user 消息,Members 含自己并标 self", () => {
			const history = buildHistoryMessages(
				[
					message({ role: "user", content: "登录页什么时候能好?" }),
					message({ role: "assistant", agentId: "fe", content: "明天下班前" }),
					message({ role: "assistant", agentId: "pm", content: "我盯着" }),
				],
				ROOM,
			);

			expect(history).toHaveLength(1);
			expect(history[0].role).toBe("user");
			expect(stripTime(String(history[0].content))).toBe(
				[
					'<ChatRoom id="room-1" name="官网改版组">',
					"<Members>",
					'<Member name="用户" handle="user" role="用户"/>',
					// ROOM.agentId 是 pm:它自己那一条,也只有它那一条,带 self。
					'<Member name="阿明" handle="pm" role="产品经理" self="true"/>',
					'<Member name="小李" handle="fe" role="前端工程师"/>',
					"</Members>",
					"<History>",
					'<message from="用户#user">登录页什么时候能好?</message>',
					'<message from="小李#fe">明天下班前</message>',
					'<message from="阿明#pm">我盯着</message>',
					"</History>",
					"</ChatRoom>",
				].join("\n"),
			);
		});

		/**
		 * 其余用例都把 `time` 剥掉了(夹具走真实时钟),所以这一条是**唯一**
		 * 守着它的地方 —— 剥了又没人钉,等于悄悄删了这个属性。
		 */
		it("每条消息都带落库时间,房间带 id(say 的 room 参数收的就是它)", () => {
			const at = new Date(2026, 7, 1, 9, 12).getTime();
			const history = buildHistoryMessages(
				[message({ role: "user", content: "在吗", timestamp: at })],
				ROOM,
			);
			const content = String(history[0].content);
			expect(content).toContain('<ChatRoom id="room-1" name="官网改版组">');
			expect(content).toContain(
				'<message from="用户#user" time="2026-08-01 09:12">在吗</message>',
			);
		});

		it("时间戳缺失就不写 time,不编一个出来", () => {
			const history = buildHistoryMessages(
				[
					{
						id: "m1",
						role: "user",
						content: "在吗",
					} as unknown as ChatMessage,
				],
				ROOM,
			);
			expect(String(history[0].content)).toContain(
				'<message from="用户#user">在吗</message>',
			);
		});

		it("整份上下文里没有一个 assistant 轮", () => {
			const history = buildHistoryMessages(
				[
					message({ role: "user", content: "在吗" }),
					message({ role: "assistant", agentId: "pm", content: "在" }),
					message({ role: "assistant", agentId: "fe", content: "我也在" }),
				],
				ROOM,
			);
			expect(history.map((entry) => entry.role)).toEqual(["user"]);
		});

		it("自己带 toolCalls 的旧转录:调用拍平进正文,一条都不丢", () => {
			// W18 之前 toolCalls 挂在自身消息上。塌成文本时丢掉它们,留下的
			// tool_result 就成了孤儿 —— provider 400 的经典造法。
			const history = buildHistoryMessages(
				[
					message({
						role: "assistant",
						agentId: "pm",
						content: "查了看板",
						toolCalls: [
							{ toolName: "board", arguments: { action: "list" }, result: "ok" },
						] as unknown as ChatMessage["toolCalls"],
					}),
				],
				ROOM,
			);
			expect(stripTime(String(history[0].content))).toContain(
				'<message from="阿明#pm">查了看板\n〔调用 board({"action":"list"}) → ok〕</message>',
			);
			expect(history.some((entry) => entry.role === "tool")).toBe(false);
		});

		it("attachments 归拢到这一条上,id 取第一条房间消息的", () => {
			// 单块之后没有别的行可挂 —— 归拢就是 merge pass 一直在做的事(决定 4);
			// id 取首行则让 summaryUpToMessageId 的匹配面不变(决定 5)。
			const first = message({
				id: "m-first",
				role: "user",
				content: "看这个",
				attachments: [
					{ id: "a1", name: "a.png", type: "image" },
				] as unknown as ChatMessage["attachments"],
			});
			const second = message({
				id: "m-second",
				role: "user",
				content: "还有这个",
				attachments: [
					{ id: "a2", name: "b.png", type: "image" },
				] as unknown as ChatMessage["attachments"],
			});
			const projected = projectRoomMessagesForModel([first, second], ROOM);

			expect(projected).toHaveLength(1);
			expect(projected[0].id).toBe("m-first");
			expect(projected[0].attachments?.map((item) => item.id)).toEqual([
				"a1",
				"a2",
			]);
		});

		/**
		 * 纯 spec 与生产适配器**逐字同源**。
		 *
		 * 这两个函数互为镜像已经写在两边的注释里很久了,靠的却一直是"约定" ——
		 * 只改一边 = 测试全绿而真机没变,而真机没变的那一半没有任何断言看得见。
		 * 载荷本身现在由同一个 builder 组装,这条用例钉住的是走到 builder 之前
		 * 的那一段:五类消息的取舍、信封署名、@ 重绘、引用行与表情统计。
		 */
		it("纯 spec 与生产适配器投出同一段文本", () => {
			const transcript = [
				message({
					role: "user",
					content: "@小李 登录页什么时候能好?",
					mentions: [{ agentId: "fe", label: "小李" }],
				}),
				message({
					role: "assistant",
					agentId: "fe",
					content: "明天下班前",
					source: "collab-say",
					replyTo: {
						messageId: "m1",
						authorLabel: "用户",
						excerpt: "登录页什么时候能好?",
					},
					reactions: [{ emoji: "👍", by: [{ type: "user" }] }],
				}),
				message({
					role: "assistant",
					agentId: "pm",
					content: "我查了看板",
					toolCalls: [
						{ toolName: "board", arguments: { action: "list" }, result: "ok" },
					] as unknown as ChatMessage["toolCalls"],
				}),
				message({
					role: "system",
					content: "「登录页」已指派给 小李",
					source: "collab-task",
				}),
				message({ role: "user", content: "(小李 · 被 @ 激活)", source: "collab" }),
			];

			const production = projectRoomMessagesForModel(transcript, ROOM);
			const spec = projectRoomHistory({
				messages: transcript.map((entry) => ({
					...entry,
					// 纯 spec 的 toolCalls 是 {name, …};ChatMessage 那一侧叫 toolName。
					...(entry.toolCalls
						? {
								toolCalls: entry.toolCalls.map((call) => ({
									name: call.toolName,
									arguments: call.arguments,
									result: call.result,
								})),
							}
						: {}),
				})) as Parameters<typeof projectRoomHistory>[0]["messages"],
				selfAgentId: "pm",
				agents: [
					{ id: "pm", name: "阿明", title: "产品经理" },
					{ id: "fe", name: "小李", title: "前端工程师" },
				],
				roomId: "room-1",
				roomName: "官网改版组",
				userLabel: "用户",
				userHandle: "user",
			});

			expect(production).toHaveLength(1);
			expect(stripTime(String(production[0].content))).toBe(
				stripTime(spec[0].content),
			);
		});

		it("一条都投不出来时什么也不投", () => {
			expect(
				buildHistoryMessages(
					[
						message({
							role: "system",
							content: "今天这个房间已花费 $5.00",
							source: "collab",
						}),
					],
					ROOM,
				),
			).toEqual([]);
		});
	});

	/**
	 * 房回合就是一条普通会话（collab-agent-view-v3.md V2）。
	 *
	 * 这一组原来守的是 `kind === 'agent'` 特判：整间房每回合重投影 + 自己的历史
	 * 整份丢弃、只捞最后一条 drive。那段代码 2026-08-02 删了，所以这一组整体重写
	 * ——它现在守的是**相反**的契约：执行会话原样透传，房间内容由 drive 携带
	 * （V1，`turn.ts` 的 `buildDriveRoomContext`）。
	 */
	describe("执行会话 = 普通会话（v3 V2）", () => {
		const AGENT_SESSION = {
			id: "agent-exec-fe",
			kind: "agent",
			agentId: "fe",
			collab: { roomSessionId: "room-1" },
		};

		it("原样透传：自己的历史全在，不再重投影那间房", () => {
			rooms.set("room-1", {
				id: "room-1",
				kind: "room",
				messages: [message({ role: "user", content: "房里说过的话" })],
			});

			const history = buildHistoryMessages(
				[
					message({
						role: "user",
						content: '<msg from="用户#user">昨天定了方向</msg>\n<turn reason="被 @ 激活"/>',
						source: "collab",
					}),
					message({ role: "assistant", agentId: "fe", content: "内部盘算", source: "collab-turn" }),
					message({
						role: "user",
						content: '<msg from="阿明#pm">收到</msg>\n<turn reason="被 @ 激活"/>',
						source: "collab",
					}),
				],
				AGENT_SESSION,
			);

			const text = history.map((entry) => String(entry.content)).join("\n");
			// 房间内容来自 drive，不是重投影 —— 房里那条没进 drive 的话不该出现
			expect(text).toContain("昨天定了方向");
			expect(text).toContain("收到");
			expect(text).not.toContain("房里说过的话");
			// 自己上一轮的输出**在历史里**，这正是狼人杀那个 bug 的根治点
			expect(text).toContain("内部盘算");
			expect(history.some((entry) => entry.role === "assistant")).toBe(true);
		});

		it("真的是普通会话：与同内容的 chat 会话逐字同解", () => {
			const messages = [
				message({ role: "user", content: "第一轮", source: "collab" }),
				message({ role: "assistant", agentId: "fe", content: "答一句", source: "collab-turn" }),
			];
			expect(buildHistoryMessages(messages, AGENT_SESSION)).toEqual(
				buildHistoryMessages(messages, { id: "s1", kind: "chat" }),
			);
		});

		it("房间不存在也不再返回空 —— 它读的是自己的历史，不是那间房", () => {
			rooms.clear();
			const history = buildHistoryMessages(
				[message({ role: "user", content: "还在这儿", source: "collab" })],
				AGENT_SESSION,
			);
			expect(history).toHaveLength(1);
		});

		it("compaction 锚点正常命中自己的历史（#turn-drive 那个 hack 已随特判删除）", () => {
			const history = buildHistoryMessages(
				[
					message({ id: "d1", role: "user", content: "老的一轮", source: "collab" }),
					message({ role: "assistant", agentId: "fe", content: "老的回答", source: "collab-turn" }),
					message({ id: "d2", role: "user", content: "新的一轮", source: "collab" }),
				],
				{ ...AGENT_SESSION, summary: "前情摘要", summaryUpToMessageId: "d1" },
			);
			const text = history.map((entry) => String(entry.content)).join("\n");
			expect(text).toContain("前情摘要");
			expect(text).not.toContain("老的一轮");
			expect(text).toContain("新的一轮");
		});
	});


	it("leaves ordinary sessions untouched", () => {
		const messages = [
			message({ role: "user", content: "你好" }),
			message({ role: "system", content: "不该出现", source: "collab-task" }),
			message({ role: "assistant", content: "你好呀" }),
		];
		const history = buildHistoryMessages(messages, { id: "s1", kind: "chat" });
		expect(history).toEqual([
			{ role: "user", content: "你好" },
			{ role: "assistant", content: "你好呀" },
		]);
	});
});
