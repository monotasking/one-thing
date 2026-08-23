/**
 * **请求级 providerOptions 袋**(设计稿 §2.8,P3-3)。
 *
 * 一句话:袋是按 providerId 命名空间装的,provider 只读自己那一格,并且**按
 * 白名单透传** —— 认得的键翻成请求体字段,认不得的键丢弃**并留痕**。
 *
 * 三件事各有各的门:
 *  1. `verbosity` 上顶层、非法值被丢 —— 走**生产入口**发一次真请求,因为它是
 *     `extraBody` 那半边写的(codec 先跑、`extraBody` 后跑,只测函数证明不了
 *     顺序);
 *  2. `image_url.detail` 与它按家不同的值域 —— 直接问已登记方言的 codec;
 *  3. 白名单是**方言的一份声明**,不是 codec 里的 `if (providerId === …)`:
 *     kimi 的块上一个 `detail` 都不长,openrouter 长,deepseek 还多认一个
 *     `original`。
 *
 * **`imageDetail` 是跨线协议的**(P4-4):xAI 的两条通路搬到 openai-responses
 * 之后,同一个袋键在那条线上写的是 `input_image.detail`(不是
 * `image_url.detail`)。同一份白名单机制、两条线各自一份声明 —— 这一条也
 * 在这里守着,免得「换线之后 detail 悄悄失效」。
 */
import { describe, expect, it } from "vitest";
import type { AgentContentPart, AgentMessage } from "@onething/core/agent-loop";
import { getLogger } from "../../../../logging/index.js";
import "../../dialects/index.js";
import {
	LedgerModelProfileResolver,
	RequestBodyBuilder,
	TurnContext,
	listDialects,
	type PartCodec,
	type PartDelivery,
} from "../../base/index.js";
import {
	captureWireRequest,
	sseResponse,
	SYSTEM_MESSAGE,
} from "../../__tests__/wire-snapshots/snapshot-harness.js";
import type { OpenAIChatUserContentPart } from "../openai-chat-messages.js";

const IMAGE_PART: AgentContentPart = {
	type: "image",
	image: "iVBORw0KGgoAAAANSUhEUg==",
	mediaType: "image/png",
};

const IMAGE_USER_MESSAGE: AgentMessage = {
	role: "user",
	content: [{ type: "text", text: "看看这张图。" }, IMAGE_PART],
};

const MINIMAL_STREAM = `data: ${JSON.stringify({
	choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
})}\n\ndata: [DONE]\n\n`;

/** openai-responses 那条线上的最短合法流(P4-5 起 `openai` 走它)。 */
const MINIMAL_RESPONSES_STREAM = `event: response.completed\ndata: ${JSON.stringify(
	{
		type: "response.completed",
		response: {
			id: "resp_provider_options",
			usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
		},
	},
)}\n\n`;

/** 已登记方言的 codec —— 与生产走的是同一只对象(配方里那只)。 */
function codecOf(dialectId: string): PartCodec {
	const dialect = listDialects().find((entry) => entry.id === dialectId);
	if (!dialect?.parts) throw new Error(`dialect has no codec: ${dialectId}`);
	return dialect.parts;
}

async function turnContextFor(
	providerId: string,
	model: string,
	bag?: Record<string, unknown>,
): Promise<TurnContext> {
	const profile = await new LedgerModelProfileResolver({}).resolve(
		providerId,
		model,
	);
	return new TurnContext(
		{
			turn: 1,
			model,
			messages: [],
			...(bag ? { providerOptions: { [providerId]: bag } } : {}),
		},
		profile,
		new RequestBodyBuilder(),
		getLogger("test.provider-options"),
	);
}

/**
 * 交出去的那一块。返回类型仍是 chat 的形状(这份门里绝大多数断言都在那条线
 * 上);Responses 那几家经 `responsesImagePart()` 再窄一次 —— 与
 * `grok / codex` 那两条既有断言的写法一致。
 */
function deliveredPart(
	delivery: PartDelivery<unknown>,
): OpenAIChatUserContentPart {
	expect(delivery.kind, JSON.stringify(delivery)).toBe("delivered");
	return (delivery as { part: OpenAIChatUserContentPart }).part;
}

function imageUrlOf(part: OpenAIChatUserContentPart): {
	url: string;
	detail?: string;
} {
	expect(part.type).toBe("image_url");
	return (part as { image_url: { url: string; detail?: string } }).image_url;
}

/** 走生产入口发一次真请求,返回线上那份请求体。 */
async function wireBody(
	providerId: string,
	config: Record<string, unknown>,
	model: string,
	bag: Record<string, unknown>,
	stream: string = MINIMAL_STREAM,
): Promise<Record<string, unknown>> {
	const dump = await captureWireRequest({
		providerId,
		config: { ...config, model },
		request: {
			messages: [SYSTEM_MESSAGE, IMAGE_USER_MESSAGE],
			model,
			turn: 1,
			providerOptions: { [providerId]: bag },
		},
		respond: () => sseResponse(stream),
	});
	return dump.requestBody as Record<string, unknown>;
}

/** `openai` 那一格的快捷入口 —— 它的线、它的流。 */
function openAIWireBody(
	bag: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return wireBody(
		"openai",
		{ apiKey: "sk-openai-fixture" },
		"gpt-5.5",
		bag,
		MINIMAL_RESPONSES_STREAM,
	);
}

/** Responses 内容块上的 `detail` —— 与 chat 的嵌套 `image_url.detail` 不同。 */
function responsesImagePart(part: unknown): {
	type: string;
	image_url?: string;
	detail?: string;
} {
	return part as { type: string; image_url?: string; detail?: string };
}

describe("openai-chat — 请求级 providerOptions 袋", () => {
	/**
	 * **P4-5:同一个袋键,换线之后换了落点。** chat-completions 上 `verbosity`
	 * 拼在**顶层**;Responses 上是 **`text.verbosity`**(官方
	 * `/docs/guides/latest-model`:「Set a default with `text.verbosity`」)。
	 * `imageDetail` 同理 —— 从嵌套的 `image_url.detail` 挪到 `input_image` 块
	 * 自己身上。守的是「换线没把旋钮弄丢」,不是新行为。
	 */
	it("openai(openai-responses):verbosity 进 text.verbosity,imageDetail 进内容块", async () => {
		const body = await openAIWireBody({ verbosity: "low", imageDetail: "low" });

		expect(body.text).toEqual({ verbosity: "low" });
		expect(body).not.toHaveProperty("verbosity");
		const parts = (body.input as { content: unknown }[])[0]!
			.content as unknown[];
		const image = responsesImagePart(parts[1]);
		expect(image.type).toBe("input_image");
		expect(image.detail).toBe("low");
	});

	it("openai:白名单外的键一个字都不发", async () => {
		const body = await openAIWireBody({ unknownKey: 1, temperature: 0.9 });

		expect(body).not.toHaveProperty("unknownKey");
		// `temperature` 是采样策略的字段:袋里写它不等于绕过策略 —— 白名单没有
		// 这一条,所以它被丢弃,请求体里那个位置仍然由 SamplingPolicy 说了算。
		expect(body).not.toHaveProperty("temperature");
	});

	it("认不出的键与非法的值都留一条 setting-dropped,不静默", async () => {
		const turn = await turnContextFor("openai", "gpt-5.5", {
			verbosity: "huge",
			unknownKey: 1,
		});
		const dialect = listDialects().find((entry) => entry.id === "openai")!;

		// 两条都没进白名单 ⇒ 请求体那半边一个字段都不长(这一回合没有
		// cacheKey,所以配方自己的 `prompt_cache_key` 也不长)。
		expect(dialect.extraBody?.(turn)).toEqual({});
		expect(turn.warnings.map((warning) => warning.kind)).toEqual([
			"setting-dropped",
			"setting-dropped",
		]);
		expect(turn.warnings.map((warning) => warning.fields?.reason)).toEqual([
			"illegal-value",
			"unknown-key",
		]);
	});

	it("openai:非法的 verbosity 不上线(`text` 这个键压根不长出来)", async () => {
		const body = await openAIWireBody({ verbosity: "huge" });

		expect(body).not.toHaveProperty("text");
		expect(body).not.toHaveProperty("verbosity");
	});

	/**
	 * 袋里没有这一格时,Responses 的 codec **仍然发 `detail:'auto'`** ——
	 * 那是这条线上内容块的常规形状(codex 的 fixture 一直钉着它),不是
	 * 「多发了一个字段」。chat 那条线是不长 `detail`,两条线本来就不同。
	 */
	it("袋里没有这一格就退回这条线的默认 detail:'auto'", async () => {
		const turn = await turnContextFor("openai", "gpt-5.5");
		const part = responsesImagePart(
			deliveredPart(codecOf("openai").user(IMAGE_PART, turn)),
		);

		expect(part).toEqual({
			type: "input_image",
			image_url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
			detail: "auto",
		});
		expect(turn.warnings).toEqual([]);
	});

	it("deepseek:值域多一个 original,标准三值照样认", async () => {
		for (const detail of ["auto", "low", "high", "original"]) {
			const turn = await turnContextFor(
				"deepseek",
				"deepseek-v4-vision-exp",
				{ imageDetail: detail },
			);
			const part = deliveredPart(codecOf("deepseek").user(IMAGE_PART, turn));
			expect(imageUrlOf(part).detail, detail).toBe(detail);
		}
	});

	it("deepseek:值域外的值被丢弃,块上不长 detail", async () => {
		const turn = await turnContextFor("deepseek", "deepseek-v4-vision-exp", {
			imageDetail: "gigantic",
		});
		const part = deliveredPart(codecOf("deepseek").user(IMAGE_PART, turn));

		expect(imageUrlOf(part)).not.toHaveProperty("detail");
	});

	/**
	 * `original` 官方 `/docs/guides/images-vision`:「Available on `gpt-5.4` and
	 * future models」。P4-9(拍板 #14)起它进了 openai 的值域,而且是**按模型**
	 * 开的 —— 5.4 之前的模型收到它仍旧当非法值丢弃,块退回默认 `auto`。
	 * xAI 的两条通路一个字没变(官方只列三值)。
	 */
	it("openai:gpt-5.4+ 收 original,更早的模型丢弃它并退回 detail:'auto'", async () => {
		for (const model of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6"]) {
			const turn = await turnContextFor("openai", model, {
				imageDetail: "original",
			});
			const part = responsesImagePart(
				deliveredPart(codecOf("openai").user(IMAGE_PART, turn)),
			);
			expect(part.detail, model).toBe("original");
			expect(turn.warnings, model).toEqual([]);
		}

		for (const model of ["gpt-5", "gpt-5.2", "o3"]) {
			const turn = await turnContextFor("openai", model, {
				imageDetail: "original",
			});
			const part = responsesImagePart(
				deliveredPart(codecOf("openai").user(IMAGE_PART, turn)),
			);
			expect(part.detail, model).toBe("auto");
		}

		// 标准三值在每一代上都照样认。
		for (const detail of ["auto", "low", "high"]) {
			const turn = await turnContextFor("openai", "gpt-5.5", {
				imageDetail: detail,
			});
			const part = responsesImagePart(
				deliveredPart(codecOf("openai").user(IMAGE_PART, turn)),
			);
			expect(part.detail, detail).toBe(detail);
		}
	});

	it("grok:值域仍是标准三值,original 被丢弃(#14 只开 openai 一家)", async () => {
		const turn = await turnContextFor("grok", "grok-4.6", {
			imageDetail: "original",
		});
		const part = responsesImagePart(
			deliveredPart(codecOf("grok").user(IMAGE_PART, turn)),
		);

		expect(part.detail).toBe("auto");
	});

	it("openrouter:同样收 detail", async () => {
		const turn = await turnContextFor("openrouter", "openai/gpt-5.5", {
			imageDetail: "high",
		});
		const part = deliveredPart(codecOf("openrouter").user(IMAGE_PART, turn));

		expect(imageUrlOf(part).detail).toBe("high");
	});

	/**
	 * xAI 换线之后(P4-4)`detail` 长在 **`input_image` 块自己身上**,不再是
	 * 嵌套的 `image_url.detail` —— 官方 Responses 的内容块就是这个形状
	 * (`{"type":"input_image","image_url":…,"detail":"high"}`)。
	 * 袋键与值域一个字没变,所以这一条守的是「换线没把旋钮弄丢」。
	 */
	it("grok / grok-oauth(openai-responses):detail 长在 input_image 上", async () => {
		for (const providerId of ["grok", "grok-oauth"]) {
			const turn = await turnContextFor(providerId, "grok-4.6", {
				imageDetail: "high",
			});
			const part = deliveredPart(
				codecOf(providerId).user(IMAGE_PART, turn),
			) as unknown as { type: string; detail?: string };
			expect(part.type, providerId).toBe("input_image");
			expect(part.detail, providerId).toBe("high");
		}
	});

	it("grok:值域外的 original 被丢弃,块退回默认 detail:'auto'", async () => {
		const turn = await turnContextFor("grok", "grok-4.6", {
			imageDetail: "original",
		});
		const part = deliveredPart(
			codecOf("grok").user(IMAGE_PART, turn),
		) as unknown as { detail?: string };

		expect(part.detail).toBe("auto");
	});

	/**
	 * codex 在同一条线上**不收**这个键:它的 fixture 钉着 `detail:'auto'` 恒发,
	 * 而配方上一个 `imageDetail` 声明都没有。收到就当认不出的键丢弃并留痕。
	 */
	it("codex:不收 detail(同一条线,白名单仍是一家一份)", async () => {
		const turn = await turnContextFor("codex", "gpt-5.5", {
			imageDetail: "high",
		});
		const part = deliveredPart(
			codecOf("codex").user(IMAGE_PART, turn),
		) as unknown as { detail?: string };

		expect(part.detail).toBe("auto");

		const dialect = listDialects().find((entry) => entry.id === "codex")!;
		dialect.extraBody?.(turn);
		expect(turn.warnings.map((warning) => warning.fields?.key)).toEqual([
			"imageDetail",
		]);
	});

	it("kimi / zhipu / qwen:不收 detail,块上一个字段都不多", async () => {
		for (const providerId of ["kimi", "zhipu", "qwen"]) {
			const turn = await turnContextFor(providerId, "kimi-k2.6", {
				imageDetail: "low",
			});
			const part = deliveredPart(codecOf(providerId).user(IMAGE_PART, turn));
			expect(imageUrlOf(part), providerId).toEqual({
				url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
			});
		}
	});

	it("kimi:不认的键照样留痕,不因为「这家没有旋钮」就静默吞掉", async () => {
		const turn = await turnContextFor("kimi", "kimi-k2.6", {
			imageDetail: "low",
			verbosity: "low",
		});
		const dialect = listDialects().find((entry) => entry.id === "kimi")!;
		dialect.extraBody?.(turn);

		expect(turn.warnings.map((warning) => warning.fields?.key).sort()).toEqual([
			"imageDetail",
			"verbosity",
		]);
		expect(
			turn.warnings.every((warning) => warning.kind === "setting-dropped"),
		).toBe(true);
	});
});
