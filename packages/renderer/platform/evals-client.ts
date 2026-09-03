/**
 * evals(提示词评估)域的渲染侧客户端 —— 结构债 P4c 第十批。
 *
 * 形状照 `music-client.ts` / `themes-client.ts` 的判例:壳外一个模块 + 通用
 * `platformApi.rpcInvoke`,四壳零改动。**三条推送不在这里** ——
 * `EVALS_RUN_PROGRESS` / `EVALS_REPLAY_PROGRESS` / `EVALS_DIAGNOSE_PROGRESS`
 * 仍是 `platformApi` 上的三条订阅(router 没有推送面)。
 *
 * ## 能力位 `evals`(#15 续做口径,默认关)
 *
 * 评估面读写的是**宿主机器上**的 evals 仓与 `~/.onething/evals`,而且跑批会拿
 * 用户配置的 API key 直接打 provider。浏览器点一下只会让服务器那台机器动 ——
 * 迁到通用通道之后这条路技术上通了,按「续做口径」必须由一颗能力位挡着。
 * `platformApi.capabilities.evals` 在 electron 上为 `true`、web 上为 `false`;
 * 为 false 时下面十四条**根本不发请求**,而是就地返回与迁移前 `platform/web.ts`
 * 那批硬桩**逐字相同**的答案(`{ success: false, error: 'Evals is not supported
 * in the web build' }`)。调用点(`stores/evals.ts` / `MessageActions.vue`)
 * 因此一行判断都不用加,可感知结果与今天逐字一致。
 *
 * **放开 = 一行**:`platform/web.ts` 的 `evals: false` 改成 `true`
 * (域在 server 上已经挂着,`POST /api/rpc` 直接可达;但四条按 wire 路径读盘的
 * 方法在 http 上仍会被域自己拒绝 —— 见 `backend/rpc/domains/evals.ts` 文件头)。
 */
import { evalsRouter } from '@shared/ipc/evals.js'
import type {
  EvalsGenerateTriageRequest,
  EvalsGenerateTriageResponse,
  EvalsGetCaseRequest,
  EvalsGetCaseResponse,
  EvalsListCasesResponse,
  EvalsListFixturesResponse,
  EvalsListRecordsRequest,
  EvalsListRecordsResponse,
  EvalsListResultsResponse,
  EvalsPromoteFixtureRequest,
  EvalsPromoteFixtureResponse,
  EvalsReadFixtureRequest,
  EvalsReadFixtureResponse,
  EvalsReadRunDetailRequest,
  EvalsReadRunDetailResponse,
  EvalsReadSnapshotRequest,
  EvalsReadSnapshotResponse,
  EvalsRecordDownvoteRequest,
  EvalsRecordDownvoteResponse,
  EvalsRetireCaseRequest,
  EvalsRetireCaseResponse,
  EvalsRunCancelResponse,
  EvalsRunStartRequest,
  EvalsRunStartResponse,
} from '@shared/ipc/evals.js'
import { platformApi } from './index'
import { clientApi } from './client'

const evals = clientApi(evalsRouter)

/** 与迁移前 `platform/web.ts` 那批硬桩逐字相同的那句话。 */
export const EVALS_UNSUPPORTED = 'Evals is not supported in the web build'

export function evalsEnabled(): boolean {
  return platformApi.capabilities.evals !== false
}

function unsupported<T>(): Promise<T> {
  return Promise.resolve({ success: false, error: EVALS_UNSUPPORTED } as unknown as T)
}

export const evalsApi = {
  recordDownvote: (
    request: EvalsRecordDownvoteRequest,
  ): Promise<EvalsRecordDownvoteResponse> =>
    evalsEnabled() ? evals.recordDownvote(request) : unsupported(),
  listRecords: (request: EvalsListRecordsRequest): Promise<EvalsListRecordsResponse> =>
    evalsEnabled() ? evals.listRecords(request) : unsupported(),
  listFixtures: (): Promise<EvalsListFixturesResponse> =>
    evalsEnabled() ? evals.listFixtures({}) : unsupported(),
  readSnapshot: (request: EvalsReadSnapshotRequest): Promise<EvalsReadSnapshotResponse> =>
    evalsEnabled() ? evals.readSnapshot(request) : unsupported(),
  readFixture: (request: EvalsReadFixtureRequest): Promise<EvalsReadFixtureResponse> =>
    evalsEnabled() ? evals.readFixture(request) : unsupported(),
  listResults: (): Promise<EvalsListResultsResponse> =>
    evalsEnabled() ? evals.listResults({}) : unsupported(),
  listCases: (): Promise<EvalsListCasesResponse> =>
    evalsEnabled() ? evals.listCases({}) : unsupported(),
  getCase: (request: EvalsGetCaseRequest): Promise<EvalsGetCaseResponse> =>
    evalsEnabled() ? evals.getCase(request) : unsupported(),
  runStart: (request: EvalsRunStartRequest): Promise<EvalsRunStartResponse> =>
    evalsEnabled() ? evals.runStart(request) : unsupported(),
  runCancel: (): Promise<EvalsRunCancelResponse> =>
    evalsEnabled() ? evals.runCancel({}) : unsupported(),
  promoteFixture: (
    request: EvalsPromoteFixtureRequest,
  ): Promise<EvalsPromoteFixtureResponse> =>
    evalsEnabled() ? evals.promoteFixture(request) : unsupported(),
  retireCase: (request: EvalsRetireCaseRequest): Promise<EvalsRetireCaseResponse> =>
    evalsEnabled() ? evals.retireCase(request) : unsupported(),
  generateTriage: (
    request?: EvalsGenerateTriageRequest,
  ): Promise<EvalsGenerateTriageResponse> =>
    evalsEnabled() ? evals.generateTriage(request ?? {}) : unsupported(),
  readRunDetail: (
    request: EvalsReadRunDetailRequest,
  ): Promise<EvalsReadRunDetailResponse> =>
    evalsEnabled() ? evals.readRunDetail(request) : unsupported(),
}
