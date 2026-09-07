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
  'killAllTerminals',
  'killTrackedDetachedChildren',
  'searchService',
  'pluginManager',
  'mcp',
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
      plugins: null, gateway: null, settings: null, evals: null, mcp: null, localTrust: null,
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
