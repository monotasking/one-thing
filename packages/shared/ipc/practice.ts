/**
 * Practice system IPC types: kegel / pomodoro rhythm sessions plus manual
 * exercise logging. See docs/design/practice-system.md.
 */
import { defineRouter } from "./router.js";
import type {
	OnethingPracticeConfig,
	OnethingPracticeEngineSnapshot,
	OnethingPracticeEventPayload,
	OnethingPracticeExerciseDetail,
	OnethingPracticeLedgerRecord,
	OnethingPracticeLogRequest,
	OnethingPracticeSetConfigRequest,
	OnethingPracticeStartRequest,
	OnethingPracticeSummaryRequest,
	OnethingPracticePhaseEdge,
	OnethingPracticeSummaryGranularity,
	OnethingPracticeSummaryResult,
} from "../contracts/practice.js";

export type PracticeSnapshot = OnethingPracticeEngineSnapshot;
export type PracticePhaseEdge = OnethingPracticePhaseEdge;
export type PracticeConfig = OnethingPracticeConfig;
export type PracticeLedgerRecord = OnethingPracticeLedgerRecord;
export type PracticeSummaryGranularity = OnethingPracticeSummaryGranularity;
export type PracticeSummaryResult = OnethingPracticeSummaryResult;

/* 五个请求/事件形状住在契约层(工单 5 §5);这里只是传输面的名字。 */
export type PracticeStartRequest = OnethingPracticeStartRequest;

export interface PracticeStopRequest {
	/** Cancel: drop the session without settling a ledger record. */
	discard?: boolean;
}

export interface PracticeStateResponse {
	snapshot: PracticeSnapshot;
}

/** Manual/agent quick-log: either sets×reps or a duration (or both). */
export type PracticeLogRequest = OnethingPracticeLogRequest;

export interface PracticeLogResponse {
	record: PracticeLedgerRecord;
}

export type PracticeSummaryRequest = OnethingPracticeSummaryRequest;

export interface PracticeRecentRequest {
	/** Trailing window in days (default 7). */
	days?: number;
	limit?: number;
}

export interface PracticeRecentResponse {
	records: PracticeLedgerRecord[];
}

export type PracticeSetConfigRequest = OnethingPracticeSetConfigRequest;

export interface PracticeConfigResponse {
	config: PracticeConfig;
}

/**
 * Pushed to the renderer on every engine transition and ~1 Hz while running.
 * `settled` is present exactly once per session, when it lands in the ledger.
 */
export type PracticeEventPayload = OnethingPracticeEventPayload;

/**
 * practice(练习:kegel / 番茄钟 / 运动账本)域 —— 结构债 P4a 的第二个域
 * (第一个是 spaces)。
 *
 * 十个方法全是**纯数据面**:节奏引擎的开始/暂停/继续/停止/读态、账本的
 * 记一笔/汇总/最近、配置的读写。引擎本身(1Hz 定时器 + 结算)住在
 * `@onething/runtime/practice`,传输面只递不判 —— 这也是它能整只搬进
 * `app/rpc/domains/practice.ts` 的原因。
 *
 * **无入参的方法一律 `Record<string, never>`**,调用处传 `{}`(spaces 的
 * `list({})` 判例):router 的 payload 是一个信封,位置参数在这条通道上没有
 * 位置。`stop` 的 `discard` 因此也从「可选的位置参数」变成信封里的一个可选键。
 *
 * 不在这条路上的:`IPC_CHANNELS.PRACTICE_EVENT` 推送(引擎每次相变 + 运行时
 * ~1Hz 往渲染层推的那条)。它**早就是注入端口**了
 * (`configurePracticeEventBroadcaster`),而 router 今天只有请求/响应面、
 * 没有推送面 —— 所以那条通道常量与 `PracticeEventPayload` 原样留在手写 IPC 上,
 * `@main/ipc/practice.ts` 迁完只剩这一条广播注入。
 */
export type PracticeRoutes = {
	start: { input: PracticeStartRequest; output: PracticeStateResponse };
	pause: { input: Record<string, never>; output: PracticeStateResponse };
	resume: { input: Record<string, never>; output: PracticeStateResponse };
	stop: { input: PracticeStopRequest; output: PracticeStateResponse };
	getState: { input: Record<string, never>; output: PracticeStateResponse };
	log: { input: PracticeLogRequest; output: PracticeLogResponse };
	summary: { input: PracticeSummaryRequest; output: PracticeSummaryResult };
	recent: { input: PracticeRecentRequest; output: PracticeRecentResponse };
	getConfig: { input: Record<string, never>; output: PracticeConfigResponse };
	setConfig: { input: PracticeSetConfigRequest; output: PracticeConfigResponse };
};

export const practiceRouter = defineRouter<PracticeRoutes>("practice", [
	"start",
	"pause",
	"resume",
	"stop",
	"getState",
	"log",
	"summary",
	"recent",
	"getConfig",
	"setConfig",
]);
