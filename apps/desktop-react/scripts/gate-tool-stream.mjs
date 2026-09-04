#!/usr/bin/env node
/**
 * **工具进度活流门**(C2-b,设计 `docs/workbench-2026-09.md` §6.2 表「执行中」列 /
 * §6.3 / §6.6)。
 *
 * 用户报的那一句是「流式看不到做了多少」。C2-a 把工具卡收成一张、把「执行中」那一格
 * 从一个不变的词换成活的耗时;C2-b 把**工具此刻真的吐出来的那一行**送上屏。这道门
 * 量的就是「那一行在动」这件事本身,以及动的时候**别的什么都不许动**。
 *
 * ── 素材 ────────────────────────────────────────────────────────────────
 * 一台假 provider 让模型调一次 `bash`,命令是一个**逐行慢慢吐**的脚本
 * (`for i in $(seq 1 20); do echo "line $i"; sleep 0.1; done`)。它是真的 bash:
 * 门要量的是真链路(工具 → `ctx.emit(progress)` → StreamChannel → SSE → 渲染层),
 * 不是一段编出来的 chunk。
 *
 * ── 六条断言 ────────────────────────────────────────────────────────────
 *  A. **那一行在动**:执行中那一行的摘要至少出现 5 个不同读数(修前恒为参数摘要,
 *     一帧都不变 —— 那正是用户说的「看不到做了多少」);
 *  B. **耗时在走**:同一行右端的读数也在变(C2-a 的账,顺带复核不被 C2-b 压坏);
 *  C. **卡高不因进度抖**:同一「步」内(状态不变的那一段)卡高方差为 0 —— 进度条
 *     绝对定位、摘要单行截断,§6.5 第 2 条几何锁的机器判据;
 *  D. **零重挂**:那一行从头到尾是同一个 DOM 节点(§6.5 第 1 条);
 *  E. **收场后与账本重放逐字相同**:同一条会话重开一次(重载 + 重进),工具卡那
 *     一块的可见文本与收场那一帧逐字相同 —— 进度不进账本,所以重放看到的是结局,
 *     而结局在两条路上必须一致;
 *  F. **events.jsonl 里零 tool-progress**:定律的真机复核(单测那一条守的是同一件
 *     事,这里守的是真店真文件)。
 *
 * 另打印长帧读数(>16ms 的帧数),不做硬断言 —— 它是读数不是闸。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 * **离屏 + 隔离 store + 独立 user-data-dir + 只用 CDP**(09-04 判例「真机门不许抢
 * 用户的机器」):窗子不 show()、不进 Dock,焦点由 CDP `Emulation.setFocusEmulationEnabled`
 * 补,一根手指都不碰真光标;起的进程在 finally 里逐个收尸,临时目录跑完删干净。
 *
 * 跑法:`node scripts/gate-tool-stream.mjs`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
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

const TRIGGER = 'TOOL_STREAM_GATE'
/** 逐行慢慢吐的那条命令。20 行 × 100ms ≈ 2s —— 够采到几十帧,又不拖长门。 */
const COMMAND = 'for i in $(seq 1 20); do echo "line $i"; sleep 0.1; done'
/** 反证口:`--no-emit` 时素材换成一条**一口气吐完**的命令(等价于没有进度)。 */
const SILENT_COMMAND = 'echo done'

/* ── 假 provider:第一轮调 bash,第二轮收尾 ───────────────────────────── */

function startMockProvider(port, command) {
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
        if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`)
      }
      const frame = (delta, finish = null) => ({
        id: 'chatcmpl-tool-stream',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      const done = () => { res.write('data: [DONE]\n\n'); res.end() }

      if (!flat.includes(TRIGGER)) {
        send(frame({ content: 'ok' }))
        send(frame({}, 'stop'))
        done()
        return
      }

      // 第几轮由**已经回来了几条 tool 消息**决定(与真实 agent-loop 同口径)。
      const toolTurns = messages.filter(m => m.role === 'tool').length
      if (toolTurns === 0) {
        send(frame({ content: '我跑一条命令看看。\n' }))
        await delay(40)
        const args = JSON.stringify({ command })
        send(frame({ tool_calls: [{ index: 0, id: 'call_bash_1', type: 'function', function: { name: 'bash', arguments: '' } }] }))
        await delay(40)
        // 参数分两片来:参数流那一段也要真实(工具卡先走 input-streaming 那一挡)。
        for (const piece of [args.slice(0, 12), args.slice(12)]) {
          send(frame({ tool_calls: [{ index: 0, function: { arguments: piece } }] }))
          await delay(40)
        }
        send(frame({}, 'tool_calls'))
        done()
        return
      }
      send(frame({ content: '\n跑完了。\n' }))
      send(frame({}, 'stop'))
      done()
    })
  })
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)))
}

/* ── 支架(照 gate-stream-structure.mjs / gate-focus.mjs)──────────────── */

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
async function clickSelector(page, selector) {
  const clicked = await page.evaluate(css => {
    const el = document.querySelector(css)
    if (!el) return false
    el.click()
    return true
  }, selector)
  if (!clicked) throw new Error(`点不到:${selector} 不在 DOM 里`)
}

const checks = []
function assert(ok, message, detail) {
  checks.push({ ok: Boolean(ok), message })
  console.log(`  ${ok ? '✓' : '✗'} ${message}${detail ? `  ${detail}` : ''}`)
  return Boolean(ok)
}

/* ── 采样器:逐帧记「工具卡那一行此刻长什么样」 ───────────────────────── */

/**
 * rAF 采样。一帧记:那一行的摘要文字、右端读数、卡高、行的 DOM 身份、状态。
 *
 * **身份靠盖号**:第一次见到一个节点就在它上面写一个号,换了节点就是换了号 ——
 * 「零重挂」这条判据别的量法都看不出来(文本会合法地变,几何也会)。
 */
function installSampler(page) {
  return page.evaluate(() => {
    window.__tool = { frames: [], done: false }
    let seq = 0
    const idOf = el => {
      if (!el.__gateId) el.__gateId = `n${(seq += 1)}`
      return el.__gateId
    }
    const sample = () => {
      const card = document.querySelector('[data-tool-card]')
      if (card) {
        const rows = Array.from(card.querySelectorAll('[data-call-id]')).filter(
          row => !row.hasAttribute('hidden'),
        )
        const row = rows[rows.length - 1]
        if (row) {
          const summary = row.querySelector('[class*="toolSummary"]')
          const right = row.querySelector('[class*="toolRight"]')
          const bar = card.querySelector('[data-tool-progress]')
          window.__tool.frames.push({
            t: Math.round(performance.now()),
            id: idOf(row),
            status: row.getAttribute('data-tool-status') ?? '',
            tone: row.getAttribute('data-tool-tone') ?? '',
            summary: (summary?.textContent ?? '').trim(),
            right: (right?.textContent ?? '').trim(),
            h: Math.round(card.getBoundingClientRect().height * 100) / 100,
            bar: bar ? bar.getAttribute('aria-valuenow') : null,
          })
        }
      }
      if (!window.__tool.done) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)

    // 长帧读数(不做硬断言):相邻两次 rAF 间隔 > 16ms 记一笔。
    window.__frameGaps = []
    let last = performance.now()
    const tick = () => {
      const now = performance.now()
      window.__frameGaps.push(Math.round((now - last) * 100) / 100)
      last = now
      if (!window.__tool.done) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

/** 工具卡那一块此刻的可见文本(收场之后拿它与账本重放比)。 */
function readCardText(page) {
  return page.evaluate(() => {
    const card = document.querySelector('[data-tool-card]')
    if (!card) return null
    return card.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  })
}

/* ── 主流程 ────────────────────────────────────────────────────────────── */

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[tool-stream-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[tool-stream-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  // 反证口:`--no-emit` 换成一条一口气吐完的命令(等价于工具不报进度)。
  const noEmit = process.argv.includes('--no-emit')
  const command = noEmit ? SILENT_COMMAND : COMMAND

  const store = await mkdtemp(path.join(tmpdir(), 'tool-stream-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'tool-stream-userdata-'))
  const mockPort = 19100 + Math.floor(Math.random() * 200)
  let mock
  let server
  let app
  try {
    mock = await startMockProvider(mockPort, command)
    // 钥匙走环境变量 / settings.json(headless core 没有 safeStorage)。
    // 审批档拨到全放行:门要量的是进度上屏,不是权限卡(权限有自己的门)。
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
              'deepseek-chat': { tools: true, reasoning: false, vision: false },
            },
          },
        },
        customProviders: [],
        modelCatalog: {},
      },
      tools: {
        enableToolCalls: true,
        permissionMode: 'dangerously-allow-all',
        bash: { enableSandbox: false, confirmDangerousCommands: false },
      },
    }))

    console.log('[1/4] 起一台 core')
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, ONETHING_STORE_PATH: store, DEEPSEEK_API_KEY: 'sk-tool-stream-gate' },
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
    if (!(await portConnects(record.host, record.port))) throw new Error('core 端口连不上')

    const made = await rpc(record, 'sessions', 'create', { name: '工具进度门' })
    const sessionId = made?.session?.id
    if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(made)}`)
    await rpc(record, 'sessions', 'updateWorkingDirectory', { sessionId, workingDirectory: store })

    console.log('[2/4] 拉起应用(离屏 · 独立 --user-data-dir)')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: '',
        // 离屏起窗:不 show()、不进 Dock,一根手指都不碰用户的前台。
        ONETHING_GATE_HEADLESS: '1',
      },
    })
    const page = await app.firstWindow()
    // 离屏窗自己把「我有焦点」补上(只进这个窗口的 CDP 调用)。
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })

    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await waitFor('Dock 就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid^="dock-tile"]'))),
    )
    await clickSelector(page, '[data-testid="dock-tile-sessions"]')
    await waitFor('总览画出那一行', () =>
      page.evaluate(id => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), sessionId),
    )
    await clickSelector(page, `[data-testid="session-row-${sessionId}"]`)
    await waitFor('聊天区就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="chat-stream"]'))),
    )

    console.log('[3/4] 发一轮,逐帧采样')
    await installSampler(page)
    await rpc(record, 'session-command', 'emit', {
      sessionId,
      command: {
        type: 'command:send-message',
        content: `${TRIGGER} 请开始`,
        suppressTitleGeneration: true,
      },
    })

    // 等这一轮收尾(工具卡上那一行不再是 executing / input-streaming)。
    await waitFor('这一轮收尾', async () => {
      const settled = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('[data-call-id]'))
        if (rows.length === 0) return false
        return rows.every(row => {
          const status = row.getAttribute('data-tool-status')
          return status !== 'executing' && status !== 'input-streaming'
        })
      })
      return settled ? true : undefined
    }, 60_000)
    await delay(500)
    await page.evaluate(() => { window.__tool.done = true })

    const frames = await page.evaluate(() => window.__tool.frames)
    const gaps = await page.evaluate(() => window.__frameGaps ?? [])
    const settledText = await readCardText(page)

    console.log(`\n  采到 ${frames.length} 帧(工具卡在场的那几帧)`)

    /* ── 断言 ──────────────────────────────────────────────────────── */
    console.log('\n[4/4] 断言')

    const executing = frames.filter(f => f.status === 'executing')
    assert(
      executing.length > 0,
      `执行中那一段真的采到了(${executing.length} 帧)`,
    )

    // A. 摘要在动。
    const summaries = [...new Set(executing.map(f => f.summary).filter(Boolean))]
    assert(
      summaries.length >= 5,
      `A 执行中那一行的摘要逐帧在变(${summaries.length} 个不同读数)`,
      summaries.length > 0 ? `例:${summaries.slice(0, 3).join(' · ')} …` : '',
    )

    // B. 耗时在走。
    const rights = [...new Set(executing.map(f => f.right).filter(Boolean))]
    assert(rights.length >= 3, `B 右端耗时在走(${rights.length} 个不同读数)`)

    // C. 同一步内卡高方差 0。
    const heights = [...new Set(executing.map(f => f.h))]
    assert(
      heights.length === 1,
      `C 执行中卡高方差为 0(高度读数:${heights.join(' / ')})`,
    )

    // D. 零重挂。
    const ids = [...new Set(executing.map(f => f.id))]
    assert(ids.length === 1, `D 那一行从头到尾是同一个 DOM 节点(节点号:${ids.join(' / ')})`)

    // E. 收场后与账本重放逐字相同。
    await page.reload()
    await waitFor('重载后渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await clickSelector(page, '[data-testid="dock-tile-sessions"]')
    await waitFor('总览画出那一行', () =>
      page.evaluate(id => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), sessionId),
    )
    await clickSelector(page, `[data-testid="session-row-${sessionId}"]`)
    await waitFor('工具卡重放出来', async () => (await readCardText(page)) || undefined)
    await delay(400)
    const replayText = await readCardText(page)
    assert(
      replayText === settledText,
      'E 收场那一帧与账本重放逐字相同(进度不进账本,重放只见结局)',
      replayText === settledText ? '' : `\n    收场:${settledText}\n    重放:${replayText}`,
    )

    // F. events.jsonl 里零 tool-progress。
    const ledgerPath = path.join(store, 'sessions', sessionId, 'events.jsonl')
    const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf-8') : ''
    const ledgerTypes = ledger
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line).type } catch { return '' } })
    assert(ledger.length > 0 && ledgerTypes.includes('tool/call'), `F0 账本真的记了这次调用(${ledgerTypes.length} 行)`)
    assert(
      !ledger.includes('tool-progress') && !ledger.includes('outputTail'),
      'F events.jsonl 里零 tool-progress / outputTail',
    )

    // 长帧读数(打印,不断言)。
    const long = gaps.filter(g => g > 16).length
    const longest = gaps.length > 0 ? Math.max(...gaps) : 0
    console.log(`\n  [读数] rAF 间隔 > 16ms:${long} / ${gaps.length} 帧;最长 ${longest}ms`)

    await app.close()
    app = undefined
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    if (mock) mock.close()
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }

  const failed = checks.filter(one => !one.ok)
  if (failed.length > 0) {
    console.error(`\n[tool-stream-gate] FAILED —— ${failed.length} / ${checks.length} 条不过`)
    process.exit(1)
  }
  console.log(`\n[tool-stream-gate] ok —— ${checks.length} 条断言全过:执行中那一行在动、卡不抖、行不重挂、账本只见结局`)
}

main().catch(error => {
  console.error('\n[tool-stream-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
