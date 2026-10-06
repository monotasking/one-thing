/**
 * Assembly-layer fence: importing @onething/backend modules must configure NOTHING.
 *
 * Before the createOnethingBackend factory existed, eleven modules wired
 * runtime adapters at import time. In a process that assembles its own
 * runtime (the standalone backend process (`backend-standalone-main.ts`)), merely importing those modules clobbered the host's
 * configuration (last-writer-wins). All wiring now happens exclusively
 * through configureAppRuntimeAdapters() / createOnethingBackend().
 */
import { describe, expect, it, vi } from 'vitest'

const spy = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('@onething/backend/tool/tool-sandbox-runtime', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingToolSandboxRuntime: () => { spy.calls.push('sandbox') },
}))
vi.mock('@onething/backend/tool/tool-background-jobs', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureCoreBackgroundJobs: () => { spy.calls.push('background-jobs') },
}))
// P3'a-3:绑定件归位后从 `./scheduler.js` 直取(runtime 源码不自引用包名),所以
// 打在 barrel 上的桩够不着了 —— 换成打在**具体模块**上。barrel 的 `export *` 同样
// 解析到这一个 id,走 barrel 的调用方照旧拿到桩。
vi.mock('@onething/backend/scheduler/scheduler-cron-runner', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingScheduler: () => { spy.calls.push('scheduler') },
}))
vi.mock('@onething/backend/file/file-ripgrep', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingRipgrepRuntime: () => { spy.calls.push('ripgrep') },
}))
// 检索收口(2026-10-03)以后 `install-providers` 是检索入口的一部分,不再经入口取
// `configureOnethingSearchProviders`,所以桩打在入口的 `configureAppSearchProviders` 上:
// 照旧调真的那一份(它的闩还在起作用),只把「真正去装」那一步换成计数。
vi.mock('@onething/backend/search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@onething/backend/search')>()
  return {
    ...actual,
    configureAppSearchProviders: () => actual.configureAppSearchProviders(() => { spy.calls.push('search') }),
  }
})
// 深层引用收口第四批(2026-10-04):`skill-manage-setup.ts` / `skill-sources.ts` 改引兄弟文件(D126),
// 不再经入口拿这两个 configure,所以桩打在声明它们的具体模块上(与上面 permission 那条同理)。
vi.mock('../skill/skill-manage.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingSkillManageRuntime: () => { spy.calls.push('skill-manage') },
}))
vi.mock('../skill/skill-loader.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingSkillsLoaderRuntime: () => { spy.calls.push('skills-loader') },
}))
// 越层清零单 3(2026-10-04):`permission-grant-storage.ts` 改引兄弟文件(D126),不再经入口拿
// `configureOnethingPermissionGrantStorage`,所以桩打在具体模块上;入口的 re-export 同样解析到这一个 id。
vi.mock('../permission/permission-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  configureOnethingPermissionGrantStorage: () => { spy.calls.push('permission-grants') },
}))
// providers 收口第二部分:装配处(`provider-call-chat` 的 `configureAppProviderRegistry`)经服务商入口拿
// `initializeRegistry`,所以桩打在入口上,不再打在入口背后的 `provider-table.ts`。
vi.mock('@onething/backend/provider', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  initializeRegistry: () => { spy.calls.push('provider-registry') },
}))
vi.mock('../credentials/credentials-pool.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // 批 E:插件凭证策略的裁决口也是一个 configure*Host 端口,同归这道栅栏管。
  configureSpaceCredentialPluginStrategyHost: () => { spy.calls.push('credential-strategy-host') },
}))
// 第④步批 0:凭证主密钥**首次用到时**才读。import 凭证入口不许起 `security`(钥匙串档的挂死风险就在
// 那一步)—— 计数桩打在子进程的出生口上,数「谁想起 security」。被数到的那一次**不起真的**
// `security`,换成 `/usr/bin/false`:这条用例就算红了,也碰不到用户的钥匙串。别的命令照旧调真的。
const keySpy = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const spawn = ((command: string, ...rest: unknown[]) => {
    if (String(command).endsWith('security')) {
      keySpy.calls.push(`spawn ${command}`)
      return actual.spawn('/usr/bin/false', [], { stdio: 'ignore' })
    }
    return (actual.spawn as (...args: unknown[]) => unknown)(command, ...rest)
  }) as typeof actual.spawn
  return { ...actual, default: { ...actual, spawn }, spawn }
})
vi.mock('@onething/backend/permission/permission-capabilities', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  registerBuiltinCapabilities: () => { spy.calls.push('capabilities') },
}))

// 包根归位 B(2026-10-03):会话表与设置仓储改成首次用到时才建,import 会话入口不再读设置、不再建仓储。
// 计数桩打在三个仓储 / 驱动的构造口与两条「要读设置 / 应用状态才会问」的路径函数上;都照旧调真的那一份。
const loadSpy = vi.hoisted(() => ({ calls: [] as string[] }))

vi.mock('../session/session-repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@onething/backend/session')>()
  return {
    ...actual,
    createOnethingSessionRepository: ((options: never) => {
      loadSpy.calls.push('session-repository')
      return actual.createOnethingSessionRepository(options)
    }) as typeof actual.createOnethingSessionRepository,
  }
})
vi.mock('../session/session-storage-driver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@onething/backend/session')>()
  return {
    ...actual,
    createHybridSessionStorageDriver: ((options: never) => {
      loadSpy.calls.push('session-storage-driver')
      return actual.createHybridSessionStorageDriver(options)
    }) as typeof actual.createHybridSessionStorageDriver,
  }
})
// 包根归位 2:设置缓存搬进 `settings/` 以后按相对路径取构造口,桩因此打在定义它的那只模块上。
vi.mock('../settings/settings-repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../settings/settings-repository.js')>()
  return {
    ...actual,
    createOnethingSettingsRepository: ((options: never) => {
      loadSpy.calls.push('settings-repository')
      return actual.createOnethingSettingsRepository(options)
    }) as typeof actual.createOnethingSettingsRepository,
  }
})
vi.mock('@onething/backend/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@onething/backend/storage')>()
  return {
    ...actual,
    getOnethingSettingsPath: () => {
      loadSpy.calls.push('settings-path')
      return actual.getOnethingSettingsPath()
    },
    getOnethingAppStatePath: () => {
      loadSpy.calls.push('app-state-path')
      return actual.getOnethingAppStatePath()
    },
  }
})

describe('@onething/backend import purity', () => {
  it('importing the formerly side-effectful modules configures nothing', { timeout: 60_000 }, async () => {
    await import('@onething/backend/permission/permission-sandbox-roots')
    await import('@onething/backend/tool/tool-background-jobs-bound')
    await import('@onething/backend/tool/tool-bash-executor')
    await import('../provider-call/provider-call-chat.js')
    await import('@onething/backend/scheduler/scheduler-bound')
    await import('../file/file-ripgrep-app-fetch.js')
    await import('@onething/backend/search')
    await import('@onething/backend/skill/skill-manage-setup')
    await import('@onething/backend/skill/skill-sources')
    await import('@onething/backend/permission/permission-grant-storage')
    await import('../credentials/credentials-resolution.js')
    await import('../credentials/credentials-strategy.js')

    expect(spy.calls).toEqual([])
  })

  /**
   * K0 的注册基座同样归这道栅栏管(内核收缩,
   * docs/design/kernel-shrink-builtin-plugins-2026-08.md §1 D2)。
   *
   * 它比上面那批更容易在未来出事:`feature-registry/feature-registry-table` 与 `http-server/http-server-client-api-roster` 都在模块
   * 级持有表,而「顺手在模块级挂一个 feature」是个只要写一次就再也发现不了的
   * 错 —— 症状会是不带界面的后端进程(`backend-standalone-main.ts`)里 import 一下就把域注册了,与宿主自己的装配
   * 撞重复守卫。所以这里断言的是**表在 import 后是空的**。
   */
  it('importing the K0 feature base mounts nothing', { timeout: 60_000 }, async () => {
    const features = await import('../feature-registry/feature-registry.js')
    await import('../http-server/http-server-client-api-roster.js')

    expect(features.dumpFeatures()).toEqual([])
  })

  /**
   * 会话入口交出会话表(`session-store.ts`)与会话组合根以后,import 它的模块在加载时都会带上会话表、设置与
   * 应用状态那几只模块。这道栅栏断言的是**带上不等于用上**:加载期不建会话仓储、不建存储驱动、不建设置仓储,
   * 也不去问设置 / 应用状态文件在哪。上面那条 `it` 已经连带加载过入口的话,这里照样数得到。
   */
  it('importing the sessions entry builds no repository and reads no settings', { timeout: 60_000 }, async () => {
    const sessions = await import('@onething/backend/session')
    // 包根归位 2(2026-10-03):设置仓储进了设置入口、接入目录进了文件入口,一并 import。这里从前还 import 兼容桶 `store.ts`,
    // 包根归位 B(2026-10-04)删桶之后它的名字都从会话 / 设置入口拿,两只入口上面已经各 import 过。
    await import('@onething/backend/settings')
    await import('@onething/backend/file')

    expect(typeof sessions.getSession).toBe('function')
    expect(loadSpy.calls).toEqual([])
  })

  /**
   * providers 收口(2026-10-04)以后,外面要服务商的名字一律经这一个入口拿,入口闭包里因此带着名册、模型目录、
   * 生效配置与各家方言。这道栅栏断言 import 入口时不建会话仓储 / 设置仓储,也不去问设置 / 应用状态文件在哪:
   * 入口里任何一只模块若在加载期读设置(例如顶层调 `getSettings()`),这里就会数到 `settings-repository` 而红。
   */
  it('importing the providers entry builds no repository and reads no settings', { timeout: 60_000 }, async () => {
    const providers = await import('@onething/backend/provider')

    expect(typeof providers.getProviderManifest).toBe('function')
    expect(loadSpy.calls).toEqual([])
  })

  /**
   * engine 收口(2026-10,决策 D27)以后,外面要引擎的名字一律经引擎入口拿,入口闭包里带着对话门面、引擎 runtime 的
   * 十二槽、历史投影与系统提示词快照,也连着 agent-loop 内核的入口。这道栅栏断言 import 两只入口时不建会话仓储 /
   * 设置仓储,也不去问设置 / 应用状态文件在哪 —— 引擎从前的 `engine-layer.ts` 读当前引擎、建引擎都只在函数里,
   * 搬家以后同样只在函数里。
   */
  it('importing the engine entry builds no repository and reads no settings', { timeout: 60_000 }, async () => {
    const engine = await import('@onething/backend/engine')
    const agentLoop = await import('@onething/backend/agent-loop')

    expect(typeof engine.ProductStreamEngine).toBe('function')
    expect(typeof agentLoop.CoreStreamEngine).toBe('function')
    expect(loadSpy.calls).toEqual([])
  })

  /**
   * 凭证入口(第④步批 0)闭包里带着主密钥、钥匙串门面与旧 safeStorage 迁移。import 它不许读钥匙:
   * 不起 `security`(钥匙串档的挂死风险就在那一步)、不碰钥匙文件 —— 钥匙在装配时才起读。
   * 档位临时换成钥匙串、摘掉 vitest 那道「不起真 security」的第二道闸,好让「import 时偷偷读了」一定会
   * 走到子进程那一步被数到(上面的桩保证数到的那一次起的是 `/usr/bin/false`)。
   */
  it('importing the credentials entry reads no master key', { timeout: 60_000 }, async () => {
    vi.stubEnv('ONETHING_CREDENTIALS_KEYRING', 'keychain')
    vi.stubEnv('VITEST', '')
    try {
      const credentials = await import('@onething/backend/credentials')
      expect(typeof credentials.credentialsStatus).toBe('function')
      expect(keySpy.calls).toEqual([])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('configureAppRuntimeAdapters wires every adapter exactly once', { timeout: 60_000 }, async () => {
    const { configureAppRuntimeAdapters } = await import('../backend.js')

    configureAppRuntimeAdapters()
    configureAppRuntimeAdapters()

    expect([...spy.calls].sort()).toEqual([
      'background-jobs',
      'capabilities',
      'credential-strategy-host',
      'permission-grants',
      'provider-registry',
      'ripgrep',
      'sandbox',
      'scheduler',
      'search',
      'skill-manage',
      'skills-loader',
    ])
  })
})
