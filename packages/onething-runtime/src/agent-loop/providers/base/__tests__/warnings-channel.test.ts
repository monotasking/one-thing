/**
 * warnings 通道(P0b-A 的 A4,设计稿 §2.4「被丢弃的设置也要留痕」)。
 *
 * `AgentTurnStreamEvent.finish` 上的 `warnings?` 是 §8 的契约增量,**还没拍板**
 * —— 在那之前这条通道的出口只有 `HttpAgentProvider.finishEvent` 里那一行
 * `log.debug('turn warnings', …)`。所以这份门直接对**回合**断言:构造一次
 * TurnContext,让那家配方的策略对象往上写,再数 warnings。
 *
 * 关键不变式:**warnings 是旁路元数据,不进请求体**。每个用例都顺带断言
 * builder 的字节与「没有 warning 时」一致 —— 快照零变化的根据就在这里。
 */
import { describe, expect, it } from "vitest";
import { GITHUB_COPILOT_DIALECT, DEEPSEEK_DIALECT } from "../../dialects/index.js";
import { OpenAIChatPartCodec } from "../../wires/index.js";
import {
	LedgerModelProfileResolver,
	RequestBodyBuilder,
	TurnContext,
	noThinkingWire,
	openAISamplingPolicy,
	openAIToolChoicePolicy,
	type Dialect,
} from "../index.js";
import { getLogger } from "../../../../logging/index.js";
import type { AgentTurnRequest } from "@onething/core/agent-loop";

function turnFor(providerId: string, request: AgentTurnRequest): TurnContext {
	const profile = new LedgerModelProfileResolver().resolveSync(
		providerId,
		request.model,
	);
	return new TurnContext(
		request,
		profile,
		new RequestBodyBuilder(),
		getLogger(`providers.${providerId}`),
	);
}

/** 一份配方在一个回合上会写的横切策略,顺序与模板方法一致。 */
function applyCrossCuttingPolicies(dialect: Dialect, turn: TurnContext): void {
	const thinking =
		dialect.reasoning.find((wire) => wire.id === turn.profile.reasoningWire) ??
		dialect.reasoning[0] ??
		noThinkingWire;
	thinking.encode(turn, turn.builder);
	(dialect.sampling ?? openAISamplingPolicy).apply(turn, turn.builder);
}

describe("warnings —— 被丢掉的设置留痕", () => {
	it("copilot:思考发不出去记 thinking-unsupported,温度记 setting-dropped", () => {
		const turn = turnFor("github-copilot", {
			messages: [{ role: "user", content: "hi" }],
			model: "gpt-5.5",
			turn: 1,
			thinking: "enabled",
			reasoningEffort: "high",
			temperature: 0.3,
		});
		applyCrossCuttingPolicies(GITHUB_COPILOT_DIALECT, turn);

		// 两条 warning 是两件事:线协议表达不了思考(`thinking-unsupported`),
		// 与模型不收这个采样参数(`setting-dropped`)。
		expect(turn.warnings.map((warning) => warning.kind)).toEqual([
			"thinking-unsupported",
			"setting-dropped",
		]);
		expect(turn.warnings.map((warning) => warning.toText())).toEqual([
			"[thinking-unsupported] thinking is not expressible on this endpoint and was not sent",
			"[setting-dropped] temperature is not sent while thinking is enabled",
		]);
		// 旁路:这两条策略一个字节都没往请求体里写。
		expect(turn.builder.build()).toEqual({});
	});

	it("copilot:thinking 关着就没有 warning,temperature 照发", () => {
		const turn = turnFor("github-copilot", {
			messages: [{ role: "user", content: "hi" }],
			model: "gpt-5.5",
			turn: 1,
			thinking: "disabled",
			temperature: 0.3,
		});
		applyCrossCuttingPolicies(GITHUB_COPILOT_DIALECT, turn);
		expect(turn.warnings).toEqual([]);
		expect(turn.builder.build()).toEqual({ temperature: 0.3 });
	});

	it("deepseek:思考是推断出来的,温度按推断后的值丢", () => {
		const turn = turnFor("deepseek", {
			messages: [{ role: "user", content: "hi" }],
			model: "deepseek-reasoner",
			turn: 1,
			temperature: 0.3,
		});
		applyCrossCuttingPolicies(DEEPSEEK_DIALECT, turn);
		expect(turn.warnings.map((warning) => warning.kind)).toEqual([
			"setting-dropped",
		]);
		expect(turn.builder.get("temperature")).toBeUndefined();
	});

	it("codec:进不了请求体的附件留一条 part-undeliverable", () => {
		const turn = turnFor("openai", {
			messages: [],
			model: "gpt-5.5",
			turn: 1,
		});
		const codec = new OpenAIChatPartCodec();
		const message = codec.toWireMessage(
			{
				role: "user",
				content: [
					{ type: "text", text: "看看这份 PDF" },
					{
						type: "file",
						data: "JVBERi0xLjcK",
						mediaType: "application/pdf",
						filename: "spec.pdf",
					},
				],
			},
			turn,
		);

		expect(turn.warnings.map((warning) => warning.kind)).toEqual([
			"part-undeliverable",
		]);
		expect(turn.warnings[0]!.fields).toMatchObject({
			partType: "file",
			reason: "wire-has-no-part",
		});
		// 留痕之外,可见替身仍然进请求体 —— 模型知道有过这个附件。
		expect(JSON.stringify(message.content)).toContain("spec.pdf");
	});

	/**
	 * #5b —— 账本说这个模型不收强制调用(智谱全系 / Kimi K2.x),序列化器把
	 * `required` 与指名函数一律降成 `'auto'` 并留痕。这是引擎之外的**第二道
	 * 保险**:最后一个能看见线上字节的人在这里兜底。
	 */
	it("tool-choice:账本说不能强制,指名函数降成 auto 并留痕", () => {
		const turn = turnFor("zhipu", {
			messages: [{ role: "user", content: "hi" }],
			model: "glm-5",
			turn: 1,
			toolChoice: { type: "function", function: { name: "read_file" } },
		});
		turn.builder.set("tools", [{ type: "function", function: { name: "read_file" } }]);
		openAIToolChoicePolicy.apply(turn, turn.builder);

		expect(turn.builder.get("tool_choice")).toBe("auto");
		expect(turn.warnings.map((warning) => warning.kind)).toEqual([
			"tool-choice-downgraded",
		]);
		expect(turn.warnings[0]!.fields).toMatchObject({
			requested: "function:read_file",
			sent: "auto",
			model: "glm-5",
		});
	});

	it("tool-choice:账本说得了强制(K3)就原样发,不留痕", () => {
		const turn = turnFor("kimi", {
			messages: [{ role: "user", content: "hi" }],
			model: "kimi-k3",
			turn: 1,
			toolChoice: "required",
		});
		turn.builder.set("tools", [{ type: "function", function: { name: "read_file" } }]);
		openAIToolChoicePolicy.apply(turn, turn.builder);

		expect(turn.builder.get("tool_choice")).toBe("required");
		expect(turn.warnings).toEqual([]);
	});

	it("没有 turn 也能序列化(P2 的投递契约矩阵没有回合)", () => {
		const codec = new OpenAIChatPartCodec();
		const delivery = codec.user({
			type: "file",
			data: "JVBERi0xLjcK",
			mediaType: "application/pdf",
			filename: "spec.pdf",
		});
		expect(delivery.kind).toBe("undeliverable");
	});
});
