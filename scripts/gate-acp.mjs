#!/usr/bin/env node
/**
 * `bun run gate:acp` —— ACP 接入的真机门(A0-4 立骨架 ①–④;方案
 * `docs/design/acp-integration-2026-09.md` §7 与 §11.1)。
 *
 * 它证的是**产物**:`dist/server/main.js` 起在一间临时 store 上,名册里只有一台假 agent
 * (`packages/onething-runtime/src/acp/__tests__/fixtures/fake-agent.mjs`,真子进程、真 ndjson
 * JSON-RPC,按环境变量剧本行事),全程只走 `POST /api/rpc` 与 `GET /api/events`,不 spawn 真 CLI。
 * 单测里的连接是同进程的;这道门照的是「装配好的 server 真的把 agent 起起来、真的把它说的话
 * 送到 SSE 与账本上」那条整链。
 *
 *   ① 握手:名册刚读进来时假 agent 是 `disconnected`(读名册不起进程);开过会话之后是
 *      `connected`,且 `capabilities` / `agentInfo` 与假 agent 在 `initialize` 里自报的逐字相同。
 *   ② 会话:绑了目录的会话发一条 → 假 agent 收到 `session/new` 且 `cwd` = 绑定目录;
 *      没绑目录的会话发一条 → 结构化拒发(那句提示落进助手消息,账本上这一轮
 *      `request/end.stopReason = 'error'`),假 agent 那边
 *      一条新的 `session/new` 都没有。
 *   ③ 流:SSE 上见到 `text-delta` 与 `reasoning-delta`;工具调用走到 `completed`,且结果是
 *      agent 自己给的(`externallyExecuted` 让本地不再执行一遍);假 agent 中途发的协议外请求 `cursor/whatever` 拿到 -32601,
 *      连接没断,这一轮照常收场(`stream:complete` + 正文落账)。
 *   ④ prompt 之外的状态:不发消息、只开会话(`acp.sessionOptions` 会 `ensureSession`),
 *      假 agent 在 `session/new` 答完后立刻推 `available_commands_update` —— 此刻没有任何
 *      prompt 在飞 —— `acp.sessionState` 里要有那条命令,SSE 上要见到带它的 `acp:session-state`。
 *
 * A2-a(方案 §7 ⑥⑦;同一台 `fake` 的第二轮走 `@rich` 剧本,读投影与账本):
 *   ⑥ diff:`tool_call_update` 带 `diff` → 工具卡 `changes` 有 `-beta` / `+BETA` / `+delta`、增 2 删 1,
 *      账本 `tool/result` 上有 `changes`;agent 自报的 `name`(edit_file)是工具名,`kind` 与
 *      `locations` 留在结局的 `metadata` 上。
 *   ⑦ terminal:假 agent 经终端桥真起一条终端,`terminal` 内容块里的 id = 工具卡结局 `metadata.terminalId`。
 *
 *
 * A3-b(方案 §7 ⑪–⑭ / ⑯;server 从这一单起也挂审批 / 文件 / 终端三只桥,门自己当应答者:订
 * SSE 上的 `permission:request`,按步发 `command:permission-respond`)。用第二台假 agent
 * `fake-a3`(不设 `unattended`,卡照常上),一轮一个剧本:
 *   ⑪ 四选项:`request_permission` 带四个选项 → 事件的 `choices` 四条;答 once → agent 收到 allow_once。
 *   ⑫ 始终允许:同一轮第二问答 always → agent 收到 allow_always,grant 落盘;下一轮同一件事
 *      两问都不上卡,agent 直接拿到 allow_once。
 *   ⑬ fs:cwd 内读成功;根外敏感文件上卡、门答 reject → agent 收到拒绝;写文件上卡(带 diff)、
 *      答 once → 落盘,账本上一条 `tool/audit`(acp-fs-write)。
 *   ⑭ terminal:`terminal/create` → `terminal.list` 里 owner 为这台 agent;`terminal/output` 与
 *      `terminal:data` 全局事件逐字一致且含 hi;kill 之后见到 `terminal:exit`。server 缺省没有
 *      终端输出通道,门以 `ONETHING_SERVER_TERMINAL=1` 打开那一格。
 *   ⑯ 无人应答:门不答那张卡 → `ONETHING_UNATTENDED_ASK_TIMEOUT_MS=2000` 后按拒绝收场,agent
 *      收到 reject_once,不是自动放行。
 *
 * A3-c(方案 §3.5 / §11.3;server 从这一单起也挂登录 / 提问两只桥):
 *   ⑮ 提问:`fake-a3` 的 `@elicit` 发一张 `elicitation/create` 表单(一道单选 + 一道自由输入)→
 *      SSE 上见到 `interaction:requested`,两道题的形状对;门经 `command:interaction-respond` 答
 *      Blue + 一句话 → agent 收到 `accept`,content 里是值 `b`(不是 label)与那句话。握手声明了
 *      `elicitation.form`。
 *   ⑯b 登录:第三台假 agent `fake-auth` 自报终端型登录;没登录时开会话被 `auth_required` 拒 →
 *      `acp.getAgents` 那一行 `auth.required === true`(SSE 上也有那一帧 `acp:agent-state`)→
 *      `acp.authenticate` 立刻答 terminalId,那一格终端(owner = 这台 agent)跑「起法 + `--login`」、
 *      退出码 0 → 行上 `auth.required === false` → 再发一条,这一轮走通。
 *
 * TODO(A4-b):⑰ 桥 / ⑱ 归因(方案 §7、§11.5)在这里还没有步骤 —— 它们要的是「假 agent 在
 * `session/new` 里**收到** `mcpServers`」,而把 `mintCredential` 的结果递进 `session/new` 是
 * A4-b 的 connector 接线。门外面没有、也不许有签凭据的 RPC,所以 A4-a 不在门里造一条假路;
 * 同一条链在单测级已经证了(真 backend + 真 `http.ts` + 真配方打出的 `acp-mcp-bridge.cjs` +
 * 真 MCP 客户端):`packages/backend/server/__tests__/host-mcp-face.test.ts`。A4-b 落地时
 * 在这里补:假 agent 拿到 stdio 那一条 → 起桥 → `tools/list` 有 `send_notification` →
 * `tools/call` 让 `agent:notification` 落在发起会话 → 关会话后同一把钥匙 401;
 * 反证:凭据换常量 → ⑱ 红。
 *
 * **必须用 node 起**(同 gate:search-index):server 的检索 Worker 要 `node:sqlite`,bun 没有。
 * 不构建:缺 `dist/server/main.js` 就叫你先 `bun run server:build`。
 * 绝不碰真 `~/.onething` —— 全程 `ONETHING_STORE_PATH` 指向 mkdtemp 出来的临时目录。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const fakeAgent = path.join(repoRoot, 'packages/onething-runtime/src/acp/__tests__/fixtures/fake-agent.mjs')
const AGENT_ID = 'fake'
/** A3-b 那几步用的第二台:同一只夹具,打开审批 / 文件 / 终端三条剧本,不设 `unattended`。 */
const A3_AGENT_ID = 'fake-a3'
/** ⑯b 用的第三台:自报终端型登录,没登录就拒开会话。 */
const AUTH_AGENT_ID = 'fake-auth'
/** ⑯ 的无人应答超时(毫秒);⑪–⑭ 门答卡远快于它。 */
const UNANSWERED_TIMEOUT_MS = 2000
/** 假 agent 在 `initialize` 里自报的两样(与夹具逐字对齐;夹具改了这里跟着改)。 */
const EXPECTED_CAPABILITIES = { loadSession: true, sessionCapabilities: {} }
const EXPECTED_AGENT_INFO = { name: 'fake-agent', version: '0.0.1' }
/** 假 agent 那次 `read` 工具的 `rawOutput`(同上,与夹具逐字对齐)。 */
const AGENT_TOOL_OUTPUT = { ok: true }

if (!fs.existsSync(serverEntry)) {
  console.error('[gate:acp] 缺 dist/server/main.js —— 先在仓根跑 `bun run server:build`')
  process.exit(1)
}

const failures = []
let child
let sse
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function check(condition, message) {
  if (condition) console.log(`  ok   ${message}`)
  else {
    failures.push(message)
    console.error(`  FAIL ${message}`)
  }
}

/** 键序无关的深比较:「逐字相同」比的是内容,不是 JSON 序列化时碰巧的键序。 */
function sameJson(a, b) {
  const canon = value => {
    if (Array.isArray(value)) return value.map(canon)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, canon(value[key])]))
    }
    return value
  }
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b))
}

async function waitForDiscovery(storePath, timeoutMs = 30_000) {
  const discoveryFile = path.join(storePath, 'run', 'http.json')
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (fs.existsSync(discoveryFile)) {
      try {
        const discovery = JSON.parse(fs.readFileSync(discoveryFile, 'utf-8'))
        if (discovery?.port) return discovery
      } catch {
        // 半写状态,下一拍再读。
      }
    }
    await sleep(200)
  }
  throw new Error('server did not publish its discovery file in time')
}

function createRpc(discovery) {
  const base = `http://127.0.0.1:${discovery.port}`
  const headers = {
    'content-type': 'application/json',
    ...(discovery.token ? { authorization: `Bearer ${discovery.token}` } : {}),
  }
  return async (domain, method, payload = {}) => {
    const response = await fetch(`${base}/api/rpc`, {
      method: 'POST', headers, body: JSON.stringify({ domain, method, payload }),
    })
    if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
    const body = await response.json()
    if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method}: ${JSON.stringify(body?.error ?? body)}`)
    return body.data
  }
}

/**
 * 订阅 `GET /api/events`(全部会话 + 全局事件),把每一帧解析成 `{ event, data }` 攒进数组。
 * 帧格式就是标准 SSE:`event:` / `data:` / 空行收一帧;`id:` 与注释行忽略。
 */
async function openEventStream(discovery) {
  const controller = new AbortController()
  const frames = []
  const response = await fetch(`http://127.0.0.1:${discovery.port}/api/events`, {
    headers: discovery.token ? { authorization: `Bearer ${discovery.token}` } : {},
    signal: controller.signal,
  })
  if (!response.ok || !response.body) throw new Error(`GET /api/events HTTP ${response.status}`)
  const decoder = new TextDecoder()
  let buffer = ''
  const pump = (async () => {
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })
        let cut
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          let event = 'message'
          const dataLines = []
          for (const line of raw.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
          }
          if (dataLines.length === 0) continue
          try {
            frames.push({ event, data: JSON.parse(dataLines.join('\n')) })
          } catch {
            frames.push({ event, data: dataLines.join('\n') })
          }
        }
      }
    } catch {
      // 门收尾时 abort 掉,这里吞掉那一下。
    }
  })()
  return { frames, close: async () => { controller.abort(); await pump } }
}

async function waitFor(predicate, budgetMs, stepMs = 100) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < budgetMs) {
    const value = await predicate()
    if (value) return value
    await sleep(stepMs)
  }
  return undefined
}

const readCalls = agentDir => {
  const file = path.join(agentDir, 'calls.log')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/** 一条会话:建、绑目录(可选)、模型指到 acp / 假 agent。 */
async function createAcpSession(rpc, name, workingDirectory, agentId = AGENT_ID) {
  const made = await rpc('sessions', 'create', { name })
  const sessionId = made?.session?.id
  if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(made)}`)
  if (workingDirectory) await rpc('sessions', 'updateWorkingDirectory', { sessionId, workingDirectory })
  await rpc('sessions', 'updateModel', { sessionId, provider: 'acp', model: agentId })
  return sessionId
}

/** SSE 上这条会话的 `permission:request` 帧(按到达先后)。 */
const permissionRequests = (frames, sessionId) => frames
  .filter(frame => frame.event === 'session:event' && frame.data?.sessionId === sessionId
    && frame.data?.event?.type === 'permission:request')
  .map(frame => frame.data.event)

/**
 * 门当应答者:每 50ms 扫一遍新到的 `permission:request`,问 `decide(event)` 要答案(返回
 * `undefined` = 这张不答),经通用 RPC 发 `command:permission-respond`。
 */
function startAnswerer(rpc, frames) {
  const answered = new Set()
  const answers = []
  let decide = () => undefined
  const timer = setInterval(() => {
    for (const frame of frames) {
      if (frame.event !== 'session:event' || frame.data?.event?.type !== 'permission:request') continue
      const event = frame.data.event
      if (answered.has(event.requestId)) continue
      const decision = decide(event, frame.data.sessionId)
      if (!decision) continue
      answered.add(event.requestId)
      answers.push({ requestId: event.requestId, type: event.permissionType, decision })
      rpc('session-command', 'emit', {
        sessionId: frame.data.sessionId,
        command: { type: 'command:permission-respond', requestId: event.requestId, toolCallId: event.toolCallId, decision },
      }).catch(error => console.error(`[gate:acp] permission-respond failed: ${error}`))
    }
  }, 50)
  return {
    answers,
    setDecider(next) { decide = next },
    stop() { clearInterval(timer) },
  }
}

async function sendMessage(rpc, sessionId, content) {
  await rpc('session-command', 'emit', {
    sessionId,
    command: { type: 'command:send-message', content, suppressTitleGeneration: true },
  })
}

async function lastAssistant(rpc, sessionId) {
  const got = await rpc('sessions', 'getMessages', { sessionId })
  const messages = got?.messages ?? got ?? []
  return [...messages].reverse().find(message => message.role === 'assistant')
}

/**
 * 一条会话的这一轮收场了没有:SSE 上见到它的 `stream:complete` 会话事件。
 * provider 那一侧的 `finish` 分片被引擎吃掉换成这条事件,不以分片形式出网。
 */
const finishSeen = (frames, sessionId) => frames.some(frame => frame.event === 'session:event'
  && frame.data?.sessionId === sessionId && frame.data?.event?.type === 'stream:complete')

/** 助手消息上所有的工具调用(投影可能挂在 `toolCalls` 或 `steps[].toolCalls` 上,两处都收)。 */
function toolCallsOf(message) {
  const calls = [...(message?.toolCalls ?? [])]
  for (const step of message?.steps ?? []) calls.push(...(step?.toolCalls ?? []))
  return calls
}

const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-acp-gate-'))
const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-acp-gate-work-')))
const agentDir = path.join(storePath, 'fake-agent')
const a3AgentDir = path.join(storePath, 'fake-agent-a3')
const authAgentDir = path.join(storePath, 'fake-agent-auth')
/** ⑬ 的「根外敏感文件」:一份假的私钥,放在会话目录之外的临时目录里 —— 门绝不去碰真的 `~/.ssh`。 */
const lonelyDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-acp-gate-lonely-')))
const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-acp-gate-outside-')))
const outsideSecret = path.join(outsideDir, '.ssh', 'id_rsa')

try {
  console.log(`[gate:acp] temp store: ${storePath}`)
  fs.writeFileSync(path.join(storePath, 'settings.json'), JSON.stringify({
    ai: {
      provider: 'acp',
      providers: { acp: { model: AGENT_ID, selectedModels: [AGENT_ID, A3_AGENT_ID, AUTH_AGENT_ID], enabled: true } },
      customProviders: [],
      modelCatalog: {},
    },
    acp: {
      enabled: true,
      // 名册的官方注册表不联网:门要确定性(A1-a 起 server 起来会在后台拉注册表)。
      registry: { enabled: false },
      agents: [{
        id: AGENT_ID,
        name: 'Fake',
        enabled: true,
        command: process.execPath,
        args: [fakeAgent],
        env: {
          FAKE_AGENT_CAPS: 'load',
          FAKE_AGENT_DIR: agentDir,
          FAKE_AGENT_PUSH_COMMANDS: '1',
          FAKE_AGENT_ROGUE_METHOD: '1',
          FAKE_AGENT_RICH_TOOLS: '1',
        },
        // ①–④ 不验审批:显式打开无人应答放行(A3-b 起桥里前置放行,不上卡)。
        unattended: 'allow',
      }, {
        id: A3_AGENT_ID,
        name: 'Fake A3',
        enabled: true,
        command: process.execPath,
        args: [fakeAgent],
        env: {
          FAKE_AGENT_CAPS: 'load',
          FAKE_AGENT_DIR: a3AgentDir,
          FAKE_AGENT_PERMISSION: '1',
          FAKE_AGENT_FS: '1',
          FAKE_AGENT_FS_OUTSIDE: outsideSecret,
          FAKE_AGENT_TERMINAL: '1',
          FAKE_AGENT_ELICIT: '1',
        },
      }, {
        id: AUTH_AGENT_ID,
        name: 'Fake Auth',
        enabled: true,
        command: process.execPath,
        args: [fakeAgent],
        env: {
          FAKE_AGENT_CAPS: 'none',
          FAKE_AGENT_DIR: authAgentDir,
          FAKE_AGENT_AUTH: 'terminal',
        },
        unattended: 'allow',
      }],
    },
    // 正常模式:A3-b 的卡要真的上屏(`dangerously-allow-all` 会让许可核一张都不问)。
    tools: { enableToolCalls: false, permissionMode: 'normal', tools: {} },
    diagnostics: { enabled: false },
  }, null, 2))

  child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ONETHING_STORE_PATH: storePath,
      ONETHING_SERVER_DATA_ROOT: storePath,
      ONETHING_SERVER_HOST: '127.0.0.1',
      ONETHING_SERVER_PORT: '',
      // ⑭:给这台 server 接上终端输出通道(缺省没有);⑯:无人应答兜底压到 2s。
      ONETHING_SERVER_TERMINAL: '1',
      ONETHING_UNATTENDED_ASK_TIMEOUT_MS: String(UNANSWERED_TIMEOUT_MS),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const serverOut = []
  child.stdout.on('data', chunk => serverOut.push(chunk.toString()))
  child.stderr.on('data', chunk => serverOut.push(chunk.toString()))

  const discovery = await waitForDiscovery(storePath)
  const rpc = createRpc(discovery)
  sse = await openEventStream(discovery)

  // ── ① 前半:读名册不起进程 ────────────────────────────────────────
  const fakeRow = async () => (await rpc('acp', 'getAgents', {}))?.agents?.find(agent => agent.config?.id === AGENT_ID)
  const before = await fakeRow()
  check(before?.status === 'disconnected',
    `① 名册读进来了,假 agent 还没起进程(status = ${before?.status ?? '不在名册里'})`)

  // ── ② 绑了目录的会话发一条 → session/new 的 cwd 就是绑定目录 ──────
  const boundId = await createAcpSession(rpc, 'acp 门 · 绑目录', workDir)
  await sendMessage(rpc, boundId, '你好,读一下 README')
  const boundDone = await waitFor(() => finishSeen(sse.frames, boundId), 20_000)
  const callsAfterBound = readCalls(agentDir)
  const newCalls = callsAfterBound.filter(call => call.method === 'new')
  check(newCalls.length === 1 && newCalls[0].cwd === workDir,
    `② 假 agent 收到 session/new,cwd = 绑定目录(读到 ${JSON.stringify(newCalls.map(call => call.cwd))})`)

  // ── ① 后半:开过会话之后 connected,握手自报逐字相同 ─────────────
  const after = await fakeRow()
  check(after?.status === 'connected', `① 开过会话之后 status = connected(读到 ${after?.status})`)
  check(sameJson(after?.capabilities, EXPECTED_CAPABILITIES),
    `① capabilities 与假 agent 自报逐字相同(读到 ${JSON.stringify(after?.capabilities)})`)
  check(sameJson(after?.agentInfo, EXPECTED_AGENT_INFO),
    `① agentInfo 与假 agent 自报逐字相同(读到 ${JSON.stringify(after?.agentInfo)})`)

  // ── ③ 流 ────────────────────────────────────────────────────────
  check(Boolean(boundDone), '③ 这一轮收场了(SSE 上见到 stream:complete)')
  const chunkTypes = new Set(sse.frames
    .filter(frame => frame.event === 'session:stream' && frame.data?.sessionId === boundId)
    .map(frame => frame.data.chunk?.type))
  check(chunkTypes.has('text-delta') && chunkTypes.has('reasoning-delta'),
    `③ SSE 上有 text-delta 与 reasoning-delta(见到 ${[...chunkTypes].join(' / ')})`)
  const rogue = callsAfterBound.find(call => call.method === 'rogue')
  check(rogue?.code === -32601,
    `③ 协议外请求 cursor/whatever 拿到 -32601(读到 ${JSON.stringify(rogue ?? null)})`)
  check(callsAfterBound.some(call => call.method === 'rogue-turn-done'),
    '③ 回绝之后连接没断:假 agent 把这一轮剩下的正文 / 思考 / 工具都送完了')
  const boundReply = await waitFor(async () => {
    const message = await lastAssistant(rpc, boundId)
    return typeof message?.content === 'string' && message.content.includes('turns=1') ? message : undefined
  }, 5_000)
  check(Boolean(boundReply), `③ 假 agent 的正文落进了助手消息(读到 ${JSON.stringify((await lastAssistant(rpc, boundId))?.content ?? null)})`)
  const toolCall = toolCallsOf(boundReply ?? await lastAssistant(rpc, boundId)).find(call => call.id === 'read-1')
  /*
   * `externallyExecuted` 是 agent 循环内部的标记(runner 据它跳过本地执行),不进投影、不出网,
   * 所以这里验它的**后果**:工具卡的结果恰是假 agent 自己给的 `rawOutput`。本地的 `read` 若真跑了,
   * 临时目录里没有 README.md,结果只会是一条「文件不存在」,不可能是 `{"ok":true}`。
   */
  // A2-a 起 ACP 工具的结局是 `{ output, metadata: { kind, … } }`(与内置工具同形,kind 供壳选 presenter),
  // agent 给的 `rawOutput` 在 `output` 里。
  const toolResultText = result => (typeof result === 'string' ? result : result?.output)
  check(toolCall?.status === 'completed' && toolResultText(toolCall?.result) === JSON.stringify(AGENT_TOOL_OUTPUT),
    `③ 工具调用走到终态 completed,结果是 agent 给的而非本地执行(externallyExecuted 生效;读到 ${JSON.stringify(toolCall
      ? { status: toolCall.status, result: toolCall.result } : null)})`)

  // ── ② 后半:没绑目录 → 结构化拒发,不起 agent 会话 ───────────────
  const unboundId = await createAcpSession(rpc, 'acp 门 · 未绑目录', undefined)
  await sendMessage(rpc, unboundId, '这条不该送到 agent')
  const refused = await waitFor(async () => {
    const message = await lastAssistant(rpc, unboundId)
    return typeof message?.content === 'string' && message.content.includes('未绑定工作目录') ? message : undefined
  }, 10_000)
  check(Boolean(refused),
    `② 未绑目录 → 结构化拒发,那句提示落进账本上的助手消息(读到 ${JSON.stringify((await lastAssistant(rpc, unboundId))?.content ?? null)})`)
  /*
   * 拒发在账本上的形状:没有单独的 `errorDetails` 格,落的是这一轮请求以 `error` 收场
   * (`request/end.stopReason = 'error'`)—— 与 provider 真失败同一套,读账本的人不必另认一种。
   */
  const ledgerFile = path.join(storePath, 'sessions', unboundId, 'events.jsonl')
  const ledger = fs.existsSync(ledgerFile)
    ? fs.readFileSync(ledgerFile, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  const requestEnd = ledger.find(record => record.type === 'request/end')
  check(requestEnd?.data?.stopReason === 'error',
    `② 账本上这一轮以 error 收场(request/end.stopReason = ${requestEnd?.data?.stopReason ?? '缺席'})`)
  const newAfterUnbound = readCalls(agentDir).filter(call => call.method === 'new').length
  check(newAfterUnbound === 1, `② 假 agent 那边没有第二条 session/new(共 ${newAfterUnbound} 条)`)

  // ── ④ prompt 之外推来的命令表 ────────────────────────────────────
  const idleId = await createAcpSession(rpc, 'acp 门 · 只开会话', workDir)
  const options = await rpc('acp', 'sessionOptions', { agentId: AGENT_ID, sessionId: idleId })
  const pushed = await waitFor(() => readCalls(agentDir).some(call => call.method === 'pushed-commands'
    && readCalls(agentDir).filter(c => c.method === 'new').length >= 2), 5_000)
  const hasReview = state => (state?.commands ?? []).some(command => command.name === 'review')
  const state = await waitFor(async () => {
    const read = await rpc('acp', 'sessionState', { sessionId: idleId })
    return hasReview(read) ? read : undefined
  }, 3_000)
  check(options?.success === true && Boolean(pushed),
    `④ 只开会话不发消息,假 agent 推了 available_commands_update(sessionOptions.success = ${options?.success})`)
  check(Boolean(state), `④ acp.sessionState 里有推来的命令 review(读到 ${JSON.stringify(
    (await rpc('acp', 'sessionState', { sessionId: idleId }))?.commands ?? null)})`)
  const frame = sse.frames.find(item => item.event === 'acp:session-state'
    && item.data?.state?.localSessionId === idleId && hasReview(item.data.state))
  check(Boolean(frame), '④ GET /api/events 上见到带这条命令的 acp:session-state 帧')

  // ── A2-a ⑥ diff / ⑦ terminal:同一台 `fake`(无人应答放行),第二轮走 `@rich` 剧本 ──────
  await sendMessage(rpc, boundId, '@rich 改一下 rich.txt 再跑个 echo')
  const richDone = await waitFor(() => sse.frames.filter(item => item.event === 'session:event'
    && item.data?.sessionId === boundId && item.data?.event?.type === 'stream:complete').length >= 2, 20_000)
  check(Boolean(richDone), '⑥ @rich 这一轮收场了')
  const richReply = await waitFor(async () => {
    const message = await lastAssistant(rpc, boundId)
    return toolCallsOf(message).some(call => call.id === 'rich-exec-2') ? message : undefined
  }, 5_000)
  const richCalls = toolCallsOf(richReply ?? await lastAssistant(rpc, boundId))
  const editCall = richCalls.find(call => call.id === 'rich-edit-2')
  const diffText = String(editCall?.changes?.diff ?? '')
  check(editCall?.toolName === 'edit_file' || editCall?.name === 'edit_file' || editCall?.toolId === 'edit_file',
    `⑥ agent 自报的 name 成了工具名(读到 ${JSON.stringify(editCall ? { toolName: editCall.toolName, toolId: editCall.toolId } : null)})`)
  check(diffText.includes('-beta') && diffText.includes('+BETA') && diffText.includes('+delta')
    && editCall?.changes?.additions === 2 && editCall?.changes?.deletions === 1,
    `⑥ tool_call_update 带 diff → 工具卡 changes 有旧 / 新两侧的行(读到 ${JSON.stringify(editCall?.changes ?? null)})`)
  check(sameJson(editCall?.result?.metadata?.locations, [{ path: path.join(workDir, 'rich.txt'), line: 3 }])
    && editCall?.result?.metadata?.kind === 'edit',
    `⑥ locations 与 kind 留在结局上(读到 ${JSON.stringify(editCall?.result?.metadata ?? null)})`)
  const richLedgerFile = path.join(storePath, 'sessions', boundId, 'events.jsonl')
  const richLedger = fs.existsSync(richLedgerFile)
    ? fs.readFileSync(richLedgerFile, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  const editResult = richLedger.find(record => record.type === 'tool/result' && record.data?.callId === 'rich-edit-2')
  check(Boolean(editResult?.data?.changes), `⑥ 账本 tool/result 上有 changes 一格(读到 ${JSON.stringify(editResult?.data?.changes ?? null)})`)
  const agentTerminal = readCalls(agentDir).find(call => call.method === 'rich-term')?.terminalId
  const execCall = richCalls.find(call => call.id === 'rich-exec-2')
  check(Boolean(agentTerminal) && agentTerminal !== 'fake-term' && execCall?.result?.metadata?.terminalId === agentTerminal,
    `⑦ terminal 内容块 → 工具卡带 terminalId(agent 经终端桥起的 ${agentTerminal ?? '缺席'};卡上 ${JSON.stringify(execCall?.result?.metadata ?? null)})`)

  // ── A3-b ⑪–⑭ / ⑯:门当应答者 ────────────────────────────────────
  const answerer = startAnswerer(rpc, sse.frames)
  const readA3Calls = () => readCalls(a3AgentDir)
  const a3Id = await createAcpSession(rpc, 'acp 门 · A3', workDir, A3_AGENT_ID)
  const turnDone = async (sessionId, count) => waitFor(() => sse.frames.filter(frame => frame.event === 'session:event'
    && frame.data?.sessionId === sessionId && frame.data?.event?.type === 'stream:complete').length >= count, 20_000)

  // ⑪ 第一问答 once,⑫ 第二问答 always。
  answerer.setDecider((event, sessionId) => {
    if (sessionId !== a3Id) return undefined
    return permissionRequests(sse.frames, a3Id).findIndex(item => item.requestId === event.requestId) === 0 ? 'once' : 'always'
  })
  await sendMessage(rpc, a3Id, '@perm 跑一下构建')
  check(Boolean(await turnDone(a3Id, 1)), '⑪ @perm 这一轮收场了')
  const firstCards = permissionRequests(sse.frames, a3Id)
  const choiceKinds = (firstCards[0]?.choices ?? []).map(choice => choice.kind).sort()
  check(sameJson(choiceKinds, ['always', 'once', 'reject', 'reject-always']),
    `⑪ permission:request 的 choices 四条(读到 ${JSON.stringify(firstCards[0]?.choices ?? null)})`)
  const permCalls = readA3Calls().filter(call => call.method === 'permission')
  check(permCalls[0]?.outcome?.optionId === 'opt-allow-once',
    `⑪ 答 once → agent 收到 allow_once 的 optionId(读到 ${JSON.stringify(permCalls[0]?.outcome ?? null)})`)
  check(permCalls[1]?.outcome?.optionId === 'opt-allow-always',
    `⑫ 答 always → agent 收到 allow_always 的 optionId(读到 ${JSON.stringify(permCalls[1]?.outcome ?? null)})`)
  const grantsFile = path.join(storePath, 'permissions', 'workspace-grants.json')
  const grantsText = fs.existsSync(grantsFile) ? fs.readFileSync(grantsFile, 'utf-8') : ''
  check(grantsText.includes('bash') && grantsText.includes(workDir),
    `⑫ grant 落盘(${fs.existsSync(grantsFile) ? `${grantsText.length} 字节` : 'workspace-grants.json 不在'})`)

  // ⑫ 下一轮同一件事:不上卡,agent 直接拿到 allow_once。
  const cardsBefore = permissionRequests(sse.frames, a3Id).length
  answerer.setDecider(() => undefined)
  await sendMessage(rpc, a3Id, '@perm 再跑一次')
  check(Boolean(await turnDone(a3Id, 2)), '⑫ 第二轮 @perm 收场了(没有卡挂住它)')
  const secondRound = readA3Calls().filter(call => call.method === 'permission' && call.turn === 2)
  check(permissionRequests(sse.frames, a3Id).length === cardsBefore,
    `⑫ 第二轮一张卡都没上(新增 ${permissionRequests(sse.frames, a3Id).length - cardsBefore} 张)`)
  check(secondRound.length === 2 && secondRound.every(call => call.outcome?.optionId === 'opt-allow-once'),
    `⑫ 第二轮两问都由 grant 放行,答 allow_once(读到 ${JSON.stringify(secondRound.map(call => call.outcome))})`)

  // ⑬ fs:根内读成功;根外敏感文件上卡 → 答 reject;写文件上卡 → 答 once。
  fs.writeFileSync(path.join(workDir, 'hello.txt'), 'hello from gate\n')
  fs.mkdirSync(path.dirname(outsideSecret), { recursive: true })
  fs.writeFileSync(outsideSecret, 'NOT A REAL KEY\n')
  const fsCardsBefore = permissionRequests(sse.frames, a3Id).length
  answerer.setDecider((event, sessionId) => {
    if (sessionId !== a3Id) return undefined
    if (event.permissionType === 'file_write' || event.permissionType === 'file_edit') return 'once'
    return 'reject'
  })
  await sendMessage(rpc, a3Id, '@fs 读写文件')
  check(Boolean(await turnDone(a3Id, 3)), '⑬ @fs 这一轮收场了')
  const fsCalls = readA3Calls()
  const insideRead = fsCalls.find(call => call.method === 'fs-read')
  check(insideRead?.ok === true && insideRead.content === 'hello from gate\n',
    `⑬ cwd 内的 hello.txt 读成功(读到 ${JSON.stringify(insideRead ?? null)})`)
  const fsCards = permissionRequests(sse.frames, a3Id).slice(fsCardsBefore)
  const outsideCard = fsCards.find(card => card.permissionType === 'external_directory' || card.permissionType === 'sensitive_file_read')
  const outsideRead = fsCalls.find(call => call.method === 'fs-read-outside')
  check(Boolean(outsideCard) && outsideRead?.ok === false,
    `⑬ 根外敏感文件上卡(${outsideCard?.permissionType ?? '没见到卡'}),答 reject 后 agent 被拒(读到 ${JSON.stringify(outsideRead ?? null)})`)
  const writeCard = fsCards.find(card => card.permissionType === 'file_write')
  const written = path.join(workDir, 'written-by-agent.txt')
  check(Boolean(writeCard?.metadata?.diff) && fs.existsSync(written) && fs.readFileSync(written, 'utf-8') === 'written by agent\n',
    `⑬ 写文件上卡带 diff、答 once 后落盘(卡 ${writeCard ? '在' : '缺'},diff ${writeCard?.metadata?.diff ? '在' : '缺'},文件 ${fs.existsSync(written) ? '在' : '缺'})`)
  const a3Ledger = path.join(storePath, 'sessions', a3Id, 'events.jsonl')
  const auditRow = fs.existsSync(a3Ledger)
    ? fs.readFileSync(a3Ledger, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      .find(record => record.type === 'tool/audit' && record.data?.toolId === 'acp-fs-write')
    : undefined
  check(auditRow?.data?.outcome === 'ok', `⑬ 账本上一条 tool/audit(acp-fs-write,读到 ${JSON.stringify(auditRow?.data ?? null)})`)

  // ⑭ terminal:起命令的卡答 once;门从 terminal.list 里找到那一格、attach 上去看 terminal:data。
  answerer.setDecider((event, sessionId) => (sessionId === a3Id ? 'once' : undefined))
  await sendMessage(rpc, a3Id, '@term 起个终端')
  const listed = await waitFor(async () => {
    const list = await rpc('terminal', 'list', {})
    return list?.terminals?.find(terminal => terminal.owner?.kind === 'acp' && terminal.owner?.agentId === A3_AGENT_ID)
  }, 15_000, 50)
  check(listed?.owner?.sessionId === a3Id,
    `⑭ terminal.list 里出现 owner = { kind: 'acp', agentId: ${A3_AGENT_ID} } 的一格(读到 ${JSON.stringify(listed?.owner ?? null)})`)
  const attached = listed ? await rpc('terminal', 'attach', { terminalId: listed.id }) : undefined
  check(Boolean(await turnDone(a3Id, 4)), '⑭ @term 这一轮收场了')
  const termCalls = readA3Calls()
  const termOutput = termCalls.find(call => call.method === 'term-output')
  const bySeq = new Map()
  for (const chunk of attached?.chunks ?? []) bySeq.set(chunk.seq, chunk.data)
  const dataFrames = sse.frames.filter(frame => frame.event === 'terminal:data' && frame.data?.terminalId === listed?.id)
  for (const frame of dataFrames) bySeq.set(frame.data.seq, frame.data.data)
  const streamed = [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]).join('')
  check(Boolean(termOutput) && termOutput.output.includes('hi') && termOutput.output === streamed && dataFrames.length > 0,
    `⑭ terminal/output 含 hi,且与 terminal:data 事件(${dataFrames.length} 帧)逐字一致(output ${JSON.stringify(termOutput?.output ?? null)} / 事件 ${JSON.stringify(streamed)})`)
  check(termOutput?.exit?.exitCode === 0, `⑭ wait_for_exit 答退出码 0(读到 ${JSON.stringify(termOutput?.exit ?? null)})`)
  const killed = termCalls.find(call => call.method === 'term-killed')
  const exitFrame = killed
    ? sse.frames.find(frame => frame.event === 'terminal:exit' && frame.data?.terminalId === killed.terminalId)
    : undefined
  check(Boolean(killed?.exit?.signal || killed?.exit?.exitCode !== 0) && Boolean(exitFrame),
    `⑭ kill 之后 agent 等到结局,SSE 上见到 terminal:exit(结局 ${JSON.stringify(killed?.exit ?? null)},事件 ${exitFrame ? '在' : '缺'})`)
  const capsFile = path.join(a3AgentDir, 'client-caps.json')
  const a3Caps = fs.existsSync(capsFile) ? JSON.parse(fs.readFileSync(capsFile, 'utf-8')) : null
  check(a3Caps?.terminal === true && a3Caps?.fs?.readTextFile === true && a3Caps?.fs?.writeTextFile === true,
    `⑭ 握手声明了 fs 两条与 terminal(读到 ${JSON.stringify(a3Caps)})`)
  check(!termCalls.some(call => call.method === 'term-error'),
    `⑭ 终端剧本没有报错(${JSON.stringify(termCalls.find(call => call.method === 'term-error') ?? null)})`)

  // ⑮ 提问:门从 SSE 上接 `interaction:requested`,按题 id 作答。
  const interactionRequests = sessionId => sse.frames
    .filter(frame => frame.event === 'session:event' && frame.data?.sessionId === sessionId
      && frame.data?.event?.type === 'interaction:requested')
    .map(frame => frame.data.event.request)
  answerer.setDecider(() => undefined)
  await sendMessage(rpc, a3Id, '@elicit 问两句')
  const elicitCard = await waitFor(() => interactionRequests(a3Id)[0], 15_000, 50)
  const colorQuestion = elicitCard?.questions?.find(question => question.id === 'color')
  const noteQuestion = elicitCard?.questions?.find(question => question.id === 'note')
  check(colorQuestion?.options?.map(option => option.label).join('/') === 'Red/Blue'
    && colorQuestion.options[1]?.description === 'the blue one'
    && noteQuestion?.allowFreeText === true && (noteQuestion.options ?? []).length === 0
    && elicitCard.origin === 'external-agent',
    `⑮ elicitation/create → interaction:requested:一道单选(Red / Blue,claude 扩展格的说明上卡)+ 一道自由输入(读到 ${JSON.stringify(elicitCard?.questions ?? null)})`)
  if (elicitCard) {
    await rpc('session-command', 'emit', {
      sessionId: a3Id,
      command: {
        type: 'command:interaction-respond',
        interactionId: elicitCard.id,
        ...(elicitCard.targetChannel ? { channel: elicitCard.targetChannel } : {}),
        answers: { color: { selected: ['Blue'] }, note: { selected: [], freeText: 'from gate' } },
      },
    })
  }
  check(Boolean(await turnDone(a3Id, 5)), '⑮ @elicit 这一轮收场了')
  const elicitCall = readA3Calls().find(call => call.method === 'elicit')
  check(sameJson(elicitCall?.response, { action: 'accept', content: { color: 'b', note: 'from gate' } }),
    `⑮ agent 收到 accept,content 是值 b(不是 label)与那句话(读到 ${JSON.stringify(elicitCall ?? null)})`)
  const a3CapsNow = fs.existsSync(capsFile) ? JSON.parse(fs.readFileSync(capsFile, 'utf-8')) : null
  check(sameJson(a3CapsNow?.elicitation, { form: {}, url: {} }) && a3CapsNow?.auth?.terminal === true,
    `⑮ 握手声明了 elicitation { form, url } 与 auth.terminal(读到 ${JSON.stringify({ elicitation: a3CapsNow?.elicitation, auth: a3CapsNow?.auth })})`)

  // ⑯ 无人应答:这一张门不答 → 超时按拒绝收场,agent 收到 reject_once。换一个目录开新会话:
  // ⑫ 在 workDir 上落的 grant 会把同一条命令直接放行,那就证不到「没人答」这一支了。
  const lonelyId = await createAcpSession(rpc, 'acp 门 · 无人应答', lonelyDir, A3_AGENT_ID)
  answerer.setDecider(() => undefined)
  await sendMessage(rpc, lonelyId, '@perm1 没人会答这张')
  check(Boolean(await turnDone(lonelyId, 1)), '⑯ @perm1 这一轮收场了(没有永远挂着)')
  // 这一问是假 agent 记下的最后一条审批(之前几轮的都早于它)。
  const lonely = readA3Calls().filter(call => call.method === 'permission').slice(-1)
  check(permissionRequests(sse.frames, lonelyId).length > 0,
    '⑯ 那张卡真的上了(桥在 server 上注册了,请求进了许可系统)')
  check(lonely[0]?.outcome?.optionId === 'opt-reject-once'
    && lonely[0].ms >= UNANSWERED_TIMEOUT_MS - 200 && lonely[0].ms < UNANSWERED_TIMEOUT_MS + 5000,
    `⑯ 无人应答 ${UNANSWERED_TIMEOUT_MS}ms 后按拒绝收场,agent 收到 reject_once、不是自动放行(读到 ${JSON.stringify(lonely[0] ?? null)})`)
  answerer.stop()

  // ⑯b 登录:没登录 → 开会话被拒 → required;去登录(终端型)→ 退出码 0 → 不再 required → 这一轮走通。
  const authRow = async () => (await rpc('acp', 'getAgents', {}))?.agents?.find(agent => agent.config?.id === AUTH_AGENT_ID)
  const authId = await createAcpSession(rpc, 'acp 门 · 登录', workDir, AUTH_AGENT_ID)
  await sendMessage(rpc, authId, '没登录的这一轮')
  const required = await waitFor(async () => ((await authRow())?.auth?.required === true ? authRow() : undefined), 15_000)
  check(Boolean(required) && required.auth.methods?.[0]?.id === 'fake-terminal-login' && required.auth.methods[0].type === 'terminal',
    `⑯b 开会话被 auth_required 拒 → 行上 auth.required = true,方法表是 agent 自报的那一条(读到 ${JSON.stringify((await authRow())?.auth ?? null)})`)
  check(sse.frames.some(frame => frame.event === 'acp:agent-state' && frame.data?.state?.config?.id === AUTH_AGENT_ID
    && frame.data.state.auth?.required === true),
    '⑯b SSE 上见到 auth.required = true 的 acp:agent-state(壳就是这样知道的)')
  check(!readCalls(authAgentDir).some(call => call.method === 'new'),
    `⑯b 没登录时 agent 那边一条会话都没开成(new-refused ${readCalls(authAgentDir).filter(call => call.method === 'new-refused').length} 次)`)
  const login = await rpc('acp', 'authenticate', { agentId: AUTH_AGENT_ID, methodId: 'fake-terminal-login' })
  check(login?.ok === true && typeof login.terminalId === 'string',
    `⑯b acp.authenticate 立刻答 terminalId(读到 ${JSON.stringify(login)})`)
  const loginExit = login?.terminalId
    ? await waitFor(() => sse.frames.find(frame => frame.event === 'terminal:exit' && frame.data?.terminalId === login.terminalId), 15_000, 50)
    : undefined
  check(loginExit?.data?.exitCode === 0
    && readCalls(authAgentDir).some(call => call.method === 'terminal-login' && call.mark === 'from-method'),
    `⑯b 那一格终端跑「起法 + --login」(方法的 env 也到了),退出码 0(结局 ${JSON.stringify(loginExit?.data ?? null)})`)
  const cleared = await waitFor(async () => ((await authRow())?.auth?.required === false ? true : undefined), 10_000)
  check(Boolean(cleared), `⑯b 退出码 0 → 行上 auth.required = false(读到 ${JSON.stringify((await authRow())?.auth ?? null)})`)
  await sendMessage(rpc, authId, '登录之后的这一轮')
  const authReply = await waitFor(async () => {
    const message = await lastAssistant(rpc, authId)
    return typeof message?.content === 'string' && message.content.includes('turns=1') ? message : undefined
  }, 20_000)
  check(Boolean(authReply), `⑯b 登录之后这一轮走通(读到 ${JSON.stringify((await lastAssistant(rpc, authId))?.content ?? null)})`)

  // 名册刷新走一趟(RPC `acp.refreshRegistry` = 强制重拉 + 探测):开关关着就只重读种子与探测,
  // 不联网 —— 收尾那一步从日志上核「一次拉取都没有」。server 宿主不调 `acp.start()`,
  // 不走这一趟的话那条核对永远是空转。
  const refreshed = await rpc('acp', 'refreshRegistry', {})
  check(refreshed?.success === true && refreshed.agents?.some(agent => agent.config?.id === AGENT_ID),
    `名册刷新成功,假 agent 仍在名册里(success = ${refreshed?.success})`)

  // ── 收尾:SIGTERM,零残留 ───────────────────────────────────────
  await sse.close()
  sse = undefined
  child.kill('SIGTERM')
  for (let i = 0; i < 100 && child.exitCode === null && child.signalCode === null; i += 1) await sleep(100)
  check(child.exitCode !== null || child.signalCode !== null, '收尾:server SIGTERM 10s 内退出')
  const leftovers = spawnSync('pgrep', ['-f', fakeAgent], { encoding: 'utf-8' })
  check(!(leftovers.status === 0 && leftovers.stdout.trim()),
    `收尾:假 agent 零残留进程${leftovers.stdout.trim() ? `(见到 ${leftovers.stdout.trim()})` : ''}`)

  // 注册表开关关着 → 进程里一次联网尝试都不该有(registry.ts 每次联网前记 `acp registry fetching`)。
  const logDir = path.join(storePath, 'log')
  const logText = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).filter(name => name.endsWith('.jsonl'))
      .map(name => fs.readFileSync(path.join(logDir, name), 'utf-8')).join('')
    : ''
  check(logText.length > 0 && !logText.includes('acp registry fetching'),
    `收尾:注册表开关关着,server 日志里没有一次注册表拉取(日志 ${logText.length} 字节)`)

  if (failures.length > 0) console.error(`[gate:acp] server 输出尾:\n${serverOut.slice(-40).join('')}`)
} catch (error) {
  failures.push(String(error?.stack || error))
  console.error(`[gate:acp] ${error?.stack || error}`)
} finally {
  if (sse) await sse.close().catch(() => {})
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await sleep(800)
    try { child.kill('SIGKILL') } catch { /* 已经没了就算了 */ }
  }
  fs.rmSync(storePath, { recursive: true, force: true })
  fs.rmSync(workDir, { recursive: true, force: true })
  fs.rmSync(outsideDir, { recursive: true, force: true })
  fs.rmSync(lonelyDir, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`[gate:acp] ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('[gate:acp] ok —— ① 握手 / ② 会话目录 / ③ 流与协议外请求 / ④ prompt 之外的状态 / ⑥ diff / ⑦ terminal / ⑪ 四选项 / ⑫ 始终允许 / ⑬ fs / ⑭ terminal / ⑮ 提问 / ⑯ 无人应答 / ⑯b 登录 全绿')
