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
async function createAcpSession(rpc, name, workingDirectory) {
  const made = await rpc('sessions', 'create', { name })
  const sessionId = made?.session?.id
  if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(made)}`)
  if (workingDirectory) await rpc('sessions', 'updateWorkingDirectory', { sessionId, workingDirectory })
  await rpc('sessions', 'updateModel', { sessionId, provider: 'acp', model: AGENT_ID })
  return sessionId
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

try {
  console.log(`[gate:acp] temp store: ${storePath}`)
  fs.writeFileSync(path.join(storePath, 'settings.json'), JSON.stringify({
    ai: {
      provider: 'acp',
      providers: { acp: { model: AGENT_ID, selectedModels: [AGENT_ID], enabled: true } },
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
        },
        // A3-a:无桥宿主缺省拒;①–④ 不验审批,显式打开无人值守放行,门步才不被拒卡住。
        unattended: 'allow',
      }],
    },
    tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
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
  check(toolCall?.status === 'completed' && toolCall?.result === JSON.stringify(AGENT_TOOL_OUTPUT),
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
}

if (failures.length > 0) {
  console.error(`[gate:acp] ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('[gate:acp] ok —— ① 握手 / ② 会话目录 / ③ 流与协议外请求 / ④ prompt 之外的状态 全绿')
