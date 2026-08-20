#!/usr/bin/env node
/**
 * 真机自证(§10.12 第 5 / 6 类)。临时 store + 假 provider,**不碰 ~/.onething**。
 *
 *   bun run server:build && node scratchpad/s1b-class56-verify.mjs [--keep]
 *
 * 两个场景各起一次服:
 *  (a) **steering 把一次执行劈成两条消息** —— 第一轮流着的时候插一句话,引擎
 *      `response-boundary` 换消息 + `rotateSessionRun`。要看到:新 run 带
 *      `continuesRunId`、被打断那条**没有 usage**、接手那条开头的推理在
 *      `contentParts`(turnIndex 2)而不是 `message.reasoning`、usage 是两轮之和。
 *  (b) **一次失败但跑完了的工具** —— `read` 越过文件末尾。要看到:
 *      `tool/result.reportedTitle` 有工具自报的标题、step.title 用它、
 *      step.result 与 step.error 两格并存、toolCall.result 是结构化结局。
 *
 * 两个场景都要 `session-shadow.jsonl` **零行**、`mismatches: 0`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const KEEP = process.argv.includes('--keep')
const TOKEN = 'class56-token'
const failures = []

function check(ok, label, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(label)
}

function writeStore(store, mockPort) {
  fs.mkdirSync(path.join(store, 'workspaces', 'default'), { recursive: true })
  fs.writeFileSync(
    path.join(store, 'workspaces', 'default', 'providers.json'),
    JSON.stringify({
      ai: {
        provider: 'openai',
        providers: {
          openai: {
            enabled: true, apiKey: 'mock-key', baseUrl: `http://127.0.0.1:${mockPort}/v1`,
            model: 'gpt-4o', selectedModels: ['gpt-4o'],
            modelCapabilitiesByModel: { 'gpt-4o': { tools: true, vision: false, reasoning: true } },
          },
        },
        customProviders: [],
      },
    }, null, 2),
  )
  fs.writeFileSync(
    path.join(store, 'workspaces', 'default', 'credentials.json'),
    JSON.stringify({
      version: 2, encryption: 'none',
      providers: {
        openai: {
          policy: 'single',
          entries: [{ id: 'mock', label: 'mock', authType: 'apiKey', apiKey: 'mock-key', source: 'user', baseUrl: `http://127.0.0.1:${mockPort}/v1` }],
        },
      },
    }, null, 2),
  )
  fs.writeFileSync(
    path.join(store, 'settings.json'),
    JSON.stringify({ chat: { contextCompactEnabled: false }, tools: { enabled: true } }, null, 2),
  )
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/**
 * 假 provider。`scenario` 决定第一轮吐什么。
 * 标题生成会打同一个端点 —— 按"这次请求带不带工具目录"把它和真回合分开(§10.7)。
 */
function startMock(port, plan) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      if (!req.url.includes('/chat/completions')) { res.writeHead(404).end(); return }
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* ignore */ }
      const hasTools = Array.isArray(payload.tools) && payload.tools.length > 0
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const sawTool = messages.some(message => message.role === 'tool')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const base = { id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'gpt-4o' }
      const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`)
      const done = () => { res.write('data: [DONE]\n\n'); res.end() }

      if (!hasTools) { // 标题生成
        send({ ...base, choices: [{ index: 0, delta: { content: 'A title' } }] })
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
        done()
        return
      }
      await plan({ send, done, sawTool, messages })
    })
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

async function boot({ store, workdir, serverPort, sessionName }) {
  const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  const proc = spawn('node', [path.join(REPO, 'dist/server/main.js')], {
    cwd: REPO,
    env: {
      ...process.env,
      ONETHING_STORE_PATH: store,
      ONETHING_SERVER_PORT: String(serverPort),
      ONETHING_SERVER_TOOLS: 'full',
      ONETHING_SERVER_TOKEN: TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout.on('data', d => { log += d })
  proc.stderr.on('data', d => { log += d })

  let up = false
  for (let attempt = 0; attempt < 120 && !up; attempt++) {
    try { up = (await fetch(`http://127.0.0.1:${serverPort}/api/settings`, { headers })).ok } catch { /* not up */ }
    if (!up) await sleep(500)
  }
  if (!up) { proc.kill('SIGKILL'); throw new Error(`server did not come up:\n${log.slice(-3000)}`) }

  const created = await (await fetch(`http://127.0.0.1:${serverPort}/api/sessions`, {
    method: 'POST', headers, body: JSON.stringify({ name: sessionName }),
  })).json()
  const sessionId = created.session?.id ?? created.sessionId ?? created.id
  await fetch(`http://127.0.0.1:${serverPort}/api/sessions/${sessionId}/working-directory`, {
    method: 'POST', headers, body: JSON.stringify({ workingDirectory: workdir }),
  })
  // 临时 store 里没有人能点"允许" —— 这道验证问的是记账,不是审批闸。
  await fetch(`http://127.0.0.1:${serverPort}/api/sessions/${sessionId}/permission-mode`, {
    method: 'POST', headers, body: JSON.stringify({ permissionMode: 'dangerously-allow-all' }),
  })
  return { proc, sessionId, headers, getLog: () => log }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

async function waitForRunEnds(eventsPath, count, ms = 60_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const ends = readJsonl(eventsPath).filter(event => event.type === 'run/end').length
    if (ends >= count) return true
    await sleep(150)
  }
  return false
}

async function shutdown(handle, store) {
  // 影子断言排在 run/end 的 fsync 之后一个宏任务;统计表 1s 节流。
  await sleep(2500)
  handle.proc.kill('SIGTERM')
  await sleep(800)
  handle.proc.kill('SIGKILL')
  let stats = {}
  try { stats = JSON.parse(fs.readFileSync(path.join(store, 'log', 'session-shadow-stats.json'), 'utf8')) } catch { /* none */ }
  const shadowLines = readJsonl(path.join(store, 'log', 'session-shadow.jsonl'))
  return { stats, shadowLines }
}

function assertShadowClean(stats, shadowLines, label) {
  check(shadowLines.length === 0, `${label}: session-shadow.jsonl 零行`, JSON.stringify(shadowLines.map(l => l.diff)).slice(0, 600))
  check(stats.mismatches === 0, `${label}: mismatches = 0`, JSON.stringify(stats))
  check((stats.runs ?? 0) >= 1, `${label}: runs ≥ 1`, JSON.stringify(stats))
  check((stats.appendFailures ?? 0) === 0, `${label}: appendFailures = 0`, JSON.stringify(stats))
}

// ===========================================================================
// (a) steering:一次执行劈成两条消息
// ===========================================================================
async function scenarioSteer() {
  console.log('\n[a] steering splits one execution across two assistant messages')
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-c5-'))
  const workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-c5-work-')))
  writeStore(store, 8901)

  const mock = await startMock(8901, async ({ send, done, sawTool }) => {
    const base = { id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'gpt-4o' }
    if (!sawTool) {
      // 第 1 轮:推理(top 落点)+ 一个工具调用。慢一点,好让插话赶在流里。
      send({ ...base, choices: [{ index: 0, delta: { reasoning_content: 'first I plan' } }] })
      await sleep(1200)
      send({
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_steer_1', type: 'function', function: { name: 'time', arguments: '{"action":"now"}' } }] } }],
      })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } })
      done()
      return
    }
    // 第 2 轮(插话已经进历史):推理 + 正文收尾。
    //
    // **先等一下**:`response-boundary` 是引擎在 chunk 队列那一侧处理的
    // (`createNextAssistantWriter`),而记录器挂在 provider 的 onEvent 上、同步。
    // 一个零延迟的假 provider 会让记录器整整跑赢引擎一个回合(见 §10.12 的
    // "新发现"),真机上模型的首字节延迟天然把这一段盖住了。这里补上那点延迟,
    // 复现的是真机的次序 —— 次序本身由下面的断言钉着。
    await sleep(800)
    send({ ...base, choices: [{ index: 0, delta: { reasoning_content: 'now with the steer in mind' } }] })
    send({ ...base, choices: [{ index: 0, delta: { content: 'done' } }] })
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 } })
    done()
  })

  const handle = await boot({ store, workdir, serverPort: 8902, sessionName: 'steer' })
  const { sessionId, headers } = handle
  const url = `http://127.0.0.1:8902/api/sessions/${sessionId}/commands`
  const eventsPath = path.join(store, 'sessions', sessionId, 'events.jsonl')

  await fetch(url, { method: 'POST', headers, body: JSON.stringify({ type: 'command:send-message', content: 'what time is it' }) })
  await sleep(600) // 第一轮还在流着
  await fetch(url, { method: 'POST', headers, body: JSON.stringify({ type: 'command:send-message', content: 'be thorough' }) })

  await waitForRunEnds(eventsPath, 2)
  const { stats, shadowLines } = await shutdown(handle, store)

  const events = readJsonl(eventsPath)
  const starts = events.filter(event => event.type === 'run/start')
  check(starts.length === 2, '两条 run/start', `got ${starts.length}`)
  const steer = starts[1]
  check(steer?.data.kind === 'steer', '第二条是 kind:steer', steer?.data.kind)
  check(steer?.data.continuesRunId === starts[0]?.data.runId, 'continuesRunId 指向被接手的那条', JSON.stringify(steer?.data.continuesRunId))
  // 次序上唯一真正要紧的一条:第 2 轮的**正文**不许记在旧 run 名下。
  // (`request/recipe` / `request/start` 落在旧 run 上是无害的 —— 回合号正是靠
  // 它们在旧 run 上的编号接上的。零延迟的假 provider 会让记录器跑赢引擎整整
  // 一个回合,连正文都记错 run —— 见 §10.12 的"新发现"。)
  const strayBody = events.filter(event =>
    (event.type === 'assistant/chunks' || event.type === 'assistant/part-end')
    && event.data.requestIndex === 2
    && event.data.runId !== steer?.data.runId)
  check(strayBody.length === 0, '第 2 轮的正文全部记在新 run 名下', `${strayBody.length} 条落在旧 run`)

  const messages = readJsonl(path.join(store, 'sessions', sessionId, 'messages.jsonl'))
    .filter(record => record.t === 'm').map(record => record.m ?? record)
  const assistants = messages.filter(message => message.role === 'assistant')
  check(assistants.length === 2, '两条 assistant 消息', `got ${assistants.length}`)
  const [first, second] = assistants
  check(first?.usage === undefined, '被打断那条没有 usage', JSON.stringify(first?.usage))
  check(first?.reasoning === 'first I plan', '被打断那条的推理仍是 top 落点', JSON.stringify(first?.reasoning))
  check(!second?.reasoning, '接手那条的 reasoning 字段是空的', JSON.stringify(second?.reasoning))
  const secondParts = (second?.contentParts ?? []).filter(part => part.type === 'reasoning')
  check(secondParts.length === 1 && secondParts[0].turnIndex === 2,
    '接手那条开头的推理在 contentParts 且 turnIndex=2',
    JSON.stringify((second?.contentParts ?? []).map(p => [p.type, p.turnIndex])))
  check(second?.usage?.totalTokens === 380, '整次执行的 usage 落在接手那条(130+250)', JSON.stringify(second?.usage))

  assertShadowClean(stats, shadowLines, '(a)')
  mock.close()
  if (!KEEP) { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(workdir, { recursive: true, force: true }) }
  return { store, stats }
}

// ===========================================================================
// (b) 失败但跑完了的工具:自报标题 + 结构化结局
// ===========================================================================
async function scenarioFailedTool() {
  console.log('\n[b] a failed-but-completed tool keeps its title and its structured result')
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-c6-'))
  const workdir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onething-c6-work-')))
  writeStore(store, 8903)
  const target = path.join(workdir, 'notes.md')
  fs.writeFileSync(target, 'line one\nline two\nline three\n')

  const mock = await startMock(8903, async ({ send, done, sawTool }) => {
    const base = { id: 'chatcmpl-x', object: 'chat.completion.chunk', model: 'gpt-4o' }
    if (!sawTool) {
      send({
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_fail_1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: target, offset: 330 }) } }] } }],
      })
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      done()
      return
    }
    send({ ...base, choices: [{ index: 0, delta: { content: 'that offset is past the end' } }] })
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } })
    done()
  })

  const handle = await boot({ store, workdir, serverPort: 8904, sessionName: 'failed-tool' })
  const { sessionId, headers } = handle
  const eventsPath = path.join(store, 'sessions', sessionId, 'events.jsonl')
  await fetch(`http://127.0.0.1:8904/api/sessions/${sessionId}/commands`, {
    method: 'POST', headers, body: JSON.stringify({ type: 'command:send-message', content: 'read past the end' }),
  })
  await waitForRunEnds(eventsPath, 1)
  const { stats, shadowLines } = await shutdown(handle, store)

  const events = readJsonl(eventsPath)
  const result = events.find(event => event.type === 'tool/result')
  check(result?.data.isError === true, 'tool/result.isError = true', JSON.stringify(result?.data.isError))
  check(typeof result?.data.reportedTitle === 'string' && result.data.reportedTitle.startsWith('Reading '),
    'tool/result 带工具自报的标题', JSON.stringify(result?.data.reportedTitle))
  const structured = result?.data.resultData && 'text' in result.data.resultData
    ? JSON.parse(result.data.resultData.text) : undefined
  check(structured?.success === false && typeof structured?.error === 'string',
    'tool/result.resultData 是结构化结局', JSON.stringify(structured))

  const messages = readJsonl(path.join(store, 'sessions', sessionId, 'messages.jsonl'))
    .filter(record => record.t === 'm').map(record => record.m ?? record)
  const assistant = messages.find(message => message.role === 'assistant' && (message.steps ?? []).length > 0)
  const step = assistant?.steps?.[0]
  const toolCall = assistant?.toolCalls?.[0]
  check(step?.title === result?.data.reportedTitle, 'step.title = 工具自报的标题', JSON.stringify(step?.title))
  check(step?.status === 'failed', 'step.status = failed', JSON.stringify(step?.status))
  check(typeof step?.result === 'string' && step.result === step.error,
    'step.result 与 step.error 两格并存且相同', JSON.stringify({ result: step?.result, error: step?.error }))
  check(toolCall?.result?.success === false, 'toolCall.result 是结构化结局', JSON.stringify(toolCall?.result))

  assertShadowClean(stats, shadowLines, '(b)')
  mock.close()
  if (!KEEP) { fs.rmSync(store, { recursive: true, force: true }); fs.rmSync(workdir, { recursive: true, force: true }) }
  return { store, stats }
}

const a = await scenarioSteer()
const b = await scenarioFailedTool()

console.log('\n[verify] stats:', JSON.stringify({ a: a.stats, b: b.stats }))
if (failures.length > 0) {
  console.error(`\n[verify] RED — ${failures.length} failed:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log('\n[verify] GREEN')
