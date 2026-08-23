/**
 * xAI 的 **Live Search**(P3-5a → P4-4 换线到 openai-responses):请求侧
 * `search_parameters` 经 providerOptions 袋透传,响应侧的引文落成一条
 * `provider-data`。
 *
 * ## 换线之后哪一半变了,哪一半没变
 *
 * **请求侧一个字没变**:官方把同一个 `search_parameters` 对象逐字列在
 * `POST /v1/chat/completions` 与 `POST /v1/responses` 两边的 Request Body 上
 * (docs.x.ai `/developers/rest-api-reference/inference/chat`),所以 P3-5a 那张
 * 嵌套白名单原样搬进 `wires/xai-search-parameters.ts` 就够了。
 *
 * **响应侧换了形状**:chat 那条线上引文是**块的顶层 `citations[]`**;Responses
 * 上是 `message` 项里每个 `output_text` 块的
 * `annotations[] = {type:'url_citation', url, start_index, end_index, title}`
 * (官方 `/developers/tools/citations`,「Inline citations are enabled by
 * default for the Responses API」)。产出的 `provider-data` **形状不变**
 * (`{provider:'grok', type:'citations', citations:[url, …]}`)—— 换线不该让
 * 下游多认一种事件。
 *
 * 四条规矩,这份测试逐条守:
 *
 *  1. **袋 → `search_parameters` 是逐键裁的**。`searchParameters` 的值是一个
 *     对象,它自己的键再过一层白名单(`mode` / `sources` / `from_date` /
 *     `to_date` / `max_search_results` / `return_citations`)。认不出的子键、
 *     值不合法的子键各丢自己一个,**合法的兄弟照发** —— 这是 fixture
 *     `responses/grok/provider-options.request.json` 记的那件事。整个值不是
 *     对象才整条丢。丢一个键就留一条 `setting-dropped`,没有静默。
 *  2. **白名单是方言的一份声明**,不是袋里的 `if (providerId === 'grok')`:
 *     grok 与 grok-oauth 同一份支持面(同一个端点);同一条线上的 **codex**
 *     与另一条线上的 **openai** 收到 `searchParameters` 都当认不出的键丢弃 +
 *     留痕。
 *  3. **引文只取 `url`**,按出现顺序去重;不是 `url_citation` 的 annotation、
 *     非字符串 / 空串的 url 一律不要,一条都不剩就不产事件。
 *  4. **只有 `message` 项才解引文** —— reasoning / function_call 项上没有这
 *     东西,拿它们喂进去应当一个事件都不产。
 */
import { describe, expect, it } from "vitest";
import type { AgentTurnStreamEvent } from "@onething/core/agent-loop";
import { getLogger } from "../../../../logging/index.js";
import "../../dialects/index.js";
import { decodeGrokResponsesCitations } from "../../dialects/grok.js";
import type { ResponsesDialect } from "../index.js";
import {
	LedgerModelProfileResolver,
	RequestBodyBuilder,
	TurnContext,
	listDialects,
	type Dialect,
} from "../../base/index.js";

const GROK_MODEL = "grok-4.6";

/** 一个「合法到底」的袋 —— 六个白名单键全带上。 */
const FULL_SEARCH_PARAMETERS = {
	mode: "auto",
	sources: [{ type: "web", country: "US" }, { type: "x" }],
	from_date: "2026-08-01",
	to_date: "2026-08-21",
	max_search_results: 5,
	return_citations: true,
} as const;

function dialectOf(dialectId: string): Dialect {
	const dialect = listDialects().find((entry) => entry.id === dialectId);
	if (!dialect) throw new Error(`unregistered dialect: ${dialectId}`);
	return dialect;
}

async function turnContextFor(
	providerId: string,
	bag?: Record<string, unknown>,
	model: string = GROK_MODEL,
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
		getLogger("test.grok-search-parameters"),
	);
}

/** 跑一次这家的 `extraBody`(袋那半边就长在里面),把请求体片段与痕一起交出来。 */
async function extraBodyFor(
	providerId: string,
	bag?: Record<string, unknown>,
	model: string = GROK_MODEL,
): Promise<{ body: Record<string, unknown>; turn: TurnContext }> {
	const turn = await turnContextFor(providerId, bag, model);
	const body = dialectOf(providerId).extraBody?.(turn) ?? {};
	return { body, turn };
}

function droppedKeys(turn: TurnContext): { key: unknown; reason: unknown }[] {
	return turn.warnings
		.filter((warning) => warning.kind === "setting-dropped")
		.map((warning) => ({
			key: warning.fields?.key,
			reason: warning.fields?.reason,
		}));
}

describe("grok — search_parameters(请求侧)", () => {
	it("六个白名单键原样写进顶层 search_parameters,一条痕都不留", async () => {
		const { body, turn } = await extraBodyFor("grok", {
			searchParameters: FULL_SEARCH_PARAMETERS,
		});

		expect(body.search_parameters).toEqual(FULL_SEARCH_PARAMETERS);
		expect(turn.warnings).toEqual([]);
	});

	it("认不出的子键只丢自己,合法的兄弟照发(fixture 记的就是这件事)", async () => {
		const { body, turn } = await extraBodyFor("grok", {
			searchParameters: {
				mode: "auto",
				max_search_results: 5,
				return_citations: true,
				bogus: 1,
			},
		});

		expect(body.search_parameters).toEqual({
			mode: "auto",
			max_search_results: 5,
			return_citations: true,
		});
		expect(droppedKeys(turn)).toEqual([
			{ key: "searchParameters.bogus", reason: "unknown-key" },
		]);
	});

	it("非法的 mode 被丢弃并留痕,合法的兄弟仍然发出去", async () => {
		const { body, turn } = await extraBodyFor("grok", {
			searchParameters: { mode: "always", return_citations: true },
		});

		expect(body.search_parameters).toEqual({ return_citations: true });
		expect(droppedKeys(turn)).toEqual([
			{ key: "searchParameters.mode", reason: "illegal-value" },
		]);
	});

	it("逐类值域:日期只认 YYYY-MM-DD、条数只认正整数、sources 只认数组、citations 只认布尔", async () => {
		const illegal: Record<string, unknown> = {
			from_date: "2026/08/01",
			to_date: 20260821,
			max_search_results: 0,
			sources: "web",
			return_citations: "yes",
		};
		const { body, turn } = await extraBodyFor("grok", {
			searchParameters: { ...illegal, mode: "on" },
		});

		// 五个非法子键全被丢,只有 `mode` 上线。
		expect(body.search_parameters).toEqual({ mode: "on" });
		expect(droppedKeys(turn).map((entry) => entry.key).sort()).toEqual(
			Object.keys(illegal)
				.map((key) => `searchParameters.${key}`)
				.sort(),
		);
		expect(
			droppedKeys(turn).every((entry) => entry.reason === "illegal-value"),
		).toBe(true);
	});

	it("值不是对象 = 整条丢(数组也是),请求体上一个字段都不长", async () => {
		for (const value of ["auto", 1, true, ["web"], null]) {
			const { body, turn } = await extraBodyFor("grok", {
				searchParameters: value,
			});

			expect(body, JSON.stringify(value)).not.toHaveProperty(
				"search_parameters",
			);
			expect(droppedKeys(turn), JSON.stringify(value)).toEqual([
				{ key: "searchParameters", reason: "illegal-value" },
			]);
		}
	});

	it("一个合法子键都不剩就不发空对象(空的 search_parameters 是纯噪音)", async () => {
		const { body } = await extraBodyFor("grok", {
			searchParameters: { bogus: 1 },
		});

		expect(body).not.toHaveProperty("search_parameters");
	});

	it("grok-oauth 同样认(同一个端点,同一份支持面)", async () => {
		const { body, turn } = await extraBodyFor("grok-oauth", {
			searchParameters: FULL_SEARCH_PARAMETERS,
		});

		expect(body.search_parameters).toEqual(FULL_SEARCH_PARAMETERS);
		expect(turn.warnings).toEqual([]);
	});

	it("openai(另一条线)不认 searchParameters:整条当认不出的键丢弃 + 留痕", async () => {
		const { body, turn } = await extraBodyFor(
			"openai",
			{ searchParameters: FULL_SEARCH_PARAMETERS },
			"gpt-5.5",
		);

		expect(body).not.toHaveProperty("search_parameters");
		expect(droppedKeys(turn)).toEqual([
			{ key: "searchParameters", reason: "unknown-key" },
		]);
	});

	it("codex(同一条线)也不认:白名单是一家一份,不是一条线一份", async () => {
		const { body, turn } = await extraBodyFor(
			"codex",
			{ searchParameters: FULL_SEARCH_PARAMETERS },
			"gpt-5.5",
		);

		expect(body).not.toHaveProperty("search_parameters");
		expect(droppedKeys(turn)).toEqual([
			{ key: "searchParameters", reason: "unknown-key" },
		]);
	});

	it("袋里没有这一格就一个字节都不多", async () => {
		const { body, turn } = await extraBodyFor("grok");

		expect(body).toEqual({});
		expect(turn.warnings).toEqual([]);
	});
});

describe("grok — 引文 annotations(响应侧)", () => {
	/** 一条完成的 `message` 项 —— 官方 `/developers/tools/citations` 的形状。 */
	function messageItem(
		annotations: unknown[],
		text = "xAI 最近发布了 Grok 4.6。",
	): Record<string, unknown> {
		return {
			id: "msg_grok_0001",
			type: "message",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text, logprobs: [], annotations }],
		};
	}

	function decode(
		item: Record<string, unknown>,
		turn: TurnContext,
	): AgentTurnStreamEvent[] {
		return decodeGrokResponsesCitations(item, turn);
	}

	it("output_text.annotations[].url_citation → 一条 provider-data", async () => {
		const turn = await turnContextFor("grok");
		const events = decode(
			messageItem([
				{
					type: "url_citation",
					url: "https://a.example",
					start_index: 0,
					end_index: 10,
					title: "1",
				},
				{
					type: "url_citation",
					url: "https://b.example",
					start_index: 11,
					end_index: 20,
					title: "2",
				},
			]),
			turn,
		);

		expect(events).toEqual([
			{
				type: "provider-data",
				turn: 1,
				providerData: {
					provider: "grok",
					type: "citations",
					citations: ["https://a.example", "https://b.example"],
				},
			},
		]);
	});

	it("形状与 P3-5a 的 chat 通路逐字相同 —— 换线不让下游多认一种事件", async () => {
		const turn = await turnContextFor("grok");
		const [event] = decode(
			messageItem([{ type: "url_citation", url: "https://a.example" }]),
			turn,
		);

		expect(event?.type).toBe("provider-data");
		const providerData =
			event?.type === "provider-data" ? event.providerData : undefined;
		expect(Object.keys(providerData ?? {}).sort()).toEqual([
			"citations",
			"provider",
			"type",
		]);
	});

	it("非 url_citation / 非字符串 / 空串的项不要,重复的 url 只留一次", async () => {
		const turn = await turnContextFor("grok");
		const events = decode(
			messageItem([
				{ type: "url_citation", url: "https://a.example" },
				{ type: "file_citation", url: "https://skip.example" },
				{ type: "url_citation", url: "" },
				{ type: "url_citation", url: 42 },
				{ type: "url_citation" },
				null,
				{ type: "url_citation", url: "https://a.example" },
				{ type: "url_citation", url: "https://b.example" },
			]),
			turn,
		);

		expect(events[0]).toMatchObject({
			providerData: {
				citations: ["https://a.example", "https://b.example"],
			},
		});
	});

	it("跨多个 output_text 块累积(按出现顺序)", async () => {
		const turn = await turnContextFor("grok");
		const events = decode(
			{
				type: "message",
				content: [
					{
						type: "output_text",
						text: "一",
						annotations: [{ type: "url_citation", url: "https://a.example" }],
					},
					{
						type: "output_text",
						text: "二",
						annotations: [{ type: "url_citation", url: "https://b.example" }],
					},
				],
			},
			turn,
		);

		expect(events[0]).toMatchObject({
			providerData: {
				citations: ["https://a.example", "https://b.example"],
			},
		});
	});

	it("不是 message 项、没有 annotations、一条都不剩 —— 都不产事件", async () => {
		const turn = await turnContextFor("grok");

		// reasoning / function_call 项上没有引文这回事。
		expect(
			decode({ type: "reasoning", encrypted_content: "enc" }, turn),
		).toEqual([]);
		expect(
			decode(
				{ type: "function_call", name: "read_file", call_id: "c1" },
				turn,
			),
		).toEqual([]);
		expect(decode(messageItem([]), turn)).toEqual([]);
		expect(decode({ type: "message" }, turn)).toEqual([]);
		expect(decode({ type: "message", content: "plain" }, turn)).toEqual([]);
		expect(
			decode(messageItem([{ type: "url_citation", url: "" }]), turn),
		).toEqual([]);
	});

	it("挂在两条通路的方言上(grok 与 grok-oauth 都解得出来)", async () => {
		for (const providerId of ["grok", "grok-oauth"]) {
			const turn = await turnContextFor(providerId);
			const dialect = dialectOf(providerId) as ResponsesDialect;
			const events = dialect.decodeOutputItem?.(
				messageItem([{ type: "url_citation", url: "https://a.example" }]),
				turn,
			);
			expect(events, providerId).toEqual([
				{
					type: "provider-data",
					turn: 1,
					providerData: {
						provider: "grok",
						type: "citations",
						citations: ["https://a.example"],
					},
				},
			]);
		}
	});

	it("codex 不挂这一支 —— 同一条 wire,一个事件都不多", () => {
		expect(
			(dialectOf("codex") as ResponsesDialect).decodeOutputItem,
		).toBeUndefined();
	});
});
