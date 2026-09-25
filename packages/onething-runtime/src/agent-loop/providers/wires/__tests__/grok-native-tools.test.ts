/**
 * xAI 服务端 `web_search` —— 带工具的回合挂上(2026-09-18)。
 *
 * 为什么开:grok-4.6 没挂这项时也会自己发起 `web_search_call`,服务端不执行、
 * 直接以 `completed` 收尾,会话表现为「说一句接着查就停了」。详见
 * `dialects/grok.ts` 的 `grokNativeTools`。
 *
 * 带工具的请求体由 wire 快照钉着(`responses/grok{,-oauth}/tools-*.request.json`
 * 末尾那一项 `{type:'web_search'}`);这里守三条边界:
 *
 *  1. 无工具的旁线请求(compact / 标题)不挂 —— 不该上网计费,也不能因为
 *     工具表非空把 `tool_choice` 带出去。
 *  2. `toolChoice: 'none'` 不挂。
 *  3. grok 与 grok-oauth 同一份;codex 不挂 `web_search`。
 *  4. 同名让位:原生 `web_search` 挂上时,我们的 `web_search` 函数工具不再
 *     进工具表(xAI 对重名 400 `Duplicate tool names: web_search`,09-18 实测);
 *     指名要这个函数的回合不挂原生。
 */
import { describe, expect, it } from "vitest";
import type { AgentTool, AgentTurnRequest } from "@onething/core/agent-loop";
import { getLogger } from "../../../../logging/index.js";
import "../../dialects/index.js";
import {
	LedgerModelProfileResolver,
	RequestBodyBuilder,
	TurnContext,
	listDialects,
} from "../../base/index.js";
import { toCodexTools, type ResponsesDialect } from "../index.js";

function fnTool(name: string): AgentTool {
	return {
		name,
		description: name,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: "" }) as never,
	};
}
const READ_TOOL = fnTool("read");
const WEB_SEARCH_FN = fnTool("web_search");

async function nativeToolsFor(
	dialectId: string,
	request: Partial<AgentTurnRequest>,
): Promise<unknown[]> {
	const dialect = listDialects().find((entry) => entry.id === dialectId) as
		| ResponsesDialect
		| undefined;
	if (!dialect) throw new Error(`unregistered dialect: ${dialectId}`);
	const model = dialectId === "codex" ? "gpt-5.5" : "grok-4.6";
	const profile = await new LedgerModelProfileResolver({}).resolve(dialectId, model);
	const turn = new TurnContext(
		{ turn: 1, model, messages: [], ...request },
		profile,
		new RequestBodyBuilder(),
		getLogger("test.grok-native-tools"),
	);
	return dialect.nativeTools?.(turn) ?? [];
}

describe("grok — 服务端 web_search 只在带工具的回合挂", () => {
	for (const dialectId of ["grok", "grok-oauth"]) {
		it(`${dialectId}:带工具 → 挂 web_search`, async () => {
			expect(await nativeToolsFor(dialectId, { tools: [READ_TOOL] })).toEqual([
				{ type: "web_search" },
			]);
		});

		it(`${dialectId}:无工具的旁线请求 → 不挂`, async () => {
			expect(await nativeToolsFor(dialectId, {})).toEqual([]);
			expect(await nativeToolsFor(dialectId, { tools: [] })).toEqual([]);
		});

		it(`${dialectId}:toolChoice 'none' → 不挂`, async () => {
			expect(
				await nativeToolsFor(dialectId, { tools: [READ_TOOL], toolChoice: "none" }),
			).toEqual([]);
		});
	}

	it("codex 不挂 web_search", async () => {
		const tools = await nativeToolsFor("codex", { tools: [READ_TOOL] });
		expect(tools).not.toContainEqual({ type: "web_search" });
	});

	it("指名要我们的 web_search 函数 → 不挂原生", async () => {
		expect(
			await nativeToolsFor("grok-oauth", {
				tools: [READ_TOOL, WEB_SEARCH_FN],
				toolChoice: { type: "function", function: { name: "web_search" } },
			}),
		).toEqual([]);
	});
});

describe("toCodexTools — 原生工具按 type 占名,同名函数工具让位", () => {
	it("原生 web_search 挂上 → 函数 web_search 不进表,其余照旧", () => {
		const tools = toCodexTools([READ_TOOL, WEB_SEARCH_FN], [{ type: "web_search" }]);
		expect(tools.map((t) => (t.type === "function" ? t.name : t.type))).toEqual([
			"read",
			"web_search",
		]);
		expect(tools.filter((t) => t.type === "function" && t.name === "web_search")).toEqual([]);
	});

	it("没有原生工具 → 函数 web_search 照发", () => {
		const tools = toCodexTools([READ_TOOL, WEB_SEARCH_FN]);
		expect(tools).toContainEqual(expect.objectContaining({ type: "function", name: "web_search" }));
	});
});
