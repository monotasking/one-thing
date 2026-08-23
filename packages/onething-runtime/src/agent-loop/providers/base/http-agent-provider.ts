/**
 * `HttpAgentProvider` —— **管线写死在模板方法里**(设计稿 §4)。
 *
 * `streamTurn` 的步骤与顺序是这一层的全部价值:子类不可覆盖它(TS 没有
 * `final`,由 `__tests__/architecture.test.ts` 守)。子类只实现 hook:
 * `buildBody` / `parseStream` / `defaultParts` / `defaultUsage` / `finish`。
 *
 * 运行期纪律也在这里(§2.10):
 *  - 实例无可写字段,回合级的量全在 `TurnContext`;
 *  - auth **晚绑定**,每回合现拿(凭据轮换在 runner 层换 key);
 *  - `finally` 取消响应体;
 *  - 首字节 / 空闲超时(`ctx.timeouts` 给了才生效,默认不限);
 *  - `AbortError` 原样抛出,**不**映射成 `ProviderHttpError`;
 *  - dump 永不落 auth 头(头压根不在体里)、截断 data-URI、URL 按方言脱敏。
 */
import type {
	AgentTurnRequest,
	AgentTurnStreamEvent,
} from "@onething/core/agent-loop";
import type { AgentProviderRequestDumpValue } from "../request-dump.js";
import { BaseAgentProvider } from "./base-agent-provider.js";
import type { ProviderContext } from "./provider-context.js";
import type { Dialect } from "./dialect.js";
import { DefaultErrorMapper, ProviderHttpError, type ErrorMapper } from "./errors.js";
import type { FinishReasonMapper } from "./finish-reason.js";
import type { PartCodec } from "./part-codec.js";
import { RequestBodyBuilder } from "./request-body-builder.js";
import { openAISamplingPolicy, type SamplingPolicy } from "./sampling-policy.js";
import { noCachePolicy, type CachePolicy } from "./cache-policy.js";
import { noThinkingWire, type ThinkingWire } from "./thinking-wire.js";
import {
	openAIToolChoicePolicy,
	type ToolChoicePolicy,
} from "./tool-choice-policy.js";
import { TurnContext } from "./turn-context.js";
import type { UsageNormalizer } from "./usage.js";

/** wire 的流解析器读完之后交回来的原始收尾信息。 */
export interface RawTurnFinish {
	finishReason?: string | null;
	/** 那条线协议给的 usage 原文;由 `UsageNormalizer` 直译到三桶。 */
	usage?: unknown;
}

const FIRST_BYTE_TIMEOUT_CODE = "first-byte-timeout";
const IDLE_TIMEOUT_CODE = "idle-timeout";

function isAbortError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { name?: unknown }).name === "AbortError"
	);
}

export abstract class HttpAgentProvider<
	TBody extends object = Record<string, unknown>,
	TChunk = unknown,
> extends BaseAgentProvider {
	/**
	 * 把继承来的 `ctx` 收窄回 `ProviderContext`:HTTP 这一支必有 `baseUrl` /
	 * `fetchImpl` / `profiles`(`declare` 只改类型,不生成字段,实例仍然无状态)。
	 */
	protected declare readonly ctx: ProviderContext;

	protected constructor(
		ctx: ProviderContext,
		protected readonly dialect: Dialect,
	) {
		super(ctx);
	}

	// -----------------------------------------------------------------------
	// 模板方法 —— 顺序即契约,子类不得覆盖
	// -----------------------------------------------------------------------

	async *streamTurn(
		request: AgentTurnRequest,
	): AsyncGenerator<AgentTurnStreamEvent, void, void> {
		// 1 profile
		const profile = await this.ctx.profiles.resolve(this.id, request.model);
		const turn = new TurnContext(
			request,
			profile,
			new RequestBodyBuilder(),
			this.turnLogger(request),
		);

		let response: Response | undefined;
		try {
			// 2 body(wire 必有字段 + 消息序列化)
			this.buildBody(turn);
			// 3 横切策略往同一只 builder 上写
			this.thinkingFor(turn).encode(turn, turn.builder);
			this.cache.annotate(turn, turn.builder);
			this.toolChoice.apply(turn, turn.builder);
			this.sampling.apply(turn, turn.builder);
			const extra = this.dialect.extraBody?.(turn);
			if (extra) {
				for (const [key, value] of Object.entries(extra)) turn.builder.set(key, value);
			}

			// 4 auth(晚绑定)
			const url = this.endpointUrl(turn);
			const headers = await this.dialect.auth.headers(turn);

			// 5 dump + 一条排障日志(P0b-A)
			//
			// 落盘的是 `forDump()` —— data URI 的 base64 载荷换成一行摘要。
			// 真机上 provider dump 曾写出 1.1G,大头就是那些块;**线上发出去的
			// 字节仍是 `build()`**(见 `send()`),两者从此不是同一份,快照门因此
			// 改读 `fetchImpl` 收到的 body。
			const dumpUrl = this.dialect.endpoint.redactForDump?.(url) ?? url;
			const requestDumpPath = await this.ctx.dumper?.({
				providerId: this.id,
				model: request.model,
				mode: this.dumpMode,
				metadata: this.dumpMetadata(turn, dumpUrl),
				requestBody: turn.builder.forDump() as AgentProviderRequestDumpValue,
			});
			// 复刻 `deepseek.ts` 退役前那条 —— 十一家从此都有(ns `providers.<id>`)。
			turn.logger.debug("stream turn request", {
				model: request.model,
				turn: request.turn,
				messageCount: request.messages.length,
				toolCount: request.tools?.length ?? 0,
				thinking: request.thinking ?? "default",
				requestDumpPath,
			});

			// 6 send(含 onUnauthorized 一次重试、首字节超时)
			response = await this.send(url, headers, turn);

			// 7 !ok → ProviderHttpError
			if (!response.ok) {
				const bodyText = await response.text().catch(() => "");
				throw this.errors.fromResponse(response, bodyText, turn);
			}

			// 8 stream + finish
			const raw = yield* this.parseStream(this.watchIdle(response), turn);
			yield this.finishEvent(raw, turn);
		} finally {
			// 提前抛错(auth / !ok / dump 炸)时这一句是唯一的回收点。流真的读起来
			// 之后 body 已被 wire 的 reader 锁住,`cancel()` 会抛 —— 那时候是 wire
			// 自己收尾,所以这里吞掉即可,不能因为回收失败盖掉真正的错误。
			await response?.body?.cancel().catch(() => undefined);
		}
	}

	// -----------------------------------------------------------------------
	// wire 必须实现
	// -----------------------------------------------------------------------

	/** 往 `turn.builder` 写这条线协议必有的字段(model / messages / stream / tools …)。 */
	protected abstract buildBody(turn: TurnContext): void;

	protected abstract parseStream(
		response: Response,
		turn: TurnContext,
	): AsyncGenerator<AgentTurnStreamEvent, RawTurnFinish, void>;

	protected abstract get defaultParts(): PartCodec;
	protected abstract get defaultUsage(): UsageNormalizer;
	protected abstract get finish(): FinishReasonMapper;

	// -----------------------------------------------------------------------
	// wire 默认,方言配方可替换 —— getter 只是 `dialect.x ?? default`
	// -----------------------------------------------------------------------

	protected get parts(): PartCodec {
		return this.dialect.parts ?? this.defaultParts;
	}

	protected get usage(): UsageNormalizer {
		return this.dialect.usage ?? this.defaultUsage;
	}

	protected get toolChoice(): ToolChoicePolicy {
		return this.dialect.toolChoice ?? this.defaultToolChoice;
	}

	protected get sampling(): SamplingPolicy {
		return this.dialect.sampling ?? this.defaultSampling;
	}

	protected get cache(): CachePolicy {
		return this.dialect.cache ?? noCachePolicy;
	}

	protected get errors(): ErrorMapper {
		return this.dialect.errors ?? new DefaultErrorMapper(this.id);
	}

	/** 今天的行为:OpenAI 形状。别的 wire 覆盖这个 getter,而不是加分支。 */
	protected get defaultToolChoice(): ToolChoicePolicy {
		return openAIToolChoicePolicy;
	}

	protected get defaultSampling(): SamplingPolicy {
		return openAISamplingPolicy;
	}

	/**
	 * 方言缝:每块流数据额外能解出来的事件(OpenRouter `reasoning_details` /
	 * `images[]` / 顶层 citations / web_search)。wire 的 `parseStream` 每块调
	 * 一次,方言不给 codec 就是空数组 —— 基类不认识任何一种额外块。
	 */
	protected decodeExtras(chunk: TChunk, turn: TurnContext): AgentTurnStreamEvent[] {
		return this.parts.decodeExtras?.(chunk, turn) ?? [];
	}

	/** dump 的 `mode` 字段。Responses 形状的 codex 覆盖成 `'codex-http'`。 */
	protected get dumpMode(): "stream" | "codex-http" {
		return "stream";
	}

	/**
	 * dump 的 `metadata` 字段。默认是 `{url, method, turn}`(openai-chat /
	 * anthropic / gemini 三家的形状);codex 覆盖成今天那份
	 * `{url, method, requestSource}` —— **它没有 `turn`**(设计稿 §9 P1 门 ①)。
	 *
	 * `url` 收到的已经是脱敏过的那份(`endpoint.redactForDump`),覆盖者不必
	 * 再脱一次。
	 */
	protected dumpMetadata(
		turn: TurnContext,
		url: string,
	): Record<string, AgentProviderRequestDumpValue> {
		return { url, method: "POST", turn: turn.turn };
	}

	/**
	 * 按 `ModelProfile.reasoningWire` 从方言登记的线型里选一条。选不到就用
	 * 第一条(P0a 每家只配一个);一条都没有就什么都不发。
	 */
	protected thinkingFor(turn: TurnContext): ThinkingWire {
		const wanted = turn.profile.reasoningWire;
		const registered = this.dialect.reasoning;
		return (
			registered.find((wire) => wire.id === wanted) ?? registered[0] ?? noThinkingWire
		);
	}

	protected endpointUrl(turn: TurnContext): string {
		const base = this.ctx.baseUrl.replace(/\/$/, "");
		const url = `${base}${this.dialect.endpoint.path}`;
		return this.dialect.endpoint.decorateUrl?.(url, turn) ?? url;
	}

	protected finishEvent(
		raw: RawTurnFinish,
		turn: TurnContext,
	): Extract<AgentTurnStreamEvent, { type: "finish" }> {
		const buckets = raw.usage === undefined ? undefined : this.usage.toBuckets(raw.usage);
		// warnings 随 finish 事件带出是 §8 的契约增量(core `AgentTurnStreamEvent`
		// 还没有那个字段,待拍板)。在那之前这一条日志就是 warnings 的**唯一**
		// 出口 —— 被丢掉的设置至少在 app.jsonl 里留了痕,不再是静默(§2.4)。
		if (turn.warnings.length > 0) {
			turn.logger.debug("turn warnings", {
				count: turn.warnings.length,
				kinds: [...new Set(turn.warnings.map((warning) => warning.kind))],
			});
		}
		return {
			type: "finish",
			turn: turn.turn,
			finishReason: this.finish.map(raw.finishReason),
			usage: buckets?.toAgentUsage(),
		};
	}

	// -----------------------------------------------------------------------
	// 发送:401 一次重试 + 首字节超时 + AbortError 原样
	// -----------------------------------------------------------------------

	protected async send(
		url: string,
		headers: Record<string, string>,
		turn: TurnContext,
	): Promise<Response> {
		const body = JSON.stringify(turn.builder.build<TBody>());
		const first = await this.fetchOnce(url, headers, body, turn);
		if (first.status !== 401 || !this.dialect.auth.onUnauthorized) return first;

		const retryHeaders = await this.dialect.auth.onUnauthorized(first, turn);
		if (!retryHeaders) return first;
		await first.body?.cancel().catch(() => undefined);
		return this.fetchOnce(url, retryHeaders, body, turn);
	}

	private async fetchOnce(
		url: string,
		headers: Record<string, string>,
		body: string,
		turn: TurnContext,
	): Promise<Response> {
		const firstByteMs = this.ctx.timeouts?.firstByteMs;
		if (!firstByteMs) {
			return this.ctx.fetchImpl(url, {
				method: "POST",
				headers,
				body,
				signal: turn.request.abortSignal,
			});
		}

		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, firstByteMs);
		const upstream = turn.request.abortSignal;
		const forwardAbort = (): void => controller.abort();
		upstream?.addEventListener("abort", forwardAbort, { once: true });
		if (upstream?.aborted) controller.abort();

		try {
			return await this.ctx.fetchImpl(url, {
				method: "POST",
				headers,
				body,
				signal: controller.signal,
			});
		} catch (error) {
			// 用户中止原样抛;只有我们自己的计时器炸的才映射成 provider 错误。
			if (timedOut && !upstream?.aborted) {
				throw new ProviderHttpError({
					providerId: this.id,
					status: 0,
					code: FIRST_BYTE_TIMEOUT_CODE,
					type: "timeout",
					message: `${this.id} agent loop timed out waiting for the first byte (${firstByteMs}ms)`,
				});
			}
			throw error;
		} finally {
			clearTimeout(timer);
			upstream?.removeEventListener("abort", forwardAbort);
		}
	}

	/**
	 * 空闲超时:两个数据块之间超过 `idleMs` 就让流带着一个
	 * `ProviderHttpError` 结束。不给 `idleMs` 就原样返回(今天的行为)。
	 */
	private watchIdle(response: Response): Response {
		const idleMs = this.ctx.timeouts?.idleMs;
		const source = response.body;
		if (!idleMs || !source) return response;

		const providerId = this.id;
		const reader = source.getReader();
		const watched = new ReadableStream<Uint8Array>({
			async pull(controller) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					const result = await Promise.race([
						reader.read(),
						new Promise<never>((_resolve, reject) => {
							timer = setTimeout(
								() =>
									reject(
										new ProviderHttpError({
											providerId,
											status: 0,
											code: IDLE_TIMEOUT_CODE,
											type: "timeout",
											inStream: true,
											message: `${providerId} agent loop stream idled for ${idleMs}ms`,
										}),
									),
								idleMs,
							);
						}),
					]);
					if (result.done) controller.close();
					else controller.enqueue(result.value);
				} catch (error) {
					if (!isAbortError(error)) await reader.cancel().catch(() => undefined);
					controller.error(error);
				} finally {
					if (timer) clearTimeout(timer);
				}
			},
			cancel(reason) {
				return reader.cancel(reason);
			},
		});

		return new Response(watched, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	}
}
