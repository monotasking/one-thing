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

/**
 * 一扇壳把它的 `home: 'shell'` 资源交上来(原子 K2b-2,`docs/design/atom-2026-09.md`
 * §10.2「**home 在 shell 的**寿命 = 那扇壳的连接」)。
 *
 * `shellId` 是那扇壳给自己起的名字,后端只拿它当**坐标**用:命令往哪扇壳发、
 * 断线时该撤哪一批自述、一条回执认不认。它不是身份 —— 身份是主体
 * (`rpc/principal.ts` 铸的那一个),两者不可互相替代。
 *
 * `spec` 是 `describe` 交出去的那一份投影的**反方向**:函数字段过不了进程边界,
 * 所以壳交上来的自述里没有 `when` / `describe`,`whenGated` 交上来也会被忽略
 * (「此刻露不露面」的判据在 core,壳不判 —— §5)。
 */
export interface MountShellResourceRequest {
	shellId: string;
	spec: SerializedResourceSpec;
}

/**
 * 登记的结局。**「这个 scheme 已经被别人占了」是一个正常结局,不是异常** ——
 * 与 `ResourceOutcomeView` 里 `denied` 不是 `failed` 是同一条纪律:一次被拒绝的
 * 登记(另一扇壳先到、或者 core 自己就有一份同名自述)是调用方要处理的分支,
 * 不是一次要写进错误日志的意外。
 */
export type MountShellResourceResponse =
	| { ok: true }
	| { ok: false; reason: "scheme-taken" };

/** 撤掉这扇壳交上来的**全部** scheme。幂等 —— 撤一扇已经不在的壳是成功。 */
export interface UnmountShellResourcesRequest {
	shellId: string;
}

/**
 * 一条壳命令的回执。两支,与 `Outcome` 的五支**不**一一对应,是刻意的:
 * 授权、取消、参数校验四件事都已经在 core 里发生完了,壳只回答「我跑了,结果是
 * 这个」或者「我没跑成,因为这个」。让壳能回一个 `denied` 等于把授权权交给它,
 * 而「授权永远在 core 里做」是 §5 的整句话。
 */
export type ShellCommandResult =
	| { kind: "ok"; text: string }
	| { kind: "failed"; message: string };

export interface ShellResultRequest {
	shellId: string;
	callId: string;
	result: ShellCommandResult;
}

/**
 * 一扇壳报一条**事实**(原子 K2b-2b,`docs/design/atom-2026-09.md` §10.3
 * 「`opened` / `closed` / `deleted` 是资源事件的三条通用名,每个 scheme 都发」)。
 *
 * ## 它为什么与 `shellResult` 是两条,不是一条
 *
 * `shellResult` 是**回执**:某一次命令的结局,由 `callId` 缝合,有且只有一个收件人
 * (那次调用)。这一条是**事实**:没有人问过,它就是发生了 —— 一格标签被用户用鼠标
 * 关掉了,没有任何一次 `do` 与它对应。两者合成一条就得为「没有 callId 的回执」
 * 造一档特例,而那正是「一件事两条路」的反面写法。
 *
 * ## 它不新开通道
 *
 * 事实进 core 之后走的仍是 K2a 那条既有的路:provider 的 `emit()` → `ResourceEventHub`
 * → `wiring/resource/event-bridge.ts` → 全局事件 `resource:event` → SSE。这条 RPC
 * 只是把「壳这一侧的 hub 入口」接出来。
 *
 * ## 两道判定都在 core
 *
 * `shellId` 要登记过(与 `shellResult` 同一条:这条通道不给陌生人用),而且 `ref` 的
 * scheme 必须**归这扇壳**——否则一扇壳可以替 `session:` 编造一条 `deleted`,而
 * 「谁能替谁说话」从来不由说话的人自己声明。
 */
export interface EmitShellResourceEventRequest {
	shellId: string;
	/** 地址,`<scheme>:<path>`。scheme 必须是这扇壳交上来的那几个之一。 */
	ref: string;
	/** 自述 `events` 里的名字(`opened` / `closed` / `deleted` 或这个 scheme 自己的)。 */
	event: string;
	payload?: unknown;
}

/** 四条壳面里三条的回答:收到了。没有第二种结局。 */
export interface ShellAckResponse {
	ok: true;
}

export type ResourcesRoutes = {
	list: { input: Record<string, never>; output: ListResourcesResponse };
	describe: {
		input: DescribeResourceRequest;
		output: SerializedResourceSpec;
	};
	read: { input: ReadResourceRequest; output: ResourceOutcomeView };
	do: { input: DoResourceRequest; output: ResourceOutcomeView };
	mountShell: {
		input: MountShellResourceRequest;
		output: MountShellResourceResponse;
	};
	unmountShell: {
		input: UnmountShellResourcesRequest;
		output: ShellAckResponse;
	};
	shellResult: { input: ShellResultRequest; output: ShellAckResponse };
	emit: { input: EmitShellResourceEventRequest; output: ShellAckResponse };
};

export const resourcesRouter = defineRouter<ResourcesRoutes>("resources", [
	"list",
	"describe",
	"read",
	"do",
	"mountShell",
	"unmountShell",
	"shellResult",
	"emit",
]);
