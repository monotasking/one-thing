/**
 * 宿主端口的**聚合**(方案 `docs/design/backend-composition-root-2026-09.md` 的 A1)。
 *
 * 施工前的事实:一个宿主要接的 Electron 独有能力散在自己代码的十几个地方,靠
 * "记得调"来保证 —— 漏一个的症状不是编译错,是运行时某件能力**静默变成降级路**
 * (React 壳漏 `configureSkillsEnvironmentHost` 就是这样:技能目录在打包态找不到,
 * 没有任何一行报错)。
 *
 * 这个文件把那些端口收成**一张必填的表**:每一项都要写,没有那件能力就显式写
 * `null`。于是"这个宿主没接语音"从一件看不见的事,变成 `voice: null` 这一行代码;
 * 而漏写一项是 `tsc` 错误,不是运行期的谜。
 *
 * **`null` 不是新的降级行为**:`applyHostPorts` 对 `null` 的项**不调**对应的
 * `configure*`,于是那个端口保持"从未注入"的状态 —— 也就是今天那些宿主的实际
 * 处境,一字不差。这份聚合只改"谁来调",不改"不调会怎样"。
 *
 * **不进聚合的 `configure*`**(方案 §2.3):
 *  · `configureApp*` 那 11 个内部适配绑定(装配层自己指向自己,不是宿主能力);
 *  · `configureServer*Port` 三个 server 专用槽;
 *  · `configureLogging` —— 宿主在装配**之前**调,它产生日志文件与 janitor,
 *    寿命比 backend 长,归宿主(注意与 `logging` 这一格的区别:那一格是
 *    `configureAppLoggingHost`,只是把宿主的两件采集能力递进来);
 *  · `configureGlobalWindowShortcuts` / `configureBrowserWindowProvider` /
 *    `configureDeepLinkService` / `configureVoiceTray` / `configurePluginAppVersion`
 *    —— 窗口系统与壳自己的东西,归壳。
 */
import { configureStorePathHost, type StorePathHost } from './stores/docs-paths.js'
import { configureSandboxHost, type SandboxHost } from './wiring/tools/core/sandbox.js'
import { configureAppLoggingHost, type AppLoggingHostPorts } from './wiring/logging/index.js'
import {
  configureSkillsEnvironmentHost,
  type SkillsEnvironmentHostPorts,
} from './wiring/skills/loader.js'
import { configureTodoPlanHost, type TodoPlanHostPorts } from './wiring/todo-plan/store.js'
import { configurePluginsHost, type PluginsHostPorts } from './wiring/plugins/host-ports.js'
import { configureGatewayHost, type GatewayHostPorts } from './wiring/gateway/host-ports.js'
import { configureSettingsHost, type SettingsHostPorts } from './wiring/settings/host-ports.js'
import { configureEvalsHost, type EvalsHostPorts } from './wiring/evals/host-ports.js'
import { configureAuthHost, type AuthHostPorts } from '@onething/runtime/auth/host-ports'
import { configureShellHost, type ShellHostPorts } from '@onething/runtime/shell/host-ports'
import { configureVoiceHost, type VoiceHostPorts } from '@onething/runtime/voice/host-ports.wiring'
import {
  configureTerminalBroadcaster,
  type TerminalHostPorts,
} from '@onething/runtime/terminal/service.wiring'
import {
  configureScratchpadHost,
  type ScratchpadHostPorts,
} from '@onething/runtime/scratchpad/service-bound'
import { configureMCPClientHost } from '@onething/runtime/mcp/manager'
import { configureMCPClientIdentity } from '@onething/runtime/mcp/identity'
import type { MCPClientFactory, MCPClientLike } from '@onething/core/mcp'

/**
 * 两件不可 `null` 的端口形状顺手再导出一次:宿主要声明"我记下来的那份是什么"
 * 时(桌面的 `electronStorePathHost` / `electronSandboxHost`)读的就是这里,
 * 免得为了一个类型去 import 两个实现模块。
 */
export type { StorePathHost, SandboxHost }

/**
 * MCP 那一格是两件事,所以单独一层:
 *  · `clientFactory: null` = 用内置 `MCPClient`(今天的缺省)。只有 server 那种
 *    要把 stdio 关掉的宿主才会给一个自己的工厂。
 *  · `identity` = clientInfo 的名字与版本。版本只有宿主知道(打包后 package.json
 *    不在可预测的相对位置),`null` = 用产品默认。
 * 整格 `null` = 这个宿主不接 MCP,两件都走缺省。
 */
export interface McpHostPorts {
  clientFactory: MCPClientFactory<MCPClientLike> | null
  identity: { name?: string; version?: string } | null
}

/**
 * 一个宿主要交给装配层的**全部** Electron/宿主独有能力。
 *
 * `storePath` / `sandbox` 不可 `null`:没有它们连 store 与工具沙箱的边界都没法
 * 回答。两者的字段本身都是可选的,所以"这个宿主没有额外的话要说"写成 `{}` ——
 * 那正是 server / daemon / 冒烟探针今天的状态。
 */
export interface OnethingHostPorts {
  /** 打包资源目录(docs 目录的判定输入)。宿主无话可说时给 `{}`。 */
  storePath: StorePathHost
  /** 工具沙箱的路径面(downloads / home)。宿主无话可说时给 `{}`。 */
  sandbox: SandboxHost
  /** 凭证加密与 OAuth 取数。`null` = 没有加密能力(token 落盘明文,已有密文解不开)。 */
  auth: AuthHostPorts | null
  /** 日志的两件宿主采集能力(日志目录 / renderer console 兜底)。`null` = 都没有。 */
  logging: AppLoggingHostPorts | null
  /** 「用系统的方式打开一个东西」。`null` = 结构化降级。 */
  shell: ShellHostPorts | null
  /** 语音的窗口与托盘。`null` = 这个宿主没有语音。 */
  voice: VoiceHostPorts | null
  /**
   * 终端(真 PTY)的输出广播器。`null` = 这个宿主没有终端输出通道 ——
   * 于是 `terminal` 域一条都不给(方案 backend-transport-forks-2026-09 §2.1:
   * 只能写不能读的终端不如不开)。
   */
  terminal: TerminalHostPorts | null
  /** 技能目录在打包态的落点。`null` = 视为非打包。 */
  skillsEnvironment: SkillsEnvironmentHostPorts | null
  /** todo 变更广播 + 在文件管理器里定位。`null` = 不广播、不定位。 */
  todoPlan: TodoPlanHostPorts | null
  /** 草稿纸变更广播。`null` = 不广播。 */
  scratchpad: ScratchpadHostPorts | null
  /** 插件的原生文件对话框 + 命令子进程执行器。`null` = 结构化降级。 */
  plugins: PluginsHostPorts | null
  /** IM 网关的八件生命周期能力。`null` = 结构化降级。 */
  gateway: GatewayHostPorts | null
  /** 设置保存链上的三件宿主能力。`null` = 保存链自然退化。 */
  settings: SettingsHostPorts | null
  /** 评估仓的打包态判定。`null` = 视为非打包。 */
  evals: EvalsHostPorts | null
  /** MCP 客户端工厂与 clientInfo。`null` = 两件都走缺省。 */
  mcp: McpHostPorts | null
}

/**
 * 逐项交给现有的 `configure*` 函数。那些函数一个字没改 —— 变的只是不再由宿主
 * 各自直接调。
 *
 * **`null` 的项不调**:那些端口都是"最后一次调用说了算"的单槽,用 `{}` 顶一次
 * 等于把宿主早先注入的东西擦掉(桌面的 sandbox 就是在装配前由 ready 钩子注入的),
 * 所以"没有"必须是**不调**,不是"调一个空的"。
 */
export function applyHostPorts(host: OnethingHostPorts): void {
  configureStorePathHost(host.storePath)
  configureSandboxHost(host.sandbox)
  if (host.auth) configureAuthHost(host.auth)
  if (host.logging) configureAppLoggingHost(host.logging)
  if (host.shell) configureShellHost(host.shell)
  if (host.voice) configureVoiceHost(host.voice)
  if (host.terminal) configureTerminalBroadcaster(host.terminal.broadcaster)
  if (host.skillsEnvironment) configureSkillsEnvironmentHost(host.skillsEnvironment)
  if (host.todoPlan) configureTodoPlanHost(host.todoPlan)
  if (host.scratchpad) configureScratchpadHost(host.scratchpad)
  if (host.plugins) configurePluginsHost(host.plugins)
  if (host.gateway) configureGatewayHost(host.gateway)
  if (host.settings) configureSettingsHost(host.settings)
  if (host.evals) configureEvalsHost(host.evals)
  if (host.mcp) {
    // 工厂缺省是内置 `MCPClient`,而 `configureMCPClientHost(null)` 是一个**有意义
    // 的动作**(把别人装的工厂摘掉)。这里只在真给了工厂时调,不替宿主做那个决定。
    if (host.mcp.clientFactory) configureMCPClientHost(host.mcp.clientFactory)
    if (host.mcp.identity) configureMCPClientIdentity(host.mcp.identity)
  }
}
