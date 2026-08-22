import { goalRouter } from '@shared/ipc/goal.js'
import { promptsRouter } from '@shared/ipc/prompts.js'
import { todoPlanRouter } from '@shared/ipc/todo-plan.js'
import { usageRouter } from '@shared/ipc/usage.js'
import type { ElectronAPI } from '@/types'
import { createRouterClient } from './router-client'
import type { PlatformApi, PlatformCapabilities } from './types'

const electronCapabilities: PlatformCapabilities = {
  localFileSystem: true,
  workspaceFileSystem: true,
  nativeWindowControls: true,
  shellTools: true,
  terminal: true,
  embeddedBrowser: true,
  collabRooms: true,
  music: true,
  interactionRespond: true,
  evals: true,
  pluginsManage: true,
  clipboardWrite: true,
  desktopWindows: true,
  globalMenuEvents: true,
}

export function createElectronPlatformApi(electronAPI: ElectronAPI): PlatformApi {
  // 每个 router 域一行。传输面(rpcInvoke)只写这一次 —— 加域不再动本文件的管道。
  // 延迟到调用时取 electronAPI.rpcInvoke:preload 在 reload 时会整只换掉方法,
  // 和本文件其余部分「按访问转发、不快照」的规矩保持一致。
  const invoke = (request: Parameters<ElectronAPI['rpcInvoke']>[0]) => electronAPI.rpcInvoke(request)
  const usage = createRouterClient(usageRouter, invoke)
  const prompts = createRouterClient(promptsRouter, invoke)
  const goal = createRouterClient(goalRouter, invoke)
  const todoPlan = createRouterClient(todoPlanRouter, invoke)

  const extras = {
    environment: 'electron' as const,
    capabilities: electronCapabilities,
    getCapabilities: async () => electronCapabilities,

    // 插件的十九条数据面已随 `pluginsRouter` 迁到通用 RPC 通道(P4 终态批 C2);
    // 过线前那道**只查不修**的序列化自检跟着搬进了 `platform/plugins-client.ts`
    // —— 它现在对两个宿主都跑,而不是只有 electron 这一侧有。

    // ── Token usage / billing(usageRouter over rpcInvoke)──────────
    getUsageSummary: usage.getSummary,
    getSessionUsage: usage.getSession,

    // ── User prompt snippets(promptsRouter)────────────────────────
    // 对外方法名一个不改:调用点(stores/prompts.ts、picker)不知道传输面换了。
    listPrompts: () => prompts.list({}),
    getPrompt: prompts.get,
    createPrompt: prompts.create,
    updatePrompt: prompts.update,
    deletePrompt: prompts.delete,

    // ── Session goals(goalRouter)──────────────────────────────────
    // 签名沿用旧的「传 sessionId 字符串」,信封在这里包,不外扩到调用点。
    goalGet: (sessionId: string) => goal.get({ sessionId }),
    goalSet: goal.set,
    goalDiffs: (sessionId: string) => goal.diffs({ sessionId }),

    // ── Todo / plan 数据面(todoPlanRouter)。窗口面仍在 electronAPI 上。──
    getTodoPlan: (request?: Parameters<typeof todoPlan.get>[0]) => todoPlan.get(request ?? {}),
    createTodoPlanNote: todoPlan.create,
    updateTodoPlan: todoPlan.update,
    renameTodoPlanNote: todoPlan.rename,
    deleteTodoPlanNote: todoPlan.delete,
    revealTodoPlanDirectory: () => todoPlan.revealDirectory({}),
  }
  // Forward per-access instead of snapshotting: tests (and the preload bridge
  // on reload) replace individual methods on window.electronAPI after this
  // wrapper is created, and those replacements must stay visible.
  return new Proxy(extras as PlatformApi, {
    get: (target, prop, receiver) =>
      prop in extras ? Reflect.get(target, prop, receiver) : Reflect.get(electronAPI, prop),
    has: (target, prop) => prop in extras || prop in electronAPI,
  })
}
