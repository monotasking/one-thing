// 一台最小的 ACP agent(测试夹具):真子进程、真 ndjson JSON-RPC。
// 会话存在 FAKE_AGENT_DIR 下的 JSON 里,所以进程重启之后还能 load 回来 ——
// 这正是「会话在 agent 自己那里」那件事的缩影。
// FAKE_AGENT_CAPS = 'load' | 'resume' | 'none',或逗号列表(A5:`list,fork,load`)决定它声明哪些会话能力:
//   load → `loadSession`;resume / list / fork → `sessionCapabilities.{resume,list,fork}`。旧的三个单值照旧。
//
// A5(gate:acp ⑲⑳㉑ / 单测):
// `session/list`(caps 含 list):列 FAKE_AGENT_DIR 里所有会话文件(按 cwd 过滤),每页
//   FAKE_AGENT_LIST_PAGE 条(缺省 50),`nextCursor` 是下一页的起点;记一行 `list`。
// `session/load`:会话文件里有 `history`(`[{ kind: 'user' | 'agent' | 'thought' | 'tool', … }]`)就按序
//   回放成 `user_message_chunk` / `agent_message_chunk` / `agent_thought_chunk` / `tool_call` + `tool_call_update`;
//   没有就照旧回放一句 `REPLAYED`(普通恢复应当丢掉它)。
// `session/fork`(caps 含 fork):复制源会话文件为一条新会话(cwd 换成请求里的),记一行 `fork`。
// 会话文件里的 `title` / `updatedAt` 进 `session/list` 的答复。
// FAKE_AGENT_CLOSE_ON_PROMPT=1:收到 prompt 就关掉自己的 stdout(连接断),进程却再活一阵 ——
// 用来证明客户端不等进程退出、凭连接关闭就收尾。
// FAKE_AGENT_PUSH_COMMANDS=1:`session/new` 一答完就推一条 `available_commands_update`(与
// claude-agent-acp 同形),此刻没有任何 prompt 在飞 —— 用来证明会话状态不靠 prompt 队列。
// FAKE_AGENT_ROGUE_METHOD=1(gate:acp ③):第一轮 prompt 先向客户端发一条协议外的**请求**
// `cursor/whatever`(Cursor 这类 agent 真会发私有方法),把拿到的 JSON-RPC 错误码记进
// calls.log —— 客户端该答 -32601 而不是断连;随后照常说完这一轮:正文、思考、一次 `read`
// 工具从 pending 走到 completed,最后 `end_turn`。只有第一轮这样,后面的轮次回到原剧本。
//
// A3-b 三条剧本(gate:acp ⑪–⑭ / ⑯;每条都要**两样**同时在:环境变量打开 + 那一轮的正文以
// 对应口令开头,所以一台 agent 可以一轮一个剧本):
// FAKE_AGENT_PERMISSION=1 + 正文 `@perm`:工具之前发 `session/request_permission`(execute、四个选项),
//   同一件事连问两次;正文 `@perm1` 只问一次。每次把选中的 optionId 记进 calls.log。
// FAKE_AGENT_FS=1 + 正文 `@fs`:读 `<cwd>/hello.txt`(应当成功)、读 FAKE_AGENT_FS_OUTSIDE(根外的
//   敏感文件,应当被拒;**只记成败与长度,从不记内容**)、写 `<cwd>/written-by-agent.txt`。
// FAKE_AGENT_TERMINAL=1 + 正文 `@term`:起 `/bin/sh -c 'sleep 1; echo hi'`,等它退出、读输出、release;
//   再起一条 `sleep 30`,kill 之后等结局、release。
// 握手时收到的 clientCapabilities 写进 FAKE_AGENT_DIR/client-caps.json(不进 calls.log)。
//
// A3-c 两条剧本(gate:acp ⑮ / ⑯b):
// FAKE_AGENT_AUTH=terminal|agent:握手自报一种登录方法;没登录(FAKE_AGENT_DIR/credentials 不在)时
//   `session/new` 与 prompt 以 `auth_required` 拒。terminal 型 = 客户端拿同一份起法追加 `--login`
//   再起一次本脚本:打印一行、写下 credentials、退出码 0;agent 型 = `authenticate` 直接写下 credentials。
// FAKE_AGENT_ELICIT=1 + 正文 `@elicit`:发一张 `elicitation/create` 表单(一道单选 + 一道自由输入),
//   把客户端的答复(或错误码)记进 calls.log,然后照常说完这一轮。
//
// A2-a 三条(gate:acp ⑥⑦ / 单测):
// FAKE_AGENT_RICH_TOOLS=1 + 正文 `@rich`:一次带 `name: 'edit_file'`、`kind: 'edit'`、`locations` 的工具
//   从 pending → in_progress → completed,收尾内容是一块 `diff`(改 `<cwd>/rich.txt` 第 2 行、加第 4 行);
//   再一次 `kind: 'execute'` 的工具,内容是一块 `terminal`(经客户端的终端桥真起一条;桥不在就用
//   假 id `fake-term`);最后两段 `compaction_summary_chunk`(同一个 compactionId)。
// FAKE_AGENT_RECORD_PROMPT=1:每轮把收到的 prompt 内容块(type + 文本前 400 字)记进 calls.log。
// FAKE_AGENT_IMAGE=1:握手自报 `promptCapabilities.image`。
// `session/new` 带了 `_meta` 就把它记进那一行的 `meta` 格(不带就没有这一格,别的用例逐条比对不受影响)。
//
// A4-b(gate:acp ⑰⑱ / 单测):`session/new` / `load` / `resume` 收到**非空**的 `mcpServers` 就把它记进
// 那一行的 `mcpServers` 格(空表不记,理由同 `meta`)。
// FAKE_AGENT_USE_HOST_MCP=1 + 正文 `@mcp`:从这条会话收到的 `mcpServers` 里找 stdio 那条 `onething`,
//   照它的 command / args / env 起桥子进程,用 `@modelcontextprotocol/client` 在 stdio 上说 MCP:
//   `tools/list` 记下工具名,`tools/call send_notification { message }` 记下结果,关掉桥,照常收尾。
//   凭据(env 里的 `ONETHING_MCP_TOKEN`)与面地址也记进那一行 —— 门拿它在会话删掉前后各打一次
//   `host-mcp.listTools`,看作废是不是真的。
//
// A2-b(gate:acp ⑧⑨⑩ / 单测):
// FAKE_AGENT_PLAN=1 + 正文 `@plan`:推两版 `plan_update`(planId `p1`,三条 → 第一条完成、第二条进行中),
//   计划留在那里;正文 `@plan-clear`:推 `plan_removed { planId: 'p1' }`。
// FAKE_AGENT_USAGE=1 + 正文 `@usage`:推 `usage_update`(used 1234 / size 200000 / 累计成本 USD,
//   每一轮 +0.25),这一轮答复带 `usage`(input 100 / output 20 / total 150 / thought 30 / cachedRead 40)。
// FAKE_AGENT_TITLE=1 + 正文 `@title <标题>`:推 `session_info_update { title }`。
// `session/set_mode`(无条件):记一行 `set-mode`,再推 `current_mode_update`。
import { AgentSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import { closeSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const dir = process.env.FAKE_AGENT_DIR
const caps = new Set((process.env.FAKE_AGENT_CAPS ?? 'load').split(',').map(cap => cap.trim()).filter(Boolean))
mkdirSync(dir, { recursive: true })
const credentials = join(dir, 'credentials')
const authMode = process.env.FAKE_AGENT_AUTH

// 终端型登录:客户端把方法给的 args 追加在起法后面再起一次本脚本 —— 这一次不是 agent,是登录程序。
if (process.argv.includes('--login')) {
  process.stdout.write(`fake-agent login ok (${process.env.FAKE_AGENT_LOGIN_MARK ?? 'no-mark'})\n`)
  writeFileSync(credentials, 'terminal')
  writeFileSync(join(dir, 'calls.log'), `${JSON.stringify({ method: 'terminal-login', mark: process.env.FAKE_AGENT_LOGIN_MARK ?? null })}\n`, { flag: 'a' })
  process.exit(0)
}
const loggedIn = () => !authMode || existsSync(credentials)
const AUTH_METHODS = {
  terminal: [{ id: 'fake-terminal-login', name: 'Fake terminal login', type: 'terminal', args: ['--login'], env: { FAKE_AGENT_LOGIN_MARK: 'from-method' } }],
  agent: [{ id: 'fake-agent-login', name: 'Fake agent login', description: 'authenticate in-band' }],
}
const file = id => join(dir, `${id}.json`)
const readSession = id => (existsSync(file(id)) ? JSON.parse(readFileSync(file(id), 'utf8')) : undefined)
const writeSession = s => writeFileSync(file(s.id), JSON.stringify(s))
const logCall = entry => writeFileSync(join(dir, 'calls.log'), `${JSON.stringify(entry)}\n`, { flag: 'a' })
/** 这条 agent 会话最近一次收到的 `mcpServers`(开 / load / resume 都会换)。只在内存:桥凭据也只活在宿主内存里。 */
const receivedMcpServers = new Map()
const noteMcpServers = (sessionId, servers) => {
  const list = Array.isArray(servers) ? servers : []
  receivedMcpServers.set(sessionId, list)
  return list.length > 0 ? { mcpServers: list } : {}
}

async function hostMcpScript(s) {
  const entry = (receivedMcpServers.get(s.id) ?? []).find(server => server.name === 'onething' && typeof server.command === 'string')
  if (!entry) {
    logCall({ method: 'host-mcp', ok: false, reason: 'no stdio onething entry in mcpServers' })
    return
  }
  const env = Object.fromEntries((entry.env ?? []).map(pair => [pair.name, pair.value]))
  const { Client } = await import('@modelcontextprotocol/client')
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio')
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args ?? [], env: { ...process.env, ...env }, stderr: 'pipe' })
  const client = new Client({ name: 'fake-agent', version: '0.0.1' })
  try {
    await client.connect(transport)
    const listed = await client.listTools()
    const called = await client.callTool({ name: 'send_notification', arguments: { message: `hello from fake agent (${s.id})`, title: 'Fake agent' } })
    logCall({
      method: 'host-mcp',
      ok: true,
      tools: listed.tools.map(tool => tool.name),
      callResult: called,
      token: env.ONETHING_MCP_TOKEN ?? null,
      url: env.ONETHING_MCP_URL ?? null,
    })
  } catch (error) {
    logCall({ method: 'host-mcp', ok: false, message: String(error?.stack ?? error?.message ?? error) })
  } finally {
    await client.close().catch(() => {})
  }
}

/** FAKE_AGENT_DIR 里所有会话文件(有 id 的 JSON;`client-caps.json` 之类不算),按文件名排序。 */
function listStoredSessions() {
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => {
      try {
        return JSON.parse(readFileSync(join(dir, name), 'utf8'))
      } catch {
        return undefined
      }
    })
    .filter(s => s && typeof s.id === 'string' && typeof s.cwd === 'string')
}

/** 会话文件里的 `history` → 回放的 `session/update` 序列。 */
function historyUpdates(history) {
  const out = []
  for (const entry of history) {
    if (entry.kind === 'user') out.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: entry.text } })
    else if (entry.kind === 'agent') out.push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: entry.text } })
    else if (entry.kind === 'thought') out.push({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: entry.text } })
    else if (entry.kind === 'tool') {
      out.push({ sessionUpdate: 'tool_call', toolCallId: entry.id, title: entry.title, kind: entry.toolKind ?? 'read', status: 'pending', rawInput: entry.input ?? {} })
      out.push({ sessionUpdate: 'tool_call_update', toolCallId: entry.id, status: 'completed', rawOutput: entry.output ?? { ok: true } })
    } else if (entry.kind === 'title') out.push({ sessionUpdate: 'session_info_update', title: entry.text })
  }
  return out
}

const MODELS = [{ value: 'alpha', name: 'Alpha' }, { value: 'beta', name: 'Beta' }]
const configOptions = s => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model, options: MODELS },
]

const PERMISSION_OPTIONS = [
  { optionId: 'opt-allow-once', name: 'Allow', kind: 'allow_once' },
  { optionId: 'opt-allow-always', name: 'Always Allow', kind: 'allow_always' },
  { optionId: 'opt-reject-once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'opt-reject-always', name: 'Always Reject', kind: 'reject_always' },
]

async function permissionScript(conn, s, times) {
  for (let ask = 1; ask <= times; ask += 1) {
    const toolCallId = `perm-${s.turns}-${ask}`
    await conn.sessionUpdate({
      sessionId: s.id,
      update: { sessionUpdate: 'tool_call', toolCallId, title: 'npm run build', kind: 'execute', status: 'pending', rawInput: { command: 'npm run build' } },
    })
    const startedAt = Date.now()
    const answer = await conn.requestPermission({
      sessionId: s.id,
      toolCall: { toolCallId, title: 'npm run build', kind: 'execute', rawInput: { command: 'npm run build' } },
      options: PERMISSION_OPTIONS,
    })
    logCall({ method: 'permission', turn: s.turns, ask, outcome: answer.outcome, ms: Date.now() - startedAt })
    await conn.sessionUpdate({
      sessionId: s.id,
      update: { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', rawOutput: { ok: true } },
    })
  }
}

async function fsScript(conn, s) {
  try {
    const read = await conn.readTextFile({ sessionId: s.id, path: join(s.cwd, 'hello.txt') })
    logCall({ method: 'fs-read', ok: true, content: read.content })
  } catch (error) {
    logCall({ method: 'fs-read', ok: false, code: error?.code ?? null, message: String(error?.message ?? error) })
  }
  try {
    const read = await conn.readTextFile({ sessionId: s.id, path: process.env.FAKE_AGENT_FS_OUTSIDE })
    logCall({ method: 'fs-read-outside', ok: true, length: read.content.length })
  } catch (error) {
    logCall({ method: 'fs-read-outside', ok: false, code: error?.code ?? null, message: String(error?.message ?? error) })
  }
  try {
    await conn.writeTextFile({ sessionId: s.id, path: join(s.cwd, 'written-by-agent.txt'), content: 'written by agent\n' })
    logCall({ method: 'fs-write', ok: true })
  } catch (error) {
    logCall({ method: 'fs-write', ok: false, code: error?.code ?? null, message: String(error?.message ?? error) })
  }
}

async function elicitScript(conn, s) {
  try {
    const response = await conn.createElicitation({
      sessionId: s.id,
      mode: 'form',
      message: 'Fake agent needs two answers',
      requestedSchema: {
        type: 'object',
        properties: {
          color: {
            type: 'string',
            title: 'Color',
            description: 'Which color?',
            oneOf: [
              { const: 'r', title: 'Red' },
              { const: 'b', title: 'Blue', _meta: { '_claude/askUserQuestionOption': { description: 'the blue one' } } },
            ],
          },
          note: { type: 'string', title: 'Note', description: 'Anything else?' },
        },
        required: ['color'],
      },
    })
    logCall({ method: 'elicit', response })
  } catch (error) {
    logCall({ method: 'elicit', code: error?.code ?? null, message: String(error?.message ?? error) })
  }
}

async function terminalScript(conn, s) {
  try {
    const terminal = await conn.createTerminal({ sessionId: s.id, command: '/bin/sh', args: ['-c', 'sleep 1; echo hi'], cwd: s.cwd })
    logCall({ method: 'term-created', terminalId: terminal.id })
    const exit = await terminal.waitForExit()
    const output = await terminal.currentOutput()
    logCall({ method: 'term-output', terminalId: terminal.id, output: output.output, truncated: output.truncated, exit, exitStatus: output.exitStatus ?? null })
    await terminal.release()
    const sleeper = await conn.createTerminal({ sessionId: s.id, command: '/bin/sh', args: ['-c', 'sleep 30'], cwd: s.cwd })
    logCall({ method: 'term-sleeper', terminalId: sleeper.id })
    await sleeper.kill()
    const killed = await sleeper.waitForExit()
    logCall({ method: 'term-killed', terminalId: sleeper.id, exit: killed })
    await sleeper.release()
  } catch (error) {
    logCall({ method: 'term-error', code: error?.code ?? null, message: String(error?.message ?? error) })
  }
}

async function richToolsScript(conn, s) {
  const path = join(s.cwd, 'rich.txt')
  const editId = `rich-edit-${s.turns}`
  await conn.sessionUpdate({
    sessionId: s.id,
    update: {
      sessionUpdate: 'tool_call', toolCallId: editId, title: 'Edit rich.txt', name: 'edit_file', kind: 'edit',
      status: 'pending', locations: [{ path, line: 3 }], rawInput: { path },
    },
  })
  await conn.sessionUpdate({ sessionId: s.id, update: { sessionUpdate: 'tool_call_update', toolCallId: editId, status: 'in_progress' } })
  await conn.sessionUpdate({
    sessionId: s.id,
    update: {
      sessionUpdate: 'tool_call_update', toolCallId: editId, status: 'completed',
      content: [{ type: 'diff', path, oldText: 'alpha\nbeta\ngamma\n', newText: 'alpha\nBETA\ngamma\ndelta\n' }],
    },
  })
  let terminalId = 'fake-term'
  try {
    const terminal = await conn.createTerminal({ sessionId: s.id, command: '/bin/sh', args: ['-c', 'echo rich'], cwd: s.cwd })
    terminalId = terminal.id
    await terminal.waitForExit()
  } catch (error) {
    logCall({ method: 'rich-term-fallback', message: String(error?.message ?? error) })
  }
  logCall({ method: 'rich-term', terminalId })
  const execId = `rich-exec-${s.turns}`
  await conn.sessionUpdate({
    sessionId: s.id,
    update: {
      sessionUpdate: 'tool_call', toolCallId: execId, title: 'Run echo rich', kind: 'execute', status: 'in_progress',
      content: [{ type: 'terminal', terminalId }],
    },
  })
  await conn.sessionUpdate({ sessionId: s.id, update: { sessionUpdate: 'tool_call_update', toolCallId: execId, status: 'completed' } })
  for (const text of ['Earlier we edited rich.txt. ', 'Then ran echo.']) {
    await conn.sessionUpdate({
      sessionId: s.id,
      update: { sessionUpdate: 'compaction_summary_chunk', compactionId: 'cmp-1', content: { type: 'text', text } },
    })
  }
}

async function planScript(conn, s) {
  const entries = (statuses) => [
    { content: 'Read the code', priority: 'high', status: statuses[0] },
    { content: 'Write the patch', priority: 'medium', status: statuses[1] },
    { content: 'Run the tests', priority: 'low', status: statuses[2] },
  ]
  await conn.sessionUpdate({
    sessionId: s.id,
    update: { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'p1', entries: entries(['pending', 'pending', 'pending']) } },
  })
  await conn.sessionUpdate({
    sessionId: s.id,
    update: { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'p1', entries: entries(['completed', 'in_progress', 'pending']) } },
  })
  logCall({ method: 'plan-pushed', id: s.id })
}

async function planClearScript(conn, s) {
  await conn.sessionUpdate({ sessionId: s.id, update: { sessionUpdate: 'plan_removed', planId: 'p1' } })
  logCall({ method: 'plan-removed', id: s.id })
}

/** 累计成本随轮次涨(每一轮 +0.25 USD),会话存盘。答这一轮的 usage。 */
async function usageScript(conn, s) {
  s.cost = Number(((s.cost ?? 0) + 0.25).toFixed(4))
  writeSession(s)
  await conn.sessionUpdate({
    sessionId: s.id,
    update: { sessionUpdate: 'usage_update', used: 1234, size: 200000, cost: { amount: s.cost, currency: 'USD' } },
  })
  logCall({ method: 'usage-pushed', id: s.id, cost: s.cost })
  return { inputTokens: 100, outputTokens: 20, totalTokens: 150, thoughtTokens: 30, cachedReadTokens: 40 }
}

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection(conn => ({
  async initialize(params) {
    logCall({ method: 'init', proxy: process.env.HTTPS_PROXY ?? null })
    // 另写一个文件,不进 calls.log(别的用例逐条比对那张表)。
    writeFileSync(join(dir, 'client-caps.json'), JSON.stringify(params?.clientCapabilities ?? null))
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: caps.has('load'),
        ...(process.env.FAKE_AGENT_IMAGE === '1' ? { promptCapabilities: { image: true } } : {}),
        sessionCapabilities: {
          ...(caps.has('resume') ? { resume: {} } : {}),
          ...(caps.has('list') ? { list: {} } : {}),
          ...(caps.has('fork') ? { fork: {} } : {}),
        },
      },
      // 自报身份:gate:acp ① 拿它与 `acp.getAgents` 那一行逐字比对。
      agentInfo: { name: 'fake-agent', version: '0.0.1' },
      ...(authMode ? { authMethods: AUTH_METHODS[authMode] ?? [] } : {}),
    }
  },
  async newSession(params) {
    if (!loggedIn()) {
      logCall({ method: 'new-refused', reason: 'auth' })
      throw RequestError.authRequired()
    }
    const s = { id: randomUUID(), cwd: params.cwd, model: 'alpha', turns: 0 }
    writeSession(s)
    logCall({ method: 'new', id: s.id, cwd: params.cwd, ...(params._meta ? { meta: params._meta } : {}), ...noteMcpServers(s.id, params.mcpServers) })
    if (process.env.FAKE_AGENT_PUSH_COMMANDS === '1') {
      setImmediate(() => {
        conn.sessionUpdate({
          sessionId: s.id,
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'review', description: 'Review the diff', input: { hint: 'path' } }],
          },
        }).then(() => logCall({ method: 'pushed-commands', id: s.id }))
      })
    }
    return {
      sessionId: s.id,
      configOptions: configOptions(s),
      modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask' }, { id: 'code', name: 'Code' }] },
    }
  },
  async loadSession(params) {
    const s = readSession(params.sessionId)
    if (!s) throw new Error(`Unknown sessionId: ${params.sessionId}`)
    logCall({ method: 'load', id: s.id, ...noteMcpServers(s.id, params.mcpServers) })
    if (Array.isArray(s.history) && s.history.length > 0) {
      // 认领(A5)要的就是这份回放;普通恢复应当丢掉它。
      for (const update of historyUpdates(s.history)) await conn.sessionUpdate({ sessionId: s.id, update })
    } else {
      // 真 agent 会回放历史;onething 此刻没有队列接,应当丢掉。
      await conn.sessionUpdate({
        sessionId: s.id,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED' } },
      })
    }
    return { configOptions: configOptions({ ...s, model: 'alpha' }) }
  },
  async listSessions(params) {
    const all = listStoredSessions().filter(s => !params?.cwd || s.cwd === params.cwd)
    const pageSize = Math.max(1, Number(process.env.FAKE_AGENT_LIST_PAGE ?? 50))
    const start = params?.cursor ? Number(params.cursor) : 0
    const page = all.slice(start, start + pageSize)
    logCall({ method: 'list', cwd: params?.cwd ?? null, cursor: params?.cursor ?? null, count: page.length })
    return {
      sessions: page.map(s => ({
        sessionId: s.id,
        cwd: s.cwd,
        ...(s.title ? { title: s.title } : {}),
        ...(s.updatedAt ? { updatedAt: s.updatedAt } : {}),
      })),
      ...(start + pageSize < all.length ? { nextCursor: String(start + pageSize) } : {}),
    }
  },
  async unstable_forkSession(params) {
    const source = readSession(params.sessionId)
    if (!source) throw new Error(`Unknown sessionId: ${params.sessionId}`)
    const s = { ...source, id: randomUUID(), cwd: params.cwd, forkedFrom: source.id }
    writeSession(s)
    logCall({ method: 'fork', from: source.id, id: s.id, cwd: params.cwd, ...noteMcpServers(s.id, params.mcpServers) })
    return { sessionId: s.id, configOptions: configOptions(s) }
  },
  async resumeSession(params) {
    const s = readSession(params.sessionId)
    if (!s) throw new Error(`Unknown sessionId: ${params.sessionId}`)
    logCall({ method: 'resume', id: s.id, ...noteMcpServers(s.id, params.mcpServers) })
    return { configOptions: configOptions({ ...s, model: 'alpha' }) }
  },
  async setSessionMode(params) {
    logCall({ method: 'set-mode', id: params.sessionId, modeId: params.modeId })
    setImmediate(() => {
      conn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'current_mode_update', currentModeId: params.modeId },
      }).then(() => logCall({ method: 'pushed-mode', id: params.sessionId, modeId: params.modeId }))
    })
    return {}
  },
  async setSessionConfigOption(params) {
    const s = readSession(params.sessionId)
    s.model = params.value
    writeSession(s)
    logCall({ method: 'set', id: s.id, value: params.value })
    return { configOptions: configOptions(s) }
  },
  async prompt(params) {
    if (process.env.FAKE_AGENT_CLOSE_ON_PROMPT === '1') {
      logCall({ method: 'close-on-prompt', pid: process.pid })
      closeSync(1)
      setTimeout(() => process.exit(0), 10_000)
      return new Promise(() => {})
    }
    // 模拟 claude-agent-acp 登录过期:先吐一句正文,再以 authRequired 拒掉这一轮。
    if (process.env.FAKE_AGENT_FAIL === 'auth') {
      await conn.sessionUpdate({
        sessionId: params.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Failed to authenticate' } },
      })
      throw RequestError.authRequired()
    }
    if (process.env.FAKE_AGENT_FAIL === 'internal') throw new Error('boom from agent')
    if (!loggedIn()) throw RequestError.authRequired()
    const s = readSession(params.sessionId)
    s.turns += 1
    writeSession(s)
    if (process.env.FAKE_AGENT_RECORD_PROMPT === '1') {
      logCall({
        method: 'prompt-blocks',
        turn: s.turns,
        blocks: (params.prompt ?? []).map(block => ({ type: block.type, ...(block.type === 'text' ? { text: block.text.slice(0, 400) } : {}) })),
      })
    }
    // 剧本口令看的是**用户那一段**:persona 头块(`<persona>`)排在它前面时跳过去。
    const text = params.prompt?.filter(block => block.type === 'text').map(block => block.text).find(t => !t.startsWith('<persona>')) ?? ''
    if (process.env.FAKE_AGENT_PERMISSION === '1' && text.startsWith('@perm')) await permissionScript(conn, s, text.startsWith('@perm1') ? 1 : 2)
    if (process.env.FAKE_AGENT_FS === '1' && text.startsWith('@fs')) await fsScript(conn, s)
    if (process.env.FAKE_AGENT_TERMINAL === '1' && text.startsWith('@term')) await terminalScript(conn, s)
    if (process.env.FAKE_AGENT_ELICIT === '1' && text.startsWith('@elicit')) await elicitScript(conn, s)
    if (process.env.FAKE_AGENT_RICH_TOOLS === '1' && text.startsWith('@rich')) await richToolsScript(conn, s)
    if (process.env.FAKE_AGENT_USE_HOST_MCP === '1' && text.startsWith('@mcp')) await hostMcpScript(s)
    if (process.env.FAKE_AGENT_PLAN === '1' && text.startsWith('@plan-clear')) await planClearScript(conn, s)
    else if (process.env.FAKE_AGENT_PLAN === '1' && text.startsWith('@plan')) await planScript(conn, s)
    if (process.env.FAKE_AGENT_TITLE === '1' && text.startsWith('@title')) {
      await conn.sessionUpdate({ sessionId: s.id, update: { sessionUpdate: 'session_info_update', title: text.slice('@title'.length).trim() } })
    }
    const usage = process.env.FAKE_AGENT_USAGE === '1' && text.startsWith('@usage') ? await usageScript(conn, s) : undefined
    const rogue = process.env.FAKE_AGENT_ROGUE_METHOD === '1' && s.turns === 1
    if (rogue) {
      // 协议外请求:客户端没挂这个方法,SDK 该以 -32601 回绝;回绝不该掐断连接。
      try {
        const answer = await conn.extMethod('cursor/whatever', { probe: true })
        logCall({ method: 'rogue', id: s.id, answered: answer ?? null })
      } catch (error) {
        logCall({ method: 'rogue', id: s.id, code: error?.code ?? null, message: String(error?.message ?? error) })
      }
    }
    await conn.sessionUpdate({
      sessionId: s.id,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `session=${s.id} model=${s.model} turns=${s.turns}` },
      },
    })
    if (rogue) {
      await conn.sessionUpdate({
        sessionId: s.id,
        update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking about the file' } },
      })
      const toolCallId = `read-${s.turns}`
      await conn.sessionUpdate({
        sessionId: s.id,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: 'Read README.md',
          kind: 'read',
          status: 'pending',
          rawInput: { path: 'README.md' },
        },
      })
      await conn.sessionUpdate({
        sessionId: s.id,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'readme body' } }],
          rawOutput: { ok: true },
        },
      })
      logCall({ method: 'rogue-turn-done', id: s.id })
    }
    return { stopReason: 'end_turn', ...(usage ? { usage } : {}) }
  },
  async cancel() {},
  async authenticate(params) {
    logCall({ method: 'authenticate', methodId: params?.methodId ?? null })
    if (authMode === 'agent' && params?.methodId === 'fake-agent-login') writeFileSync(credentials, 'agent')
    return {}
  },
}), stream)
