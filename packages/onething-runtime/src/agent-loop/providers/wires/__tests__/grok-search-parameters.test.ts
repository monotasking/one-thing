/**
 * xAI 的 **Live Search**(P3-5a,设计稿 §12 Grok):请求侧 `search_parameters`
 * 经 providerOptions 袋透传,响应侧顶层 `citations[]` 落成一条 `provider-data`。
 *
 * 三条规矩,这份测试逐条守:
 *
 *  1. **袋 → `search_parameters` 是逐键裁的**。`searchParameters` 的值是一个
 *     对象,它自己的键再过一层白名单(`mode` / `sources` / `from_date` /
 *     `to_date` / `max_search_results` / `return_citations`)。认不出的子键、
 *     值不合法的子键各丢自己一个,**合法的兄弟照发** —— 这是 fixture
 *     `provider-options-search.request.json` 记的那件事。整个值不是对象才
 *     整条丢。丢一个键就留一条 `setting-dropped`,没有静默。
 *  2. **白名单是方言的一份声明**,不是袋里的 `if (providerId === 'grok')`:
 *     grok 与 grok-oauth 同一份支持面(同一个端点),openai 收到
 *     `searchParameters` 当认不出的键丢弃 + 留痕。
 *  3. **`citations[]` 是块的顶层字段**(不在 `choices[].delta` 里),来一块认
 *     一块;非字符串 / 空串的项不要,一条都不剩就不产事件。
 */
import { describe, expect, it } from "vitest";
import type { AgentTurnStreamEvent } from "@onething/core/agent-loop";
import { getLogger } from "../../../../logging/index.js";
import "../../dialects/index.js";
import { decodeGrokCitations } from "../../dialects/grok.js";
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

	it("openai 不认 searchParameters:整条当认不出的键丢弃 + 留痕", async () => {
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

	it("袋里没有这一格就一个字节都不多", async () => {
		const { body, turn } = await extraBodyFor("grok");

		expect(body).toEqual({});
		expect(turn.warnings).toEqual([]);
	});
});

describe("grok — citations[](响应侧)", () => {
	function decode(chunk: unknown, turn: TurnContext): AgentTurnStreamEvent[] {
		return decodeGrokCitations(chunk, turn);
	}

	it("顶层 citations[] → 一条 provider-data", async () => {
		const turn = await turnContextFor("grok");
		const events = decode(
			{
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				citations: ["https://a.example", "https://b.example"],
			},
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

	it("非字符串 / 空串的项不要,剩下的照发", async () => {
		const turn = await turnContextFor("grok");
		const events = decode(
			{ citations: ["https://a.example", "", 42, null, "https://b.example"] },
			turn,
		);

		expect(events[0]).toMatchObject({
			providerData: {
				citations: ["https://a.example", "https://b.example"],
			},
		});
	});

	it("没有 citations、不是数组、一条都不剩 —— 都不产事件", async () => {
		const turn = await turnContextFor("grok");

		expect(decode({ choices: [] }, turn)).toEqual([]);
		expect(decode({ citations: "https://a.example" }, turn)).toEqual([]);
		expect(decode({ citations: [] }, turn)).toEqual([]);
		expect(decode({ citations: ["", 1] }, turn)).toEqual([]);
		expect(decode(null, turn)).toEqual([]);
	});

	it("挂在两条通路的 codec 上(grok 与 grok-oauth 都解得出来)", async () => {
		for (const providerId of ["grok", "grok-oauth"]) {
			const turn = await turnContextFor(providerId);
			const events = dialectOf(providerId).parts?.decodeExtras?.(
				{ citations: ["https://a.example"] },
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
});
