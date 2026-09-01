#!/usr/bin/env node
/**
 * 流式**块结构**门(09-01 用户录屏报障:「用 agent 时,流式渲染中 think、table
 * 等内容会出现再消失,再出现」)。
 *
 * ── 它与 gate:monotone 的分工 ──────────────────────────────────────────
 * `gate:monotone` 量的是**正文总长**不回缩,素材纯正文、没有推理也没有表。这条报障
 * 恰恰落在它盖不到的两格上:
 *
 *  · 一整块思考消失时,后面的正文还在继续长 —— **总长曲线可以是单调的**;
 *  · 表格在 code ↔ table 之间来回换装,总长的涨落被别处的增长盖住。
 *
 * 所以这条门量的是**结构**:逐帧记下最后一条 assistant 消息里每一件东西的类型、
 * 位置与文本,断言三条纪律。
 *
 * ── 三条断言(各自钉一条真机病)────────────────────────────────────────
 *  A. **思考块只增不减**。修前真机读数:t=7441ms 结构 `[think,text,think]` →
 *     `[think,text]`,那一整段思考在屏幕上没了 **2166ms** 才回来。
 *     病根:打包行 `assistant/chunks` 只说明「这一截进账本了」,不说明「画得出来」
 *     —— 流式期间账本投影里没有行内推理(要等 `contentParts` 物化),而旧的
 *     `trimTailByChunks` 按打包行字符数把它从活尾巴前端裁走了(见 chat-fold 的
 *     `handOverToLedger` 文件注)。
 *  B. **思考块不搬家**。同一块思考在相邻两帧里的位置序号不许变。它钉的是交接的
 *     **顺序闸**:账本流式期只有一格扁平的 `content`,前面那截交不出去时后面的
 *     正文也不许交,否则思考段会被拉到表格后面、还和下一段思考并成一块
 *     (第一版修法的真机读数:t=4.8s `think|text|表|text|think(205)`)。
 *  C. **表格成形后不再降级回 code**。修前一条流里降级 17 帧,每次伴随一次内容
 *     回缩(254→217、278→229);病根是 `incremental.toFrame` 的
 *     `!text.endsWith('\n')` 判据会**逐行来回翻**,单向闸修掉(见那个文件注)。
 *
 * ── 素材与节拍 ────────────────────────────────────────────────────────
 * 推理 ↔ 正文交替(deepseek 的 `reasoning_content`)+ 一张逐行长出来的表,
 * 6 字 / 45ms,整流约 10s —— 跨过好几道 2s 打包闸,每一段都各自经历一次打包行到达。
 *
 * 跑法:`node scripts/gate-stream-structure.mjs`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 可重复:每次一个全新的临时 store,跑完删干净;起的进程在 finally 里逐个收尸。
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

/* ── 素材 ──────────────────────────────────────────────────────────────── */

const THINK_1 =
  '先看清楚要做什么。素材里既有思考也有正文,还有一张表。要量的是:思考段在打包行到达的那一刻会不会从屏幕上消失。这一段要写得足够长,长到跨过两秒那道打包闸,不然打包行根本不会来。再补几句凑长度,让这一段思考至少两百个字符往上,确保它自己就吃掉一整个打包窗。'
const TEXT_1 = '先说结论:这条链路是通的。下面按步骤展开,每一步都给出可以复核的读数。'
const THINK_2 =
  '第二段思考。它开在正文之后,所以是**行内推理**而不是顶部推理 —— 落点不同,尾巴里的去处也不同。行内推理在流式期间没有物化成 part,打包行若把它从尾巴前端裁走,屏幕上就没有第二个产地。这正是 A 条要钉的那件事。再写长一点,凑过打包闸。'
const TEXT_2 = [
  '',
  '| 项 | 状态 | 备注 |',
  '| --- | --- | --- |',
  '| 传输 | 真 | POST /api/rpc |',
  '| 账本 | 真 | events.jsonl |',
  '| 表格 | 真 | 需要整行结构才成形 |',
  '',
  '表格上面一段,表格下面一段 —— 中间那张表在流式期间要逐行长出来。',
].join('\n')
const THINK_3 =
  '第三段思考,继续往后拖时间,让整条流跨过又一道打包闸。写满两百字以上,确保每一段都各自经历一次打包行到达。这里再补一些字,把长度垫够,免得整段被一次打包行一口吃掉,那样就量不到交接的那一刻了。'
const TEXT_3 = '最后一段正文收尾,`行内代码` 与 **加粗**,把这条流收干净。'

const SCRIPT = [
  ['reasoning', THINK_1],
  ['content', TEXT_1],
  ['reasoning', THINK_2],
  ['content', TEXT_2],
  ['reasoning', THINK_3],
  ['content', TEXT_3],
]

const TRIGGER = 'STREAM_STRUCTURE_GATE'
const PIECE_DELAY_MS = 45

const pieces = text => text.match(/[\s\S]{1,6}/g) ?? []

function startMockProvider(port) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch { /* ignore */ }
      const flat = (Array.isArray(payload.messages) ? payload.messages : [])
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
        .join('\n')
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = obj => {
        if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`)
      }
      const frame = (delta, finish = null) => ({
        id: 'chatcmpl-structure',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-reasoner',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      if (!flat.includes(TRIGGER)) {
        send(frame({ content: 'ok' }))
        send(frame({}, 'stop'))
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      for (const [kind, text] of SCRIPT) {
        for (const piece of pieces(text)) {
          if (res.destroyed) return
          send(frame(kind === 'reasoning' ? { reasoning_content: piece } : { content: piece }))
          await delay(PIECE_DELAY_MS)
        }
      }
      send(frame({}, 'stop'))
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

/* ── 支架(照 gate-stream-monotone.mjs)──────────────────────────────────── */

function readDiscovery(store) {
  try { return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8')) } catch { return undefined }
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}
function portConnects(host, port) {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const settle = value => { socket.destroy(); resolve(value) }
    socket.setTimeout(500)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}
async function waitFor(label, predicate, timeoutMs = 40_000) {
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
  if (!body || body.ok !== true) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
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
 * rAF 采样器:逐帧记**最后一条 assistant 消息的结构**。
 *
 * 一件东西 = 一个思考块(`chat-thought`)或一个正文块(`data-prose`)。思考块**里面**
 * 的块不重复计(它自己就是一件东西)。每件记类型、文本长度、文本头 14 字(身份)。
 * 只记结构不截图:断言要的是「哪一件在不在、在第几位」,像素在这里没有用。
 */
function installSampler(page) {
  return page.evaluate(() => {
    const baseline = document.querySelectorAll('[data-message-id][data-role="assistant"]').length
    window.__struct = { frames: [], done: false, baseline, seenReadout: false }
    const shapeOf = el => {
      const out = []
      for (const node of el.querySelectorAll('[data-testid="chat-thought"],[data-prose]')) {
        if (node.parentElement?.closest('[data-testid="chat-thought"]')) continue
        const text = node.textContent ?? ''
        out.push({
          k: node.getAttribute('data-testid') === 'chat-thought'
            ? 'think'
            : (node.getAttribute('data-prose') ?? node.tagName.toLowerCase()),
          n: text.length,
          h: text.slice(0, 14),
        })
      }
      return out
    }
    const tick = () => {
      const rows = document.querySelectorAll('[data-message-id][data-role="assistant"]')
      const art = rows.length > baseline ? rows[rows.length - 1] : undefined
      if (document.querySelector('[data-testid="chat-readout"]')) window.__struct.seenReadout = true
      if (art) window.__struct.frames.push({ t: Math.round(performance.now()), s: shapeOf(art) })
      if (!window.__struct.done) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

/* ── 三条断言 ──────────────────────────────────────────────────────────── */

/** A:思考块的条数只增不减。 */
function findThinkVanished(frames) {
  const out = []
  for (let i = 1; i < frames.length; i += 1) {
    const before = frames[i - 1].s.filter(b => b.k === 'think').length
    const after = frames[i].s.filter(b => b.k === 'think').length
    if (after < before) out.push({ i, t: frames[i].t, before, after })
  }
  return out
}

/** B:同一块思考(按头 14 字认)在相邻两帧里的位置序号不许变。 */
function findThinkMoved(frames) {
  const out = []
  let prev
  for (const frame of frames) {
    const pos = new Map()
    frame.s.forEach((block, index) => { if (block.k === 'think') pos.set(block.h, index) })
    if (prev) {
      for (const [head, index] of pos) {
        const was = prev.get(head)
        if (was !== undefined && was !== index) out.push({ t: frame.t, head, was, now: index })
      }
    }
    prev = pos
  }
  return out
}

/**
 * C:表格成形之后不再降级回 code。
 *
 * 判据读**块的檐**:表格檐是「Copy Markdown / Copy CSV」,代码檐是「Copy source」
 * —— 两者都是块壳画上去的第一段文字,所以块的 textContent 开头就说得出它此刻是谁。
 */
function findTableDowngrades(frames) {
  const out = []
  let formed = false
  for (const frame of frames) {
    for (const block of frame.s) {
      if (block.k !== 'object') continue
      if (block.h.startsWith('Copy Markdown')) formed = true
      else if (formed && block.h.startsWith('Copy source')) out.push({ t: frame.t, head: block.h })
    }
  }
  return out
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[structure-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[structure-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'structure-gate-'))
  const mockPort = 18800 + Math.floor(Math.random() * 200)
  let mock
  let server
  let app
  try {
    console.log('[1/3] 起假慢流 provider 与真 core')
    mock = await startMockProvider(mockPort)
    // 钥匙走环境变量(headless core 没有 safeStorage,理由见 gate-stream-monotone.mjs)。
    writeFileSync(path.join(store, 'settings.json'), JSON.stringify({
      ai: {
        provider: 'deepseek',
        temperature: 0.6,
        providers: {
          deepseek: {
            baseUrl: `http://127.0.0.1:${mockPort}/v1`,
            model: 'deepseek-reasoner',
            selectedModels: ['deepseek-reasoner'],
            enabled: true,
            modelCapabilitiesByModel: {
              'deepseek-reasoner': { tools: false, reasoning: true, vision: false },
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
      env: { ...process.env, ONETHING_STORE_PATH: store, DEEPSEEK_API_KEY: 'sk-structure-gate' },
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

    console.log('[2/3] 拉起应用,喂一条推理↔正文交替 + 表格的慢流')
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

    const made = await rpc(record, 'sessions', 'create', { name: '结构门' })
    const sessionId = made?.session?.id
    if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(made)}`)
    await clickTestId(page, 'dock-tile-sessions')
    await waitFor('总览画出那张卡', () =>
      page.evaluate(id => Boolean(document.querySelector(`[data-testid="card-${id}"]`)), sessionId),
    )
    await clickTestId(page, `card-${sessionId}`)
    await waitFor('聊天区就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="chat-stream"]'))),
    )

    await installSampler(page)
    await rpc(record, 'session-command', 'emit', {
      sessionId,
      command: { type: 'command:send-message', content: `${TRIGGER} 请开始`, suppressTitleGeneration: true },
    })
    await waitFor('assistant 完稿', async () => {
      const state = await page.evaluate(() => ({
        readout: Boolean(document.querySelector('[data-testid="chat-readout"]')),
        seen: window.__struct?.seenReadout ?? false,
        n: window.__struct?.frames.length ?? 0,
      }))
      return state.seen && !state.readout && state.n > 50 ? state : undefined
    }, 120_000)
    await delay(400)
    const frames = await page.evaluate(() => { window.__struct.done = true; return window.__struct.frames })

    console.log(`[3/3] 断言(采到 ${frames.length} 帧)`)
    assert(frames.length > 100, `采到 ${frames.length} 帧结构读数`)
    const finalThinks = frames[frames.length - 1].s.filter(b => b.k === 'think').length
    assert(finalThinks >= 3, `完稿时屏幕上有 ${finalThinks} 个思考块(素材给了 3 段)`)
    assert(
      frames[frames.length - 1].s.some(b => b.k === 'object'),
      '完稿时那张表在屏幕上',
    )

    const vanished = findThinkVanished(frames)
    if (vanished.length > 0) {
      const shown = vanished.slice(0, 5).map(v => `t=${v.t}ms ${v.before}→${v.after}`).join(' · ')
      throw new Error(`断言失败:A 思考块消失了 ${vanished.length} 次(${shown})`)
    }
    assert(true, `A 思考块全程只增不减(${frames.length} 帧零消失)`)

    const moved = findThinkMoved(frames)
    if (moved.length > 0) {
      const shown = moved.slice(0, 5).map(m => `t=${m.t}ms「${m.head}」${m.was}→${m.now}`).join(' · ')
      throw new Error(`断言失败:B 思考块搬家 ${moved.length} 次(${shown})`)
    }
    assert(true, 'B 思考块全程不搬家(位置序号一帧都没变过)')

    const downgrades = findTableDowngrades(frames)
    if (downgrades.length > 0) {
      throw new Error(
        `断言失败:C 表格成形后又降级回 code,共 ${downgrades.length} 帧(首次 t=${downgrades[0].t}ms)`,
      )
    }
    assert(true, 'C 表格成形后再没降级回 code(单向闸)')

    await app.close()
    app = undefined
    console.log('\n[structure-gate] ok —— 思考块不消失、不搬家,表格不回退')
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    if (mock) mock.close()
    await delay(600)
    await rm(store, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\n[structure-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
