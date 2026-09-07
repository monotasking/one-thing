/**
 * evalsWorkbench(事故工作台)域 —— 结构债 P4c 第十批,十一条数据面整只从手写
 * IPC 通道搬到通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉两处镜像:`apps/electron/src/main/ipc/evals-workbench.ts` 里那十一条裸
 * `ipcMain.handle`(那个文件**整只删掉**),以及 `preload/bridge.ts` /
 * `platform/web.ts` 各自的十一条包装与硬桩。server 侧本来就一条路由都没有,
 * 所以 `server/*` 零改动。
 *
 * ## 搬家时消掉的两处 electron 触点
 *
 *  - **`sendToAll`**(`BrowserWindow.getAllWindows()`):两条进度推送
 *    (`EVALS_REPLAY_PROGRESS` / `EVALS_DIAGNOSE_PROGRESS`)改走
 *    `wiring/evals/events.ts` 的注入端口。桌面注入的仍是「所有活着的窗口」,
 *    渲染层收到的 payload 一字未变。
 *  - **跨文件 `import("./evals.js")` 拿 `getRepoDirForEvals()`**:`incidentPromote`
 *    现在直接问 `wiring/evals/host-ports.ts` 的 `resolveEvalsRepoDir()` ——
 *    判定只有一份,不再由两个 IPC 文件互相 import。
 *
 * `activeOps`(每事故单飞:回放与诊断共用一张表)随搬,语义逐字不变。
 *
 * ## http 分叉
 *
 * 本域**不需要**像 evals 域那样逐条拒绝:十一条里没有一条把 wire 上的绝对路径
 * 交给 `fs` —— `incidentReadFile` 是相对路径且迁移前就有 containment guard
 * (解析后必须落在事故包目录里),其余全部按 `incidentId` 在事故目录内寻址。
 * 渲染侧仍由能力位 `evals`(web 默认关)挡着,与 evals 域同一个口径。
 */
import fs from 'node:fs'
import { canAccessEvalSource, requireIncidentAccess, requireEvalRepositoryAccess } from './evals-access.js'
import path from 'node:path'
import type { EvalsWorkbenchRoutes } from '@shared/ipc/evals-workbench.js'
import type {
  EvalsDiagnoseProgressEvent,
  EvalsIncidentMetaDTO,
  EvalsIncidentRunSummary,
  EvalsReplayProgressEvent,
  EvalsReplayStartRequest,
  EvalsRoundView,
} from '@shared/ipc/evals.js'
import * as store from '../../store.js'
import {
  broadcastEvalsDiagnoseProgress,
  broadcastEvalsReplayProgress,
} from '../../wiring/evals/events.js'
import { resolveEvalsRepoDir } from '../../wiring/evals/host-ports.js'
import {
  createEvalsModelCaller,
  resolveEvalsCredentials,
} from '../../wiring/evals/provider-adapter.js'
import { getLogger } from '../../wiring/logging/index.js'
import type { RpcRouteHandlers } from '../registry.js'
import { getEvalsTaskOwner } from '../../wiring/evals/task-owner.js'

const log = getLogger('rpc.evals-workbench')

const READ_FILE_MAX_BYTES = 4 * 1024 * 1024

const incidentTaskKey = (id: string) => `incident:${id}`

function getAnalysisModelConfig(): { providerId: string; model: string } {
  const settings = store.getSettings()
  const configured = (
    settings as { evals?: { analysisModel?: { providerId: string; model: string } } }
  )?.evals?.analysisModel
  return configured ?? { providerId: 'deepseek', model: 'deepseek-v4-pro' }
}

/**
 * Resolve the analysis model caller (judge/summary/simulation). Falls back
 * to the replay provider when the configured analysis provider has no
 * credentials.
 */
async function resolveAnalysis(fallbackProviderId?: string, fallbackModel?: string, signal?: AbortSignal) {
  let { providerId, model } = getAnalysisModelConfig()
  if (!resolveEvalsCredentials(providerId).ok && fallbackProviderId) {
    providerId = fallbackProviderId
    model = fallbackModel ?? model
  }
  if (!resolveEvalsCredentials(providerId).ok) return null
  return { callModel: createEvalsModelCaller(providerId, model, { signal }), model }
}

function listRunSummaries(incidentDir: string): EvalsIncidentRunSummary[] {
  const runsDir = path.join(incidentDir, 'runs')
  if (!fs.existsSync(runsDir)) return []
  const summaries: EvalsIncidentRunSummary[] = []
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const runDir = path.join(runsDir, entry.name)
    let runJson: Record<string, unknown> = {}
    try {
      runJson = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json'), 'utf-8'))
    } catch {
      // run may be in progress or legacy
    }
    const attemptFiles = fs
      .readdirSync(runDir)
      .filter(f => f.endsWith('.jsonl'))
      .sort()
    summaries.push({
      runId: entry.name,
      startedAt: String(runJson.startedAt ?? ''),
      kind: (runJson.kind as 'replay' | 'diagnosis') ?? 'replay',
      attempts: Number(runJson.attempts ?? attemptFiles.length),
      passes: Number(runJson.passes ?? 0),
      disabledSections: runJson.disabledSections as string[] | undefined,
      attemptFiles,
    })
  }
  summaries.sort((a, b) => (a.runId < b.runId ? 1 : -1))
  return summaries
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Traced AgentMessage content can be a string or content parts
function extractResponseText(message: unknown): string {
  const m = message as { content?: unknown }
  if (typeof m?.content === 'string') return m.content
  if (Array.isArray(m?.content)) {
    return (m.content as Array<{ type?: string; text?: string }>)
      .filter(p => p?.type === 'text' && typeof p.text === 'string')
      .map(p => p.text)
      .join('\n')
  }
  return ''
}

function extractResponseToolCalls(
  message: unknown,
): Array<{ name: string; args: unknown }> {
  const m = message as {
    toolCalls?: Array<{ name?: string; arguments?: unknown }>
  }
  return (m?.toolCalls ?? []).map(tc => ({
    name: tc.name ?? 'unknown',
    args: tc.arguments,
  }))
}

// ── Background replay executor ─────────────────────────

async function runReplayInBackground(options: {
  runtime: typeof import('@onething/runtime')
  incident: { id: string; promptVersion?: string }
  scene: import('@onething/runtime').ReplayScene
  request: EvalsReplayStartRequest
  runId: string
  callModel: ReturnType<typeof createEvalsModelCaller>
  analysis: { callModel: ReturnType<typeof createEvalsModelCaller>; model: string } | null
  rubric?: string
  simulateTool?: import('@onething/runtime').ToolSimulator
  signal: AbortSignal
}): Promise<void> {
  const { runtime, incident, scene, request, runId } = options
  const push = (payload: EvalsReplayProgressEvent) => broadcastEvalsReplayProgress(payload)

  const runDir = path.join(runtime.getIncidentDir(incident.id), 'runs', runId)
  fs.mkdirSync(runDir, { recursive: true })

  const attempts = Math.min(request.runs ?? 1, 10)
  let passes = 0

  try {
    for (let i = 1; i <= attempts; i++) {
      if (options.signal.aborted) break
      push({ incidentId: incident.id, runId, type: 'attempt-start', attempt: i })

      const result = await runtime.runReplay({
        scene,
        callModel: options.callModel,
        useCapturedPrompt: request.useCapturedPrompt,
        disabledSections: request.disabledSections,
        simulateTool: options.simulateTool,
        rubric: request.judge !== false ? options.rubric : undefined,
        judgeModel:
          request.judge !== false && options.analysis ? options.analysis : undefined,
        header: {
          runId,
          attempt: i,
          incidentId: incident.id,
          promptVersion: incident.promptVersion,
          disabledSections: request.disabledSections,
          model: request.model || scene.params.model || 'unknown',
          provider: request.providerId || scene.params.provider,
        },
        onEvent: event =>
          push({
            incidentId: incident.id,
            runId,
            type: 'transcript-event',
            attempt: i,
            event: event as unknown as Record<string, unknown>,
          }),
        signal: options.signal,
      })

      runtime.writeTranscript(
        path.join(runDir, `attempt-${i}.jsonl`),
        result.transcript.header,
        result.transcript.events,
      )
      if (result.verdict?.pass) passes++
      push({
        incidentId: incident.id,
        runId,
        type: 'attempt-done',
        attempt: i,
        pass: result.verdict?.pass ?? null,
        reason: result.verdict?.reason,
      })
    }

    fs.writeFileSync(
      path.join(runDir, 'run.json'),
      JSON.stringify(
        {
          runId,
          kind: 'replay',
          startedAt: new Date().toISOString(),
          attempts,
          passes,
          disabledSections: request.disabledSections,
          judged: request.judge !== false && !!options.rubric,
          aborted: options.signal.aborted || undefined,
        },
        null,
        2,
      ),
      'utf-8',
    )
    push({ incidentId: incident.id, runId, type: 'run-done', passes, attempts })
  } catch (error) {
    push({
      incidentId: incident.id,
      runId,
      type: 'error',
      error: errorMessage(error),
    })
  }
}

// ── Shared analysis routine ────────────────────────────

/** Fire-and-forget analysis for the 👎 flow (never throws). */
export async function analyzeIncidentInBackground(incidentId: string): Promise<void> {
  try {
    await getEvalsTaskOwner().start(incidentTaskKey(incidentId), async signal => {
      const runtime = await import('@onething/runtime')
      await analyzeIncidentById(runtime, incidentId, signal)
    })
  } catch (error) {
    log.error('background analysis failed', { incidentId }, error)
  }
}

async function analyzeIncidentById(
  runtime: typeof import('@onething/runtime'),
  incidentId: string,
  signal?: AbortSignal,
): Promise<
  | { ok: true; incident: import('@onething/runtime').IncidentMeta }
  | { ok: false; error: string }
> {
  const incident = runtime.readIncident(incidentId)
  if (!incident) return { ok: false, error: 'Incident not found' }
  const analysis = await resolveAnalysis(incident.provider, incident.model, signal)
  if (!analysis) {
    return { ok: false, error: 'No analysis model available' }
  }
  const trace = runtime.readIncidentTurnTrace(incidentId)
  const sectionNames = Object.keys(incident.sectionHashes ?? {})
  const result = await runtime.analyzeIncident({
    incident,
    turnTrace: trace,
    sectionNames,
    analysis,
    signal,
  })
  if (!result) return { ok: false, error: 'Analysis produced no result' }

  const updated = runtime.updateIncident(incidentId, {
    title: result.title,
    category: result.category,
    rubric: result.rubric || incident.note,
    status: incident.status === 'new' ? 'analyzed' : incident.status,
  })
  if (!updated) return { ok: false, error: 'Failed to persist analysis' }
  // Rewrite the human cover with the AI summary
  try {
    fs.writeFileSync(
      path.join(runtime.getIncidentDir(incidentId), 'incident.md'),
      runtime.renderAnalyzedMarkdown(updated, result),
      'utf-8',
    )
  } catch {
    // non-fatal
  }
  return { ok: true, incident: updated }
}

// ── Handlers ───────────────────────────────────────────

export const evalsWorkbenchRpcHandlers: RpcRouteHandlers<EvalsWorkbenchRoutes> = {
  async incidentList(_request, context = { transport: 'ipc' }) {
    try {
      const { listIncidents } = await import('@onething/runtime')
      return {
        success: true,
        incidents: listIncidents({ limit: 200 }).filter(incident => canAccessEvalSource(context, incident.sessionId)) as unknown as EvalsIncidentMetaDTO[],
      }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },

  async incidentGet(request, context = { transport: 'ipc' }) {
    await requireIncidentAccess(request.incidentId, context, 'read')
    try {
      const { readIncident, getIncidentDir } = await import('@onething/runtime')
      const incident = readIncident(request.incidentId)
      if (!incident) return { success: false, error: 'Incident not found' }
      const dir = getIncidentDir(request.incidentId)
      let markdown = ''
      try {
        markdown = fs.readFileSync(path.join(dir, 'incident.md'), 'utf-8')
      } catch {
        // cover may be missing
      }
      return {
        success: true,
        incident: incident as unknown as EvalsIncidentMetaDTO,
        markdown,
        runs: listRunSummaries(dir),
      }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },

  async incidentUpdate(request, context = { transport: 'ipc' }) {
    await requireIncidentAccess(request.incidentId, context, 'write')
    try {
      const { updateIncident } = await import('@onething/runtime')
      const incident = updateIncident(request.incidentId, request.patch as never)
      if (!incident) return { success: false, error: 'Incident not found' }
      return {
        success: true,
        incident: incident as unknown as EvalsIncidentMetaDTO,
      }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },

  async incidentReadFile(request, context = { transport: 'ipc' }) {
    await requireIncidentAccess(request.incidentId, context, 'read')
    try {
      const { getIncidentDir } = await import('@onething/runtime')
      const dir = getIncidentDir(request.incidentId)
      const resolved = path.resolve(dir, request.relativePath)
      // Path containment guard
      if (!resolved.startsWith(path.resolve(dir) + path.sep)) {
        return { success: false, error: 'Path escapes incident bundle' }
      }
      if (!fs.existsSync(resolved)) {
        return { success: false, error: 'File not found' }
      }
      const stat = fs.statSync(resolved)
      if (stat.size > READ_FILE_MAX_BYTES) {
        return { success: false, error: 'File too large to display' }
      }
      return { success: true, content: fs.readFileSync(resolved, 'utf-8') }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },

  async replayStart(request, context = { transport: 'ipc' }) {
    await requireIncidentAccess(request.incidentId, context, 'write')
    try {
      const tasks = getEvalsTaskOwner()
      if (tasks.has(incidentTaskKey(request.incidentId))) {
        return {
          success: false,
          error: 'An operation is already running for this incident',
        }
      }
      const runtime = await import('@onething/runtime')
      const incident = runtime.readIncident(request.incidentId)
      if (!incident) return { success: false, error: 'Incident not found' }
      const scene = runtime.loadSceneFromIncident(request.incidentId)
      if (!scene) {
        return { success: false, error: 'Incident has no replayable scene' }
      }

      const providerId = request.providerId || scene.params.provider || 'deepseek'
      const model = request.model || scene.params.model || 'deepseek-v4-pro'
      const credentials = resolveEvalsCredentials(providerId)
      if (!credentials.ok) {
        return { success: false, error: credentials.reason }
      }
      const runId = `replay-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
      void tasks.start(incidentTaskKey(request.incidentId), async signal => {
        const callModel = createEvalsModelCaller(providerId, model, { signal })
        const analysis = await resolveAnalysis(providerId, model, signal)
        const rubric = incident.rubric || incident.note
        const simulateTool = analysis ? runtime.createAiToolSimulator(analysis) : undefined
        await runReplayInBackground({ runtime, incident, scene, request, runId, callModel, analysis, rubric, simulateTool, signal })
      }).catch(error => {
        broadcastEvalsReplayProgress({ incidentId: incident.id, runId, type: 'error', error: errorMessage(error) })
      })

      return { success: true, runId }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },

  async replayCancel(request, context = { transport: 'ipc' }) {
    await requireIncidentAccess(request.incidentId, context, 'abort')
    if (!getEvalsTaskOwner().cancel(incidentTaskKey(request.incidentId))) return { success: false, error: 'No operation in progress' }
    return { success: true }
  },

  async incidentAnalyze(request, context = { transport: 'ipc' }) {
    await requireIncidentAccess(request.incidentId, context, 'write')
    try {
      const runtime = await import('@onething/runtime')
      const updated = await getEvalsTaskOwner().start(incidentTaskKey(request.incidentId), signal => analyzeIncidentById(runtime, request.incidentId, signal))
      if (!updated.ok) return { success: false, error: updated.error }
      return {
        success: true,
        incident: updated.incident as unknown as EvalsIncidentMetaDTO,
      }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },

  async incidentPromote(request, context = { transport: 'ipc' }) {
    await requireIncidentAccess(request.incidentId, context, 'write')
    requireEvalRepositoryAccess(context)
    try {
      const runtime = await import('@onething/runtime')
      const repoDir = resolveEvalsRepoDir()
      if (!repoDir) {
        return { success: false, error: 'Evals repo not configured' }
      }
      const incident = runtime.readIncident(request.incidentId)
      if (!incident) return { success: false, error: 'Incident not found' }

      const caseId = request.caseId.replace(/[^a-zA-Z0-9_-]/g, '-')
      const caseDir = path.join(repoDir, 'evals', 'cases', caseId)
      fs.mkdirSync(caseDir, { recursive: true })

      // Self-contained: copy the whole scene into the repo case bundle
      const sceneSrc = path.join(runtime.getIncidentDir(request.incidentId), 'scene')
      const sceneDst = path.join(caseDir, 'scene')
      fs.cpSync(sceneSrc, sceneDst, { recursive: true })

      const rubric = incident.rubric || incident.note || ''
      const yaml = [
        `# Promoted from incident ${incident.id}`,
        `id: ${caseId}`,
        `description: >`,
        `  ${(request.description || incident.title).replace(/\n/g, '\n  ')}`,
        `incidentRef: ${incident.id}`,
        `scene: scene`,
        ...(rubric ? [`rubric: >`, `  ${rubric.replace(/\n/g, '\n  ')}`] : []),
        `userMessage: >`,
        `  ${incident.userMessage.replace(/\n/g, '\n  ')}`,
        `expect:`,
        `  # judged by rubric via replay engine`,
        '',
      ].join('\n')
      const casePath = path.join(caseDir, 'case.yaml')
      fs.writeFileSync(casePath, yaml, 'utf-8')

      runtime.updateIncident(request.incidentId, {
        status: 'case-created',
        caseId,
      })

      return { success: true, casePath }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },

  async roundList(request, context = { transport: 'ipc' }) {
    await requireIncidentAccess(request.incidentId, context, 'read')
    try {
      const runtime = await import('@onething/runtime')
      const incident = runtime.readIncident(request.incidentId)
      if (!incident) return { success: false, error: 'Incident not found' }

      // Bundle copy first (survives ring rollover), live trace second.
      const bundleRoundsDir = path.join(
        runtime.getIncidentDir(request.incidentId),
        'scene',
        'rounds',
      )
      const rounds = fs.existsSync(bundleRoundsDir)
        ? runtime.readTraceRoundsFromDir(bundleRoundsDir)
        : runtime.readTraceRounds(incident.sessionId, incident.turnId)

      const views: EvalsRoundView[] = rounds.map(r => ({
        round: r.round,
        ts: r.ts,
        purpose: r.purpose,
        requestMessages: r.request.messages,
        model: r.request.model,
        temperature: r.request.temperature,
        toolNames: (r.request.tools ?? []).map(t => t.name),
        responseContent: extractResponseText(r.response.message),
        responseToolCalls: extractResponseToolCalls(r.response.message),
        finishReason: r.response.finishReason,
        incomplete: r.incomplete,
      }))
      return { success: true, rounds: views }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },

  async roundReplay(request, context = { transport: 'ipc' }) {
    await requireIncidentAccess(request.incidentId, context, 'write')
    try {
      const runtime = await import('@onething/runtime')
      const incident = runtime.readIncident(request.incidentId)
      if (!incident) return { success: false, error: 'Incident not found' }

      const bundleRoundsDir = path.join(
        runtime.getIncidentDir(request.incidentId),
        'scene',
        'rounds',
      )
      const rounds = fs.existsSync(bundleRoundsDir)
        ? runtime.readTraceRoundsFromDir(bundleRoundsDir)
        : runtime.readTraceRounds(incident.sessionId, incident.turnId)
      const roundData = rounds.find(r => r.round === request.round)
      if (!roundData) {
        return { success: false, error: `Round ${request.round} not traced` }
      }

      const providerId = request.providerId || incident.provider
      const credentials = resolveEvalsCredentials(providerId)
      if (!credentials.ok) {
        return { success: false, error: credentials.reason }
      }
      const result = await getEvalsTaskOwner().start(incidentTaskKey(request.incidentId), signal => runtime.replayRound({
        roundData,
        callModel: createEvalsModelCaller(providerId, request.model || roundData.request.model, { signal }),
        runs: request.runs,
        editedMessages: request.editedMessages,
      }))
      return {
        success: true,
        attempts: result.attempts,
        edited: result.edited,
      }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },

  async diagnoseStart(request, context = { transport: 'ipc' }) {
    await requireIncidentAccess(request.incidentId, context, 'write')
    try {
      const tasks = getEvalsTaskOwner()
      if (tasks.has(incidentTaskKey(request.incidentId))) {
        return {
          success: false,
          error: 'An operation is already running for this incident',
        }
      }
      const runtime = await import('@onething/runtime')
      const incident = runtime.readIncident(request.incidentId)
      if (!incident) return { success: false, error: 'Incident not found' }
      const scene = runtime.loadSceneFromIncident(request.incidentId)
      if (!scene) {
        return { success: false, error: 'Incident has no replayable scene' }
      }

      const providerId = scene.params.provider || 'deepseek'
      const model = scene.params.model || 'deepseek-v4-pro'
      const credentials = resolveEvalsCredentials(providerId)
      if (!credentials.ok) {
        return { success: false, error: credentials.reason }
      }
      if (!await resolveAnalysis(providerId, model)) {
        return {
          success: false,
          error: 'No analysis model available for judging',
        }
      }

      void tasks.start(incidentTaskKey(request.incidentId), async signal => {
        const push = (payload: EvalsDiagnoseProgressEvent) =>
          broadcastEvalsDiagnoseProgress(payload)
        try {
          const analysis = await resolveAnalysis(providerId, model, signal)
          if (!analysis) throw new Error('No analysis model available for judging')
          // Rubric is required for judging — auto-run analysis first
          if (!incident.rubric && !incident.note) {
            push({ incidentId: request.incidentId, type: 'step', step: 'analyze' })
            await analyzeIncidentById(runtime, request.incidentId, signal)
          }
          const result = await runtime.diagnoseIncident({
            incidentId: request.incidentId,
            callModel: createEvalsModelCaller(providerId, model, { signal }),
            analysis,
            simulateTool: runtime.createAiToolSimulator(analysis),
            quick: request.quick,
            signal,
            onProgress: p =>
              push({
                incidentId: request.incidentId,
                type: p.type,
                step: p.step,
                section: p.section,
                failRate: p.failRate,
                conclusion: p.conclusion,
                error: p.error,
              }),
          })
          push({
            incidentId: request.incidentId,
            type: 'done',
            conclusion: result.conclusion,
            report: fs.readFileSync(result.reportPath, 'utf-8'),
          })
        } catch (error) {
          push({
            incidentId: request.incidentId,
            type: 'error',
            error: errorMessage(error),
          })
        }
      }).catch(error => {
        broadcastEvalsDiagnoseProgress({ incidentId: request.incidentId, type: 'error', error: errorMessage(error) })
      })

      return { success: true }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  },
}
