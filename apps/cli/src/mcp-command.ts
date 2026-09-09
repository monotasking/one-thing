/**
 * `onething mcp` —— 原子的 **MCP 服务端出口**(K4-c,`docs/design/atom-2026-09.md`
 * §4 那张表的倒数第三行:「把在场的 scheme 投影成一个 MCP server,给 Claude Code /
 * 别的 agent 用 —— 这是『给 AI 用』的另一半:不只是这台的 AI,是任何 AI」)。
 *
 * ## 它是又一个出口,不是第二套实现
 *
 * 这只文件里**没有任何一个 scheme 的名字**,也没有一行业务:工具表是
 * `resource.list` + `resource.describe` 现算出来的,入参契约是内核那只
 * `toolInputSchemaOf`(与本机 AI 看到的**同一份 schema**),`tools/call` 转手给
 * `resource.do` / `resource.read`,返回体是 RPC 域那三只 `serialize*` 的投影经
 * `resource-command.ts` 的排版函数印出来的同一批字。接一个邮箱之后,外面的 agent
 * 当场多出一只 `mail` 工具 —— 这个文件一个字都不改,那正是 §8 陌生能力演练要的答案。
 *
 * 反面写法是在这里按 scheme 写一张工具表(`session_rename` / `dir_reveal` …),
 * 那就是把「加功能不许改骨架」当场作废。
 *
 * ## 它只认识 daemon 的四支,不直连 backend
 *
 * 桥走的是 `<store>/run/daemon.sock` 上的 `resource.{list,describe,read,do}` ——
 * **外面的 agent 拿不到任何一件 daemon 自己没有的能力**。从 `@onething/*` 静态拉
 * 进来的只有纯函数(`toolInputSchemaOf` / `toolDescriptionOf` / 还原函数 / 元工具
 * 自述)与日志门面,它们不碰引擎状态。
 *
 * ## 主体:`system:mcp:<clientName>`
 *
 * K4-b 把 daemon 的主体一律铸成 `localUserPrincipal()`,理由是「能连上 0600 的
 * socket 就已经是这台机器上的那个人」。**这条理由到 MCP 这里断了**:连 socket 的
 * 仍然是这台机器上的人,但**下指令的是外面那个 agent**。所以桥在 `initialize`
 * 之后拿 `clientInfo.name`,把每一次调用铸成 `{ kind:'system', component:
 * 'mcp:<name>' }` 递给 daemon;daemon 只收 `system` 这一支(见 `daemon-server.ts`
 * 的 `readOptionalSystemPrincipal`),`user` / `agent` 一律当场拒 —— 一个能自称
 * 「我是本机用户」的出口,等于把 K3-a' 那条「效果按主体定」的分档一次废掉。
 *
 * 后果是诚实的:`session` 的 `removeMessage` 对非用户主体顶格 `session_destructive`
 * (policy `ask`),而这条桥后面**没有人能答那张卡**。见下面 `DO_TIMEOUT_MS`。
 *
 * ## stdout 是协议信道,一个字都不许多
 *
 * MCP stdio 的约定:stdout 只走 JSON-RPC 帧,排障一律 stderr。所以这只子命令里
 * **`stdout()` 是禁用的**(整个文件没有一处),日志走 `getLogger` + 一只把记录写到
 * stderr 的 sink。刻意**不调 `configureLogging`**:它会落盘(要么与 daemon 抢同一个
 * `daemon.jsonl`,要么在 `log/` 里长出一个 janitor 不认识的新家族)、会装 janitor,
 * 而它默认打开的 `LegacyConsoleSink` patch 的正是 `process.stdout.write` —— 那会把
 * **每一帧协议字节**当成一条 `ns='console'` 记录抄一遍。
 */

import {
  RESOURCE_META_TOOL_ID,
  RESOURCE_OP_KEY,
  RESOURCE_READ_KEY,
  RESOURCE_REF_KEY,
  ResourceMetaTool,
  ResourceRegistry,
  toolDescriptionOf,
  toolInputSchemaOf,
} from '@onething/core/resource'
import { resourceSpecFromShell } from '@onething/backend/wiring/resource/index.js'
import { getLogger, getRootLogger } from '@onething/backend/wiring/logging/index.js'
import type {
  ListResourcesResponse,
  ResourceOutcomeView,
  ResourceReadView,
  SerializedResourceSpec,
} from '@shared/ipc/resources.js'
import type { DaemonResourcePrincipal } from '@shared/cli/protocol.js'
import {
  formatOutcomeView,
  formatReadView,
  formatResourceList,
  formatResourceSpec,
} from './resource-command.js'
import { stderr } from './stdout.js'

/** 服务器名。Claude Code 的 `mcp__<server>__<tool>` 里的中段。 */
export const MCP_SERVER_NAME = 'onething'

/**
 * 服务器版本。跟着 CLI 走,不跟着 MCP 协议走 —— `initialize` 的 `serverInfo`
 * 回答的是「你在跟哪一版 onething 说话」。
 */
export const MCP_SERVER_VERSION = '1.1.7'

/**
 * 一次 `do` 等多久才认输。
 *
 * 60 秒不是新拍的数,是 `HeadlessBackend.startPermissionTimeout` 那条既有降级的
 * 同一个数:守护进程里一张没人答的权限卡,60 秒之后自动拒。差别在于那条降级只
 * 装在 `chat.ask` 的活流上,资源调用没有流,于是这条桥自己数这 60 秒 —— 但它
 * **只能停止等待,答不了那张卡**(答卡是 `Permission.respond`,那是 core 的事,
 * 不是一条 CLI 桥该伸手的地方)。
 *
 * **K4-d 之后这一格是双保险,不再是唯一的止损**(那条留账已还):守护进程装配时
 * 声明自己无人值守(`markHostUnattended`),于是 `system` 主体的 ask 由
 * `packages/backend/wiring/tools/core/permission-policy.ts` 的 `unattendedHostBridge`
 * 在同样的 60 秒后经 `Permission.respond` **真的答掉**。两个 60 秒谁先跑赢由调度
 * 决定,而两种次序的结局都是对的:
 *  - 桥先超时 → 它回一句「需要审批,无人应答」,daemon 那边稍后把卡答掉,不留 pending;
 *  - 那边先答掉 → 这条 `do` 收到的是一个正常的 `denied` 结局,桥的计时器空转后清掉。
 * 桥这一格因此只解决「不无限等」,而「卡不留下」归被调用的那一侧 —— 判据放在
 * 被调方的同一条纪律(见 `readOptionalSystemPrincipal`)。
 */
export const DO_TIMEOUT_MS = 60_000

/** 超时那一支给外面 agent 的话。说清「为什么」,而不只是「超时了」。 */
const APPROVAL_UNAVAILABLE =
  'This action needs approval and nothing on this bridge can answer the prompt '
  + '(the daemon is headless — there is no window). Ask the person at the machine to run it, '
  + 'or use an action that needs no approval.'

/** 每只资源工具描述末尾那一句。带效果的自述才印 —— 没有效果就没有卡。 */
const APPROVAL_NOTE = `Note: actions listed with effects may need approval. ${APPROVAL_UNAVAILABLE}`

/** 这只文件用得到的那一格 daemon 客户端。窄到只剩 `request`,好让测试喂替身。 */
export interface McpDaemonClient {
  request<TData = unknown>(method: never, params?: unknown): Promise<TData>
}

/**
 * `clientInfo.name` → 主体。
 *
 * 客户端可以自称任何名字,所以这个字符串**不是身份证明**,它是审计上的一行落款
 * (`system:mcp:claude-code`)。真正的闸是「只能是 system 这一支」,那一条由 daemon
 * 判、不由这里判 —— 判据放在被调用的那一侧,才挡得住一个改过的桥。
 */
export function mcpPrincipalOf(clientName: string | undefined): DaemonResourcePrincipal {
  const name = clientName?.trim()
  return { kind: 'system', component: `mcp:${name && name.length > 0 ? name : 'unknown'}` }
}

/** MCP `tools/list` 里的一行。只用得到这四格,所以不吃 SDK 的 `Tool` 类型。 */
export interface McpToolListing {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
}

/** MCP `tools/call` 的返回体。同上,只用得到这两格。 */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function textResult(text: string, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

/**
 * 元工具那一行。
 *
 * 名字 / 标题 / 描述 / 入参 schema 全部读**本机那只 `ResourceMetaTool` 的 `spec`**,
 * 一个字面量都不抄:那只自述是在构造期算的、不看注册表里有什么,所以拿一张空表
 * 造一只元工具只为读它的自述,是合法的、也是唯一不产生第二份契约的写法。将来谁改
 * 了元工具的措辞或 schema,这条桥自动跟上。
 */
export function metaToolListing(): McpToolListing {
  const spec = new ResourceMetaTool(new ResourceRegistry()).spec
  return {
    name: spec.id,
    ...(spec.title ? { title: spec.title } : {}),
    description: spec.description,
    inputSchema: spec.input as unknown as Record<string, unknown>,
  }
}

/** 这份自述里有没有任何一条带效果的做法(= 有没有可能停在一张卡上)。 */
function declaresEffects(serialized: SerializedResourceSpec): boolean {
  return Object.values(serialized.ops ?? {}).some(op => (op.effects ?? []).length > 0)
}

/**
 * 一份自述 → 一只 MCP 工具。
 *
 * `resourceSpecFromShell`(`@onething/backend/wiring/resource`)在这里当**还原函数**用(投影 → 内核认的自述形),不是
 * 因为这份自述来自某扇壳:它是仓里唯一一份现成的还原,而再抄一份就是「同一份事实
 * 两份代码」—— 那正是这条设计线整篇在反对的东西。它会把每条做法的 `home` 盖成
 * `'shell'`,在这里**无害且不可见**:还原出来的 spec 只被 `toolInputSchemaOf` /
 * `toolDescriptionOf` 读,那两只函数一个字都不看 `home`;真正的 `home` 要报给外面
 * 的 agent 时读的是投影上那一格(见 `needsWindow`)。
 */
export function resourceToolListing(serialized: SerializedResourceSpec): McpToolListing {
  const spec = resourceSpecFromShell(serialized)
  const needsWindow = Object.values(serialized.ops ?? {}).some(op => op.home === 'shell')
  const lines = [toolDescriptionOf(spec), `Address every call with \`ref\`, e.g. \`${serialized.scheme}:<path>\`.`]
  if (needsWindow) lines.push('Some actions run in the app window; they fail here when no window is open.')
  if (declaresEffects(serialized)) lines.push(APPROVAL_NOTE)
  return {
    name: serialized.scheme,
    title: serialized.title,
    description: lines.join('\n\n'),
    inputSchema: toolInputSchemaOf(spec) as unknown as Record<string, unknown>,
  }
}

/**
 * 现算一次工具表。
 *
 * **每次 `tools/list` 都重算**,而不是启动时算一次再靠
 * `notifications/tools/list_changed` 通知变化 —— 因为 daemon 今天**没有资源事件的
 * 订阅口**:`DaemonClient.request` 的 `onEvent` 是绑在一次请求上的流事件
 * (`chat.ask` 用它推 token),方法表里没有 `resource.watch` 那样的长订阅。现算是
 * 诚实的次优解:会重新 list 的客户端总能看到最新的表,把表缓存住不再问的客户端
 * 看不到 —— 这一条写进了留账。
 */
export async function listResourceTools(client: McpDaemonClient): Promise<McpToolListing[]> {
  const request = <T>(method: string, params?: unknown): Promise<T> =>
    client.request<T>(method as never, params)
  const listed = await request<ListResourcesResponse>('resource.list')
  const tools: McpToolListing[] = [metaToolListing()]
  for (const entry of listed?.schemes ?? []) {
    const spec = await request<SerializedResourceSpec>('resource.describe', { scheme: entry.scheme })
    tools.push(resourceToolListing(spec))
  }
  return tools
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * 判别键与 `ref` 之外的一切 = 这次调用的参数。
 *
 * 与 `core/resource/tool.ts` 的 `restParams` 同一条规则(那一份是本机 AI 走的那条
 * 路)。两处同规不是巧合:模型看到的是**同一份 schema**,一份 schema 只能有一种读法。
 */
function restParams(input: Record<string, unknown>, discriminator: string): Record<string, unknown> {
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (key === discriminator || key === RESOURCE_REF_KEY) continue
    rest[key] = value
  }
  return rest
}

/** `{list:true}` / `{describe:'<scheme>'}` —— 与本机元工具同一种调用形状。 */
async function callMetaTool(
  client: McpDaemonClient,
  input: Record<string, unknown>,
): Promise<McpToolResult> {
  const request = <T>(method: string, params?: unknown): Promise<T> =>
    client.request<T>(method as never, params)
  const describe = stringField(input, 'describe')
  if (describe !== undefined) {
    return textResult(formatResourceSpec(
      await request<SerializedResourceSpec>('resource.describe', { scheme: describe }),
    ))
  }
  if (input.list === true) {
    return textResult(formatResourceList(await request<ListResourcesResponse>('resource.list')))
  }
  return textResult(`${RESOURCE_META_TOOL_ID}: the call names neither \`list\` nor \`describe\``, true)
}

/**
 * 一次 `do` 的等待上限。超时**不取消**那次调用(daemon 那边照旧在跑 / 照旧挂在卡上),
 * 只是不再等它 —— 见 `DO_TIMEOUT_MS`。
 */
const TIMED_OUT = Symbol('timed-out')

async function withDoTimeout<T>(pending: Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([pending, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * 一次 `tools/call`。
 *
 * **错误一律映射成 `isError: true`,不抛**:MCP 里抛出去的是协议级错误(客户端读到
 * 的是「这台服务器坏了」),而「这条会话不存在」「这条做法被拒」是**结果**,模型
 * 应该读到它并改做法。`denied` / `invalid` / `failed` / `aborted` 四支本来就是
 * `Outcome` 上的正常结局(见 `@shared/ipc/resources.ts` 的头注:「被拒绝不是错误」),
 * 这里只是把它们摆进 MCP 的那一格。
 */
export async function callResourceTool(
  client: McpDaemonClient,
  toolName: string,
  rawInput: unknown,
  principal: DaemonResourcePrincipal,
  timeoutMs: number = DO_TIMEOUT_MS,
): Promise<McpToolResult> {
  const input: Record<string, unknown> =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? { ...(rawInput as Record<string, unknown>) }
      : {}
  const request = <T>(method: string, params?: unknown): Promise<T> =>
    client.request<T>(method as never, params)

  try {
    if (toolName === RESOURCE_META_TOOL_ID) return await callMetaTool(client, input)

    const read = stringField(input, RESOURCE_READ_KEY)
    const op = stringField(input, RESOURCE_OP_KEY)
    if (read === undefined && op === undefined) {
      return textResult(
        `${toolName}: the call names neither \`${RESOURCE_OP_KEY}\` nor \`${RESOURCE_READ_KEY}\``,
        true,
      )
    }

    /*
     * `ref` 在这条路上是**必填**,尽管 schema 说它可以省(省掉 = 对命名空间本身
     * 说话)。原因不在这里:daemon 的 `resource.read` / `resource.do` 收的是一个
     * 字符串地址,而 `parseRef` 不接受空 path(`session:` 解析成 `null`)—— 也就是
     * 「对命名空间本身说话」今天只有 AI 工具那条路表达得出来。桥不发明一种地址,
     * 它把这件事说清楚。留账里有这一条。
     */
    const ref = stringField(input, RESOURCE_REF_KEY)
    if (ref === undefined) {
      return textResult(
        `${toolName}: this bridge needs an address — pass \`ref\` (e.g. "${toolName}:<path>").`,
        true,
      )
    }

    if (read !== undefined) {
      const view = await request<ResourceReadView>('resource.read', {
        ref,
        name: read,
        query: restParams(input, RESOURCE_READ_KEY),
        principal,
      })
      return textResult(formatReadView(view), view.kind !== 'ok')
    }

    const view = await withDoTimeout(
      request<ResourceOutcomeView>('resource.do', {
        ref,
        op,
        params: restParams(input, RESOURCE_OP_KEY),
        principal,
      }),
      timeoutMs,
    )
    if (view === TIMED_OUT) return textResult(APPROVAL_UNAVAILABLE, true)
    return textResult(formatOutcomeView(view), view.kind !== 'ok')
  } catch (error) {
    return textResult(error instanceof Error ? error.message : String(error), true)
  }
}

/** 一条进来的请求。两个处理器共用这一个形状,所以桥不吃 SDK 的请求类型。 */
export interface McpIncomingRequest {
  params?: { name?: string; arguments?: unknown }
}

/**
 * `createResourceMcpServer` 只用得到 SDK `Server` 的这几格。
 *
 * 结构子集而不是 import SDK 的类型 —— 与 `runtime/external-agents/host-mcp/server.ts`
 * 的 `CreateSdkMcpServerFn` 同一条纪律:SDK 保持软依赖,测试可以喂替身,而这只文件
 * 与 SDK 的接触面小到一眼看得完。
 */
export interface McpServerLike {
  setRequestHandler(method: string, handler: (request: McpIncomingRequest) => Promise<unknown>): void
  getClientVersion(): { name?: string } | undefined
  connect(transport: unknown): Promise<void>
  onclose?: () => void
  close(): Promise<void>
}

export interface CreateResourceMcpServerOptions {
  /** SDK 的 `Server`(或替身)。装配交给调用方,好让测试与真机共用这只函数。 */
  server: McpServerLike
  /** 一次 `do` 的等待上限。测试把它调小。 */
  doTimeoutMs?: number
}

/**
 * 装一台服务器:两个处理器,零状态。
 *
 * 走**低层 `Server` + `setRequestHandler`** 而不是 `McpServer.registerTool`,理由
 * 只有一条:`registerTool` 是**注册期**的一张表,而这条桥的表是**每次 `tools/list`
 * 现算**的(见 `listResourceTools`)。用高层 API 就得在启动时把表钉死,再靠一条我们
 * 发不出来的 `list_changed` 去补 —— 那是拿一个 API 的方便换一句谎。
 */
export function createResourceMcpServer(
  client: McpDaemonClient,
  options: CreateResourceMcpServerOptions,
): McpServerLike {
  const { server } = options
  const timeoutMs = options.doTimeoutMs ?? DO_TIMEOUT_MS
  const log = getLogger('cli.mcp')

  server.setRequestHandler('tools/list', async () => {
    const tools = await listResourceTools(client)
    log.debug('tools listed', { count: tools.length })
    return { tools }
  })

  server.setRequestHandler('tools/call', async (request: McpIncomingRequest) => {
    const name = request.params?.name ?? ''
    const principal = mcpPrincipalOf(server.getClientVersion()?.name)
    const result = await callResourceTool(client, name, request.params?.arguments, principal, timeoutMs)
    log.info('tool call', { tool: name, principal: principal.component, isError: result.isError === true })
    return result
  })

  return server
}

/**
 * 一只把结构化记录写到 **stderr** 的 sink。
 *
 * 不用 `configureLogging` 的 `consoleEcho`:那一支走 `console`,而 `console.info`
 * 落 stdout —— 在这条命令里那是协议信道。见文件头。
 */
function installStderrLogSink(): void {
  getRootLogger().addSink({
    write: record => {
      try {
        stderr(JSON.stringify(record))
      } catch {
        // 一条日志写不出去,不能把协议连接带下水。
      }
    },
  })
}

export interface McpCommandOptions {
  storePath?: string
}

/**
 * `onething mcp [--store <path>]`。
 *
 * 起一台 stdio MCP 服务器,活到对面把连接关掉为止。Claude Code / Cursor 的
 * `mcpServers` 配置里那条命令行就是它。
 *
 * SDK 走**动态 import**:`index.ts` 静态引这个文件(与 `resource-command` 同规),
 * 而 MCP server SDK 连着一份内嵌的 ajv,启动时求值它会让每一条 `onething --help`
 * 都替这条命令买单。动态 import 在 esbuild 的单文件 cjs 里仍然内联在同一份产物中,
 * 推迟的是**求值**不是下载 —— 这正是我们要的那一半。
 */
export async function mcpCommand(options: McpCommandOptions, client: McpDaemonClient): Promise<void> {
  installStderrLogSink()
  const log = getLogger('cli.mcp')

  const [{ Server }, { StdioServerTransport }] = await Promise.all([
    import('@modelcontextprotocol/server'),
    import('@modelcontextprotocol/server/stdio'),
  ])

  const server = createResourceMcpServer(client, {
    server: new Server(
      { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      { capabilities: { tools: {} } },
    ) as unknown as McpServerLike,
  })

  const closed = new Promise<void>(resolve => {
    server.onclose = () => resolve()
  })
  await server.connect(new StdioServerTransport())
  log.info('mcp server ready', { store: options.storePath ?? '(default)' })
  await closed
}
