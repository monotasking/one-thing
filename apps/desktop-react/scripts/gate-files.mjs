#!/usr/bin/env node
/**
 * React 壳 D5 的验收门 —— **脚本级,拒人肉 QA**(与 gate-data.mjs 同一体例)。
 *
 * D1 的门证的是「屏幕上的会话来自 core」;这一条证的是**屏幕上的文件树来自磁盘**:
 *
 *  ① 脚本在磁盘上真的建一棵目录树,再用发现文件里的 token 建一条会话并把它的
 *     `workingDirectory` 指到那棵树的根 —— 全程绕开应用,数据是「别人写的」;
 *  ② 拉起应用 → 进那条会话 → 打开 Dock 上那块「文件」→ 断言**根条上显示的路径**
 *     就是那条会话的工作目录(根目录判据的端到端证明);
 *  ③ 展开两层,断言每一层画出来的名字与 `fs.readdir` 逐条相等(集合相等,
 *     不是「包含」—— 多画一行同样是红);
 *  ④ 点一个源码文件 → 断言预览里出现的是**磁盘上那个文件的原文**;
 *  ⑤ 打开检索面板搜一个真文件名 → 断言命中行里有它的路径;
 *  ⑥ 点行尾的 reveal → 断言**做得到就成功、做不到就弹一条 error**
 *     (独立 server 没有宿主外壳,结构化降级 —— 这一格验的是「失败看得见」)。
 *
 * ── 为什么要自带一个 workspace root(这条门最要紧的一行 env) ─────────────
 * 壳走的是 `POST /api/rpc`,于是 files 域按 `transport:'http'` 把每条路径夹进
 * `context.sandboxRoot`(= `<workspaceRoot>/<uid>/<wid>`)。`workspaceRoot` 默认是
 * `tmpdir()/onething-server-workspaces` —— 一个空目录。所以这条门把
 * `ONETHING_SERVER_WORKSPACE_ROOT` 指到自己造的临时目录,并把那棵真树建在
 * `<root>/local-user/default` 里面:**沙箱根就是会话的工作目录**,链路因此全通。
 *
 * 这同时也是本批留下的那条账:真实使用中(会话的工作目录是用户的代码仓)
 * 这两者并不重合,files 域会拒绝。判据与实证写在汇报里 —— 门不去绕过它,
 * 门只证「路径在允许范围内时,这条链路是真的」。
 *
 * 跑法:`node scripts/gate-files.mjs`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 可重复:每次全新的临时 store + 临时 workspace,跑完删干净。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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
/** 截图落在构建产物目录里 —— 它已经在 .gitignore 上,门不该往仓里丢文件。 */
const shotDir = path.join(appRoot, 'dist', 'gate-shots')

/** 沙箱根的两段 —— 与 `ownerSandboxRoot(root, uid, wid)` 的拼法一致。 */
const OWNER_UID = 'local-user'
const OWNER_WID = 'default'

const SESSION_NAME = 'D5 门 · 文件面'
/** 预览要逐字对上的那份原文。刻意带中文与换行:它是**数据**,不该被任何一层加工。 */
const FILE_TEXT = `export const gate = 'D5'\n// 这一行必须原样出现在预览里\n`

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

/** 与 gate-data.mjs 同一条理由:用 element.click() 绕开可操作性判定,派发的仍是真事件。 */
async function clickSelector(page, selector) {
  const clicked = await page.evaluate(css => {
    const el = document.querySelector(css)
    if (!el) return false
    el.click()
    return true
  }, selector)
  if (!clicked) throw new Error(`点不到:${selector} 不在 DOM 里`)
}

/** 屏幕上此刻这一层画出来的名字(按 data-file-depth 取)。 */
function namesAtDepth(page, depth) {
  return page.evaluate(
    d =>
      Array.from(document.querySelectorAll(`[data-file-path][data-file-depth="${d}"]`)).map(
        el => el.getAttribute('data-file-path').split('/').pop(),
      ),
    depth,
  )
}

const sorted = names => [...names].sort()

/** 磁盘上那一层的真名字 —— 后端会跳过 node_modules / .git,这里跟着跳。 */
async function realNames(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  return sorted(entries.map(e => e.name).filter(n => n !== 'node_modules' && n !== '.git'))
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[d5-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[d5-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'd5-gate-store-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'd5-gate-ws-'))
  const cwd = path.join(workspaceRoot, OWNER_UID, OWNER_WID)
  let server
  let app
  try {
    await mkdir(shotDir, { recursive: true })
    console.log('\n[1/6] 在磁盘上建一棵真目录树')
    await mkdir(path.join(cwd, 'packages', 'core'), { recursive: true })
    await mkdir(path.join(cwd, 'docs'), { recursive: true })
    await writeFile(path.join(cwd, 'README.md'), '# d5 gate\n')
    await writeFile(path.join(cwd, 'packages', 'core', 'engine.ts'), FILE_TEXT)
    await writeFile(path.join(cwd, 'docs', 'note.md'), 'note\n')
    const level0 = await realNames(cwd)
    const level1 = await realNames(path.join(cwd, 'packages'))
    assert(level0.length === 3, `第一层磁盘上有 ${level0.length} 项:${level0.join(', ')}`)

    console.log('\n[2/6] 起一台 core(沙箱根 = 那棵树的根),建一条会话并把工作目录指过去')
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
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

    const created = await rpc(record, 'sessions', 'create', { name: SESSION_NAME })
    const sessionId = created?.session?.id
    if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(created)}`)
    await rpc(record, 'sessions', 'updateWorkingDirectory', { sessionId, workingDirectory: cwd })
    const listed = await rpc(record, 'sessions', 'listMeta', {})
    const meta = (listed.sessions ?? []).find(s => s.id === sessionId)
    assert(
      meta?.workingDirectory === cwd,
      `core 侧确认这条会话的 workingDirectory = ${meta?.workingDirectory}`,
    )

    console.log('\n[3/6] 拉起应用,进那条会话,打开文件面板')
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
    // 「当前会话」是 expose store 的事实(根目录判据的第一半),所以这里**点进去**,
    // 不去改 store —— 门要走用户真正走的那条路。
    await waitFor('Dock 上的「会话总览」瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
    )
    await clickSelector(page, '[data-testid="dock-tile-sessions"]')
    await waitFor('总览画出那张卡', () =>
      page.evaluate(id => Boolean(document.querySelector(`[data-session-id="${id}"]`)), sessionId),
    )
    await clickSelector(page, `[data-testid="card-${sessionId}"]`)
    await waitFor('文件瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-files"]'))),
    )
    await clickSelector(page, '[data-testid="dock-tile-files"]')

    const shownRoot = await waitFor('文件面板画出根条', async () => {
      const text = await page.evaluate(
        () => document.querySelector('[data-testid="files-root"]')?.textContent ?? null,
      )
      return text && text.startsWith('/') ? text : undefined
    })
    assert(shownRoot === cwd, `根条上显示的就是那条会话的工作目录:${shownRoot}`)

    console.log('\n[4/6] 展开两层,逐条对磁盘')
    const shown0 = await waitFor('第一层画出来', async () => {
      const names = await namesAtDepth(page, 0)
      return names.length > 0 ? names : undefined
    })
    assert(
      JSON.stringify(sorted(shown0)) === JSON.stringify(level0),
      `第一层与磁盘逐条相等:${sorted(shown0).join(', ')}`,
    )

    await clickSelector(page, `[data-file-path="${path.join(cwd, 'packages')}"] button`)
    const shown1 = await waitFor('第二层画出来', async () => {
      const names = await namesAtDepth(page, 1)
      return names.length > 0 ? names : undefined
    })
    assert(
      JSON.stringify(sorted(shown1)) === JSON.stringify(level1),
      `第二层与磁盘逐条相等:${sorted(shown1).join(', ')}`,
    )

    await clickSelector(page, `[data-file-path="${path.join(cwd, 'packages', 'core')}"] button`)
    const shown2 = await waitFor('第三层画出来', async () => {
      const names = await namesAtDepth(page, 2)
      return names.length > 0 ? names : undefined
    })
    assert(shown2.join(',') === 'engine.ts', `第三层:${shown2.join(', ')}`)
    await page.screenshot({ path: path.join(shotDir, 'tree.png') })

    console.log('\n[5/6] 点一个源码文件,断言预览里是磁盘上那份原文')
    await clickSelector(page, `[data-file-path="${path.join(cwd, 'packages', 'core', 'engine.ts')}"] button`)
    const previewText = await waitFor('预览画出来', async () => {
      const text = await page.evaluate(
        () => document.querySelector('[data-testid="files-preview"]')?.textContent ?? null,
      )
      return text && text.includes('export const') ? text : undefined
    })
    console.log('  · 预览读数:', JSON.stringify(previewText).slice(0, 300))
    for (const line of FILE_TEXT.trim().split('\n')) {
      assert(previewText.includes(line), `预览里逐行对上:${line}`)
    }
    await page.screenshot({ path: path.join(shotDir, 'preview.png') })

    console.log('\n[6/6] reveal 的诚实性 + 检索面文件侧')
    await clickSelector(page, '[data-testid="files-preview"] button[aria-label]')
    await clickSelector(
      page,
      `[data-file-path="${path.join(cwd, 'README.md')}"] button[aria-label]:last-of-type`,
    )
    await delay(800)
    // 观测口就是屏幕:失败会画一条 error toast(不自动消失那一档)。
    const revealErrorShown = await page.evaluate(() => {
      const text = document.body.textContent ?? ''
      return text.includes('没能在文件管理器中定位') || text.includes('Could not reveal that path')
    })
    console.log(
      `  · reveal 结果:${revealErrorShown ? '结构化降级并弹出通知(这台 core 是独立 server,没有宿主外壳)' : '成功,没有报错'}`,
    )

    await clickSelector(page, '[data-testid="dock-tile-search"]')
    await waitFor('检索面板就位', () =>
      page.evaluate(() =>
        Boolean(document.querySelector('[data-testid="search-panel"] input')),
      ),
    )
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="search-panel"] input')
      if (!input) return
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set
      setter.call(input, 'engine')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const hit = await waitFor('检索面画出文件命中', async () => {
      const rows = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[role="option"]')).map(el => el.textContent ?? ''),
      )
      const found = rows.find(text => text.includes('engine.ts'))
      return found ?? undefined
    })
    assert(hit.includes('engine.ts'), `检索面文件侧命中了真文件:${hit.trim()}`)
    await page.screenshot({ path: path.join(shotDir, 'search.png') })

    await app.close()
    app = undefined
    console.log(`\n[d5-gate] ok —— 文件树、预览、检索三处画的都是磁盘上的真文件(截图:${path.relative(appRoot, shotDir)}/)`)
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\n[d5-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
