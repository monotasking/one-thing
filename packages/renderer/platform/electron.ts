import { goalRouter } from '@shared/ipc/goal.js'
import { promptsRouter } from '@shared/ipc/prompts.js'
import { todoPlanRouter } from '@shared/ipc/todo-plan.js'
import { usageRouter } from '@shared/ipc/usage.js'
import type { ElectronAPI } from '@/types'
import { clientFor } from './client'
import { ELECTRON_HOST_CAPABILITIES } from './electron-capabilities'
import type { PlatformApi } from './types'

/**
 * 桌面的能力表住在 `./electron-capabilities`(C2 抽出去的,内容一位没改):
 * `platform/client.ts` 造 IPC 传输时要把它递给 `Transport.capabilities()`,
 * 而本文件反过来要 `client.ts` 的 `clientFor` —— 留在原处就是一条模块环。
 */
const electronCapabilities = ELECTRON_HOST_CAPABILITIES

export function createElectronPlatformApi(electronAPI: ElectronAPI): PlatformApi {
  // 每个 router 域一行。**传输面已经归 `@onething/client`**(C2):这只桥的
  // `Transport` 实现在 `platform/electron-transport.ts`,`clientFor` 按 electronAPI
  // 对象记忆,所以这里拿到的与 `platformApi` / `client` 拿到的是同一份。
  // 「延迟到调用时取 electronAPI.rpcInvoke」那条纪律搬进了传输实现里(preload 在
  // reload 时会整只换掉方法),与本文件其余部分「按访问转发、不快照」一致。
  const client = clientFor(electronAPI)
  const usage = client.api(usageRouter)
  const prompts = client.api(promptsRouter)
  const goal = client.api(goalRouter)
  const todoPlan = client.api(todoPlanRouter)

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

    // ── Todo / plan 数据面(todoPlanRouter)。窗口面走宿主壳路由(A1-a)。──
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
