/**
 * evals(提示词评估)域 —— 结构债 P4c 第十批,十四条数据面整只从手写 IPC 通道
 * 搬到通用 `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉两处镜像:
 *  - `apps/electron/src/main/ipc/evals.ts` 里那十四条裸 `ipcMain.handle`
 *    (这一域从来没有「手写 IPC 工厂 + 壳适配」两层)—— 那个文件搬完只剩
 *    **三条推送的广播注入**;
 *  - `preload/bridge.ts` 的十三条包装(`readSnapshot` 从前连包装都没有)与
 *    `platform/web.ts` 的十三条 `Evals is not supported in the web build` 硬桩。
 *
 * server 侧本来就**一条路由都没有**(web 是硬桩),所以 `server/http.ts` 与
 * `server/runtime.ts` 零改动 —— 域挂上 router 就经 `POST /api/rpc` 自动可达。
 *
 * ## 两个 electron 触点各自的去处
 *
 *  - **`app.isPackaged`**(旧 `getRepoDir()`,传染九条):判定本身搬进
 *    `wiring/evals/host-ports.ts` 的 `resolveEvalsRepoDir()`,宿主只注入
 *    `isPackaged` 这一位事实。未注入 = 视为非打包 = `process.cwd()`,与迁移前
 *    `!app.isPackaged` 那条分支逐字同义。
 *  - **`BrowserWindow.fromWebContents(event.sender)`**(旧 `runStart` 里只为给
 *    后台跑批一个推进度的靶子):没有了。进度改走
 *    `wiring/evals/events.ts` 的注入端口全窗广播 —— **这是本批唯一一处行为
 *    变化**(单窗 → 全窗),事件体一字未变;桌面只有一扇设置窗承载评估页,
 *    而渲染侧的订阅只在 `startRun` 时才建立,所以可感知结果不变。
 *
 * ## http 分叉:按 wire 上的绝对路径读盘的四条,在 http 上夹进 evals 面自己那两棵树
 *
 * `readSnapshot` / `readFixture` / `promoteFixture` / `readRunDetail` 会把请求
 * 里带来的路径直接交给 `fs`。桌面上这是对的(用户就是本机那个人,形状与迁移前
 * 逐字相同);挂上通用通道之后 server 上同一条会变成「读服务器上任意文件」。
 *
 * P4 终态批 B(拍板 #15)放开了渲染侧能力位 `evals`,所以这四条不能再一律拒 ——
 * 拒了等于位开着面死着。改成**夹紧**:`transport === 'http'` 时路径必须落在 evals
 * 面自己的两棵树里(`<repoDir>/evals` 与 `~/.onething/evals/fixtures/auto`),
 * 越界回一句结构化失败,不抛、不读盘。
 *
 * **为什么不是 `resolveRpcSandbox` 的 sandboxRoot**:那是 `<workspaceRoot>/<uid>/<wid>`
 * 的 per-owner 工作区(默认在 tmpdir 下),而 evals 仓是宿主机器上的**代码仓**
 * (`resolveEvalsRepoDir()`:设置 → 非打包 cwd),两者从不相交 —— 夹进 sandboxRoot
 * 会让四条全灭,与「一律拒」没有区别。所以 `resolveRpcSandbox` 在这里只用它那条
 * **fail-closed 不变量**(联网宿主没接沙箱根 = 宿主接线漏了,抛),真正的边界是
 * evals 面自己的根。两条都过才放行。
 */
import fs from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  ContextSnapshotMessage,
  EvalCaseMeta,
  EvalFixtureMeta,
  EvalRunResultEntry,
  EvalsRoutes,
  EvalsRunProgressEvent,
  EvalsRunStartRequest,
  TurnEvalRecordView,
} from '@shared/ipc/evals.js'
import type { RpcDispatchContext } from '@shared/ipc/rpc.js'
import { sessionReads } from '../../session/reads.js'
import * as store from '../../store.js'
import { createIncidentForTurn } from '../../wiring/evals/incident.js'
import { broadcastEvalsRunProgress } from '../../wiring/evals/events.js'
import { resolveEvalsRepoDir } from '../../wiring/evals/host-ports.js'
import {
  createEvalsModelCaller,
  resolveEvalsCredentials,
} from '../../wiring/evals/provider-adapter.js'
import { getLogger } from '../../wiring/logging/index.js'
import { getSkillsForSession } from '../../wiring/skills/session-skills.js'
import { analyzeIncidentInBackground } from './evals-workbench.js'
import { isPathInside, resolveRpcSandbox } from '../sandbox.js'
import type { RpcRouteHandlers } from '../registry.js'

const log = getLogger('rpc.evals')

/** 夹不住时的答案。写给用户看,不泄露宿主上任何一段真实路径。 */
const EVALS_PATH_OUTSIDE = 'Path is outside the evals workspace'

/**
 * evals 面在宿主机器上的两棵树 —— http 上 wire 路径只能落在它们里面。
 *
 * 每次现取而不是常量:`resolveEvalsRepoDir()` 读的是设置,用户改了评估仓的位置
 * 之后不该还要重启才认。仓没配 = 只剩自动夹具那棵树(不是「全放开」)。
 */
function evalsWireRoots(): string[] {
  const roots = [path.resolve(getEvalsFixturesAutoDir())]
  const repoDir = resolveEvalsRepoDir()
  if (repoDir) roots.push(path.resolve(repoDir, 'evals'))
  return roots
}

type EvalsWirePath = { ok: true; path: string } | { ok: false; error: string }

/**
 * 请求里带来的路径 → 这次真的可以交给 `fs` 的路径(见文件头「http 分叉」)。
 *
 * `ipc`:原样(桌面语义就是「用户说哪就是哪」,与迁移前逐字相同)。
 * `http`:先过 `resolveRpcSandbox` 的 fail-closed 闸(没接沙箱根就抛,那是宿主
 * 接线 bug,不是用户输入错误),再要求解析后的绝对路径落在 evals 面的根里。
 * 比较一律在 `path.resolve()` 之后做,`..` 在比较前就已经塌掉了。
 */
function clampEvalsWirePath(
  rawPath: unknown,
  context: RpcDispatchContext | undefined,
): EvalsWirePath {
  const value = typeof rawPath === 'string' ? rawPath.trim() : ''
  if (!value) return { ok: false, error: 'Path required' }
  if (context?.transport !== 'http') return { ok: true, path: value }
  resolveRpcSandbox(context)
  const candidate = path.resolve(value)
  const inside = evalsWireRoots().some(root => isPathInside(candidate, root))
  return inside ? { ok: true, path: candidate } : { ok: false, error: EVALS_PATH_OUTSIDE }
}

// ── Helpers(逐字搬自 @main/ipc/evals.ts)────────────────

function getEvalsFixturesAutoDir(): string {
  return path.join(homedir(), '.onething', 'evals', 'fixtures', 'auto')
}

function getEvalsFixturesDir(repoDir: string): string {
  return path.join(repoDir, 'evals', 'fixtures')
}

function getEvalsCasesDir(repoDir: string): string {
  return path.join(repoDir, 'evals', 'cases')
}

function getResultsPath(repoDir: string): string {
  return path.join(repoDir, 'evals', 'results.jsonl')
}

function getTriagePath(repoDir: string): string {
  return path.join(repoDir, 'evals', 'triage.md')
}

function readUserMessagePreview(fixtureRef: string | null): string {
  if (!fixtureRef) return ''
  try {
    const fixture = JSON.parse(fs.readFileSync(fixtureRef, 'utf-8'))
    return String(fixture.userMessage ?? '').slice(0, 120)
  } catch {
    return ''
  }
}

function scanFixturesDir(dir: string, out: EvalFixtureMeta[]): void {
  if (!fs.existsSync(dir)) return
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const filePath = path.join(dir, entry.name)
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const fixture = JSON.parse(content)
      out.push({
        path: filePath,
        capturedAt: fixture.capturedAt ?? '',
        provider: fixture.provider ?? 'unknown',
        model: fixture.model ?? 'unknown',
        sessionId: fixture.sessionRef?.sessionId ?? '',
        turnId: fixture.sessionRef?.turnId ?? '',
        userMessagePreview:
          (fixture.userMessage ?? '').slice(0, 120) || '(no user message)',
        hasNegative: true, // auto fixtures are only created for negative signals
      })
    } catch {
      // Skip unparseable files
    }
  }
}

/**
 * Case YAML parsing/generation lives in @onething/runtime (case-file.ts) —
 * a single implementation shared with the CLI runner, per design §7 (the
 * mini-YAML parser and generator must not drift between consumers).
 */
type ParseCaseYamlFn = (content: string) => {
  id: string
  description: string
  fixture: string
  userMessage: string
  expect: Record<string, unknown>
}

function scanCasesDir(
  dir: string,
  isSentinel: boolean,
  out: EvalCaseMeta[],
  parseCaseYaml: ParseCaseYamlFn,
): void {
  if (!fs.existsSync(dir)) return
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    // Flat legacy cases (<id>.yaml) and promoted bundle cases (<id>/case.yaml)
    let filePath: string | null = null
    let fileLabel = ''
    if (entry.isFile() && entry.name.endsWith('.yaml')) {
      filePath = path.join(dir, entry.name)
      fileLabel = entry.name
    } else if (entry.isDirectory() && entry.name !== 'sentinel') {
      const bundleCase = path.join(dir, entry.name, 'case.yaml')
      if (fs.existsSync(bundleCase)) {
        filePath = bundleCase
        fileLabel = `${entry.name}/case.yaml`
      }
    }
    if (!filePath) continue
    try {
      const parsed = parseCaseYaml(fs.readFileSync(filePath, 'utf-8'))
      out.push({
        id: parsed.id || fileLabel.replace(/\/?case\.yaml$|\.yaml$/, ''),
        file: fileLabel,
        dir,
        description: parsed.description || '',
        fixture: parsed.fixture || '',
        userMessage: parsed.userMessage || '',
        isSentinel,
        expect: parsed.expect || {},
      })
    } catch {
      // Skip unparseable files
    }
  }
}

async function loadAllCases(repoDir: string): Promise<EvalCaseMeta[]> {
  const { parseCaseYaml } = await import('@onething/runtime')
  const casesDir = getEvalsCasesDir(repoDir)
  const sentinelDir = path.join(casesDir, 'sentinel')
  const allCases: EvalCaseMeta[] = []
  scanCasesDir(casesDir, false, allCases, parseCaseYaml)
  scanCasesDir(sentinelDir, true, allCases, parseCaseYaml)
  return allCases
}

// ── Running state ──────────────────────────────────────
//
// 单跑闸,逐字沿用:一次只允许一个跑批在飞。`runCancel` 只发信号,清空由后台
// 跑批自己的 finally 做 —— 在这里清会让第二个跑批在第一个还在写结果时起飞。

let activeRunAbort: AbortController | null = null

/** 测试用:把单跑闸复位到「没有跑批在飞」。 */
export function resetEvalsRunStateForTests(): void {
  activeRunAbort = null
}

// ── Background Run (delegates to runner.ts) ─────────────

async function runEvalsInBackground(
  repoDir: string,
  request: EvalsRunStartRequest,
  abortController: AbortController,
): Promise<void> {
  const emitProgress = (event: EvalsRunProgressEvent) => {
    // Persist run detail on run-done (adapter responsibility, not runner)
    if (event.type === 'run-done' && event.detail?.cases) {
      try {
        const runsDir = path.join(repoDir, 'evals', 'runs')
        fs.mkdirSync(runsDir, { recursive: true })
        const ts = event.entry?.ts ?? new Date().toISOString()
        const filename = `${ts.replace(/[:.]/g, '-')}.json`
        const detailPath = path.join(runsDir, filename)
        fs.writeFileSync(
          detailPath,
          JSON.stringify(
            {
              version: 1,
              ts,
              provider: event.entry?.provider,
              model: event.entry?.model,
              runs: event.entry?.runs,
              cases: event.detail.cases,
            },
            null,
            2,
          ),
          'utf-8',
        )
      } catch (err) {
        log.error('persist run detail failed', undefined, err)
      }
    }

    // Strip detail before sending to renderer (too large for IPC)
    const { detail: _, ...cleanEvent } = event
    broadcastEvalsRunProgress(cleanEvent)
  }

  try {
    const { runEvals } = await import('@onething/runtime')

    const callModel = createEvalsModelCaller(request.providerId, request.model)

    await runEvals({
      repoDir,
      caseIds: request.caseIds,
      runs: request.runs,
      disabledSections: request.disabledSections,
      includeSentinel: false,
      callModel,
      providerLabel: request.providerId,
      modelLabel: request.model,
      signal: abortController.signal,
      onProgress: emitProgress,
    })
  } catch (error) {
    emitProgress({
      type: 'error',
      error: error instanceof Error ? error.message : 'Unknown error',
    })
  } finally {
    activeRunAbort = null
  }
}

// ── Handlers ───────────────────────────────────────────

export const evalsRpcHandlers: RpcRouteHandlers<EvalsRoutes> = {
  async recordDownvote(request) {
    try {
      if (!request.sessionId || !request.turnId) {
        return { success: false, error: 'Missing sessionId or turnId' }
      }

      const { recordExplicitDown } = await import('@onething/runtime')

      const session = store.getSession(request.sessionId)
      const workingDirectory = session?.workingDirectory
      const skills = getSkillsForSession(workingDirectory)

      // The incident bundle is the human-facing artifact (scene +
      // trace + note); its creation is what makes the 👎 useful.
      const incident = await createIncidentForTurn({
        sessionId: request.sessionId,
        turnId: request.turnId,
        origin: 'downvote',
        note: request.note,
        userMessage: request.userMessage,
        explicitDown: true,
      })
      const incidentRef = incident?.incidentId ?? null
      // Server-side resolved user message (the renderer historically
      // sent the assistant content here).
      const resolvedUserMessage = incident?.userMessage || request.userMessage

      // AI analysis runs asynchronously after the 👎 returns — the
      // human's only job was the one-liner; title/category/rubric are
      // the machine's job (design D5).
      if (incidentRef) {
        void analyzeIncidentInBackground(incidentRef).catch(() => {})
      }

      // Build assistantResponse from the DOWNVOTED message (turnId is
      // its message id) — the user may downvote an older turn, not the
      // session's latest assistant message.
      const downvotedMsg = request.turnId
        ? sessionReads.getMessage(request.sessionId, request.turnId)
        : undefined
      const lastAssistantMsg =
        downvotedMsg?.role === 'assistant'
          ? downvotedMsg
          : sessionReads.lastMessageOfRole(request.sessionId, 'assistant')
      const assistantResponse =
        lastAssistantMsg?.content != null
          ? {
              content: String(lastAssistantMsg.content),
              toolCalls: lastAssistantMsg.toolCalls?.map(
                (tc: { toolName?: string; arguments?: Record<string, unknown> }) => ({
                  name: tc.toolName ?? 'unknown',
                  args: tc.arguments,
                }),
              ),
              finishReason: lastAssistantMsg.toolCalls?.length ? 'tool_calls' : 'stop',
            }
          : undefined

      const fixturePath = recordExplicitDown({
        turnId: request.turnId,
        sessionId: request.sessionId,
        incidentRef,
        assistantResponse,
        providerId: session?.lastProvider ?? 'unknown',
        model: session?.lastModel ?? 'unknown',
        userMessage: resolvedUserMessage,
        workingDirectory,
        workingDirectoryRoots: session?.workingDirectoryRoots,
        skills,
        hasTools: true,
        storeOptions: {},
      })

      return { success: true, fixturePath, incidentId: incidentRef ?? undefined }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('downvote recording failed', undefined, error)
      return { success: false, error: message }
    }
  },

  async listRecords(request) {
    try {
      const { loadMergedRecords, recordHasNegative } = await import('@onething/runtime')

      let records = loadMergedRecords()

      // Filter: negative only (default true for review)
      if (request.negativeOnly !== false) {
        records = records.filter(recordHasNegative)
      }

      // Filter: category
      if (request.category) {
        records = records.filter(r => r.judge?.category === request.category)
      }

      // Filter: since timestamp
      if (request.sinceTs) {
        const since = new Date(request.sinceTs).getTime()
        records = records.filter(r => new Date(r.ts).getTime() >= since)
      }

      const total = records.length

      // Apply offset/limit
      const offset = request.offset ?? 0
      const limit = request.limit ?? 50
      const page = records
        .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
        .slice(offset, offset + limit)

      // Convert to view models; the user-message preview comes from the
      // exported fixture (only read for the current page, so cost stays
      // bounded by the page size).
      const views: TurnEvalRecordView[] = page.map(r => ({
        ...r,
        hasFixture: !!r.fixtureRef,
        userMessagePreview: readUserMessagePreview(r.fixtureRef),
      }))

      return { success: true, records: views, total }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('list records failed', undefined, error)
      return { success: false, error: message }
    }
  },

  async listFixtures() {
    try {
      const fixtures: EvalFixtureMeta[] = []
      const autoDir = getEvalsFixturesAutoDir()
      const repoDir = resolveEvalsRepoDir()

      // Auto fixtures (user data dir)
      scanFixturesDir(autoDir, fixtures)

      // Manual fixtures (repo dir, if configured)
      if (repoDir) {
        const manualDir = getEvalsFixturesDir(repoDir)
        if (manualDir !== autoDir) {
          scanFixturesDir(manualDir, fixtures)
        }
      }

      fixtures.sort(
        (a, b) => new Date(b.capturedAt).getTime() - new Date(a.capturedAt).getTime(),
      )

      return { success: true, fixtures }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('list fixtures failed', undefined, error)
      return { success: false, error: message }
    }
  },

  async readSnapshot(request, context) {
    try {
      const clamped = clampEvalsWirePath(request.path, context)
      if (!clamped.ok) return { success: false, error: clamped.error }
      const snapshotPath = clamped.path
      if (!fs.existsSync(snapshotPath)) {
        return { success: false, error: 'Snapshot file not found' }
      }

      const isPrompt = snapshotPath.endsWith('.prompt.json')
      const isContext = snapshotPath.endsWith('.context.jsonl')
      if (!isPrompt && !isContext) {
        return { success: false, error: 'Unknown snapshot type' }
      }

      if (isPrompt) {
        const content = fs.readFileSync(snapshotPath, 'utf-8')
        const promptSnapshot = JSON.parse(content)
        return { success: true, snapshotType: 'prompt', promptSnapshot }
      }

      // Context: read jsonl with pagination
      const raw = fs.readFileSync(snapshotPath, 'utf-8')
      const allLines = raw.split('\n').filter(Boolean)
      // First line is header, rest are messages
      const messages: ContextSnapshotMessage[] = []
      for (const line of allLines.slice(1)) {
        try {
          const parsed = JSON.parse(line)
          if (parsed.m) {
            messages.push(parsed.m as ContextSnapshotMessage)
          }
        } catch {
          // skip bad lines
        }
      }
      const offset = request.offset ?? 0
      const limit = request.limit ?? 50
      const page = messages.slice(offset, offset + limit)
      return {
        success: true,
        snapshotType: 'context',
        contextMessages: page,
        total: messages.length,
        hasMore: offset + limit < messages.length,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return { success: false, error: message }
    }
  },

  async readFixture(request, context) {
    try {
      const clamped = clampEvalsWirePath(request.fixturePath, context)
      if (!clamped.ok) return { success: false, error: clamped.error }
      if (!fs.existsSync(clamped.path)) {
        return { success: false, error: 'Fixture file not found' }
      }
      const content = fs.readFileSync(clamped.path, 'utf-8')
      const fixture = JSON.parse(content)
      return { success: true, fixture }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('read fixture failed', undefined, error)
      return { success: false, error: message }
    }
  },

  async listResults() {
    try {
      const repoDir = resolveEvalsRepoDir()
      if (!repoDir) {
        return { success: true, entries: [] }
      }

      const resultsPath = getResultsPath(repoDir)
      if (!fs.existsSync(resultsPath)) {
        return { success: true, entries: [] }
      }

      const content = fs.readFileSync(resultsPath, 'utf-8').trim()
      if (!content) {
        return { success: true, entries: [] }
      }

      const entries: EvalRunResultEntry[] = content
        .split('\n')
        .filter(Boolean)
        .map(line => {
          try {
            return JSON.parse(line) as EvalRunResultEntry
          } catch {
            return null
          }
        })
        .filter((e): e is EvalRunResultEntry => e !== null)

      return { success: true, entries }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('list results failed', undefined, error)
      return { success: false, error: message }
    }
  },

  async listCases() {
    try {
      const repoDir = resolveEvalsRepoDir()
      if (!repoDir) {
        return { success: true, cases: [] }
      }

      const allCases = await loadAllCases(repoDir)

      return { success: true, cases: allCases }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('list cases failed', undefined, error)
      return { success: false, error: message }
    }
  },

  async getCase(request) {
    try {
      const repoDir = resolveEvalsRepoDir()
      if (!repoDir) {
        return { success: false, error: 'Evals repo not configured' }
      }

      const cases = await loadAllCases(repoDir)
      const found = cases.find(c => c.id === request.caseId)
      if (!found) {
        return { success: false, error: 'Case not found' }
      }

      return { success: true, case_: found }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('get case failed', undefined, error)
      return { success: false, error: message }
    }
  },

  async runStart(request) {
    try {
      log.debug('run start received', {
        provider: request.providerId,
        model: request.model,
        runs: request.runs,
        caseIds: request.caseIds?.length ?? 0,
        disabledSections: request.disabledSections,
      })
      if (activeRunAbort) {
        log.warn('run start blocked', { reason: 'run already in progress' })
        return { success: false, error: 'A run is already in progress' }
      }

      const repoDir = resolveEvalsRepoDir()
      log.debug('repo dir resolved', { repoDir })
      if (!repoDir) {
        log.warn('run start blocked', { reason: 'no repo dir' })
        return { success: false, error: 'Evals repo not configured' }
      }

      // Fail fast if the provider can't serve eval calls, instead of
      // launching a run where every attempt throws and a zero-score
      // entry pollutes results.jsonl.
      const credentials = resolveEvalsCredentials(request.providerId)
      log.debug('credentials check', {
        ok: credentials.ok,
        reason: credentials.ok ? undefined : credentials.reason,
      })
      if (!credentials.ok) {
        return { success: false, error: credentials.reason }
      }

      const abortController = new AbortController()
      activeRunAbort = abortController

      log.info('background run launching', {
        provider: request.providerId,
        model: request.model,
      })
      // Fire and forget — progress is sent via push events
      runEvalsInBackground(repoDir, request, abortController).catch(err => {
        log.error('background run failed', undefined, err)
      })

      log.debug('run start accepted')
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('run start failed', undefined, error)
      return { success: false, error: message }
    }
  },

  async runCancel() {
    if (activeRunAbort) {
      // Only signal — the background run's finally clears activeRunAbort
      // once it has actually exited. Clearing here would let a second run
      // start while the first is still writing progress/results.
      activeRunAbort.abort()
      return { success: true }
    }
    return { success: false, error: 'No run in progress' }
  },

  async promoteFixture(request, context) {
    try {
      const repoDir = resolveEvalsRepoDir()
      if (!repoDir) {
        return { success: false, error: 'Evals repo not configured' }
      }

      // Read the fixture
      const clamped = clampEvalsWirePath(request.fixturePath, context)
      if (!clamped.ok) return { success: false, error: clamped.error }
      const fixturePath = clamped.path
      if (!fs.existsSync(fixturePath)) {
        return { success: false, error: 'Fixture file not found' }
      }
      const fixtureContent = fs.readFileSync(fixturePath, 'utf-8')
      const fixture = JSON.parse(fixtureContent)

      // Copy fixture to repo evals/fixtures/
      const repoFixturesDir = getEvalsFixturesDir(repoDir)
      fs.mkdirSync(repoFixturesDir, { recursive: true })
      // 目的地一律由 `basename` 拼,所以写的落点永远在 repoFixturesDir 里,
      // 与来源路径长什么样无关(来源那一侧由上面的夹紧负责)。
      const fixtureFilename = path.basename(fixturePath)
      const destFixturePath = path.join(repoFixturesDir, fixtureFilename)
      if (!fs.existsSync(destFixturePath)) {
        fs.copyFileSync(fixturePath, destFixturePath)
      }

      // Optionally copy .context.jsonl for multi-turn replay
      let contextRef: string | undefined
      if (request.includeContext) {
        const baseName = fixtureFilename.replace(/\.json$/, '')
        const contextSrc = path.join(
          path.dirname(fixturePath),
          `${baseName}.context.jsonl`,
        )
        if (fs.existsSync(contextSrc)) {
          const contextDest = path.join(repoFixturesDir, path.basename(contextSrc))
          if (!fs.existsSync(contextDest)) {
            fs.copyFileSync(contextSrc, contextDest)
          }
          contextRef = path.basename(contextSrc)
        }
      }

      // Generate case YAML via the shared runtime generator
      const { generateCaseYaml } = await import('@onething/runtime')
      const expect: Record<string, unknown> = {}
      const e = request.expect
      // Tool Call
      if (e.firstToolCall) expect.firstToolCall = e.firstToolCall
      if (e.lastToolCall) expect.lastToolCall = e.lastToolCall
      if (e.hasToolCalls !== undefined) expect.hasToolCalls = e.hasToolCalls
      if (e.toolCallContains) expect.toolCallContains = e.toolCallContains
      if (e.noToolCalls) expect.noToolCalls = e.noToolCalls
      if (e.toolCallCount) expect.toolCallCount = e.toolCallCount
      // Skill
      if (e.skillUsed) expect.skillUsed = e.skillUsed
      if (e.anySkillUsed !== undefined) expect.anySkillUsed = e.anySkillUsed
      // MCP
      if (e.mcpToolUsed !== undefined) expect.mcpToolUsed = e.mcpToolUsed
      if (e.mcpServerUsed) expect.mcpServerUsed = e.mcpServerUsed
      if (e.mcpToolUsedName) expect.mcpToolUsedName = e.mcpToolUsedName
      // Output
      if (e.contains) expect.contains = e.contains
      if (e.notContains) expect.notContains = e.notContains
      if (e.minOutputLength !== undefined) expect.minOutputLength = e.minOutputLength
      if (e.maxOutputLength !== undefined) expect.maxOutputLength = e.maxOutputLength
      if (e.outputStartsWith) expect.outputStartsWith = e.outputStartsWith
      if (e.outputEndsWith) expect.outputEndsWith = e.outputEndsWith
      if (e.regex) expect.regex = e.regex
      if (e.notes) expect.notes = e.notes

      const yaml = generateCaseYaml({
        id: request.caseId,
        description: request.description,
        fixture: fixtureFilename,
        context: contextRef,
        userMessage: fixture.userMessage || '',
        expect,
      })

      const casesDir = getEvalsCasesDir(repoDir)
      fs.mkdirSync(casesDir, { recursive: true })
      const casePath = path.join(casesDir, `${request.caseId}.yaml`)
      fs.writeFileSync(casePath, yaml, 'utf-8')

      return { success: true, casePath }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('promote fixture failed', undefined, error)
      return { success: false, error: message }
    }
  },

  async retireCase(request) {
    try {
      const repoDir = resolveEvalsRepoDir()
      if (!repoDir) {
        return { success: false, error: 'Evals repo not configured' }
      }

      const casesDir = getEvalsCasesDir(repoDir)
      const casePath = path.join(casesDir, `${request.caseId}.yaml`)
      if (!fs.existsSync(casePath)) {
        return { success: false, error: 'Case file not found' }
      }

      const sentinelDir = path.join(casesDir, 'sentinel')
      fs.mkdirSync(sentinelDir, { recursive: true })
      const newPath = path.join(sentinelDir, `${request.caseId}.yaml`)
      fs.renameSync(casePath, newPath)

      return { success: true, newPath }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('retire case failed', undefined, error)
      return { success: false, error: message }
    }
  },

  async generateTriage(request) {
    try {
      const repoDir = resolveEvalsRepoDir()
      if (!repoDir) {
        return { success: false, error: 'Evals repo not configured' }
      }

      const { loadMergedRecords, filterRecordsByWeeks, generateTriageReport } = await import(
        '@onething/runtime'
      )

      const records = loadMergedRecords()
      const filtered = filterRecordsByWeeks(records, request?.weeks ?? 1)
      const report = generateTriageReport(filtered)

      const triagePath = getTriagePath(repoDir)
      if (fs.existsSync(triagePath)) {
        const existing = fs.readFileSync(triagePath, 'utf-8')
        const updated = existing.replace(
          /## Current Week:.*/,
          `## Current Week: ${new Date().toISOString().slice(0, 10)}`,
        )
        fs.writeFileSync(triagePath, updated + '\n' + report, 'utf-8')
      } else {
        fs.writeFileSync(triagePath, `# Evals Triage Ledger\n\n${report}`, 'utf-8')
      }

      return { success: true, report, triagePath }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('generate triage failed', undefined, error)
      return { success: false, error: message }
    }
  },

  async readRunDetail(request, context) {
    try {
      const repoDir = resolveEvalsRepoDir()
      if (!repoDir) {
        return { success: false, error: 'Evals repo not configured' }
      }
      // `detailPath` 是相对仓根的,先拼再夹 —— 夹的是拼完的结果,`..` 因此没有
      // 出路(桌面照旧不夹,形状与迁移前逐字相同)。
      const clamped = clampEvalsWirePath(path.join(repoDir, request.detailPath), context)
      if (!clamped.ok) return { success: false, error: clamped.error }
      const fullPath = clamped.path
      if (!fs.existsSync(fullPath)) {
        return { success: false, error: 'Run detail file not found' }
      }
      const detail = JSON.parse(fs.readFileSync(fullPath, 'utf-8'))
      return { success: true, detail }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      log.error('read run detail failed', undefined, error)
      return { success: false, error: message }
    }
  },
}

