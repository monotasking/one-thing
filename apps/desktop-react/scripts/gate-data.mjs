#!/usr/bin/env node
/**
 * React 壳 D1 的验收门 —— **脚本级,拒人肉 QA**(方案 §4 P1 那一行门)。
 *
 * D0 的门(gate-connect.mjs)证的是「连得上」:一次真 RPC 往返 + 一条 SSE 到达。
 * D1 要证的是**屏幕上画的就是 core 里的那批会话**,所以这一条门只问三件事:
 *
 *  ① 脚本用发现文件里的 token 直接造两条会话(`sessions.create`),再往其中一条
 *     里塞一条用户消息(`sessions.addSystemMessage`)—— 全程绕开应用,数据是
 *     「别人写进 store 的」而不是应用自己造的;
 *  ② 拉起应用 → 打开 Dock 上那块「会话总览」→ 断言**渲染出来的会话集合**
 *     (id 与标题)与直接 HTTP `sessions.listMeta` 返回的**逐条相等**
 *     (集合相等,不是「包含」—— 多画一条假卡同样是红);
 *  ③ 对其中一条开 Quick Look → 断言首页消息的**正文出现在 DOM 里**。
 *
 * 跑法:`node scripts/gate-data.mjs`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 可重复:每次一个全新的临时 store,跑完删干净。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
// Electron 本体不在这个应用里重装一份 —— 理由见 gate-connect.mjs 顶部那段。
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

/** 两条会话的名字。刻意一中一英:标题是**数据**,不该被 i18n 碰。 */
const SESSION_NAMES = ['D1 门 · 甲会话', 'd1-gate-beta']
/** 塞进甲会话的那条用户消息的正文 —— ③ 就是在 DOM 里找这一句。 */
const MESSAGE_TEXT = 'D1 门:这一句必须出现在 Quick Look 里'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

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

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await delay(150)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败:${message}`)
  console.log(`  ✓ ${message}`)
}

/** 用发现文件里的 token 打一条真 RPC —— 这是脚本侧「别人写进 store」的那只手。 */
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
  // rpc 信封(@shared/ipc/rpc.ts):{ ok:true, data } | { ok:false, error }。
  if (!body || body.ok !== true) {
    throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  }
  return body.data
}

/**
 * 点一个 testid。**用 element.click() 而不是 playwright 的 page.click** ——
 * 后者要先过一遍「可见 / 稳定 / 没被别的东西挡住」的可操作性判定,而这块壳上
 * Dock 有磁性放大动画、卡上的预览眼睛平时 opacity 为 0(占位常驻、hover 才显形),
 * 于是那套判定会一直重试到超时。这条门要证的是**数据**,不是命中测试;
 * element.click() 派发的仍是一次真事件、走的仍是 React 那个 onClick。
 */
async function clickTestId(page, testId) {
  const clicked = await page.evaluate(id => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    el.click()
    return true
  }, testId)
  if (!clicked) throw new Error(`点不到:[data-testid="${testId}"] 不在 DOM 里`)
}

const sortByTitle = rows => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[d1-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[d1-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'd1-gate-'))
  let server
  let app
  try {
    console.log('\n[1/4] 起一台 core,并用 token 直接往 store 里写两条会话')
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, ONETHING_STORE_PATH: store },
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

    const created = []
    for (const name of SESSION_NAMES) {
      const result = await rpc(record, 'sessions', 'create', { name })
      const id = result?.session?.id
      if (!id) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(result)}`)
      created.push({ id, name })
    }
    assert(created.length === 2, `建了两条会话:${created.map(s => s.id).join(', ')}`)

    const target = created[0]
    await rpc(record, 'sessions', 'addSystemMessage', {
      sessionId: target.id,
      message: {
        id: `d1-gate-${Date.now()}`,
        role: 'user',
        content: MESSAGE_TEXT,
        timestamp: Date.now(),
      },
    })
    const page1 = await rpc(record, 'sessions', 'getMessagesPage', {
      sessionId: target.id,
      limit: 20,
      anchor: 'tail',
    })
    assert(
      (page1.messages ?? []).some(m => m.content === MESSAGE_TEXT),
      'HTTP 侧确认那条消息真的落库了',
    )

    // 这一份是「事实」,应用画出来的必须与它逐条相等。
    const listed = await rpc(record, 'sessions', 'listMeta', {})
    const expected = sortByTitle((listed.sessions ?? []).map(s => ({ id: s.id, title: s.name })))
    assert(expected.length === 2, `listMeta 说 store 里有 ${expected.length} 条会话`)

    console.log('\n[2/4] 拉起应用,等它连上同一台 core')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '' },
    })
    const page = await app.firstWindow()
    const probe = await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    assert(probe.rpcOk === true, `连上了同一台 core(baseUrl=${probe.baseUrl})`)

    console.log('\n[3/4] 打开会话总览,断言渲染出的会话集合 = listMeta')
    // 按 data-testid 点,不按 aria-label —— 后者是翻译过的文案,会跟着系统语言变。
    await waitFor('Dock 上的「会话总览」瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
    )
    await clickTestId(page, 'dock-tile-sessions')
    const rendered = await waitFor('总览画出会话卡', async () => {
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-session-id]')).map(el => ({
          id: el.getAttribute('data-session-id'),
          title: el.querySelector('span')?.textContent ?? '',
        })),
      )
      return rows.length > 0 ? rows : undefined
    })
    const actual = sortByTitle(rendered)
    assert(
      JSON.stringify(actual) === JSON.stringify(expected),
      `渲染出的会话集合与 listMeta 逐条相等:${JSON.stringify(actual)}`,
    )

    console.log('\n[4/4] 进一条会话的 Quick Look,断言首页消息的正文出现')
    await clickTestId(page, `card-preview-${target.id}`)
    const shown = await waitFor('Quick Look 画出首页消息', async () => {
      const text = await page.evaluate(() => {
        const body = document.querySelector('[data-testid="quicklook-body"]')
        return body ? body.textContent : null
      })
      return text && text.includes('D1 门:这一句') ? text : undefined
    })
    assert(shown.includes(MESSAGE_TEXT), 'Quick Look 里出现了那条真消息的正文')

    await app.close()
    app = undefined
    console.log('\n[d1-gate] ok —— 会话集合与消息正文都来自 core')
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\n[d1-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
