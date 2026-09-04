/**
 * `search-corpus-redact.mjs` 的类型面。
 *
 * 为什么要这一份:那个模块是 `scripts/` 下的 `.mjs`(脚本就该是脚本),而
 * `packages/core/search/__tests__/fixtures.test.ts` 要 import 它 —— 仓里
 * `allowJs` 是关的,没有这份声明 tsc 就答「找不到声明文件」。
 * **一份实现、两个消费者**(抽取脚本与夹具自检)是刻意的:两边跑的必须是同一份规则,
 * 不然「洗过的语料再洗一遍恒等」这句话就不成立。
 *
 * 面本身没有形状可加:规则 8(`public-ipv4`)带的那格 `accept(match)` 谓词是**规则表
 * 内部**的事 —— `redactText` 只换它点头的,`findRedactionHits` 也只把它点头的算命中,
 * 所以外面看到的仍然是「洗 / 验 / id 表」这三样。规则条数变了 `REDACT_RULE_IDS`
 * 自己就长了(它是从规则表算出来的),这份声明不需要跟着改。
 */
export declare const REDACT_RULE_IDS: readonly string[]
export declare function redactText<T>(text: T): T
export declare function findRedactionHits(text: unknown): string[]
