/**
 * Tools IPC Handlers
 *
 * Handles IPC communication for tool-related operations:
 * - Get all available builtin tools
 * - Execute a tool
 * - Cancel a tool execution
 */

import {
	registerElectronToolsIpcHandlers,
	type ElectronBackgroundJobsListRequest,
	type ElectronBackgroundJobsStopRequest,
	type ElectronRefreshAsyncToolsRequest,
	type ElectronToolCancelRequest,
} from "@onething/electron-host/ipc/tools";
import {
	applyOnethingToolCallUpdateForIpc,
	cancelOnethingToolForIpc,
	executeOnethingToolWithSessionContextForIpc,
	listOnethingBackgroundJobsForIpc,
	listOnethingSettingsToolsForIpc,
	type OnethingToolCallStateLike,
	stopOnethingBackgroundJobForIpc,
} from "@onething/runtime/tools";
import { IPC_CHANNELS } from "@shared/ipc.js";
import type { JsonObject } from "@shared/json.js";
import { getMCPToolDefinitionsForModel } from "@onething/app/mcp/index.js";
import {
	listBackgroundJobs,
	stopBackgroundJob,
} from "@onething/runtime/tools/background-jobs-bound";
import * as store from "@onething/app/store.js";
// 工具列表与直接执行由目录 / runner 回答(设计文档 §10.2-④)。
import {
	refreshToolkitMcpTools,
	runToolkitToolDirectly,
	toolkitCatalogToolDefinitions,
} from "@onething/app/toolkit/index.js";
import { getLogger } from "@onething/app/logging/index.js";

const log = getLogger("ipc.tools");

/**
 * Register all tool-related IPC handlers
 */
export function registerToolHandlers() {
	registerElectronToolsIpcHandlers({
		channels: {
			getTools: IPC_CHANNELS.GET_TOOLS,
			executeTool: IPC_CHANNELS.EXECUTE_TOOL,
			cancelTool: IPC_CHANNELS.CANCEL_TOOL,
			backgroundJobsList: IPC_CHANNELS.BACKGROUND_JOBS_LIST,
			backgroundJobsStop: IPC_CHANNELS.BACKGROUND_JOBS_STOP,
			refreshAsyncTools: IPC_CHANNELS.REFRESH_ASYNC_TOOLS,
			updateToolCall: IPC_CHANNELS.UPDATE_TOOL_CALL,
		},
		getTools: async () => {
			/*
			 * 呈现一个字不改(`listOnethingSettingsToolsForIpc` 是同一个函数、同一份
			 * MCP 合并、同一条 source 推导),换的只是"有哪些工具"这一格的来源:
			 * Catalog + 派生 guard。目录建不起来时报空表 —— 这台宿主确实没有工具。
			 */
			return listOnethingSettingsToolsForIpc({
				getAllToolsAsync: () => toolkitCatalogToolDefinitions() ?? [],
				getMCPToolDefinitions: getMCPToolDefinitionsForModel,
				logger: console,
			});
		},
		executeTool: async (request: unknown) => {
			const { toolId, arguments: args, messageId, sessionId } = request as {
				toolId: string
				arguments: JsonObject
				messageId: string
				sessionId: string
			};
			return executeOnethingToolWithSessionContextForIpc({
				toolId,
				args,
				sessionId,
				messageId,
				getSession: (id) => store.getSession(id),
				executeTool: async (id, toolArgs, context) => {
					// runner:两阶段 + 统一取消 + 统一截断 + 审计。目录里没有这个
					// 名字时如实报 tool-not-found(R4b 之后没有第二条路)。
					const outcome = await runToolkitToolDirectly(
						id,
						toolArgs,
						context as Parameters<typeof runToolkitToolDirectly>[2],
					);
					return outcome ?? { success: false, error: `Tool not found: ${id}` };
				},
				logger: console,
			});
		},
		cancelTool: async ({ toolCallId }: ElectronToolCancelRequest) => {
			return cancelOnethingToolForIpc({ toolCallId, logger: console });
		},
		backgroundJobsList: async ({ includeInactive }: ElectronBackgroundJobsListRequest = {}) => {
			return listOnethingBackgroundJobsForIpc({ includeInactive, listJobs: listBackgroundJobs });
		},
		backgroundJobsStop: async ({ jobId }: ElectronBackgroundJobsStopRequest) => {
			return stopOnethingBackgroundJobForIpc({ jobId, stopJob: stopBackgroundJob });
		},
		/*
		 * R4b:旧路刷的是「异步工具」—— 一批要靠 `setInitContext(cwd/skills)` +
		 * `initializeAsyncTools()` 才拿得到 schema 的注册表条目。新树里没有这个
		 * 概念(懒初始化是 `Catalog.ensurePrepared`,按工具、按需、只跑一次),
		 * 唯一会在运行期改变的工具面是 MCP,所以这条通道现在刷的就是它。
		 * 契约(通道名与返回形状)一个字未动。
		 */
		refreshAsyncTools: async (_request: ElectronRefreshAsyncToolsRequest) => {
			try {
				refreshToolkitMcpTools();
				return { success: true as const };
			} catch (error) {
				log.error("refresh MCP tools failed", undefined, error);
				return {
					success: false as const,
					error: error instanceof Error && error.message
						? error.message
						: "Failed to refresh tools",
				};
			}
		},
		updateToolCall: async (request: unknown) => {
			const { sessionId, messageId, toolCallId, updates } = request as {
				sessionId: string
				messageId: string
				toolCallId: string
				updates: Partial<OnethingToolCallStateLike>
			};
			return applyOnethingToolCallUpdateForIpc({
				sessionId,
				messageId,
				toolCallId,
				updates,
				getSession: (id) => store.getSession(id),
				updateMessageToolCalls: (id, targetMessageId, toolCalls) =>
					store.updateMessageToolCalls(
						id,
						targetMessageId,
						toolCalls as Parameters<typeof store.updateMessageToolCalls>[2],
					),
				updateMessageStep: (id, targetMessageId, stepId, stepUpdates) =>
					store.updateMessageStep(
						id,
						targetMessageId,
						stepId,
						stepUpdates as Parameters<typeof store.updateMessageStep>[3],
					),
				logger: console,
			});
		},
	});

	log.info("handlers registered");
}
