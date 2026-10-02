/**
 * 私聊房的纯规则(docs/design/agent-im-dm.md D1/D6/D7 + §2.3)。
 *
 * 四件事钉在这里,每一件都是"群房一个字不动"的另一半:
 *  1. 形态判定:人数即形态,标记必须真的写进去;
 *  2. D6 免判:单成员房里用户说话 = @ 了唯一那位(合成 mention,不另开路径),
 *     冻结时照样报「被按住了」——省的是判定,不是任何一道闸;
 *  3. D7 工具面:dm 走自己那一格,恒 union(群房那一格若再收紧也波及不到);
 *  4. §2.3 文案:私聊有自己的情况说明,群版输出**字节级不变**。
 */
import { describe, expect, it } from "vitest";
import { decideCollabActivations } from "../activation.js";
import { isAgentPairDmRoom, isUserDmRoom } from "../dm.js";
import { buildCollabCommonRules } from "../agent-rules.js";
import {
	buildCollabRoomContext,
	buildCollabRoomSystemPrompt,
} from "../roster.js";
import { resolveAgentToolSurface } from "../../agents/profile.js";
import type { CollabAgentLike } from "../types.js";

const FE: CollabAgentLike = { id: "fe", name: "小李", title: "工程师" };
const PM: CollabAgentLike = { id: "pm", name: "阿明", title: "产品" };

describe("isUserDmRoom / isAgentPairDmRoom — 人数即形态", () => {
	it("单成员 + 标记 = 用户托管私聊", () => {
		expect(isUserDmRoom({ dm: true, memberAgentIds: ["fe"] })).toBe(true);
		expect(isAgentPairDmRoom({ dm: true, memberAgentIds: ["fe"] })).toBe(false);
	});

	it("双成员 + 标记 = agent 互聊(本期只判形态,无消费方)", () => {
		expect(isAgentPairDmRoom({ dm: true, memberAgentIds: ["fe", "pm"] })).toBe(
			true,
		);
		expect(isUserDmRoom({ dm: true, memberAgentIds: ["fe", "pm"] })).toBe(
			false,
		);
	});

	it("没有标记的单成员房不是私聊 —— 行为分支只认写进去的事实", () => {
		expect(isUserDmRoom({ memberAgentIds: ["fe"] })).toBe(false);
		expect(isUserDmRoom(undefined)).toBe(false);
		expect(isUserDmRoom(null)).toBe(false);
		expect(isUserDmRoom({ dm: true, memberAgentIds: [] })).toBe(false);
	});
});

describe("D6 免判激活", () => {
	it("用户随便说一句就激活唯一那位成员,理由与被 @ 同一档", () => {
		expect(
			decideCollabActivations({
				authorKind: "user",
				text: "帮我看看首页那个报错",
				members: [FE],
				chainCount: 0,
				maxChain: 20,
				dmSoleMember: true,
			}),
		).toEqual({ activations: [{ agentId: "fe", reason: "mention" }] });
	});

	it("真写了 @ 也只排一条 —— 两种写法落成同一条激活", () => {
		expect(
			decideCollabActivations({
				authorKind: "user",
				text: "@小李 看一下",
				mentions: [{ agentId: "fe", label: "小李" }],
				members: [FE],
				chainCount: 0,
				maxChain: 20,
				dmSoleMember: true,
			}).activations,
		).toEqual([{ agentId: "fe", reason: "mention" }]);
	});

	it('冻结的私聊房照样报"被按住了" —— 私聊里没写 @ 也是点名', () => {
		expect(
			decideCollabActivations({
				authorKind: "user",
				text: "在吗",
				members: [FE],
				chainCount: 0,
				maxChain: 20,
				frozen: true,
				dmSoleMember: true,
			}),
		).toEqual({ activations: [], blockedByFrozen: true });
	});

	it("唯一成员已退休/查无此人时(在职名册为空)合成不出激活", () => {
		expect(
			decideCollabActivations({
				authorKind: "user",
				text: "在吗",
				members: [],
				chainCount: 0,
				maxChain: 20,
				dmSoleMember: true,
			}),
		).toEqual({ activations: [] });
	});

	it("agent 自己的发言不免判(D3 的双成员语义留给 IM P3)", () => {
		expect(
			decideCollabActivations({
				authorKind: "agent",
				authorAgentId: "pm",
				text: "收到",
				members: [FE],
				chainCount: 0,
				maxChain: 20,
				dmSoleMember: true,
			}).activations,
		).toEqual([]);
	});

	it("群房行为守恒:不带 dmSoleMember 的单成员房仍然没人被激活", () => {
		expect(
			decideCollabActivations({
				authorKind: "user",
				text: "帮我看看首页那个报错",
				members: [FE],
				chainCount: 0,
				maxChain: 20,
			}).activations,
		).toEqual([]);
	});
});

describe("D7 dm 工具面 = union", () => {
	it("白名单 ∪ send_message/board/history,与群房当前语义同解但走自己那一格", () => {
		expect(
			resolveAgentToolSurface({
				sessionKind: "agent",
				sessionDm: true,
				ownTools: ["read"],
			}),
		).toEqual(["read", "send_message", "board", "history", "notebook"]);
		expect(
			resolveAgentToolSurface({
				sessionKind: "room",
				sessionDm: true,
				ownTools: ["read", "send_message"],
			}),
		).toEqual(["read", "send_message", "board", "history"]);
	});

	it("没有白名单 = 不限制(union 之后即全量)", () => {
		expect(
			resolveAgentToolSurface({ sessionKind: "agent", sessionDm: true }),
		).toBeNull();
	});

	it("dm 走的确实是 collab-dm 那一格,且它是 union", () => {
		expect(
			resolveAgentToolSurface({
				ownTools: ["bash"],
				sessionKind: "agent",
				sessionDm: true,
			}),
		).toEqual(["bash", "send_message", "board", "history", "notebook"]);
		expect(
			resolveAgentToolSurface({
				ownTools: null,
				sessionKind: "agent",
				sessionDm: true,
			}),
		).toBeNull();
		// 显式 grant 也是 union(会话 kind 推出来的那一格与手写 grant 同解)
		expect(
			resolveAgentToolSurface({ ownTools: ["bash"], grants: ["collab-dm"] }),
		).toEqual(["bash", "send_message", "board", "history"]);
	});

	it("dm 标记不越界到工作台会话", () => {
		expect(
			resolveAgentToolSurface({
				sessionKind: "work",
				sessionDm: true,
				ownTools: ["read"],
			}),
		).toEqual(["read", "board", "send_message", "notebook"]);
		expect(
			resolveAgentToolSurface({
				sessionKind: "chat",
				sessionDm: true,
				ownTools: ["read"],
			}),
		).toEqual(["read"]);
	});
});

describe("§2.3 dm 情况说明", () => {
	const base = { self: FE, members: [FE], roomName: "小李" };

	it("说的是私聊、替用户办事,并给出轻重活分界", () => {
		const context = buildCollabRoomContext({ ...base, dm: true });
		expect(context).toContain('<chat with="用户">');
		expect(context).toContain("A one-on-one conversation");
		expect(context).toContain("is your work to do, on their behalf");
		expect(context).toContain("`board` start");
		// 工具面措辞与 union 一致 —— 绝不能出现"除 say 和 board 外没有其他工具"那类收紧口径
		expect(context).toContain("Everything you normally have works here");
		expect(context).not.toContain("room");
	});

	it('私聊里没有花名册、没有"@ 某位成员"、没有指派给别人', () => {
		const context = buildCollabRoomContext({ ...base, dm: true });
		expect(context).not.toContain("<room");
		expect(context).not.toContain("@name");
		expect(context).not.toContain("assign");
	});

	it("群房文案零改动:仍是群版情况说明,dm 分支一个字都没渗进去", () => {
		const context = buildCollabRoomContext({
			self: FE,
			members: [FE, PM],
			roomName: "官网改版组",
		});
		expect(context).toContain("the room 「官网改版组」");
		expect(context).toContain("- 用户");
		expect(context).toContain("- 阿明#pm(产品)");
		expect(context).not.toContain("one-on-one");
		expect(context).not.toContain("private chat");
	});

	it("通用规则:与场子无关的那几条三版逐字相同,只有场子措辞随房间改", () => {
		const group = buildCollabCommonRules();
		const dm = buildCollabCommonRules({ dm: true });
		const pair = buildCollabCommonRules({ pair: true });
		// 2026-08-01 整理:"你在什么场子里"那句事实已经移进 `<where_you_are>`
		// (roster.ts),规则块不再复述 —— 它此前是那句话的第二份逐字副本。
		for (const rules of [group, dm, pair]) {
			expect(rules).not.toContain("You are in a");
			expect(rules).not.toContain("stays in this session");
			expect(rules.startsWith("<rules>")).toBe(true);
			expect(rules.endsWith("</rules>")).toBe(true);
		}
		// 标签白名单、验真、卡状态现查、轻重活分界、被指派≠开工、不客套 —— 这几条
		// 与"在哪个场子"无关,三版必须一个字不差(行为守恒的可执行版本)。
		// 2026-08-02 少了一条:「Your reply reaches the room only through `say`…
		// Before the turn ends…」那条收尾检查规则已删(A.3 念经裁撤),机制只在
		// `<where_you_are>` 说一次。
		// 2026-08-02:私聊那几条不再靠工具名 `dm` 认(它并进了 `send_message` 的
		// `to`,collab-send-channel-and-wake.md §4),改认"这条讲的是私聊"本身。
		const sceneFree = (text: string) =>
			text
				.split("\n")
				.filter((line) => line.startsWith("- ")
					&& !line.includes("private chat")
					&& !line.includes("with `to"));
		expect(sceneFree(group)).toHaveLength(6);
		expect(sceneFree(dm)).toEqual(sceneFree(group));
		expect(sceneFree(pair)).toEqual(sceneFree(group));
		// §5 规则 2/3:结论送回哪儿、干活现场在哪,两处随场子改 —— 用户私聊里
		// "正经活回大群"会与上面的轻重活分界直接打架,所以那一版说的是这间房本身。
		expect(group).toContain("Bring the conclusion back to the room");
		expect(pair).toContain("Bring the conclusion back into this chat");
		// 收尾检查那一条确实不在了。
		for (const rules of [group, dm, pair]) {
			expect(rules).not.toContain("Before the turn ends");
			expect(rules).not.toContain("turn text");
		}
		expect(dm).toContain("work that is yours gets a card and gets done right here");
		expect(group).toContain("anything hands-on goes back to the room as a card");
		expect(pair).toContain("anything hands-on goes back to the room as a card");
	});

	it("系统提示词整体:persona 原文 + dm 情况说明 + dm 通用规则", () => {
		const prompt = buildCollabRoomSystemPrompt({
			...base,
			dm: true,
			personaPrompt: "你是小李,写前端。",
			includeCommonRules: true,
		});
		expect(prompt.startsWith("你是小李,写前端。")).toBe(true);
		expect(prompt).toContain('<chat with="用户">');
		expect(prompt).toContain("A one-on-one conversation");
		expect(prompt).toContain("<rules>");
		expect(prompt.endsWith("</workspace>")).toBe(true);
	});
});
