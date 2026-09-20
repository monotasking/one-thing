#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { stdin as input } from 'node:process'
import type { Interface as ReadlineInterface } from 'node:readline/promises'
import type { AskOutputEvent, DaemonStreamEvent } from '@shared/cli/protocol.js'
import { ensureDaemon, tryConnect, spawnDaemon } from './daemon-client.js'
import { assertSupportedPlatform, ensureRuntimeDirs, getCliRuntimePaths } from './paths.js'
import { AssistantTextOut, stdout, stderr } from './stdout.js'
// 静态 import,与 `trace-command` / `plugin-command` 的纪律同一条(见那两个文件的
// 头注):cli 与 Electron 主进程在同一张 rollup 图里,动态 import 会把整个主进程包
// 拽进这个纯 node 进程。`resource-command.ts` 只吃 `@shared/ipc/resources`(纯类型)
// 与 `./stdout.js`,静态引它一个字节都不多带。
import { resourceCommand } from './resource-command.js'

interface ParsedArgs {
  args: string[]
  flags: Record<string, string | boolean>
  storePath?: string
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.storePath) process.env.ONETHING_STORE_PATH = parsed.storePath

  if (parsed.args[0] === 'store' && parsed.flags['daemon-child']) {
    throw new Error('Store commands are offline-only and cannot be combined with --daemon-child.')
  }
  if (parsed.flags['daemon-child']) {
    process.env.ONETHING_HEADLESS = '1'
    const { runDaemonServer } = await import('./daemon-server.js')
    await runDaemonServer({ storePath: parsed.storePath })
    return
  }

  const [scope, command, ...rest] = parsed.args
  if (!scope || parsed.flags.help || parsed.flags.h) {
    printHelp()
    return
  }

  switch (scope) {
    case 'store':
      await (await import('./store-command.js')).storeCommand(command, rest, parsed.storePath, parsed.flags)
      break
    case 'daemon':
      await daemonCommand(command, rest, parsed)
      break
    case 'ask':
      await askCommand([command, ...rest].filter(Boolean), parsed)
      break
    case 'chat':
      await chatCommand(parsed)
      break
    case 'session':
      await sessionCommand(command, rest, parsed)
      break
    case 'active':
      await activeCommand(command, rest, parsed)
      break
    case 'provider':
      await providerCommand(command, rest, parsed)
      break
    case 'tools':
      await toolsCommand(command, rest, parsed)
      break
    case 'permission':
      await permissionCommand(command, rest, parsed)
      break
    case 'collab':
      await collabCommand(command, rest, parsed)
      break
    case 'resource':
      await runResourceCommand(command, rest, parsed)
      break
    case 'mcp':
      await runMcpCommand(parsed)
      break
    case 'trace': {
      // 第二个不经 daemon 的 scope(理由见 trace-command.ts 的头注):轨迹的
      // 事实是一个纯追加文件,读它不该要求引擎活着 —— 排障时引擎往往正是
      // 那个起不来的东西。
      const lastFlag = parsed.flags.last
      const responseFlag = stringFlag(parsed, 'response')
      await (await import('./trace-command.js')).traceCommand(command, {
        ...(stringFlag(parsed, 'run') ? { run: stringFlag(parsed, 'run') } : {}),
        ...(lastFlag !== undefined ? { last: typeof lastFlag === 'string' ? Number(lastFlag) : true } : {}),
        ...(parsed.flags.json ? { json: true } : {}),
        ...(responseFlag !== undefined ? { response: Number(responseFlag) || 0 } : {}),
      })
      break
    }
    case 'plugin':
      // 唯一不经 daemon 的 scope:插件只在桌面宿主执行,CLI daemon 不装配
      // 插件系统。这里直接动账本,装完由用户去桌面刷新(命令自己会说)。
      await (await import('./plugin-command.js')).pluginCommand(command, rest)
      break
    default:
      throw new Error(`Unknown command: ${scope}`)
  }
}

/**
 * 资源:读 / 做 / 看(原子 K4-b)。
 *
 * 走 daemon:资源内核是**装配产物**(`backend.resources`),不是一个能在进程外读的
 * 文件 —— 与 `trace` / `plugin` 那两个离线 scope 不同,这一条天然要求引擎活着
 * (读一条会话的摘要就是要那台内核)。
 *
 * 退出码由 `resourceCommand` 说:一次被拒的 `do` 要让 `&& 下一条` 停下来。
 * `0` 时不写 `process.exitCode` —— 写 `0` 与不写在语义上相同,但不写才不会把
 * 一个别处已经置过的失败码抹掉。
 */
/**
 * `onething mcp` —— stdio MCP 服务端出口(原子 K4-c)。
 *
 * **动态 import,量出来的**(与 `trace-command` / `plugin-command` 同一条,理由却
 * 不同):`mcp-command.ts` 的静态闭包里有 `@onething/backend/wiring/resource`
 * (还原函数)与 `wiring/logging`(日志门面),两者一求值就把装配层的脊柱拉起来
 * —— 静态引进来之后 `onething --help` 从 **0.13s 变成 1.3s**(五次取中位数,
 * 12MB 的单文件 cjs)。改成动态之后回到 0.13s,而 `onething mcp` 自己照付不误
 * (它本来就要连 daemon)。MCP server SDK(连着一份内嵌 ajv)在 `mcpCommand` 里
 * 还有第二层动态 import,同一条理由。
 *
 * 与其余 scope 的两处不同,都是 stdio 协议逼出来的:
 *   · **它不关连接**。服务器活到对面关掉 stdin 为止,`mcpCommand` 在那之前不返回;
 *     `client.close()` 放在 finally 里,那一刻进程也该走了。
 *   · **它一个字都不往 stdout 写**(`stdout()` 在 `mcp-command.ts` 里是禁用的)——
 *     那条管子是 JSON-RPC 信道,多一行就是一次协议解析失败。
 */
async function runMcpCommand(parsed: ParsedArgs): Promise<void> {
  const client = await ensureDaemon({ storePath: parsed.storePath })
  try {
    const { mcpCommand } = await import('./mcp-command.js')
    await mcpCommand({ ...(parsed.storePath ? { storePath: parsed.storePath } : {}) }, client)
  } finally {
    client.close()
  }
}

async function runResourceCommand(command: string | undefined, rest: string[], parsed: ParsedArgs): Promise<void> {
  const client = await ensureDaemon({ storePath: parsed.storePath })
  try {
    const code = await resourceCommand(command, rest, {
      ...(parsed.flags.json ? { json: true } : {}),
      ...(stringFlag(parsed, 'query') !== undefined ? { query: stringFlag(parsed, 'query') } : {}),
      ...(stringFlag(parsed, 'params') !== undefined ? { params: stringFlag(parsed, 'params') } : {}),
      ...(stringFlag(parsed, 'session') !== undefined ? { session: stringFlag(parsed, 'session') } : {}),
    }, client)
    if (code !== 0) process.exitCode = code
  } finally {
    client.close()
  }
}

/**
 * Multi-agent rooms over the daemon:
 *   onething collab new <名字> --members a,b --pm a [--cwd DIR] [--mode dangerously-allow-all]
 *   onething collab list
 *   onething collab update <roomId> [--name N] [--members a,b] [--pm a|''] [--mode MODE]
 *   onething collab send <roomId> <消息…>
 *   onething collab board <roomId>
 *   onething collab log <roomId> [--limit N]
 */
async function collabCommand(command = 'list', rest: string[], parsed: ParsedArgs): Promise<void> {
  const client = await ensureDaemon({ storePath: parsed.storePath })
  switch (command) {
    case 'new': {
      const members = (stringFlag(parsed, 'members') || '').split(',').map(item => item.trim()).filter(Boolean)
      const budgetFlag = stringFlag(parsed, 'budget')
      stdout(formatJson(await client.request('collab.roomNew', {
        name: required(rest.join(' '), 'name'),
        memberAgentIds: members,
        pmAgentId: stringFlag(parsed, 'pm') || undefined,
        workingDirectory: stringFlag(parsed, 'cwd') || undefined,
        permissionMode: stringFlag(parsed, 'mode') || undefined,
        dailyCostUSD: budgetFlag !== undefined ? Number(budgetFlag) : undefined,
      })))
      break
    }
    case 'budget':
      stdout(formatJson(await client.request('collab.setBudgets', {
        roomSessionId: required(rest[0], 'roomSessionId'),
        dailyCostUSD: Number(required(rest[1], 'dailyCostUSD')),
      })))
      break
    case 'update': {
      // Team settings (W6): only the flags you pass change. --pm '' clears it.
      const membersFlag = stringFlag(parsed, 'members')
      const pmFlag = stringFlag(parsed, 'pm')
      stdout(formatJson(await client.request('collab.roomUpdate', {
        roomSessionId: required(rest[0], 'roomSessionId'),
        ...(stringFlag(parsed, 'name') !== undefined ? { name: stringFlag(parsed, 'name') } : {}),
        ...(membersFlag !== undefined
          ? { memberAgentIds: membersFlag.split(',').map(item => item.trim()).filter(Boolean) }
          : {}),
        ...(pmFlag !== undefined ? { pmAgentId: pmFlag || null } : {}),
        ...(stringFlag(parsed, 'mode') !== undefined ? { permissionMode: stringFlag(parsed, 'mode') } : {}),
      })))
      break
    }
    case 'list':
      printRows(await client.request<any[]>('collab.roomList'), ['id', 'name', 'pmAgentId', 'frozen'])
      break
    case 'send':
      stdout(formatJson(await client.request('collab.send', {
        roomSessionId: required(rest[0], 'roomSessionId'),
        content: required(rest.slice(1).join(' '), 'content'),
      })))
      break
    case 'board':
      stdout(formatJson(await client.request('collab.board', {
        roomSessionId: required(rest[0], 'roomSessionId'),
      })))
      break
    case 'log':
      stdout(formatJson(await client.request('collab.transcript', {
        roomSessionId: required(rest[0], 'roomSessionId'),
        limit: Number(stringFlag(parsed, 'limit') || 30),
      })))
      break
    default:
      throw new Error(`Unknown collab command: ${command}`)
  }
  client.close()
}

async function daemonCommand(command = 'status', rest: string[], parsed: ParsedArgs): Promise<void> {
  assertSupportedPlatform()
  const paths = getCliRuntimePaths(parsed.storePath)
  ensureRuntimeDirs(paths)

  switch (command) {
    case 'start': {
      const client = await ensureDaemon({ storePath: parsed.storePath })
      const status = await client.request('daemon.status')
      stdout(formatJson(status))
      client.close()
      break
    }
    case 'status': {
      const client = await tryConnect({ storePath: parsed.storePath })
      if (!client) {
        stdout('daemon stopped')
        return
      }
      stdout(formatJson(await client.request('daemon.status')))
      client.close()
      break
    }
    case 'stop': {
      const client = await tryConnect({ storePath: parsed.storePath })
      if (!client) {
        stdout('daemon already stopped')
        return
      }
      await client.request('daemon.shutdown')
      client.close()
      stdout('daemon stopping')
      break
    }
    case 'restart': {
      const client = await tryConnect({ storePath: parsed.storePath })
      if (client) {
        await client.request('daemon.prepareRestart', { force: Boolean(parsed.flags.force) })
        client.close()
        await sleep(500)
      }
      spawnDaemon(parsed.storePath, paths.bootLogPath)
      const restarted = await ensureDaemon({ storePath: parsed.storePath })
      stdout(formatJson(await restarted.request('daemon.status')))
      restarted.close()
      break
    }
    case 'logs': {
      // L2 之后正主是结构化的 `daemon.jsonl`;`daemon.log` 只剩配置之前的 stderr,
      // 前者不在就退回后者(升级过来的机器上它可能还有历史内容)。
      const logFile = fs.existsSync(paths.logPath) ? paths.logPath : paths.bootLogPath
      if (!fs.existsSync(logFile)) {
        stdout(`No daemon log found at ${paths.logPath}`)
        return
      }
      const text = fs.readFileSync(logFile, 'utf8')
      const lines = text.split(/\r?\n/)
      const count = Number(parsed.flags.n || parsed.flags.lines || 200)
      stdout(lines.slice(Math.max(0, lines.length - count)).join('\n'))
      break
    }
    default:
      throw new Error(`Unknown daemon command: ${command}`)
  }
}

async function askCommand(promptArgs: string[], parsed: ParsedArgs): Promise<void> {
  const prompt = promptArgs.join(' ').trim() || await readStdin()
  if (!prompt.trim()) throw new Error('Prompt is required')

  const client = await ensureDaemon({ storePath: parsed.storePath })
  const json = Boolean(parsed.flags.json)
  const yes = Boolean(parsed.flags.yes || parsed.flags.y)
  const sessionId = stringFlag(parsed, 'session') || stringFlag(parsed, 's')
  const pendingPermissions = new Set<string>()
  const text = new AssistantTextOut()

  await client.request('chat.ask', { prompt, sessionId, yes }, async streamEvent => {
    await handleAskEvent(client, streamEvent, { json, yes, pendingPermissions, text })
  })
  if (!json) {
    text.end()
    process.stdout.write('\n')
  }
  client.close()
}

async function chatCommand(parsed: ParsedArgs): Promise<void> {
  const client = await ensureDaemon({ storePath: parsed.storePath })
  const rl = readline.createInterface({ input, output: process.stderr })
  let session = await client.request<{ id: string; name: string }>('session.show').catch(() => client.request<{ id: string; name: string }>('session.new', { name: 'CLI Chat' }))
  let active = false
  let sawSigint = false

  stdout(`onething chat (${session.name})`)
  stdout('Type /exit to quit, /new [name], /use <session>, /sessions, /abort, /retry, /cwd [path].')

  rl.on('SIGINT', () => {
    if (active) {
      void client.request('active.list').then((streams: any) => {
        const current = Array.isArray(streams) ? streams.find(item => item.sessionId === session.id) : undefined
        if (current) return client.request('active.abort', { streamId: current.streamId })
      })
      sawSigint = true
      return
    }
    rl.close()
  })

  while (true) {
    const line = await rl.question('> ').catch(() => '/exit')
    const trimmed = line.trim()
    if (!trimmed) continue
    if (trimmed === '/exit' || trimmed === '/quit') break
    if (trimmed.startsWith('/')) {
      const done = await handleChatSlash(
        client,
        trimmed,
        () => session,
        next => { session = next },
        () => active,
        permission => promptPermission(permission, rl),
      )
      if (done) continue
    } else {
      active = true
      sawSigint = false
      const text = new AssistantTextOut()
      await client.request('chat.ask', { prompt: trimmed, sessionId: session.id }, async event => {
        await handleAskEvent(client, event, {
          json: false,
          yes: false,
          pendingPermissions: new Set(),
          text,
          promptPermission: permission => promptPermission(permission, rl),
        })
      }).catch(error => {
        if (!sawSigint) stderr(error.message)
      }).finally(() => {
        active = false
        text.end()
        process.stdout.write('\n')
      })
    }
  }
  rl.close()
  client.close()
}

async function sessionCommand(command = 'list', rest: string[], parsed: ParsedArgs): Promise<void> {
  const client = await ensureDaemon({ storePath: parsed.storePath })
  switch (command) {
    case 'list':
      printRows(await client.request<any[]>('session.list'), ['id', 'name', 'updatedAt', 'messageCount'])
      break
    case 'new':
      stdout(formatJson(await client.request('session.new', { name: rest.join(' ') || 'CLI Chat' })))
      break
    case 'use':
      stdout(formatJson(await client.request('session.use', { sessionId: required(rest[0], 'sessionId') })))
      break
    case 'show':
      stdout(formatJson(await client.request('session.show', { sessionId: rest[0] })))
      break
    case 'rename':
      await client.request('session.rename', { sessionId: required(rest[0], 'sessionId'), name: required(rest.slice(1).join(' '), 'name') })
      stdout('renamed')
      break
    case 'pin':
    case 'unpin':
      await client.request('session.pin', { sessionId: required(rest[0], 'sessionId'), pinned: command === 'pin' })
      stdout(command === 'pin' ? 'pinned' : 'unpinned')
      break
    case 'archive':
    case 'restore':
      await client.request('session.archive', { sessionId: required(rest[0], 'sessionId'), archived: command === 'archive' })
      stdout(command === 'archive' ? 'archived' : 'restored')
      break
    case 'delete':
      await client.request('session.delete', { sessionId: required(rest[0], 'sessionId') })
      stdout('deleted')
      break
    case 'cwd': {
      const clear = Boolean(parsed.flags.clear)
      const cwd = clear ? null : rest[1] || rest[0]
      const sessionId = rest.length > 1 ? rest[0] : stringFlag(parsed, 'session')
      stdout(formatJson(await client.request('session.cwd', Object.prototype.hasOwnProperty.call(parsed.flags, 'clear') || cwd ? { sessionId, cwd } : { sessionId })))
      break
    }
    case 'model':
      await client.request('session.model', { sessionId: required(rest[0], 'sessionId'), provider: required(rest[1], 'provider'), model: required(rest[2], 'model') })
      stdout('model set')
      break
    default:
      throw new Error(`Unknown session command: ${command}`)
  }
  client.close()
}

async function activeCommand(command = 'list', rest: string[], parsed: ParsedArgs): Promise<void> {
  const client = await ensureDaemon({ storePath: parsed.storePath })
  if (command === 'list') printRows(await client.request<any[]>('active.list'), ['streamId', 'sessionId', 'status', 'promptPreview'])
  else if (command === 'abort') stdout(formatJson(await client.request('active.abort', { streamId: required(rest[0], 'streamId') })))
  else throw new Error(`Unknown active command: ${command}`)
  client.close()
}

async function providerCommand(command = 'list', rest: string[], parsed: ParsedArgs): Promise<void> {
  const client = await ensureDaemon({ storePath: parsed.storePath })
  switch (command) {
    case 'list':
      printRows(await client.request<any[]>('provider.list'), ['id', 'model', 'enabled', 'isDefault'])
      break
    case 'use':
      stdout(formatJson(await client.request('provider.use', { providerId: required(rest[0], 'providerId'), model: rest[1] })))
      break
    case 'enable':
    case 'disable':
      stdout(formatJson(await client.request('provider.enable', { providerId: required(rest[0], 'providerId'), enabled: command === 'enable' })))
      break
    case 'configure': {
      const providerId = required(rest[0], 'providerId')
      const update: Record<string, unknown> = { providerId }
      for (const key of ['apiKey', 'baseUrl', 'model'] as const) {
        const value = stringFlag(parsed, key)
        if (value) update[key] = value
      }
      const selected = stringFlag(parsed, 'selectedModels')
      if (selected) update.selectedModels = selected.split(',').map(item => item.trim()).filter(Boolean)
      stdout(formatJson(await client.request('provider.configure', update)))
      break
    }
    case 'models':
      stdout((await client.request<string[]>('provider.models', { providerId: required(rest[0], 'providerId') })).join('\n'))
      break
    default:
      throw new Error(`Unknown provider command: ${command}`)
  }
  client.close()
}

async function toolsCommand(command = 'list', rest: string[], parsed: ParsedArgs): Promise<void> {
  const client = await ensureDaemon({ storePath: parsed.storePath })
  if (command === 'list') {
    printRows(await client.request<any[]>('tools.list'), ['id', 'name', 'enabled', 'autoExecute'])
  } else if (command === 'enable' || command === 'disable') {
    await client.request('tools.set', { toolId: required(rest[0], 'toolId'), enabled: command === 'enable' })
    stdout(command === 'enable' ? 'enabled' : 'disabled')
  } else {
    throw new Error(`Unknown tools command: ${command}`)
  }
  client.close()
}

async function permissionCommand(command: string | undefined, rest: string[], parsed: ParsedArgs): Promise<void> {
  const client = await ensureDaemon({ storePath: parsed.storePath })
  if (command !== 'set') throw new Error('Usage: onething permission set <mode>')
  stdout(formatJson(await client.request('permission.mode.set', { mode: required(rest[0], 'mode') })))
  client.close()
}

async function handleAskEvent(
  client: { request<T = unknown>(method: any, params?: unknown): Promise<T> },
  streamEvent: DaemonStreamEvent,
  options: {
    json: boolean
    yes: boolean
    pendingPermissions: Set<string>
    /** 一个回合一只:助手正文要逐片投影,扣尾这件事有状态。 */
    text: AssistantTextOut
    promptPermission?: (event: Extract<AskOutputEvent, { type: 'permission' }>) => Promise<'once' | 'session' | 'workdir' | 'reject'>
  },
): Promise<void> {
  const { streamId, event } = streamEvent
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ streamId, event })}\n`)
  } else {
    writeHumanAskEvent(event, options.text)
  }

  if (event.type === 'permission' && streamEvent.sessionId && !options.pendingPermissions.has(event.id)) {
    options.pendingPermissions.add(event.id)
    const decision = options.yes ? 'once' : await (options.promptPermission ?? promptPermission)(event)
    await client.request('permission.respond', {
      sessionId: streamEvent.sessionId,
      requestId: event.id,
      decision,
    })
  }
}

function writeHumanAskEvent(event: AskOutputEvent, text: AssistantTextOut): void {
  switch (event.type) {
    case 'text_delta':
      text.write(event.text)
      break
    case 'reasoning_delta':
      break
    case 'tool_use':
      process.stderr.write(`\n[tool] ${event.name}\n`)
      break
    case 'tool_result':
      process.stderr.write(`[tool-result] ${event.id}${event.isError ? ' failed' : ' completed'}\n`)
      break
    case 'permission':
      process.stderr.write(`\n[permission] ${event.description}\n`)
      break
    case 'error':
      process.stderr.write(`\n[error] ${event.message}\n`)
      break
  }
}

async function promptPermission(
  event: Extract<AskOutputEvent, { type: 'permission' }>,
  existingRl?: ReadlineInterface,
): Promise<'once' | 'session' | 'workdir' | 'reject'> {
  const rl = existingRl ?? readline.createInterface({ input, output: process.stderr })
  try {
    const answer = await rl.question('Allow? [o]nce/[s]ession/[w]orkdir/[r]eject: ')
    const normalized = answer.trim().toLowerCase()
    if (normalized.startsWith('s')) return 'session'
    if (normalized.startsWith('w')) return 'workdir'
    if (normalized.startsWith('r') || normalized.startsWith('n')) return 'reject'
    return 'once'
  } finally {
    if (!existingRl) rl.close()
  }
}

async function handleChatSlash(
  client: any,
  line: string,
  getSession: () => { id: string; name: string },
  setSession: (session: { id: string; name: string }) => void,
  isActive: () => boolean,
  promptPermissionForChat?: (event: Extract<AskOutputEvent, { type: 'permission' }>) => Promise<'once' | 'session' | 'workdir' | 'reject'>,
): Promise<boolean> {
  const [command, ...rest] = line.slice(1).split(/\s+/)
  switch (command) {
    case 'sessions':
      printRows(await client.request('session.list'), ['id', 'name', 'updatedAt', 'messageCount'])
      return true
    case 'new':
      setSession(await client.request('session.new', { name: rest.join(' ') || 'CLI Chat' }))
      stdout(`using ${getSession().name}`)
      return true
    case 'use':
      if (isActive()) {
        stderr('/use is disabled while a stream is active; /abort first')
        return true
      }
      setSession(await client.request('session.use', { sessionId: required(rest[0], 'sessionId') }))
      stdout(`using ${getSession().name}`)
      return true
    case 'cwd':
      stdout(formatJson(await client.request('session.cwd', rest[0] ? { sessionId: getSession().id, cwd: rest[0] } : { sessionId: getSession().id })))
      return true
    case 'abort': {
      const streams = await client.request('active.list') as Array<{ sessionId: string; streamId: string }>
      const current = streams.find((item: { sessionId: string }) => item.sessionId === getSession().id)
      if (current) await client.request('active.abort', { streamId: current.streamId })
      return true
    }
    case 'retry': {
      const text = new AssistantTextOut()
      await client.request('chat.retryLast', { sessionId: getSession().id }, async (event: DaemonStreamEvent) => {
        await handleAskEvent(client, event, {
          json: false,
          yes: false,
          pendingPermissions: new Set(),
          text,
          promptPermission: promptPermissionForChat,
        })
      })
      text.end()
      process.stdout.write('\n')
      return true
    }
    default:
      stderr(`Unknown slash command: /${command}`)
      return true
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: string[] = []
  const flags: Record<string, string | boolean> = {}
  const booleanFlags = new Set(['clear', 'daemon-child', 'force', 'h', 'help', 'json', 'last', 'y', 'yes',
    'all-hosts-stopped', 'automatic-restarts-disabled'])
  const valueShortFlags = new Set(['n', 's'])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--') {
      args.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2)
      if (inline !== undefined) flags[name] = inline
      else if (booleanFlags.has(name)) flags[name] = true
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) flags[name] = argv[++i]
      else flags[name] = true
      continue
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const shortName = arg.slice(1)
      if (shortName.length === 1 && valueShortFlags.has(shortName) && argv[i + 1] && !argv[i + 1].startsWith('-')) {
        flags[shortName] = argv[++i]
        continue
      }
      const letters = arg.slice(1).split('')
      for (const letter of letters) flags[letter] = true
      continue
    }
    args.push(arg)
  }
  const storePath = typeof flags.store === 'string' ? path.resolve(flags.store) : undefined
  return { args, flags, storePath }
}

function stringFlag(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.flags[name]
  return typeof value === 'string' ? value : undefined
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function printRows(rows: any[], columns: string[]): void {
  if (!Array.isArray(rows) || rows.length === 0) {
    stdout('(none)')
    return
  }
  const widths = columns.map(column => Math.max(column.length, ...rows.map(row => String(row[column] ?? '').length)))
  stdout(columns.map((column, i) => column.padEnd(widths[i])).join('  '))
  for (const row of rows) {
    stdout(columns.map((column, i) => formatCell(row[column]).padEnd(widths[i])).join('  '))
  }
}

function formatCell(value: unknown): string {
  if (typeof value === 'number' && value > 1_000_000_000_000) return new Date(value).toISOString()
  return String(value ?? '')
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function required(value: string | undefined, label: string): string {
  if (!value || !value.trim()) throw new Error(`${label} is required`)
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function printHelp(): void {
  stdout(`onething CLI

Usage:
  onething daemon start|stop|restart|status|logs
  onething ask [--json] [--yes] [--session <id>] <prompt>
  onething chat
  onething session list|new|use|show|rename|pin|unpin|archive|restore|delete|cwd|model
  onething active list|abort <streamId>
  onething provider list|use|enable|disable|configure|models
  onething tools list|enable|disable
  onething permission set <mode>
  onething plugin install <path.tgz | market id> [more...]
  onething store backup <new-backup-dir> --store <stopped-store>
  onething store verify <backup-dir>
  onething store restore <backup-dir> <new-store-dir>
  onething store lock [inspect] [--store <path>]
  onething store lock recover --store <stopped-store> --identity-file <reviewed-diagnostic.json>
      --all-hosts-stopped --automatic-restarts-disabled
  onething plugin list
  onething plugin uninstall <id | package name>
  onething trace <sessionId> [--run <id> | --last] [--json] [--response <requestIndex>]
  onething resource list
  onething resource describe <scheme>
  onething resource read <ref> <name> [--query '<json>'] [--session <id>] [--json]
  onething resource do <ref> <op> [--params '<json>'] [--session <id>] [--json]
  onething mcp [--store <path>]        # stdio MCP server: every resource, for any agent

Global:
  --store <path>  Use a non-default store directory

Notes:
  store lock defaults to read-only JSON diagnosis. Recovery requires a reviewed
  diagnostic from the same store, every host stopped, and automatic restarts
  disabled. It preserves the old lock in a diagnostic archive; there is no force
  mode and no automatic recovery based only on a missing PID.

  trace reads <store>/sessions/<id>/events.jsonl directly (no daemon needed) and
  never writes. --response prints the assistant text of one request, folded from
  the recorded chunks.

  resource is the one generic surface over every namespace (session, dir, music,
  …): list names them, describe prints one namespace's reads/ops/events, and
  read/do go through the same pipeline the UI and the model use — so a do can ask
  for permission and is written to the audit ledger. --json prints exactly what
  the RPC face returns. A non-ok read/do exits 1.

  plugin commands only edit the npm ledger under <store>/plugins — plugins run on
  the desktop host, so a running desktop app needs Settings → Plugins → Refresh
  (or a restart) before an install/uninstall takes effect. Requires a local npm.
`)
}

main().catch(error => {
  const code = error instanceof Error ? error.name : ''
  if (code === 'ERR_UNSUPPORTED_PLATFORM') {
    stderr('ERR_UNSUPPORTED_PLATFORM: Windows daemon transport is not supported in v1.')
  } else {
    stderr(error instanceof Error ? error.message : String(error))
  }
  process.exitCode = 1
})
