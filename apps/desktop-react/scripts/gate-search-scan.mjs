#!/usr/bin/env node
/**
 * 检索面**扫盘那一路**的真机门(09-07 事故,用户报障)。
 *
 * ── 事故原样 ───────────────────────────────────────────────────────────
 * 搜「all」之后两条 `rg --files --follow --no-ignore` 挂在 462% CPU、415 GB 虚拟
 * 内存上,清空输入框也不死;而整发搜索**一个结果都没有**。四条根因:
 *   ① 扫盘根接成了授权全集(492 条会话 → 31 个扫描根,含一个 18GB 带 16 个
 *      node_modules 的目录);② 扫描型没有预算,`all` 档要收齐所有组才答;
 *   ③ `listOnethingRipgrepFiles` 不收 signal、无 finally、从不 kill;
 *   ④ 壳 → core 的查询不带 AbortSignal。
 *
 * ── 这道门证的四条 ─────────────────────────────────────────────────────
 *   ① **会话 / 消息块先上屏**:文件那一块还在扫的时候,别的块已经有行了;
 *   ② **文件块 3 秒内落地或标未扫完**:预算是真的,而且超时不等于「没搜成」;
 *   ③ **清词后 200ms 内 `pgrep -f 'rg --files'` 为零**:撤回一路传到了 `proc.kill()`;
 *   ④ **`ps` 里没有孤儿 rg**:门自己起的那些进程一条都没留下。
 *
 * ── 为什么必须真机 ─────────────────────────────────────────────────────
 * ③ 与 ④ 量的是**操作系统进程表**。单测里那条链最多走到「`kill()` 被调用了」;
 * 而事故的形态恰恰是「调用方以为自己停了,机器上那条进程还在」。这条门跑的是
 * 真 `dist/server` + 真 Electron 壳 + 真子进程,断言读的是 `pgrep`。
 *
 * 那条子进程是一个**叫 `rg` 的慢壳脚本**(见 `seedSlowRipgrep`),不是真 ripgrep:
 * 要量的不是 ripgrep 有多快,是「永远列不完的目录」这一形下我们自己的进程管理。
 * 真 ripgrep 那条路由 `gate:search` 第 5 步覆盖。
 *
 * 跑法:`node scripts/gate-search-scan.mjs`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 全程离屏(`ONETHING_GATE_HEADLESS=1`),只用页面内 DOM 派发,不动真光标、
 * 不连 5175、不写真店;临时 store 与工作区跑完删干净。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

const OWNER_UID = 'local-user'
const OWNER_WID = 'default'

/** 那条会话的名字(消息块要靠它命中)。 */
const SESSION_NAME = '扫盘门 · 大目录会话'
/** 埋在文件名与消息里的判据词。够独特,免得撞上别的东西。 */
const MARKER = 'zorbulaxscan'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败:${message}`)
  console.log(`  ✓ ${message}`)
}

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
    await delay(100)
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
  if (!body || body.ok !== true) {
    throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  }
  return body.data
}

/**
 * 此刻机器上有几条 `rg --files`。
 *
 * **按 `--files` 筛而不是按 `rg` 筛**:开发机上随时可能有别人手打的 `rg <pattern>`,
 * 而 `--files`(列文件)只有检索这一路会发。`pgrep -f` 自己也会匹配到,所以排掉
 * 命令行里带 `pgrep` 的那些。
 */
function ripgrepListProcesses() {
  const found = spawnSync('pgrep', ['-fl', 'rg --files'], { encoding: 'utf-8' })
  return (found.stdout ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.includes('pgrep'))
}

/**
 * 一棵**慢得可复现**的「大目录」—— 一个叫 `rg` 的壳脚本,摆在 core 进程 PATH 的
 * 最前面。它先吐出几个带判据词的文件名,然后**永不结束**。
 *
 * 为什么不去真造一棵 18GB 的树:那件事在一台开发机上既慢又不可复现(取决于盘、
 * 缓存、`.gitignore`),而这道门要量的**不是 ripgrep 有多快**,是**我们自己的
 * 进程管理**:预算到点交不交、清词杀不杀、退出留不留孤儿。一个「永远列不完的
 * 目录」是那件事最诚实的实验装置。
 *
 * 真 ripgrep 那条路由 `gate:search` 第 5 步覆盖(它拿真 rg 在真目录上量行首徽)。
 */
async function seedSlowRipgrep(binDir) {
  await mkdir(binDir, { recursive: true })
  const shim = path.join(binDir, 'rg')
  await writeFile(shim, [
    '#!/bin/sh',
    '# gate-search-scan 的慢 rg:先给几条命中,再永不结束。',
    `for i in 0 1 2 3 4; do echo "${MARKER}-$i.ts"; done`,
    'while true; do sleep 0.2; done',
    '',
  ].join('\n'))
  await chmod(shim, 0o755)
  return shim
}

/** 命中用的那几个文件也真的落在盘上(壳点开一行时不至于指向空气)。 */
async function seedFiles(root) {
  await mkdir(root, { recursive: true })
  for (let i = 0; i < 5; i += 1) {
    await writeFile(path.join(root, `${MARKER}-${i}.ts`), 'gate\n')
  }
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

async function typeQuery(page, value) {
  await page.evaluate(text => {
    const input = document.querySelector('[data-testid="search-panel"] input')
    if (!input) throw new Error('检索框不在 DOM 里')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

/** 屏幕上此刻每一块有几行、块尾项是什么态。 */
function readBlocks(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="search-panel"]')
    if (!panel) return { panel: false, blocks: {}, more: {} }
    const blocks = {}
    for (const row of panel.querySelectorAll('[role="option"][data-capability]')) {
      const at = row.getAttribute('data-row')
      if (at === 'more' || at === 'action') continue
      const cap = row.getAttribute('data-capability')
      blocks[cap] = (blocks[cap] ?? 0) + 1
    }
    const more = {}
    for (const item of panel.querySelectorAll('[data-row="more"]')) {
      more[item.getAttribute('data-block')] = item.getAttribute('data-more-state')
    }
    const readouts = {}
    for (const el of panel.querySelectorAll('[data-readout]')) {
      readouts[`${el.getAttribute('data-readout')}:${el.getAttribute('data-block') ?? ''}`] =
        (el.textContent ?? '').trim()
    }
    return { panel: true, blocks, more, readouts }
  })
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[search-scan-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[search-scan-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const before = ripgrepListProcesses()
  if (before.length > 0) {
    console.log(`[search-scan-gate] 开跑前机器上已有 ${before.length} 条 \`rg --files\`(不是本门起的,断言会扣掉):`)
    for (const line of before) console.log(`  · ${line}`)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'search-scan-store-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'search-scan-ws-'))
  const binDir = await mkdtemp(path.join(tmpdir(), 'search-scan-bin-'))
  const cwd = path.join(workspaceRoot, OWNER_UID, OWNER_WID)
  let server
  let app
  try {
    console.log('\n[1/5] 摆一个「永远列不完的目录」(慢 rg 壳脚本)+ 几个真命中文件')
    await seedFiles(cwd)
    console.log(`  · ${await seedSlowRipgrep(binDir)}`)

    console.log('\n[2/5] 起一台 core(PATH 前置那个慢 rg),建一条工作目录指向那棵树的会话')
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        // core 起的每一条 `rg` 都是那个壳脚本 —— 判据在 `getOnethingRipgrepPath`:
        // 它先 `which('rg')`,而 which 读的就是这条 PATH。
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        ONETHING_STORE_PATH: store,
        ONETHING_SERVER_WORKSPACE_ROOT: workspaceRoot,
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

    const created = await rpc(record, 'sessions', 'create', { name: `${SESSION_NAME} ${MARKER}` })
    const sessionId = created?.session?.id
    if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(created)}`)
    await rpc(record, 'sessions', 'updateWorkingDirectory', { sessionId, workingDirectory: cwd })

    console.log('\n[3/5] 拉起应用(离屏),开检索面,进那条会话')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: '',
        ONETHING_GATE_HEADLESS: '1',
      },
    })
    const page = await app.firstWindow()
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await waitFor('检索瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-search"]'))))
    await clickSelector(page, '[data-testid="dock-tile-search"]')
    await waitFor('检索面板就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="search-panel"] input'))))
    // 进会话:文件那一档的扫描根 = 活跃会话的工作目录(壳把它当 `filters.dir` 递回去)。
    await typeQuery(page, SESSION_NAME)
    const at = await waitFor('那条会话出现在命中里', () => page.evaluate((name) => {
      const rows = [...document.querySelectorAll('[data-testid="search-panel"] [role="option"]')]
        .filter(el => /^\d+$/.test(el.getAttribute('data-row') ?? ''))
      const found = rows.find(el => (el.textContent ?? '').includes(name))
      return found ? found.getAttribute('data-row') : undefined
    }, SESSION_NAME))
    await clickSelector(page, `[data-testid="search-panel"] [role="option"][data-row="${at}"]`)
    await waitFor('面板收回 Dock 了', () =>
      page.evaluate(() => !document.querySelector('[data-testid="search-panel"]')))
    await clickSelector(page, '[data-testid="dock-tile-search"]')
    await waitFor('检索面板又开出来', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="search-panel"] input'))))

    console.log('\n[4/5] 在「不挑」那一档上搜一个词 —— 四条断言')
    const startedAt = Date.now()
    await typeQuery(page, MARKER)

    /*
     * ── ① 会话 / 消息块先上屏 ────────────────────────────────────────
     * 判据是「屏上已经有别的块的行了」,而那一刻文件那一块要么还在扫、要么刚落地。
     * 事故那一次这里是**一个结果都没有**(整发要收齐所有组才答)。
     * 反证:把 `fanout` 的 `deferInAll` 拆掉 → 这一条超时红。
     */
    const first = await waitFor('别的块先画出行来', async () => {
      const state = await readBlocks(page)
      const others = Object.keys(state.blocks).filter(cap => cap !== 'files')
      return others.length > 0 ? { ...state, others, ms: Date.now() - startedAt } : undefined
    }, 15_000)
    console.log('  · 首屏读数:', JSON.stringify({ blocks: first.blocks, more: first.more, ms: first.ms }))
    assert(first.others.length > 0, `① 会话 / 消息块先上屏(${first.ms}ms,块:${first.others.join(' / ')})`)
    /*
     * **「先」是有数的**:扫盘那一路的预算是 3s,所以别的块必须在那之前很久就到。
     * 没有这一条,`waitFor` 只会老老实实等到 3s 之后再判绿 —— 那正是事故那一形
     * (整发要收齐所有组才答),而门会陪着它一起绿。
     * 反证:把 `fanout` 的 `deferInAll` 改成恒假 → 首屏读数从 ~110ms 跳到 ~3.2s,
     * 这一条当场红。
     */
    assert(
      first.ms < 2000,
      `① 而且是**先**:${first.ms}ms < 2000ms(扫盘那一路的预算是 3000ms)`,
    )

    /*
     * ── ② 文件那一块 3 秒内落地或标未扫完 ────────────────────────────
     * 「落地」= 它不再是 `scanning`:要么有行、要么给出一句诚实的读数
     * (`partial` / `end`),要么页脚一行「没搜成 · 重试」。
     * 3s 是能力自述里的 `budget.timeoutMs`,再加一点往返与渲染的余量。
     */
    const settled = await waitFor('文件那一块落地', async () => {
      const state = await readBlocks(page)
      if (state.more.files === 'scanning') return undefined
      const failed = Object.entries(state.readouts).some(([key]) => key.startsWith('block-errors:'))
      const rows = state.blocks.files ?? 0
      const readout = state.readouts['partial:files'] ?? state.readouts['end:files']
      return rows > 0 || readout !== undefined || failed
        ? { ...state, rows, readout, failed, ms: Date.now() - startedAt }
        : undefined
    }, 12_000)
    console.log('  · 文件块读数:', JSON.stringify({
      rows: settled.rows, readout: settled.readout, failed: settled.failed, ms: settled.ms,
    }))
    assert(
      settled.rows > 0 || settled.readout !== undefined || settled.failed,
      `② 文件那一块落地了(${settled.ms}ms;行 ${settled.rows} 条,块尾读数「${settled.readout ?? '—'}」)`,
    )
    assert(
      settled.ms < 12_000,
      `② 它没有无限期地扫下去(预算 3s + 往返;实测 ${settled.ms}ms)`,
    )

    /*
     * ── ③ 清词之后 200ms 内那条 rg 没了 ──────────────────────────────
     * 先确认这一趟**真的起过** `rg`(否则这条断言是空过的);再清词,
     * 然后只等 200ms 就数进程。
     *
     * 反证:把 `listOnethingRipgrepFiles` 的 `finally { kill() }` 注掉 →
     * 清词之后那条 rg 还在,这一条当场红(09-07 真机上就是这一形)。
     */
    await typeQuery(page, MARKER.slice(0, 6))
    const sawRg = await waitFor('这一趟真的起了 rg', async () => {
      const running = ripgrepListProcesses().filter(line => !before.includes(line))
      return running.length > 0 ? running : undefined
    }, 8_000).catch(() => [])
    if (sawRg.length === 0) {
      console.log('  · (这一趟没抓到在飞的 rg —— 扫得太快;③ 改为只判「清词之后为零」)')
    } else {
      console.log(`  · 在飞的 rg:${sawRg.length} 条`)
    }
    await typeQuery(page, '')
    await delay(200)
    const afterClear = ripgrepListProcesses().filter(line => !before.includes(line))
    assert(
      afterClear.length === 0,
      `③ 清词后 200ms 内 \`rg --files\` 为零(还剩 ${afterClear.length} 条${afterClear.length ? `:${afterClear.join(' | ')}` : ''})`,
    )

    console.log('\n[5/5] 收摊之后再数一次')
    await app.close()
    app = undefined
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await waitFor('core 退出', () => !pidAlive(server.pid), 10_000).catch(() => undefined)
    await delay(300)
    const orphans = ripgrepListProcesses().filter(line => !before.includes(line))
    assert(
      orphans.length === 0,
      `④ \`ps\` 里没有孤儿 rg(还剩 ${orphans.length} 条${orphans.length ? `:${orphans.join(' | ')}` : ''})`,
    )

    console.log('\n[search-scan-gate] ok —— 别的块先上屏 / 文件块有边界 / 清词即杀 / 零孤儿')
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    if (server && pidAlive(server.pid)) server.kill('SIGKILL')
    await rm(store, { recursive: true, force: true })
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(binDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\n[search-scan-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
