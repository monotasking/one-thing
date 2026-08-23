/**
 * `base/` 的架构门(设计稿 §3.1 / §9 P0a 第 ⑤ 条)。
 *
 * 四件事,全部代理可自证:
 *  1. `HttpAgentProvider` 的子类不得覆盖 `streamTurn`(TS 没有 `final`),
 *     也不得有可写实例字段(实例无状态);
 *  2. `base/` 源码里不得出现对方言字段的字符串分支
 *     (`dialect.x === '…'` / `switch (dialect.…)`)—— 多态取代分支;
 *  3. `UsageBuckets` 的不变量与投影,`billable` 与账本同一条公式;
 *  4. `ModelProfile.toAgentModelCapabilities` 对固定输入产出固定结果 ——
 *     P2-a 之前这是「与 `factory.ts` 的 `withPerModelCapabilities` 等价」的
 *     并存门,覆盖层退役后改为把当时的输出录成内联期望(见文件末尾)。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { undeliverableAttachmentText } from "@onething/core/agent-loop";
import type { AgentModelCapabilities } from "@onething/core/agent-loop";
import type { AgentProviderRuntimeConfig } from "../../factory.js";
import { computeOnethingUsageCostUSD } from "../../../../usage/pricing.js";
import {
	LedgerModelProfileResolver,
	PathUsageNormalizer,
	RequestBodyBuilder,
	Undeliverable,
	UsageBuckets,
	type LedgerModelProfileConfig,
} from "../index.js";

const BASE_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/__tests__$/, "");
const PROVIDERS_DIR = dirname(BASE_DIR);
/** `packages/onething-runtime/src` —— 非 HTTP 的子类住在 `external-agents/`。 */
const RUNTIME_SRC_DIR = dirname(dirname(PROVIDERS_DIR));
const EXTERNAL_AGENTS_DIR = join(RUNTIME_SRC_DIR, "external-agents");

/**
 * 扫源码前先剥注释 —— 这份文件自己的注释里就写着被禁的那两个模式,
 * 不剥就是自证陷阱(checker 不剥注释这条坑仓里踩过一次)。
 */
export function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function collectTsFiles(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) {
				if (entry === "__tests__" || entry === "__fixtures__" || entry === "wire-snapshots") {
					continue;
				}
				walk(full);
				continue;
			}
			if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
		}
	};
	walk(root);
	return out;
}

// ---------------------------------------------------------------------------
// 扫描器(纯函数,自带样例断言 —— P0a 还没有子类,不能靠"扫到 0 个"当绿)
// ---------------------------------------------------------------------------

/** 取出 `class X extends <base>` 的类体(按花括号配平)。 */
export function extractClassBodies(
	source: string,
	basePattern: RegExp,
): Array<{ name: string; body: string }> {
	const out: Array<{ name: string; body: string }> = [];
	const decl = /class\s+([A-Za-z_$][\w$]*)[^{]*?\bextends\s+([A-Za-z_$][\w$]*)/g;
	let match: RegExpExecArray | null;
	while ((match = decl.exec(source))) {
		if (!basePattern.test(match[2]!)) continue;
		const open = source.indexOf("{", decl.lastIndex - 1);
		if (open < 0) continue;
		let depth = 0;
		let end = open;
		for (let i = open; i < source.length; i += 1) {
			if (source[i] === "{") depth += 1;
			else if (source[i] === "}") {
				depth -= 1;
				if (depth === 0) {
					end = i;
					break;
				}
			}
		}
		out.push({ name: match[1]!, body: source.slice(open + 1, end) });
	}
	return out;
}

export function overridesStreamTurn(classBody: string): boolean {
	return /(^|\n)[^\S\n]*(?:public\s+|protected\s+|private\s+|override\s+|async\s+|\*\s*)*\*?\s*streamTurn\s*[(<]/.test(
		classBody,
	);
}

/** 顶层(深度 1)的字段声明里,没有 `readonly` 的那些。构造器参数属性同办。 */
export function findWritableInstanceFields(classBody: string): string[] {
	const violations: string[] = [];
	const lines = classBody.split("\n");
	let depth = 0;
	for (const line of lines) {
		const trimmed = line.trim();
		if (depth === 0 && trimmed && !trimmed.startsWith("*") && !trimmed.startsWith("//")) {
			const field =
				/^(?:(?:public|protected|private|declare|override|accessor)\s+)*([A-Za-z_$#][\w$]*)\s*[?!]?\s*[:=]/.exec(
					trimmed,
				);
			if (field && !/\breadonly\b/.test(trimmed) && !/\bstatic\b/.test(trimmed)) {
				violations.push(field[1]!);
			}
			const ctorParams = /^constructor\s*\(([^)]*)\)/s.exec(trimmed);
			if (ctorParams) {
				for (const raw of ctorParams[1]!.split(",")) {
					const param = raw.trim();
					if (!param) continue;
					if (/^(?:public|protected|private)\s/.test(param) && !/\breadonly\b/.test(param)) {
						violations.push(param);
					}
				}
			}
		}
		for (const char of line) {
			if (char === "{" || char === "(" || char === "[") depth += 1;
			else if (char === "}" || char === ")" || char === "]") depth -= 1;
		}
		if (depth < 0) depth = 0;
	}
	return violations;
}

describe("base/ 架构不变式", () => {
	const baseFiles = collectTsFiles(BASE_DIR);
	const providerFiles = collectTsFiles(PROVIDERS_DIR);

	it("扫描器本身是活的(样例)", () => {
		const sample = `
class Bad extends HttpAgentProvider {
	private cachedBody: string = "";
	protected readonly ok = 1;
	constructor(ctx, private dialect: Dialect) { super(ctx) }
	async *streamTurn(request) { yield 1 }
}
`;
		const [found] = extractClassBodies(sample, /^HttpAgentProvider$/);
		expect(found?.name).toBe("Bad");
		expect(overridesStreamTurn(found!.body)).toBe(true);
		const writable = findWritableInstanceFields(found!.body);
		expect(writable).toContain("cachedBody");
		expect(writable.some((entry) => entry.includes("private dialect"))).toBe(true);
		expect(writable).not.toContain("ok");
	});

	it("HttpAgentProvider 的子类不覆盖 streamTurn,也没有可写实例字段", () => {
		const offenders: string[] = [];
		for (const file of providerFiles) {
			const source = stripComments(readFileSync(file, "utf8"));
			for (const cls of extractClassBodies(source, /HttpAgentProvider$/)) {
				if (overridesStreamTurn(cls.body)) {
					offenders.push(`${file}: ${cls.name} overrides streamTurn`);
				}
				for (const field of findWritableInstanceFields(cls.body)) {
					offenders.push(`${file}: ${cls.name} has a writable field: ${field}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	/**
	 * 非 HTTP 的两家(acp / external-agents)直接继承 `BaseAgentProvider`:
	 * 它们的传输是一条 JSON-RPC 会话 / 一个子进程,没有 fetch 可言(§2.9)。
	 * `streamTurn` 是它们**必须**实现的抽象方法,所以这一条只守「实例无状态」。
	 *
	 * 断言里点名两个类,是因为"扫到 0 个"也会绿 —— 门必须先证明自己扫得到东西。
	 */
	it("BaseAgentProvider 的直接子类没有可写实例字段", () => {
		const offenders: string[] = [];
		const found: string[] = [];
		for (const file of [...providerFiles, ...collectTsFiles(EXTERNAL_AGENTS_DIR)]) {
			const source = stripComments(readFileSync(file, "utf8"));
			for (const cls of extractClassBodies(source, /^BaseAgentProvider$/)) {
				found.push(cls.name);
				for (const field of findWritableInstanceFields(cls.body)) {
					offenders.push(`${file}: ${cls.name} has a writable field: ${field}`);
				}
			}
		}
		expect(offenders).toEqual([]);
		expect(found.sort()).toEqual(["ACPAgentProvider", "ExternalAgentProvider"]);
	});

	it("base/ 里没有对方言字段的字符串分支", () => {
		const offenders: string[] = [];
		for (const file of baseFiles) {
			const source = stripComments(readFileSync(file, "utf8"));
			if (/dialect\.[A-Za-z_$][\w$]*\s*(?:===|!==|==|!=)\s*['"`]/.test(source)) {
				offenders.push(`${file}: compares a dialect field to a string literal`);
			}
			if (/switch\s*\(\s*[\w.]*\bdialect\./.test(source)) {
				offenders.push(`${file}: switches on a dialect field`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("base/ 不反向依赖装配层,也不碰 @shared/ipc", () => {
		for (const file of baseFiles) {
			const source = stripComments(readFileSync(file, "utf8"));
			expect(source).not.toMatch(/@onething\/backend/);
			expect(source).not.toMatch(/@shared\/ipc/);
			expect(source).not.toMatch(/from ['"]electron['"]/);
		}
	});
});

// ---------------------------------------------------------------------------
// UsageBuckets
// ---------------------------------------------------------------------------

describe("UsageBuckets", () => {
	it("构造时校验非负", () => {
		expect(() => new UsageBuckets(-1, 0, 0, 0)).toThrow(RangeError);
		expect(() => new UsageBuckets(0, 0, 0, Number.NaN)).toThrow(RangeError);
		expect(() => new UsageBuckets(0, 0, 0, 0, -5)).toThrow(RangeError);
		expect(() => new UsageBuckets(1, 2, 3, 4)).not.toThrow();
	});

	it("投影:input = uncached + read,total = input + output,cacheWrite 原样", () => {
		const buckets = new UsageBuckets(100, 40, 25, 60, 12);
		expect(buckets.input).toBe(140);
		expect(buckets.total).toBe(200);
		expect(buckets.toAgentUsage()).toEqual({
			inputTokens: 140,
			outputTokens: 60,
			totalTokens: 200,
			cacheReadTokens: 40,
			cacheWriteTokens: 25,
			reasoningTokens: 12,
		});
	});

	it("零值不落进 AgentUsage(与今天 usageFromChunk 一致)", () => {
		expect(new UsageBuckets(10, 0, 0, 5).toAgentUsage()).toEqual({
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
		});
	});

	it("billable 与 computeOnethingUsageCostUSD 同一条公式", () => {
		const prices = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
		const buckets = new UsageBuckets(1200, 800, 300, 450, 90);
		expect(buckets.billable(prices)).toBe(
			computeOnethingUsageCostUSD(
				{
					input: 2000,
					output: 450,
					cacheRead: 800,
					cacheWrite: 300,
					reasoning: 90,
					total: 2450,
				},
				prices,
			),
		);
	});

	it("cacheHitRatio", () => {
		expect(new UsageBuckets(75, 25, 0, 10).cacheHitRatio()).toBe(0.25);
		expect(new UsageBuckets(0, 0, 0, 0).cacheHitRatio()).toBe(0);
	});
});

describe("PathUsageNormalizer", () => {
	const normalizer = new PathUsageNormalizer({
		presence: "prompt_tokens",
		uncachedInput: {
			from: "prompt_tokens",
			minus: [
				["prompt_tokens_details", "cached_tokens"],
				["prompt_tokens_details", "cache_write_tokens"],
			],
		},
		cacheRead: ["prompt_tokens_details", "cached_tokens"],
		cacheWrite: ["prompt_tokens_details", "cache_write_tokens"],
		output: "completion_tokens",
		reasoning: ["completion_tokens_details", "reasoning_tokens"],
	});

	it("prompt − read − write 派生", () => {
		const buckets = normalizer.toBuckets({
			prompt_tokens: 1000,
			completion_tokens: 200,
			prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 100 },
			completion_tokens_details: { reasoning_tokens: 50 },
		});
		expect(buckets?.uncachedInput).toBe(600);
		expect(buckets?.input).toBe(900);
		expect(buckets?.cacheWrite).toBe(100);
		expect(buckets?.toAgentUsage().reasoningTokens).toBe(50);
	});

	it("没有 usage 那块就返回 undefined,不造零", () => {
		expect(normalizer.toBuckets(undefined)).toBeUndefined();
		expect(normalizer.toBuckets({})).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// RequestBodyBuilder
// ---------------------------------------------------------------------------

describe("RequestBodyBuilder", () => {
	it("点分路径读写删", () => {
		const builder = new RequestBodyBuilder();
		builder.set("model", "m").set("stream_options.include_usage", true);
		expect(builder.get("stream_options.include_usage")).toBe(true);
		expect(builder.build()).toEqual({ model: "m", stream_options: { include_usage: true } });
		builder.delete("stream_options.include_usage");
		expect(builder.build()).toEqual({ model: "m", stream_options: {} });
	});

	it("forDump 截断 data-URI,其余原样", () => {
		const base64 = Buffer.from("x".repeat(900)).toString("base64");
		const builder = new RequestBodyBuilder();
		builder.set("messages", [
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
					{ type: "image_url", image_url: { url: "https://example.com/a.png" } },
				],
			},
		]);
		const dumped = JSON.stringify(builder.forDump());
		expect(dumped).toContain("<data-uri:image/png 900 bytes>");
		expect(dumped).not.toContain(base64);
		expect(dumped).toContain("https://example.com/a.png");
		expect(dumped).toContain("look");
		// 原对象不受影响 —— forDump 是一份投影,不是就地改写。
		expect(JSON.stringify(builder.build())).toContain(base64);
	});
});

// ---------------------------------------------------------------------------
// Undeliverable 文案与 core 不许漂移
// ---------------------------------------------------------------------------

describe("Undeliverable", () => {
	it("文案与 core 的 undeliverableAttachmentText 逐字相同", () => {
		const withPath = { filename: "report.pdf", mediaType: "application/pdf", path: "/tmp/report.pdf" };
		const withoutPath = { filename: "a.bin", mediaType: "application/octet-stream" };
		const bare = {};
		for (const part of [withPath, withoutPath, bare]) {
			expect(Undeliverable.fromPart(part, "wire-has-no-part").toText()).toBe(
				undeliverableAttachmentText(part),
			);
		}
	});
});

// ---------------------------------------------------------------------------
// ModelProfile.toAgentModelCapabilities —— 能力投影的唯一一份
// ---------------------------------------------------------------------------

/** 编译期断言:`AgentProviderRuntimeConfig` 喂得进 `LedgerModelProfileConfig`。 */
const _configIsCompatible: LedgerModelProfileConfig = {} as AgentProviderRuntimeConfig;
void _configIsCompatible;

const PROBE_ID = "base-arch-probe";

const TRANSPORT: AgentModelCapabilities = {
	capabilities: ["text-input", "text-output", "streaming", "tool-calls"],
	inputModalities: ["text"],
	outputModalities: ["text"],
	toolResultModalities: ["text"],
	supportsTools: true,
	supportsStructuredToolResults: true,
	supportsReasoning: false,
	supportsStreaming: true,
	supportsForcedToolUse: true,
	maxInputTokens: 111,
	maxOutputTokens: 222,
};

interface ProfileCase {
	name: string;
	providerId: string;
	model: string;
	config: AgentProviderRuntimeConfig;
	base?: AgentModelCapabilities;
	expected: AgentModelCapabilities;
}

/**
 * P0a–P1 期间这张表是**等价门**:每条用例都用一个 `registerAgentProviderRuntime`
 * 探针把同一份输入喂给 `factory.ts` 的 `withPerModelCapabilities`,再与
 * `ModelProfile.toAgentModelCapabilities` 逐条比对,守着两份并存不漂移。
 *
 * P2-a 覆盖层退役,`ModelProfile` 成了唯一一份 —— 探针没有第二份可比,于是它
 * **当时的输出被录成下面的内联期望**再删除。断言的意思因此从「两份相等」变成
 * 「这一份没有变」:同样是硬门,只是不再需要一个假 provider 来当尺子。
 */
const PROFILE_CASES: ProfileCase[] = [
	{
		name: "账本一无所知('default')—— provider 的声明原样保留",
		providerId: PROBE_ID,
		model: "totally-unknown-model",
		config: {},
		expected: {
			capabilities: ["text-input", "text-output", "streaming", "tool-calls"],
			inputModalities: ["text"],
			outputModalities: ["text"],
			toolResultModalities: ["text"],
			supportsTools: true,
			supportsStructuredToolResults: true,
			supportsReasoning: false,
			supportsStreaming: true,
			supportsForcedToolUse: true,
			maxInputTokens: 111,
			maxOutputTokens: 222,
		},
	},
	{
		name: "registry 翻 vision + imageOutput",
		providerId: PROBE_ID,
		model: "some-model",
		config: {
			models: {
				"some-model": {
					supportsVision: true,
					supportsImageOutput: true,
					contextLength: 128000,
					maxOutputTokens: 8192,
				},
			},
		},
		expected: {
			capabilities: ["text-input", "text-output", "streaming", "tool-calls", "vision-input", "file-input", "image-output"],
			inputModalities: ["text", "image", "file"],
			outputModalities: ["text", "image"],
			toolResultModalities: ["text"],
			supportsTools: true,
			supportsStructuredToolResults: true,
			supportsReasoning: false,
			supportsStreaming: true,
			supportsForcedToolUse: true,
			maxInputTokens: 128000,
			maxOutputTokens: 8192,
		},
	},
	{
		name: "registry 关掉 tools —— 结构化结果与强制调用一起归零",
		providerId: PROBE_ID,
		model: "no-tools",
		config: {
			models: {
				"no-tools": {
					supportsTools: false,
				},
			},
		},
		expected: {
			capabilities: ["text-input", "text-output", "streaming"],
			inputModalities: ["text"],
			outputModalities: ["text"],
			toolResultModalities: ["text"],
			supportsTools: false,
			supportsStructuredToolResults: false,
			supportsReasoning: false,
			supportsStreaming: true,
			supportsForcedToolUse: false,
			maxInputTokens: 111,
			maxOutputTokens: 222,
		},
	},
	{
		name: "override 压过 registry",
		providerId: PROBE_ID,
		model: "clash",
		config: {
			modelCapabilitiesByModel: {
				clash: {
					vision: false,
					reasoning: true,
				},
			},
			models: {
				clash: {
					supportsVision: true,
					supportsReasoning: false,
				},
			},
		},
		expected: {
			capabilities: ["text-input", "text-output", "streaming", "tool-calls", "reasoning"],
			inputModalities: ["text"],
			outputModalities: ["text"],
			toolResultModalities: ["text"],
			supportsTools: true,
			supportsStructuredToolResults: true,
			supportsReasoning: true,
			supportsStreaming: true,
			supportsForcedToolUse: true,
			maxInputTokens: 111,
			maxOutputTokens: 222,
		},
	},
	{
		name: "codex gpt-5.5:元数据里的 image_generation 推出 image 输出",
		providerId: "codex",
		model: "gpt-5.5",
		config: {
			models: {
				"gpt-5.5": {
					supportsTools: true,
					supportsVision: true,
					supportsReasoning: true,
					supportsImageOutput: false,
					supportsTemperature: false,
					providerMetadata: {
						codex: {
							nativeTools: ["image_generation"],
						},
					},
				},
			},
		},
		expected: {
			capabilities: ["text-input", "text-output", "streaming", "tool-calls", "reasoning", "structured-tool-results", "vision-input", "file-input", "image-output"],
			inputModalities: ["text", "image", "file"],
			outputModalities: ["text", "image"],
			toolResultModalities: ["text"],
			supportsTools: true,
			supportsStructuredToolResults: true,
			supportsReasoning: true,
			supportsStreaming: true,
			supportsForcedToolUse: true,
			maxInputTokens: 111,
			maxOutputTokens: 222,
		},
	},
	{
		name: "pattern 档:deepseek-reasoner",
		providerId: "deepseek",
		model: "deepseek-reasoner",
		config: {},
		expected: {
			capabilities: ["text-input", "text-output", "streaming", "tool-calls", "reasoning"],
			inputModalities: ["text"],
			outputModalities: ["text"],
			toolResultModalities: ["text"],
			supportsTools: true,
			supportsStructuredToolResults: true,
			supportsReasoning: true,
			supportsStreaming: true,
			supportsForcedToolUse: true,
			maxInputTokens: 111,
			maxOutputTokens: 222,
		},
	},
	{
		name: "limits 只在正整数时压过 base",
		providerId: PROBE_ID,
		model: "limits",
		config: {
			models: {
				limits: {
					contextLength: 0,
					maxOutputTokens: 4096,
				},
			},
		},
		expected: {
			capabilities: ["text-input", "text-output", "streaming", "tool-calls"],
			inputModalities: ["text"],
			outputModalities: ["text"],
			toolResultModalities: ["text"],
			supportsTools: true,
			supportsStructuredToolResults: true,
			supportsReasoning: false,
			supportsStreaming: true,
			supportsForcedToolUse: true,
			maxInputTokens: 111,
			maxOutputTokens: 4096,
		},
	},
	{
		name: "base 只声明文本、无 tools —— 账本沉默时不许被翻",
		providerId: PROBE_ID,
		model: "quiet",
		config: {},
		base: {
			capabilities: ["text-input", "text-output"],
			inputModalities: ["text"],
			outputModalities: ["text"],
			supportsTools: false,
		},
		expected: {
			capabilities: ["text-input", "text-output"],
			inputModalities: ["text"],
			outputModalities: ["text"],
			supportsTools: false,
			supportsStructuredToolResults: false,
			supportsForcedToolUse: false,
			supportsReasoning: false,
		},
	},
];

describe("ModelProfile.toAgentModelCapabilities", () => {
	for (const testCase of PROFILE_CASES) {
		it(testCase.name, async () => {
			const profile = await new LedgerModelProfileResolver(testCase.config).resolve(
				testCase.providerId,
				testCase.model,
			);
			expect(profile.toAgentModelCapabilities(testCase.base ?? TRANSPORT)).toEqual(
				testCase.expected,
			);
		});
	}
});
