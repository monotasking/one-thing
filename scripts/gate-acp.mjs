#!/usr/bin/env node
/**
 * `bun run gate:acp` —— ACP 接入的真机门(A0-4 立骨架 ①–④;方案
 * `docs/design/acp-integration-2026-09.md` §7 与 §11.1)。
 *
 * 它证的是**产物**:`dist/server/main.js` 起在一间临时 store 上,名册里只有一台假 agent
 * (`packages/backend/acp/__tests__/fixtures/fake-agent.mjs`,真子进程、真 ndjson
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
 * A2-b(方案 §3.3 / §11.6;三只投影 + 切模式,同一台 `fake`):
 *   ⑧ 计划:`@plan` → 假 agent 推两版 `plan_update` → 待办域 `session-ai-todo` 的行跟着第二版走
 *      (`todo-plan.get` 读得到 `- [x]` / 进行中 / `- [ ]` 三行);`@plan-clear` → `plan_removed` → 那份清掉。
 *   ⑨ 用量:`@usage` → `usage_update` 进 `acp.sessionState(...).usage`(SSE 上也有那一帧);这一轮收场 →
 *      usage 账本(`<store>/usage/usage-YYYY-MM.jsonl`)上这条会话恰一行,`source: 'acp'`、思考 / 缓存
 *      两格在、厂商报价 = 这一轮的累计成本增量、本地估价 `costUSD: null`。
 *   ⑩ 切模式:`acp.setSessionMode` → 假 agent 收到 `session/set_mode`,推回 `current_mode_update`;
 *      答复与 `acp.sessionState` 的 `modes.current` 都是新值,SSE 上有带新模式的 `acp:session-state`。
 *   反证:挖掉计划投影的订阅 → ⑧ 红。
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
 * A4-b(方案 §3.6 / §7 ⑰⑱ / §11.5;宿主工具面接到运行时):`fake` 打开 `FAKE_AGENT_USE_HOST_MCP`,
 * 一条新会话发 `@mcp`:
 *   ⑰ 桥:这条会话的 `session/new` 里 `mcpServers` 有一条 stdio 的 `onething`(command = server 的 node,
 *      args = 本机 `acp-mcp-bridge.cjs`,env 带 URL 与桥凭据);假 agent 照它起桥、用真 MCP 客户端
 *      `tools/list` 见到 `send_notification`、`tools/call` 不报错。
 *   ⑱ 归因:SSE 上见到 `agent:notification`,`sessionId` = 发起那条会话、`agentId` = fake(都不从参数收);
 *      门拿假 agent 记下的那枚桥凭据直接打 `POST /api/rpc host-mcp.listTools` —— 会话在时 200、删掉之后 401
 *      (删会话 → `session:` 资源 `deleted` → `AcpSubsystem` 作废那条会话名下的凭据)。
 *   反证:`serversFor` 答空表 → ⑰ 红;删会话不作废 → ⑱ 的 401 红。
 *
 * A5(方案 §3.7 / §7 ⑲–㉑ / §11.6;会话生命):
 *   ⑲ 崩溃重连 + 退避:第四台 `fake-crash`。发一条 → `kill -9` 它的进程(pid 取自 `acp.getAgents`)→
 *      `acp:agent-state` 推来 `error` → 下一条消息自动重连并 `session/load` 回原会话(calls.log);
 *      30s 内再崩再发两轮照样重连;第 4 次崩之后那一条被拒(`errorDetails` 里是退避那句话),
 *      行上 `backoff.latched === true`,假 agent 那边**没有**新的 `init`(没起新进程);
 *      `acp.reconnectAgent` 清锁,再发一条照常走通。
 *   ⑳ 认领:第五台 `fake-remote`(`FAKE_AGENT_CAPS=list,fork,load`,每页 1 条)目录里预置两条带历史的
 *      会话 → `acp.listRemoteSessions` 翻页列出这两条 → `acp.adoptSession` 建本地会话,账本上
 *      `message/imported` ≥ 4 条、`imported` 与之相符,本地会话绑了那条的目录、模型指到这台 agent;
 *      再认领一次答同一个 sessionId、`alreadyAdopted: true`;列表上那一条带 `adoptedSessionId`;
 *      在认领来的会话上发一条,agent 在**那条**会话上答(不 `session/new`)。
 *   ㉑ 分叉:`acp.forkSession` → 新本地会话(带着本地历史),假 agent 收到 `session/fork`(源 = 认领的
 *      那条),链接表里新会话的 agent 会话 id ≠ 源的;在分叉上发一条,agent 在 fork 出来的那条上答。
 *   反证:挖掉退避 → ⑲「第 4 次仍在重连」红;挖掉认领查重 → ⑳「再认领答同一条」红。
 *
 * A6-a ㉒(opt-in `ONETHING_GATE_REAL_ACP=1`,否则一行 `skipped`):种子名册里的真 `claude-agent-acp`,
 *   在另一间临时 store 上把 §5 A6 对等清单逐行跑一遍 —— 细则见文件末 `runRealClaudeParity` 的注释。
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
const fakeAgent = path.join(repoRoot, 'packages/backend/acp/__tests__/fixtures/fake-agent.mjs')
const AGENT_ID = 'fake'
/** A3-b 那几步用的第二台:同一只夹具,打开审批 / 文件 / 终端三条剧本,不设 `unattended`。 */
const A3_AGENT_ID = 'fake-a3'
/** ⑯b 用的第三台:自报终端型登录,没登录就拒开会话。 */
const AUTH_AGENT_ID = 'fake-auth'
/** ⑲ 用的第四台:只为被 kill -9。 */
const CRASH_AGENT_ID = 'fake-crash'
/** ⑳㉑ 用的第五台:自报 list / fork / load,目录里预置两条带历史的会话。 */
const REMOTE_AGENT_ID = 'fake-remote'
/** 退避那句话里一定有的几个字(`acp/acp-reconnect-backoff.ts` 的 `acpReconnectRefusal`)。 */
const BACKOFF_REFUSAL = 'automatic reconnect is paused'
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
const crashAgentDir = path.join(storePath, 'fake-agent-crash')
const remoteAgentDir = path.join(storePath, 'fake-agent-remote')
/** ⑬ 的「根外敏感文件」:一份假的私钥,放在会话目录之外的临时目录里 —— 门绝不去碰真的 `~/.ssh`。 */
const lonelyDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-acp-gate-lonely-')))
const outsideDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-acp-gate-outside-')))
const outsideSecret = path.join(outsideDir, '.ssh', 'id_rsa')

try {
  console.log(`[gate:acp] temp store: ${storePath}`)
  fs.writeFileSync(path.join(storePath, 'settings.json'), JSON.stringify({
    ai: {
      provider: 'acp',
      providers: { acp: { model: AGENT_ID, selectedModels: [AGENT_ID, A3_AGENT_ID, AUTH_AGENT_ID, CRASH_AGENT_ID, REMOTE_AGENT_ID], enabled: true } },
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
          FAKE_AGENT_USE_HOST_MCP: '1',
          FAKE_AGENT_PLAN: '1',
          FAKE_AGENT_USAGE: '1',
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
      }, {
        id: CRASH_AGENT_ID,
        name: 'Fake Crash',
        enabled: true,
        command: process.execPath,
        args: [fakeAgent],
        env: { FAKE_AGENT_CAPS: 'load', FAKE_AGENT_DIR: crashAgentDir },
        unattended: 'allow',
      }, {
        id: REMOTE_AGENT_ID,
        name: 'Fake Remote',
        enabled: true,
        command: process.execPath,
        args: [fakeAgent],
        env: { FAKE_AGENT_CAPS: 'list,fork,load', FAKE_AGENT_DIR: remoteAgentDir, FAKE_AGENT_LIST_PAGE: '1' },
        unattended: 'allow',
      }],
    },
    // 正常模式:A3-b 的卡要真的上屏(`dangerously-allow-all` 会让许可核一张都不问)。
    tools: { enableToolCalls: false, permissionMode: 'normal', tools: {} },
    diagnostics: { enabled: false },
  }, null, 2))

  // ⑳:fake-remote 自己那边已经有两条会话(onething 从没见过),带着要回放的历史。
  fs.mkdirSync(remoteAgentDir, { recursive: true })
  const REMOTE_SESSIONS = [
    {
      id: 'remote-one', cwd: workDir, model: 'alpha', turns: 2, title: 'Remote one', updatedAt: '2026-09-20T10:00:00Z',
      history: [
        { kind: 'user', text: 'remote question one' },
        { kind: 'thought', text: 'remote thinking' },
        { kind: 'agent', text: 'remote answer one' },
        { kind: 'tool', id: 'remote-tool-1', title: 'Read notes.md', input: { path: 'notes.md' } },
        { kind: 'user', text: 'remote question two' },
        { kind: 'agent', text: 'remote answer two' },
        { kind: 'title', text: 'Remote one' },
      ],
    },
    {
      id: 'remote-two', cwd: workDir, model: 'alpha', turns: 1, title: 'Remote two',
      history: [{ kind: 'user', text: 'second session' }, { kind: 'agent', text: 'second answer' }],
    },
  ]
  for (const session of REMOTE_SESSIONS) {
    fs.writeFileSync(path.join(remoteAgentDir, `${session.id}.json`), JSON.stringify(session))
  }

  child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ONETHING_STORE_PATH: storePath, ONETHING_CREDENTIALS_KEYRING: 'file',
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

  // ── A2-b ⑧ 计划 → 待办 ──────────────────────────────────────────
  const planId = await createAcpSession(rpc, 'acp 门 · 计划', workDir)
  const aiTodo = async () => (await rpc('todo-plan', 'get', { sessionId: planId }))?.snapshot?.sessionAiTodo
  await sendMessage(rpc, planId, '@plan 列个计划')
  await waitFor(() => finishSeen(sse.frames, planId), 20_000)
  const expectedRows = ['- [x] **Read the code**', '- [ ] Write the patch _(进行中)_', '- [ ] Run the tests']
  const planDoc = await waitFor(async () => {
    const doc = await aiTodo()
    return expectedRows.every(row => String(doc?.content ?? '').includes(row)) ? doc : undefined
  }, 5_000)
  check(Boolean(planDoc) && planDoc.totalTasks === 3,
    `⑧ plan_update 两版 → session-ai-todo 的三行跟着第二版走(读到 ${JSON.stringify((await aiTodo())?.content ?? null)})`)
  const planStateFrame = sse.frames.find(item => item.event === 'acp:session-state'
    && item.data?.state?.localSessionId === planId && item.data.state.plan?.kind === 'items')
  check(Boolean(planStateFrame), '⑧ SSE 上见到带计划的 acp:session-state 帧')
  await sendMessage(rpc, planId, '@plan-clear 计划做完了')
  await waitFor(() => sse.frames.filter(item => item.event === 'session:event' && item.data?.sessionId === planId
    && item.data?.event?.type === 'stream:complete').length >= 2, 20_000)
  const planCleared = await waitFor(async () => ((await aiTodo()) ? undefined : true), 5_000)
  check(Boolean(planCleared), `⑧ plan_removed → 那份 AI 待办清掉了(读到 ${JSON.stringify((await aiTodo())?.content ?? null)})`)

  // ── A2-b ⑨ 用量 ──────────────────────────────────────────────────
  const usageId = await createAcpSession(rpc, 'acp 门 · 用量', workDir)
  await sendMessage(rpc, usageId, '@usage 算个账')
  await waitFor(() => finishSeen(sse.frames, usageId), 20_000)
  const usageState = await rpc('acp', 'sessionState', { sessionId: usageId })
  check(sameJson(usageState?.usage, { used: 1234, size: 200000, cost: { amount: 0.25, currency: 'USD' } }),
    `⑨ usage_update → acp.sessionState.usage(读到 ${JSON.stringify(usageState?.usage ?? null)})`)
  check(sse.frames.some(item => item.event === 'acp:session-state' && item.data?.state?.localSessionId === usageId
    && item.data.state.usage?.used === 1234), '⑨ SSE 上见到带用量的 acp:session-state 帧')
  const usageDir = path.join(storePath, 'usage')
  const usageRows = () => (fs.existsSync(usageDir)
    ? fs.readdirSync(usageDir).filter(name => /^usage-.*\.jsonl$/.test(name))
      .flatMap(name => fs.readFileSync(path.join(usageDir, name), 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line)))
    : []).filter(row => row.sessionId === usageId)
  // 账本是排队追加的;见到第一行之后再等一拍,确认不会冒出第二行(同一轮两行账就是双写)。
  await waitFor(() => usageRows().length > 0, 5_000)
  await sleep(300)
  const finalRows = usageRows()
  const usageRow = finalRows[0]
  check(finalRows.length === 1 && usageRow?.source === 'acp' && usageRow?.providerId === 'acp' && usageRow?.modelId === AGENT_ID,
    `⑨ 这一轮收场 → 账本上恰一行,source = acp(读到 ${finalRows.length} 行:${JSON.stringify(finalRows.map(r => ({ source: r.source, providerId: r.providerId, modelId: r.modelId })))})`)
  check(usageRow?.usage?.input === 100 && usageRow?.usage?.output === 20 && usageRow?.usage?.reasoning === 30 && usageRow?.usage?.cacheRead === 40,
    `⑨ 思考 / 缓存两格进了账本(读到 ${JSON.stringify(usageRow?.usage ?? null)})`)
  check(usageRow?.providerCostUSD === 0.25 && (usageRow?.costUSD ?? null) === null,
    `⑨ 厂商报价 = 这一轮的累计成本增量,本地估价为 null(读到 providerCostUSD = ${usageRow?.providerCostUSD}, costUSD = ${usageRow?.costUSD})`)

  // ── A2-b ⑩ 切模式 ────────────────────────────────────────────────
  const modeReply = await rpc('acp', 'setSessionMode', { sessionId: planId, modeId: 'code' })
  check(modeReply?.success === true && modeReply.state?.modes?.current === 'code',
    `⑩ acp.setSessionMode 答切完之后的状态表(读到 ${JSON.stringify(modeReply ?? null)})`)
  const setModeCall = await waitFor(() => readCalls(agentDir).find(call => call.method === 'set-mode' && call.modeId === 'code'), 3_000)
  check(Boolean(setModeCall), `⑩ 假 agent 收到 session/set_mode(modeId = ${setModeCall?.modeId ?? '缺席'})`)
  const pushedMode = await waitFor(() => readCalls(agentDir).some(call => call.method === 'pushed-mode' && call.modeId === 'code'), 3_000)
  await sleep(200)
  const modeState = await rpc('acp', 'sessionState', { sessionId: planId })
  check(Boolean(pushedMode) && modeState?.modes?.current === 'code',
    `⑩ agent 推回的 current_mode_update 折进同一格(acp.sessionState.modes.current = ${modeState?.modes?.current})`)
  check(sse.frames.some(item => item.event === 'acp:session-state' && item.data?.state?.localSessionId === planId
    && item.data.state.modes?.current === 'code'), '⑩ SSE 上见到带新模式的 acp:session-state 帧')

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

  // ── ⑰ 桥 / ⑱ 归因(A4-b)────────────────────────────────────────
  const mcpId = await createAcpSession(rpc, 'acp 门 · 宿主工具', workDir)
  const callsBeforeMcp = readCalls(agentDir).length
  await sendMessage(rpc, mcpId, '@mcp 给用户发条通知')
  await waitFor(() => finishSeen(sse.frames, mcpId), 30_000)
  const mcpCalls = readCalls(agentDir).slice(callsBeforeMcp)
  const mcpNew = mcpCalls.find(call => call.method === 'new')
  const hostEntry = (mcpNew?.mcpServers ?? []).find(server => server.name === 'onething')
  const hostEnv = Object.fromEntries((hostEntry?.env ?? []).map(pair => [pair.name, pair.value]))
  check(Boolean(hostEntry) && !('type' in hostEntry) && typeof hostEntry.command === 'string'
    && /acp-mcp-bridge\.cjs$/.test(hostEntry.args?.[0] ?? '') && fs.existsSync(hostEntry.args[0])
    && typeof hostEnv.ONETHING_MCP_TOKEN === 'string' && hostEnv.ONETHING_MCP_URL === `http://127.0.0.1:${discovery.port}`,
    `⑰ session/new 的 mcpServers 里有一条 stdio 的 onething(桥产物在盘上,env 带面地址与凭据;读到 ${JSON.stringify(
      hostEntry ? { ...hostEntry, env: hostEntry.env?.map(pair => pair.name) } : mcpNew?.mcpServers ?? null)})`)
  const hostMcpRun = mcpCalls.find(call => call.method === 'host-mcp')
  check(hostMcpRun?.ok === true && hostMcpRun.tools?.includes('send_notification'),
    `⑰ 假 agent 起了桥,tools/list 有 send_notification(读到 ${JSON.stringify(hostMcpRun?.tools ?? hostMcpRun ?? null)})`)
  check(hostMcpRun?.ok === true && !hostMcpRun.callResult?.isError,
    `⑰ tools/call send_notification 没报错(读到 ${JSON.stringify(hostMcpRun?.callResult ?? null)})`)
  const notified = await waitFor(() => sse.frames.find(frame => frame.event === 'agent:notification'
    && frame.data?.sessionId === mcpId), 5_000, 50)
  check(notified?.data?.agentId === AGENT_ID && String(notified?.data?.message ?? '').startsWith('hello from fake agent'),
    `⑱ SSE 上的 agent:notification 落在发起会话、归 fake(读到 ${JSON.stringify(notified?.data ?? null)})`)
  const bridgeToken = hostMcpRun?.token
  const bridgeListTools = async () => {
    const response = await fetch(`http://127.0.0.1:${discovery.port}/api/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bridgeToken}` },
      body: JSON.stringify({ domain: 'host-mcp', method: 'listTools', payload: {} }),
    })
    return response.status
  }
  const liveStatus = bridgeToken ? await bridgeListTools() : 'no token'
  check(liveStatus === 200, `⑱ 会话在时,同一枚桥凭据打 host-mcp.listTools → 200(读到 ${liveStatus})`)
  await rpc('sessions', 'delete', { sessionId: mcpId })
  const revokedStatus = bridgeToken ? await waitFor(async () => {
    const status = await bridgeListTools()
    return status === 401 ? status : undefined
  }, 3_000) ?? await bridgeListTools() : 'no token'
  check(revokedStatus === 401, `⑱ 删掉会话之后,同一枚桥凭据 → 401(读到 ${revokedStatus})`)


  // ── ⑲ 崩溃重连 + 退避(A5)──────────────────────────────────────
  const agentRow = async agentId => (await rpc('acp', 'getAgents', {}))?.agents?.find(agent => agent.config?.id === agentId)
  const completions = sessionId => sse.frames.filter(frame => frame.event === 'session:event'
    && frame.data?.sessionId === sessionId && frame.data?.event?.type === 'stream:complete').length
  const sendAndWait = async (sessionId, content) => {
    const before = completions(sessionId)
    await sendMessage(rpc, sessionId, content)
    return waitFor(() => completions(sessionId) > before, 20_000)
  }
  const replyText = async sessionId => {
    const message = await lastAssistant(rpc, sessionId)
    return `${message?.content ?? ''} ${message?.errorDetails ?? ''}`
  }
  const killAgent = async () => {
    const row = await agentRow(CRASH_AGENT_ID)
    if (typeof row?.pid !== 'number') return { pid: undefined, errored: false }
    process.kill(row.pid, 'SIGKILL')
    const errored = await waitFor(async () => (await agentRow(CRASH_AGENT_ID))?.status === 'error', 5_000)
    return { pid: row.pid, errored: Boolean(errored) }
  }
  const crashCalls = method => readCalls(crashAgentDir).filter(call => call.method === method)

  const crashId = await createAcpSession(rpc, 'acp 门 · 崩溃', workDir, CRASH_AGENT_ID)
  const crashFirst = await sendAndWait(crashId, 'hello crash')
  const crashAcpId = crashCalls('new')[0]?.id
  check(Boolean(crashFirst) && Boolean(crashAcpId), `⑲ 第一轮走通(agent 会话 ${crashAcpId ?? '缺席'})`)
  const firstKill = await killAgent()
  check(firstKill.errored, `⑲ kill -9 进程 ${firstKill.pid ?? '?'} 之后行上 status = error`)
  check(sse.frames.some(frame => frame.event === 'acp:agent-state' && frame.data?.state?.config?.id === CRASH_AGENT_ID
    && frame.data.state.status === 'error'), '⑲ SSE 上见到这台的 acp:agent-state status = error')
  let reconnects = 0
  for (let round = 1; round <= 3; round += 1) {
    if (round > 1) {
      const again = await killAgent()
      if (!again.errored) break
    }
    const done = await sendAndWait(crashId, `after crash ${round}`)
    const loads = crashCalls('load').filter(call => call.id === crashAcpId).length
    const text = await replyText(crashId)
    const row = await agentRow(CRASH_AGENT_ID)
    if (done && loads === round && text.includes(`session=${crashAcpId}`) && row?.status === 'connected') reconnects += 1
    check(row?.backoff?.attempts === round && row.backoff.latched === false,
      `⑲ 第 ${round} 次崩后重连:backoff.attempts = ${round}、未锁(读到 ${JSON.stringify(row?.backoff ?? null)})`)
  }
  check(reconnects === 3, `⑲ 30s 内崩三次,三次都自动重连并 session/load 回同一条会话(做到 ${reconnects} 次)`)
  const fourthKill = await killAgent()
  const initsBeforeRefusal = crashCalls('init').length
  await sendMessage(rpc, crashId, 'fourth time')
  const refusal = await waitFor(async () => {
    const text = await replyText(crashId)
    return text.includes(BACKOFF_REFUSAL) ? text : undefined
  }, 10_000)
  check(fourthKill.errored && Boolean(refusal),
    `⑲ 第 4 次崩之后那一条被拒,那句话落进助手消息(读到 ${JSON.stringify((await replyText(crashId)).slice(0, 200))})`)
  const latchedRow = await agentRow(CRASH_AGENT_ID)
  check(latchedRow?.backoff?.latched === true, `⑲ 行上 backoff.latched = true(读到 ${JSON.stringify(latchedRow?.backoff ?? null)})`)
  check(sse.frames.some(frame => frame.event === 'acp:agent-state' && frame.data?.state?.config?.id === CRASH_AGENT_ID
    && frame.data.state.backoff?.latched === true), '⑲ SSE 上见到带 backoff.latched 的 acp:agent-state')
  await sleep(300)
  check(crashCalls('init').length === initsBeforeRefusal,
    `⑲ 被拒的那一次没有起新进程(init ${initsBeforeRefusal} → ${crashCalls('init').length})`)
  const reconnected = await rpc('acp', 'reconnectAgent', { agentId: CRASH_AGENT_ID })
  check(reconnected?.ok === true && reconnected.state?.status === 'connected' && !reconnected.state?.backoff?.latched,
    `⑲ acp.reconnectAgent 清锁并连上(读到 ${JSON.stringify(reconnected?.ok ? { status: reconnected.state?.status, backoff: reconnected.state?.backoff ?? null } : reconnected)})`)
  const afterReconnect = await sendAndWait(crashId, 'after reconnect')
  check(Boolean(afterReconnect) && (await replyText(crashId)).includes(`session=${crashAcpId}`),
    '⑲ 重新连接之后再发一条,照常走通(同一条 agent 会话)')

  // ── ⑳ 认领(A5)────────────────────────────────────────────────
  const remoteCalls = method => readCalls(remoteAgentDir).filter(call => call.method === method)
  const remoteListed = await rpc('acp', 'listRemoteSessions', { agentId: REMOTE_AGENT_ID, cwd: workDir })
  const listedIds = remoteListed?.ok ? remoteListed.sessions.map(session => session.acpSessionId).sort() : []
  check(remoteListed?.ok === true && sameJson(listedIds, ['remote-one', 'remote-two']),
    `⑳ listRemoteSessions 列出假 agent 自己那两条(读到 ${JSON.stringify(remoteListed?.ok ? listedIds : remoteListed)})`)
  check(remoteCalls('list').length >= 2, `⑳ 翻页到底(每页 1 条,session/list 调了 ${remoteCalls('list').length} 次)`)
  check(remoteListed?.ok && remoteListed.sessions.find(session => session.acpSessionId === 'remote-one')?.title === 'Remote one',
    '⑳ 列表带 agent 自报的标题')
  const unsupportedList = await rpc('acp', 'listRemoteSessions', { agentId: CRASH_AGENT_ID })
  check(unsupportedList?.ok === false && unsupportedList.code === 'unsupported',
    `⑳ 没自报 sessionCapabilities.list 的那台答 unsupported(读到 ${JSON.stringify(unsupportedList)})`)
  const adopted = await rpc('acp', 'adoptSession', { agentId: REMOTE_AGENT_ID, acpSessionId: 'remote-one', cwd: workDir })
  const adoptedId = adopted?.ok ? adopted.sessionId : undefined
  const adoptedLedgerFile = adoptedId ? path.join(storePath, 'sessions', adoptedId, 'events.jsonl') : undefined
  const adoptedLedger = adoptedLedgerFile && fs.existsSync(adoptedLedgerFile)
    ? fs.readFileSync(adoptedLedgerFile, 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    : []
  const importedEvents = adoptedLedger.filter(record => record.type === 'message/imported')
  check(adopted?.ok === true && adopted.alreadyAdopted === false && importedEvents.length >= 4 && adopted.imported === importedEvents.length,
    `⑳ adoptSession 建了本地会话,账本上 message/imported ${importedEvents.length} 条、imported = ${adopted?.imported}(读到 ${JSON.stringify(adopted)})`)
  check(importedEvents.every(record => record.data?.message?.origin?.source === 'acp-import'),
    '⑳ 认领来的每一条都带 origin.source = acp-import')
  check(remoteCalls('load').some(call => call.id === 'remote-one'), '⑳ 假 agent 收到 session/load remote-one')
  const adoptedMessages = adoptedId ? ((await rpc('sessions', 'getMessages', { sessionId: adoptedId }))?.messages ?? []) : []
  check(adoptedMessages.length >= 4 && adoptedMessages[0]?.role === 'user' && adoptedMessages[0]?.content === 'remote question one'
    && adoptedMessages.some(message => message.role === 'assistant' && message.content === 'remote answer one'),
    `⑳ 投影读得到回放的历史(${adoptedMessages.length} 条,首条 ${JSON.stringify(adoptedMessages[0]?.content ?? null)})`)
  const adoptedSession = adoptedId ? (await rpc('sessions', 'get', { sessionId: adoptedId }))?.session : undefined
  check(adoptedSession?.workingDirectory === workDir && adoptedSession?.lastProvider === 'acp' && adoptedSession?.lastModel === REMOTE_AGENT_ID,
    `⑳ 本地会话绑了那条的目录、模型指到 ${REMOTE_AGENT_ID}(读到 ${JSON.stringify(adoptedSession
      ? { wd: adoptedSession.workingDirectory, provider: adoptedSession.lastProvider, model: adoptedSession.lastModel, name: adoptedSession.name } : null)})`)
  const adoptedAgain = await rpc('acp', 'adoptSession', { agentId: REMOTE_AGENT_ID, acpSessionId: 'remote-one', cwd: workDir })
  check(adoptedAgain?.ok === true && adoptedAgain.sessionId === adoptedId && adoptedAgain.alreadyAdopted === true && adoptedAgain.imported === 0,
    `⑳ 再认领一次答同一个 sessionId、alreadyAdopted = true(读到 ${JSON.stringify(adoptedAgain)})`)
  const relisted = await rpc('acp', 'listRemoteSessions', { agentId: REMOTE_AGENT_ID, cwd: workDir })
  check(relisted?.ok && relisted.sessions.find(session => session.acpSessionId === 'remote-one')?.adoptedSessionId === adoptedId
    && !relisted.sessions.find(session => session.acpSessionId === 'remote-two')?.adoptedSessionId,
    '⑳ 列表上认领过的那条带 adoptedSessionId,没认领的不带')
  const adoptedReply = adoptedId ? await sendAndWait(adoptedId, 'continue remote') : undefined
  check(Boolean(adoptedReply) && (await replyText(adoptedId)).includes('session=remote-one') && remoteCalls('new').length === 0,
    `⑳ 在认领来的会话上发一条,agent 在 remote-one 上答、没有 session/new(读到 ${JSON.stringify((await replyText(adoptedId)).slice(0, 120))})`)

  // ── ㉑ 分叉(A5)────────────────────────────────────────────────
  const forked = adoptedId ? await rpc('acp', 'forkSession', { sessionId: adoptedId }) : undefined
  const forkId = forked?.ok ? forked.sessionId : undefined
  const forkCall = remoteCalls('fork')[0]
  check(Boolean(forkId) && forkId !== adoptedId && forkCall?.from === 'remote-one' && forkCall?.cwd === workDir,
    `㉑ forkSession 建了新本地会话,假 agent 收到 session/fork(源 remote-one;读到 ${JSON.stringify({ forked, forkCall })})`)
  const linksFile = path.join(storePath, 'acp', 'session-links.json')
  const linkTable = fs.existsSync(linksFile) ? JSON.parse(fs.readFileSync(linksFile, 'utf-8')) : { links: {} }
  const forkLink = forkId ? linkTable.links?.[`${REMOTE_AGENT_ID}:${forkId}`] : undefined
  const sourceLink = adoptedId ? linkTable.links?.[`${REMOTE_AGENT_ID}:${adoptedId}`] : undefined
  check(Boolean(forkLink) && forkLink.acpSessionId === forkCall?.id && forkLink.acpSessionId !== sourceLink?.acpSessionId,
    `㉑ 链接表里分叉的 agent 会话 id ≠ 源的(分叉 ${forkLink?.acpSessionId ?? '缺席'} / 源 ${sourceLink?.acpSessionId ?? '缺席'})`)
  const forkMessages = forkId ? ((await rpc('sessions', 'getMessages', { sessionId: forkId }))?.messages ?? []) : []
  check(forkMessages.length >= adoptedMessages.length, `㉑ 分叉带着本地这边的历史(${forkMessages.length} 条)`)
  const forkReply = forkId ? await sendAndWait(forkId, 'on the fork') : undefined
  check(Boolean(forkReply) && (await replyText(forkId)).includes(`session=${forkCall?.id}`),
    `㉑ 在分叉上发一条,agent 在 fork 出来的那条上答(读到 ${JSON.stringify(forkId ? (await replyText(forkId)).slice(0, 120) : null)})`)

  // 名册刷新走一趟(RPC `acp.refreshRegistry` = 强制重拉 + 探测):开关关着就只重读种子与探测,
  // 不联网 —— 收尾那一步从日志上核「一次拉取都没有」。A5 起 server 装配后调 `acp.start()`
  // (后台那趟 refresh 也在开关前止步),这一趟再显式强拉一次。
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

// ── ㉒ 真 claude-agent-acp 对等门(A6-a,opt-in)─────────────────────────────────────────
/**
 * 方案 §5 A6 对等清单 / §11.7 A6-a:用本机的 `claude-agent-acp`(种子 `resources/acp-agents/claude-code.json`
 * 那条起法 —— 门**不写**任何用户 agent 条目,它得从种子名册里来,这本身就是证据的一部分)真跑一遍。
 * 花的是跑门的人自己的 Claude 订阅额度,于是 opt-in:`ONETHING_GATE_REAL_ACP=1`;没开 = 一行
 * `skipped`、不影响退出码(口径同 `gate:search-index` ⑫ / `gate:embed-runtime`)。
 *
 * 纪律:绝不跑登录(`--cli auth login`),门自己不写 `~/.claude`、不碰真 `~/.onething`(server 起在
 * 临时 store,会话目录是临时目录;agent 读它自己的 `~/.claude` 登录态,并照常把会话记录写进
 * `~/.claude/projects/<临时目录>` —— 那是 agent 的行为,不是门的)。prompt 一共 ≤ 6 条、每条一句。
 * 代理:server 继承门自己的环境(`HTTPS_PROXY` 等),`resolveExternalAgentSpawnEnv` 再照 App 口径递给 agent。
 *
 *   ㉒-1 名册:`claude-code` 来自 builtin、探测到已装;开过会话之后能力表 loadSession / fork / list / resume /
 *        image / embeddedContext / http+sse MCP、authMethods ≥ 2 且有终端型,`auth.required === false`。
 *   ㉒-2 persona:`session/new` 的 `_meta` 带 `systemPrompt.append`(从我们这边的 debug 日志读键名);
 *        「只回复单词 pong」→ 正文含 pong。
 *   ㉒-3 选项:`acp.sessionState` 的 configOptions 按 category 有 model / thought_level / mode;model_config(fast)
 *        只在当前模型支持时 agent 才列,缺席打一行 note、不算红。
 *   ㉒-4 权限 + diff:临时 cwd 放项目级 `.claude/settings.json`(defaultMode default + ask Edit/Write/Bash,压过
 *        跑门人自己的 bypass / allow)→ 改 hello.txt → 上一张带 choices 的卡、至少 once / reject(ask 规则逼出的卡适配器不给 always,
 *        always 由假 agent ⑫ 证)→ 答 once
 *        → 盘上是 hi;agent 用 Edit / Write 就验 changes 有 -hello / +hi,用 Bash 就验卡的效果是命令执行、
 *        diff 那行打 `skipped(bash)`。
 *   ㉒-5 提问:AskUserQuestion → `interaction:requested` 恰一道 ≥ 2 选项的题(旁边允许适配器自带的一道「Other」
 *        自由输入)→ 答第一项 → 这一轮以正文收场。
 *   ㉒-6 宿主 MCP:`session/new` 的 mcpServers 有 http 形的 `onething`;让它调 send_notification 发 ping →
 *        SSE 上这条会话的 `agent:notification` 含 ping。
 *   ㉒-7 插话:握手顶层 `_meta.steering.supported === true`(插话一次被消化:没有插话的 RPC 路,留账)。
 *   ㉒-8 恢复:关 server、同一 store 重起,同一会话「再回复一次 pong」→ 日志见 session/resume 或 load、
 *        这一发没有 `_meta.systemPrompt`,正文又是 pong。
 *   ㉒-9 用量:账本上 ≥ 1 行 `source: 'acp'`、`modelId: 'claude-code'`,输入 / 输出 token > 0。
 */
async function runRealClaudeParity() {
  const REAL_AGENT_ID = 'claude-code'
  const TURN_BUDGET_MS = 240_000
  const startedAt = Date.now()
  let prompts = 0
  let reportedCost
  let realChild
  let realSse
  const realStore = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-acp-real-'))
  const realCwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-acp-real-work-')))
  const realOut = []
  const proxyVars = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
    .filter(name => process.env[name])
  console.log(`[gate:acp] ㉒ 真 claude-agent-acp(temp store ${realStore};代理 ${proxyVars.length > 0 ? proxyVars.join(' / ') : '无'})`)

  const boot = async () => {
    realChild = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ONETHING_STORE_PATH: realStore, ONETHING_CREDENTIALS_KEYRING: 'file',
        ONETHING_SERVER_DATA_ROOT: realStore,
        ONETHING_SERVER_HOST: '127.0.0.1',
        ONETHING_SERVER_PORT: '',
        ONETHING_LOG: 'info,acp=debug',
        // 桌面有终端宿主;server 缺省没有。没有它握手就不声明 `auth.terminal`,claude-agent-acp
        // 于是把终端型登录方法整个藏掉(`supportsTerminalAuth`)—— ㉒-1 量的是桌面同款的握手。
        ONETHING_SERVER_TERMINAL: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    realChild.stdout.on('data', chunk => realOut.push(chunk.toString()))
    realChild.stderr.on('data', chunk => realOut.push(chunk.toString()))
    const discovery = await waitForDiscovery(realStore)
    return { rpc: createRpc(discovery), sse: await openEventStream(discovery) }
  }
  const stop = async () => {
    if (realSse) await realSse.close().catch(() => {})
    realSse = undefined
    if (realChild && realChild.exitCode === null && realChild.signalCode === null) {
      realChild.kill('SIGTERM')
      for (let i = 0; i < 100 && realChild.exitCode === null && realChild.signalCode === null; i += 1) await sleep(100)
      if (realChild.exitCode === null && realChild.signalCode === null) realChild.kill('SIGKILL')
    }
  }
  const logRecords = () => {
    const dir = path.join(realStore, 'log')
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl'))
      .flatMap(name => fs.readFileSync(path.join(dir, name), 'utf-8').split('\n').filter(Boolean))
      .flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  }
  const openRequests = () => logRecords().filter(record => record.ns === 'acp' && record.msg === 'session open request'
    && record.fields?.agentId === REAL_AGENT_ID)
  const completes = (frames, sessionId) => frames.filter(frame => frame.event === 'session:event'
    && frame.data?.sessionId === sessionId && frame.data?.event?.type === 'stream:complete').length
  const turn = async (rpc, frames, sessionId, text) => {
    const before = completes(frames, sessionId)
    prompts += 1
    await sendMessage(rpc, sessionId, text)
    return waitFor(() => completes(frames, sessionId) > before, TURN_BUDGET_MS, 250)
  }
  const replyText = async (rpc, sessionId) => {
    const message = await lastAssistant(rpc, sessionId)
    return typeof message?.content === 'string' ? message.content : ''
  }

  try {
    fs.writeFileSync(path.join(realStore, 'settings.json'), JSON.stringify({
      ai: {
        provider: 'acp',
        providers: { acp: { model: REAL_AGENT_ID, selectedModels: [REAL_AGENT_ID], enabled: true } },
        customProviders: [],
        modelCatalog: {},
      },
      // 不写 agents:claude-code 只能从种子名册来。注册表不联网(确定性)。
      acp: { enabled: true, registry: { enabled: false } },
      tools: { enableToolCalls: false, permissionMode: 'normal', tools: {} },
      diagnostics: { enabled: false },
    }, null, 2))
    fs.writeFileSync(path.join(realCwd, 'hello.txt'), 'hello\n')
    /*
     * ㉒-4 要一张真卡。跑门的人自己的 `~/.claude/settings.json` 可能是 `bypassPermissions` + allow 全开
     * (本机就是),那样 Claude 一张卡都不问。门不碰 `~/.claude`,只在**临时 cwd** 里放一份项目级设置:
     * Claude Code 的设置层级 project > user,规则上 ask 压过 allow —— 这一间目录里改文件 / 跑命令都得问。
     */
    fs.mkdirSync(path.join(realCwd, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(realCwd, '.claude', 'settings.json'), JSON.stringify({
      permissions: { defaultMode: 'default', ask: ['Edit', 'Write', 'Bash'] },
    }, null, 2))

    let { rpc, sse: stream } = await boot()
    realSse = stream
    const row = async () => (await rpc('acp', 'getAgents', {}))?.agents?.find(agent => agent.config?.id === REAL_AGENT_ID)

    // ── ㉒-1 前半:种子名册 ──
    const seeded = await row()
    check(seeded?.source === 'builtin' && seeded?.detect?.installed === true,
      `㉒-1 名册里的 claude-code 来自 builtin、探测到已装(读到 source = ${seeded?.source}, detect = ${JSON.stringify(seeded?.detect ?? null)})`)
    if (!seeded?.detect?.installed) throw new Error('claude-agent-acp 不在 PATH 上,㉒ 无从跑起')

    // 一个带 persona 的 agent 绑到会话上:persona 才有东西可送(产品默认助理身份不是 persona)。
    const persona = await rpc('agents', 'create', { name: 'Gate', systemPrompt: '你是 onething 的门测助手,回答尽量短。' })
    const sessionId = (await rpc('sessions', 'create', { name: 'acp 门 · 真 Claude' }))?.session?.id
    await rpc('sessions', 'updateWorkingDirectory', { sessionId, workingDirectory: realCwd })
    if (persona?.agent?.id) await rpc('sessions', 'updateAgent', { sessionId, agentId: persona.agent.id })
    await rpc('sessions', 'updateModel', { sessionId, provider: 'acp', model: REAL_AGENT_ID })

    // ── ㉒-2 persona + pong ──
    const pongDone = await turn(rpc, realSse.frames, sessionId, '只回复单词 pong')
    const afterFirst = await row()
    if (afterFirst?.auth?.required === true) {
      check(false, `㉒-1 auth.required === false —— 读到 true:先在终端里 claude auth login(门不替你登录;行 ${JSON.stringify(afterFirst.auth)})`)
      throw new Error('claude-agent-acp 要求登录,㉒ 就此停下')
    }
    const pongText = await replyText(rpc, sessionId)
    const firstNew = openRequests().find(record => record.fields?.method === 'session/new')
    check(Array.isArray(firstNew?.fields?.metaKeys) && firstNew.fields.metaKeys.includes('systemPrompt')
      && sameJson(firstNew.fields.systemPromptKeys, ['append']),
      `㉒-2 session/new 的 _meta 带 systemPrompt.append(日志读到 ${JSON.stringify(firstNew?.fields ?? null)})`)
    check(Boolean(pongDone) && /pong/i.test(pongText), `㉒-2 「只回复单词 pong」→ 正文含 pong(读到 ${JSON.stringify(pongText.slice(0, 200))})`)

    // ── ㉒-1 后半:握手能力 ──
    const caps = afterFirst?.capabilities ?? {}
    const sessionCaps = caps.sessionCapabilities ?? {}
    check(caps.loadSession === true && Boolean(sessionCaps.fork) && Boolean(sessionCaps.list) && Boolean(sessionCaps.resume),
      `㉒-1 loadSession + sessionCapabilities.{fork,list,resume}(读到 loadSession = ${caps.loadSession}, sessionCapabilities 键 ${JSON.stringify(Object.keys(sessionCaps))})`)
    check(caps.promptCapabilities?.image === true && caps.promptCapabilities?.embeddedContext === true,
      `㉒-1 promptCapabilities.{image,embeddedContext}(读到 ${JSON.stringify(caps.promptCapabilities ?? null)})`)
    check(caps.mcpCapabilities?.http === true && caps.mcpCapabilities?.sse === true,
      `㉒-1 mcpCapabilities.{http,sse}(读到 ${JSON.stringify(caps.mcpCapabilities ?? null)})`)
    const methods = afterFirst?.auth?.methods ?? []
    check(methods.length >= 2 && methods.some(method => method.type === 'terminal') && afterFirst?.auth?.required === false,
      `㉒-1 authMethods ≥ 2 且有终端型,auth.required === false(读到 ${JSON.stringify(afterFirst?.auth ?? null)})`)

    // ── ㉒-3 选项按 category ──
    const state = await rpc('acp', 'sessionState', { sessionId })
    const categories = new Set((state?.configOptions ?? []).map(option => option.category))
    const optionList = JSON.stringify((state?.configOptions ?? []).map(option => `${option.id}:${option.category ?? '-'}=${option.currentValue}`))
    check(['model', 'thought_level', 'mode'].every(category => categories.has(category)),
      `㉒-3 configOptions 按 category 有 model / thought_level / mode(读到 ${optionList})`)
    // fast(`model_config`)只在当前模型支持时才列(claude-agent-acp `buildConfigOptions` 看 `supportsFastMode`)。
    if (categories.has('model_config')) check(true, '㉒-3 当前模型支持 fast,model_config 那一格在')
    else console.log(`  note ㉒-3 没有 model_config(fast)一格 —— 当前模型不支持 fast,agent 就不列;不算红(${optionList})`)

    // ── ㉒-6 前半:同一发 session/new 里的 onething ──
    const hostEntry = (firstNew?.fields?.mcpServers ?? []).find(server => server.name === 'onething')
    check(hostEntry?.type === 'http', `㉒-6 session/new 的 mcpServers 有 http 形的 onething(读到 ${JSON.stringify(firstNew?.fields?.mcpServers ?? null)})`)

    // ── ㉒-7 插话自报 ──
    check(afterFirst?.handshakeMeta?.steering?.supported === true,
      `㉒-7 握手顶层 _meta.steering.supported === true(读到 ${JSON.stringify(afterFirst?.handshakeMeta?.steering ?? null)};插话投递无 RPC 路,留账)`)

    // ── ㉒-4 权限 + diff ──
    let answerer = startAnswerer(rpc, realSse.frames)
    answerer.setDecider((event, sid) => (sid === sessionId ? 'once' : undefined))
    const cardsBefore = permissionRequests(realSse.frames, sessionId).length
    const editDone = await turn(rpc, realSse.frames, sessionId, '把 hello.txt 里的 hello 改成 hi,不要问我')
    const editCards = permissionRequests(realSse.frames, sessionId).slice(cardsBefore)
    const agentCard = editCards.find(card => (card.choices ?? []).length > 0)
    const cardSummary = JSON.stringify(editCards.map(card => ({
      permissionType: card.permissionType, toolKind: card.metadata?.toolKind ?? null, title: card.title,
      choices: (card.choices ?? []).map(choice => `${choice.kind}:${choice.label}`),
    })))
    check(Boolean(agentCard), `㉒-4 上了一张带 choices 的权限卡(${editCards.length} 张:${cardSummary})`)
    const kinds = new Set((agentCard?.choices ?? []).map(choice => choice.kind))
    /*
     * 这张卡是门自己放的项目级 ask 规则逼出来的;claude-agent-acp 对「用户 ask 规则逼出的卡」刻意不给
     * 「始终允许」(`acp-agent.js:5587` `noPersistentRule = matchedAskRule !== undefined || …`)。
     * 于是这里只要 once / reject;always 那条路由假 agent ⑫ 证。
     */
    check(['once', 'reject'].every(kind => kinds.has(kind)),
      `㉒-4 choices 至少有 once / reject(卡由门的 ask 规则逼出;读到 ${JSON.stringify([...kinds])})`)
    console.log('  note ㉒-4 always 由假 agent ⑫ 证;ask 规则逼出的卡适配器不给 always(acp-agent.js:5587)')
    const editMessage = await lastAssistant(rpc, sessionId)
    const editCalls = toolCallsOf(editMessage)
    const callSummary = JSON.stringify(editCalls.map(call => ({ name: call.toolName ?? call.name, kind: call.result?.metadata?.kind ?? null, status: call.status, diff: String(call?.changes?.diff ?? '').slice(0, 120) })))
    const usedEditOrWrite = editCalls.some(call => /^(edit|write|multiedit)/i.test(String(call.toolName ?? call.name ?? ''))
      || call.result?.metadata?.kind === 'edit')
    if (usedEditOrWrite) {
      const changed = editCalls.find(call => /-hello/.test(String(call?.changes?.diff ?? '')) && /\+hi/.test(String(call?.changes?.diff ?? '')))
      check(Boolean(editDone) && Boolean(changed), `㉒-4 答 once → 工具卡 changes 有 -hello / +hi(读到 ${callSummary})`)
    } else {
      const bashCard = editCards.find(card => card.metadata?.toolKind === 'execute' || /bash|shell|exec/i.test(String(card.permissionType ?? '')))
      check(Boolean(editDone) && Boolean(bashCard),
        `㉒-4 agent 用的是 Bash:那张卡的效果是命令执行(读到 ${cardSummary};工具 ${callSummary})`)
      console.log('  skipped(bash) ㉒-4 diff 那一行 —— agent 没用 Edit / Write,命令改文件没有 diff 可验')
    }
    const onDisk = fs.readFileSync(path.join(realCwd, 'hello.txt'), 'utf-8')
    check(onDisk.trim() === 'hi', `㉒-4 盘上 hello.txt 现在是 hi(读到 ${JSON.stringify(onDisk)};门答了 ${answerer.answers.length} 张卡)`)
    answerer.setDecider(() => undefined)

    // ── ㉒-5 提问 ──
    const interactions = () => realSse.frames
      .filter(frame => frame.event === 'session:event' && frame.data?.sessionId === sessionId
        && frame.data?.event?.type === 'interaction:requested')
      .map(frame => frame.data.event.request)
    const asksBefore = interactions().length
    const beforeElicit = completes(realSse.frames, sessionId)
    prompts += 1
    await sendMessage(rpc, sessionId, '先用一个单选问题问我要红色还是蓝色,我答了你再回答一个字')
    const card = await waitFor(() => interactions()[asksBefore], TURN_BUDGET_MS, 100)
    const choiceQuestions = (card?.questions ?? []).filter(item => (item.options ?? []).length > 0)
    const freeTextQuestions = (card?.questions ?? []).filter(item => (item.options ?? []).length === 0)
    const question = choiceQuestions[0]
    // 适配器在单选题后自带一道「Other」自由输入(claude-agent-acp `elicitation.js` 的 `<id>_custom`),允许至多一道。
    check(Boolean(card) && choiceQuestions.length === 1 && (question?.options ?? []).length >= 2
      && freeTextQuestions.length <= 1 && freeTextQuestions.every(item => item.allowFreeText === true),
      `㉒-5 AskUserQuestion → interaction:requested 恰一道 ≥ 2 选项的题(旁边至多一道无选项的自由输入;读到 ${JSON.stringify(card?.questions ?? null)})`)
    if (card && question) {
      await rpc('session-command', 'emit', {
        sessionId,
        command: {
          type: 'command:interaction-respond',
          interactionId: card.id,
          ...(card.targetChannel ? { channel: card.targetChannel } : {}),
          answers: { [question.id]: { selected: [question.options[0].label] } },
        },
      })
    }
    const elicitDone = await waitFor(() => completes(realSse.frames, sessionId) > beforeElicit, TURN_BUDGET_MS, 250)
    const elicitText = await replyText(rpc, sessionId)
    check(Boolean(elicitDone) && elicitText.trim().length > 0,
      `㉒-5 答第一项之后这一轮以正文收场(读到 ${JSON.stringify(elicitText.slice(0, 200))})`)

    // ── ㉒-6 后半:send_notification 落回会话 ──
    answerer.setDecider((event, sid) => (sid === sessionId ? 'once' : undefined))
    const notifyDone = await turn(rpc, realSse.frames, sessionId, '调用 onething 的 send_notification 工具发一条内容为 ping 的通知,然后回答 done')
    const notified = realSse.frames.find(frame => frame.event === 'agent:notification' && frame.data?.sessionId === sessionId)
    check(Boolean(notifyDone) && /ping/i.test(String(notified?.data?.message ?? '')),
      `㉒-6 SSE 上这条会话的 agent:notification 含 ping(读到 ${JSON.stringify(notified?.data ?? null)};正文 ${JSON.stringify((await replyText(rpc, sessionId)).slice(0, 120))})`)
    answerer.stop()

    // ── ㉒-8 恢复:关 server、同一 store 重起 ──
    await stop()
    const requestsBeforeRestart = openRequests().length
    ;({ rpc, sse: stream } = await boot())
    realSse = stream
    const resumeDone = await turn(rpc, realSse.frames, sessionId, '再回复一次 pong')
    const resumedText = await replyText(rpc, sessionId)
    const reopen = openRequests().slice(requestsBeforeRestart)
    const restored = reopen.find(record => record.fields?.method === 'session/resume' || record.fields?.method === 'session/load')
    check(Boolean(restored) && !reopen.some(record => record.fields?.method === 'session/new'),
      `㉒-8 重起之后走 ${restored?.fields?.method ?? '缺席'} 回到原会话,没有新的 session/new(读到 ${JSON.stringify(reopen.map(record => record.fields?.method))})`)
    check(reopen.length > 0 && reopen.every(record => !(record.fields?.metaKeys ?? []).includes('systemPrompt')),
      `㉒-8 重连那一发没带 _meta.systemPrompt(persona 不重送;读到 ${JSON.stringify(reopen.map(record => record.fields?.metaKeys))})`)
    check(Boolean(resumeDone) && /pong/i.test(resumedText), `㉒-8 「再回复一次 pong」→ 正文含 pong(读到 ${JSON.stringify(resumedText.slice(0, 200))})`)

    // ── ㉒-9 用量 ──
    const usageDir = path.join(realStore, 'usage')
    const usageRows = () => (fs.existsSync(usageDir)
      ? fs.readdirSync(usageDir).filter(name => /^usage-.*\.jsonl$/.test(name))
        .flatMap(name => fs.readFileSync(path.join(usageDir, name), 'utf-8').split('\n').filter(Boolean).map(line => JSON.parse(line)))
      : []).filter(entry => entry.source === 'acp' && entry.modelId === REAL_AGENT_ID)
    await waitFor(() => usageRows().length > 0, 5_000)
    const rows = usageRows()
    reportedCost = rows.reduce((sum, entry) => sum + (typeof entry.providerCostUSD === 'number' ? entry.providerCostUSD : 0), 0)
    check(rows.length >= 1 && rows.some(entry => (entry.usage?.input ?? 0) > 0 && (entry.usage?.output ?? 0) > 0),
      `㉒-9 账本上有 source = acp、modelId = claude-code 的行且输入 / 输出 > 0(读到 ${rows.length} 行:${JSON.stringify(rows.map(entry => ({ ...entry.usage, providerCostUSD: entry.providerCostUSD })))})`)
  } catch (error) {
    failures.push(`㉒ ${String(error?.stack || error)}`)
    console.error(`[gate:acp] ㉒ ${error?.stack || error}`)
  } finally {
    await stop()
    const leftovers = spawnSync('pgrep', ['-f', 'bin/claude-agent-acp( |$)'], { encoding: 'utf-8' })
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`[gate:acp] ㉒ 收尾:用时 ${elapsed}s,prompt ${prompts} 条,agent 自报花费 ${reportedCost === undefined ? '未读到' : `$${reportedCost.toFixed(4)}`},代理 ${proxyVars.length > 0 ? proxyVars.join(' / ') : '无'}`
      + `${leftovers.status === 0 && leftovers.stdout.trim() ? `(pgrep claude-agent-acp 仍见 ${leftovers.stdout.trim().split('\n').join(',')},可能是别处起的)` : ''}`)
    if (failures.some(item => item.startsWith('㉒')) || failures.length > 0) {
      console.error(`[gate:acp] ㉒ server 输出尾:\n${realOut.slice(-30).join('')}`)
    }
    fs.rmSync(realStore, { recursive: true, force: true })
    fs.rmSync(realCwd, { recursive: true, force: true })
  }
}

if (process.env.ONETHING_GATE_REAL_ACP !== '1') {
  console.log('  skipped ㉒ 真 claude-agent-acp 对等门 —— opt-in:ONETHING_GATE_REAL_ACP=1(花本机 Claude 订阅的少量额度,≤ 6 条 prompt)')
} else if (failures.length > 0) {
  console.log('  skipped ㉒ 真 claude-agent-acp 对等门 —— 前面的假 agent 步骤已经红了,先修那些,不白花额度')
} else {
  await runRealClaudeParity()
}

if (failures.length > 0) {
  console.error(`[gate:acp] ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('[gate:acp] ok —— ① 握手 / ② 会话目录 / ③ 流与协议外请求 / ④ prompt 之外的状态 / ⑥ diff / ⑦ terminal / ⑧ 计划 / ⑨ 用量 / ⑩ 切模式 / ⑪ 四选项 / ⑫ 始终允许 / ⑬ fs / ⑭ terminal / ⑮ 提问 / ⑯ 无人应答 / ⑯b 登录 / ⑰ 桥 / ⑱ 归因 / ⑲ 崩溃退避 / ⑳ 认领 / ㉑ 分叉 全绿' + (process.env.ONETHING_GATE_REAL_ACP === '1' ? ' / ㉒ 真 Claude 对等' : ''))
