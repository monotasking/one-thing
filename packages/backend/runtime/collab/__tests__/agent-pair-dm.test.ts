/**
 * agent ↔ agent 私聊的纯规则(docs/design/agent-im-dm.md D3/D6/§3.3/§3.4)。
 *
 * 四件事钉在这里,每一件都是"群房与单成员私聊都不受影响"的另一半:
 *  1. D6 的另一半:双成员房里 **agent 的发言** 直接激活对面那位(合成 mention,
 *     与单成员房同一条路径),而 **用户插话** 照旧走既有 mention/判定;
 *  2. §3.3 链长闸:乒乓在第 6 条被掐断,而且掐断时 `blockedByChain` 立起来 ——
 *     那正是既有收场行为(房里贴「我先按住了」)的触发条件;
 *  3. §3.4 工具面:say/board/dm 三件套是群房那一格,dm 房不 fork;
 *  4. §3.1/D4 文案:双人房有自己的情况说明(用户是旁观者,不是群成员),
 *     群版与单成员私聊版一个字不动。
 */
import { describe, expect, it } from "vitest";
import { decideCollabActivations } from "../activation.js";
import { COLLAB_DM_PAIR_MAX_CHAIN } from "../types.js";
import { COLLAB_ROOM_TOOLS } from "../tool-surface.js";
// 工具面的唯一实现在 agents 层(C2「工具面单点」):collab 只出地板表。
import { resolveAgentToolSurface } from "../../agents/profile.js";
import {
	buildCollabRoomContext,
	buildCollabRoomSystemPrompt,
} from "../roster.js";
import type { CollabAgentLike } from "../types.js";

const FE: CollabAgentLike = { id: "fe", name: "小李", title: "工程师" };
const PM: CollabAgentLike = { id: "pm", name: "阿明", title: "产品" };
const PAIR = [FE, PM];

describe("D6 免判激活 —— 双成员房的那一半", () => {
	it("agent 说一句就激活对面那位,理由与被 @ 同一档", () => {
		expect(
			decideCollabActivations({
				authorKind: "agent",
				authorAgentId: "fe",
				text: "这个接口我打算改成分页的,你怎么看",
				members: PAIR,
				chainCount: 0,
				maxChain: COLLAB_DM_PAIR_MAX_CHAIN,
				dmPairPeer: true,
			}),
		).toEqual({ activations: [{ agentId: "pm", reason: "mention" }] });
	});

	it("真写了 @ 也只排一条 —— 两种写法落成同一条激活", () => {
		expect(
			decideCollabActivations({
				authorKind: "agent",
				authorAgentId: "fe",
				text: "@阿明 你怎么看",
				mentions: [{ agentId: "pm", label: "阿明" }],
				members: PAIR,
				chainCount: 0,
				maxChain: COLLAB_DM_PAIR_MAX_CHAIN,
				dmPairPeer: true,
			}).activations,
		).toEqual([{ agentId: "pm", reason: "mention" }]);
	});

	it("用户插话**不**免判:旁观者说一句不该强行把两个人都拉起来", () => {
		expect(
			decideCollabActivations({
				authorKind: "user",
				text: "你们聊,我看看",
				members: PAIR,
				chainCount: 0,
				maxChain: COLLAB_DM_PAIR_MAX_CHAIN,
				dmPairPeer: true,
			}).activations,
		).toEqual([]);
	});

	it("用户点名照旧生效 —— 免判分支没有夺走既有的 @ 语义", () => {
		expect(
			decideCollabActivations({
				authorKind: "user",
				text: "@小李 这个我同意",
				mentions: [{ agentId: "fe", label: "小李" }],
				members: PAIR,
				chainCount: 0,
				maxChain: COLLAB_DM_PAIR_MAX_CHAIN,
				dmPairPeer: true,
			}).activations,
		).toEqual([{ agentId: "fe", reason: "mention" }]);
	});

	it('作者不是这间房的成员:合成不出"对面"', () => {
		expect(
			decideCollabActivations({
				authorKind: "agent",
				authorAgentId: "ghost",
				text: "我路过说一句",
				members: PAIR,
				chainCount: 0,
				maxChain: COLLAB_DM_PAIR_MAX_CHAIN,
				dmPairPeer: true,
			}).activations,
		).toEqual([]);
	});

	it("对面已退休(调用方按在职过滤后只剩一位):不激活,也不误伤作者自己", () => {
		expect(
			decideCollabActivations({
				authorKind: "agent",
				authorAgentId: "fe",
				text: "在吗",
				members: [FE],
				chainCount: 0,
				maxChain: COLLAB_DM_PAIR_MAX_CHAIN,
				dmPairPeer: true,
			}).activations,
		).toEqual([]);
	});

	it('冻结的双人房不激活,但会报出"被按住了"(与单成员房同一条路径)', () => {
		expect(
			decideCollabActivations({
				authorKind: "agent",
				authorAgentId: "fe",
				text: "在吗",
				members: PAIR,
				chainCount: 0,
				maxChain: COLLAB_DM_PAIR_MAX_CHAIN,
				frozen: true,
				dmPairPeer: true,
			}),
		).toEqual({ activations: [], blockedByFrozen: true });
	});

	it("群房行为守恒:不带 dmPairPeer 的双成员房里,agent 发言不激活任何人", () => {
		expect(
			decideCollabActivations({
				authorKind: "agent",
				authorAgentId: "fe",
				text: "这个接口我打算改成分页的",
				members: PAIR,
				chainCount: 0,
				maxChain: 32,
			}).activations,
		).toEqual([]);
	});
});

describe("§3.3 链长闸:乒乓被第 6 条掐断", () => {
	it("A→B→A… 到默认上限停,停在那一刻 blockedByChain 立起来", () => {
		const speakers = ["fe", "pm"];
		let chainCount = 0;
		const spoke: string[] = [];
		let blocked = false;

		// 每一轮 = 一位成员说一句(chainCount += 1),然后房间决定要不要激活对面。
		for (let round = 0; round < 20; round++) {
			const authorAgentId = speakers[round % 2];
			const decision = decideCollabActivations({
				authorKind: "agent",
				authorAgentId,
				text: "收到",
				members: PAIR,
				chainCount,
				maxChain: COLLAB_DM_PAIR_MAX_CHAIN,
				dmPairPeer: true,
			});
			if (decision.activations.length === 0) {
				blocked = Boolean(decision.blockedByChain);
				break;
			}
			spoke.push(authorAgentId);
			chainCount += 1;
		}

		expect(spoke).toHaveLength(COLLAB_DM_PAIR_MAX_CHAIN);
		expect(spoke).toEqual(["fe", "pm", "fe", "pm", "fe", "pm"]);
		// 收场行为不是新写的:blockedByChain 就是 turn.ts 贴「我先按住了」的条件,
		// 而那一行说的正是"你说一句话,讨论就继续"—— 用户插话重置链,循环解开。
		expect(blocked).toBe(true);
	});

	it("房间显式配置照旧压过默认值(闸是可配置的,配了就要算数)", () => {
		const atTwo = decideCollabActivations({
			authorKind: "agent",
			authorAgentId: "fe",
			text: "再说一句",
			members: PAIR,
			chainCount: 2,
			maxChain: 2,
			dmPairPeer: true,
		});
		expect(atTwo).toEqual({ activations: [], blockedByChain: true });
	});
});

describe("§3.4 工具面:双人房走群房那一路", () => {
	it("send_message + board + history 是同一档,dm 房不 fork 出第二套", () => {
		// 2026-08-02 少了 `dm`:私聊并进 `send_message` 的 `to` 参数
		// (collab-send-channel-and-wake.md §2),旧名降为隐藏真工具,刻意不进这张表。
		expect(COLLAB_ROOM_TOOLS).toEqual(["send_message", "board", "history"]);
		// 双成员房不是 `dm: true` 那一格(D7 的 union 是单成员私聊的特权),它按普通
		// 群房解析 —— 今天两格的工具清单一样,但走的确实是不同的那一格。
		expect(
			resolveAgentToolSurface({ sessionKind: "agent", ownTools: ["read"] }),
		).toEqual(["read", "send_message", "board", "history", "notebook"]);
	});
});

describe("§3.1/D4 双人房情况说明", () => {
	const base = { self: FE, members: PAIR, roomName: "小李 ⇄ 阿明" };

	it("说清三件事:对面是谁、用户在旁观、没有搬运上下文", () => {
		const context = buildCollabRoomContext({ ...base, dmPair: true });
		expect(context).toContain('<chat with="阿明(产品)">');
		expect(context).toContain("A private chat between the two of you");
		expect(context).toContain("用户 can see this conversation and may step in");
		expect(context).toContain("cannot see the context you are coming from");
		// 沟通场:正经活回大群立卡(§5 规则 3),口径与通用规则一致。
		expect(context).toContain("anything hands-on goes back to the room as a card");
	});

	it("不是群:不念花名册,也不把用户说成群成员", () => {
		const context = buildCollabRoomContext({ ...base, dmPair: true });
		expect(context).not.toContain("<room");
		expect(context).not.toContain("Who is in it");
	});

	it("群房与单成员私聊的文案零改动", () => {
		const group = buildCollabRoomContext({
			self: FE,
			members: PAIR,
			roomName: "官网改版组",
		});
		expect(group).toContain("the room 「官网改版组」");
		expect(group).toContain("- 用户");
		expect(group).toContain("- 阿明#pm(产品)");
		const sole = buildCollabRoomContext({
			self: FE,
			members: [FE],
			roomName: "小李",
			dm: true,
		});
		expect(sole).toContain("A one-on-one conversation");
	});

	it("系统提示词整体:persona 原文 + 双人情况说明 + pair 版通用规则", () => {
		const prompt = buildCollabRoomSystemPrompt({
			...base,
			dmPair: true,
			personaPrompt: "你是小李,写前端。",
			includeCommonRules: true,
		});
		expect(prompt.startsWith("你是小李,写前端。")).toBe(true);
		expect(prompt).toContain('<chat with="阿明(产品)">');
		expect(prompt).toContain("A private chat between the two of you");
		expect(prompt).toContain("<rules>");
		expect(prompt.endsWith("</workspace>")).toBe(true);
	});
});
