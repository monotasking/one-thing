/**
 * K5-a —— 一台已连接的外部 server → 一份资源自述
 * (`docs/design/atom-2026-09.md` §3「MCP 客户端」那一行:「外部资源进来 —— 工具表
 * → 自动投影成一个 scheme 的 ops(读法与事件为空,手工补)」;§9 分期 K5「外部」)。
 *
 * ## 它是一只纯函数,不是一台机器
 *
 * 进去的是「这台 server 叫什么、它报了哪些工具」,出来的是一份 `ResourceSpec` 加
 * 一张「op 名 → 这台 server 上真正的工具名」的对照表。连接、重连、断开、寿命全不
 * 在这里 —— 那些是装配层 `backend/wiring/resource/mcp-mount.ts` 的事(§10.2:
 * 外部提供者的寿命 = 连接期)。分开的理由是它俩的可测性完全不同:投影可以拿一张
 * 工具表当场断言,寿命要一台会连会断的假 server。
 *
 * 自述住在产品层,实现住在装配层 —— 与 `music` / `sessions` / `files` 三份逐字同
 * 一条纪律。差别只在这一份是**算出来的**:一台 server 的工具表随时会变,所以它是
 * 一只函数而不是一个字面量,而「变了要重投」由 `fingerprint` 那一格说出口。
 *
 * ## 三条归一,每一条都是因为两套字母表对不上
 *
 * ① **scheme**:`mcp-<server id 归一>`。server id 是用户在设置里填的、或者
 *    `createCoreId()` 生成的,两者都可能带大写 / 下划线 / 中文,而 scheme 语法是
 *    `[a-z][a-z0-9-]*`(`core/resource/ref.ts`)。归一那一只住在内核里
 *    (`normalizeSchemeSegment`),这里只负责加前缀。
 * ② **op 名**:成员名语法是 lowerCamelCase(`core/resource/contract.ts` 的
 *    `MEMBER_NAME_PATTERN`),而 MCP 的工具名一律是 `brave_web_search` /
 *    `get-library-docs` 这种。所以 `brave_web_search` → `braveWebSearch`,而**真正
 *    的工具名要留着**(调用时用的是它)—— 那就是 `toolNames` 那张表存在的理由。
 * ③ **撞名**:归一是多对一的(`get_docs` 与 `get-docs` 归一成同一个),两边都是
 *    真实存在的工具,丢掉一个不是选项。判据借内核那只 `uniqueName`,不自己写。
 *
 * ## 为什么读法与事件是空的
 *
 * §3 那一行的原话就是「读法与事件为空,手工补」。MCP 的 `resources/*` 与
 * `prompts/*` 两族能力**不是**这里的 `reads`:那两族有自己的地址空间(`uri`)、
 * 自己的订阅语义,把它们硬折成资源自述的读法是一次没有人验收过的语义翻译。今天
 * 这份投影只回答一句话:**这台 server 能做什么**。补读法与状态的口在文件末尾。
 */

import type { JsonSchema, ResourceSpec } from '@onething/core/resource'
import { normalizeSchemeSegment, isRefScheme, uniqueName } from '@onething/core/resource'
import type { MCPToolInfo } from '@onething/core/mcp'

/**
 * 投影出来的 scheme 的前缀。
 *
 * 前缀存在的理由有两个,都是硬的:①外部 id 归一之后可能以数字开头,而 scheme 的
 * 首字符必须是字母 —— 前缀这个字母把它补上;②它让这一族命名空间与内置的
 * (会话 / 目录 / 音乐)在地址上一眼分得开,而且**结构上撞不上** —— 内置的没有
 * 一个带这个前缀。
 */
export const MCP_RESOURCE_SCHEME_PREFIX = 'mcp-'

/**
 * 单例地址的路径部分:`mcp-<id>:server`。
 *
 * 一台 server 就是一个实例,没有第二个可指。它仍然要有一段路径,因为 `parseRef`
 * 拒绝空路径(`scheme:` 是**前缀**不是地址)——「一种资源只有一个实例」与「这种
 * 资源不需要地址」是两回事,后者在这套地址系统里不成立。
 *
 * 调用方**可以不给** ref(`plan` 那一侧按缺席补它);给了别的路径是一次真的说错
 * 了地址,不是可以静默忽略的多余参数 —— 与 `music` 那两个单例同一条判据。
 */
export const MCP_RESOURCE_SINGLETON_PATH = 'server'

/** 一台 server 投影出来的全部东西。 */
export interface McpResourceProjection {
  readonly scheme: string
  readonly spec: ResourceSpec
  /**
   * op 名 → 这台 server 上真正的工具名。
   *
   * 它不在 `spec` 里,因为自述是给**所有出口**读的公开契约,而这张表只有实现用
   * 得上(`apply` 拿它去 `callTool`)。把实现的私事挂在公开契约上,下一个出口就会
   * 开始读它。
   */
  readonly toolNames: ReadonlyMap<string, string>
  /**
   * 这份自述的指纹。**工具表变了就换一个** —— 装配层拿它当「要不要重挂」的判据
   * (§10.2「已登记」那一行:自述随工具表变化重投,先注销再登记)。
   *
   * 只按**投影出来的东西**算(标题 + 每条做法的名字 / 标题 / 参数契约),不按原始
   * 工具表算:一台 server 把工具描述里的空格改了一个,投影出来的自述逐字相同,那
   * 就不该把一个正在被调用的命名空间摘掉再装回去。
   */
  readonly fingerprint: string
}

export interface McpResourceProjectionInput {
  /** 已经分配好的 scheme(见 {@link mcpResourceScheme})。 */
  readonly scheme: string
  /** 给人看的名字。设置里那台 server 的 `name`,空就退回它的 id。 */
  readonly title: string
  readonly tools: readonly MCPToolInfo[]
}

/**
 * 一台 server 的 id → 一个合法且不撞名的 scheme。归一之后什么都没剩下 → `null`
 * (调用方该跳过这一台并说出来,而不是替它编一个名字)。
 *
 * `taken` 是**这一轮已经分配出去的** scheme 集合。调用方按一个稳定的次序(server
 * id 的字典序)逐台要名字,于是同一份 server 名单永远得到同一份分配 —— 一个会随
 * 连接完成顺序变的地址,是没法写进快捷键、deeplink 或者一句话里的。
 */
export function mcpResourceScheme(serverId: string, taken: ReadonlySet<string> = new Set()): string | null {
  const segment = normalizeSchemeSegment(serverId)
  if (!segment) return null
  const base = `${MCP_RESOURCE_SCHEME_PREFIX}${segment}`
  // 前缀补了首字母,归一保证了其余字符 —— 所以这一句今天不可能红。留着是因为
  // scheme 语法是内核的、前缀是这里的,两边各改各的那天,红在登记之前比红在
  // `registry.register` 里更容易看懂。
  if (!isRefScheme(base)) return null
  return uniqueName(base, taken, '-')
}

/**
 * 一个 MCP 工具名 → 一个合法的 op 名(lowerCamelCase)。
 *
 * 切分只按「非字母数字」切,不拆已有的驼峰:`getLibraryDocs` 进来还是
 * `getLibraryDocs`,`brave_web_search` 进来是 `braveWebSearch`。开头的数字会被丢掉
 * (`2fa_check` → `faCheck`),因为成员名的首字符必须是字母 —— 丢掉的那一位由
 * `toolNames` 那张表兜着(调用用的是原名),真撞了名由 `uniqueName` 兜着。
 *
 * 一个字母数字都没有的工具名 → `null`,那只工具不进这份投影。
 */
export function mcpResourceOpName(toolName: string): string | null {
  const parts = toolName.split(/[^A-Za-z0-9]+/).filter(part => part.length > 0)
  if (parts.length === 0) return null
  const joined = parts
    .map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('')
  const trimmed = joined.replace(/^[^A-Za-z]+/, '')
  if (trimmed.length === 0) return null
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1)
}

/** 标题最长这么多字。一句超长的工具描述会把命令面板与权限卡撑变形。 */
const TITLE_LIMIT = 160

/**
 * 一句人话:工具描述的**第一句**,没有描述就退回工具名。
 *
 * 第一句而不是整段:自述里的 `title` 是给命令面板一行、给权限卡一个抬头、给
 * `resources describe` 一行用的。整段说明模型仍然拿得到 —— 它在 `params` 契约里
 * (MCP 的 inputSchema 自带每个参数的 description),而不在这一行。
 */
function firstSentence(text: string | undefined, fallback: string): string {
  const trimmed = (text ?? '').trim()
  if (trimmed.length === 0) return fallback
  const match = /^[\s\S]*?[.。!!??\n]/.exec(trimmed)
  const head = (match ? match[0] : trimmed).trim()
  const sentence = head.length > 0 ? head : trimmed
  return sentence.length > TITLE_LIMIT ? `${sentence.slice(0, TITLE_LIMIT - 1)}…` : sentence
}

const EMPTY_PARAMS: JsonSchema = { type: 'object', properties: {} }

/**
 * 一台已连接的 server → 一份自述。
 *
 * 每条做法:`effects: ['mcp']`(与 `McpTool` 声明的**同一个**效果类 —— 权限只认
 * 效果,两条路对同一台 server 说的必须是同一句话)、`home: 'core'`(客户端住在
 * 引擎进程里)、`params` 就是那只工具自己的 `inputSchema`(不翻译、不补默认:
 * 那份契约的解释权归 server)。
 *
 * `exposure.aiTool: false`:**AI 走 `McpTool`,这一 scheme 服务的是 RPC / CLI /
 * 插件 / MCP 出口那四条路。** MCP 的工具今天已经以 `McpTool` 进了工具目录给模型
 * 用;资源投影再进目录,模型面上就是同一件事两只工具(两个名字、两张权限卡,而
 * 模型会两条都试)。元工具 `resources` 的 `list` 照列它 —— 它确实是一种资源。
 */
export function projectMcpResource(input: McpResourceProjectionInput): McpResourceProjection {
  const ops: Record<string, ResourceSpec['ops'][string]> = {}
  const toolNames = new Map<string, string>()
  const used = new Set<string>()

  // 按工具名排序:自述会进 `resources describe` 与将来的 MCP 出口,而那些是提示词
  // 的一部分。让顺序取决于 server 报表的顺序 = 同一台 server 两次连接换一份前缀
  // (`core/resource/schema.ts` 的同一条理由)。
  for (const tool of [...input.tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const base = mcpResourceOpName(tool.name)
    if (!base) continue
    const name = uniqueName(base, used)
    used.add(name)
    toolNames.set(name, tool.name)
    ops[name] = {
      title: firstSentence(tool.description, tool.name),
      params: (tool.inputSchema as JsonSchema | undefined) ?? EMPTY_PARAMS,
      effects: ['mcp'],
      home: 'core',
    }
  }

  const spec: ResourceSpec = {
    scheme: input.scheme,
    title: input.title,
    // §3:读法与事件为空。补它们的口写在文件头。
    reads: {},
    ops,
    events: {},
    exposure: { aiTool: false },
  }

  const fingerprint = JSON.stringify([
    input.title,
    [...toolNames].map(([name, toolName]) => [name, toolName, ops[name].title, ops[name].params]),
  ])

  return { scheme: input.scheme, spec, toolNames, fingerprint }
}

/*
 * ── 留账:手写自述怎么覆盖自动投影 ────────────────────────────────────────────
 *
 * §3 那一行的原话是「读法与事件为空,**手工补**」。今天没有那个口,而这是自觉的:
 * 补的形状有两种,选错一种要付重写的代价。
 *
 *   (a) **合并式**:同一 scheme 交一份手写的 `{ reads, events, state }`,与自动投影
 *       出来的 `ops` 合并。好处是工具表变了不用改手写那半;代价是「谁赢」要逐格
 *       定(手写的 op 能不能盖掉同名的自动 op?),而那是一张会长的表。
 *   (b) **接管式**:手写一份完整的 `ResourceSpec`,自动投影退位。好处是判据只有
 *       一条;代价是那台 server 加一只工具,手写那份不会自己长出来。
 *
 * 判据不该由施工者拍。真正需要它的场景出现之前(某台 server 的 `resources/*` 要
 * 被投影成读法),这里保持一句话:**投影是全自动的,没有覆盖口。**
 */
