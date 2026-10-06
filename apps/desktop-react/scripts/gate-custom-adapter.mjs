#!/usr/bin/env node
/**
 * 真机门 · 自定义服务商「自动识别」(provider 整改 批 4 §7.3,
 * `docs/design/provider-settings-rework-2026-09.md`)。
 *
 * 起一台真的 `dist/server/main.js`(临时 store)、两台本地假转发站、一台假分析模型,全程 HTTP:
 *
 *  ① 偏差站(思考放在 `delta.reasoning` 而不是 `reasoning_content`):`providers.probeCustom`
 *     走「需要分析」那条路 —— 分析模型(内置 deepseek 指向本地假站,返回一张固定的适配表 JSON)
 *     被请恰好一次,回验通过,摘要里 `reasoningPath === 'choices[0].delta.reasoning'`;
 *  ② 把答回来的适配表**应用**(写进 `customProviders[]` 那一条,整份存设置),以这一家为聊天
 *     provider 发一轮消息:账本(`sessionEvents.listRaw`)里有思考增量,且就是偏差站那句思考;
 *  ③ 规则判满的标准站(字段名全是默认的):`probeCustom` 零次调用分析模型,`analyzed === false`。
 *
 * 前提:仓根 `bun run server:build`。不进 `npm run verify`(脚本在清单外单跑:`npm run gate:custom-adapter`)。
 * 不碰真 store、不连 5175、不起窗口;起的每个进程 / 端口都在 finally 里收掉。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')

const RELAY_ID = 'custom-gate-relay'
const RELAY_MODEL = 'relay-think-1'
const RELAY_THOUGHT = '先看看用户要什么。'
const RELAY_TEXT = '你好,我是转发站。'
const ANALYST_SPEC = {
  version: 1,
  wire: 'openai-chat',
  response: { reasoningDeltaPath: 'choices[0].delta.reasoning' },
  probe: { confidence: 'high', notes: 'reasoning lives in delta.reasoning' },
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败:${message}`)
  console.log(`  ✓ ${message}`)
}

async function waitFor(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await delay(150)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)?.slice(0, 600)}`)
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

function close(server) {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()))
}

function sseFrame(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`
}

function chunk(model, delta, finish = null, extra = {}) {
  return { id: 'chatcmpl-gate', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra }
}

/**
 * 一台假转发站。`reasoningKey` 决定思考放在哪一格:偏差站 = `reasoning`,标准站 = `reasoning_content`。
 * `calls` 记每一发(方法 + 路径),门据它判「探测真的打到了这里」。
 */
function startRelay(reasoningKey) {
  const calls = []
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`)
    req.resume()
    req.on('end', async () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: RELAY_MODEL, object: 'model' }, { id: 'relay-lite', object: 'model' }] }))
        return
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(sseFrame(chunk(RELAY_MODEL, { role: 'assistant', content: '', [reasoningKey]: RELAY_THOUGHT })))
        await delay(10)
        res.write(sseFrame(chunk(RELAY_MODEL, { content: RELAY_TEXT })))
        res.write(sseFrame(chunk(RELAY_MODEL, {}, 'stop')))
        res.write(sseFrame(chunk(RELAY_MODEL, {}, null, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 } })))
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
    })
  })
  return { server, calls }
}

/** 假分析模型(内置 deepseek 指向它):不看问题,答那张固定的适配表 JSON,切成三片流式送出。 */
function startAnalyst() {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      calls.push({ url: req.url, body })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const text = JSON.stringify(ANALYST_SPEC)
      const size = Math.ceil(text.length / 3)
      for (let at = 0; at < text.length; at += size) {
        res.write(sseFrame(chunk('deepseek-chat', { content: text.slice(at, at + size) })))
        await delay(5)
      }
      res.write(sseFrame(chunk('deepseek-chat', {}, 'stop', { usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } })))
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return { server, calls }
}

async function rpc(record, domain, method, payload = {}) {
  const response = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(record.token ? { authorization: `Bearer ${record.token}` } : {}) },
    body: JSON.stringify({ domain, method, payload }),
  })
  if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
  const body = await response.json()
  if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  return body.data
}

function readDiscovery(store) {
  try {
    return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8'))
  } catch {
    return undefined
  }
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[gate:custom-adapter] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'gate-custom-adapter-'))
  const deviant = startRelay('reasoning')
  const standard = startRelay('reasoning_content')
  const analyst = startAnalyst()
  let server
  const serverOut = []
  try {
    console.log('\n[1/4] 起两台假转发站 + 假分析模型,写隔离 settings.json')
    const deviantPort = await listen(deviant.server)
    const standardPort = await listen(standard.server)
    const analystPort = await listen(analyst.server)
    const relayBase = `http://127.0.0.1:${deviantPort}/v1`
    writeFileSync(path.join(store, 'settings.json'), JSON.stringify({
      ai: {
        provider: 'deepseek',
        temperature: 0.6,
        providers: {
          deepseek: {
            baseUrl: `http://127.0.0.1:${analystPort}/v1`,
            model: 'deepseek-chat',
            selectedModels: ['deepseek-chat'],
            enabled: true,
            modelCapabilitiesByModel: { 'deepseek-chat': { tools: false, reasoning: false, vision: false } },
          },
          [RELAY_ID]: {
            baseUrl: relayBase,
            model: RELAY_MODEL,
            selectedModels: [RELAY_MODEL],
            enabled: true,
            modelCapabilitiesByModel: { [RELAY_MODEL]: { tools: false, reasoning: true, vision: false } },
          },
        },
        customProviders: [{ id: RELAY_ID, name: '门 · 转发站', dialect: 'custom-openai', baseUrl: relayBase, model: RELAY_MODEL, selectedModels: [RELAY_MODEL], enabled: true }],
        modelCatalog: {},
      },
      tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
      diagnostics: { enabled: false },
    }, null, 2))

    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      // headless 宿主的钥匙走环境变量(`<PROVIDER_ID 去掉 custom->_API_KEY`),不写盘。
      env: { ...process.env, DEEPSEEK_API_KEY: 'sk-gate-analyst', GATE_RELAY_API_KEY: 'sk-relay-secret', ONETHING_STORE_PATH: store, ONETHING_CREDENTIALS_KEYRING: 'file' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (c) => serverOut.push(c.toString()))
    server.stderr.on('data', (c) => serverOut.push(c.toString()))
    const record = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    })
    assert(Boolean(record.port), `core 起在临时 store 上(端口 ${record.port})`)

    console.log('\n[2/4] ① 偏差站:需要分析 → 分析模型答表 → 回验通过')
    const probe = await rpc(record, 'providers', 'probeCustom', { baseUrl: relayBase, apiKey: 'sk-relay-secret' })
    assert(probe.ok === true, `probeCustom ok(${JSON.stringify({ reasonKind: probe.reasonKind, error: probe.error })})`)
    assert(probe.analyzed === true, '走了「需要分析」那条路(analyzed = true)')
    assert(analyst.calls.length === 1, `分析模型被请恰好一次(实际 ${analyst.calls.length})`)
    assert(!analyst.calls[0].body.includes('sk-relay-secret'), '交给分析模型的样本里没有转发站的密钥')
    assert(probe.summary?.reasoningPath === 'choices[0].delta.reasoning', `摘要 reasoningPath = ${probe.summary?.reasoningPath}`)
    assert(probe.summary?.wireLabelKey === 'providers.dialect.custom-openai', `摘要 wireLabelKey = ${probe.summary?.wireLabelKey}`)
    assert(probe.summary?.modelCount === 2, `摘要 modelCount = ${probe.summary?.modelCount}`)
    assert(deviant.calls.includes('GET /v1/models') && deviant.calls.includes('POST /v1/chat/completions'), '探两发都打到了偏差站')

    console.log('\n[3/4] ② 应用适配表 → 以这一家发一轮 → 账本里有思考增量')
    const current = await rpc(record, 'settings', 'getSettings', {})
    const settings = current.settings
    const next = {
      ...settings,
      ai: {
        ...settings.ai,
        provider: RELAY_ID,
        customProviders: (settings.ai.customProviders ?? []).map((p) => (p.id === RELAY_ID ? { ...p, adapter: probe.spec } : p)),
      },
    }
    const saved = await rpc(record, 'settings', 'saveSettings', next)
    assert(saved.success === true, `设置存上了(${saved.error ?? 'ok'})`)
    const reread = await rpc(record, 'settings', 'getSettings', {})
    const persisted = reread.settings.ai.customProviders.find((p) => p.id === RELAY_ID)
    assert(persisted?.adapter?.response?.reasoningDeltaPath === 'choices[0].delta.reasoning', '适配表落在 customProviders[] 那一条上')

    const made = await rpc(record, 'sessions', 'create', { name: '门 · 自动识别' })
    const sessionId = made?.session?.id
    assert(Boolean(sessionId), `建了一条会话 ${sessionId}`)
    const before = deviant.calls.filter((c) => c === 'POST /v1/chat/completions').length
    await rpc(record, 'session-command', 'emit', {
      sessionId,
      command: { type: 'command:send-message', content: '打个招呼' },
    })
    const raw = await waitFor('这一轮在账本里收尾(出现正文)', async () => {
      const listed = await rpc(record, 'sessionEvents', 'listRaw', { sessionId })
      const text = JSON.stringify(listed.events ?? [])
      return text.includes(RELAY_TEXT) ? listed.events : undefined
    }, 45_000).catch(async (error) => {
      const listed = await rpc(record, 'sessionEvents', 'listRaw', { sessionId }).catch(() => undefined)
      const loud = serverOut.join('').split('\n').filter((line) => /WARN|ERROR|FATAL/.test(line)).slice(-20)
      throw new Error(
        `${error.message}\n账本:${JSON.stringify(listed?.events ?? []).slice(0, 1500)}\nserver 告警:\n${loud.join('\n')}`,
      )
    })
    // ≥ 而不是 ===:会话自动起题走的是同一家聊天 provider,也会打一发。
    assert(deviant.calls.filter((c) => c === 'POST /v1/chat/completions').length >= before + 1, '这一轮真的打到了偏差站')
    // 账本的 `assistant/chunks` 按 kind 分段存增量;这里不猜编码细节,整棵走一遍找 kind === 'reasoning' 的段。
    const reasoningSegments = []
    const walk = (value) => {
      if (Array.isArray(value)) return value.forEach(walk)
      if (!value || typeof value !== 'object') return
      if (value.kind === 'reasoning') reasoningSegments.push(value)
      Object.values(value).forEach(walk)
    }
    walk(raw.filter((event) => event.type === 'assistant/chunks'))
    const rawText = JSON.stringify(raw)
    assert(reasoningSegments.length > 0, `账本 assistant/chunks 里有思考段(${reasoningSegments.length} 段)`)
    assert(JSON.stringify(reasoningSegments).includes(RELAY_THOUGHT), '思考段就是偏差站 `delta.reasoning` 里那句')
    assert(rawText.includes(RELAY_TEXT), '正文也在账本里')

    console.log('\n[4/4] ③ 标准站:规则判满 → 零次调用分析模型')
    const analystBefore = analyst.calls.length
    const plain = await rpc(record, 'providers', 'probeCustom', { baseUrl: `http://127.0.0.1:${standardPort}/v1` })
    assert(plain.ok === true, `probeCustom ok(${plain.reasonKind ?? 'ok'})`)
    assert(plain.analyzed === false, 'analyzed = false')
    assert(analyst.calls.length === analystBefore, `分析模型零次调用(前 ${analystBefore} / 后 ${analyst.calls.length})`)
    assert(plain.spec?.wire === 'openai-chat' && plain.spec?.response === undefined, '适配表只写了 wire')
    assert(plain.summary?.reasoningPath === 'choices[0].delta.reasoning_content', `摘要 reasoningPath = ${plain.summary?.reasoningPath}`)

    console.log('\n[gate:custom-adapter] 全绿')
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM')
      await Promise.race([new Promise((r) => server.once('exit', r)), delay(6000)])
      if (server.exitCode === null) server.kill('SIGKILL')
    }
    await Promise.all([close(deviant.server), close(standard.server), close(analyst.server)])
    await rm(store, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`\n[gate:custom-adapter] 红:${error.message}`)
  process.exit(1)
})
