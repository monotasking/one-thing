/**
 * evalsWorkbench(事故工作台)域的渲染侧客户端 —— 结构债 P4c 第十批。
 *
 * 与 `evals-client.ts` 同一颗能力位(`evals`):两域在渲染侧是两个 store,
 * 但对「这台机器能不能跑评估」这件事只有一个答案。关着时下面十一条**根本不发
 * 请求**,就地返回与迁移前 `platform/web.ts` 那批硬桩逐字相同的答案。
 *
 * **两条推送不在这里**(`EVALS_REPLAY_PROGRESS` / `EVALS_DIAGNOSE_PROGRESS`)——
 * router 没有推送面,它们仍是 `platformApi` 上的订阅。
 */
import { evalsWorkbenchRouter } from '@shared/ipc/evals-workbench.js'
import type {
  EvalsReplayCancelRequest,
  EvalsReplayCancelResponse,
} from '@shared/ipc/evals-workbench.js'
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
} from '@shared/ipc/evals.js'
import { EVALS_UNSUPPORTED, evalsEnabled } from './evals-client'
import { clientApi } from './client'

const workbench = clientApi(evalsWorkbenchRouter)

function unsupported<T>(): Promise<T> {
  return Promise.resolve({ success: false, error: EVALS_UNSUPPORTED } as unknown as T)
}

export const evalsWorkbenchApi = {
  incidentList: (): Promise<EvalsIncidentListResponse> =>
    evalsEnabled() ? workbench.incidentList({}) : unsupported(),
  incidentGet: (request: EvalsIncidentGetRequest): Promise<EvalsIncidentGetResponse> =>
    evalsEnabled() ? workbench.incidentGet(request) : unsupported(),
  incidentUpdate: (
    request: EvalsIncidentUpdateRequest,
  ): Promise<EvalsIncidentUpdateResponse> =>
    evalsEnabled() ? workbench.incidentUpdate(request) : unsupported(),
  incidentReadFile: (
    request: EvalsIncidentReadFileRequest,
  ): Promise<EvalsIncidentReadFileResponse> =>
    evalsEnabled() ? workbench.incidentReadFile(request) : unsupported(),
  replayStart: (request: EvalsReplayStartRequest): Promise<EvalsReplayStartResponse> =>
    evalsEnabled() ? workbench.replayStart(request) : unsupported(),
  replayCancel: (request: EvalsReplayCancelRequest): Promise<EvalsReplayCancelResponse> =>
    evalsEnabled() ? workbench.replayCancel(request) : unsupported(),
  incidentAnalyze: (
    request: EvalsIncidentAnalyzeRequest,
  ): Promise<EvalsIncidentAnalyzeResponse> =>
    evalsEnabled() ? workbench.incidentAnalyze(request) : unsupported(),
  incidentPromote: (
    request: EvalsIncidentPromoteRequest,
  ): Promise<EvalsIncidentPromoteResponse> =>
    evalsEnabled() ? workbench.incidentPromote(request) : unsupported(),
  roundList: (request: EvalsRoundListRequest): Promise<EvalsRoundListResponse> =>
    evalsEnabled() ? workbench.roundList(request) : unsupported(),
  roundReplay: (request: EvalsRoundReplayRequest): Promise<EvalsRoundReplayResponse> =>
    evalsEnabled() ? workbench.roundReplay(request) : unsupported(),
  diagnoseStart: (
    request: EvalsDiagnoseStartRequest,
  ): Promise<EvalsDiagnoseStartResponse> =>
    evalsEnabled() ? workbench.diagnoseStart(request) : unsupported(),
}
