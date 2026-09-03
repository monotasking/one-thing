#!/usr/bin/env node
/**
 * 流式正文单调门(内容块流式契约 §6:只许文本追加,屏幕正文不许回缩)。
 *
 * ── 它钉的那条真机病(08-31 报障:「未闭合引用块正文回缩」)────────────────
 * 实测读数 …119,125,6,14,…,163:流到 ~2s 处正文整段缩回,只剩几个字重新长。
 * 报障时疑在 markdown 的 stable-cut,查下来**引用块和 stable-cut 都是替罪羊**,
 * 真病根在 chat-fold.appendTail:
 *
 *  · 流式中 materialize 出的消息**没有 contentParts**(parts 到 request/end
 *    才物化),折叠的正文只活在 message.content 里;
 *  · anchor 步有「parts 空则按 content 现搭一格」的兜底,但 appendTail 把活
 *    尾巴 push 进 parts 之后 parts 非空,兜底失效 —— 屏幕上只画尾巴;
 *  · 打包行(assistant/chunks,2s / 64 条闸)一到,尾巴按纪律整段丢掉,
 *    「账本接管」却接不上屏 —— 被打包的正文从屏幕消失,直到 run 收尾。
 *
 * 判据因此不是引用块,是**流时长跨过 2000ms 打包闸**:当年的「纯文本无此
 * 现象」只是对照素材太短(<2s,打包行从没来过)。两组素材都必须流超 2s,
 * 纯文本组同样在钉这条病,不只是对照。
 *
 * ── 门的做法 ─────────────────────────────────────────────────────────────
 *  ① 起真 core(dist/server)+ 一个**假慢流 provider**(OpenAI 兼容 SSE,
 *     每 100ms 吐 ≤6 个字符,整流 ~3s,跨过打包闸);
 *  ② 拉起真应用,进会话,注入一条消息触发流式生成;
 *  ③ 页面里挂一个 rAF 采样器,逐帧读 assistant 消息的正文 textContent 长度
 *     (扣掉读数行 / 动作行 —— 它们不是正文,且各有自己的涨落);
 *  ④ 断言:序列**单调不减**(块结构原位换装是等长的,允许持平)。
 *
 * 跑法:`node scripts/gate-stream-monotone.mjs`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 可重复:每次一个全新的临时 store,跑完删干净。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import http from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** 报障原形:引用块(含裸 `>` 行与嵌套)+ 前后正文,整流 ~3s(跨打包闸)。 */
const QUOTE_MATERIAL = [
  '滚动锚定的关键是把「跟底」做成一个可撤销的状态。',
  '',
  '> 账本是唯一事实,屏幕只是折叠。任何「顺手存一份」的快照,都会变成第二份真相。',
  '>',
  '> 写侧收敛成一件事:先落账,再推进活投影。',
  '>',
  '> > ——这一句本身又引自 deepseek-harness 的设计笔记:一切皆投影,不存 duration。',
  '',
  '引用之后正文照常接续,间距走节奏表,不额外加档。',
].join('\n')

/** 纯文本组:同样流超 2s —— 这条病与引用块无关,纯文本一样要过打包闸。 */
const PLAIN_MATERIAL = [
  '纯文本组的第一段,写满一行的样子,用来垫出足够的采样帧数与流时长,并且再多写几个字。',
  '',
  '第二段继续写,让整条流的时长与引用组相当,确保同样跨过两秒那道打包闸,这里也再垫长一点。',
  '',
  '第三段收尾,再写一些字把总长度垫过一百六十个字符,凑够一次跨块、跨打包行的完整慢流。',
].join('\n')

const SCENARIOS = [
  { name: 'plain', trigger: 'MONO_PLAIN', material: PLAIN_MATERIAL },
  { name: 'quote', trigger: 'MONO_QUOTE', material: QUOTE_MATERIAL },
]

// ============================================================ 假慢流 provider

/** 把素材切成 ≤6 字符的小片 —— 与真流的 delta 粒度同数量级。 */
function splitMaterial(text) {
  return text.match(/[\s\S]{1,6}/g) ?? []
}

function startMockProvider(port) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* ignore */ }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      const flat = messages
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
        .join('\n')

      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = obj => {
        if (res.writableEnded || res.destroyed) return
        res.write(`data: ${JSON.stringify(obj)}\n\n`)
      }
      const frame = (delta, finishReason = null) => ({
        id: 'chatcmpl-mono',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })

      const scenario = SCENARIOS.find(s => flat.includes(s.trigger))
      if (!scenario) {
        // 标题生成之类的旁路请求:一句短回答,别卡住。
        send(frame({ content: 'ok' }))
        send(frame({}, 'stop'))
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      for (const piece of splitMaterial(scenario.material)) {
        if (res.destroyed) return
        send(frame({ content: piece }))
        await delay(100)
      }
      send(frame({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

// ============================================================ 支架(照 gate-chat.mjs)

function readDiscovery(store) {
  try {
    return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8'))
  } catch {
    return undefined
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function portConnects(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const settle = value => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(500)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

async function waitFor(label, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await delay(120)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败:${message}`)
  console.log(`  ✓ ${message}`)
}

async function rpc(record, domain, method, payload = {}) {
  const response = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(record.token ? { authorization: `Bearer ${record.token}` } : {}),
    },
    body: JSON.stringify({ domain, method, payload }),
  })
  if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
  const body = await response.json()
  if (!body || body.ok !== true) {
    throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  }
  return body.data
}

async function clickTestId(page, testId) {
  const clicked = await page.evaluate(id => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    el.click()
    return true
  }, testId)
  if (!clicked) throw new Error(`点不到:[data-testid="${testId}"] 不在 DOM 里`)
}

/**
 * rAF 采样器:逐帧读**最后一条 assistant 消息**的正文 textContent 长度。
 * 读数行(chat-readout)与动作行(chat-actions)不是正文,扣掉 —— 前者每 100ms
 * 换读数、后者流完才出现,都会把长度曲线搅浑。
 */
function installSampler(page) {
  return page.evaluate(() => {
    const baseline = document.querySelectorAll('[data-message-id][data-role="assistant"]').length
    window.__mono = { samples: [], done: false, readoutSeen: false, baseline }
    const tick = () => {
      const rows = document.querySelectorAll('[data-message-id][data-role="assistant"]')
      // 只认**这一场**长出来的 assistant:场景开跑前的旧消息不进读数。
      const art = rows.length > baseline ? rows[rows.length - 1] : undefined
      if (document.querySelector('[data-testid="chat-readout"]')) window.__mono.readoutSeen = true
      if (art) {
        let len = art.textContent.length
        for (const el of art.querySelectorAll('[data-testid="chat-readout"],[data-testid="chat-actions"]')) {
          len -= el.textContent.length
        }
        const prev = window.__mono.samples[window.__mono.samples.length - 1]
        if (prev !== undefined && len < prev && !window.__mono.dropSnap) {
          window.__mono.dropSnap = { prevText: window.__mono.lastText, curText: art.textContent }
        }
        window.__mono.samples.push(len)
        window.__mono.lastText = art.textContent
      }
      if (!window.__mono.done) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

/** 找非单调的下降点:返回 [{index, from, to}]。 */
function findDrops(samples) {
  const drops = []
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i] < samples[i - 1]) drops.push({ index: i, from: samples[i - 1], to: samples[i] })
  }
  return drops
}

async function runScenario(page, record, scenario) {
  console.log(`\n—— 场景:${scenario.name} ——`)
  // 每场景一条全新会话:上一场的 assistant 留在旧会话里,采样器面对的是干净的树。
  const made = await rpc(record, 'sessions', 'create', { name: `单调门 ${scenario.name}` })
  const sessionId = made?.session?.id
  if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(made)}`)
  await clickTestId(page, 'dock-tile-sessions')
  await waitFor('总览画出那一行', () =>
    page.evaluate(id => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), sessionId),
  )
  await clickTestId(page, `session-row-${sessionId}`)
  await waitFor('聊天区就位(空树)', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="chat-stream"]'))),
  )
  await installSampler(page)
  await rpc(record, 'session-command', 'emit', {
    sessionId,
    command: { type: 'command:send-message', content: `${scenario.trigger} 请开始`, suppressTitleGeneration: true },
  })

  // 等流真正结束:读数行消失 + 动作行出现(assistant 完稿)。
  // 完稿判据:读数行**出现过**(流真的开了)又**消失了**(流真的收了)。
  await waitFor(`${scenario.name}:assistant 完稿`, async () => {
    const state = await page.evaluate(() => ({
      readout: Boolean(document.querySelector('[data-testid="chat-readout"]')),
      readoutSeen: window.__mono?.readoutSeen ?? false,
      sampled: window.__mono?.samples.length ?? 0,
    }))
    return state.readoutSeen && !state.readout && state.sampled > 10 ? state : undefined
  })
  // 再采几帧,把完稿后的稳定形也收进来。
  await delay(300)
  const samples = await page.evaluate(() => {
    window.__mono.done = true
    return window.__mono.samples
  })

  const nonzero = samples.filter(v => v > 0)
  assert(nonzero.length > 20, `${scenario.name}:采到了 ${nonzero.length} 帧正文读数`)
  const finalLen = nonzero[nonzero.length - 1]
  assert(finalLen > 0, `${scenario.name}:完稿正文非空(末帧 ${finalLen} 字符)`)

  const drops = findDrops(nonzero)
  if (drops.length > 0) {
    const shown = drops
      .slice(0, 8)
      .map(d => `#${d.index}:${d.from}→${d.to}`)
      .join(' ')
    const around = drops[0] ? nonzero.slice(Math.max(0, drops[0].index - 6), drops[0].index + 6).join(',') : ''
    const snap = await page.evaluate(() => window.__mono?.dropSnap ?? null)
    throw new Error(
      `断言失败:${scenario.name}:正文长度非单调,${drops.length} 次回缩(${shown})\n首次回缩附近的序列:…${around}…\n回缩前正文:${JSON.stringify(snap?.prevText ?? '')}\n回缩后正文:${JSON.stringify(snap?.curText ?? '')}`,
    )
  }
  assert(true, `${scenario.name}:正文长度全程单调不减(${nonzero.length} 帧,末帧 ${finalLen})`)
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[mono-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[mono-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'mono-gate-'))
  const mockPort = 18700 + Math.floor(Math.random() * 200)
  let mock
  let server
  let app
  try {
    console.log('[1/4] 起假慢流 provider 与真 core')
    mock = await startMockProvider(mockPort)
    // 照 shadow-battery 的种法:settings.json 把 deepseek 指到本地假 provider。
    //
    // **钥匙走环境变量,不写进 settings.json**(2026-08-31 用户拍板「甲」):
    // 这个 core 是纯 node 子进程,没有 safeStorage,而一次性迁移在**没有加密能力
    // 时拒绝执行**(不然 API key 会明文落盘)。于是靠 `settings.ai` 种钥匙的老写法
    // 在这里必然解析成「未配置」。headless 的正道是环境变量那一格
    // (`providers/env.ts` 的 `DEEPSEEK_API_KEY`)—— 它不需要迁移,也一个字节都不写盘。
    // baseUrl / model / enabled 仍然从 settings 走:env 兜底只顶替钥匙那一格。
    writeFileSync(path.join(store, 'settings.json'), JSON.stringify({
      ai: {
        provider: 'deepseek',
        temperature: 0.6,
        providers: {
          deepseek: {
            baseUrl: `http://127.0.0.1:${mockPort}/v1`,
            model: 'deepseek-chat',
            selectedModels: ['deepseek-chat'],
            enabled: true,
            modelCapabilitiesByModel: {
              'deepseek-chat': { tools: false, reasoning: false, vision: false },
            },
          },
        },
        customProviders: [],
        modelCatalog: {},
      },
      tools: { enableToolCalls: false },
    }))

    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        // 见上:headless 的钥匙走这一格。
        DEEPSEEK_API_KEY: 'sk-mono-gate',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serverErr = []
    server.stderr.on('data', chunk => serverErr.push(chunk.toString()))
    const record = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    }).catch(error => {
      throw new Error(`${error.message}\nserver stderr:\n${serverErr.join('')}`)
    })
    assert(await portConnects(record.host, record.port), `core 端口 ${record.port} 可连`)

    console.log('[2/4] 拉起应用')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '' },
    })
    const page = await app.firstWindow()
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await waitFor('Dock 上的「会话总览」瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
    )
    console.log('[3/4] 对照组:纯文本流式,正文单调')
    await runScenario(page, record, SCENARIOS[0])

    console.log('[4/4] 病灶组:未闭合引用块流式,正文单调')
    await runScenario(page, record, SCENARIOS[1])

    await app.close()
    app = undefined
    console.log('\n[mono-gate] ok —— 两组素材的流式正文长度全程单调不减')
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    if (mock) mock.close()
    await delay(600)
    await rm(store, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\n[mono-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
