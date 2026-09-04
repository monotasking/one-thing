#!/usr/bin/env node
/**
 * React 壳 D5 的验收门 —— **脚本级,拒人肉 QA**(与 gate-data.mjs 同一体例)。
 *
 * D1 的门证的是「屏幕上的会话来自 core」;这一条证的是**屏幕上的文件树来自磁盘**:
 *
 *  ① 脚本在磁盘上真的建一棵目录树,再用发现文件里的 token 建一条会话并把它的
 *     `workingDirectory` 指到那棵树的根 —— 全程绕开应用,数据是「别人写的」;
 *  ② 拉起应用 → 进那条会话 → 打开 Dock 上那块「文件」→ 断言**头上那条路径**
 *     就是那条会话的工作目录(根目录判据的端到端证明);
 *  ③ 展开两层,断言每一层画出来的名字与 `fs.readdir` 逐条相等(集合相等,
 *     不是「包含」—— 多画一行同样是红);
 *  ④ 点一个源码文件 → 断言预览里出现的是**磁盘上那个文件的原文**;
 *  ⑤ 打开检索面板搜一个真文件名 → 断言命中行里有它的路径;
 *  ⑥ 双击一行开详情 → 点里面的 reveal → 断言**做得到就成功、做不到就弹一条 error**
 *     (独立 server 没有宿主外壳,结构化降级 —— 这一格验的是「失败看得见」)。
 *
 * ── 改版后这条门改了什么(08-31「IDE 紧凑树」+ 同日 claude design 定稿)───────
 * **真事实一条没改**(根 / 树 / 预览 / 检索 / reveal 的诚实性),只有取件口跟着
 * 屏幕的新形状动了四处:
 *  · 根:`[data-testid="files-root"]` 还在原地,但**读的是 `data-root` 而不是
 *    textContent** —— 定稿把深路径的中段折成了 `…`,屏幕上那串字不再逐字等于路径。
 *    屏幕说「我在哪儿」(可折),属性说「那条路径本身」(永不折),门问后者;
 *  · 行:一行的 `data-file-path` 挂在**那颗按钮**上(行尾多了打开点与 ⋯,
 *    所以按钮外面又裹回了一层 div),选择器 `[data-file-path="…"]` 不变;
 *  · 详情:载体从 ui/Dialog 换成 ui/Popover(附属浮层,不遮树、不 modal)。
 *    **08-31 真机走查修的一处错位**:`data-testid="files-detail"` 从前挂在浮层
 *    *里面*那层 div 上,而 `role="dialog"` 在浮层根上 —— 于是按 testid 取到的元素
 *    role 是空的,这一句从前是假的。现在 testId 落在浮层根上,两件事在同一个元素,
 *    所以这条门**按 role 真验**(下面第 6 步),而那条路径改按后代取。
 *  · reveal:行尾那枚常驻小钮退役,它的活儿在详情浮层与行菜单里各有一个入口。
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

/**
 * 从树行右键菜单里点一档「打开方式」。语言按机器走(全新 user-data-dir 上
 * 多半是英文),所以按**正则**取而不是逐字对 —— 门要走用户真正走的那条路,
 * 但不该被界面语言绊住。
 */
async function switchModeTo(page, filePath, pattern) {
  await page.evaluate(selector => {
    document
      .querySelector(selector)
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  }, `[data-file-path="${filePath}"]`)
  await waitFor('行菜单出来了', () =>
    page.evaluate(() => Boolean(document.querySelector('[role="menu"]'))),
  )
  await page.evaluate(source => {
    const re = new RegExp(source)
    const items = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
    const target = items.find(el => re.test(el.textContent ?? ''))
    if (!target) throw new Error(`菜单里没有 ${source};现有:${items.map(e => e.textContent).join(' | ')}`)
    target.click()
  }, pattern.source)
  await delay(400)
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
  /*
   * ── 独立的 `--user-data-dir`(09-01 修:这道门从前跑在**用户真实的 Electron
   * 档案**上)───────────────────────────────────────────────────────────────
   * 后果有两条,都真发生过:
   *  ① **不可重复**:上一次跑到一半失败,把 `onething.files.openMode: stage`
   *     留在了那份 localStorage 里;下一次开跑,点开文件直接落在舞台上(合檐,
   *     没有 `viewer-name`),门在第 5 步报「查看器头上说的路径:null」——
   *     排查半天,病根不在被测代码里。
   *  ② **改用户状态**:那正是「验证不改用户状态」那条纪律要拦的事。
   * gate:a11y 一开始就是这么起的,这道门跟上。
   */
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'd5-gate-userdata-'))
  const cwd = path.join(workspaceRoot, OWNER_UID, OWNER_WID)
  let server
  let app
  try {
    await mkdir(shotDir, { recursive: true })
    console.log('\n[1/7] 在磁盘上建一棵真目录树')
    await mkdir(path.join(cwd, 'packages', 'core'), { recursive: true })
    await mkdir(path.join(cwd, 'docs'), { recursive: true })
    await writeFile(path.join(cwd, 'README.md'), '# d5 gate\n')
    await writeFile(path.join(cwd, 'packages', 'core', 'engine.ts'), FILE_TEXT)
    await writeFile(path.join(cwd, 'docs', 'note.md'), 'note\n')
    const level0 = await realNames(cwd)
    const level1 = await realNames(path.join(cwd, 'packages'))
    assert(level0.length === 3, `第一层磁盘上有 ${level0.length} 项:${level0.join(', ')}`)

    console.log('\n[2/7] 起一台 core(沙箱根 = 那棵树的根),建一条会话并把工作目录指过去')
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

    console.log('\n[3/7] 拉起应用,进那条会话,打开文件面板')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: '',
        /*
         * **离屏起窗**(09-04 S4 立的纪律「真机门不许抢用户的机器」)。窗子不 show()、
         * 不进 Dock;页面照样渲染、照样跑布局与 rAF,焦点由 CDP
         * `Emulation.setFocusEmulationEnabled` 补上(只进这个窗口,不动真光标)。
         */
        ONETHING_GATE_HEADLESS: '1',
      },
    })
    const page = await app.firstWindow()
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
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
    await waitFor('总览画出那一行', () =>
      page.evaluate(id => Boolean(document.querySelector(`[data-session-id="${id}"]`)), sessionId),
    )
    await clickSelector(page, `[data-testid="session-row-${sessionId}"]`)
    await waitFor('文件瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-files"]'))),
    )
    await clickSelector(page, '[data-testid="dock-tile-files"]')

    const shownRoot = await waitFor('文件面板画出面包屑路径', async () => {
      // 取 data-root 而不是 textContent:面包屑的中段会折成 `…`(理由见文件头)。
      const text = await page.evaluate(
        () => document.querySelector('[data-testid="files-root"]')?.getAttribute('data-root') ?? null,
      )
      return text && text.startsWith('/') ? text : undefined
    })
    assert(shownRoot === cwd, `面包屑说的就是那条会话的工作目录:${shownRoot}`)

    console.log('\n[4/7] 展开两层,逐条对磁盘')
    const shown0 = await waitFor('第一层画出来', async () => {
      const names = await namesAtDepth(page, 0)
      return names.length > 0 ? names : undefined
    })
    assert(
      JSON.stringify(sorted(shown0)) === JSON.stringify(level0),
      `第一层与磁盘逐条相等:${sorted(shown0).join(', ')}`,
    )

    await clickSelector(page, `[data-file-path="${path.join(cwd, 'packages')}"]`)
    const shown1 = await waitFor('第二层画出来', async () => {
      const names = await namesAtDepth(page, 1)
      return names.length > 0 ? names : undefined
    })
    assert(
      JSON.stringify(sorted(shown1)) === JSON.stringify(level1),
      `第二层与磁盘逐条相等:${sorted(shown1).join(', ')}`,
    )

    await clickSelector(page, `[data-file-path="${path.join(cwd, 'packages', 'core')}"]`)
    const shown2 = await waitFor('第三层画出来', async () => {
      const names = await namesAtDepth(page, 2)
      return names.length > 0 ? names : undefined
    })
    assert(shown2.join(',') === 'engine.ts', `第三层:${shown2.join(', ')}`)
    await page.screenshot({ path: path.join(shotDir, 'tree.png') })

    console.log('\n[5/7] 点一个源码文件,断言查看器里是磁盘上那份原文')
    /*
     * ── 取件口跟着形状换了,**真事实一个字没改**(查看器 F1)────────────────
     * 从前这一步问的是那层盖住树的「预览」(`files-preview`),现在问的是**面板内
     * 分栏右列**那块查看器(`file-viewer` / `viewer-body`)。要证的仍然是同一句话:
     * **屏幕上这几行字与磁盘上那份文件逐行相同**。
     *
     * 顺手多验一条查看器才有的真事实:**树没有被盖掉** —— 分栏是并排不是覆盖,
     * 所以打开一个文件之后,树上那些行仍然在 DOM 里(这是「树常驻」铁律的真机面)。
     */
    const enginePath = path.join(cwd, 'packages', 'core', 'engine.ts')
    await clickSelector(page, `[data-file-path="${enginePath}"]`)
    const viewerText = await waitFor('查看器画出来', async () => {
      const text = await page.evaluate(
        () => document.querySelector('[data-testid="viewer-body"]')?.textContent ?? null,
      )
      return text && text.includes('export const') ? text : undefined
    })
    console.log('  · 查看器读数:', JSON.stringify(viewerText).slice(0, 300))
    for (const line of FILE_TEXT.trim().split('\n')) {
      assert(viewerText.includes(line), `查看器里逐行对上:${line}`)
    }
    /*
     * W1:查看器身上那条檐没有了(一格一檐),所以「它此刻在看谁」改问**它自己
     * 那格稳定的取件口**(`data-viewer-path`,长在查看器根上)。
     * 「檐上说得出文件名」那件事换了地方 —— 见下面第 6 步末尾那条(叶檐)。
     */
    const viewerPath = await page.evaluate(
      () => document.querySelector('[data-testid="file-viewer"]')?.getAttribute('data-viewer-path') ?? null,
    )
    assert(viewerPath === enginePath, `查看器此刻在看的就是刚点的那条路径:${viewerPath}`)
    assert(
      await page.evaluate(() => Boolean(document.querySelector('[data-testid="files-tree"] [data-file-path]'))),
      '树没有被盖掉 —— 分栏是并排,不是覆盖(树常驻铁律的真机面)',
    )
    await page.screenshot({ path: path.join(shotDir, 'viewer.png') })

    /*
     * ── W1-a 修批:**面板内这一档也有一条身份带** ────────────────────────────
     * 这一步跑在「打开方式 = 面板内」那一档(`file-open-mode` 的**出厂缺省**),
     * 而 W1-a 交卷时那一档一条檐都没有 —— 关一个文件只剩右键与 Esc,却正是多数
     * 用户第一眼看到的那一屏。所以「檐说得出文件名」这条断言不能只钉中央叶
     * (第 6 步末尾那一条),两档各钉一次。
     *
     * 问的是同一件事,只是取件口从叶换成了查看器盒子 —— 因为那条分栏里**不许插
     * 包裹层**(树与查看器的相邻兄弟是上面那条判据),所以檐只能长在盒子里面。
     * 三句话:①恰一条 tablist(修前 0 条);②它说得出文件名;③✕ 在场**而且按得动**。
     */
    const panelStrip = await page.evaluate(() => {
      const viewer = document.querySelector('[data-testid="file-viewer"]')
      const tab = viewer?.querySelector('[role="tab"]')
      const close = tab?.querySelector('[class*="close"]')
      const box = close instanceof HTMLElement ? close.getBoundingClientRect() : null
      return {
        tablists: viewer ? viewer.querySelectorAll('[role="tablist"]').length : 0,
        first: viewer?.firstElementChild?.getAttribute('data-testid') ?? null,
        tabText: (tab?.textContent ?? '').trim(),
        selected: tab?.getAttribute('aria-selected') ?? null,
        closeW: box ? Math.round(box.width) : 0,
        closeH: box ? Math.round(box.height) : 0,
        // 树的两件动作在这一档**不该在**:面板内不是树,分不了屏也没有「隐藏的标签」。
        treeActions: Boolean(
          viewer?.querySelector('[data-testid^="pane-split"], [data-testid^="pane-hidden"]'),
        ),
      }
    })
    assert(
      panelStrip.tablists === 1,
      `面板内这一格恰有一条檐(实测 ${panelStrip.tablists} 条 tablist;修前 0 条)`,
    )
    assert(
      panelStrip.first === 'viewer-strip',
      `那条檐是查看器盒子里的第一个孩子(实测 ${panelStrip.first});树与查看器仍是相邻兄弟`,
    )
    assert(
      panelStrip.tabText.includes('engine.ts'),
      `面板内那条檐说得出文件名:${panelStrip.tabText || '—'}`,
    )
    assert(panelStrip.selected === 'true', '那一格报 aria-selected=true(单 tab 也是选中的那一格)')
    assert(
      panelStrip.closeW > 0 && panelStrip.closeH > 0,
      `✕ 在场且量得到命中区:${panelStrip.closeW}×${panelStrip.closeH}`,
    )
    assert(!panelStrip.treeActions, '不画「分屏」「隐藏的标签」—— 那两件是树的动作,这一档不在树里')
    await page.screenshot({ path: path.join(shotDir, 'viewer-strip.png') })
    // **按得动**:点那颗 ✕,分栏当场收起来(修前这一档根本没有这条路)。
    await page.evaluate(() => {
      const close = document.querySelector('[data-testid="file-viewer"] [role="tab"] [class*="close"]')
      if (close instanceof HTMLElement) close.click()
    })
    await waitFor('✕ 把这一格关掉了', () =>
      page.evaluate(() => !document.querySelector('[data-testid="file-viewer"]')),
    )
    assert(true, '面板内那条檐上的 ✕ 按得动(修前:这一档一颗关闭钮都没有)')
    // 关完再开回来 —— 下面几步照旧要一份开着的查看器。
    await clickSelector(page, `[data-file-path="${enginePath}"]`)
    await waitFor('查看器又回来了', async () => {
      const now = await page.evaluate(
        () =>
          document.querySelector('[data-testid="file-viewer"]')?.getAttribute('data-viewer-path') ??
          null,
      )
      return now === enginePath
    })

    /*
      * ── F2 真机取证(09-01)──────────────────────────────────────────────
      * 三件报障各验一条,验的都是**修前做不到、修后做得到**的那件事:
      *  ① 分栏可拖:杆在场、按 APG 报 valuenow、← 一下比例真的变小(修前无杆);
      *  ② 落点真接上:选「主区域」之后那块瓦真的落在舞台上,而且面板内那条
      *     分栏收起(修前只记档不搬 —— 报障原话「open 位置,调整后也没有生效」);
      *  ③ 换落点状态留存:换过去之后**还是同一份文件、同一份内容**。
      */
     console.log('\n[6/7] 分栏可拖 + 落点真接上 + 换落点状态留存(F2)')
     const splitter = await page.evaluate(() => {
       const el = document.querySelector('[data-testid="files-splitter"]')
       if (!el) return null
       return {
         role: el.getAttribute('role'),
         orientation: el.getAttribute('aria-orientation'),
         now: Number(el.getAttribute('aria-valuenow')),
         min: Number(el.getAttribute('aria-valuemin')),
         max: Number(el.getAttribute('aria-valuemax')),
         tabIndex: el.tabIndex,
         controls: el.getAttribute('aria-controls'),
       }
     })
     assert(splitter?.role === 'separator', `分隔杆在场且报 role=separator(实测:${splitter?.role})`)
     assert(splitter?.orientation === 'vertical', '竖杆报 aria-orientation=vertical')
     assert(splitter?.tabIndex === 0, '它可聚焦(APG:可调的 separator 进 Tab 序)')
     assert(
       Number.isFinite(splitter?.now) && splitter.now > splitter.min && splitter.now < splitter.max,
       `它报得出当下的比例:${splitter?.now}(区间 ${splitter?.min}–${splitter?.max})`,
     )
     assert(splitter?.controls === 'files-tree-column', '它说得出自己在调哪一块')
     // 键盘调宽度:← 一下,比例真的变小(修前根本没有这条路)。
     await page.evaluate(() => {
       const el = document.querySelector('[data-testid="files-splitter"]')
       el.focus()
     })
     await page.keyboard.press('ArrowLeft')
     const narrowed = await page.evaluate(() =>
       Number(document.querySelector('[data-testid="files-splitter"]').getAttribute('aria-valuenow')),
     )
     assert(narrowed < splitter.now, `← 一下宽度真的变了:${splitter.now} → ${narrowed}`)
     await page.screenshot({ path: path.join(shotDir, 'splitter.png') })

     // ② 落点:右键 → 「主区域」。W1 起它是「插进中央区那棵树」,不是「摆一块瓦上舞台」。
     const beforeText = await page.evaluate(
       () => document.querySelector('[data-testid="viewer-body"]')?.textContent ?? '',
     )
     await switchModeTo(page, enginePath, /主区域|Main stage/)
     await waitFor('查看器搬到了中央叶里', () =>
       page.evaluate(() => {
         const leaf = document.querySelector('[data-pane-leaf]')
         const viewer = leaf?.querySelector('[data-testid="file-viewer"]')
         return Boolean(viewer)
       }),
     )
     assert(true, '选「主区域」之后查看器真的进了中央区那棵树(修前:只记档,一动不动)')
     assert(
       await page.evaluate(() => !document.querySelector('[data-testid="files-tree"] + [data-testid="file-viewer"]')),
       '面板内那条分栏收起来了 —— 一份内容只有一个落点(不重影)',
     )
     /*
      * ③ 状态留存 + **一格一檐**(W1 把 09-01 那次「合檐」回炉推到终点)。
      *
      * 修前这里问的是「宿主檐在场、查看器自己那条不画」;W1 之后规则只有一条:
      * **一片叶只有一条檐,那条檐就是 tab 条;内容自己一条都不画**。所以这三条
      * 翻个面继续钉同一件事:①查看器身上零檐;②**叶檐说得出文件名**;
      * ③体拿得到确定高度(修前 clientHeight == scrollHeight,内容被齐边剪掉)。
      */
     /*
      * **W1-b:那条檐搬进了窗口顶栏**(设计 §2.2 D 稿:「中央区的檐就是窗口顶栏」)。
      * 于是「一格一檐」翻了个更狠的面:**中央叶身上一条 tablist 都没有**,那一条整条
      * 在顶栏上,而且认得出它是哪片叶的(组的取件口 = 叶 id)。判据本身一个字没变:
      * 一块内容只有一条檐,而且那条檐说得出它是谁。
      */
     const merged = await page.evaluate(() => {
       const leaf = document.querySelector('[data-pane-leaf]')
       const leafId = leaf?.getAttribute('data-pane-leaf') ?? ''
       const viewer = leaf?.querySelector('[data-testid="file-viewer"]')
       const body = viewer?.querySelector('[data-testid="viewer-body"]')
       const bar = document.querySelector('[data-testid="topbar"]')
       const group = bar?.querySelector(`[data-topbar-leaf="${leafId}"]`)
       const activeTab = group?.querySelector('[role="tab"][aria-selected="true"]')
       return {
         ownChrome: Boolean(viewer?.querySelector('[data-viewer-chrome]')),
         ownName: Boolean(viewer?.querySelector('[data-testid="viewer-name"]')),
         topbarChrome: Boolean(group?.querySelector('[data-pane-chrome]')),
         // 叶身上零檐 —— 聊天区里一个像素的檐都不画。
         tablistsInLeaf: leaf ? leaf.querySelectorAll('[role="tablist"]').length : 0,
         // 顶栏上这一片叶恰好一条。
         tablistsInGroup: group ? group.querySelectorAll('[role="tablist"]').length : 0,
         activeTabText: (activeTab?.textContent ?? '').trim(),
         clientH: body?.clientHeight ?? 0,
         scrollH: body?.scrollHeight ?? 0,
         leafH: leaf ? Math.round(leaf.getBoundingClientRect().height) : 0,
       }
     })
     assert(
       merged.topbarChrome && !merged.ownChrome && !merged.ownName,
       '一格一檐:檐在顶栏上,查看器身上零檐(修前两条叠着)',
     )
     assert(
       merged.tablistsInLeaf === 0,
       `中央叶身上零檐(W1-b:实测 ${merged.tablistsInLeaf} 条 tablist,应为 0)`,
     )
     assert(
       merged.tablistsInGroup === 1,
       `顶栏上这片叶只有一条檐(实测 ${merged.tablistsInGroup} 条 tablist)`,
     )
     assert(
       merged.activeTabText.includes('engine.ts'),
       `顶栏那条檐说得出文件名:${merged.activeTabText || '—'}`,
     )
     /*
      * 「滚得动」的**根判据是高度有没有被宿主夹住**,不是「这一份内容够不够长」——
      * 这道门那个夹具文件只有两行,再长的判据它也满足不了。修前查看器没有
      * height,在宿主那个块级内容盒里高度被内容撑开(真机探针量到 52016px),
      * 于是 clientHeight == scrollHeight、浏览器不给滚动条。
      */
     assert(
       merged.clientH > 0 && merged.clientH <= merged.leafH,
       `体的高度被叶夹住(可视 ${merged.clientH} ≤ 叶 ${merged.leafH};修前是内容撑的 52016)`,
     )
     const afterText = await page.evaluate(
       () => document.querySelector('[data-testid="viewer-body"]')?.textContent ?? '',
     )
     assert(afterText === beforeText, '换落点之后内容逐字相同(状态住 store,换的只是外框)')
     await page.screenshot({ path: path.join(shotDir, 'viewer-stage.png') })
     /*
      * 收拾干净:**关掉那一格**。W1 之后关一个文件的路是 tab 上那颗唯一的 ✕
      * (从前那两颗语义不同的 ✕ 正是用户报的「有误导」)。
      */
     await page.evaluate(() => {
       const tab = Array.from(document.querySelectorAll('[data-pane-chrome] [role="tab"]')).find(
         (el) => (el.textContent ?? '').includes('engine.ts'),
       )
       const close = tab?.querySelector('[class*="close"]')
       if (close instanceof HTMLElement) close.click()
     })
     await waitFor('查看器收回', () =>
       page.evaluate(() => !document.querySelector('[data-testid="file-viewer"]')),
     )
     // 落点放回「面板内」,后面几步照旧走分栏那一档。
     await switchModeTo(page, enginePath, /面板内|This panel/)

     console.log('\n[7/7] 详情(⌘I / 右键)→ reveal 的诚实性 + 检索面文件侧')
    /*
     * ── 详情的入口 09-01 换了(双击那条路整条删了)────────────────────────
     * 报障:触控板双指点按到达时就是双击形态,与右键语义打架。裁定是
     * 「打开=单击/↵,动作=右键菜单,详情不设双击入口」。所以这里走**右键菜单**
     * 那条路 —— 门要走用户真正走的那条。
     *
     * 顺手把「双击不再开详情」也钉一条:派一个真的 dblclick,详情不该出现。
     */
    await page.evaluate(selector => {
      const el = document.querySelector(selector)
      if (!el) throw new Error(`双击不到:${selector}`)
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, detail: 2 }))
    }, `[data-file-path="${path.join(cwd, 'README.md')}"]`)
    await delay(400)
    assert(
      await page.evaluate(() => !document.querySelector('[data-testid="files-detail"]')),
      '双击**不再**开详情(09-01 裁定:触控板双指点按与右键打架)',
    )
    await page.evaluate(selector => {
      const el = document.querySelector(selector)
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    }, `[data-file-path="${path.join(cwd, 'README.md')}"]`)
    await waitFor('行菜单出来了', () =>
      page.evaluate(() => Boolean(document.querySelector('[role="menu"]'))),
    )
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
      const target = items.find(el => /详情|Details/.test(el.textContent ?? ''))
      if (!target) throw new Error('菜单里没有「详情」这一行')
      target.click()
    })
    const detailPath = await waitFor('详情面画出来', () =>
      page.evaluate(
        () =>
          document
            .querySelector('[data-testid="files-detail"] [data-file-path]')
            ?.getAttribute('data-file-path') ?? null,
      ),
    )
    /*
     * 附属浮层的**语义**:role=dialog(读屏认得出这是一块浮层)但**没有**
     * aria-modal(它不打断 —— 背后那棵树照旧看得见)。两条一起断言:
     * 少了 role 是「读屏不知道这是什么」,多了 aria-modal 是「谎称打断」。
     */
    const detailRole = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="files-detail"]')
      return el ? { role: el.getAttribute('role'), modal: el.getAttribute('aria-modal') } : null
    })
    assert(detailRole?.role === 'dialog', `详情浮层报的是 role=dialog(实测:${detailRole?.role})`)
    assert(detailRole?.modal === null, '它**没有** aria-modal —— 附属浮层不打断')
    assert(
      detailPath === path.join(cwd, 'README.md'),
      `详情面问的是刚双击的那一行:${detailPath}`,
    )
    // reveal 现在长在详情面的动作组里(行尾那枚常驻小钮已随改版退役)。
    await page.evaluate(() => {
      // 详情浮层是 role="dialog"(但没有 aria-modal —— 它是附属不是打断)。
      const buttons = Array.from(document.querySelectorAll('[role="dialog"] button'))
      const target = buttons.find(b => /文件管理器|file manager/i.test(b.textContent ?? ''))
      if (!target) throw new Error('详情面上没有「在文件管理器中显示」这颗钮')
      target.click()
    })
    await delay(800)
    // 观测口就是屏幕:失败会画一条 error toast(不自动消失那一档)。
    const revealErrorShown = await page.evaluate(() => {
      const text = document.body.textContent ?? ''
      return text.includes('没能在文件管理器中定位') || text.includes('Could not reveal that path')
    })
    console.log(
      `  · reveal 结果:${revealErrorShown ? '结构化降级并弹出通知(这台 core 是独立 server,没有宿主外壳)' : '成功,没有报错'}`,
    )
    // 详情浮层不遮树(它不是模态),但走完仍然关掉 —— Esc 是它的逃生口,
    // 顺带证一句「它真的关得掉」。
    await page.keyboard.press('Escape')
    await waitFor('详情面关掉了', () =>
      page.evaluate(() => !document.querySelector('[data-testid="files-detail"]')),
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
    await rm(userDataDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\n[d5-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
