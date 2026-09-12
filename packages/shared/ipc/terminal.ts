/**
 * Terminal Module
 * Wire contracts for the real PTY terminal (user-driven shells; NOT the ACP
 * protocol "terminal", which is a pipes-based registry inside the ACP client).
 * See docs/design/terminal-system.md.
 */
import { defineRouter } from "./router.js";

export interface TerminalCreateRequest {
	cwd?: string
	shell?: string
	/**
	 * cols/rows may be omitted: at create time xterm is not mounted yet and
	 * cannot be measured. The service spawns at 80x24 and the first mounted
	 * view corrects via resize.
	 */
	cols?: number
	rows?: number
	/** Seeds the initial cwd only — terminals are app-scoped, not session-scoped. */
	sessionId?: string
}

export interface TerminalInfo {
	id: string
	title: string
	cwd: string
	shell: string
	cols: number
	rows: number
	createdAt: number
	exited?: { code: number | null }
}

export interface TerminalCreateResponse {
	success: boolean
	terminal?: TerminalInfo
	error?: string
}

export interface TerminalListResponse {
	success: boolean
	terminals: TerminalInfo[]
	error?: string
}

export interface TerminalWriteRequest {
	terminalId: string
	data: string
}

export interface TerminalResizeRequest {
	terminalId: string
	cols: number
	rows: number
}

export interface TerminalKillRequest {
	terminalId: string
}

/**
 * Flow-control ack, one-way renderer→main (ipcRenderer.send, no invoke round
 * trip — a lost ack only delays resume by one beat; the attach generation
 * protocol resets the ledger anyway).
 * `bytes` is measured in JS string length (UTF-16 code units) on BOTH sides —
 * mixing utf8 byte counts would drift the watermark ledger on CJK output.
 */
export interface TerminalAckPayload {
	terminalId: string
	bytes: number
	generation: number
}

export interface TerminalAttachRequest {
	terminalId: string
}

export interface TerminalOutputChunk {
	seq: number
	data: string
}

/**
 * Attach = reattach protocol (renderer reload / view mount): one call returns
 * the scrollback snapshot AND resets the flow-control generation.
 */
export interface TerminalAttachResponse {
	success: boolean
	/** Carries current cols/rows — open/resize xterm to these BEFORE replaying. */
	info?: TerminalInfo
	chunks?: TerminalOutputChunk[]
	lastSeq?: number
	/** True when the ring buffer wrapped: replay may start mid-escape-sequence — write a full reset (\x1bc) first. */
	truncated?: boolean
	/** Flow-control generation; every ack must carry it, stale-generation acks are dropped. */
	generation?: number
	error?: string
}

export interface TerminalSimpleResponse {
	success: boolean
	error?: string
}

/** 一批终端输出。T0 起它是全局事件 `terminal:data` 的载荷(见下方「两条推送不在这条路上」)。 */
export interface TerminalDataEvent {
	terminalId: string
	seq: number
	data: string
}

/** 一格 PTY 死了。全局事件 `terminal:exit` 的载荷;服务侧保证它排在最后一批输出 flush 之后。 */
export interface TerminalExitEvent {
	terminalId: string
	exitCode: number | null
}

/**
 * terminal(真 PTY 终端)域 —— 结构债 P4 终态批 D2(用户拍板:「D2 terminal 迁 +
 * 能力位默认关」)。
 *
 * 七条请求面(`create` / `list` / `write` / `resize` / `kill` / `attach` / `ack`)
 * 整只从手写 IPC 通道搬到通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * ## `ack` 从单向 send 变成有应答的 invoke
 *
 * 它从前是 `ipcRenderer.send`(不带回执):flush 节拍上的一条纯通知,丢一条只是
 * 把恢复推迟一拍,attach 的世代协议本来就会把账本清零。router 只有请求/响应面,
 * 所以搬过来之后它有了一条 `{ success: true }` 的空回执 —— **渲染侧本来就不等它**
 * (`xterm.write` 的回调里发出去就不管了),所以可感知行为不变。
 * 与 `VOICE_AUDIO_CHUNK` 的判例(拍板 #10,退回单向手写通道)的差别在频次:
 * PCM 是每秒 10–25 块的稳定上行,ack 只在终端真有输出时按 16ms flush 节拍走一条。
 *
 * ## 两条推送不在这条路上
 *
 * 输出走**注入广播器端口**(`configureTerminalBroadcaster`,
 * `@onething/runtime/terminal/service.wiring`),而 router 今天只有请求/响应面。
 *
 * P4-D2 当时把 `TERMINAL_DATA` / `TERMINAL_EXIT` 两条通道常量留在了手写 IPC 上
 * (同 practice / scratchpad / oauth 判例);**T0(2026-09-12)把它们删了** ——
 * 两年里没有一个 import,而真正把输出送出 core 的那条路是两条**全局事件**
 * (`@shared/events` 的 `TerminalDataGlobalEvent` / `TerminalExitGlobalEvent`,
 * 骑 `GET /api/events`):React 壳只有一条 `host:connection` IPC,手写通道在它
 * 身上结构性地走不通。下面这两个**载荷类型**原样留在这里 —— 全局事件 `extends`
 * 的就是它们,形状只有一份。
 */
export type TerminalRoutes = {
	create: { input: TerminalCreateRequest; output: TerminalCreateResponse };
	list: { input: Record<string, never>; output: TerminalListResponse };
	write: { input: TerminalWriteRequest; output: TerminalSimpleResponse };
	resize: { input: TerminalResizeRequest; output: TerminalSimpleResponse };
	kill: { input: TerminalKillRequest; output: TerminalSimpleResponse };
	attach: { input: TerminalAttachRequest; output: TerminalAttachResponse };
	ack: { input: TerminalAckPayload; output: TerminalSimpleResponse };
};

export const terminalRouter = defineRouter<TerminalRoutes>("terminal", [
	"create",
	"list",
	"write",
	"resize",
	"kill",
	"attach",
	"ack",
]);
