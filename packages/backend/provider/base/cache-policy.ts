/**
 * `CachePolicy` —— 缓存断点由谁打(设计稿 §3)。
 *
 * OpenAI `prompt_cache_breakpoint` / Anthropic `cache_control` /
 * OpenRouter 互转 / Gemini `cachedContent` / 什么都不打 —— 每种是一个对象,
 * 不是基类里的一段 if。P0a 只落一个「什么都不打」,它是今天的行为。
 */
import type { RequestBodyBuilder } from "./request-body-builder.js";
import type { TurnContext } from "./turn-context.js";

export interface CachePolicy {
	annotate(turn: TurnContext, builder: RequestBodyBuilder): void;
}

export class NoCachePolicy implements CachePolicy {
	annotate(): void {}
}

export const noCachePolicy: CachePolicy = new NoCachePolicy();
