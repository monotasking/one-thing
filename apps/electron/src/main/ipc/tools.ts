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
	refreshOnethingAsyncToolsForIpc,
	stopOnethingBackgroundJobForIpc,
} from "@onething/runtime/tools";
import { IPC_CHANNELS } from "@shared/ipc.js";
import type { JsonObject } from "@shared/json.js";
import {
	getAllToolsAsync,
	executeTool,
	initializeToolRegistry,
	isInitialized,
	setInitContext,
	initializeAsyncTools,
} from "@onething/app/tools/index.js";
import { getMCPToolDefinitionsForModel } from "@onething/app/mcp/index.js";
import {
	listBackgroundJobs,
	stopBackgroundJob,
} from "@onething/app/tools/core/background-jobs.js";
import * as store from "@onething/app/store.js";
// R3b:开关开时工具列表与直接执行改由目录 / runner 回答(设计文档 §10.2-④)。
import { isToolkitEnabled } from "@onething/runtime/toolkit/flag";
import {
	runToolkitToolDirectly,
	toolkitCatalogToolDefinitions,
} from "@onething/app/toolkit/index.js";

/**
 * Register all tool-related IPC handlers
 */
export function registerToolHandlers() {
	// Initialize the tool registry
	if (!isInitialized()) {
		initializeToolRegistry();
	}

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
			 * 开关开时来自 Catalog + 派生 guard,关时来自旧 registry。目录建不起来
			 * 时 `toolkitCatalogToolDefinitions()` 返回 undefined,原样退回旧路。
			 */
			const toolkitTools = isToolkitEnabled()
				? toolkitCatalogToolDefinitions()
				: undefined;
			return listOnethingSettingsToolsForIpc({
				getSessionsList: () => store.getSessionsList(),
				getSession: (sessionId) => store.getSession(sessionId),
				getAllToolsAsync: toolkitTools
					? async () => toolkitTools
					: getAllToolsAsync,
				getMCPToolDefinitions: getMCPToolDefinitionsForModel,
				setInitContext: (context) =>
					setInitContext(context as Parameters<typeof setInitContext>[0]),
				cwd: () => process.cwd(),
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
					// 开关开且目录里有它 —— 走 runner(两阶段 + 统一取消 + 统一截断 +
					// 审计)。目录里没有就 `undefined`,原样退回旧路。
					if (isToolkitEnabled()) {
						const outcome = await runToolkitToolDirectly(
							id,
							toolArgs,
							context as Parameters<typeof runToolkitToolDirectly>[2],
						);
						if (outcome) return outcome;
					}
					return executeTool(
						id,
						toolArgs,
						context as Parameters<typeof executeTool>[2],
					);
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
		refreshAsyncTools: async ({ workingDirectory }: ElectronRefreshAsyncToolsRequest) => {
			return refreshOnethingAsyncToolsForIpc({
				workingDirectory,
				setInitContext: (context) =>
					setInitContext(context as Parameters<typeof setInitContext>[0]),
				initializeAsyncTools,
				logger: console,
			});
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

	console.log("[Tools IPC] Handlers registered");
}
