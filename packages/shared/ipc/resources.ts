/**
 * 资源域的契约(原子 K2a,`docs/design/atom-2026-09.md` §4「所有出口都是投影」的
 * 「RPC 域」那一行)。
 *
 * ## 一个域,零个 scheme 名
 *
 * §4 那张表写的是「每个 scheme **自动**得到 `read` / `do` 两个通用处理器」。所以这
 * 份契约里**没有任何一个具体命名空间的名字**:四条方法(`list` / `describe` /
 * `read` / `do`)对会话、文件、音乐、邮件说的是同一句话,加一种资源不改这只文件
 * 一个字 —— 那正是 §8 陌生能力演练要的答案(「能力自己的模块 + 一行注册」)。
 *
 * 反面写法是给每种资源开一个域(`sessions` / `files` / `music`),那就是今天那 24 个
 * 手写域的形状,以及那笔「24 域授权迁契约」的债。
 *
 * ## 为什么四条里有两条是「问它有什么」
 *
 * `list` / `describe` 是**自述的投影**,不是资源操作:命令面板要列做法、设置页要列
 * 命名空间许可、K4 的 MCP 出口要生成 tool list —— 三者读的必须是同一份自述,而不是
 * 各自维护一张表(§7 盲点 7 那道「投影的一致性」门)。函数(`when` / `describe`)在
 * 这里被丢掉:它们过不了进程边界,而调用方需要知道的只是「这条做法带不带场子闸」
 * (`whenGated`)—— 具体闸不闸由管线在 core 里判,壳不判(§5)。
 *
 * ## 结局是投影,不是异常
 *
 * `read` / `do` 的返回值是 `Outcome` 的**可序列化投影**。`Outcome` 本身带一只
 * `Error`(`failed` 那一支),而 Error 过不了 IPC / HTTP(Electron 会把它揉成
 * `Error invoking remote method …`,HTTP 上干脆没有异常这回事)——`RpcResponse`
 * 那份契约头注释说的就是这件事。所以这里把五态摊成五支纯数据,`failed` 只留
 * 名字与一句话:**类名是给判定读的**(不 match 措辞,`core/tools/abort.ts` 那条判例),
 * 消息是给人读的,堆栈一个字都不过网络。
 *
 * 注意「被拒绝」不是错误:`denied` 是一个正常结局(人说了不),它和 `invalid`
 * (参数写错了)、`failed`(真炸了)是三件不同的事,合成一个 `throw` 就再也分不开。
 */
import type { JsonSchema } from "@onething/core/resource";
import { defineRouter } from "./router.js";

/** 一个在场的命名空间。`list` 只给这两格 —— 详情问 `describe`。 */
export interface ResourceSchemeSummary {
	scheme: string;
	title: string;
}

export interface ListResourcesResponse {
	schemes: ResourceSchemeSummary[];
}

export interface DescribeResourceRequest {
	scheme: string;
}

/** 一条读法的投影。与 `ReadSpec` 逐格相同(它本来就全是数据)。 */
export interface SerializedReadSpec {
	title: string;
	query: JsonSchema;
	result: JsonSchema;
}

/** 一条做法的投影。少了两个函数,多了一格 `whenGated`。 */
export interface SerializedOpSpec {
	title: string;
	params: JsonSchema;
	/** 静态上界(`EffectClass[]`,这里按字符串过线 —— 词汇表在 core)。 */
	effects: string[];
	home: "core" | "shell";
	/**
	 * 这条做法带场子闸(`OpSpec.when`)。**它不说此刻闸开不开** —— 那要在 core 里
	 * 带着场子上下文才判得了,而授权与可用性一律在 core 判(§5)。它说的是
	 * 「这条做法可能在某些场子里不露面」,好让命令面板知道自己列出来的东西可能被拒。
	 */
	whenGated?: boolean;
	entity?: string;
	keymap?: boolean;
}

export interface SerializedEventSpec {
	title: string;
	payload: JsonSchema;
}

export interface SerializedStateSpec {
	title: string;
	schema: JsonSchema;
	volatility: "stable" | "turn" | "live";
}

/** 一份自述的可序列化投影。函数没了,别的一格不少。 */
export interface SerializedResourceSpec {
	scheme: string;
	title: string;
	reads: Record<string, SerializedReadSpec>;
	ops: Record<string, SerializedOpSpec>;
	events: Record<string, SerializedEventSpec>;
	state?: Record<string, SerializedStateSpec>;
}

export interface ReadResourceRequest {
	/** 地址,`<scheme>:<path>`。 */
	ref: string;
	/** 哪一条读法(自述 `reads` 里的名字)。 */
	name: string;
	query?: Record<string, unknown>;
	/**
	 * 从哪条会话里发起的。**可选,而且是发起坐标不是操作对象** —— 操作对象在
	 * `ref` 里。不给 = 这次调用不属于任何会话(审计另落一本,见
	 * `backend/wiring/toolkit/audit-sink.ts`)。
	 */
	sessionId?: string;
}

export interface DoResourceRequest {
	ref: string;
	/** 哪一条做法(自述 `ops` 里的名字)。 */
	op: string;
	params?: Record<string, unknown>;
	sessionId?: string;
}

/**
 * `Outcome` 的可序列化投影。五支与 `core/toolkit/outcome.ts` 一一对应,
 * **判别键同名同义**,是一次转手不是翻译。
 */
export type ResourceOutcomeView =
	| { kind: "ok"; text: string }
	| { kind: "invalid"; message: string }
	| { kind: "denied"; reason: string }
	| { kind: "aborted"; reason?: string; partial?: string }
	| { kind: "failed"; error: { name: string; message: string } };

export type ResourcesRoutes = {
	list: { input: Record<string, never>; output: ListResourcesResponse };
	describe: {
		input: DescribeResourceRequest;
		output: SerializedResourceSpec;
	};
	read: { input: ReadResourceRequest; output: ResourceOutcomeView };
	do: { input: DoResourceRequest; output: ResourceOutcomeView };
};

export const resourcesRouter = defineRouter<ResourcesRoutes>("resources", [
	"list",
	"describe",
	"read",
	"do",
]);
