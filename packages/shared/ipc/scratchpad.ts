export interface ScratchpadDocument {
	sessionId: string;
	filePath: string;
	content: string;
	/**
	 * Revision marker for read-watermark correlation: the file's mtime in ms.
	 * 0 means the scratchpad has never been written.
	 */
	version: number;
	updatedAt: number;
}

export interface ScratchpadGetRequest {
	sessionId: string;
}

export interface ScratchpadGetResponse {
	success: boolean;
	document?: ScratchpadDocument;
	error?: string;
}

export interface ScratchpadUpdateRequest {
	sessionId: string;
	content: string;
}

export interface ScratchpadUpdateResponse {
	success: boolean;
	document?: ScratchpadDocument;
	error?: string;
}

export interface ScratchpadDeleteRequest {
	sessionId: string;
}

export interface ScratchpadDeleteResponse {
	success: boolean;
	error?: string;
}

/** Rename a draft session's scratchpad to the real id it materialized into. */
export interface ScratchpadAdoptRequest {
	fromSessionId: string;
	toSessionId: string;
}

export interface ScratchpadAdoptResponse {
	success: boolean;
	error?: string;
}

export interface ScratchpadChangedPayload {
	sessionId: string;
	document?: ScratchpadDocument;
}

/**
 * scratchpad(每会话草稿纸)域 —— 结构债 P4c 第五域。
 *
 * 四个方法都是**纯数据面**:读一份、写一份、删一份、把草稿会话的那份改名认领到
 * 真实 session id 上。文件读写与 `<store>` 下的落点住在 `@onething/runtime/scratchpad`,
 * 传输面只递不判。
 *
 * **推送不在这个域里**:`SCRATCHPAD_CHANGED` 早就是注入端口
 * (`configureScratchpadHost`),而 router 今天只有请求/响应面、没有推送面 ——
 * 所以那条通道常量与 `ScratchpadChangedPayload` 原样留在手写 IPC 上
 * (`@main/ipc/scratchpad.ts` 迁完只剩这一条广播注入),server 侧的
 * `GET /api/scratchpad/events` SSE 同理保留。
 */
import { defineRouter } from "./router.js";

export type ScratchpadRoutes = {
	get: { input: ScratchpadGetRequest; output: ScratchpadGetResponse };
	update: { input: ScratchpadUpdateRequest; output: ScratchpadUpdateResponse };
	delete: { input: ScratchpadDeleteRequest; output: ScratchpadDeleteResponse };
	adopt: { input: ScratchpadAdoptRequest; output: ScratchpadAdoptResponse };
};

export const scratchpadRouter = defineRouter<ScratchpadRoutes>("scratchpad", [
	"get",
	"update",
	"delete",
	"adopt",
]);
