/**
 * 已认证的来访者 → 通用 RPC 通道的 dispatch context 与这条面自带的函数端口。
 *
 * 路由在鉴权之后调这两只(`http-server-routes.ts`),把结果交给 `dispatchRpc`。
 *
 * 2026-10-04 从 `http-server-runtime.ts` 原样搬来(决策 D219),代码一行没改。
 */
import type { ServerResponse } from "node:http";
import type { RpcDispatchContext } from "@shared/ipc/rpc.js";
import { watchClientDisconnect } from './http-server-request-abort.js'
import { workspaceSandboxRoot } from "./http-server-sandbox.js";
import type { RpcDispatchPorts } from "./http-server-dispatch-table.js";
import type { RuntimeFilesAdapter, RuntimeRequestContext } from "./http-server-runtime-facade.js";

/** 壳坐标的形状:客户端现铸的 uuid(或测试替身里的短名)。 */
const SHELL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * 已认证身份 → 通用 RPC 通道的 dispatch context（主线 T 批 3）。
 *
 * 住在 runtime 而不是 http.ts,是因为「owner 的沙箱根长什么样」本来就是这个
 * 文件的知识;http.ts 只负责在鉴权之后把它取出来交给 `dispatchRpc`。
 * 身份字段来自 bearer 门放行之后的 RuntimeRequestContext；私有监听能力来自
 * 当前 surface 的 files 端口。两者均不从客户端可控的 RPC 信封恢复。
 */
export function createServerRpcDispatchContext(
	workspaceRoot: string | undefined,
	context: RuntimeRequestContext,
	/**
	 * 这一发的响应对象 —— 用来观察「调用方还在不在」(09-07 事故第四条修;
	 * 判据与理由都在 `request-abort.ts`)。**可选**:铸不出这个观察的调用方
	 * (单测、进程内直调)不给,于是 `signal` 缺席 = 「没人能告诉你调用方走了」。
	 *
	 * 它铸在这里而不是在路由处理者里,理由与这张表上别的格逐字相同:
	 * **身份与处境由宿主一次铸齐**,处理者只读,不自己去看连接。
	 */
	response?: ServerResponse,
	/**
	 * 请求头 `X-Onething-Shell-Id` 的原值(决策 D277)。合规矩(1–128 个字母、数字、`-`、`_`)
	 * 才铸进 `callerId`;不合就当没带 —— 它只是一个坐标,答错了的后果是命令发给了「最近活动的
	 * 那一扇」,不是越权。
	 */
	shellIdHeader?: string,
	/**
	 * 请求头 `X-Onething-Acting-System` 的原值(第④步批 3)。解得开、1–128 个字符、没有控制字符才铸进
	 * `actingSystemComponent`;不合就当没带 —— 它只会把主体**降**成 `system`,答错的后果是这一发按本来的主体走。
	 */
	actingSystemHeader?: string,
): RpcDispatchContext {
	const callerId = shellIdHeader && SHELL_ID_PATTERN.test(shellIdHeader) ? shellIdHeader : undefined;
	const actingSystemComponent = actingSystemComponentOf(actingSystemHeader);
	return {
		transport: "http",
		ownerUid: context.userId,
		workspaceId: context.workspaceId,
		...(callerId ? { callerId } : {}),
		...(actingSystemComponent ? { actingSystemComponent } : {}),
		sandboxRoot: workspaceRoot
			? workspaceSandboxRoot(workspaceRoot, context)
			: undefined,
		...(response === undefined
			? {}
			: { signal: watchClientDisconnect(response) }),
	};
}

/** 组件名的规矩:解得开、去掉首尾空白后 1–128 个字符、没有控制字符。 */
function actingSystemComponentOf(header: string | undefined): string | undefined {
	if (!header) return undefined;
	let decoded: string;
	try {
		decoded = decodeURIComponent(header).trim();
	} catch {
		return undefined;
	}
	// eslint-disable-next-line no-control-regex
	if (!decoded || decoded.length > 128 || /[\u0000-\u001f\u007f]/.test(decoded)) return undefined;
	return decoded;
}

/**
 * 这条 surface 自己带来的函数端口(工单 4 C3)。
 *
 * 与上面那个 context 分开:context 是纯数据(身份 + 作用域,到处被 spread),
 * 端口是函数。从前监听端口是用一个 Symbol + 非枚举属性挂在 context 上的 ——
 * 类型上说不出口,而且任何一次 `{ ...context }` 都会把它悄悄丢掉。
 */
export function createServerRpcDispatchPorts(
	files?: RuntimeFilesAdapter,
): RpcDispatchPorts | undefined {
	if (!files) return undefined;
	return {
		workspaceWatch: {
			startWorkspaceWatch: files.startWorkspaceWatch?.bind(files),
			stopWorkspaceWatch: files.stopWorkspaceWatch?.bind(files),
		},
	};
}
