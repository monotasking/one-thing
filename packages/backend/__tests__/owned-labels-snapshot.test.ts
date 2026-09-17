/**
 * `own()` 登记表的**逐字快照**(工单 5 §1 的判据)。
 *
 * `adopt()` 要做的事是把 `backend.ts` 里三句一组的手写 `own(quiesce)/own(drain)/
 * own(dispose)` 收成一句;它是不是"逐字等价"这件事,唯一说得出话的口径就是这张
 * 表 —— 标签、顺序、条数,一个字都不许变。所以这里不写"包含哪几格"(那种断言
 * 收缩顺序改了也绿),而是把整张表钉死。
 *
 * store 隔离与动态 import 的理由同 `assembly-lifecycle.test.ts` 文件头。
 */
import { afterAll, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'

const previousStorePath = process.env.ONETHING_STORE_PATH
const storeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-owned-labels-'))
process.env.ONETHING_STORE_PATH = storeRoot

afterAll(async () => {
  const { getCurrentBackendSafe, setCurrentBackend } = await import('../current.js')
  if (getCurrentBackendSafe()) setCurrentBackend(null)
  if (previousStorePath === undefined) delete process.env.ONETHING_STORE_PATH
  else process.env.ONETHING_STORE_PATH = previousStorePath
  fs.rmSync(storeRoot, { recursive: true, force: true })
})

class NoopSender extends EventEmitter {
  isDestroyed(): boolean { return false }
  send(): void { /* 不观察推送面 */ }
}

const OWNED_LABELS = [
  'activeRequests',
  'hostPorts',
  'externalAgentsAssemblyRollback',
  'externalAgentsAdmission',
  'storeLease',
  'usageLedgerBinding',
  'usageLedger',
  'pluginModelsAdmission',
  'pluginModelsDrain',
  'credentialStrategiesAdmission',
  'credentialStrategiesDrain',
  'credentialStrategyState',
  'todoPlanAdmission',
  'todoPlanDrain',
  'todoPlanRuntime',
  'evalsTaskBinding',
  'evalsTaskAdmission',
  'evalsTaskDrain',
  'mediaLibraryBinding',
  'mediaLibraryAdmission',
  'mediaLibraryDrain',
  'practiceBinding',
  'practiceAdmission',
  'practiceDrain',
  'musicAdmission',
  'musicDrain',
  'voiceBinding',
  'voiceAdmission',
  'voiceDrain',
  'flushSessionEventLedger',
  'flushAllPendingSaves',
  'eventSystem',
  'collabInspectorBinding',
  'collabInspectorAdmission',
  'collabInspectorDrain',
  'toolExecutionAdmission',
  'toolExecutionDrain',
  'collabDigestBinding',
  'collabDigestAdmission',
  'collabDigestDrain',
  'sessionLayer',
  'sessionDeletions',
  'sessionTocAdmission',
  'sessionTocDrain',
  'sessionLedgerBroadcaster',
  'outboundRepliesAdmission',
  'outboundRepliesDrain',
  'taskDispatchAdmission',
  'taskDispatchDrain',
  'builtinTriggers',
  'sessionPermissionRecorders',
  'interaction',
  'permission',
  'streamEngine',
  'variableSystem',
  'goalStreamBreakers',
  'goalRetryAdmission',
  'goalRetryDrain',
  'goalUsage',
  'projectDirs',
  // K1(`docs/design/atom-2026-09.md`):资源内核两格,排在工具目录之后 ——
  // 关机链上反着跑(先注销内置资源,再清内核那一格)。资源工具进不进工具目录归 K3。
  'resourceKernel',
  'builtinResources',
  // K2a:资源事件单向转发上总线。登记在两条资源登记之后 —— 关机链上它先撤,
  // 于是内核还在的时候订阅已经摘干净了。
  // K2b-2:壳侧提供者的登记簿。登记在内置资源之后 → 关机链上跑在它之前
  // (壳交的资源先按 §10.2 收场,再轮到内置的和内核本身)。
  'shellResources',
  'resourceEventBridge',
  // K3-a:资源工具(加元工具 `resources`)在工具目录里的那份投影。登记在壳登记簿
  // 之后 → 关机链上先摘目录、再撤壳交上来的自述。
  'resourceCatalogTools',
  'killAllTerminals',
  'killTrackedDetachedChildren',
  'searchService',
  'pluginManager',
  'mcp',
  // K5-a:MCP 投影驱动。紧跟在 `mcp` 之后登记 → 关机链上先摘那几个投影出来的命名
  // 空间,再关客户端(反过来的话中间那一拍注册表里留着打不通电话的命名空间)。
  'mcpResources',
  'acp',
  'externalAgents',
  'engineAbortAll',
  'collab',
  'rpcDomains',
  'sessionBlobGc',
  'sessionListBackfill',
]

it('own() 登记表逐字快照', { timeout: 180_000 }, async () => {
  const { createOnethingBackend } = await import('../backend.js')
  const backend = await createOnethingBackend({
    host: {
      storePath: {}, sandbox: {}, auth: null, logging: null, shell: null, voice: null,
      terminal: null, skillsEnvironment: null, todoPlan: null, scratchpad: null,
      plugins: null, gateway: null, settings: null, evals: null, mcp: null, localTrust: null, speechOutput: null,
    },
    toolRegistry: 'headless',
    sender: new NoopSender() as never,
  })
  try {
    expect(backend.ownedLabels()).toEqual(OWNED_LABELS)
  } finally {
    await backend.dispose()
  }
})
