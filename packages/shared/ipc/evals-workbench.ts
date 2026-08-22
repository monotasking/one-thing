/**
 * evalsWorkbench(事故工作台:事故包 / 回放 / AI 分析 / 晋升 / 逐轮 / 诊断)域 ——
 * 结构债 P4c 第十批,十一条数据面整只从手写 IPC 通道迁到通用 `rpc:invoke` /
 * `POST /api/rpc`。
 *
 * 十一条逐条对应从前 `IPC_CHANNELS` 上那十一条 `evals:*` invoke 通道 —— 全是
 * `apps/electron/src/main/ipc/evals-workbench.ts` 里的裸 `ipcMain.handle`。
 * 请求/响应形状一字未改;变的只是通道。
 *
 * **两条推送留在原地**(`EVALS_REPLAY_PROGRESS` / `EVALS_DIAGNOSE_PROGRESS`)——
 * router 今天没有推送面,它们改走 `backend/wiring/evals/events.ts` 的
 * `configureEvalsEventBroadcaster` 注入端口(与 evals 域那条 run 进度同一个端口)。
 *
 * **为什么另立一个域而不是并进 `evals`**:两者是两张不同的账 —— evals 域算的是
 * 「用例跑批」(夹具 / 用例 / results.jsonl),工作台算的是「一次事故的现场」
 * (事故包 / 回放 / 诊断报告)。它们在渲染侧也是两个 store
 * (`stores/evals.ts` / `stores/evalsWorkbench.ts`),迁移不合并职责。
 *
 * 类型全部收自 `./evals.js` —— 契约文件不因为域拆成两个就把类型也抄两份;
 * 这里只新立两条从前没有具名类型的(`replayCancel` 的请求/响应)。
 */
import type {
	EvalsDiagnoseStartRequest,
	EvalsDiagnoseStartResponse,
	EvalsIncidentAnalyzeRequest,
	EvalsIncidentAnalyzeResponse,
	EvalsIncidentGetRequest,
	EvalsIncidentGetResponse,
	EvalsIncidentListResponse,
	EvalsIncidentPromoteRequest,
	EvalsIncidentPromoteResponse,
	EvalsIncidentReadFileRequest,
	EvalsIncidentReadFileResponse,
	EvalsIncidentUpdateRequest,
	EvalsIncidentUpdateResponse,
	EvalsReplayStartRequest,
	EvalsReplayStartResponse,
	EvalsRoundListRequest,
	EvalsRoundListResponse,
	EvalsRoundReplayRequest,
	EvalsRoundReplayResponse,
} from "./evals.js";
import { defineRouter } from "./router.js";

/** 迁移前这一条是匿名内联的 `{ incidentId: string }`,搬家顺手给它一个名字。 */
export interface EvalsReplayCancelRequest {
	incidentId: string;
}

export interface EvalsReplayCancelResponse {
	success: boolean;
	error?: string;
}

export type EvalsWorkbenchRoutes = {
	incidentList: { input: Record<string, never>; output: EvalsIncidentListResponse }
	incidentGet: { input: EvalsIncidentGetRequest; output: EvalsIncidentGetResponse }
	incidentUpdate: { input: EvalsIncidentUpdateRequest; output: EvalsIncidentUpdateResponse }
	incidentReadFile: { input: EvalsIncidentReadFileRequest; output: EvalsIncidentReadFileResponse }
	replayStart: { input: EvalsReplayStartRequest; output: EvalsReplayStartResponse }
	replayCancel: { input: EvalsReplayCancelRequest; output: EvalsReplayCancelResponse }
	incidentAnalyze: { input: EvalsIncidentAnalyzeRequest; output: EvalsIncidentAnalyzeResponse }
	incidentPromote: { input: EvalsIncidentPromoteRequest; output: EvalsIncidentPromoteResponse }
	roundList: { input: EvalsRoundListRequest; output: EvalsRoundListResponse }
	roundReplay: { input: EvalsRoundReplayRequest; output: EvalsRoundReplayResponse }
	diagnoseStart: { input: EvalsDiagnoseStartRequest; output: EvalsDiagnoseStartResponse }
}

export const evalsWorkbenchRouter = defineRouter<EvalsWorkbenchRoutes>("evalsWorkbench", [
	"incidentList",
	"incidentGet",
	"incidentUpdate",
	"incidentReadFile",
	"replayStart",
	"replayCancel",
	"incidentAnalyze",
	"incidentPromote",
	"roundList",
	"roundReplay",
	"diagnoseStart",
]);
