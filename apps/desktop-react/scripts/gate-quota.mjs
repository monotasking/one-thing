#!/usr/bin/env node
/**
 * `npm run gate:quota` —— 配额与余额(批 5,正本 `docs/design/provider-settings-rework-2026-09.md` §8.6)。
 *
 * 证的是**产物**:`dist/server/main.js` 起在一间临时 store 上,池里五家各一条凭证(明文 store,
 * 无 safeStorage 的 server 本来就是这样落盘),每条凭证的端点都指到旁边一台本地假接口站 ——
 * 产品代码一行不改,配额源按「凭证生效的端点」推出自己的配额接口地址,于是全部落到假站上。
 * **绝不打真的 chatgpt.com / api.anthropic.com / api.deepseek.com**:假站之外的一切出网请求
 * 都会撞上一个不存在的代理口(`HTTP(S)_PROXY=127.0.0.1:9`,回环直连)。
 *
 *   ① 五源各喂一份真实响应夹具,`providers.quota` 归一逐格对;
 *   ② Codex 两种套餐顺序(primary 是 5h / primary 是 7d)都归到「5h / 7d」;
 *   ③ 每次取到好数都有一帧 `provider:quota` 出网,载荷里没有任何令牌 / 密钥原文;
 *   ④ 429:Claude 那条接口回 429 → 答上一份好数(静默)、不推送;此后 force 连问三次、再跑完一轮
 *      也**零请求**,server 日志记下 10 分钟静默期(`holdMs = 600000`);
 *   ⑤ 被动源:一条 Codex 响应头 → 缓存更新、`provider:quota` 出网,`wham/usage` 零请求;
 *   ⑥ `run/end` 去抖:DeepSeek 连发三轮,30 秒内余额接口零请求,31 秒时恰好一次;
 *      Codex 那一轮因为被动源刚刷过,到点也不问;
 *   ⑦ 读数卡要读的形状逐格在:窗口(5h/7d + 重置时刻)、余额(币种)、不支持(unsupported)、
 *      失败(error + 原话)。卡片行的**措辞**逐格由 `src/composer/quota-rows.test.ts` 钉(那是纯函数)。
 *   ⑧ 默认空间两个订阅账号各答各的窗口(批 8 §8.7,关掉批 5 留账「默认空间多账号拿到的是同一份
 *      配额」):池里 cx-1 / cx-2 两条,按凭证问,打到 wham/usage 的 Bearer 各是各的、窗口各是各的。
 *
 * **必须用 node 起**(同 gate:acp):server 的检索 Worker 要 `node:sqlite`,bun 没有。
 * 不构建:缺 `dist/server/main.js` 就叫你先在仓根 `bun run server:build`。不连 5175,不碰真 `~/.onething`。
 * 跑一趟约 45 秒(⑥ 要真等 30 秒去抖)。**不进 verify**。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const TAG = '[gate:quota]'

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

/* ── 凭证原文:门的最后一步断言它们一个都没出网 ─────────────────────────── */

const SECRETS = {
  codex: 'at-codex-SECRET-0001',
  codex2: 'at-codex-SECRET-0006',
  claude: 'at-claude-SECRET-0002',
  deepseek: 'sk-deepseek-SECRET-0003',
  kimi: 'sk-kimi-SECRET-0004',
  openrouter: 'sk-or-SECRET-0005',
}

/* ── 假接口站 ─────────────────────────────────────────────────────────────── */

const RESET_5H = 1_790_003_600 // 秒,Codex 的写法
const RESET_7D = 1_790_600_000

const CODEX_PLUS_ORDER = {
  plan_type: 'plus',
  rate_limit: {
    primary_window: { used_percent: 62, limit_window_seconds: 18_000, reset_at: RESET_5H },
    secondary_window: { used_percent: 31, limit_window_seconds: 604_800, reset_at: RESET_7D },
  },
  credits: { has_credits: true, unlimited: false, balance: '12.50' },
}
const CODEX_SWAPPED_ORDER = {
  plan_type: 'team',
  rate_limit: {
    primary_window: { used_percent: 31, limit_window_seconds: 604_800, reset_at: RESET_7D },
    secondary_window: { used_percent: 62, limit_window_seconds: 18_000, reset_at: RESET_5H },
  },
}
/** 默认空间第二个 Codex 账号(⑧)的窗口 —— 与第一个故意不同。 */
const CODEX_SECOND_ACCOUNT = {
  plan_type: 'pro',
  rate_limit: {
    primary_window: { used_percent: 15, limit_window_seconds: 18_000, reset_at: RESET_5H },
    secondary_window: { used_percent: 5, limit_window_seconds: 604_800, reset_at: RESET_7D },
  },
}
const CLAUDE_USAGE = {
  five_hour: { utilization: 44, resets_at: '2026-09-26T06:30:00Z' },
  seven_day: { utilization: 18, resets_at: '2026-09-28T00:00:00Z' },
  seven_day_sonnet: { utilization: 9, resets_at: '2026-09-28T00:00:00Z' },
  seven_day_opus: null,
}
const DEEPSEEK_BALANCE = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '123.45', granted_balance: '0.00', topped_up_balance: '123.45' }],
}
const KIMI_BALANCE = { code: 0, data: { available_balance: 49.58, voucher_balance: 46.58, cash_balance: 3 }, status: true }
const OPENROUTER_KEY = { data: { label: 'gate', usage: 5.88, limit: 10, is_free_tier: false } }

function startStation() {
  const hits = []
  const state = { codex: CODEX_PLUS_ORDER, claudeStatus: 200, deepseekStatus: 200 }
  const send = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(data))
  }
  const sse = async (res, frames, headers = {}) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers })
    for (const frame of frames) {
      if (res.destroyed) return
      res.write(`data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`)
      await sleep(15)
    }
    res.end()
  }
  const server = http.createServer((req, res) => {
    // 请求体不看(假站按路径答),但得排干,`end` 才会来。
    req.resume()
    req.on('end', async () => {
      const url = new URL(req.url, 'http://127.0.0.1')
      hits.push({ method: req.method, path: url.pathname, auth: req.headers.authorization ?? '', ua: req.headers['user-agent'] ?? '', beta: req.headers['anthropic-beta'] ?? '', at: Date.now() })
      if (req.method === 'GET' && url.pathname === '/backend-api/wham/usage') {
        // 按 Bearer 答:第二个账号有它自己的窗口(⑧)。
        return send(res, 200, req.headers.authorization === `Bearer ${SECRETS.codex2}` ? CODEX_SECOND_ACCOUNT : state.codex)
      }
      if (req.method === 'GET' && url.pathname === '/api/oauth/usage') {
        return state.claudeStatus === 429
          ? send(res, 429, { error: { type: 'rate_limit_error', message: 'Rate limited' } })
          : send(res, 200, CLAUDE_USAGE)
      }
      if (req.method === 'GET' && url.pathname === '/user/balance') {
        return state.deepseekStatus === 200
          ? send(res, 200, DEEPSEEK_BALANCE)
          : send(res, state.deepseekStatus, { detail: 'upstream exploded' })
      }
      if (req.method === 'GET' && url.pathname === '/v1/users/me/balance') return send(res, 200, KIMI_BALANCE)
      if (req.method === 'GET' && url.pathname === '/api/v1/auth/key') return send(res, 200, OPENROUTER_KEY)
      if (req.method === 'POST' && url.pathname.endsWith('/responses')) {
        // Codex Responses 流:成功响应头上带两窗用量(被动源)。
        return sse(res, [
          { type: 'response.created', response: { id: 'resp_gate' } },
          { type: 'response.output_text.delta', delta: '配额门的回答' },
          { type: 'response.completed', response: { id: 'resp_gate', usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } },
        ], {
          'x-codex-primary-used-percent': '77',
          'x-codex-primary-window-minutes': '300',
          'x-codex-primary-reset-after-seconds': '3600',
          'x-codex-secondary-used-percent': '40',
          'x-codex-secondary-window-minutes': '10080',
          'x-codex-secondary-reset-after-seconds': '86400',
        })
      }
      if (req.method === 'POST' && url.pathname.endsWith('/chat/completions')) {
        const frame = (delta, finish = null) => ({
          id: 'chatcmpl-gate', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000),
          model: 'deepseek-chat', choices: [{ index: 0, delta, finish_reason: finish }],
        })
        return sse(res, [frame({ content: '配额门' }), frame({ content: '的回答' }), frame({}, 'stop'), '[DONE]'])
      }
      send(res, 404, { error: 'not_found', path: url.pathname })
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}`,
        state,
        hits,
        count: (pathname, since = 0) => hits.filter(hit => hit.path === pathname && hit.at > since).length,
        last: pathname => [...hits].reverse().find(hit => hit.path === pathname),
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}

/* ── 临时 store ───────────────────────────────────────────────────────────── */

function seedStore(storePath, base) {
  const farFuture = Date.now() + 30 * 86_400_000
  const token = (accessToken, extra = {}) => ({ accessToken, refreshToken: `rt-${accessToken}`, expiresAt: farFuture, tokenType: 'Bearer', ...extra })
  const entry = (id, fields) => ({ id, label: id, source: 'user', ...fields })
  const pool = entries => ({ policy: 'single', entries })
  const credentials = {
    version: 2,
    encryption: 'none',
    providers: {
      // 批 8:默认空间与别的空间一样,账号的令牌就住在池里这一条上;两个账号两条(⑧)。
      codex: pool([
        entry('cx-1', { authType: 'oauth', oauthToken: token(SECRETS.codex, { accountId: 'acct_gate' }), baseUrl: `${base}/backend-api/codex` }),
        entry('cx-2', { authType: 'oauth', oauthToken: token(SECRETS.codex2, { accountId: 'acct_gate_2' }), baseUrl: `${base}/backend-api/codex` }),
      ]),
      'claude-code': pool([entry('cc-1', { authType: 'oauth', oauthToken: token(SECRETS.claude), baseUrl: `${base}/v1` })]),
      deepseek: pool([entry('ds-1', { authType: 'apiKey', apiKey: SECRETS.deepseek, baseUrl: base })]),
      kimi: pool([entry('km-1', { authType: 'apiKey', apiKey: SECRETS.kimi, baseUrl: `${base}/v1`, region: 'intl' })]),
      openrouter: pool([entry('or-1', { authType: 'apiKey', apiKey: SECRETS.openrouter, baseUrl: `${base}/api/v1` })]),
    },
  }
  const noCaps = model => ({ [model]: { tools: false, reasoning: false, vision: false } })
  const provider = model => ({ model, selectedModels: [model], enabled: true, modelCapabilitiesByModel: noCaps(model) })
  const providers = {
    ai: {
      provider: 'deepseek',
      providers: {
        deepseek: provider('deepseek-chat'),
        codex: provider('gpt-5.3-codex'),
        'claude-code': provider('claude-sonnet-4-20250514'),
        kimi: provider('moonshot-v1-128k'),
        openrouter: provider('openai/gpt-4o'),
        gemini: provider('gemini-2.0-flash-exp'),
      },
      customProviders: [],
    },
  }
  const space = path.join(storePath, 'workspaces', 'default')
  fs.mkdirSync(space, { recursive: true })
  fs.writeFileSync(path.join(space, 'credentials.json'), JSON.stringify(credentials, null, 2))
  fs.writeFileSync(path.join(space, 'providers.json'), JSON.stringify(providers, null, 2))
  // 批 8 之前这里还要另种一份 `oauth-tokens.json` 单槽(默认空间的令牌住在那儿,池里那条只是
  // 「登没登」的标记)。单槽退役:默认空间的账号就是池里这一条条,不再种它。
  fs.writeFileSync(path.join(storePath, 'settings.json'), JSON.stringify({
    storage: { providerConfigMigratedAt: 1, spaceProviderSettingsMigratedAt: 1 },
    tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
    diagnostics: { enabled: false },
  }, null, 2))
}

/* ── server 的两张面 ─────────────────────────────────────────────────────── */

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

/** 订 `GET /api/events`,收 `provider:quota` 帧(原文一并留着,③ 要查里面有没有令牌)。 */
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
          if (event !== 'provider:quota' || dataLines.length === 0) continue
          const text = dataLines.join('\n')
          try {
            frames.push({ raw: text, data: JSON.parse(text), at: Date.now() })
          } catch {
            // 不认的帧不收。
          }
        }
      }
    } catch {
      // 收尾时 abort 掉。
    }
  })()
  return { frames, close: async () => { controller.abort(); await pump } }
}

const windowsOf = quota => (quota?.kind === 'windows' ? quota.windows.map(w => `${w.id}:${w.usedPercent}`) : [])

/* ── 门 ─────────────────────────────────────────────────────────────────── */

const storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'onething-gate-quota-'))
const station = await startStation()
let child
let sse
const serverOut = []

try {
  seedStore(storePath, station.base)
  const env = { ...process.env }
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key]
  child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...env,
      // 假站之外的一切出网请求撞死在一个不存在的代理口上;回环直连。
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
  sse = await openEventStream(discovery)
  const quota = (providerId, extra = {}) => rpc('providers', 'quota', { providerId, spaceId: 'default', ...extra })

  // ── ① 五源各喂夹具,归一逐格对 ─────────────────────────────────────────
  console.log(`${TAG} ① 五源归一`)
  const codex = await quota('codex', { force: true })
  check(codex.credentialId === 'cx-1' && codex.quota.kind === 'windows'
    && windowsOf(codex.quota).join(',') === '5h:62,7d:31'
    && codex.quota.plan === 'plus'
    && codex.quota.balance?.currency === 'credits' && codex.quota.balance?.available === 12.5
    && codex.quota.windows[0].resetsAt === RESET_5H * 1000,
  `codex:5h 62% / 7d 31%,重置时刻秒→毫秒,credits 另出一条(${JSON.stringify(codex.quota)})`)
  const codexHit = station.last('/backend-api/wham/usage')
  check(codexHit?.auth === `Bearer ${SECRETS.codex}`, 'codex:OAuth Bearer 打到 wham/usage')

  const claude = await quota('claude-code', { force: true })
  check(claude.credentialId === 'cc-1' && windowsOf(claude.quota).join(',') === '5h:44,7d:18,seven_day_sonnet:9'
    && claude.quota.windows[2].label === 'Sonnet',
  `claude-code:5h / 本周 / Sonnet 周窗;null 的 opus 窗丢掉(${windowsOf(claude.quota)})`)
  const claudeHit = station.last('/api/oauth/usage')
  check(claudeHit?.beta === 'oauth-2025-04-20' && claudeHit?.ua.startsWith('claude-code/') && claudeHit?.auth === `Bearer ${SECRETS.claude}`,
    `claude-code:三个头都带(beta=${claudeHit?.beta} UA=${claudeHit?.ua})`)

  const deepseek = await quota('deepseek', { force: true })
  check(deepseek.quota.kind === 'balance' && deepseek.quota.currency === 'CNY' && deepseek.quota.available === 123.45,
    `deepseek:余额 ¥123.45(${JSON.stringify(deepseek.quota)})`)
  const kimi = await quota('kimi', { force: true })
  check(kimi.quota.kind === 'balance' && kimi.quota.currency === 'USD' && kimi.quota.available === 49.58,
    `kimi(国际站):余额 $49.58(${JSON.stringify(kimi.quota)})`)
  const openrouter = await quota('openrouter', { force: true })
  check(openrouter.quota.kind === 'balance' && Math.abs(openrouter.quota.available - 4.12) < 1e-9 && openrouter.quota.granted === 10,
    `openrouter:limit − usage = $4.12(${JSON.stringify(openrouter.quota)})`)
  const hitsBeforeGemini = station.hits.length
  const gemini = await quota('gemini', { force: true })
  check(gemini.quota.kind === 'unsupported' && station.hits.length === hitsBeforeGemini,
    '没有配额源的家(gemini):unsupported,假站零请求')

  // ── ② Codex 两种套餐顺序 ────────────────────────────────────────────────
  console.log(`${TAG} ② Codex 套餐顺序`)
  station.state.codex = CODEX_SWAPPED_ORDER
  const swapped = await quota('codex', { force: true })
  check(windowsOf(swapped.quota).join(',') === '5h:62,7d:31',
    `primary 是周窗的套餐也归到 5h / 7d(${windowsOf(swapped.quota)})`)
  const cached = await quota('codex')
  check(station.count('/backend-api/wham/usage') === 2 && windowsOf(cached.quota).join(',') === '5h:62,7d:31',
    `不带 force:60 秒内吃后端缓存,零请求(wham/usage 共 ${station.count('/backend-api/wham/usage')} 次)`)

  // ── ③ provider:quota 出网,载荷无令牌 ───────────────────────────────────
  console.log(`${TAG} ③ 出网`)
  await waitFor(() => sse.frames.length >= 6, 3_000)
  const pushedProviders = [...new Set(sse.frames.map(frame => frame.data.providerId))].sort()
  check(pushedProviders.join(',') === 'claude-code,codex,deepseek,kimi,openrouter',
    `每次取到好数都推一帧 provider:quota(${sse.frames.length} 帧:${pushedProviders})`)
  const leaked = Object.values(SECRETS).filter(secret => sse.frames.some(frame => frame.raw.includes(secret)))
  check(leaked.length === 0, `载荷里没有任何令牌 / 密钥原文(泄漏 ${leaked.length} 条)`)
  check(sse.frames.find(frame => frame.data.providerId === 'deepseek')?.data.credentialId === 'ds-1',
    '帧上带凭证 id(壳据它认领那一格)')

  // ── ④ 429 → 静默 10 分钟 ────────────────────────────────────────────────
  console.log(`${TAG} ④ 429`)
  station.state.claudeStatus = 429
  const framesBefore429 = sse.frames.length
  const limited = await quota('claude-code', { force: true })
  const claudeHits = station.count('/api/oauth/usage')
  check(claudeHits === 2, `force 真去问了一次,吃到 429(/api/oauth/usage 共 ${claudeHits} 次:${JSON.stringify(station.hits.filter(h => h.path === "/api/oauth/usage").map(h => h.at - station.hits[0].at))})`)
  check(limited.quota.kind === 'windows' && windowsOf(limited.quota).join(',') === windowsOf(claude.quota).join(','),
    `429 静默:答上一份好数,不说失败(${limited.quota.kind})`)
  const after429 = Date.now()
  for (let i = 0; i < 3; i += 1) await quota('claude-code', { force: true })
  await sleep(300)
  check(station.count('/api/oauth/usage', after429) === 0, `静默期内 force 连问三次:零请求(${station.count('/api/oauth/usage', after429)})`)
  check(sse.frames.slice(framesBefore429).every(frame => frame.data.providerId !== 'claude-code'), '429 不推送')

  // ── ⑤⑥ 发消息:被动源 + run/end 去抖 ────────────────────────────────────
  console.log(`${TAG} ⑤⑥ 发消息`)
  const newSession = async (providerId, model) => {
    const made = await rpc('sessions', 'create', { name: `配额门 ${providerId}` })
    const sessionId = made?.session?.id
    if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(made)}`)
    await rpc('sessions', 'updateModel', { sessionId, provider: providerId, model })
    return sessionId
  }
  const send = (sessionId, content) =>
    rpc('session-command', 'emit', { sessionId, command: { type: 'command:send-message', content, suppressTitleGeneration: true } })
  const responsesCount = () => station.hits.filter(hit => hit.path.endsWith('/responses')).length
  const completionsCount = () => station.hits.filter(hit => hit.path.endsWith('/chat/completions')).length

  const codexSession = await newSession('codex', 'gpt-5.3-codex')
  const whamBeforeSend = station.count('/backend-api/wham/usage')
  const framesBeforeSend = sse.frames.length
  await send(codexSession, '被动源那一条')
  await waitFor(() => responsesCount() >= 1, 15_000)
  const passive = await waitFor(
    () => sse.frames.slice(framesBeforeSend).find(frame => frame.data.providerId === 'codex' && windowsOf(frame.data.quota).includes('5h:77')),
    10_000,
  )
  check(responsesCount() >= 1, `codex 那一轮真的打到了假站的 /responses(${responsesCount()} 次)`)
  check(Boolean(passive) && passive.data.credentialId === 'cx-1',
    `⑤ 响应头 → provider:quota 出网(5h 77% / 7d 40%,凭证 ${passive?.data.credentialId})`)
  const fromCache = await quota('codex')
  check(windowsOf(fromCache.quota).join(',') === '5h:77,7d:40' && station.count('/backend-api/wham/usage') === whamBeforeSend,
    `⑤ 缓存已被一条响应头更新,wham/usage 零新增(${windowsOf(fromCache.quota)})`)

  const deepseekSession = await newSession('deepseek', 'deepseek-chat')
  const balanceBefore = station.count('/user/balance')
  for (let i = 0; i < 3; i += 1) {
    const before = completionsCount()
    await send(deepseekSession, `第 ${i + 1} 轮`)
    await waitFor(() => completionsCount() > before, 15_000)
    await sleep(400)
  }
  const lastRunEnd = Date.now()
  check(completionsCount() >= 3, `deepseek 三轮都跑完(/chat/completions ${completionsCount()} 次)`)
  await sleep(28_000)
  check(station.count('/user/balance') === balanceBefore,
    `⑥ 最后一次 run/end 之后 28 秒:余额接口零请求(去抖 30 秒,期间三轮只算一次)`)
  await waitFor(() => station.count('/user/balance') > balanceBefore, 6_000, 100)
  await sleep(1_500)
  const balanceHits = station.count('/user/balance') - balanceBefore
  const firedAt = station.last('/user/balance')?.at ?? 0
  check(balanceHits === 1, `⑥ 30 秒去抖到点:恰好一次(${balanceHits} 次,距最后一次 run/end ${firedAt - lastRunEnd}ms)`)
  check(station.count('/backend-api/wham/usage') === whamBeforeSend,
    '⑥ codex 那一轮:被动源 60 秒内刚刷过,run/end 到点也不问')
  check(station.count('/api/oauth/usage', after429) === 0, '④ 静默期一直有效:claude-code 零请求')

  // ── ⑦ 读数卡要读的形状 ────────────────────────────────────────────────
  console.log(`${TAG} ⑦ 卡片读的形状`)
  const ds = await quota('deepseek')
  check(ds.credentialId === 'ds-1' && ds.quota.kind === 'balance' && typeof ds.quota.fetchedAt === 'number',
    '卡片不带凭证 id 问:后端 decide 出这一发会用的那条(ds-1),余额一支带币种')
  check(swapped.quota.windows.every(w => typeof w.seconds === 'number' && typeof w.resetsAt === 'number'),
    '窗口一支:每窗带时长(卡按它命名 5 小时 / 本周)与重置时刻')
  station.state.deepseekStatus = 500
  const broken = await quota('deepseek', { force: true })
  check(broken.quota.kind === 'error' && broken.quota.reason === 'network' && broken.quota.message.includes('upstream exploded'),
    `失败一支:error + 归因 + 服务商原话(${broken.quota.kind}/${broken.quota.reason}:${broken.quota.message})`)

  // 收尾自查:一切请求都落在假站上(除了假站没有别的出口能到)。
  const unexpected = station.hits.filter(hit => !['/backend-api/wham/usage', '/api/oauth/usage', '/user/balance', '/v1/users/me/balance', '/api/v1/auth/key'].includes(hit.path)
    && !hit.path.endsWith('/responses') && !hit.path.endsWith('/chat/completions'))
  check(unexpected.length === 0, `假站没收到意料外的路径(${unexpected.map(hit => hit.path).join(', ') || '无'})`)

  const logDir = path.join(storePath, 'log')
  const records = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).filter(name => name.endsWith('.jsonl'))
      .flatMap(name => fs.readFileSync(path.join(logDir, name), 'utf-8').split('\n'))
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean)
    : []
  const hold = records.find(record => record.msg === 'quota rate-limited; holding')
  check(hold?.fields?.holdMs === 600_000 && hold?.fields?.providerId === 'claude-code',
    `server 日志:quota rate-limited; holding ${JSON.stringify(hold?.fields ?? null)}(10 分钟静默期)`)

  // ── ⑧ 默认空间两个订阅账号各答各的窗口(批 8)─────────────────────────
  console.log(`${TAG} ⑧ 默认空间两账号各答各的`)
  const second = await quota('codex', { credentialId: 'cx-2', force: true })
  const secondHit = station.last('/backend-api/wham/usage')
  check(second.credentialId === 'cx-2' && windowsOf(second.quota).join(',') === '5h:15,7d:5' && second.quota.plan === 'pro',
    `cx-2 答它自己的窗口(${second.credentialId}:${windowsOf(second.quota)} / ${second.quota.plan})`)
  check(secondHit?.auth === `Bearer ${SECRETS.codex2}`, 'cx-2 那一问带的是 cx-2 自己的令牌')
  const firstAgain = await quota('codex', { credentialId: 'cx-1', force: true })
  const firstHit = station.last('/backend-api/wham/usage')
  check(firstAgain.credentialId === 'cx-1' && windowsOf(firstAgain.quota).join(',') !== windowsOf(second.quota).join(',')
    && firstHit?.auth === `Bearer ${SECRETS.codex}`,
  `cx-1 答 cx-1 的窗口、带 cx-1 的令牌(${windowsOf(firstAgain.quota)}),两份不是同一份`)

  if (failures.length > 0) console.error(`${TAG} server 输出尾:\n${serverOut.slice(-40).join('')}`)
} catch (error) {
  failures.push(String(error?.stack || error))
  console.error(`${TAG} ${error?.stack || error}`)
  console.error(`${TAG} server 输出尾:\n${serverOut.slice(-40).join('')}`)
} finally {
  if (sse) await sse.close().catch(() => {})
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    await waitFor(() => child.exitCode !== null || child.signalCode !== null, 8_000, 100)
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL') } catch { /* 已经没了 */ }
    }
  }
  await station.close()
  // 排障:ONETHING_GATE_KEEP_STORE=1 留下临时 store(日志、账本、凭证文件)。
  if (process.env.ONETHING_GATE_KEEP_STORE) console.log(`${TAG} kept store: ${storePath}`)
  else fs.rmSync(storePath, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`${TAG} ${failures.length} check(s) failed`)
  process.exit(1)
}
console.log(`${TAG} ok —— ① 五源归一 / ② 套餐顺序 / ③ 出网无令牌 / ④ 429 静默 / ⑤ 被动源 / ⑥ run/end 去抖 / ⑦ 卡片形状 / ⑧ 两账号各答各的 全绿`)
