/**
 * 不带界面的后端进程的「档位」:谁拉起了这个进程,它就照谁的需要多起几件事。
 *
 * 为什么有档位(第④步批 2a,`docs/design/two-process-2026-10.md` §2.3 第 7 / 8 条):批 2b 起桌面不再自己装配
 * 后端,而是拉起 `backend-standalone-main.ts` 这个进程、经发现文件连上它。今天的 `server:start` 是一台
 * 「只有 HTTP 面」的后端,桌面进程内那一份比它多起五件事(用户定时任务、真的 MCP 客户端、电台指挥、首启
 * 模型拉取、登录 shell 的 PATH)、多一格宿主能力(出声)、装配开关也不同。档位就是把「桌面需要的那一份」
 * 写成数据,由拉起它的人用一个环境变量点名:
 *
 *   `ONETHING_BACKEND_LAUNCHER` | 谁拉起 | 起什么
 *   ----------------------------|--------|-------------------------------------------------------------
 *   不设 / `none`               | `server:start`、真机门 | 与批 2a 之前**逐字相同**(只有决策 D6 / D9 两处改动)
 *   `desktop`                   | 批 2b 起的桌面 | 装配开关与桌面进程内那份逐格相同(D14);五件补齐;出声;
 *                               |        | 发现文件 owner `backend`;日志 `app.jsonl`、不回显到终端
 *   `cli`                       | 批 3 起的 CLI | 认这个值,但它该起什么属于批 3(决策 D7),今天等同 `none`
 *
 * 交出三类东西:
 *   - 读档位:`readBackendLauncher(env)`(唯一读 `ONETHING_BACKEND_LAUNCHER` 的地方)与
 *     `backendLaunchProfile(launcher, env)`(档位 → 一张纯数据的档案);
 *   - 装配用的几格:`launchHostPorts(profile, env)`(宿主表里随档位变的两格)、`prepareProcessEnv(profile)`
 *     (登录 shell 的 PATH,在第一次 spawn 之前等它);
 *   - 装配之后起的服务:`startLaunchServices(backend, profile)`,每一件都在起它的那一行 `own()`。
 *
 * 依赖:scheduler、music(经实例)、settings、process-env、voice、mcp 与 logging 的入口。被谁用:进程入口
 * `backend-standalone-main.ts` 与 `http-server/http-server-standalone-backend.ts` / `http-server-runtime.ts`。
 */
import type { OnethingBackend, OnethingBackendOptions } from '@onething/backend/backend.js'
import type { OnethingHostPorts } from '@onething/backend/backend-host-ports.js'
import type { ConfigureLoggingOptions } from '@onething/backend/logging/logging-configure'
import type { HttpDiscoveryOwner } from '@shared/backend/http-discovery.js'
import type { MCPClientLike } from '@onething/backend/mcp'
import type { MCPServerConfig } from '@shared/ipc/mcp.js'
import { getLogger } from '@onething/backend/logging'
import { createNativeMCPClient } from '@onething/backend/mcp'
import { hydrateProcessEnvFromLoginShell } from '@onething/backend/process-env'
import { initializeUserSchedulerTasks } from '@onething/backend/scheduler'
import { getSettings, modelRegistry } from '@onething/backend/settings'
import { createProcessSpeechOutput } from '@onething/backend/voice'

// ── 读档位 ────────────────────────────────────────────────────────────────

/** 认得的档位。`none` 与「不设」同义:没有启动者,就是 `server:start` 今天那一档。 */
export const BACKEND_LAUNCHERS = ['desktop', 'cli', 'none'] as const
export type BackendLauncher = typeof BACKEND_LAUNCHERS[number]

export type BackendLauncherReading =
  | { readonly ok: true; readonly launcher: BackendLauncher | undefined }
  | { readonly ok: false; readonly value: string }

/**
 * 读 `ONETHING_BACKEND_LAUNCHER`。不设或空串 = `undefined`(缺省档);认不出的值答 `ok: false` ——
 * 进程入口据此拒绝启动,而不是静默退回缺省档:拼错一个字母就少了 MCP 与定时任务,那种错没人看得出来。
 */
export function readBackendLauncher(env: NodeJS.ProcessEnv = process.env): BackendLauncherReading {
  const raw = env.ONETHING_BACKEND_LAUNCHER
  if (raw === undefined || raw === '') return { ok: true, launcher: undefined }
  return (BACKEND_LAUNCHERS as readonly string[]).includes(raw)
    ? { ok: true, launcher: raw as BackendLauncher }
    : { ok: false, value: raw }
}

/** 这几个装配开关随档位变(D14 对比的就是这一格)。 */
export type LaunchAssemblySwitches = Required<Pick<OnethingBackendOptions, 'toolRegistry' | 'sessionSkills' | 'pets'>>
  & Pick<OnethingBackendOptions, 'promptVersion' | 'collab'>

/** 一个档位的全部差异,纯数据(工厂函数除外,它们不起任何东西)。 */
export interface BackendLaunchProfile {
  /** 读到的档位;`undefined` = 没设。 */
  readonly launcher: BackendLauncher | undefined
  readonly assembly: LaunchAssemblySwitches
  /** 进程自己的日志文件与终端回显。 */
  readonly logging: Pick<ConfigureLoggingOptions, 'fileBaseName' | 'src' | 'consoleEcho'>
  /** 发现文件里的 owner(决策 D6)。 */
  readonly discoveryOwner: HttpDiscoveryOwner
  /** `null` = 不改进程名。 */
  readonly processTitle: string | null
  /** ACP agent 要人答卡、没人答时怎么办:`wait` 一直等(有窗口的宿主),`reject` 到点拒(无人值守)。 */
  readonly acpUnanswered: 'wait' | 'reject'
  /** MCP 客户端工厂;`undefined` = 由 server runtime 按 `ONETHING_SERVER_MCP_*` 环境变量决定(今天的行为)。 */
  readonly mcpClientFactory: ((config: MCPServerConfig) => MCPClientLike) | undefined
  /** 装配之前就要做的、与装配之后才起的几件。 */
  readonly loginShellEnv: boolean
  readonly speechOutput: boolean
  readonly userSchedulerTasks: boolean
  readonly music: boolean
  readonly modelRegistryRefresh: boolean
}

/**
 * 档位 → 档案。缺省档的每一格都是批 2a 之前 `createRealServerBackend` 与进程入口里写死的值
 * (`ONETHING_SERVER_TOOLS=readonly` 照旧降级);桌面档的装配开关与 `apps/desktop-react/electron/own-core-options.ts`
 * 逐格相同,由 `apps/desktop-react/electron/__tests__/own-core-options.test.ts` 对比。
 */
export function backendLaunchProfile(
  launcher: BackendLauncher | undefined,
  env: NodeJS.ProcessEnv = process.env,
): BackendLaunchProfile {
  if (launcher === 'desktop') {
    return {
      launcher,
      assembly: { toolRegistry: 'full', promptVersion: true, collab: true, sessionSkills: true, pets: true },
      /*
       * 日志进 `app.jsonl`(施工单 §2.3「行为变化」表的推荐:后端是同一种进程,与 CLI 同名)。终端回显关掉:
       * 拉起它的人把 stdout 接成管道,回显每行都写进去,没人读就会写满、把这个进程卡在 `write` 上。
       * 剩下那几处启动期直写 stderr 的 FATAL 是一两行,由拉起者读走当作「为什么没起来」。
       */
      logging: { fileBaseName: 'app', src: 'server', consoleEcho: false },
      discoveryOwner: 'backend',
      // 活动监视器里能和桌面主进程分开(两者是同一只二进制)。
      processTitle: 'onething-backend',
      // 有窗口答卡:与桌面进程内那句 `registerACPPermissionBridge()` 同口径。
      acpUnanswered: 'wait',
      // 桌面没有注入客户端宿主时 `MCPManager` 用的就是这一种;server runtime 装它而不是 `DisabledServerMCPClient`。
      mcpClientFactory: createNativeMCPClient,
      loginShellEnv: true,
      speechOutput: true,
      userSchedulerTasks: true,
      music: true,
      modelRegistryRefresh: true,
    }
  }
  // `none`、不设、以及今天的 `cli`(批 3 再定义它):`server:start` 那一档。
  return {
    launcher,
    assembly: {
      // User decision (2026-07-25): web/server tools ship with desktop parity by default;
      // ONETHING_SERVER_TOOLS=readonly degrades to zero-side-effect tools for exposed deployments.
      toolRegistry: env.ONETHING_SERVER_TOOLS === 'readonly' ? 'readonly' : 'full',
      sessionSkills: true,
      // 宠物宿主(`docs/design/pet-system-2026-09.md` §9.1):浏览器壳连 server 时栖位照样有 `pet:` 可读。
      pets: true,
    },
    logging: { fileBaseName: 'server', src: 'server', consoleEcho: 'pretty' },
    discoveryOwner: 'server',
    processTitle: null,
    acpUnanswered: 'reject',
    mcpClientFactory: undefined,
    loginShellEnv: false,
    speechOutput: false,
    userSchedulerTasks: false,
    music: false,
    modelRegistryRefresh: false,
  }
}

// ── 装配用的几格 ──────────────────────────────────────────────────────────

/**
 * 宿主表里随档位变的两格。
 *
 * `storePath`:`ONETHING_RESOURCES_PATH` 设了 = 打包态的资源目录(内建 skills / templates / docs 在它下面),
 * 于是答 `{ isPackaged: true, resourcesPath }`;没设 = `{}`,与批 2a 之前逐字相同。开发态桌面今天递的是
 * `{ isPackaged: false, resourcesPath }`,而 `isPackaged` 为假时 `resourcesPath` 一处都不读,所以拉起者
 * 只在打包态设这个变量(决策见 `docs/design/backend-structure-decisions-2026-10.md`)。
 *
 * `speechOutput`:桌面档由后端自己交一只进程出声器(`voice` 的 `createProcessSpeechOutput`,与桌面宿主表
 * 交的是同一只);缺省档照旧 `null`。
 */
export function launchHostPorts(
  profile: BackendLaunchProfile,
  env: NodeJS.ProcessEnv = process.env,
): Pick<OnethingHostPorts, 'storePath' | 'speechOutput'> {
  const resourcesPath = env.ONETHING_RESOURCES_PATH
  return {
    storePath: resourcesPath ? { isPackaged: true, resourcesPath } : {},
    speechOutput: profile.speechOutput ? createProcessSpeechOutput() : null,
  }
}

/**
 * 登录 shell 的 PATH(桌面档)。进程入口在**装配之前**起它、与装配并行跑,在装配跑完、`acp.start()` 之前等它
 * (`createRealServerBackend` 里那一行)—— ACP 起名册时就按 PATH 判「装没装」并在后台起 `<agent> --version`,
 * MCP stdio 更晚(建 runtime 时),bash 工具再晚。判词与 Electron 主进程那一处同源(`process-env/process-env-login-shell.ts`
 * 文件头:Electron 也是在起 ACP / MCP 之前等它)。永不 reject:补不上只记一行,照旧起。
 */
export function prepareProcessEnv(profile: BackendLaunchProfile): Promise<void> {
  if (!profile.loginShellEnv) return Promise.resolve()
  return hydrateProcessEnvFromLoginShell({ logger: getLogger('backend.env') }).then(() => undefined, () => undefined)
}

// ── 装配之后起的服务 ──────────────────────────────────────────────────────

/**
 * 起这个档位要的三件(登录 shell 在装配时并行、MCP 由 server runtime 起、ACP 由 `createRealServerBackend` 起,
 * 都不在这里)。与桌面 `main.ts` 的 `startPostWindowServices` 同一张单子、同一个次序、同一个 `own()` 标签;
 * 任何一件失败都不挡进程起来,只记一行。返回起了哪几件,给进程入口记日志。
 */
export function startLaunchServices(backend: OnethingBackend, profile: BackendLaunchProfile): string[] {
  const log = getLogger('backend.launch')
  const started: string[] = []
  if (profile.userSchedulerTasks) {
    // 同步的:读一次盘、往调度器里注册,交回 stop。
    try {
      backend.own(initializeUserSchedulerTasks(), 'userSchedulerTasks', 'quiesce')
      started.push('userSchedulerTasks')
    } catch (error) {
      log.error('subsystem startup failed', { subsystem: 'scheduler', blocking: false }, error)
    }
  }
  if (profile.music) {
    // 电台指挥与 now-playing 观察者;收尾归音乐子系统自己的 `drain()`(装配时已 `own`)。
    try {
      backend.music.start()
      started.push('music')
    } catch (error) {
      log.error('subsystem startup failed', { subsystem: 'music', blocking: false }, error)
    }
  }
  if (profile.modelRegistryRefresh) {
    const refreshController = new AbortController()
    backend.own(() => refreshController.abort(), 'modelRegistryRefresh', 'quiesce')
    void backend.runTask('backend:model-registry', () => refreshModelsOnFirstStartup(refreshController.signal)).catch((error: unknown) => {
      if (refreshController.signal.aborted && (error === refreshController.signal.reason || (error as Error)?.name === 'AbortError')) {
        log.debug('model registry refresh cancelled during shutdown')
      } else log.error('subsystem startup failed', { subsystem: 'model-registry', blocking: false }, error)
    })
    started.push('modelRegistryRefresh')
  }
  return started
}

/**
 * 首次启动从 models.dev 拉一次模型目录(已有目录就跳过)。与 `apps/desktop-react/electron/main.ts` 那份逐句相同;
 * 批 2b 桌面不再进程内装配时,那一份随 `startPostWindowServices` 一起删掉。
 */
async function refreshModelsOnFirstStartup(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  const providers = getSettings()?.ai?.providers
  if (!providers) return
  const hasModels = Object.values(providers).some(
    config => Object.keys((config as { models?: object })?.models ?? {}).length > 0,
  )
  if (hasModels) return
  await modelRegistry.refreshAllProviders({ signal })
}
