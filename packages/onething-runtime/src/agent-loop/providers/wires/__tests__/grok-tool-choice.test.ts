/**
 * xAI 版 `tool_choice` 拼法 —— 「有工具才发」(2026-08-25)。
 *
 * xAI 的 Open Responses 端点不容忍「请求里没有工具却带 `tool_choice`」:
 * 400 "A tool_choice was set on the request but no tools were specified"。
 * compact 摘要 / 标题生成这类无工具旁线请求(`generateChatResponse`)以前每次
 * 都撞它 —— 压缩永远失败,引擎按设计「记错 + 放弃压缩继续发送」,于是 Grok
 * 会话的上下文只会一直滚大。
 *
 * 三条规矩,这份测试逐条守:
 *
 *  1. **grok / grok-oauth 两条通路同一份策略**(spec 共用):builder 里的工具表
 *     为空(`buildBody` 恒写 `tools`,空表也写 `[]`)就整个不写 `tool_choice`;
 *     有工具时照发,指名工具仍是这条线的扁平 `{type:'function', name}`。
 *  2. **判据是 builder 里的实际工具表**,不是 `request.tools` —— 原生工具
 *     (方言 `nativeTools` 挂进来的)也算数,与 `OpenAIToolChoicePolicy` 同规。
 *  3. **codex 一个字不变**:方言上没有自定义策略,继续走 wire 默认的「恒发」
 *     (`baseline.request.json` 钉着没有工具也发 `'auto'`)。
 */
import { describe, expect, it } from "vitest";
import { getLogger } from "../../../../logging/index.js";
import "../../dialects/index.js";
import {
	LedgerModelProfileResolver,
	RequestBodyBuilder,
	TurnContext,
	listDialects,
	type Dialect,
} from "../../base/index.js";
import { responsesToolChoicePolicy } from "../index.js";
import type { AgentTurnRequest } from "@onething/core/agent-loop";

const GROK_MODEL = "grok-4.6";

function dialectOf(dialectId: string): Dialect {
	const dialect = listDialects().find((entry) => entry.id === dialectId);
	if (!dialect) throw new Error(`unregistered dialect: ${dialectId}`);
	return dialect;
}

async function applyToolChoice(options: {
	dialectId: string;
	/** buildBody 之后 builder 里的工具表(它恒在,空表也写 `[]`)。 */
	bodyTools: unknown[];
	toolChoice?: AgentTurnRequest["toolChoice"];
}): Promise<RequestBodyBuilder> {
	const profile = await new LedgerModelProfileResolver({}).resolve(
		options.dialectId,
		GROK_MODEL,
	);
	const builder = new RequestBodyBuilder({ tools: options.bodyTools });
	const turn = new TurnContext(
		{
			turn: 1,
			model: GROK_MODEL,
			messages: [],
			...(options.toolChoice ? { toolChoice: options.toolChoice } : {}),
		},
		profile,
		builder,
		getLogger("test.grok-tool-choice"),
	);
	const policy = dialectOf(options.dialectId).toolChoice ?? responsesToolChoicePolicy;
	policy.apply(turn, builder);
	return builder;
}

const ONE_TOOL = [{ type: "function", name: "read", parameters: {} }];

describe("grok — tool_choice 只在真的带了工具时才发", () => {
	it("无工具(compact / 标题这类旁线请求):整个字段不写", async () => {
		const builder = await applyToolChoice({ dialectId: "grok", bodyTools: [] });
		expect(builder.has("tool_choice")).toBe(false);
	});

	it("有工具:照发 auto", async () => {
		const builder = await applyToolChoice({ dialectId: "grok", bodyTools: ONE_TOOL });
		expect(builder.get("tool_choice")).toBe("auto");
	});

	it("指名工具仍是这条线的扁平拼法", async () => {
		const builder = await applyToolChoice({
			dialectId: "grok",
			bodyTools: ONE_TOOL,
			toolChoice: { type: "function", function: { name: "read" } },
		});
		expect(builder.get("tool_choice")).toEqual({ type: "function", name: "read" });
	});

	it("grok-oauth 与 grok 同一份策略(spec 共用)", async () => {
		expect(dialectOf("grok-oauth").toolChoice).toBe(dialectOf("grok").toolChoice);
		const builder = await applyToolChoice({ dialectId: "grok-oauth", bodyTools: [] });
		expect(builder.has("tool_choice")).toBe(false);
	});

	it("codex 一个字不变:无自定义策略,wire 默认恒发(基线守卫)", async () => {
		expect(dialectOf("codex").toolChoice).toBeUndefined();
		const builder = await applyToolChoice({ dialectId: "codex", bodyTools: [] });
		expect(builder.get("tool_choice")).toBe("auto");
	});
});
