/**
 * 宿主工具面的跨进程契约(ACP A4-a,`docs/design/acp-integration-2026-09.md` §3.6 / §11.5)。
 *
 * **只认桥凭据的域。** 调用方是 `acp-mcp-bridge.cjs` 那个薄进程(stdio 上说 MCP、在这里
 * 说 RPC),或者 `/api/mcp` 那张 HTTP 面;两者手里都是宿主为「某台 agent × 某条会话」签的
 * 一把钥匙(`RpcDispatchContext.bridgeCredential`),不是用户 token。用户 token 调这个域
 * 一律拒 —— 工具表是**按凭据**算的(它背后是哪条会话、哪张牌),没有凭据就没有表。
 *
 * 形状刻意贴着 MCP:`listTools` 答的就是 `tools/list` 的 `tools`,`callTool` 答的就是
 * `tools/call` 的 `CallToolResult` 子集 —— 桥因此不翻译,只转手。
 */
import { defineRouter } from "./router.js";

/** 一只工具,MCP `Tool` 的子集。`inputSchema` 是 JSON Schema(`type: 'object'`)。 */
export interface HostMcpToolListing {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export interface HostMcpListToolsResponse {
	tools: HostMcpToolListing[];
}

export interface HostMcpCallToolRequest {
	name: string;
	args?: Record<string, unknown>;
}

/** MCP `CallToolResult` 里我们用得到的那一小块。 */
export interface HostMcpCallToolResponse {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

export type HostMcpRoutes = {
	listTools: { input: Record<string, never>; output: HostMcpListToolsResponse };
	callTool: { input: HostMcpCallToolRequest; output: HostMcpCallToolResponse };
};

export const hostMcpRouter = defineRouter<HostMcpRoutes>("host-mcp", ["listTools", "callTool"]);

/**
 * 凭据查不到时的那句话的**前缀**。RPC 的失败只带 message(处理者的错误码在派发那一层
 * 不保留),桥与测试靠这个前缀认出「钥匙不对」而不是别的失败。
 */
export const HOST_MCP_UNAUTHORIZED = "HOST_MCP_UNAUTHORIZED";

// 桥进程的环境变量名 / 服务器名 / `/api/mcp` 路径住在产品层
// `@onething/runtime/acp/mcp-bridge/server`:桥入口是产品层文件,而产品层不许 import
// `@shared/ipc`(只有 `*.wiring.ts` 例外),所以那几个名字归它,装配层从它那里取。
