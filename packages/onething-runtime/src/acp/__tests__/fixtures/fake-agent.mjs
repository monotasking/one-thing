// 一台最小的 ACP agent(测试夹具):真子进程、真 ndjson JSON-RPC。
// 会话存在 FAKE_AGENT_DIR 下的 JSON 里,所以进程重启之后还能 load 回来 ——
// 这正是「会话在 agent 自己那里」那件事的缩影。
// FAKE_AGENT_CAPS = 'load' | 'resume' | 'none' 决定它声明哪种恢复能力。
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
import { AgentSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'
import { closeSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const dir = process.env.FAKE_AGENT_DIR
const caps = process.env.FAKE_AGENT_CAPS ?? 'load'
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

const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))
new AgentSideConnection(conn => ({
  async initialize(params) {
    logCall({ method: 'init', proxy: process.env.HTTPS_PROXY ?? null })
    // 另写一个文件,不进 calls.log(别的用例逐条比对那张表)。
    writeFileSync(join(dir, 'client-caps.json'), JSON.stringify(params?.clientCapabilities ?? null))
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: caps === 'load',
        sessionCapabilities: caps === 'resume' ? { resume: {} } : {},
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
    logCall({ method: 'new', id: s.id, cwd: params.cwd })
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
    logCall({ method: 'load', id: s.id })
    // 真 agent 会回放历史;onething 此刻没有队列接,应当丢掉。
    await conn.sessionUpdate({
      sessionId: s.id,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED' } },
    })
    return { configOptions: configOptions({ ...s, model: 'alpha' }) }
  },
  async resumeSession(params) {
    const s = readSession(params.sessionId)
    if (!s) throw new Error(`Unknown sessionId: ${params.sessionId}`)
    logCall({ method: 'resume', id: s.id })
    return { configOptions: configOptions({ ...s, model: 'alpha' }) }
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
    const text = params.prompt?.find(block => block.type === 'text')?.text ?? ''
    if (process.env.FAKE_AGENT_PERMISSION === '1' && text.startsWith('@perm')) await permissionScript(conn, s, text.startsWith('@perm1') ? 1 : 2)
    if (process.env.FAKE_AGENT_FS === '1' && text.startsWith('@fs')) await fsScript(conn, s)
    if (process.env.FAKE_AGENT_TERMINAL === '1' && text.startsWith('@term')) await terminalScript(conn, s)
    if (process.env.FAKE_AGENT_ELICIT === '1' && text.startsWith('@elicit')) await elicitScript(conn, s)
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
    return { stopReason: 'end_turn' }
  },
  async cancel() {},
  async authenticate(params) {
    logCall({ method: 'authenticate', methodId: params?.methodId ?? null })
    if (authMode === 'agent' && params?.methodId === 'fake-agent-login') writeFileSync(credentials, 'agent')
    return {}
  },
}), stream)
