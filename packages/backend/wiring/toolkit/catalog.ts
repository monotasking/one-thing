/**
 * R2a/R3a —— 三档目录的装配(§6 的 `app/toolkit/`)。
 *
 * 与旧 `app/tools/builtin/{index,headless,readonly}.ts` **一一对应**:三档的 id
 * 集合逐一相等,有测试钉着(`__tests__/catalog-tiers.test.ts` 把旧三个 barrel 的
 * `registerTool` 收集下来直接比)。
 *
 * 适配器的来源与旧 `app/tools/builtin/*.ts` / `app/collab/*-tool.ts` **逐字相同**
 * (见 `adapters.ts`)。这里只 import 那些 store 与适配函数,一个旧 Tool 对象都不
 * import —— 新树的目录不该经过旧树。
 *
 * ## `feature_*` 为什么不在三档里
 *
 * 它们在旧树里也不在那三个 barrel 里:自进化三件套由 `self-evolution` **feature**
 * 自己注册(吃自己狗粮 —— 自进化能力如果走特权路进内核,它证明的就不是"feature
 * 基座够用")。新树保持同一条纪律:`registerFeatureTools(catalog, runtime)` 是一个
 * 独立入口,而**宿主档门**同样保留 —— 判据不是"是不是桌面",而是一句可证的等价
 * 陈述:挂载一个 feature 与跑一条 shell 是同一量级的能力,所以目录里没有 `bash`
 * 的宿主(readonly 档)一个字都不注册。**默认拒绝**。
 */

import { Catalog } from '@onething/core/toolkit'
import {
  createAskUserTool,
  createBashTool,
  createBoardTool,
  createEditTool,
  createGoalTool,
  createHistoryTool,
  createNotebookTool,
  createPracticeTool,
  createRadioTool,
  createReadTool,
  createSearchTool,
  createSendMessageTool,
  createTaskTool,
  createTimeTool,
  createVariableTool,
  createWebOpenTool,
  createWebSearchTool,
  createWriteTool,
  type AskUserToolAdapters,
  type BashToolAdapters,
  type BoardToolAdapters,
  type GoalToolAdapters,
  type HistoryToolAdapters,
  type MutatingFileToolAdapters,
  type NotebookToolAdapters,
  type PracticeToolAdapters,
  type RadioToolAdapters,
  type ReadToolAdapters,
  type SendMessageToolAdapters,
  type TaskToolPorts,
  type VariableToolAdapters,
  type WebOpenToolAdapters,
  type WebSearchToolAdapters,
} from '@onething/runtime/toolkit'
import { getSettings } from '../../stores/settings.js'
import { getConnectedDirectoriesForSession } from '../../stores/connected-directories.js'
import {
  getOnethingFileMutationsDir,
  getOnethingToolOutputsDir,
} from '@onething/runtime/storage'
import { getDefaultReadRoots } from '../tools/core/sandbox.js'
import { createLocalBashOperations } from '@onething/runtime/tools/bash-executor'
import { getGuardedVariableRegistryForTools, VariableError } from '../variables/index.js'
import {
  askUserAdapters,
  boardAdapters,
  goalAdapters,
  historyAdapters,
  notebookAdapters,
  practiceAdapters,
  radioAdapters,
  sendMessageAdapters,
  taskPorts,
  webOpenAdapters,
  webSearchAdapters,
} from './adapters.js'
import { createFeatureInspectTool } from './builtin/feature-inspect.js'
import { createFeatureMountTool } from './builtin/feature-mount.js'
import { createFeatureUnmountTool } from './builtin/feature-unmount.js'
import { FeatureToolRuntime } from './builtin/feature-runtime.js'

function defaultWorkingDirectory(): string | undefined {
  return getSettings().tools?.bash?.defaultWorkingDirectory
}

/** 每次现取:用户可以在应用跑着的时候收紧它,下一条命令就该照新的来。 */
function configuredEnvAllowlist(): string[] | null {
  const allowlist = getSettings().tools?.bash?.envAllowlist
  return Array.isArray(allowlist) ? allowlist : null
}

function configuredShellPath(): string | undefined {
  const bash = getSettings().tools?.bash
  return bash && 'shellPath' in bash && typeof bash.shellPath === 'string' ? bash.shellPath : undefined
}

export function readAdapters(): ReadToolAdapters {
  return {
    getDefaultWorkingDirectory: defaultWorkingDirectory,
    /**
     * 读根里的接入目录按**会话归属的 space** 解析(批 B2)。走这里而不是全局适配器:
     * 那份适配器服务的是没有会话语境的调用面,退回全局层对它是对的。
     */
    getDefaultReadRoots: sessionId => getDefaultReadRoots({
      getConnectedDirectories: () => getConnectedDirectoriesForSession(sessionId),
    }),
  }
}

export function mutatingFileAdapters(): MutatingFileToolAdapters {
  return {
    getDefaultWorkingDirectory: defaultWorkingDirectory,
    getFileMutationsDir: getOnethingFileMutationsDir,
    // per-space:按**会话归属**取,不是当前空间(批 B2 / 设计盲点 1)。
    getConnectedDirectories: sessionId => getConnectedDirectoriesForSession(sessionId),
  }
}

export function bashAdapters(): BashToolAdapters {
  return {
    getDefaultWorkingDirectory: defaultWorkingDirectory,
    getToolOutputsDir: getOnethingToolOutputsDir,
    getShellPath: configuredShellPath,
    getConnectedDirectories: sessionId => getConnectedDirectoriesForSession(sessionId),
    createOperations: options => createLocalBashOperations({
      ...options,
      envAllowlist: configuredEnvAllowlist(),
    }),
  }
}

export function variableAdapters(): VariableToolAdapters {
  return {
    // Guarded facade:外部身份的会话(网关 IM / API)不能通过工具读写全局效果变量。
    getRegistry: getGuardedVariableRegistryForTools,
    isVariableError: error => error instanceof VariableError,
  }
}

export interface CatalogAdapters {
  readonly read?: ReadToolAdapters
  readonly mutatingFile?: MutatingFileToolAdapters
  readonly bash?: BashToolAdapters
  readonly variable?: VariableToolAdapters
  readonly webSearch?: WebSearchToolAdapters
  readonly webOpen?: WebOpenToolAdapters
  readonly goal?: GoalToolAdapters
  readonly task?: TaskToolPorts
  readonly askUser?: AskUserToolAdapters
  readonly practice?: PracticeToolAdapters
  readonly radio?: RadioToolAdapters
  readonly sendMessage?: SendMessageToolAdapters
  readonly board?: BoardToolAdapters
  readonly history?: HistoryToolAdapters
  readonly notebook?: NotebookToolAdapters
}

function resolve(adapters: CatalogAdapters): Required<CatalogAdapters> {
  return {
    read: adapters.read ?? readAdapters(),
    mutatingFile: adapters.mutatingFile ?? mutatingFileAdapters(),
    bash: adapters.bash ?? bashAdapters(),
    variable: adapters.variable ?? variableAdapters(),
    webSearch: adapters.webSearch ?? webSearchAdapters(),
    webOpen: adapters.webOpen ?? webOpenAdapters(),
    goal: adapters.goal ?? goalAdapters(),
    task: adapters.task ?? taskPorts(),
    askUser: adapters.askUser ?? askUserAdapters(),
    practice: adapters.practice ?? practiceAdapters(),
    radio: adapters.radio ?? radioAdapters(),
    sendMessage: adapters.sendMessage ?? sendMessageAdapters(),
    board: adapters.board ?? boardAdapters(),
    history: adapters.history ?? historyAdapters(),
    notebook: adapters.notebook ?? notebookAdapters(),
  }
}

/**
 * 桌面全量档(`toolRegistry: 'full'`)—— 与旧 `builtin/index.ts` 同集(17 只)。
 *
 * 注册 ≠ 呈现:这里永远是全量的,「这一回合看得见谁」由 `Surface.resolve` 用
 * 每只工具自己的 `visibleIn(scene)` 算(协作四件套的场子、goal 的 active、
 * task 的套娃闸)。
 */
export function createDesktopCatalog(adapters: CatalogAdapters = {}): Catalog {
  const resolved = resolve(adapters)
  return new Catalog()
    .register(createBashTool(resolved.bash))
    .register(createEditTool(resolved.mutatingFile))
    .register(createReadTool(resolved.read))
    .register(createWriteTool(resolved.mutatingFile))
    .register(createVariableTool(resolved.variable))
    .register(createRadioTool(resolved.radio))
    .register(createPracticeTool(resolved.practice))
    .register(createTaskTool(resolved.task))
    .register(createAskUserTool(resolved.askUser))
    .register(createTimeTool())
    /*
     * S6 `search`(检索重建 §14.3)。**它不收适配器** —— 从进程单槽里现拿。
     *
     * 这一格是必须的,不是偷懒:装配里目录建在缝 4(`buildToolkitCatalog`),而检索
     * 服务起在缝 4.5(`createAppSearchService`)—— 目录建好的那一刻适配器还没装。
     * 工具的 `spec` 是个 getter、描述里的 kind 清单每次现算,所以回合真正取面时
     * 拿到的是**那时**的注册表。构造期抓一份就会永远印一张空清单。
     */
    .register(createSearchTool())
    .register(createWebSearchTool(resolved.webSearch))
    .register(createWebOpenTool(resolved.webOpen))
    .register(createGoalTool(resolved.goal))
    .register(createBoardTool(resolved.board))
    .register(createHistoryTool(resolved.history))
    .register(createNotebookTool(resolved.notebook))
    .register(createSendMessageTool(resolved.sendMessage))
}

/** CLI daemon 档 —— 与旧 `builtin/headless.ts` 同集(11 只)。 */
export function createHeadlessCatalog(adapters: CatalogAdapters = {}): Catalog {
  const resolved = resolve(adapters)
  return new Catalog()
    .register(createBashTool(resolved.bash))
    .register(createEditTool(resolved.mutatingFile))
    .register(createReadTool(resolved.read))
    .register(createWriteTool(resolved.mutatingFile))
    .register(createVariableTool(resolved.variable))
    .register(createBoardTool(resolved.board))
    .register(createHistoryTool(resolved.history))
    .register(createSendMessageTool(resolved.sendMessage))
    .register(createTimeTool())
    .register(createSearchTool())
    .register(createWebSearchTool(resolved.webSearch))
    .register(createWebOpenTool(resolved.webOpen))
}

/**
 * 降级档(`ONETHING_SERVER_TOOLS=readonly`)—— 与旧 `builtin/readonly.ts` 同集
 * (4 只):对本机零副作用的工具。没有 bash / write / edit,也没有 variable
 * (它能重指工作目录)。
 */
export function createReadonlyCatalog(adapters: CatalogAdapters = {}): Catalog {
  const resolved = resolve(adapters)
  return new Catalog()
    .register(createReadTool(resolved.read))
    .register(createTimeTool())
    // 零副作用 —— 降级档也给(§14.3)。它读的是本机索引,而这一档的判据是「对本机
    // 零副作用」,不是「不碰本机数据」(`read` 也在这一档里)。
    .register(createSearchTool())
    .register(createWebSearchTool(resolved.webSearch))
    .register(createWebOpenTool(resolved.webOpen))
}

export type ToolCatalogTier = 'full' | 'headless' | 'readonly'

export function createCatalogForTier(tier: ToolCatalogTier, adapters: CatalogAdapters = {}): Catalog {
  if (tier === 'full') return createDesktopCatalog(adapters)
  if (tier === 'readonly') return createReadonlyCatalog(adapters)
  return createHeadlessCatalog(adapters)
}

/**
 * 自进化三件套。与旧树同一条纪律:**不进那三个 barrel**,由 self-evolution
 * feature 在 `mount` 时调用一次。
 *
 * 宿主档门:目录里没有 `bash` 就一个字都不注册(判据同旧 `hasTool('bash')`)。
 * 返回的注销函数对位旧实现里那三个 `ctx.registerDisposer(...)` —— 卸载时先清扫
 * 动态 feature、再摘工具,顺序由调用方保证(旧实现靠注册顺序拿到)。
 */
export function registerFeatureTools(
  catalog: Catalog,
  runtime: FeatureToolRuntime = new FeatureToolRuntime(),
): { runtime: FeatureToolRuntime; registered: boolean; unregister(): void } {
  if (!catalog.has('bash')) return { runtime, registered: false, unregister: () => {} }

  catalog.register(createFeatureMountTool(runtime))
  catalog.register(createFeatureUnmountTool(runtime))
  catalog.register(createFeatureInspectTool(runtime))
  return {
    runtime,
    registered: true,
    unregister() {
      catalog.unregister('feature_mount')
      catalog.unregister('feature_unmount')
      catalog.unregister('feature_inspect')
    },
  }
}

export { FeatureToolRuntime }
