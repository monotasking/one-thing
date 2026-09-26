#!/usr/bin/env node
/**
 * `npm run gate:route` —— 轮转 v2(批 6,正本 `docs/design/provider-settings-rework-2026-09.md` §9.3)。
 *
 * 证的是**产物**:`dist/server/main.js` 起在一间临时 store 上,旁边一台本地假站同时扮演
 * 订阅家(Codex Responses 流 + `wham/usage` 配额口)、同家 API(OpenAI Responses 流)与一家
 * 按量 API(DeepSeek chat/completions)。假站**按凭证**决定怎么答(Bearer 是哪条就按哪条的剧本),
 * 所以「这一发用了哪条凭证」直接读假站的来访记录。绝不打真服务商:假站之外的一切出网请求都
 * 撞在一个不存在的代理口上(`HTTP(S)_PROXY=127.0.0.1:9`,回环直连)。
 *
 *   ① 订阅账号 A 窗口 100%、B 40%(配额服务取数,A 写上配额冷却)→ 下一发选 B;
 *   ② B 这一发 429 `usage_limit_reached`、开关开 → 沿序列接同家 API 第一把,`auto-retry` 的
 *      reason 是「订阅额度已用完,这一轮按 API 计费」;再发一条 → 发送前就直接走 API(不再碰订阅);
 *   ③ 开关关(`providers.codex.subscriptionFallback = false`)→ 失败句「全部冷却中」,假站零请求;
 *   ④ A 的窗口 `resets_at` 过后 → 回到 A;
 *   ⑤ 默认空间两把密钥(池没写策略 = 新缺省「按顺序接力」),第一把 402 → 换第二把;
 *   ⑥ 流到一半失败(已上屏半句)→ 换凭证重试:落盘的回答里那半句**不重复**;dev 校验
 *      (`sessions.validation`)对这条会话不报「内容不一致」(core `Session` 按账本作废摘段);
 *   ⑦ 上一轮跑过工具、这一轮配额失败 → 仍然换凭证,工具**只执行一次**(「跑过工具后不再换」
 *      只管同一次请求里已经动手的工具,见回报里的结论)。
 *   ⑧ 请求旋钮跟家走(批 6 留账):订阅家与同家 API 各在自己的设置里存一个 `verbosity`
 *      (订阅 high / API low)。② 里 B 429 → 接力 k1 那一发,请求体里的 `text.verbosity` 是
 *      API 家的 low —— 旋钮袋按接下来真收请求的那一家重挂,不是首次解析那一家的键;
 *   ⑨ 运行收尾按当前凭证(批 6 留账):⑤⑥⑦ 三轮都在运行中途换过手(d1→d2 / d2→d3 / d3→d4),
 *      run 结束 30 秒去抖后的余额刷新(`GET /user/balance`)打的是换手后的 d2 / d3 / d4,
 *      **d1 一次都不被问**(修之前按首次解析那条刷:d1 / d2 / d3)。同家 API 那一半(openai)
 *      没有配额源,② 那一轮收尾刷的是「无源」—— 所以这一步借按量家的余额口证「按当前凭证」。
 *
 * **必须用 node 起**(同 gate:quota):server 的检索 Worker 要 `node:sqlite`,bun 没有。
 * 不构建:缺 `dist/server/main.js` 就叫你先在仓根 `bun run server:build`。不连 5175,不碰真 `~/.onething`。
 * 跑一趟约 75 秒(④ 要真等窗口重置,⑨ 要真等 30 秒去抖)。**不进 verify**。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const TAG = '[gate:route]'

if (!fs.existsSync(serverEntry)) {
  console.error(`${TAG} 缺 dist/server/main.js —— 先在仓根跑 \`bun run server:build\``)
  process.exit(1)
}

const failures = []
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
function check(condition, message) {
  if (condition) console.log(`  ok   ${message}`)
  else {
    failures.push(message)
    console.error(`  FAIL ${message}`)
  }
}
async function waitFor(predicate, budgetMs, stepMs = 50) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < budgetMs) {
    const value = await predicate()
    if (value) return value
    await sleep(stepMs)
  }
  return undefined
}

/* ── 凭证与剧本 ─────────────────────────────────────────────────────────── */

const ROUTE_FALLBACK_API_REASON = '订阅额度已用完,这一轮按 API 计费'
const T = {
  A: 'at-sub-A', B: 'at-sub-B',
  k1: 'sk-api-k1', k2: 'sk-api-k2',
  d1: 'sk-ds-d1', d2: 'sk-ds-d2', d3: 'sk-ds-d3', d4: 'sk-ds-d4', d5: 'sk-ds-d5',
}
const WHO = Object.fromEntries(Object.entries(T).map(([name, secret]) => [secret, name]))
const A_RESET_MS = 22_000
/** 配额服务的 run 结束去抖(`QUOTA_RUN_END_DEBOUNCE_MS`)。⑨ 要等它过去。 */
const QUOTA_RUN_END_DEBOUNCE_MS = 30_000

/* ── 假站 ─────────────────────────────────────────────────────────────── */

function startStation() {
  const hits = []
  // 每条凭证一张剧本:数组逐发消费,最后一格之后一直用最后一格。
  const script = {
    A: ['ok'], B: ['ok'], k1: ['ok'], k2: ['ok'],
    d1: ['402'], d2: ['ok'], d3: ['ok'], d4: ['ok'], d5: ['ok'],
  }
  const served = {}
  const quotaWindows = {
    A: { used: 100, resetAt: Math.floor((Date.now() + A_RESET_MS) / 1000) },
    B: { used: 40, resetAt: Math.floor((Date.now() + 3_600_000) / 1000) },
  }
  const next = who => {
    const list = script[who] ?? ['ok']
    const index = served[who] ?? 0
    served[who] = index + 1
    return list[Math.min(index, list.length - 1)]
  }
  const send = (res, status, data) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(data))
  }
  const sse = async (res, frames) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    for (const frame of frames) {
      if (res.destroyed) return
      res.write(`data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`)
      await sleep(15)
    }
    res.end()
  }
  const responsesText = (who, text) => [
    { type: 'response.created', response: { id: `resp_${who}` } },
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: { id: `resp_${who}`, usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } },
  ]
  const chat = (delta, finish = null) => ({
    id: 'chatcmpl-gate', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
    model: 'deepseek-chat', choices: [{ index: 0, delta, finish_reason: finish }],
  })
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', async () => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      const who = WHO[auth] ?? `?${auth.slice(0, 12)}`
      let body = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}') } catch { /* 非 JSON */ }
      if (req.method === 'GET' && url.pathname === '/user/balance') {
        hits.push({ path: url.pathname, who, at: Date.now() })
        return send(res, 200, {
          is_available: true,
          balance_infos: [{ currency: 'CNY', total_balance: '42.00', granted_balance: '0.00', topped_up_balance: '42.00' }],
        })
      }
      if (req.method === 'GET' && url.pathname === '/backend-api/wham/usage') {
        hits.push({ path: url.pathname, who, at: Date.now() })
        const window = quotaWindows[who]
        if (!window) return send(res, 401, { error: 'unknown account' })
        return send(res, 200, {
          plan_type: 'plus',
          rate_limit: {
            primary_window: { used_percent: window.used, limit_window_seconds: 18_000, reset_at: window.resetAt },
            secondary_window: { used_percent: 10, limit_window_seconds: 604_800, reset_at: Math.floor((Date.now() + 86_400_000) / 1000) },
          },
        })
      }
      if (req.method !== 'POST') return send(res, 404, { error: 'not_found', path: url.pathname })
      const act = next(who)
      hits.push({
        path: url.pathname, who, act, at: Date.now(),
        messages: Array.isArray(body.messages) ? body.messages.length : undefined,
        // ⑧:Responses 线上 `verbosity` 拼在 `text.verbosity`(chat 线上是顶层)。
        verbosity: body?.text?.verbosity ?? body?.verbosity,
      })

      if (url.pathname.endsWith('/responses')) {
        if (act === '429') {
          return send(res, 429, { error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus' } })
        }
        return sse(res, responsesText(who, `路由门由 ${who} 作答`))
      }
      if (url.pathname.endsWith('/chat/completions')) {
        if (act === '402') return send(res, 402, { error: { message: 'Insufficient Balance', type: 'unknown_error' } })
        if (act === 'midstream') {
          return sse(res, [chat({ content: '半截' }), chat({ content: '回答' }), { error: { message: 'Insufficient Balance', type: 'insufficient_quota' } }])
        }
        if (act === 'tool') {
          return sse(res, [
            chat({ tool_calls: [{ index: 0, id: 'call_gate_time', type: 'function', function: { name: 'time', arguments: '' } }] }),
            chat({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }),
            chat({}, 'tool_calls'),
            '[DONE]',
          ])
        }
        return sse(res, [chat({ content: `完整回答(${who})` }), chat({}, 'stop'), '[DONE]'])
      }
      send(res, 404, { error: 'not_found', path: url.pathname })
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        hits,
        script,
        quotaWindows,
        sends: (since = 0) => hits.filter(hit => hit.act !== undefined && hit.at > since),
        /** 换一条凭证的剧本(从头逐发消费)。 */
        play: (who, list) => {
          script[who] = list
          served[who] = 0
        },
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}

/* ── 临时 store ───────────────────────────────────────────────────────────── */

function seedStore(storePath, base) {
  const farFuture = Date.now() + 30 * 86_400_000
  const token = accessToken => ({ accessToken, refreshToken: `rt-${accessToken}`, expiresAt: farFuture, tokenType: 'Bearer', accountId: `acct-${accessToken}` })
  const entry = (id, fields) => ({ id, label: id, source: 'user', ...fields })
  const account = id => entry(id, { authType: 'oauth', oauthToken: token(T[id]), baseUrl: `${base}/backend-api/codex` })
  const apiKey = (id, baseUrl) => entry(id, { authType: 'apiKey', apiKey: T[id], baseUrl })
  const provider = (model, extra = {}) => ({ model, selectedModels: [model], enabled: true, modelCapabilitiesByModel: { [model]: { tools: true, reasoning: false, vision: false } }, ...extra })
  // ⑧:两家各一份请求旋钮(手改 settings 的形状:`providerOptions.request`)。
  const knob = verbosity => ({ providerOptions: { request: { verbosity } } })

  const workspaces = path.join(storePath, 'workspaces')
  fs.mkdirSync(path.join(workspaces, 'default'), { recursive: true })
  fs.mkdirSync(path.join(workspaces, 'gate'), { recursive: true })
  fs.writeFileSync(path.join(workspaces, 'index.json'), JSON.stringify({
    spaces: [{ id: 'default', name: '默认空间', createdAt: 0 }, { id: 'gate', name: '路由门', createdAt: 1 }],
  }, null, 2))

  // 「路由门」空间:订阅家两个账号 + 同家 API 两把密钥(非默认空间:每个账号自己的令牌住在条目上)。
  fs.writeFileSync(path.join(workspaces, 'gate', 'credentials.json'), JSON.stringify({
    version: 2,
    encryption: 'none',
    providers: {
      codex: { policy: 'single', entries: [account('A'), account('B')] },
      openai: { policy: 'priority-failover', entries: [apiKey('k1', `${base}/api/v1`), apiKey('k2', `${base}/api/v1`)] },
    },
  }, null, 2))
  fs.writeFileSync(path.join(workspaces, 'gate', 'providers.json'), JSON.stringify({
    ai: {
      provider: 'codex',
      providers: { codex: provider('gpt-5.3-codex', knob('high')), openai: provider('gpt-5.3-codex', knob('low')) },
      customProviders: [],
    },
  }, null, 2))

  // 默认空间:按量的一家,**池不写策略** —— 读出来就是新缺省「按顺序接力」(§9.2)。
  fs.writeFileSync(path.join(workspaces, 'default', 'credentials.json'), JSON.stringify({
    version: 2,
    encryption: 'none',
    providers: {
      deepseek: { entries: ['d1', 'd2', 'd3', 'd4', 'd5'].map(id => apiKey(id, base)) },
    },
  }, null, 2))
  // 默认空间的 provider 表里也列上 codex / openai(不给凭证):引擎起流时「用哪一家」按
  // `store.getSettings()`(默认空间那一份)判存在性,凭证与开关才按会话所在空间解 ——
  // 与 gate:quota 的种法同形(那是存量的解析口径,不是本批的事)。
  fs.writeFileSync(path.join(workspaces, 'default', 'providers.json'), JSON.stringify({
    ai: {
      provider: 'deepseek',
      providers: { deepseek: provider('deepseek-chat'), codex: provider('gpt-5.3-codex'), openai: provider('gpt-5.3-codex') },
      customProviders: [],
    },
  }, null, 2))

  fs.writeFileSync(path.join(storePath, 'settings.json'), JSON.stringify({
    storage: { providerConfigMigratedAt: 1, spaceProviderSettingsMigratedAt: 1 },
    tools: { enableToolCalls: true, permissionMode: 'dangerously-allow-all', tools: {} },
    diagnostics: { enabled: false },
  }, null, 2))
}

/* ── server 的面 ─────────────────────────────────────────────────────────── */

async function waitForDiscovery(storePath, timeoutMs = 30_000) {
  const discoveryFile = path.join(storePath, 'run', 'http.json')
  const found = await waitFor(() => {
    if (!fs.existsSync(discoveryFile)) return undefined
    try {
      const discovery = JSON.parse(fs.readFileSync(discoveryFile, 'utf-8'))
      return discovery?.port ? discovery : undefined
    } catch {
      return undefined
    }
  }, timeoutMs, 200)
  if (!found) throw new Error('server did not publish its discovery file in time')
  return found
}

function createRpc(discovery) {
  const base = `http://127.0.0.1:${discovery.port}`
  const headers = { 'content-type': 'application/json', ...(discovery.token ? { authorization: `Bearer ${discovery.token}` } : {}) }
  return async (domain, method, payload = {}) => {
    const response = await fetch(`${base}/api/rpc`, { method: 'POST', headers, body: JSON.stringify({ domain, method, payload }) })
    if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
    const body = await response.json()
    if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method}: ${JSON.stringify(body?.error ?? body)}`)
    return body.data
  }
}

function readEvents(storePath, sessionId) {
  const file = path.join(storePath, 'sessions', sessionId, 'events.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}

function readLogRecords(storePath) {
  const dir = path.join(storePath, 'log')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl'))
    .flatMap(name => fs.readFileSync(path.join(dir, name), 'utf-8').split('\n').filter(Boolean))
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}

/* ── 门 ─────────────────────────────────────────────────────────────────── */

const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-gate-route-'))
const station = await startStation()
const startedAt = Date.now()
let child
const serverOut = []

try {
  seedStore(storePath, station.base)
  const env = { ...process.env }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key]
  child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...env,
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '127.0.0.1,localhost',
      ONETHING_STORE_PATH: storePath,
      ONETHING_SERVER_DATA_ROOT: storePath,
      ONETHING_SERVER_HOST: '127.0.0.1',
      ONETHING_SERVER_PORT: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => serverOut.push(chunk.toString()))
  child.stderr.on('data', chunk => serverOut.push(chunk.toString()))

  const discovery = await waitForDiscovery(storePath)
  const rpc = createRpc(discovery)

  // 发送带上模型选择器里那一对(与壳一样):非默认空间的会话不带这一对时,引擎按全局默认挑。
  const pick = new Map()
  const newSession = async (workspaceId, providerId, model) => {
    const made = await rpc('sessions', 'create', { name: `路由门 ${providerId}`, ...(workspaceId ? { workspaceId } : {}) })
    const sessionId = made?.session?.id
    if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(made)}`)
    await rpc('sessions', 'updateModel', { sessionId, provider: providerId, model })
    pick.set(sessionId, { providerId, model })
    return sessionId
  }
  const emitSend = (sessionId, content) => rpc('session-command', 'emit', {
    sessionId,
    command: { type: 'command:send-message', content, suppressTitleGeneration: true, ...pick.get(sessionId) },
  })
  /** 发一条,等这一轮的 `run/end` 落盘(或前置拦截:一段时间内没有新 run)。 */
  const sendAndSettle = async (sessionId, content, budgetMs = 15_000) => {
    const runsBefore = readEvents(storePath, sessionId).filter(event => event.type === 'run/end').length
    await emitSend(sessionId, content)
    await waitFor(() => readEvents(storePath, sessionId).filter(event => event.type === 'run/end').length > runsBefore, budgetMs, 100)
    await sleep(200)
    return readEvents(storePath, sessionId)
  }
  const assistantText = async sessionId => {
    const got = await rpc('sessions', 'get', { sessionId })
    const messages = got?.session?.messages ?? []
    const last = [...messages].reverse().find(message => message.role === 'assistant')
    const content = last?.content
    return typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part?.text ?? '').join('') : ''
  }
  const retryReasons = events => events.filter(event => event.type === 'request/error' && event.data?.willRetry).map(event => event.data?.error?.message)
  const quota = (providerId, extra = {}) => rpc('providers', 'quota', { providerId, spaceId: 'gate', ...extra })

  // ── ① 订阅账号按窗口剩余量选 ─────────────────────────────────────────────
  console.log(`${TAG} ① A 100% / B 40% → B`)
  const qa = await quota('codex', { credentialId: 'A', force: true })
  const qb = await quota('codex', { credentialId: 'B', force: true })
  check(qa.quota?.kind === 'windows' && qb.quota?.kind === 'windows', `配额服务取到两个账号的窗口(A ${JSON.stringify(qa.quota?.windows?.[0]?.usedPercent)} / B ${JSON.stringify(qb.quota?.windows?.[0]?.usedPercent)})`)
  const creds = await rpc('spaces', 'getCredentials', { id: 'gate' })
  const aRow = creds?.credentials?.providers?.codex?.entries?.find(item => item.id === 'A')
  check(aRow?.cooldownReason === 'quota' && aRow?.cooldownUntil >= Date.now() + A_RESET_MS - 15_000,
    `A 窗口满:配额冷却写到重置时刻(cooldownReason=${aRow?.cooldownReason})`)
  const decided = await quota('codex')
  check(decided.credentialId === 'B', `密钥策略只读 decide = B(${decided.credentialId})`)
  const gateSession = await newSession('gate', 'codex', 'gpt-5.3-codex')
  let mark = Date.now()
  await sendAndSettle(gateSession, '第一问')
  const s1 = station.sends(mark)
  check(s1.length === 1 && s1[0].who === 'B' && s1[0].path.endsWith('/backend-api/codex/responses'),
    `这一发用 B 打订阅口(${s1.map(hit => `${hit.who}@${hit.path}`).join(', ')})`)

  // ── ② 订阅都满 → 同家 API ────────────────────────────────────────────────
  console.log(`${TAG} ② A/B 都满、开关开 → 同家 API 第一把`)
  station.play('B', ['429'])
  mark = Date.now()
  const events2 = await sendAndSettle(gateSession, '第二问')
  const s2 = station.sends(mark)
  check(s2.map(hit => hit.who).join(',') === 'B,k1' && s2[1].path.endsWith('/api/v1/responses'),
    `B 429 usage_limit_reached → 沿序列接 API 第一把 k1(${s2.map(hit => `${hit.who}@${hit.path}`).join(', ')})`)
  const reasons2 = retryReasons(events2)
  check(reasons2.at(-1) === ROUTE_FALLBACK_API_REASON, `auto-retry 的 reason:「${reasons2.at(-1)}」`)
  check((await assistantText(gateSession)).includes('由 k1 作答'), '回答来自 API 那一把')
  // ── ⑧ 请求旋钮跟家走 ───────────────────────────────────────────────────
  console.log(`${TAG} ⑧ 接力到 API 那一发带的是 API 家的旋钮`)
  check(s2[1]?.verbosity === 'low',
    `B → k1 接力那一发:请求体 text.verbosity = API 家的 low(${JSON.stringify(s2[1]?.verbosity)};订阅家存的是 high)`)
  mark = Date.now()
  await sendAndSettle(gateSession, '第三问')
  const s2b = station.sends(mark)
  check(s2b.length === 1 && s2b[0].who === 'k1',
    `A/B 都在冷却 → 发送前就直接走同家 API,订阅口零请求(${s2b.map(hit => hit.who).join(',')})`)
  check(s2b[0]?.verbosity === 'low', `发送前就接力的那一发同样是 API 家的旋钮(${JSON.stringify(s2b[0]?.verbosity)})`)

  // ── ③ 开关关 → 失败句 ────────────────────────────────────────────────────
  console.log(`${TAG} ③ 开关关 → 失败句`)
  const current = await rpc('spaces', 'getProviderSettings', { id: 'gate' })
  const ai = current?.ai ?? current?.settings ?? current
  const offAi = { ...ai, providers: { ...ai.providers, codex: { ...ai.providers.codex, subscriptionFallback: false } } }
  await rpc('spaces', 'setProviderSettings', { id: 'gate', ai: offAi })
  mark = Date.now()
  const before3 = readEvents(storePath, gateSession).length
  await emitSend(gateSession, '第四问')
  await sleep(2_500)
  const tail3 = readEvents(storePath, gateSession).slice(before3)
  const logText = fs.existsSync(path.join(storePath, 'log'))
    ? fs.readdirSync(path.join(storePath, 'log')).filter(name => name.endsWith('.jsonl')).map(name => fs.readFileSync(path.join(storePath, 'log', name), 'utf-8')).join('\n')
    : ''
  const said = JSON.stringify(tail3) + serverOut.join('') + logText
  check(station.sends(mark).length === 0, `开关关:假站零请求(${station.sends(mark).map(hit => hit.who).join(',') || '无'})`)
  check(said.includes('全部冷却中'), '开关关:失败句是今天那句「凭证全部冷却中」')
  await rpc('spaces', 'setProviderSettings', {
    id: 'gate',
    ai: { ...ai, providers: { ...ai.providers, codex: { ...ai.providers.codex } } },
  })

  // ── ④ 窗口重置 → 回 A ───────────────────────────────────────────────────
  console.log(`${TAG} ④ A 的 resets_at 过后 → 回 A`)
  const resetAt = station.quotaWindows.A.resetAt * 1000
  await sleep(Math.max(0, resetAt - Date.now() + 1_000))
  const back = await quota('codex')
  check(back.credentialId === 'A', `重置之后 decide 回到 A(${back.credentialId})`)
  mark = Date.now()
  await sendAndSettle(gateSession, '第五问')
  const s4 = station.sends(mark)
  check(s4.length === 1 && s4[0].who === 'A', `这一发用 A(${s4.map(hit => hit.who).join(',')})`)

  // ── ⑤ 默认空间:两把密钥,402 → 第二把 ────────────────────────────────────
  console.log(`${TAG} ⑤ 默认空间 402 → 第二把`)
  const dsSession = await newSession(undefined, 'deepseek', 'deepseek-chat')
  mark = Date.now()
  const events5 = await sendAndSettle(dsSession, '默认空间那一问')
  const s5 = station.sends(mark)
  check(s5.map(hit => hit.who).join(',') === 'd1,d2', `d1 402 → d2(${s5.map(hit => hit.who).join(',')})`)
  check(retryReasons(events5).some(reason => String(reason).includes('配额耗尽')), `auto-retry reason:「${retryReasons(events5).at(-1)}」`)
  const pool = await rpc('spaces', 'getCredentials', { id: 'default' })
  check(pool?.credentials?.providers?.deepseek?.policy === 'priority-failover', `池没写策略 → 读作「按顺序接力」(${pool?.credentials?.providers?.deepseek?.policy})`)

  // ── ⑥ 流到一半失败 → 换凭证重试,已上屏的半句不重复 ─────────────────────
  console.log(`${TAG} ⑥ 流到一半失败`)
  station.play('d2', ['midstream'])
  const midSession = await newSession(undefined, 'deepseek', 'deepseek-chat')
  mark = Date.now()
  await sendAndSettle(midSession, '流到一半那一问')
  const s6 = station.sends(mark)
  const text6 = await assistantText(midSession)
  check(s6.map(hit => hit.who).join(',') === 'd2,d3', `d2 流到一半报余额不足 → d3(${s6.map(hit => hit.who).join(',')})`)
  check(text6 === '完整回答(d3)', `落盘的回答只有重试那一遍(「${text6}」)`)
  const text6Again = await assistantText(midSession)
  check(!text6Again.includes('半截回答'), '失败那一发的半句不留在回答里')
  // 旧文字流通道(`session:stream`)上那半句收不回,但 core `Session` 的累计值据账本
  // `request/error.discardParts` 摘掉了同号段 —— dev 校验(`sessions.validation`)不再报不一致。
  const inconsistent6 = readLogRecords(storePath)
    .filter(record => record.ns === 'sessions.validation' && record.level === 'warn' && record.fields?.sessionId === midSession)
  check(inconsistent6.length === 0,
    `sessions.validation 对这条会话零「内容不一致」(${inconsistent6.map(record => String(record.fields?.detail ?? '').slice(0, 80)).join(' | ') || '无'})`)

  // ── ⑦ 上一轮跑过工具,这一轮配额失败 → 仍然换,工具只跑一次 ──────────────
  console.log(`${TAG} ⑦ 跑过工具之后的换凭证`)
  station.play('d3', ['tool', '402'])
  const toolSession = await newSession(undefined, 'deepseek', 'deepseek-chat')
  mark = Date.now()
  const events7 = await sendAndSettle(toolSession, '现在几点')
  const s7 = station.sends(mark)
  const toolResults = events7.filter(event => event.type === 'tool/result')
  check(s7.map(hit => `${hit.who}:${hit.act}`).join(',') === 'd3:tool,d3:402,d4:ok',
    `第一轮 d3 要工具 → 第二轮 d3 402 → 换 d4(${s7.map(hit => `${hit.who}:${hit.act}`).join(',')})`)
  check(toolResults.length === 1, `工具只执行一次(tool/result ${toolResults.length} 条)`)
  check((await assistantText(toolSession)).includes('完整回答(d4)'), '回答来自 d4')
  const lastRunEndAt = Date.now()

  // ── ⑨ 运行收尾的配额刷新按换手后的凭证 ────────────────────────────────────
  console.log(`${TAG} ⑨ run 结束的余额刷新按当前凭证(等 ${QUOTA_RUN_END_DEBOUNCE_MS / 1000}s 去抖)`)
  const balanceWho = () => station.hits.filter(hit => hit.path === '/user/balance').map(hit => hit.who)
  await waitFor(() => balanceWho().includes('d4'), QUOTA_RUN_END_DEBOUNCE_MS + 10_000 - (Date.now() - lastRunEndAt), 250)
  await sleep(500)
  const asked = balanceWho()
  check(['d2', 'd3', 'd4'].every(who => asked.includes(who)),
    `换手后的 d2 / d3 / d4 各被问了余额(${asked.join(',') || '无'})`)
  check(!asked.includes('d1'), `首次解析的 d1 一次都没被问(${asked.join(',') || '无'})`)

  const unexpected = station.hits.filter(hit => hit.who.startsWith('?'))
  check(unexpected.length === 0, `假站没收到认不出的凭证(${unexpected.map(hit => `${hit.who}@${hit.path}`).join(', ') || '无'})`)
  if (failures.length > 0) console.error(`${TAG} server 输出尾:\n${serverOut.slice(-40).join('')}`)
} catch (error) {
  failures.push(String(error?.stack || error))
  console.error(`${TAG} ${error?.stack || error}`)
  console.error(`${TAG} server 输出尾:\n${serverOut.slice(-40).join('')}`)
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 8_000, 100)
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch { /* 已经没了 */ }
    }
  }
  await station.close()
  if (process.env.ONETHING_GATE_KEEP_STORE) console.log(`${TAG} kept store: ${storePath}`)
  else fs.rmSync(storePath, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`${TAG} ${failures.length} check(s) failed (${Math.round((Date.now() - startedAt) / 1000)}s)`)
  process.exit(1)
}
console.log(`${TAG} ok —— ① 按剩余量 / ② 接同家 API / ③ 开关关 / ④ 窗口重置回 A / ⑤ 默认空间 402 / ⑥ 流中失败不重复 / ⑦ 工具后换凭证 / ⑧ 旋钮跟家走 / ⑨ 收尾按当前凭证 全绿(${Math.round((Date.now() - startedAt) / 1000)}s)`)
