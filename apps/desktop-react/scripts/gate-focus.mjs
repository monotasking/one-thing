#!/usr/bin/env node
/**
 * **响应链的真机门**(09-02 R0 立,设计 `docs/design/react-shell-focus-2026-09.md` §8)。
 *
 * ── 它为什么在 R0 就先立、而且**先钉红** ───────────────────────────────────
 * R0 立的是树,零消费者;八套旧机制一格没动。所以那时这道门量到的是**病本身**——
 * 场景 1 就是用户报的那条(树行 Enter 开文件 → ⌘F 开检索条 → Esc 关掉 → ⌘F 再也
 * 开不出来)。先把红钉下来,R1 / R2 才有一个「改前 vs 改后」的机器读数。
 *
 * **R2 起它不再带 `--expect-red` 跑**:内容面全部接树之后,所有场景应当全绿。
 * 那个档留着只为一件事 —— 下一次要先钉红再修的时候还用得上(有红也退 0,
 * 红绿逐条打表)。
 *
 * **R3 起它进 `npm run verify`**(排在 gate:a11y 之后、整条链最后)。理由与
 * gate:a11y 逐字相同:它断言的是焦点落点与 Esc 归属,同一份代码同一个视口跑
 * 一百遍是同一个答案,没有余量、不看机器状况 —— 与 gate:perf 那种毫秒读数
 * 正相反。判词写在 `scripts/verify.mjs` 那一行上头。
 *
 * ── 十二个场景(1-6 设计 §8 逐条;7-12 是 R2 那几条规则与拍点的读数)────────
 *  1. 树行 ↵ 开文件 → ⌘F → Esc → ⌘F 再开。**用户报的那条**。
 *  2. ⌘⇧F 开检索 → Esc → 焦点回到开它之前那块面里。
 *  3. 架子两 tab 切换 → 焦点落在新层内;旧层 `inert`(§11 拍点 2)。
 *  4. 对话框里开菜单 → Esc 只关菜单 → 再 Esc 关对话框 → 焦点回触发钮。
 *  5. 焦点在输入面板 + 旁边**真开着一扇浮窗**时按 Esc(§11 拍点 3:按树 =
 *     输入面板先答)。R3 补真:R2 版没真开浮窗(在场 0 扇),拍点 3 没被量到。
 *     两条读数缺一不可 —— 焦点仍在输入框 ∧ 那扇浮窗收掉了。生成中那半边这道门
 *     造不出来(要一台在流的 provider),**记跳过不假造**,由 jsdom 用例守着。
 *  6. 整机扫 I4(每个 Placement 宿主层根元素带 `data-focus-scope`)。
 *  7. 壳一起来,第一响应者就是输入面板(§3.5 规则 1)。
 *  8. 总览里进一条会话 → 焦点落进那条会话的输入框(§3.5 规则 2)。
 *  9. 拼舞台 → 钉右边 → 撕浮窗,每步之后焦点都在那块面所在的那一层里(规则 3)。
 * 10. 文件树单击开文件**焦点留树**,↵ 开文件**焦点进查看器**(§11 拍点 1 的 (a) 档)。
 * 11. ⌘F 在浮窗里的查看器与架子 tab 里的查看器**各开一次**(多实例:路由看实例)。
 * 12. ⌘⇧F → Esc → 焦点回到开它之前**那个输入框**(§4.5 的 returnTo,兄弟之间的归还)。
 * 13. 召唤三态(S1,§14):Dock 里 → 开 + 焦点进(**①-a 用一块自己不入焦、也没有
 *     region 的面**——工作区;自入焦的面会把「键盘开面焦点跟过去」整条盖住,
 *     09-04 S2 用户报障时这道门正是这么一声不吭的);焦点在面里 → 回输入框;看得见没聚焦
 *     → 只聚焦;架子上切走了 tab → 露出来 + 焦点进。后三态每一步都同时量
 *     「placements 一个字节没变」—— 召唤与旧那条纯开关的分歧就是这一句。
 *     **09-04 补两处**:①-a 从「按一下」扩成**三连按**(出现 / 隐藏 / 再出现 ——
 *     用户报的正是这三下里第二下变成了「没反应」);新增 ①-c **位置记忆四形**
 *     (弹窗 / 浮窗 / 盖满 / 钉右边,种在 files 上),把 `openFromMemory` 的四条
 *     支路各走一遍 —— 从前这道门只量过「新 store 的缺省档」。
 *
 * 14. 两条会话同屏(W5-b / W6-a):点列表只换活动那一格;⌘N 落活动格;⌘W 关活动格,
 *     而最后一格会话关不掉(T0 拍点 2)。
 * 15. **B3**(W7-t):点会话那一格标签 → 焦点进它的输入面板,**而且直接打字就进得去**。
 *     落点那半句在场景 3b 的 ③-a 里(那一格分成了「点会话 / 点文件」两半);这一条
 *     多量最后半句 —— 落点对了但键盘没真进去,用户报的病还在。
 * 16. **B11**(W7-t):二合一之后拆开 → 焦点跟到**左格**(它留在原标签)。
 * 17. **B12**(W7-t):⌘W 落在关不掉的那一格上 → **说一句话**,而不是静默的空动作。
 *
 * (打表时的编号比这里多一格:总览那条键盘交接是 8b,自成一个场景。)
 *
 *  每个场景**每一步**之后断言 I1(`activeElement` 不是 body)。
 *
 * ── 纪律(照 gate-a11y / gate-dock 的配方)────────────────────────────────
 *  · 真 Electron + 隔离 `--user-data-dir` + 一次性临时 store,跑完删干净;
 *  · 键盘走 playwright 的 `keyboard.press`(底下是 CDP `Input.dispatchKeyEvent`)——
 *    **只进目标窗口,不动真光标、不抢用户的机器**(09-01 判例);
 *  · `finally` 里逐个收尸,结尾自查残留。
 *
 * 跑法:`npm run gate:focus`(判红)/ `-- --expect-red`(只打表)/ `-- --strict`(StrictMode 档)。
 * 前置:仓根 `bun run server:build`,本目录 `npm run app:build`(strict 档另加 `app:build:strict`)。
 * **窗子一律离屏起**(`ONETHING_GATE_HEADLESS=1`):不上屏、不进 Dock,焦点由
 * CDP `Emulation.setFocusEmulationEnabled` 补 —— 门不许抢用户的机器。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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

const EXPECT_RED = process.argv.includes('--expect-red')

/**
 * **中央区那一组标签的取件口**(W1-b × W4 的接缝)。
 *
 * 两件事同时为真,所以这一格必须写清楚:
 *  · W1-b 起中央叶的檐整条搬进了**窗口顶栏**(`TopBarTabs`)——
 *    `[data-pane-region="center"]` 那块地里一条 tablist 都没有;
 *  · W4 起架子与浮窗的叶**自己头上**画同一件檐(`LeafStrip`),于是
 *    `[data-pane-chrome]` 不再是中央区专属。
 * 两条合起来:中央区的标签既不在中央区那块地里,也不能靠 `data-pane-chrome`
 * 单独认出来 —— 只能从**顶栏那条带子**里取。
 *
 * (内容那几层 `[data-pane-tab]` 仍旧在 `[data-pane-region="center"]` 里面,
 *  所以那一族选择器保持限定在中央区,两者不是一件事。)
 */
const CENTER_TABS = '[data-testid="topbar-tabs"] [data-pane-chrome] [role="tab"]'

/**
 * **`--strict`:换一份带 React StrictMode 的产物,把同样这些场景再跑一遍**(09-04 S4)。
 *
 * S3 结案时留的账原话:「gate:focus 跑生产构建照不出此病(改前改后都绿),只有
 * jsdom 用例与 dev 壳真机读数照得出,让门起 dev 壳待拍」。这一批把它结了 ——
 * 不是让门去起一台 vite dev 壳(那要多占 5175 这个用户自己在用的口)。
 *
 * **它是换一份产物,不是加一个开关**(施工时先走错过一次,记在这里):
 * `<StrictMode>` 在 **production 版的 react-dom 里是空操作**,模拟卸载→再挂载
 * 那一串检查整个长在 development 版里。所以 strict 档跑的是
 * `npm run app:build:strict` 出的 `dist-strict/`(`vite build --mode development`
 * —— **仍然是构建产物,不是 dev server**),由 `electron/main.ts` 的
 * `ONETHING_GATE_DIST` 指过去;缺省档那份 `dist/` 一个字节都不动,于是
 * 「118 断言」这个基线与三基线性能读数的对照面没有变。
 *
 * strict 档跑的场景与缺省档**逐条相同**(不是子集:一层重挂一次要是能踩坏别的
 * 场景,那也是本批该知道的),只在 ①-c 多一形(钉左边 —— 用户报的正是那一形)。
 */
const STRICT = process.argv.includes('--strict')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const settle = (value) => {
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
    last = await Promise.resolve()
      .then(predicate)
      .catch((error) => ({ pending: String(error?.message ?? error) }))
    if (last && !last.pending) return last
    await delay(150)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}

async function rpc(record, domain, method, payload = {}) {
  const res = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(record.token ? { authorization: `Bearer ${record.token}` } : {}),
    },
    body: JSON.stringify({ domain, method, payload }),
  })
  if (!res.ok) throw new Error(`rpc ${domain}.${method} HTTP ${res.status}`)
  const body = await res.json()
  if (!body || body.ok !== true) {
    throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  }
  return body.data
}

/** 与 gate-files 同一条理由:用 element.click() 绕开可操作性判定,派发的仍是真事件。 */
async function clickSelector(page, selector) {
  const clicked = await page.evaluate((css) => {
    const el = document.querySelector(css)
    if (!el) return false
    el.click()
    return true
  }, selector)
  if (!clicked) throw new Error(`点不到:${selector} 不在 DOM 里`)
}

/**
 * 右键一块瓦,按菜单项的文案选一种打开方式。回 false = 菜单里没有那一项。
 *
 * 走的是**用户真走的那条路**(Dock 瓦的右键菜单 = 打开方式),不去改 store ——
 * 形态落定之后焦点跟不跟得过去,正是这条路上的事(设计 §3.5 规则 3)。
 */
async function openAsFromDockMenu(page, tile, labelRe) {
  const opened = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="dock-tile-${id}"]`)
    if (!(el instanceof HTMLElement)) return false
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))
    return true
  }, tile)
  if (!opened) return false
  await delay(350)
  const picked = await page.evaluate((source) => {
    const re = new RegExp(source)
    const items = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'))
    const hit = items.find((el) => re.test(el.textContent ?? ''))
    if (hit instanceof HTMLElement) {
      hit.click()
      return true
    }
    // 没命中就把菜单收掉,别让它挡住下一步。
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return false
  }, labelRe.source)
  await delay(500)
  return picked
}

/**
 * 把那条夹具会话的**行**摆到屏幕上(不点它)。
 *
 * 09-04 方向 A:总览的卡网格换成了树形列表,`card-<id>` 改名 `session-row-<id>`;
 * 「在不在屏上」的判据仍是 `[data-session-id="<id>"]`(那条契约一个字没改)。
 *
 * 点瓦是**开关**语义:总览已经摆出来了就别再点一下(那一下会把它收回去)。
 * 而「摆出来了没有」在两种时刻都读不准 —— ①重载之后有一格窗口期(落点是记忆,
 * 面画出来要一帧,卡还要等列表拉回来);②上一个场景可能刚好把它留在开着的状态
 * (R3 判例:场景 5 改成真开浮窗之后,那一下 Esc 收的是浮窗而不是从前那一层,
 * 于是走到场景 8 时总览是开着的,一点就关,waitFor 白等 20 秒)。
 * 所以这里点完先等,等不到就**再点一次**:上一下十有八九是把它收回去了。
 * 两下都等不到才是真的没有(那时超时,是夹具的问题)。
 *
 * 单独抽出来是因为它有**两个**调用点:进会话那条路,和场景 8(它要自己断言
 * 「点行之后焦点去哪」,不能整段复用进会话)。同一段判据抄两份迟早分叉。
 */
async function ensureOverviewRow(page, sessionId) {
  // 重载之后先等那一次 RPC 往返:会话表是拉回来的,拉回来之前总览上没有卡。
  await waitFor('渲染层完成一次 RPC 往返', async () => {
    const value = await page.evaluate(() => window.__d0 ?? null)
    return value && value.rpcOk ? value : undefined
  })
  const rowShown = () =>
    page.evaluate((id) => Boolean(document.querySelector(`[data-session-id="${id}"]`)), sessionId)
  for (let attempt = 0; attempt < 2 && !(await rowShown()); attempt += 1) {
    await clickSelector(page, '[data-testid="dock-tile-sessions"]')
    await delay(700)
  }
  await waitFor('总览画出那一行', rowShown)
}

/**
 * 进那条夹具会话(总览里点那一行)。**重载之后必须再走一遍**:文件树的根跟着
 * 「当前会话的工作目录」走,而当前会话是内存态 —— 重载之后它是空的,树会退回
 * 主目录,那时候树上有什么就不由这道门说了算了。
 */
async function enterGateSession(page, sessionId) {
  await ensureOverviewRow(page, sessionId)
  await clickSelector(page, `[data-testid="session-row-${sessionId}"]`)
  await delay(400)
}

/**
 * **把文件面板切到前台**(09-05 W1-b 施工时真机抓出来的一格夹具脆弱)。
 *
 * 病历:场景 3b 的 ② 是「树行 focus() → ↵ 开文件」。`document.querySelector` 找得到
 * 那一行,`row.focus()` 却**静默不生效** —— 探针读数
 * `{landed:false, rowFound:true, tree:true, inert:true, active:composer-input}`:
 * 那棵树此刻坐在架子上一个**不活动的 tab 层**里(keep-alive,DOM 在、`inert` 也在),
 * 而 inert 子树里的元素不可聚焦。产品这一格是**对的**(后台那一层本来就不该能摸到);
 * 错的是夹具:它假设「树在 DOM 里」等于「树能用」。
 *
 * 那一层是不是活动 tab,取决于场景 3 切完 tab 之后 `shelves[side].activeId` 有没有
 * 在整页重载之前落盘 —— 一格与本批无关的持久化时序。所以这里不去赌它:
 * **看见 inert 就把那条 tab 点回来**,点不动就如实说。
 */
async function ensureFilesInteractive(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await page.evaluate(() => {
      const tree = document.querySelector('[data-testid="files-tree"]')
      if (!tree) return { ok: false, why: '文件树不在 DOM 里' }
      if (!tree.closest('[inert]')) return { ok: true }
      // 架子上那条 tab:按**文案**认(tab 上没有 id 属性,而这一格只是夹具)。
      const tab = Array.from(document.querySelectorAll('[data-shelf] [role="tab"]')).find((el) =>
        /文件|Files/.test(el.textContent ?? ''),
      )
      if (tab instanceof HTMLElement) {
        tab.click()
        return { ok: false, why: '点了架子上那条「文件」tab' }
      }
      return { ok: false, why: '树在 inert 层里,而架子上找不到它那条 tab' }
    })
    if (state.ok) return { ok: true }
    if (attempt === 2) return state
    await delay(400)
  }
  return { ok: false, why: '重试三次仍然是 inert' }
}

/** 树上此刻有没有一行**文件**(目录行不算:目录的 ↵ 是展开,不是打开)。 */
function hasFileRow(page) {
  return page.evaluate(() =>
    Boolean(
      document.querySelector('[data-testid="files-tree"] [data-file-path][data-file-type="file"]'),
    ),
  )
}

/* ── 记分板:每个场景一格,逐条打表 ────────────────────────────────────── */

const scenarios = []
let current = null

function scenario(name) {
  current = { name, checks: [] }
  scenarios.push(current)
  console.log(`\n[场景 ${scenarios.length}] ${name}`)
}

function assert(ok, message, detail) {
  current.checks.push({ ok: Boolean(ok), message, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${message}${detail ? `  ${detail}` : ''}`)
  return Boolean(ok)
}

/**
 * 夹具没搭起来 = **跳过**,不是红。
 * 红要留给产品的读数;把「这台默认布局没摆出两块面」记成红,下一个人只会去
 * 改判据(判例:命名近似规则那条注释里写过同一件事)。
 */
function skip(message, why) {
  current.checks.push({ skipped: true, ok: true, message, detail: why })
  console.log(`  ⊘ ${message}(跳过:${why})`)
}

/** I1:焦点永远不落在「没有东西」上。每一步之后问一次。 */
async function assertNoOrphan(page, step) {
  const at = await page.evaluate(() => {
    const el = document.activeElement
    return {
      isBody: el === document.body || el === null,
      tag: el?.tagName?.toLowerCase() ?? '(null)',
      testid: el?.getAttribute?.('data-testid') ?? null,
      scope: el?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
    }
  })
  return assert(
    !at.isBody,
    `I1 · ${step}:焦点没掉到 body`,
    `(此刻在 <${at.tag}>${at.testid ? `[${at.testid}]` : ''},作用域 ${at.scope ?? '—'})`,
  )
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[focus-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[focus-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }
  if (STRICT && !existsSync(path.join(appRoot, 'dist-strict/index.html'))) {
    console.error(
      '[focus-gate] --strict 要的是带 StrictMode 的那份产物 —— 先跑 `npm run app:build:strict`',
    )
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'focus-gate-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'focus-gate-userdata-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'focus-gate-ws-'))
  let server
  let app
  try {
    // 一棵最小的树,场景 1 要在它上面开一个文件。
    await mkdir(path.join(workspaceRoot, 'notes'), { recursive: true })
    await writeFile(path.join(workspaceRoot, 'notes', 'alpha.md'), '# alpha\n\nzorbulax\n')
    await writeFile(path.join(workspaceRoot, 'readme.md'), '# readme\n')
    /*
     * **一份按行寻址的内容**(场景 1 / 11 的 ⌘F 要它):跳转条只在
     * `handler.lineCount` 答得出数时才开(图 / 渲染态 markdown / 诚实态都答不出,
     * 那时 ⌘F 原样落给全局命令表 —— 那是产品行为,不是响应链的事)。
     * 树上文件按名排序,`a.ts` 因此是第一个 `data-file-type="file"` 的行。
     */
    await writeFile(
      path.join(workspaceRoot, 'a.ts'),
      "export const gate = 'focus'\nconst second = 2\nconst third = 3\n",
    )
    // 第二份按行寻址的内容:场景 11(多实例)要在同一片叶里开两格查看器。
    await writeFile(
      path.join(workspaceRoot, 'b.ts'),
      "export const other = 'focus'\nconst two = 2\n",
    )

    console.log('[1/3] 起一台 core')
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
    server.stderr.on('data', (chunk) => serverErr.push(chunk.toString()))
    const record = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    }).catch((error) => {
      throw new Error(`${error.message}\nserver stderr:\n${serverErr.join('')}`)
    })
    if (!(await portConnects(record.host, record.port))) throw new Error('core 端口连不上')

    const created = await rpc(record, 'sessions', 'create', { name: 'focus-gate' })
    const sessionId = created?.session?.id
    if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(created)}`)
    await rpc(record, 'sessions', 'updateWorkingDirectory', {
      sessionId,
      workingDirectory: workspaceRoot,
    })
    /*
     * **另外两条会话**(W5-b 场景 15「两片会话叶并排」的夹具):
     * 一条用来切出第二片叶,一条用来验「点列表只换焦点叶那一格」。
     */
    const secondId = (await rpc(record, 'sessions', 'create', { name: 'focus-gate-2' }))?.session?.id
    const thirdId = (await rpc(record, 'sessions', 'create', { name: 'focus-gate-3' }))?.session?.id
    if (!secondId || !thirdId) throw new Error('夹具会话没建够三条')

    console.log(`[2/3] 拉起应用(离屏 · 独立 --user-data-dir${STRICT ? ' · StrictMode' : ''})`)
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: '',
        /*
         * **离屏起窗**(09-04 S4,纪律「真机门不许抢用户的机器」的落地)。
         * 窗子不 show()、不进 Dock;页面照样渲染、照样跑布局与 rAF。
         */
        ONETHING_GATE_HEADLESS: '1',
        ...(STRICT ? { ONETHING_GATE_DIST: 'dist-strict' } : {}),
      },
    })
    const page = await app.firstWindow()
    /*
     * **离屏窗要自己把「我有焦点」这件事补上**(CDP `Emulation.setFocusEmulationEnabled`)。
     *
     * 不补的话:窗口没上屏 → 页面处于 blurred 状态 → `document.hasFocus()` 为假,
     * `:focus-visible` 不画,而这道门**量的正是焦点**。补上之后 `activeElement` /
     * `focusin` / `focusout` / `Tab` 走位全部与前台档逐字相同 —— 一致性由 S4 拿
     * HEAD 在两档各跑一趟证过(118 断言逐条对上)。
     *
     * 这是**只进这个窗口**的 CDP 调用,一根手指都不碰真光标与用户的前台
     * (09-01 那条「禁系统级合成输入」判例的同一条纪律)。
     */
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    /** 壳的地址(重载都走它;`?gallery` 那一格是场景 4 用的组件库页)。 */
    const shellUrl = (extra = '') => `${page.url().split('?')[0]}${extra ? `?${extra}` : ''}`
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await waitFor('Dock 就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid^="dock-tile"]'))),
    )
    // 进那条会话(门要走用户真正走的那条路)。
    await enterGateSession(page, sessionId)

    console.log('[3/3] 逐个场景')

    /* ── 场景 1:⌘F → Esc → ⌘F(用户报的那条)──────────────────────────── */
    scenario('树行 ↵ 开文件 → ⌘F → Esc → ⌘F 再开(用户报的那条;R1 之前第二次开不出来)')
    await clickSelector(page, '[data-testid="dock-tile-files"]')
    await waitFor('文件树画出来', () =>
      page.evaluate(() =>
        Boolean(document.querySelector('[data-testid="files-tree"] [data-file-path]')),
      ),
    )
    await assertNoOrphan(page, '开文件面板之后')
    // 焦点落到第一行再按 ↵ —— 「单击留树、↵ 进查看器」是 §11 拍点 1 的 (a) 档。
    // 挑一行**文件**(目录行的 ↵ 是展开,不是打开 —— 那是另一件事)。
    const rowFocused = await page.evaluate(() => {
      const row = document.querySelector(
        '[data-testid="files-tree"] [data-file-path][data-file-type="file"]',
      )
      if (!(row instanceof HTMLElement)) return false
      row.focus()
      return document.activeElement === row
    })
    assert(rowFocused, '树行(文件那一行)接得住焦点 —— ↵ 开文件的前提')
    await page.keyboard.press('Enter')
    await delay(500)
    let opened = await page.evaluate(() =>
      Boolean(document.querySelector('[data-testid="file-viewer"]')),
    )
    assert(opened, '↵ 之后查看器开出来了(§11 拍点 1 的 (a) 档)')
    if (!opened) {
      // ↵ 今天开不出来的话退回单击开 —— 这个场景真正要量的是后面那三下
      // (⌘F → Esc → ⌘F),不该被前置动作卡死在半路。
      await clickSelector(page, '[data-testid="files-tree"] [data-file-type="file"]')
      await delay(500)
      opened = await page.evaluate(() =>
        Boolean(document.querySelector('[data-testid="file-viewer"]')),
      )
      console.log(`  · ↵ 没开出来,退回单击开:${opened ? '开出来了' : '仍然没有'}`)
    }
    await assertNoOrphan(page, '开查看器之后')

    const findBar = () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="viewer-jump-bar"]')))
    await page.keyboard.press('Meta+f')
    await delay(300)
    const first = await findBar()
    assert(first, '第一次 ⌘F:检索条开出来')
    await page.keyboard.press('Escape')
    await delay(300)
    assert(!(await findBar()), 'Esc 关掉检索条')
    await assertNoOrphan(page, 'Esc 关掉检索条之后(**这一步是病根**:焦点该回查看器)')
    await page.keyboard.press('Meta+f')
    await delay(300)
    assert(await findBar(), '**第二次 ⌘F:检索条还开得出来**(用户报的那条)')

    /* ── 场景 2:⌘⇧F → Esc → 焦点回原处 ───────────────────────────────── */
    scenario('⌘⇧F 开检索 → Esc → 焦点回到开它之前那块面里')
    const before = await page.evaluate(
      () => document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
    )
    await page.keyboard.press('Meta+Shift+f')
    await delay(400)
    const searchOpen = await page.evaluate(() =>
      Boolean(document.querySelector('[data-testid="search-panel"], [data-pane-tab="panel:search"]')),
    )
    assert(searchOpen, '⌘⇧F 把检索面开出来了')
    await assertNoOrphan(page, '⌘⇧F 开面之后')
    await page.keyboard.press('Escape')
    await delay(400)
    await assertNoOrphan(page, 'Esc 收面之后')
    const after = await page.evaluate(
      () => document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
    )
    assert(
      before !== null && after === before,
      '焦点回到了开它之前那个作用域',
      `(开之前 ${before ?? '—'} → 收之后 ${after ?? '—'})`,
    )

    /* ── 场景 2b:检索面的三条焦点纪律(检索面终稿 R10)────────────────────
     * 三件都只有真机量得到,而三件都是 09-05 报障里点过名的:
     *  ① **⌘⇧F 开面,焦点进的是那格输入框**(不是面板根,也不是 Dock 上那颗瓦)——
     *    落点由作用域的 `restingTarget` 答,第 ⑦ 步它从 `activateOnMount` 换成了
     *    `SearchBindings` 的 `placed` 上升沿,行为必须一个字不变;
     *  ② **Tab 在这块面里是「换搜索范围」**,不是把焦点交出去(行内结构键,
     *    不进任何表);焦点因此**留在输入框**;
     *  ③ **IME 组字期间不接键**:`isComposing` 的那一下 ↓ 不许去走行 ——
     *    中文输入法选字用的正是方向键,抢走它就打不出字。
     */
    scenario('检索面:⌘⇧F 落焦进输入框 / Tab 换档不交焦点 / IME 组字期间不接键')
    await page.keyboard.press('Meta+Shift+f')
    await delay(400)
    const searchInputReady = await page.evaluate(() =>
      Boolean(document.querySelector('[data-testid="search-panel"] input')),
    )
    if (!searchInputReady) {
      skip('检索面没开出来', '这台的默认布局里 ⌘⇧F 没把它摆出来')
    } else {
      const landed = await page.evaluate(() => {
        const input = document.querySelector('[data-testid="search-panel"] input')
        return document.activeElement === input
      })
      assert(landed, '① ⌘⇧F 开面之后焦点落在**那格输入框**上')
      await assertNoOrphan(page, '⌘⇧F 开检索面之后')

      const tabbed = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="search-panel"]')
        const input = panel.querySelector('input')
        const before = [...panel.querySelectorAll('[role="radio"]')]
          .findIndex(el => el.getAttribute('aria-checked') === 'true')
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab', bubbles: true, cancelable: true,
        }))
        return { before, panelHasFocus: document.activeElement === input }
      })
      await delay(200)
      const afterTab = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="search-panel"]')
        return {
          at: [...panel.querySelectorAll('[role="radio"]')]
            .findIndex(el => el.getAttribute('aria-checked') === 'true'),
          focused: document.activeElement === panel.querySelector('input'),
        }
      })
      assert(
        afterTab.at === tabbed.before + 1,
        '② Tab 是**换搜索范围**(档位往后挪一格)',
        `(${tabbed.before} → ${afterTab.at})`,
      )
      assert(afterTab.focused, '② Tab 之后焦点**仍然在输入框**,没有交出去')

      /*
       * ③ IME:派一下 `isComposing` 的 ↓。判据是「活动项一格没动」——
       * 组字期间那一下方向键归输入法,列表连看都不该看它。
       */
      const ime = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="search-panel"]')
        const input = panel.querySelector('input')
        const activeOf = () => panel.querySelector('[role="option"][aria-selected="true"]')
          ?.getAttribute('data-item-id') ?? null
        const before = activeOf()
        const event = new KeyboardEvent('keydown', {
          key: 'ArrowDown', bubbles: true, cancelable: true,
        })
        // jsdom / Chromium 都不让直接构造 isComposing,所以就地定义它。
        Object.defineProperty(event, 'isComposing', { value: true })
        input.dispatchEvent(event)
        return { before, after: activeOf(), prevented: event.defaultPrevented }
      })
      assert(
        ime.after === ime.before,
        '③ IME 组字期间那一下 ↓ **不动活动项**(方向键归输入法)',
        `(${ime.before ?? '—'} → ${ime.after ?? '—'})`,
      )
      assert(!ime.prevented, '③ 而且**不吞**它:组字那一下要原样交给输入法')
      await page.keyboard.press('Escape')
      await delay(300)
      await assertNoOrphan(page, '收回检索面之后')
    }

    /* ── 场景 3:架子切 tab ──────────────────────────────────────────── */
    scenario('架子两 tab 切换 → 焦点在新层内;旧层 inert')
    // 夹具:右键两块瓦,各自选「右侧栏」——「钉到边」是菜单里那一组的语义,
    // 走的是用户真走的那条路(不去改 store)。
    for (const tile of ['diff', 'sessions']) {
      const pinned = await page.evaluate((id) => {
        const el = document.querySelector(`[data-testid="dock-tile-${id}"]`)
        if (!(el instanceof HTMLElement)) return false
        el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))
        return true
      }, tile)
      if (!pinned) continue
      await delay(400)
      const picked = await page.evaluate(() => {
        const items = Array.from(
          document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'),
        )
        const texts = items.map((el) => (el.textContent ?? '').trim())
        // 语言两种都认:这道门跑在一个全新 store 上,界面语言跟系统走。
        const right = items.find((el) => /右侧栏|Right/.test(el.textContent ?? ''))
        if (right instanceof HTMLElement) right.click()
        return { count: items.length, texts, hit: Boolean(right) }
      })
      console.log(
        `  · 右键 ${tile}:菜单 ${picked.count} 项${picked.count ? `(${picked.texts.join(' / ')})` : ''},`
          + `「右侧栏 / Right」${picked.hit ? '点到了' : '没找到'}`,
      )
      await delay(500)
    }
    /*
     * **只数展开着的那些架子上的 tab**(2026-09-12「收起 ≠ 关闭」)。收起从今天起
     * 不卸载树身,于是一条收成细梁的架子照样查得到 `[role="tab"]` —— 拿它来选
     * 「切哪一格」会点进一块**此刻看不见**的面,而这一段要量的是焦点跟着切 tab
     * 走。改的只是**读形态的方式**(`:not([data-shelf-collapsed])`),量什么一个字没动。
     */
    const shelf = await page.evaluate(() => ({
      count: document.querySelectorAll('[data-shelf]:not([data-shelf-collapsed]) [role="tab"]').length,
    }))
    if (shelf.count < 2) {
      skip('架子两 tab 切换', `夹具没搭起来 —— 此刻架子上只有 ${shelf.count} 个 tab`)
    } else {
      /*
       * 点哪一条 tab 就量哪一条架子(W4:四条边各持一棵树,而前面几个场景可能
       * 在别的边上也留了瓦 —— 点 A 边、量 B 边当然读不到焦点)。
       */
      const clickedSide = await page.evaluate(() => {
        const tabs = Array.from(
          document.querySelectorAll('[data-shelf]:not([data-shelf-collapsed]) [role="tab"]'),
        )
        const off = tabs.find((t) => t.getAttribute('aria-selected') !== 'true')
        if (!(off instanceof HTMLElement)) return null
        off.click()
        return off.closest('[data-shelf]')?.getAttribute('data-shelf') ?? null
      })
      await delay(400)
      /*
       * ── W4:架子的身子换成了拼贴树,层次因此是**两级** ──────────────────
       * 从前一格 tab 一层,每一层自己是一格 `shelf-layer`;现在**整条架子**一格
       * `shelf-layer`(住户 = 它露脸的那格瓦 —— 召唤与跟焦按住户名精确取那一条边),
       * 里面每一格 tab 是一格 `leaf`(`inert` 仍旧说两遍,判词在 `PaneLeaf` 的
       * `PaneTabLayer` 上)。取件口随之从 `data-panel-layer=<瓦 id>` 换成
       * `data-pane-tab=<refId>`;**这一条要守的三件事一个字没改**。
       */
      const state = await page.evaluate((side) => {
        const body = document.querySelector(
          side
            ? `[data-shelf="${side}"] [data-shelf-body]`
            : '[data-shelf]:not([data-shelf-collapsed]) [data-shelf-body]',
        )
        const layers = Array.from(body?.querySelectorAll('[data-pane-tab]') ?? [])
        const active = document.activeElement
        return {
          inertOld: layers.filter((l) => l.hasAttribute('inert')).length,
          focusInLive: layers.some(
            (l) => !l.hasAttribute('inert') && active instanceof Node && l.contains(active),
          ),
          focusInShelf: Boolean(body && active instanceof Node && body.contains(active)),
          onTab: active instanceof Element ? active.getAttribute('role') === 'tab' : false,
          scopes: layers.map((l) => l.getAttribute('data-focus-scope')),
          hostScope: body?.getAttribute('data-focus-scope') ?? null,
        }
      }, clickedSide)
      assert(state.inertOld > 0, '旧层打上了 inert')
      /*
       * I4 的架子那一格在**这里**验,不在场景 6 —— 那时架子上多半已经空了
       * (场景 5 的整页重载 + 场景 6 把瓦挪去别的形态)。层是按需挂载的东西,
       * 只能在它确实在场的那一刻问。
       */
      assert(
        state.hostScope === 'shelf-layer',
        'I4 · shelf-layer:这条架子的身子带着 data-focus-scope',
        `(读数 ${state.hostScope ?? '—'})`,
      )
      assert(
        state.scopes.length > 0 && state.scopes.every((v) => v === 'leaf'),
        '架子里每一格 tab 各是树上一格 `leaf`',
        `(${state.scopes.length} 层:${[...new Set(state.scopes)].join(' / ') || '—'})`,
      )
      /*
       * ── §11 拍点 2「切 tab 进内容」:W4 之后它是**裁定**,不再是侥幸 ────────
       * W4 之前架子的 tab 条长在架子的 `<head>` 里、在每一格 `shelf-layer` 的
       * **外面** —— 点一条 tab 之后焦点不在任何一层里,于是 `focus-follow` 的
       * 「架子切 tab」那一发 `activateScope` 送得进去,这一条因此绿。
       *
       * W4 把那条 tab 条换成了**叶檐**(`LeafStrip`,它长在叶里、叶又长在层里),
       * 那条路当场失效:注册表的「焦点已经在我里面就不往回拽」把它挡住,焦点
       * 停在 tab 上。W4 交卷时曾把这一条**收弱**成「焦点还在这条架子里」。
       *
       * 09-05 裁定:**不收弱,把行为定死** —— tab 被激活(指针点击 / Enter /
       * Space)→ 焦点进这片叶的内容;←/→ roving 仍旧留在 tab 上。四个区域
       * (中央顶栏组 / 架子叶檐 / 浮窗根叶檐 / 分屏出来的叶)同一句话,产地只有
       * 一处:`workbench/LeafStrip.tsx` 的 `useSelectIntoContent`。
       *
       * 所以这一条回到强的那一句,并且在 3b ③ 给**中央区**加了同款读数。
       */
      assert(
        state.focusInLive,
        '焦点落在新层内(§11 拍点 2:切 tab 进内容)',
        `(在这条架子里:${state.focusInShelf} / 停在 tab 上:${state.onTab})`,
      )
      await assertNoOrphan(page, '切 tab 之后')
    }

    /* ── 场景 3b:中央叶两 tab 切换(W1)────────────────────────────────
     *
     * 与场景 3 **同型**(那一条量的是架子的 tab 层),这一条量中央区那棵拼贴树里
     * 一片叶的 tab 层。判据逐字相同:**非活动那一格 inert 说两遍**(DOM 一遍、
     * 树一遍),而焦点落在活的那一层里。
     *
     * 夹具走用户真走的那条路:文件树行右键 →「主区域」把落点改成中央区,
     * 再 ↵ 开一个文件 —— 于是那片叶上有两格 tab(聊天 + 文件)。
     */
    scenario('中央叶两 tab 切换 → 焦点在活的那一层内;非活动那一层 inert')
    {
      await page.goto(shellUrl())
      await waitFor('壳回来了', () =>
        page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-input"]'))),
      )
      await enterGateSession(page, sessionId)
      if (!(await hasFileRow(page))) {
        await clickSelector(page, '[data-testid="dock-tile-files"]')
        await delay(500)
      }
      const rowCss = '[data-testid="files-tree"] [data-file-path][data-file-type="file"]'
      const haveRow = await page.evaluate((css) => Boolean(document.querySelector(css)), rowCss)
      if (!haveRow) {
        skip('中央叶两 tab 切换', '文件树没画出一行文件 —— 夹具没搭起来')
      } else {
        // ① 落点改「主区域」(= 中央区那棵树)。走行菜单,不改 store。
        await page.evaluate((css) => {
          const row = document.querySelector(css)
          row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 }))
        }, rowCss)
        await delay(400)
        const toCenter = await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
          const center = items.find((el) => /主区域|Main stage/.test(el.textContent ?? ''))
          if (center instanceof HTMLElement) center.click()
          return Boolean(center)
        })
        await delay(400)
        if (!toCenter) {
          skip('中央叶两 tab 切换', '行菜单里没有「主区域 / Main stage」那一档')
        } else {
          // ② ↵ 开一个文件 —— 它成为中央叶的第二格 tab,而且是活动那一格。
          /*
           * 树可能坐在架子上一个**不活动的 tab 层**里(DOM 在、`inert` 也在),
           * 那时 `row.focus()` 静默不生效 —— 病历与判据写在 `ensureFilesInteractive` 上。
           */
          const live = await ensureFilesInteractive(page)
          const landed = await page.evaluate((css) => {
            const row = document.querySelector(css)
            if (row instanceof HTMLElement) row.focus()
            return document.activeElement === row
          }, rowCss)
          await page.keyboard.press('Enter')
          await delay(700)
          const twoTabs = await page.evaluate(
            (css) => document.querySelectorAll(css).length,
            CENTER_TABS,
          )
          if (twoTabs < 2) {
            skip(
              '中央叶两 tab 切换',
              `顶栏那一组只有 ${twoTabs} 格 tab —— 夹具没搭起来`
                + `(树可交互:${live.ok}${live.why ? `/${live.why}` : ''};焦点落在行上:${landed})`,
            )
          } else {
            const leafState = await page.evaluate(() => {
              // W4:架子与浮窗也画 `data-pane-tab`,所以这一条要**限定在中央区**。
              const center = document.querySelector('[data-pane-region="center"]')
              const layers = Array.from(center?.querySelectorAll('[data-pane-tab]') ?? [])
              const active = document.activeElement
              return {
                layers: layers.length,
                inertOff: layers.filter((l) => l.hasAttribute('inert')).length,
                focusInLive: layers.some(
                  (l) => !l.hasAttribute('inert') && active instanceof Node && l.contains(active),
                ),
                scopes: layers.map((l) => l.getAttribute('data-focus-scope')),
              }
            })
            assert(leafState.layers >= 2, '叶里两格 tab 各挂一层', `(${leafState.layers} 层)`)
            assert(
              leafState.inertOff === leafState.layers - 1,
              '非活动那些层**都**打上了 inert(DOM 那一遍)',
              `(${leafState.inertOff}/${leafState.layers - 1})`,
            )
            assert(
              leafState.scopes.every((v) => v === 'leaf'),
              '每一层的根都带 data-focus-scope="leaf"',
              `(${[...new Set(leafState.scopes)].join(' / ') || '—'})`,
            )
            assert(leafState.focusInLive, '焦点落在活的那一层内')
            await assertNoOrphan(page, '中央叶开出第二格 tab 之后')

            /*
             * ③ 切回第一格(聊天),再问一次同一句话 —— inert 跟着翻,不是只翻一次。
             * **点与读都限定在中央区**(W4:架子的叶檐也画 `data-pane-chrome`,
             * 不限定的话这一下点的是架子上那条 tab 条)。
             *
             * ── W7-t / B3:这一格分成两半 ──────────────────────────────────
             * 09-05 那句裁定(「点顶栏一格 tab → 焦点进那片叶的内容」)一个字没变;
             * 变的是「内容」这两个字对**会话**那一种意味着什么 —— 它自述
             * `focusInto: 'composer'`(`ContentKind.focusInto`),而它自述的理由正是
             * 用户报的那条:修前点回会话标签,焦点落在消息流上,直接打字进不去。
             * 所以两半各读一次,谁都不被另一半的答案盖住:
             *  · ③-a 点**会话**那一格(自述了落点的那一种)→ 焦点进输入面板;
             *  · ③-b 再点回**文件**那一格(没自述的那一种)→ 原判据逐字不变。
             * 两半共有的那一句(inert 跟着翻)各问一遍 —— 翻两次才叫「跟着翻」。
             */
            const flipTab = async () => {
              await page.evaluate((css) => {
                const tabs = Array.from(document.querySelectorAll(css))
                const off = tabs.find((t) => t.getAttribute('aria-selected') !== 'true')
                if (off instanceof HTMLElement) off.click()
              }, CENTER_TABS)
              await delay(400)
              return page.evaluate(() => {
                const center = document.querySelector('[data-pane-region="center"]')
                const layers = Array.from(center?.querySelectorAll('[data-pane-tab]') ?? [])
                const live = layers.filter((l) => !l.hasAttribute('inert'))
                const active = document.activeElement
                return {
                  inertOff: layers.filter((l) => l.hasAttribute('inert')).length,
                  live: live.map((l) => l.getAttribute('data-pane-tab')),
                  // 「切 tab 进内容」在中央区的读数(09-05 裁定,与场景 3 同一句话)。
                  focusInLive: live.some((l) => active instanceof Node && l.contains(active)),
                  onTab: active instanceof Element ? active.getAttribute('role') === 'tab' : false,
                  // 焦点此刻真的落在哪一件上(B3 要的是**那块可编辑区本身**)。
                  testid: active instanceof Element ? active.getAttribute('data-testid') : null,
                  /*
                   * 焦点那一格作用域。**要读到内容自己那一格** —— `leaf` 是家具
                   * (`passThrough`),停在它身上就说明穿透那一步没走完。
                   */
                  scope: active?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
                }
              })
            }

            /* ③-a 点回会话那一格 —— B3 的读数。 */
            const toChat = await flipTab()
            assert(
              toChat.scope === 'composer' && toChat.testid === 'composer-input',
              '点会话那一格 tab → 焦点落进它的输入面板(W7-t / B3,`ContentKind.focusInto`)',
              `(作用域 ${toChat.scope ?? '—'} / 落在 ${toChat.testid ?? '—'} 上;停在 tab 上:${toChat.onTab})`,
            )
            assert(
              toChat.inertOff === leafState.layers - 1 && toChat.live.length === 1,
              '切到会话那一格:inert 跟着翻,活的永远只有一层',
              `(活的:${toChat.live.join(' / ') || '—'})`,
            )
            await assertNoOrphan(page, '中央叶切到会话那一格之后')

            /* ③-b 再点回文件那一格 —— 没自述落点的那一种,原判据逐字不变。 */
            const flipped = await flipTab()
            /*
             * ── 中央区的「切 tab 进内容」(09-05 裁定,与场景 3 同款)────────
             * 那条檐在顶栏上、内容在中央区那块地里,两者在 DOM 上互不包含 ——
             * 所以这一条量的是**跨 DOM 分支的落焦**,正是裁定要的那件事:判据
             * 是响应链(`activateScope('leaf', { owner: refId })` + `passThrough`),
             * 不是 DOM 祖先。
             */
            assert(
              flipped.focusInLive,
              '点顶栏一格 tab → 焦点进那片叶的内容(09-05 裁定,四个区域同一句)',
              `(停在 tab 上:${flipped.onTab} / 作用域 ${flipped.scope ?? '—'})`,
            )
            assert(
              Boolean(flipped.scope) && flipped.scope !== 'leaf',
              '而且落在**内容自己那一格**作用域上,不是叶那格家具',
              `(读数 ${flipped.scope ?? '—'})`,
            )
            assert(
              flipped.inertOff === leafState.layers - 1 && flipped.live.length === 1,
              '切一次 tab:inert 跟着翻,活的永远只有一层',
              `(活的:${flipped.live.join(' / ') || '—'})`,
            )
            await assertNoOrphan(page, '中央叶切 tab 之后')
          }
        }
      }
    }


    /* ── 场景 3c:文件叶 ⌘⇧↩ 进真全屏(W2,设计 §4)──────────────────────
     *
     * 四条读数,一条都不能少:
     *  ① `full-layer` 拿到键盘(§3.5 规则 2「打开什么,焦点进什么」);
     *  ② 那一格内容**真的搬进了全屏层**,叶自己的身子留空 —— 而且它是**同一个
     *     DOM 节点**(零重挂;判词与三种写法的实测读数写在 `PaneLeaf` 文件头);
     *  ③ 其余的叶与架子 `inert`(路径截断,DOM 与树各说一遍),而且它**真的压得过
     *     浮窗**(`--z-full: 550` > `--z-float: 200`)—— 判据是
     *     `elementFromPoint` 落在全屏层里,不是读一个 z 数字:那正是「盖」当年
     *     被用户说成「不是全屏的那个全屏」的那一格;
     *  ④ Esc 退出 → 内容回原叶原 tab,键盘也回原处(§3.5 规则 5)。
     *
     * 夹具接着 3b 用:那一步已经把「文件开在哪」的记忆改成了主区域,而且中央叶上
     * 此刻恰有两格 tab(聊天 + 文件)。这一步先把**文件**那一格点成活动的 ——
     * 聊天那一种自述 `fullable: false`(输入框会被盖掉,W5 撤),⌘⇧↩ 落在它身上
     * 是结构化拒绝,不是进全屏。
     */
    scenario('文件叶 ⌘⇧↩ → 全屏层拿焦点、其余叶与架子 inert、Esc 回原叶原 tab')
    {
      /*
       * 先在旁边**真开一扇浮窗**(③ 的层序那一半要它):全屏得压得过它。
       * 顺序不能反 —— 开浮窗会把焦点叶指到那扇窗那片叶上,而下面那一下 ⌘⇧↩
       * 取的正是焦点叶的活动 tab。
       *
       * **拿 `diff` 那块瓦开,不拿 `sessions` / `search`**:后两块是场景 16 的夹具
       * (右架子上那两格 tab),而「打开方式」这一下会**改它的位置记忆** ——
       * 第一版用了 sessions,场景 16 的 ② 当场变成「那条架子上只有 1 个 tab」的跳过,
       * 门还是绿的,少的那几条读数一声不吭。这正是这只文件里已经立过的那条判例。
       */
      const floatUp = await openAsFromDockMenu(page, 'diff', /^(Float|浮窗)$/)
      await delay(400)
      const floatBox = floatUp
        ? await page.evaluate(() => {
          const win = document.querySelector('[data-float-body]')?.closest('section')
          if (!win) return null
          const r = win.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
        })
        : null

      /*
       * 把中央区那一组标签里**文件那一格**点亮。
       *
       * 修前这里写的是「点不是当前选中的那一格」—— 一个**奇偶数**的写法:它成立
       * 全靠「上一步之后活动的恰好是聊天那一格」。W7-t / B3 把场景 3b 的 ③ 拆成
       * 了两半(先点会话、再点回文件),翻了两次,这里再翻一次就落到**聊天**那格
       * 上,而聊天自述 `fullable: false` —— 于是这一整段(⌘⇧↩ 进全屏)在夹具都没
       * 搭对的情况下跑完并红了八条。夹具该按**它要的是谁**说话,不按奇偶说话。
       */
      const picked = await page.evaluate((css) => {
        const tabs = Array.from(document.querySelectorAll(css))
        const file = tabs.find((t) => (t.getAttribute('data-tab-id') ?? '').startsWith('file:'))
        if (file instanceof HTMLElement) {
          file.click()
          return true
        }
        return false
      }, CENTER_TABS)
      await delay(400)
      const liveTab = await page.evaluate(() => {
        const center = document.querySelector('[data-pane-region="center"]')
        const live = Array.from(center?.querySelectorAll('[data-pane-tab]') ?? []).find(
          (l) => !l.hasAttribute('inert'),
        )
        return live?.getAttribute('data-pane-tab') ?? null
      })
      /*
       * 跳过的判据也一起修:内容 refId 里会话那一种的前缀是 `session:`
       * (`content/session-ref.ts` 的 `SESSION_KIND`),`chat:` 是一个从来没有
       * 命中过的旧名 —— 于是「夹具没搭起来」这条出口一直是死的,夹具错了也照跑。
       */
      if (!picked || !liveTab || !liveTab.startsWith('file:')) {
        skip('文件叶 ⌘⇧↩ 进全屏', `中央叶此刻活的是 ${liveTab ?? '—'} —— 夹具没搭起来`)
      } else {
        await page.keyboard.press('Meta+Shift+Enter')
        await delay(600)

        const inFull = await page.evaluate((tabId) => {
          const layer = document.querySelector('[data-testid="full-layer"]')
          const slot = document.querySelector('[data-full-slot]')
          const tab = document.querySelector(`[data-pane-tab="${tabId}"]`)
          const centerBody = document.querySelector('[data-pane-region="center"] [data-pane-body]')
          const active = document.activeElement
          const leaves = Array.from(document.querySelectorAll('[data-pane-leaf]'))
          const shelves = Array.from(document.querySelectorAll('[data-focus-scope="shelf-layer"]'))
          return {
            layer: Boolean(layer),
            // ① 键盘进了全屏层。
            focusInLayer: Boolean(layer && active instanceof Node && layer.contains(active)),
            // ② 内容搬进了 slot,叶自己的身子里一格 tab 层都没有。
            tabInSlot: Boolean(slot && tab && slot.contains(tab)),
            bodyEmpty: centerBody ? centerBody.querySelectorAll('[data-pane-tab]').length === 0 : null,
            /*
             * ③ 其余的叶与架子 inert(**装着它的那一片留活口**)。
             *
             * 「哪一片是持有者」不能靠 `tab.closest('[data-pane-leaf]')` 反查 ——
             * 全屏期间那一格的 DOM 已经搬进全屏层了,它在叶的**外面**。
             * 判据换成读结果:非 inert 的叶**恰好一片**,那一片就是持有者。
             */
            leaves: leaves.length,
            inertLeaves: leaves.filter((l) => l.hasAttribute('inert')).length,
            shelvesInert: shelves.every((el) => el.hasAttribute('inert')),
            shelfCount: shelves.length,
          }
        }, liveTab)

        /*
         * ③ 之二:**层序**。两条读数,量的是两件不同的事:
         *
         *  · `z` —— 读的是**排出来的 computed style**(不是样式表源文本):全屏那一层
         *    必须严格大于最上面那扇浮窗。反证:把 `--z-full` 改回「盖」那一档
         *    (100 < --z-float 200)→ 这一条当场红,而上面那几条(焦点 / inert /
         *    搬家)一条都不会红 —— 它是层序唯一的守卫;
         *  · `hit` —— 在那扇浮窗的正中取一点问「这一点上是谁」。它量的**不是 z**
         *    (第一版以为是,拿它当层序的判据,把 `--z-full` 改成 100 照样绿):
         *    被盖住的浮窗此刻带着 `inert`,而 Chromium 的 inert 子树不参与命中测试,
         *    所以这一条真正守住的是「看不见的那一层连指针都摸不到」。两条都要。
         */
        const onTop = floatBox
          ? await page.evaluate((pt) => {
            const el = document.elementFromPoint(pt.x, pt.y)
            const layer = document.querySelector('[data-testid="full-layer"]')
            const win = document.querySelector('[data-float-body]')?.closest('section') ?? null
            const zOf = (node) => {
              const raw = node ? getComputedStyle(node).zIndex : 'auto'
              const n = Number.parseInt(raw, 10)
              return Number.isFinite(n) ? n : null
            }
            return {
              inLayer: Boolean(layer && el instanceof Node && layer.contains(el)),
              who: el?.getAttribute?.('data-testid')
                ?? el?.closest?.('[data-testid]')?.getAttribute('data-testid')
                ?? el?.tagName
                ?? null,
              fullZ: zOf(layer),
              floatZ: zOf(win),
            }
          }, floatBox)
          : null

        assert(inFull.layer, '① ⌘⇧↩ 把全屏层开出来了')
        assert(inFull.focusInLayer, '① 键盘进了全屏层(§3.5 规则 2)')
        assert(
          inFull.tabInSlot && inFull.bodyEmpty === true,
          '② 那一格内容搬进了 [data-full-slot],叶自己的身子留空',
          `(在 slot 里:${inFull.tabInSlot} / 身子空了:${inFull.bodyEmpty})`,
        )
        assert(
          inFull.leaves >= 1 && inFull.inertLeaves === inFull.leaves - 1,
          '③ 其余的叶 inert,装着它的那一片留活口(非 inert 的恰好一片)',
          `(${inFull.inertLeaves}/${inFull.leaves} 片 inert)`,
        )
        assert(
          inFull.shelvesInert,
          '③ 架子也 inert(键盘不会漏进看不见的面)',
          `(在场 ${inFull.shelfCount} 条)`,
        )
        if (!onTop) {
          skip('③ 全屏压得过浮窗', floatUp ? '量不到那扇浮窗的矩形' : 'Dock 菜单里没有「浮窗」那一项')
        } else {
          assert(
            onTop.fullZ !== null && onTop.floatZ !== null && onTop.fullZ > onTop.floatZ,
            '③ **它压得过浮窗**:全屏层排出来的 z 严格大于最上面那扇浮窗的 z',
            `(全屏 ${onTop.fullZ ?? '—'} vs 浮窗 ${onTop.floatZ ?? '—'})`,
          )
          assert(
            onTop.inLayer,
            '③ 被盖住的浮窗连指针都摸不到(inert 子树不参与命中测试)',
            `(浮窗正中那一点上是 ${onTop.who ?? '—'})`,
          )
        }
        await assertNoOrphan(page, '进全屏之后')

        // ④ Esc 退出 —— 退层链第一站就是它。
        await page.keyboard.press('Escape')
        await delay(600)
        const back = await page.evaluate((tabId) => {
          const tab = document.querySelector(`[data-pane-tab="${tabId}"]`)
          const centerBody = document.querySelector('[data-pane-region="center"] [data-pane-body]')
          const active = document.activeElement
          return {
            layerGone: !document.querySelector('[data-testid="full-layer"]'),
            backInBody: Boolean(centerBody && tab && centerBody.contains(tab)),
            focusBack: Boolean(tab && active instanceof Node && tab.contains(active)),
            where: active?.getAttribute?.('data-testid') ?? active?.tagName ?? null,
          }
        }, liveTab)
        assert(back.layerGone, '④ Esc 退出全屏')
        assert(back.backInBody, '④ 内容回到原叶那一格身子里(同一个 DOM 节点搬回去)')
        assert(
          back.focusBack,
          '④ 键盘回到原叶原 tab(§3.5 规则 5)',
          `(此刻在 [${back.where ?? '—'}])`,
        )
        await assertNoOrphan(page, '退出全屏之后')

        // 收拾:那扇浮窗是这一步自己开的,退层链再按一下把它收回去。
        if (floatUp) {
          await page.keyboard.press('Escape')
          await delay(400)
        }
      }
    }

    /* ── 场景 4:对话框里开菜单 ──────────────────────────────────────── */
    scenario('对话框里开菜单 → Esc 只关菜单 → 再 Esc 关对话框 → 焦点回触发钮')
    await page.goto(shellUrl('gallery'))
    await waitFor('规格页就位', () =>
      page.evaluate(() =>
        Boolean(
          [...document.querySelectorAll('button')].some(
            (el) => (el.textContent ?? '').trim() === 'open dialog',
          ),
        ),
      ),
    )
    const dialogOpened = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(
        (el) => (el.textContent ?? '').trim() === 'open dialog',
      )
      if (!btn) return false
      btn.focus()
      window.__focusAnchor = btn
      btn.click()
      return true
    })
    assert(dialogOpened, '规格页上找得到「open dialog」触发器')
    await waitFor('对话框在场', () =>
      page.evaluate(() => Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))),
    )
    await assertNoOrphan(page, '开对话框之后')
    // 对话框里今天没有菜单触发器,所以这一格量的是它退化后的那一半:
    // 一下 Esc 只关一层、并且焦点回到开它的那个钮。
    await page.keyboard.press('Escape')
    await delay(300)
    const back = await page.evaluate(() => ({
      closed: !document.querySelector('[role="dialog"][aria-modal="true"]'),
      returned: document.activeElement === window.__focusAnchor,
    }))
    assert(back.closed, 'Esc 关掉对话框')
    assert(back.returned, 'Esc 之后焦点回到开它的那个元素')
    await assertNoOrphan(page, 'Esc 关对话框之后')

    /* ── 场景 5:输入面板 vs 浮窗的 Esc 归属 ─────────────────────────── */
    scenario('焦点在输入面板、旁边**真开着一扇浮窗**时 Esc(§11 拍点 3:按树,输入面板先答)')
    /*
     * ── R3 补的那一格(R2 留账)─────────────────────────────────────────────
     * R2 版这一步只 `clickSelector` 点了一下 files 那块瓦,而那时它的落点是
     * 「面板内」——**按 Esc 前在场的浮层是 0 扇**,于是这个场景量到的其实只有
     * 「Esc 没把焦点从输入框里抢走」,拍点 3 那句「输入面板先答,才轮到 root
     * 收浮窗」一个字都没被验到(留账原话:「门场景 5 未真开浮窗,拍点 3 靠
     * jsdom 用例」)。R3 走菜单把它**真开成一扇浮窗**再问同一下 Esc,于是
     * 这一格量的是两件事,缺一不可:
     *   ① 焦点仍在输入框里(输入面板答了「不是我的」,但没被人把焦点搬走);
     *   ② 那扇浮窗**收掉了**(没人认领 → 一路传到 root 的退层链 → escapeTopmost)。
     * 只有 ① 的话,「树根本没把这一下往外传」也能过;只有 ② 的话,「浮窗那一路
     * 抢先并顺手改了焦点」也能过。
     */
    await page.goto(shellUrl())
    await waitFor('壳回来了', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-input"]'))),
    )
    const floatPrepared = await openAsFromDockMenu(page, 'diff', /浮窗|Float/)
    const floatOpen = await page.evaluate(
      () => document.querySelectorAll('section[role="dialog"]').length,
    )
    if (!floatPrepared || floatOpen === 0) {
      skip(
        '旁边真开着一扇浮窗时按 Esc',
        floatPrepared
          ? '选了「浮窗 / Float」但一扇都没画出来'
          : 'Dock 菜单里没有「浮窗 / Float」那一项',
      )
    } else {
      assert(floatOpen > 0, '前提:真开出了浮窗', `(在场 ${floatOpen} 扇)`)
      /*
       * 焦点摆回输入框。用 `.focus()` 而不是真鼠标点:这一步只是**摆好前提**,
       * 而真机上点输入框会先走一趟 pointerdown 抢根(§4.6),那是另一条路的事。
       * 场景 10 那种「点完之后焦点在哪儿」才必须用真鼠标点。
       */
      await page.evaluate(() => {
        const box = document.querySelector('[data-testid="composer-input"]')
        if (box instanceof HTMLElement) box.focus()
      })
      const ready = await page.evaluate(() => ({
        inComposer: document.activeElement?.getAttribute?.('data-testid') === 'composer-input',
        scope:
          document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
          ?? null,
      }))
      assert(ready.inComposer, '前提:焦点在输入框里', `(作用域 ${ready.scope ?? '—'})`)
      await assertNoOrphan(page, '焦点摆进输入面板之后')

      await page.keyboard.press('Escape')
      await delay(400)
      const afterEsc = await page.evaluate(() => ({
        inComposer: document.activeElement?.getAttribute?.('data-testid') === 'composer-input',
        floatStill: document.querySelectorAll('section[role="dialog"]').length,
      }))
      assert(
        afterEsc.inComposer,
        '① 一下 Esc 之后焦点**仍在输入面板里**(不是被浮窗那一路抢走)',
        `(按 Esc 前在场的浮层 ${floatOpen} 扇,按完还剩 ${afterEsc.floatStill} 扇)`,
      )
      assert(
        afterEsc.floatStill < floatOpen,
        '② 那扇浮窗**收掉了**(输入面板没认领 → 传到 root 的退层链)',
        `(${floatOpen} → ${afterEsc.floatStill} 扇)`,
      )
      await assertNoOrphan(page, '输入面板里按 Esc 之后')
    }
    /*
     * 拍点 3 的**另一半**(「输入面板正在生成时,Esc 归两段停止,浮窗不收」)
     * 这道门量不到,如实记跳过而不是假造一个生成态:要造出「生成中」得有一台
     * 真在流的 provider(gate:chat 那一套假慢流),而那是另一道门的夹具。
     * 在这里塞一个假的 `streaming` 标志 = 门断言的是自己写进去的那格状态,
     * 不是产品的行为 —— 那种绿比红更坏。
     * 今天守着这一半的是 jsdom 用例:`composer/components/Composer.test.tsx`
     * 的 Esc 三分支(拒答 / 关抽屉 / 两段停止)与 `useEscStop`。
     */
    skip(
      '生成中按 Esc:两段停止、浮窗不收(拍点 3 的另一半)',
      '造不出真的生成态 —— 要一台在流的 provider(gate:chat 的夹具);今天由 Composer.test.tsx 的 Esc 三分支守着',
    )

    /* ── 场景 6:I4 整机扫 ───────────────────────────────────────────── */
    scenario('I4:每个 Placement 宿主层的根元素都带 data-focus-scope')
    /*
     * ── 为什么这一格要**把四种形态各摆出来一次**(R1 改)────────────────────
     * R0 版只在跑完最后一步的那一刻扫一次 DOM,于是读到的是「此刻恰好开着什么」——
     * 那时四种形态多半一个都不在场,扫出来永远只有 root,「未接树」与「没开出来」
     * 两件事分不开。宿主层是**按需挂载**的(舞台没开就不渲染),所以 I4 只能这么验:
     * 走用户真走的那条路(Dock 瓦的右键菜单 = 打开方式)把每一种形态开出来,
     * 开出来了再问它的根带不带 `data-focus-scope`。
     * 开不出来(菜单里没有那一项)记**跳过**,不记红 —— 那是夹具没搭起来。
     */
    const scopesNow = () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('[data-focus-scope]')).map((el) =>
          el.getAttribute('data-focus-scope'),
        ),
      )
    assert(
      (await scopesNow()).includes('root'),
      '壳根带 data-focus-scope="root"',
      `(此刻整机 ${[...new Set(await scopesNow())].join(' / ') || '—'})`,
    )

    for (const [key, labelRe] of [
      ['float-layer', /浮窗|Float/],
      ['stage-layer', /弹出|Popup/],
      // W2:「盖」退役,`full-layer` 顶上(菜单那一行也从「盖满」改成「全屏」)。
      ['full-layer', /^(全屏|Full screen)$/],
    ]) {
      const picked = await openAsFromDockMenu(page, 'diff', labelRe)
      if (!picked) {
        skip(`${key} 的根带 data-focus-scope`, `Dock 菜单里没有 ${labelRe} 那一项`)
        continue
      }
      const scopes = await scopesNow()
      assert(scopes.includes(key), `${key} 的根带 data-focus-scope`, `(在场:${[...new Set(scopes)].join(' / ')})`)
      await assertNoOrphan(page, `以 ${key} 打开之后`)
    }

    // shelf-layer 那一格在场景 3 里验(层是按需挂载的,只能在它在场的那一刻问)。
    console.log('  · shelf-layer:见场景 3 最后一条')

    /*
     * 上面那一轮最后停在**全屏**上(W2)。它铺满整扇窗,后面每一条都要先把它退掉
     * —— 不退的话下一步点什么都点在盖住的那一层上。退层链第一站就是它。
     */
    await page.keyboard.press('Escape')
    await delay(400)

    /*
     * **叶**(W1)。它不是 Placement 宿主层,是一格 `region` —— 但它与那四层同样
     * 是「按需挂载 + 带 data-focus-scope」的一格,而且中央区永远至少有一片叶,
     * 所以它**任何时候都该在场**。这一条因此不必先摆什么形态。
     */
    {
      const scopes = await scopesNow()
      assert(
        scopes.includes('leaf'),
        '中央叶的根带 data-focus-scope="leaf"(中央区永远至少一片叶)',
        `(在场:${[...new Set(scopes)].join(' / ')})`,
      )
    }


    /* ── 场景 7:启动第一响应者 ──────────────────────────────────────── */
    scenario('壳一起来,第一响应者就是输入面板(§3.5 规则 1)')
    /*
     * 整页重载一次:这一条问的是**刚起来那一刻**的事实,而前面六个场景已经把
     * 焦点摆到别处去了。重载之后照样要等那一次 RPC 往返(与开场同一条等待)。
     *
     * ── 先把中央区那一格换回**会话**(W5-c-3)────────────────────────────
     * 规则 1 的原话是「应用启动时是主内容,**有会话则是它的输入面板**」——
     * 路线 A 之后输入框是会话叶自己的器官,中央区活动那一格是文件查看器时屏幕上
     * 根本没有一块可交互的输入面板(后台那一格的还挂在 DOM 里,但整层 `inert`,
     * `activateScope` 按设计挑不到它)。而前面几个场景把活动格换成了文件。
     * 所以这里先点回第一格(常驻那一格会话)再重载 —— 补的是**这一条的前提**,
     * 不是放宽它:没有会话在场时「第一响应者是输入面板」本来就不成立。
     */
    await page.evaluate((css) => {
      const first = document.querySelectorAll(css)[0]
      if (first instanceof HTMLElement) first.click()
    }, CENTER_TABS)
    await delay(400)
    await page.goto(shellUrl())
    await waitFor('壳回来了', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-input"]'))),
    )
    await delay(400)
    const boot = await page.evaluate(() => ({
      testid: document.activeElement?.getAttribute?.('data-testid') ?? null,
      scope:
        document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
        ?? null,
      first: window.__focus?.dump?.().path.at(-1) ?? null,
    }))
    assert(
      boot.scope === 'composer',
      '第一响应者 = 输入面板',
      `(焦点此刻在 [${boot.testid ?? '—'}],作用域 ${boot.scope ?? '—'};树说 ${boot.first ?? '—'})`,
    )
    await assertNoOrphan(page, '壳刚起来')

    /* ── 场景 8:Expose 进会话 → 焦点在输入框 ────────────────────────── */
    scenario('总览里进一条会话 → 焦点落在那条会话的输入框里(§3.5 规则 2)')
    /*
     * 「把行摆上屏」与「点那一行」是两件事,这里只能借前者:这一格要自己断言
     * 点完之后焦点去哪,整段借 `enterGateSession` 就把被测的那一下也吞进去了。
     * 摆上屏那一半为什么要重试,写在 `ensureOverviewRow` 的注释里(点瓦是开关)。
     */
    await ensureOverviewRow(page, sessionId)
    await assertNoOrphan(page, '开总览之后')
    await clickSelector(page, `[data-testid="session-row-${sessionId}"]`)
    await delay(500)
    const entered = await page.evaluate(() => ({
      testid: document.activeElement?.getAttribute?.('data-testid') ?? null,
      scope:
        document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
        ?? null,
    }))
    assert(
      entered.scope === 'composer',
      '进会话之后焦点在输入面板里',
      `(焦点此刻在 [${entered.testid ?? '—'}],作用域 ${entered.scope ?? '—'})`,
    )
    await assertNoOrphan(page, '进会话之后')

    /* ── 场景 8b:总览的键盘交接(搜索条 ↓ 交给树,树 ↵ 进会话)────────── */
    scenario('总览:搜索条 ↓ 把键盘交给树(活动行由 aria-activedescendant 指着),树上 ↵ 进会话')
    /*
     * 这一格钉的是设计 §3.2 那张键表最要紧的两行,以及 §3.1 那条形:
     * 树是**一个 Tab 位**(`role="tree" tabIndex=0`),469 条会话不是 469 个 Tab 位,
     * 活动行由 `aria-activedescendant` 指着而不是靠 `.focus()` 一行一行搬。
     * 所以「键盘交出去了没有」的判据必须是**两条一起**:焦点在树容器上 **且**
     * activedescendant 真的指着一个在场的 `#expose-row-<id>` —— 只看第一条的话,
     * 一棵没有活动行的树也会绿(而那正是键盘走不动的样子)。
     */
    await ensureOverviewRow(page, sessionId)
    await assertNoOrphan(page, '开总览之后(键盘交接)')
    /*
     * 先把焦点摆进搜索条。**这一格不断言「摆出来那一刻焦点就在搜索条」** ——
     * 上一个场景刚进过一条会话,按规则 2 焦点此刻正在 composer 里,而总览这块面
     * 一直开着(`ensureOverviewRow` 看见行在屏上就不会再点一次瓦,点瓦是开关)。
     * 「摆出来那一刻落在搜索条」是 `restingTarget` 第一档的事,由 Overview.test
     * 那组落点用例守着;这里要量的是**交接**,所以它自己把起点摆好。
     *
     * 用 Playwright 的真点击(底下是 CDP `Input.dispatchMouseEvent`),不用页面里
     * 那只 `el.click()`:合成 click 不落焦,输入框上尤其不落 —— 那样量的就是
     * 「焦点本来在哪」而不是「↓ 把它交给了谁」。
     */
    /*
     * ── 09-12:搜索**静息时是一行字**,点它才换成输入框(方向 A 拍板 1)────────
     * 所以摆起点这一步多了一下:先点那一行(`expose-search-row`),输入框才存在;
     * 点开那一拍焦点由作用域的落点第二档送进去(判词在 ExposeView 的
     * `restingTarget` 上),于是下面那句断言量的仍旧是「焦点在输入框里」。
     */
    await page.click('[data-testid="expose-search-row"]')
    await delay(250)
    const onSearch = await page.evaluate(() =>
      Boolean(document.activeElement?.hasAttribute?.('data-expose-search')),
    )
    assert(onSearch, '点一下搜索那一行 → 输入框在场且焦点落在它身上(交接的起点摆好了)')
    await page.keyboard.press('ArrowDown')
    await delay(300)
    const handed = await page.evaluate(() => {
      const el = document.activeElement
      const active = el?.getAttribute?.('aria-activedescendant') ?? null
      return {
        testid: el?.getAttribute?.('data-testid') ?? null,
        active,
        // activedescendant 指的那一行**真的在 DOM 里**吗(指着空气 = 键盘走不动)。
        present: Boolean(active && document.getElementById(active)),
        rowTestid: active
          ? (document.getElementById(active)?.getAttribute('data-testid') ?? null)
          : null,
      }
    })
    assert(
      handed.testid === 'expose-tree',
      '↓ 把焦点交给了树容器(这块面唯一那个 Tab 位)',
      `(焦点此刻在 [${handed.testid ?? '—'}])`,
    )
    assert(
      handed.present,
      'aria-activedescendant 指着一个在场的行',
      `(指着 ${handed.active ?? '—'},那一行是 [${handed.rowTestid ?? '—'}])`,
    )
    await assertNoOrphan(page, '键盘交给树之后')
    await page.keyboard.press('Enter')
    await delay(500)
    const enteredByKey = await page.evaluate(() => ({
      testid: document.activeElement?.getAttribute?.('data-testid') ?? null,
      scope:
        document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
        ?? null,
    }))
    assert(
      enteredByKey.scope === 'composer',
      '树上 ↵ 进会话之后焦点在输入面板里(与点行那条路同一个落点)',
      `(焦点此刻在 [${enteredByKey.testid ?? '—'}],作用域 ${enteredByKey.scope ?? '—'})`,
    )
    await assertNoOrphan(page, '树上 ↵ 进会话之后')

    /* ── 场景 9:拼舞台 → 钉右边 → 撕浮窗,每步焦点跟着那块面 ────────── */
    scenario('形态变化三步:拼舞台 → 钉右边 → 撕成浮窗,每步之后焦点都在那块面里(§3.5 规则 3)')
    /**
     * 焦点此刻落在哪一层里 —— 按**宿主层的根**问(`data-focus-scope` 的四种 layer),
     * 而不是问最内层那一格:规则 3 说的是「跟着那块面走」,那块面装在哪一层里
     * 才是这一条要量的东西。
     */
    const layerNow = () =>
      page.evaluate(() => {
        const el = document.activeElement
        const layer = el?.closest?.(
          '[data-focus-scope="stage-layer"],[data-focus-scope="float-layer"],'
            + '[data-focus-scope="shelf-layer"],[data-focus-scope="full-layer"]',
        )
        /*
         * W4:装着这块面的那一格 tab 层在**层根里面**(shelf-layer → leaf → tab 层),
         * 所以要从**焦点元素**往上找,不是从层根往下找。
         */
        const tab = el?.closest?.('[data-pane-tab]')?.getAttribute('data-pane-tab') ?? null
        return {
          layer: layer?.getAttribute('data-focus-scope') ?? null,
          panel: tab?.startsWith('panel:') ? tab.slice('panel:'.length) : tab,
          scope: el?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
        }
      })
    /*
     * ── 先把它**开出来**,再量挪动 ──────────────────────────────────────────
     * 「从 Dock 开一块面」与「把一块开着的面挪个地方」是两件事,规则也不同:
     * 前者(dock → 任何形态)焦点**不跟**(指针点瓦之后焦点留在瓦上,是今天的
     * 行为),后者才是规则 3 说的「焦点跟着那块面走」。所以这一步只做准备,
     * 不断言 —— 三条读数量的是它开出来**之后**的三次挪动。
     */
    const prepared = await openAsFromDockMenu(page, 'diff', /浮窗|Float/)
    if (!prepared) skip('准备:先把改动面开成浮窗', 'Dock 菜单里没有「浮窗 / Float」那一项')
    // 拼上舞台(菜单那条路 = 用户真走的路)。
    const staged = await openAsFromDockMenu(page, 'diff', /弹出|Popup/)
    if (!staged) {
      skip('拼舞台之后焦点在舞台那一层里', 'Dock 菜单里没有「弹出 / Popup」那一项')
    } else {
      const at = await layerNow()
      assert(at.layer === 'stage-layer', '拼舞台之后焦点在舞台那一层里', `(读数 ${JSON.stringify(at)})`)
      await assertNoOrphan(page, '拼舞台之后')
    }
    const pinned = await openAsFromDockMenu(page, 'diff', /右侧栏|Right/)
    if (!pinned) {
      skip('钉右边之后焦点在那条架子的层里', 'Dock 菜单里没有「右侧栏 / Right」那一项')
    } else {
      const at = await layerNow()
      assert(
        at.layer === 'shelf-layer' && at.panel === 'diff',
        '钉右边之后焦点在**装着这块面**的那一层里',
        `(读数 ${JSON.stringify(at)})`,
      )
      await assertNoOrphan(page, '钉右边之后')
    }
    const floated = await openAsFromDockMenu(page, 'diff', /浮窗|Float/)
    if (!floated) {
      skip('撕成浮窗之后焦点在那扇窗里', 'Dock 菜单里没有「浮窗 / Float」那一项')
    } else {
      const at = await layerNow()
      assert(at.layer === 'float-layer', '撕成浮窗之后焦点在那扇窗里', `(读数 ${JSON.stringify(at)})`)
      await assertNoOrphan(page, '撕成浮窗之后')
    }

    /* ── 场景 10:树行单击不抢焦点,↵ 抢 ─────────────────────────────── */
    scenario('文件树:单击开文件但焦点留树,↵ 开文件并把焦点送进查看器(§11 拍点 1)')
    /*
     * ── 步①为什么**必须**用一块自己不入焦的面(09-04 S2 改)──────────────────
     * 这一步从前按检索面那个键量,而 `SearchPanel` 自己声明了 `activateOnMount`
     * (那个键敲出来就打字是它的产品语义)—— 于是**就算召唤那条路一句焦点都不送,
     * 这一步照样绿**:它把「键盘开面 → 焦点跟过去」(§3.5 规则 2)整条盖住了。
     * R2 派工时踩过同款(那次改用文件树才量出真读数),S2 用户报「触发一块面之后
     * 焦点还在输入框里」时,这道门也是一声不吭。
     *
     * 所以①改用**工作区**那块面:它既没有 `activateOnMount`,`focus/scopes.ts` 里
     * 也没有它自己的 region —— 焦点能进去,只可能是召唤那条路(点名
     * `requestFocusOnOpen` → `focus-follow` 在提交之后 `activateScope`)送进去的。
     * 判据因此是「焦点落在**装着工作区总览的那一层**里」,而不是某个 scope id
     * (它没有自己的 scope)。**这一步禁止换回任何自入焦的面**。
     *
     * 出厂键位表里只有检索(K2 起是 ⌘⇧F)与总览(⌘E)有键,所以这里先给
     * `toggle:workspace` 种一个 ⌘⇧U(全表未占用),再整页重载让键位 store 吃进去。
     */
    await page.evaluate(() => {
      localStorage.setItem(
        'onething.keymap',
        JSON.stringify({
          state: {
            overrides: {
              'toggle:workspace': { meta: true, shift: true, key: 'u' },
              // ①-c 那一步要按它:那一步要一块**有「打开方式」菜单**的普通瓦。
              // W6-a 之前是 files;「目录」那块瓦改成启动瓦之后它的右键是最近目录表,
              // 所以这一步换成「改动」(diff)——判据一个字没变:记忆 → 召唤第一下按记忆开。
              'toggle:diff': { meta: true, shift: true, key: 'k' },
            },
          },
          version: 2,
        }),
      )
    })
    await page.goto(shellUrl())
    await waitFor('壳回来了', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-input"]'))),
    )
    await enterGateSession(page, sessionId)
    /*
     * 前面几个场景把 files 那块瓦挪去了别的形态,而落点是**记忆**(存 localStorage,
     * 重载之后还在)—— 所以这里不能想当然地点一下瓦就以为树会出来:那一下多半是
     * 「收回去」。走菜单点名回「面板内 / Dock」那一档,状态从此确定。
     */
    if (!(await hasFileRow(page))) {
      await clickSelector(page, '[data-testid="dock-tile-files"]')
      await delay(500)
    }
    await waitFor('文件树画出一行**文件**', () => hasFileRow(page))
    const rowSelector = '[data-testid="files-tree"] [data-file-path][data-file-type="file"]'
    /*
     * 这一条**必须用真的鼠标点**(playwright 的 click → CDP `Input.dispatchMouseEvent`,
     * 只进目标窗口、不动真光标)。别处那只 `clickSelector` 走的是页面里的
     * `el.click()` —— 它派的是一个合成事件,**不落焦**;而这一条量的正是
     * 「点完之后焦点在哪儿」,拿合成点击去量等于量了个寂寞(第一版就栽在这儿:
     * 读数说焦点还在输入面板里,而那是探针自己没落焦)。
     */
    await page.click(rowSelector)
    await delay(600)
    const afterClick = await page.evaluate((css) => {
      const row = document.querySelector(css)
      return {
        opened: Boolean(document.querySelector('[data-testid="file-viewer"]')),
        onRow: document.activeElement === row,
        scope:
          document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
          ?? null,
      }
    }, rowSelector)
    assert(afterClick.opened, '单击开出了查看器')
    assert(
      afterClick.scope === 'files',
      '单击之后焦点**留在树这块面里**(拍点 1 的 (a) 档)',
      `(在行上:${afterClick.onRow};作用域 ${afterClick.scope ?? '—'})`,
    )
    await assertNoOrphan(page, '单击开文件之后')

    // ↵:先把焦点摆回那一行(真机上单击本来就落在它身上),再按。
    await page.evaluate((css) => {
      const row = document.querySelector(css)
      if (row instanceof HTMLElement) row.focus()
    }, rowSelector)
    await page.keyboard.press('Enter')
    await delay(600)
    const afterEnter = await page.evaluate(() => ({
      scope:
        document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
        ?? null,
      inViewer: Boolean(document.activeElement?.closest?.('[data-testid="file-viewer"]')),
    }))
    assert(
      afterEnter.inViewer,
      '↵ 之后焦点**进了查看器**',
      `(作用域 ${afterEnter.scope ?? '—'})`,
    )
    await assertNoOrphan(page, '↵ 开文件之后')

    /* ── 场景 11:多实例 —— 同一片叶里两份查看器各开一次 ⌘F(W1 改)──── */
    /*
     * **这一条的夹具换了,验的事没换。** W1 之前查看器是 Dock 上一块瓦,
     * 「多实例」只能靠把那一块瓦摆去两种形态来演(浮窗一份、架子一份);
     * W1 之后它是一种**内容**,一个文件一份实例 —— 于是「多实例」是它的常态:
     * 同一片叶里开两个文件就是两份。验的仍然是那一句:
     * **⌘F 落在活动的那一份上**,而且切一次 tab 之后落在另一份上。
     */
    scenario('⌘F 在同一片叶里的**两份**查看器上各开一次(多实例)')
    {
      const rowsCss = '[data-testid="files-tree"] [data-file-path][data-file-type="file"]'
      const openByEnter = async (name) => {
        const hit = await page.evaluate(
          ({ css, want }) => {
            const row = Array.from(document.querySelectorAll(css)).find((el) =>
              (el.getAttribute('data-file-path') ?? '').endsWith(want),
            )
            if (!(row instanceof HTMLElement)) return false
            row.focus()
            return true
          },
          { css: rowsCss, want: name },
        )
        if (!hit) return false
        await page.keyboard.press('Enter')
        await delay(700)
        return true
      }
      const openedA = await openByEnter('/a.ts')
      const openedB = await openByEnter('/b.ts')
      const tabs = await page.evaluate((css) => document.querySelectorAll(css).length, CENTER_TABS)
      if (!openedA || !openedB || tabs < 3) {
        skip('⌘F 在两份查看器上各开一次', `夹具没搭起来(顶栏那一组 ${tabs} 格 tab)`)
      } else {
        const findOpens = async (where) => {
          // 焦点摆进**活着的**那一份查看器(非活动那一层是 inert 的,进不去)。
          await page.evaluate(() => {
            const center = document.querySelector('[data-pane-region="center"]')
            const live = Array.from(center?.querySelectorAll('[data-pane-tab]') ?? []).find(
              (l) => !l.hasAttribute('inert'),
            )
            const viewer = live?.querySelector('[data-focus-scope="viewer"]')
            if (viewer instanceof HTMLElement) viewer.focus()
          })
          await page.keyboard.press('Meta+f')
          await delay(300)
          const opened = await page.evaluate(() =>
            Boolean(document.querySelector('[data-testid="viewer-jump-bar"]')),
          )
          assert(opened, `⌘F 在${where}那一份查看器上开得出检索条`)
          if (opened) {
            await page.keyboard.press('Escape')
            await delay(250)
            await assertNoOrphan(page, `${where}:Esc 关掉检索条之后`)
          }
        }
        const liveNow = () =>
          page.evaluate(
            () =>
              Array.from(
                document.querySelector('[data-pane-region="center"]')?.querySelectorAll('[data-pane-tab]') ?? [],
              )
                .find((l) => !l.hasAttribute('inert'))
                ?.getAttribute('data-pane-tab') ?? null,
          )
        const firstLive = await liveNow()
        await findOpens('活动的')
        // 切到另一格 —— 那是**另一份实例**(它有自己的滚动位、草稿、检索条)。
        await page.evaluate((css) => {
          // 中央区那一组标签在**顶栏**上(W1-b),而架子的叶檐也画 `data-pane-chrome`
          // (W4)—— 所以这一下必须从顶栏那条带子里取,判词在 `CENTER_TABS` 上。
          const tabRow = Array.from(document.querySelectorAll(css))
          const off = tabRow.find(
            (t) => t.getAttribute('aria-selected') !== 'true' && /\.ts$/.test(t.textContent ?? ''),
          )
          if (off instanceof HTMLElement) off.click()
        }, CENTER_TABS)
        await delay(500)
        const secondLive = await liveNow()
        assert(
          firstLive !== null && secondLive !== null && firstLive !== secondLive,
          '切一次 tab 之后活着的是**另一份**实例',
          `(${firstLive ?? '—'} → ${secondLive ?? '—'})`,
        )
        await findOpens('切过去那')
      }
    }

    /* ── 场景 12:⌘⇧F → Esc → 回到开它之前那个输入框(returnTo)────────── */
    scenario('⌘⇧F → Esc → 焦点回到**开它之前那个元素**(§4.5 的 returnTo)')
    await page.goto(shellUrl())
    await waitFor('壳回来了', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-input"]'))),
    )
    await enterGateSession(page, sessionId)
    await page.evaluate(() => {
      const box = document.querySelector('[data-testid="composer-input"]')
      if (box instanceof HTMLElement) box.focus()
    })
    const beforePalette = await page.evaluate(
      () => document.activeElement?.getAttribute?.('data-testid') ?? null,
    )
    assert(beforePalette === 'composer-input', '开检索面之前焦点在输入框里(前提)')
    await page.keyboard.press('Meta+Shift+f')
    await delay(400)
    assert(
      await page.evaluate(() =>
        Boolean(document.querySelector('[data-testid="search-panel"], [data-pane-tab="panel:search"]')),
      ),
      '⌘⇧F 把检索面开出来了',
    )
    await assertNoOrphan(page, '⌘⇧F 开面之后')
    await page.keyboard.press('Escape')
    await delay(500)
    const backTo = await page.evaluate(() => ({
      testid: document.activeElement?.getAttribute?.('data-testid') ?? null,
      scope:
        document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
        ?? null,
    }))
    assert(
      backTo.testid === 'composer-input',
      '**焦点回到了开它之前那个输入框**(兄弟之间的归还)',
      `(此刻在 [${backTo.testid ?? '—'}],作用域 ${backTo.scope ?? '—'})`,
    )
    await assertNoOrphan(page, 'Esc 收检索面之后')


    /* ── 场景 13:召唤三态(S1,设计 §14)────────────────────────────────── */
    scenario('召唤三态:Dock 开 → 只聚焦 → 隐藏(浮窗形)→ 架子上露出来 → 隐藏(钉边形)(S1/S1b,§14)')
    /*
     * ── 为什么这一格要读「落点」,而且是从**落盘的那份**读 ────────────────────
     * 召唤与旧那条纯开关(`toggleItem`,已随 S2/09-04 删)的分歧只有一句:
     * **它永远不改形态**(除了第一态「开出来」)。所以后三态每一步的判据都是同一
     * 句话 —— 「这一下之后落点一个字节都没变」。DOM 上看不出这件事(一块面被关掉
     * 与被藏起来在 DOM 上都是「不在了」),而 store 没有挂在 window 上,所以读它
     * 落盘的那份:zustand persist 每一次状态写入都同步落一次盘。
     *
     * ── W4:落点搬家了,这几只探针跟着搬 ──────────────────────────────────
     * 「一块瓦在哪儿」从 W4 起住在**拼贴树**里(`onething.workbench` 的
     * `byWorkspace[*].regions`);`onething.stage` 那份档案里只剩几何(架子厚度 /
     * 收起态 / 浮窗矩形 / 位置记忆)。判词全文在 `src/stage/residency.ts` 文件头。
     *
     * 所以探针分成两半,各读各的账:
     *  · **落点**(`placementsRaw` / `placementsSig`)从树上折出来 —— 折法与产品
     *    里那只投影逐字同型(`edge:<side>` → `{kind:'edge',side}`,`float:*` →
     *    `{kind:'float'}`,只认 `panel:` 那些 tab);
     *  · **架子几何**(`shelvesRaw` 的 `collapsed`)读 stage 那份;
     *    **活动 tab**(`activeId`)从树上读(它是住处,不是几何)。
     *
     * 两处都走一遍**整本账**(每个工作区一格),不去猜当前空间那个 id 是什么 ——
     * 空间 id 是别处的事实,拿到这道门里来判等于把两件事拴在一起。
     */
    const readWorkbenchRegions = () =>
      page.evaluate(() => {
        const raw = localStorage.getItem('onething.workbench')
        if (!raw) return []
        const found = []
        const walk = (value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return
          if (value.regions && typeof value.regions === 'object') found.push(value.regions)
          for (const key of Object.keys(value)) walk(value[key])
        }
        try {
          walk(JSON.parse(raw))
        } catch {
          return []
        }
        return found
      })

    /** 一棵树上按阅读序的那些瓦 id(叶内次序原样)。 */
    const panelsOfTree = (node, out = []) => {
      if (!node || typeof node !== 'object') return out
      if (node.kind === 'leaf') {
        for (const tab of node.tabs ?? []) if (tab?.kind === 'panel') out.push(tab.key)
        return out
      }
      panelsOfTree(node.a, out)
      panelsOfTree(node.b, out)
      return out
    }

    /** 一棵树上此刻显形的那些瓦(每片叶各一格活动 tab)。 */
    const visibleOfTree = (node, out = []) => {
      if (!node || typeof node !== 'object') return out
      if (node.kind === 'leaf') {
        const active = (node.tabs ?? [])[node.active ?? 0]
        if (active?.kind === 'panel') out.push(active.key)
        return out
      }
      visibleOfTree(node.a, out)
      visibleOfTree(node.b, out)
      return out
    }

    /** 一格 regions → 一张 `{瓦 id: 落点}`(与产品里那只投影同一个折法)。 */
    const placementsOfRegions = (regions) => {
      const table = {}
      for (const [region, tree] of Object.entries(regions)) {
        const placement = region.startsWith('edge:')
          ? { kind: 'edge', side: region.slice('edge:'.length) }
          : region.startsWith('float:')
            ? { kind: 'float' }
            : null
        if (!placement) continue
        for (const id of panelsOfTree(tree)) table[id] = placement
      }
      return table
    }

    const placementsRaw = async () =>
      (await readWorkbenchRegions()).map((regions) => placementsOfRegions(regions))

    const placementsSig = async () =>
      (await placementsRaw()).map((table) => JSON.stringify(table)).sort().join('||')

    /**
     * 架子那一格读数:**几何读 stage 的账,活动 tab 读树**(W4 起两半各有各的家)。
     * 交回的形状与 W4 之前逐字相同(`{ left|right|top|bottom: {collapsed, activeId} }`),
     * 所以下面那些断言一个字都不用改。
     */
    const shelvesRaw = async () => {
      const geometry = await page.evaluate(() => {
        const raw = localStorage.getItem('onething.stage')
        if (!raw) return []
        const found = []
        const walk = (value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return
          if (value.shelves && typeof value.shelves === 'object') found.push(value.shelves)
          for (const key of Object.keys(value)) walk(value[key])
        }
        try {
          walk(JSON.parse(raw))
        } catch {
          return []
        }
        return found
      })
      const trees = await readWorkbenchRegions()
      const out = []
      for (let at = 0; at < Math.max(geometry.length, trees.length); at += 1) {
        const shelves = geometry[at] ?? {}
        const regions = trees[at] ?? {}
        const merged = {}
        for (const side of ['left', 'right', 'top', 'bottom']) {
          const tree = regions[`edge:${side}`]
          merged[side] = {
            ...(shelves[side] ?? {}),
            tabs: tree ? panelsOfTree(tree) : [],
            activeId: tree ? (visibleOfTree(tree)[0] ?? null) : null,
          }
        }
        out.push(merged)
      }
      return out
    }
    /** 焦点此刻落在哪一格作用域 / 哪一块面里。 */
    const focusNow = () =>
      page.evaluate(() => {
        const el = document.activeElement
        return {
          testid: el?.getAttribute?.('data-testid') ?? null,
          scope: el?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
          panel: (() => {
            const tab = el?.closest?.('[data-pane-tab]')?.getAttribute('data-pane-tab') ?? null
            return tab?.startsWith('panel:') ? tab.slice('panel:'.length) : tab
          })(),
        }
      })
    const searchOnScreen = () =>
      page.evaluate(() =>
        Boolean(document.querySelector('[data-testid="search-panel"], [data-pane-tab="panel:search"]')),
      )

    await page.goto(shellUrl())
    await waitFor('壳回来了', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-input"]'))),
    )
    await enterGateSession(page, sessionId)
    // 前面几个场景可能留下浮窗 / 盖 / 舞台。Esc 逐层退到干净(架子按设计不在链里)。
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press('Escape')
      await delay(150)
    }
    await page.evaluate(() => {
      const box = document.querySelector('[data-testid="composer-input"]')
      if (box instanceof HTMLElement) box.focus()
    })

    /* ①-a 未打开 → 开出来 + 焦点进那块面。**用一块自己不入焦的面**(见上面那段)。 */
    const workspaceOnScreen = () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="workspace-overview"]')))
    if (await workspaceOnScreen()) {
      skip('①-a Dock 里 → 召唤把工作区开出来并把焦点送进去', '工作区面此刻还在场(Esc 没退干净)')
    } else {
      await page.keyboard.press('Meta+Shift+u')
      await delay(600)
      assert(await workspaceOnScreen(), '①-a 召唤把工作区面开出来了')
      const landed = await page.evaluate(() => {
        const el = document.activeElement
        const layer = el?.closest?.('[data-focus-scope$="-layer"]') ?? null
        return {
          testid: el?.getAttribute?.('data-testid') ?? el?.tagName ?? null,
          scope: el?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
          inWorkspacePane: Boolean(layer?.querySelector('[data-testid="workspace-overview"]')),
        }
      })
      /*
       * 两条一起量,缺一条这一步就又变成盖住病的那种绿:
       *  · 焦点**进了装着工作区总览的那一层**(这块面没有自己的 region,所以判的是层);
       *  · 焦点**离开了输入框** —— 用户 09-04 报的正是这一句(「触发一块面,焦点
       *    为什么还在 inputbox」)。
       */
      assert(
        landed.inWorkspacePane,
        '①-a 开出来之后焦点进了装着这块面的那一层(它自己没有 activateOnMount,也没有 region)',
        `(此刻在 [${landed.testid ?? '—'}],作用域 ${landed.scope ?? '—'})`,
      )
      assert(
        landed.testid !== 'composer-input',
        '①-a 焦点离开了输入框(§3.5 规则 2:键盘开面,焦点进那块面)',
        `(此刻在 [${landed.testid ?? '—'}])`,
      )
      await assertNoOrphan(page, '①-a 召唤开面之后')
      /*
       * **第二下必须是「隐藏」,不是「只聚焦」**(09-04 用户报障的判据)。
       * 用户数的那三下是「出现 / 没反应 / 隐藏」——「没反应」正是第一下焦点没跟
       * 进去、第二下补聚焦(这些面没有 region,焦点落在层根上不画环,所以无声)。
       * 所以这一步只加两条读数就把那条病钉死了:第二下面**不在场**,第三下又
       * 回来并且焦点仍然进得去。
       */
      await page.keyboard.press('Meta+Shift+u')
      await delay(700)
      assert(
        !(await workspaceOnScreen()),
        '①-a 第二下 = **隐藏**(焦点已经在面里;不是「补一次聚焦」)',
      )
      await page.keyboard.press('Meta+Shift+u')
      await delay(700)
      assert(await workspaceOnScreen(), '①-a 第三下把它召唤回来了')
      const again = await page.evaluate(() => {
        const el = document.activeElement
        const layer = el?.closest?.('[data-focus-scope$="-layer"]') ?? null
        return {
          testid: el?.getAttribute?.('data-testid') ?? el?.tagName ?? null,
          inWorkspacePane: Boolean(layer?.querySelector('[data-testid="workspace-overview"]')),
        }
      })
      assert(
        again.inWorkspacePane && again.testid !== 'composer-input',
        '①-a 第三下焦点同样进了那一层(不是「开了但焦点留在输入框」)',
        `(此刻在 [${again.testid ?? '—'}])`,
      )
      await assertNoOrphan(page, '①-a 三连按之后')
      // 收走,别让它挡住后面几步。
      await page.keyboard.press('Meta+Shift+u')
      await delay(600)
    }


    /* ①-b 检索面开出来 —— 后面 ②③④ 都在它身上量,所以这一步只管把它摆上台。 */
    await page.evaluate(() => {
      const box = document.querySelector('[data-testid="composer-input"]')
      if (box instanceof HTMLElement) box.focus()
    })
    if (await searchOnScreen()) {
      skip('①-b Dock 里 → 召唤把检索面开出来', '检索面此刻还在场(Esc 没退干净)')
    } else {
      await page.keyboard.press('Meta+Shift+f')
      await delay(500)
      assert(await searchOnScreen(), '①-b 召唤把检索面开出来了')
      const at = await focusNow()
      /*
       * 这一步的**焦点那一半不是判召唤的读数**:检索面自己声明了 `activateOnMount`
       * (那个键敲出来就打字是它的产品语义),所以就算召唤一句焦点都不送它照样入焦。
       * 留着它是因为设计 §14 的门要这一格产品行为在场;**分辨得出召唤**的是
       * ①-a(自己不入焦的那块面)与下面三步(②③④ 全是「形态一个字节不变」)。
       */
      assert(
        at.scope === 'search',
        '①-b 开出来之后焦点在检索面里(它自己声明了 activateOnMount)',
        `(此刻在 [${at.testid ?? '—'}],作用域 ${at.scope ?? '—'})`,
      )
      await assertNoOrphan(page, '①-b 召唤开面之后')
    }

    /*
     * ③ 看得见、焦点不在它里面 → 只聚焦,形态零变化。
     * **排在 ④ 前面**:09-04 改判之后 ④ 会把面收走,收完就没有「看得见」可言了。
     */
    await page.evaluate(() => {
      const box = document.querySelector('[data-testid="composer-input"]')
      if (box instanceof HTMLElement) box.focus()
    })
    const sigBeforeFocus = await placementsSig()
    await page.keyboard.press('Meta+Shift+f')
    await delay(450)
    /*
     * 两条一起量:焦点**进了装着检索面的那一扇窗**(与场景 10 同一把尺),
     * 而且**落在那块面自己那一格里**而不是停在层的根上 —— 后者是设计 §4.1
     * 那张表 `layer` 行的原话(「进入落点 = 第一个可交互子作用域,否则根」),
     * R2 的实现把它写成了死码(`entryOf` 判的是 `restingTarget` **闭包在不在**,
     * 而 `FocusScope` 给每一格都无条件登记一个),09-04 S1 一并改判成判**返回值**。
     */
    const refocused = await page.evaluate(() => {
      const el = document.activeElement
      const layer = el?.closest?.('[data-focus-scope="float-layer"]') ?? null
      return {
        testid: el?.getAttribute?.('data-testid') ?? null,
        scope: el?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
        inSearchWindow: Boolean(layer?.querySelector('[data-testid="search-panel"]')),
      }
    })
    assert(
      refocused.inSearchWindow && refocused.scope === 'search',
      '③ 焦点在输入框、面看得见 → 召唤**只把键盘送进那扇窗里的那块面**',
      `(此刻在 [${refocused.testid ?? '—'}],作用域 ${refocused.scope ?? '—'})`,
    )
    const sigAfterFocus = await placementsSig()
    assert(
      sigBeforeFocus !== null && sigAfterFocus === sigBeforeFocus,
      '③ placements 一个字节都没变',
      `(前 ${sigBeforeFocus ?? '—'} / 后 ${sigAfterFocus ?? '—'})`,
    )
    await assertNoOrphan(page, '③ 召唤只聚焦之后')

    /*
     * ④-a 看得见、焦点在它里面、而它是一扇**浮窗** → **收回 Dock**
     *     (09-04 用户改判,推翻 09-03 的「回去」)。钉边那一形在下面 ④-b 单量 ——
     *     用户 09-04 裁定收的对象按形态定:架子收整条,浮窗 / 舞台 / 盖收回 Dock。
     *
     * 三条读数:面回了 Dock(账上少的**只有**它这一条)、焦点回到按键之前那个
     * 输入框、I1。中间那条是这一格真正要证的东西 —— `summonItem` 的 `case 'hide'`
     * 一个 `.focus()` 都不发,焦点是**层卸载之后**由树的结构归还(§4.5 的
     * `returnTo` → 父链)自己送回来的。jsdom 量不到它(浮窗要多活一帧走出场动画,
     * 那时作用域还没卸载),所以这一条只有真机门说得清。
     */
    const rawBeforeHide = await placementsRaw()
    await page.keyboard.press('Meta+Shift+f')
    await delay(700)
    const hidden = await focusNow()
    assert(!(await searchOnScreen()), '④-a 浮窗:焦点在面里 → 再按一下**把它收回 Dock**')
    const rawAfterHide = await placementsRaw()
    const diff = (() => {
      if (!rawBeforeHide || !rawAfterHide || rawBeforeHide.length !== rawAfterHide.length) {
        return { ok: false, why: '两次读到的账本格数对不上' }
      }
      const gone = []
      for (let i = 0; i < rawBeforeHide.length; i += 1) {
        const before = rawBeforeHide[i]
        const after = rawAfterHide[i]
        for (const key of Object.keys(before)) {
          if (!(key in after)) {
            gone.push(key)
            continue
          }
          if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
            return { ok: false, why: `「${key}」那条落点变了` }
          }
        }
        for (const key of Object.keys(after)) {
          if (!(key in before)) return { ok: false, why: `凭空多了「${key}」` }
        }
      }
      return { ok: gone.length === 1 && gone[0] === 'search', why: `少掉的是 ${JSON.stringify(gone)}` }
    })()
    assert(diff.ok, '④-a placements 里**少的只有它这一条**,其余逐字节不变', `(${diff.why})`)
    assert(
      hidden.testid === 'composer-input',
      '④-a 焦点回到按键之前那个输入框(**没人手动搬** —— 层卸载后的结构归还)',
      `(此刻在 [${hidden.testid ?? '—'}],作用域 ${hidden.scope ?? '—'})`,
    )
    await assertNoOrphan(page, '④-a 召唤收掉浮窗之后')

    /* ② 钉在架子上、切走了 tab → 露出来 + 焦点进,形态零变化。 */
    const shelved = await openAsFromDockMenu(page, 'search', /右侧栏|Right/)
    if (!shelved) {
      skip('② 架子上切走 tab → 召唤把它露出来并把焦点送进去', 'Dock 菜单里没有「右侧栏 / Right」那一项')
    } else {
      // 把活动 tab 切到别人身上(架子上此刻至少还有前面几个场景钉上去的那几块面)。
      const switched = await page.evaluate(() => {
        const tabs = Array.from(document.querySelectorAll('[data-shelf] [role="tab"]'))
        const off = tabs.find((t) => t.getAttribute('aria-selected') !== 'true')
        if (off instanceof HTMLElement) {
          off.click()
          return { count: tabs.length, ok: true }
        }
        return { count: tabs.length, ok: false }
      })
      await delay(450)
      if (!switched.ok) {
        skip(
          '② 架子上切走 tab → 召唤把它露出来并把焦点送进去',
          `夹具没搭起来 —— 那条架子上只有 ${switched.count} 个 tab,切不走`,
        )
      } else {
        // 焦点摆回输入框(切 tab 那一下会把焦点送进新露脸的那一层)。
        await page.evaluate(() => {
          const box = document.querySelector('[data-testid="composer-input"]')
          if (box instanceof HTMLElement) box.focus()
        })
        const sigBeforeReveal = await placementsSig()
        await page.keyboard.press('Meta+Shift+f')
        await delay(600)
        const revealed = await page.evaluate(() => {
          const layer = document.querySelector('[data-pane-tab="panel:search"]')
          const el = document.activeElement
          return {
            // W4:那一格事实的属性名随树换成了 `data-pane-on`。
            on: layer?.getAttribute('data-pane-on') === 'true' || layer?.hasAttribute('data-pane-on'),
            inert: layer?.hasAttribute('inert') ?? null,
            focusInside: Boolean(layer && el instanceof Node && layer.contains(el)),
            scope: el?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
          }
        })
        assert(revealed.on === true && revealed.inert === false, '② 召唤把那一格 tab 露了出来')
        assert(
          revealed.focusInside,
          '② 露出来之后焦点进了那块面',
          `(作用域 ${revealed.scope ?? '—'})`,
        )
        const sigAfterReveal = await placementsSig()
        assert(
          sigBeforeReveal !== null && sigAfterReveal === sigBeforeReveal,
          '② placements 一个字节都没变(变的是架子的活动 tab,不是落点)',
          `(前 ${sigBeforeReveal ?? '—'} / 后 ${sigAfterReveal ?? '—'})`,
        )
        await assertNoOrphan(page, '② 召唤露出架子上那一格之后')

        /*
         * ④-b 同一格,但它此刻**钉在架子上** → 收的是**整条架子**,不是这块面
         *     (09-04 用户裁定)。上一步刚把焦点送进这块面,所以这一下正落在第四格。
         *
         * 用户否决的那一版是 `closeToDock`:关掉之后架子会露出隔壁那个 tab、焦点
         * 跟着掉到隔壁面上 —— 所以这里三条一起量:架子收了、这块面**仍是活动 tab**、
         * placements 一个字节没变(它没被关掉)。焦点仍然没人手动搬:架子收成细梁
         * 那一刻这一层就不在了,结构归还把键盘送回输入框。
         */
        const sigBeforeCollapse = await placementsSig()
        const shelvesBefore = await shelvesRaw()
        await page.keyboard.press('Meta+Shift+f')
        await delay(700)
        const shelvesAfter = await shelvesRaw()
        const collapsedNow = await page.evaluate(() =>
          Boolean(document.querySelector('[data-shelf]'))
            && document.querySelectorAll('[data-shelf] [role="tab"]').length === 0,
        )
        // 这道门把 search 钉在**右边**(上一步走的就是菜单里那一项),所以直接读那一格。
        const readShelf = (list) =>
          list?.find?.((sh) => (sh.right?.tabs ?? []).includes('search'))?.right ?? null
        const shelfBefore = readShelf(shelvesBefore)
        const shelfAfter = readShelf(shelvesAfter)
        assert(
          shelfBefore?.collapsed === false && shelfAfter?.collapsed === true,
          '④-b 钉边:焦点在面里 → 再按一下**收起整条架子**',
          `(collapsed ${String(shelfBefore?.collapsed)} → ${String(shelfAfter?.collapsed)};DOM 上 tab 条没了:${collapsedNow})`,
        )
        assert(
          shelfAfter?.activeId === 'search' && shelfBefore?.activeId === 'search',
          '④-b **这块面仍是那条架子的活动 tab**(隔壁 tab 没被顶上来)',
          `(activeId ${shelfBefore?.activeId ?? '—'} → ${shelfAfter?.activeId ?? '—'})`,
        )
        const sigAfterCollapse = await placementsSig()
        assert(
          sigBeforeCollapse !== null && sigAfterCollapse === sigBeforeCollapse,
          '④-b placements 一个字节都没变(收的是架子,这块面没被关掉)',
          `(前 ${sigBeforeCollapse ?? '—'} / 后 ${sigAfterCollapse ?? '—'})`,
        )
        const backAfterCollapse = await focusNow()
        assert(
          backAfterCollapse.testid === 'composer-input',
          '④-b 焦点回到按键之前那个输入框(**没人手动搬** —— 架子收起即结构变化)',
          `(此刻在 [${backAfterCollapse.testid ?? '—'}],作用域 ${backAfterCollapse.scope ?? '—'})`,
        )
        await assertNoOrphan(page, '④-b 召唤收起架子之后')
      }
    }

    /*
     * ── ①-c 为什么排在**最后** ────────────────────────────────────────────
     * 它的拆台是栏头那颗 X(`closeShelf`:整条一起收回 Dock,记忆原样留着 ——
     * 「只关这一格」这个口不存在)。而上面 ② / ④-b 要那条右架子上**有两个 tab**
     * 才切得走,所以这一步一旦排在它们前面,就会把它们的夹具一起收掉
     * (09-04 施工时真踩过:② 与 ④-b 当场变成「那条架子上只有 1 个 tab」的跳过,
     * 断言从 113 掉到 110 —— 门还是绿的,少的那三条读数一声不吭)。
     */
    /*
     * ①-c **位置记忆四形**(09-04 补,起因见下)。
     *
     * ── 这一步补的是门自己的盲区 ──────────────────────────────────────────
     * ①-a 量的是**新 store 的缺省档**(没有记忆 = 浮窗)。而「打开」走的是
     * `resolveOpen` 的三层序(记忆 > item 天生落点 > 全局档),真用户的账上那一格
     * 多半是记忆 —— `openFromMemory` 的四条支路(舞台 / 浮窗 / 盖 / 钉边)在这道门
     * 里一条都没被走过。09-04 用户报障时第一反应就是「会不会是记忆那条路上多写了
     * 一次 store」,而门答不上话,因为它只量过缺省档。
     *
     * ── 为什么种在 files 上 ───────────────────────────────────────────────
     * 工作区那块瓦的右键是**快切表**(Dock.tsx 的判词),没有「打开方式」那一排,
     * 所以四种记忆只能种在一块有那张菜单的瓦上。files 还多一样好处:它**有**
     * 自己的 region(`focus/scopes.ts` 里那一行),于是这一步与 ①-a 正好凑成
     * 「有 region / 无 region」两半 —— 前者判到 scope,后者只判到层。
     *
     * ── 「钉边**且架子收着**」那一形不在这里 ──────────────────────────────
     * 它要那条架子上**另有一个 tab**(只剩一个 tab 时收起整条架子与关掉它没法
     * 分辨),而栏头那颗 X 是 `closeShelf`(整条一起收),没有「只关这一格」的口。
     * 造那个夹具要多钉一块面上去、再把活动 tab 切走,而它走的仍是这四条支路里的
     * `edge` 那一条 —— 差别只在 `shelves[side].collapsed`,那一格由 ②(露出来)
     * 与 ④-b(收起整条)两步各量了一遍。09-04 的真机读数也单独走过它。
     */
    const subjectOnScreen = () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="diff-panel"]')))
    /** 把 files 送回 Dock,**不动它的记忆**:架子走栏头那颗 X(closeShelf 自己留记忆),别的形态走退层链。 */
    const subjectBackToDock = async () => {
      for (let i = 0; i < 6 && (await subjectOnScreen()); i += 1) {
        const closedShelf = await page.evaluate(() => {
          const shelf = document.querySelector('[data-shelf]')
          if (!shelf) return false
          const x = Array.from(shelf.querySelectorAll('button[aria-label]')).find((b) =>
            /^(关闭整栏|Close all in)/.test(b.getAttribute('aria-label') ?? ''),
          )
          if (x instanceof HTMLElement) {
            x.click()
            return true
          }
          return false
        })
        if (!closedShelf) await page.keyboard.press('Escape')
        await delay(450)
      }
    }
    const MEMORY_FORMS = [
      { key: 'stage', label: '弹窗(舞台)', menu: /^(Popup|弹窗)$/ },
      { key: 'float', label: '浮窗', menu: /^(Float|浮窗)$/ },
      // W2:「盖满」那一行改成「全屏」——记忆里那一档同步换名(persist v10 迁的就是它)。
      { key: 'full', label: '全屏', menu: /^(Full screen|全屏)$/ },
      { key: 'edge', label: '钉右边', menu: /^(Right|右边)$/ },
      /*
       * **钉左边只在 strict 档量**(09-04 S4)。用户 09-04 报的那一形原话是
       * 「files 记忆钉**左**架子」—— 而 09-04 S3 补的 ①-c 只种了右边。两条边在
       * 产品代码里走的是同一条支路(`edge` 只差一个 `side`),所以缺省档不必多跑
       * 一形(那会动 118 这个基线数);strict 档是**照用户报的那一形**跑的,
       * 左右都要在场。
       */
      ...(STRICT ? [{ key: 'edge-left', label: '钉左边', menu: /^(Left|左边)$/ }] : []),
    ]
    for (const form of MEMORY_FORMS) {
      await subjectBackToDock()
      const seeded = await openAsFromDockMenu(page, 'diff', form.menu)
      if (!seeded) {
        skip(`①-c 记忆=${form.label}`, `Dock 菜单里没有「${form.menu.source}」那一项`)
        continue
      }
      await delay(300)
      await subjectBackToDock()
      if (await subjectOnScreen()) {
        skip(`①-c 记忆=${form.label}`, '这块面送不回 Dock(夹具没搭起来)')
        continue
      }
      await page.evaluate(() => {
        const box = document.querySelector('[data-testid="composer-input"]')
        if (box instanceof HTMLElement) box.focus()
      })
      await delay(150)

      // 第一下:按记忆开出来 + 焦点进去(files 有自己的 region,所以判得到 scope)。
      await page.keyboard.press('Meta+Shift+k')
      await delay(700)
      assert(await subjectOnScreen(), `①-c 记忆=${form.label}:第一下把它开出来了`)
      const landedOnce = await page.evaluate(() => {
        const el = document.activeElement
        const layer = el?.closest?.('[data-focus-scope$="-layer"]') ?? null
        return {
          testid: el?.getAttribute?.('data-testid') ?? el?.tagName ?? null,
          scope: el?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
          inPane: Boolean(layer?.querySelector('[data-testid="diff-panel"]')),
        }
      })
      assert(
        landedOnce.inPane && landedOnce.testid !== 'composer-input',
        `①-c 记忆=${form.label}:第一下焦点就进了那块面(不是留在输入框)`,
        `(此刻在 [${landedOnce.testid ?? '—'}],作用域 ${landedOnce.scope ?? '—'})`,
      )
      await assertNoOrphan(page, `①-c 记忆=${form.label} 开面之后`)

      // 第二下:隐藏(焦点已经在里面)。这一条正是用户数的那三下里「没反应」的位置。
      await page.keyboard.press('Meta+Shift+k')
      await delay(700)
      assert(
        !(await subjectOnScreen()),
        `①-c 记忆=${form.label}:第二下 = **隐藏**(不是补一次聚焦)`,
      )

      // 第三下:再召唤回来,焦点同样进去。
      await page.keyboard.press('Meta+Shift+k')
      await delay(700)
      const landedAgain = await page.evaluate(() => {
        const el = document.activeElement
        const layer = el?.closest?.('[data-focus-scope$="-layer"]') ?? null
        return {
          testid: el?.getAttribute?.('data-testid') ?? el?.tagName ?? null,
          inPane: Boolean(layer?.querySelector('[data-testid="diff-panel"]')),
        }
      })
      assert(
        (await subjectOnScreen()) && landedAgain.inPane && landedAgain.testid !== 'composer-input',
        `①-c 记忆=${form.label}:第三下又出来了,焦点仍然进得去`,
        `(此刻在 [${landedAgain.testid ?? '—'}])`,
      )
      await assertNoOrphan(page, `①-c 记忆=${form.label} 三连按之后`)
    }
    await subjectBackToDock()

    /* ── 场景 15:两条会话同时在中央区(W5-b;W6-a 收成一条标签条)──────────
     *
     * 会话多开之后「当前会话」第一次有了**两个候选**,于是四件事各要一句读数:
     *  ① 两条会话同时在中央区那条标签条上;
     *  ② 点列表 = **只换活动那一格**(另一格一个字不动);
     *  ③ ⌘N = 在活动那一格原位开一条新的(另一格仍旧不动);
     *  ④ ⌘W 关的是活动那一格,而**最后一格会话关不掉**(T0 拍点 2 —— 判据是
     *    「这个区域里同种还剩几个」,会话多开之后它第一次真的被数了)。
     * 收尾再量一次启动回落(composer → chat(焦点叶的)→ root)。
     *
     * **W6-a 改的只有「并排」那两个字的落地形**:中央区收成一条标签条(单叶政策,
     * 设计 `workbench-tabs-2026-09.md` §2.1),所以第二条会话落成**同一条条上
     * 的第二格**而不是第二片叶。上面那四条判据一个字没改 —— 它们问的从来是
     * 「两条会话各说各的、动一格不碰另一格」,而不是「它们住在几片叶里」。
     */
    scenario('两条会话同屏:点列表只换活动那一格;⌘N 落活动格;⌘W 关活动格且最后一格关不掉')
    {
      await page.goto(shellUrl())
      await waitFor('壳回来了', () =>
        page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-input"]'))),
      )
      await enterGateSession(page, sessionId)

      /**
       * 中央区此刻摆着哪几条会话(按阅读序)。
       *
       * W6-a:一格内容一层(`[data-pane-tab]`),而中央区只有一片叶 —— 所以这里
       * 直接数**内容层**,不再按叶分组。判据因此比从前更细:它数的是会话本身,
       * 而不是「装着它们的那几片叶」。
       */
      const centerSessions = () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-pane-region="center"] [data-pane-tab]'))
            .map((el) => el.getAttribute('data-pane-tab') ?? '')
            .filter((id) => id.startsWith('session:')),
        )

      // ① 会话行右键 →「在右侧」= 切一刀,新叶放右边(菜单与拖拽同一只 dropRef)。
      await ensureOverviewRow(page, secondId)
      await page.evaluate((id) => {
        const row = document.querySelector(`[data-testid="session-row-${id}"]`)
        row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 80 }))
      }, secondId)
      await delay(400)
      const openedRight = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
        const right = items.find((el) => /在右侧|Open to the right/.test(el.textContent ?? ''))
        if (right instanceof HTMLElement) right.click()
        return Boolean(right)
      })
      await delay(700)
      if (!openedRight) {
        skip('两条会话同屏', '会话行右键菜单里没有「在右侧 / Open to the right」那一项')
      } else {
        const two = await centerSessions()
        assert(two.length === 2, '中央区此刻摆着两条会话', `tabs=${two.length}`)
        assert(
          await page.evaluate(
            () =>
              document.querySelectorAll('[data-testid="topbar"] [data-topbar-leaf]').length,
          ) === 1,
          '而且它们在**同一条标签条**上(单叶政策)',
        )
        await assertNoOrphan(page, '并排之后')

        // ② 点列表里第三条 = 只换**焦点叶**那一格(另一片一个字不动)。
        const before = await centerSessions()
        await ensureOverviewRow(page, thirdId)
        await clickSelector(page, `[data-testid="session-row-${thirdId}"]`)
        await delay(600)
        const after = await centerSessions()
        assert(after.length === 2, '还是两条(点列表不多开一格)', `tabs=${after.length}`)
        const gone = before.filter((id) => !after.includes(id))
        const fresh = after.filter((id) => !before.includes(id))
        assert(gone.length === 1 && fresh.length === 1, '只有一格换了内容', JSON.stringify({ before, after }))
        assert(fresh[0] === `session:${thirdId}`, '换上去的正是刚点的那一条', fresh[0] ?? '—')

        // ③ ⌘N = 在焦点叶原位开一条新的;另一片仍旧不动。
        const beforeNew = await centerSessions()
        await page.keyboard.press('Meta+n')
        await delay(1200)
        const afterNew = await centerSessions()
        assert(afterNew.length === 2, '⌘N 之后还是两条(不多开一格)', `tabs=${afterNew.length}`)
        const movedByNew = afterNew.filter((id) => !beforeNew.includes(id))
        assert(movedByNew.length === 1, '⌘N 只动了活动那一格', JSON.stringify({ beforeNew, afterNew }))
        await assertNoOrphan(page, '⌘N 之后')

        /*
         * ④ ⌘W 关焦点叶那一格 → 只剩一片;再按一次关不掉(最后一片常驻)。
         *
         * **先把键盘交回那片叶**:⌘N 之后焦点在输入面板上,而输入面板是**叶外面**
         * 的一格作用域(路线 B:composer 留在 `.center`,不在树里)。⌘W 是叶的
         * **面域局部键** —— 活动路径不经过那片叶,它当然轮不到。这不是回归,
         * 正是「局部键需要一个目标」那条三层立法在会话多开之后的第一次显形:
         * 门要按用户真做的那一步走(点回那片会话再按 ⌘W)。
         */
        await page.evaluate(() => {
          /*
           * W6-a:一格内容一层,而**看得见的那一层**才是活动格 —— 后台那几层是
           * `inert`,把焦点扔进去等于扔进一个不可交互的角落。
           */
          const layer = document.querySelector(
            '[data-pane-region="center"] [data-pane-tab][data-pane-on]',
          )
          const stream = layer?.querySelector('[data-testid="chat-stream"]')
          if (stream instanceof HTMLElement) stream.focus()
        })
        await delay(400)
        const armed = await page.evaluate(
          () =>
            document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
            ?? null,
        )
        assert(armed === 'chat', '键盘先回到活动那一格会话里(⌘W 是叶的局部键)', String(armed))
        await page.keyboard.press('Meta+w')
        await delay(700)
        const afterClose = await centerSessions()
        assert(afterClose.length === 1, '⌘W 关掉了活动那一格,只剩一条', `tabs=${afterClose.length}`)
        await page.keyboard.press('Meta+w')
        await delay(700)
        const afterLast = await centerSessions()
        assert(
          afterLast.length === 1 && afterLast[0].startsWith('session:'),
          '最后一格会话**关不掉**(T0 拍点 2)',
          JSON.stringify(afterLast),
        )
        await assertNoOrphan(page, '⌘W 两下之后')
      }

      // 收尾:重载一次,启动回落照旧落在输入面板上(第 ② 级换成带 owner 的 chat)。
      await page.goto(shellUrl())
      await waitFor('壳回来了', () =>
        page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-input"]'))),
      )
      await delay(500)
      const rebooted = await page.evaluate(() => ({
        scope:
          document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
          ?? null,
      }))
      assert(rebooted.scope === 'composer', '重载之后第一响应者仍是输入面板', String(rebooted.scope))
      await assertNoOrphan(page, '并排场景收尾重载之后')
    }

    /* ── 场景 17-19:W7-t 的三条(B3 / B11 / B12)──────────────────────────
     *
     * 三条各自成一个场景(记分板上一条红指得出该修哪一件),共用一份夹具:
     * 中央区那条条上摆着「会话 + a.ts + b.ts」。夹具走用户真走的那条路 ——
     * 落点记忆在场景 3b 里已经改成「主区域」,所以树上 ↵ 开出来的文件就落在中央区。
     *
     *  · **B3**  点会话那一格标签 → 焦点进它的输入面板,而且**直接打字进得去**
     *            (场景 3b 的 ③-a 已经量过落点;这一条多量最后那半句 —— 落点对了
     *            但键盘没真的进去,用户报的病还在);
     *  · **B11** 二合一之后**拆开** → 焦点跟到**左格**(它留在原标签);
     *  · **B12** ⌘W 落在关不掉的那一格上 → **说一句话**(修前是静默的空动作:
     *            真机读数「before 5 / after 5」,人听不出是坏了还是不许)。
     */
    const w7tRowsCss = '[data-testid="files-tree"] [data-file-path][data-file-type="file"]'
    let w7tFixture = null
    {
      await page.goto(shellUrl())
      await waitFor('壳回来了', () =>
        page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-input"]'))),
      )
      await enterGateSession(page, sessionId)
      if (!(await hasFileRow(page))) {
        await clickSelector(page, '[data-testid="dock-tile-files"]')
        await delay(500)
      }
      await ensureFilesInteractive(page)
      // 头两行文件各 ↵ 一次(↵ = 固定 tab;单击是预览,攒不出两格)。
      for (const at of [0, 1]) {
        await page.evaluate(
          ({ css, index }) => {
            const row = document.querySelectorAll(css)[index]
            if (row instanceof HTMLElement) row.focus()
          },
          { css: w7tRowsCss, index: at },
        )
        await page.keyboard.press('Enter')
        await delay(600)
      }
      w7tFixture = await page.evaluate((css) => {
        const tabs = Array.from(document.querySelectorAll(css))
        return {
          tabs: tabs.length,
          labels: tabs.map((t) => (t.textContent ?? '').trim()),
        }
      }, CENTER_TABS)
    }

    /* ── 场景 17:B3 —— 点会话标签,键盘真的进得去输入框 ─────────────────── */
    scenario('点会话那一格标签 → 焦点进输入面板,而且直接打字就进得去(W7-t / B3)')
    if (!w7tFixture || w7tFixture.tabs < 3) {
      skip('B3', `中央区只攒出 ${w7tFixture?.tabs ?? 0} 格 tab —— 夹具没搭起来`)
    } else {
      // 先把键盘扔进别处(消息流那一层),不然「点了才进去」量的是「本来就在那儿」。
      await page.evaluate((css) => {
        const tabs = Array.from(document.querySelectorAll(css))
        const last = tabs[tabs.length - 1]
        if (last instanceof HTMLElement) last.click()
      }, CENTER_TABS)
      await delay(400)
      const before = await page.evaluate(
        () => document.activeElement?.getAttribute?.('data-testid') ?? null,
      )
      assert(before !== 'composer-input', '起手焦点不在输入框里(这一条才量得出「点了才进去」)', String(before))

      // 点第一格 tab —— 那是常驻的会话(`resident` 那一种,seed 出来的第一格)。
      await page.evaluate((css) => {
        const first = document.querySelectorAll(css)[0]
        if (first instanceof HTMLElement) first.click()
      }, CENTER_TABS)
      await delay(500)
      const landed = await page.evaluate(() => ({
        testid: document.activeElement?.getAttribute?.('data-testid') ?? null,
        scope:
          document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
          ?? null,
      }))
      assert(
        landed.testid === 'composer-input' && landed.scope === 'composer',
        '焦点落在输入框本身(不是消息流,也不是叶那格家具)',
        `(落在 ${landed.testid ?? '—'} / 作用域 ${landed.scope ?? '—'})`,
      )
      /*
       * **最后那半句**:落点对了不等于打得进去。这一下走 CDP 的键盘
       * (`keyboard.type` 底下就是 `Input.dispatchKeyEvent`,只进这个窗口),
       * 打完再退格擦掉 —— 这道门不给下一步留下一份脏草稿。
       */
      await page.keyboard.type('焦')
      await delay(200)
      /*
       * 读的是**此刻有焦点的那一块**,不是文档序第一块(W5-c-3)。路线 A 之后
       * 输入框是会话叶的器官 —— 这一场的夹具里中央区攒了三格 tab,于是屏幕上
       * 有好几块 `composer-input`,而 `querySelector` 取的是文档序第一块。上一条
       * 断言刚刚确认了焦点就在一块 `composer-input` 上,所以 `activeElement`
       * 就是那一块,一个字都不用猜。
       */
      const typed = await page.evaluate(
        () => document.activeElement?.textContent ?? '',
      )
      assert(typed.includes('焦'), '直接打字就落进那块可编辑区里', `(读到「${typed}」)`)
      await page.keyboard.press('Backspace')
      await delay(150)
      await assertNoOrphan(page, 'B3 点会话标签之后')
    }

    /* ── 场景 18:B11 —— 拆开之后焦点跟到左格 ───────────────────────────── */
    scenario('二合一之后拆开 → 焦点进**左格**那一格内容(W7-t / B11)')
    if (!w7tFixture || w7tFixture.tabs < 3) {
      skip('B11', `中央区只攒出 ${w7tFixture?.tabs ?? 0} 格 tab —— 夹具没搭起来`)
    } else {
      /*
       * ① 把**第二格**(a.ts)点成活动的,再与**左边**那一格二合一
       *    → 左格 = 第一格,也就是那条**会话**。
       *
       * ── 左格必须是会话,这条门才有分辨力(09-06 审查第三次改)──────────
       * 这一场要量的是产品那一句 `unpairTab` 末尾的 `focusIntoRefAfterCommit(左格)`。
       * 左格是**文件**时它送的落点(那一格 tab 的内容层)与焦点系统自己的孤儿回收
       * 送到的落点是**同一处**,读数一字不差 —— 前两版就是这么绿的。
       *
       * 左格是**会话**时两者当场分岔:产品那一句问的是**种类自述的落焦偏好**
       * (`ContentKind.focusInto: 'composer'`,W7-t / B3),焦点落在**输入面板**上
       * —— 而输入面板在 `.center` 上、根本不在拼贴树里;回收只会把焦点收回活动内容
       * 那一层(树里的容器)。所以「落在 composer-input / 作用域 composer」这一读数
       * **只有产品那一句送得到**,反证(把那一句注释掉重跑)当场红。
       */
      await page.evaluate((css) => {
        const second = document.querySelectorAll(css)[1]
        if (second instanceof HTMLElement) second.click()
      }, CENTER_TABS)
      await delay(400)
      /* W7-c 裁定 2:「分屏」那颗钮删了 —— 这张表的开口是**右键一格标签**。 */
      await page.evaluate((css) => {
        const second = document.querySelectorAll(css)[1]
        if (!(second instanceof HTMLElement)) return
        const box = second.getBoundingClientRect()
        second.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: Math.round(box.left + box.width / 2),
            clientY: Math.round(box.top + box.height / 2),
          }),
        )
      }, CENTER_TABS)
      await delay(400)
      const joined = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
        const left = items.find((el) => /与左边的标签二合一|Join with the tab on the left/.test(el.textContent ?? ''))
        if (!(left instanceof HTMLElement) || (left instanceof HTMLButtonElement && left.disabled)) return false
        left.click()
        return true
      })
      await delay(600)
      const pair = await page.evaluate(() => {
        const left = document.querySelector('[data-pair-side="left"] [data-pair-head]')
        return {
          sides: document.querySelectorAll('[data-pair-side]').length,
          leftId: left?.getAttribute('data-pair-head') ?? null,
        }
      })
      if (!joined || pair.sides !== 2) {
        skip('B11', `二合一没成(菜单可用:${joined} / 屏幕上 ${pair.sides} 格)`)
      } else if (!pair.leftId?.startsWith('session:')) {
        // 夹具没摆成「左格是会话」——这一场就没有分辨力,宁可跳过也不留一条假绿。
        skip('B11', `左格不是会话(读到 ${pair.leftId ?? '—'})—— 夹具没摆成有分辨力的样子`)
      } else {
        assert(Boolean(pair.leftId), '左格说得出自己是谁(格头带着它的 refId)', String(pair.leftId))
        /*
         * ② 先把焦点停在**这两格外面**,再拆。
         *
         * ── 两版都没有分辨力的病历(09-06 审查逮到)────────────────────────
         * 第一版写的是「丢进输入框」,用的是这只文件里的 `clickSelector` —— 它派的
         * 是 `el.click()`,一发合成 click,**不带 pointerdown、也不搬焦点**,于是
         * 焦点一动没动,这一整场从来没有起手条件。
         *
         * 第二版改成真指针点**右格**并断言起手在右格,起手条件是真的了,可这一条
         * **照样量不出那句产品代码**:审查把 `unpairTab` 末尾那句
         * `focusIntoRefAfterCommit` 注释掉重跑,读数与基线一字不差 —— 因为右格被
         * 拆走那一刻,焦点系统自己的**孤儿回收**(那一层没了 / 变 inert → settle
         * 把焦点收回活动内容 = 左格)独立地把焦点送到了同一处。焦点起手在**这两格
         * 里面**,这条门就永远绿。
         *
         * 第三版把焦点停在**两格外面**的一颗按钮上(叶动作组那颗,它在顶栏里、
         * 不在 pair 里,而且拆开之后它还在场),起手条件这才干净:这时没有任何东西
         * 被拆成孤儿。**但仅有这一条还不够** —— 拆开会把左格那一层从
         * `pair:…` 换成 `session:…`,那一层重挂,焦点系统照样有理由 settle 一次,
         * 而 settle 送到的落点与「产品送到左格」在**文件**左格上是同一处。
         *
         * 第四版(现在这一版)因此把分辨力做进**读数本身**:左格摆成**会话**,
         * 于是产品那一句送的是它自述的落焦偏好(输入面板,树**外面**),回收 /
         * settle 送的是树**里面**那一层 —— 两个读数结构上不可能相同(见上面 ① 段)。
         *
         * 起手那一句自己也断言(焦点真在两格外面),不让它再静默退化。
         */
        /*
         * 停焦那一颗从「叶动作组那颗分屏钮」换成**顶栏尾格里的那颗**(W7-c 裁定 2
         * 把分屏钮删了)。要的性质一个字没变:它在顶栏里、不在 pair 里、拆开之后
         * 还在场 —— 尾格今天只剩 ⋯ 与 AgentChip 两件,取第一颗按得动的即可。
         */
        await page.evaluate(() => {
          const btn = document.querySelector('[data-testid="topbar-trailing"] button')
          if (btn instanceof HTMLElement) btn.focus()
        })
        await delay(300)
        const parked = await page.evaluate(() => {
          const active = document.activeElement
          const side = active?.closest?.('[data-pair-side]')
          return {
            testid: active?.getAttribute?.('data-testid') ?? active?.tagName ?? null,
            side: side?.getAttribute('data-pair-side') ?? null,
          }
        })
        assert(
          parked.side === null && parked.testid !== null && parked.testid !== 'BODY',
          '拆之前焦点停在这两格**外面**的一颗钮上(这一条给下面那一条分辨力)',
          `(此刻在 ${parked.testid ?? '—'},格 ${parked.side ?? '外面'})`,
        )
        // ③ 拆开 —— 缝中点那颗小把手(与右键菜单同一只 `unpairTab`)。
        await page.evaluate(() => {
          const btn = document.querySelector('[data-testid^="pair-unpair:"]')
          if (btn instanceof HTMLElement) btn.click()
        })
        await delay(700)
        const after = await page.evaluate(() => {
          const active = document.activeElement
          const layer = active?.closest?.('[data-pane-tab]') ?? null
          return {
            sides: document.querySelectorAll('[data-pair-side]').length,
            landedIn: layer?.getAttribute('data-pane-tab') ?? null,
            testid: active?.getAttribute?.('data-testid') ?? null,
            scope:
              active?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
          }
        })
        assert(after.sides === 0, '拆开之后屏幕上没有两格了', `(${after.sides} 格)`)
        /*
         * **量的是左格那一种内容的落焦偏好目标,不是「进了树里某个容器」**。
         * 左格是会话 → 偏好是它的输入面板(`ContentKind.focusInto: 'composer'`),
         * 而输入面板在 `.center` 上、根本不在拼贴树里 —— 回收路送不到那儿。
         * 所以这一条读数只有 `unpairTab` 末尾那一句送得到:拆掉它就红。
         */
        assert(
          after.testid === 'composer-input' && after.scope === 'composer',
          '焦点跟到**左格那一格内容自己说的落点**(会话 → 它的输入面板),而不是被回收送回某个容器',
          `(落在 ${after.testid ?? '—'} / 作用域 ${after.scope ?? '—'} / 树层 ${after.landedIn ?? '树外'})`,
        )
        await assertNoOrphan(page, 'B11 拆开之后')
      }
    }

    /* ── 场景 19:B12 —— ⌘W 落在关不掉的那一格上要说话 ───────────────────── */
    scenario('⌘W 落在关不掉的那一格上 → 播报一句「关不掉」,而且那一格真的还在(W7-t / B12)')
    if (!w7tFixture || w7tFixture.tabs < 3) {
      skip('B12', `中央区只攒出 ${w7tFixture?.tabs ?? 0} 格 tab —— 夹具没搭起来`)
    } else {
      // ① 把会话那一格点成活动的,并把键盘交回那片叶(⌘W 是叶的面域局部键)。
      await page.evaluate((css) => {
        const first = document.querySelectorAll(css)[0]
        if (first instanceof HTMLElement) first.click()
      }, CENTER_TABS)
      await delay(500)
      await page.evaluate(() => {
        const layer = document.querySelector(
          '[data-pane-region="center"] [data-pane-tab][data-pane-on]',
        )
        const stream = layer?.querySelector('[data-testid="chat-stream"]')
        if (stream instanceof HTMLElement) stream.focus()
      })
      await delay(400)
      const armed = await page.evaluate(
        () =>
          document.activeElement?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope')
          ?? null,
      )
      assert(armed === 'chat', '键盘先回到那一格会话里(⌘W 是叶的局部键)', String(armed))

      /*
       * ② **把播报口先擦干净**再按。这道门此前几步已经往那格里写过话(拖拽落定 /
       * 拆开),不擦的话读到的可能是上一句 —— 探针擦的是**自己的量具**,
       * 不是产品状态。
       */
      await page.evaluate(() => {
        const slot = document.querySelector('[data-live="polite"]')
        if (slot) slot.textContent = ''
      })
      const tabsBefore = await page.evaluate(
        (css) => document.querySelectorAll(css).length,
        CENTER_TABS,
      )
      await page.keyboard.press('Meta+w')
      // `announce` 先清空、下一拍再写(读屏要两次差分才重念),所以等得比一帧长。
      await delay(700)
      const said = await page.evaluate((css) => ({
        spoken: document.querySelector('[data-live="polite"]')?.textContent ?? '',
        tabs: document.querySelectorAll(css).length,
      }), CENTER_TABS)
      assert(
        said.tabs === tabsBefore,
        '那一格真的关不掉(⌘W 之后 tab 数一个没变)',
        `(before ${tabsBefore} / after ${said.tabs})`,
      )
      assert(
        /关不掉|can.t be closed/.test(said.spoken),
        '而且它**说了一句话** —— 不再是静默的空动作',
        `(播报口里:「${said.spoken.trim() || '—'}」)`,
      )
      await assertNoOrphan(page, 'B12 ⌘W 被拒之后')
    }

    /* ── 场景 20:W7-c —— Shift+F10 开表,Esc 关表焦点回那格标签 ─────────── */
    /*
     * W7-c 裁定 3 把「分屏」那颗钮删了,标签动作表从此只有右键与 `Shift+F10`
     * 两个开口。键盘那一条因此**必须**满足响应链第 5 条(「关掉什么,焦点回打开
     * 它的地方」)—— 否则按一下 Esc 焦点掉进树里某处,再按 `Shift+F10` 开的就不是
     * 同一格标签的表了(那正是 ⌘F「开一次之后再也开不出来」那桩病的同型)。
     *
     * 归还是**结构性的**(§4.5:菜单 portal 到 body,在树上是那一格标签的孩子),
     * 所以这一条量的是那条结构而不是某处的簿记。
     * 反证:把 `ui/Menu` 那格 `FocusScope` 的 `activateOnMount` 拆掉 → 第一条红
     * (焦点根本没进菜单,Esc 也就无从谈起)。
     */
    scenario('Shift+F10 在焦点标签上开动作表 → Esc 关表,焦点回那格标签(W7-c 裁定 3)')
    const tabForMenu = await page.evaluate((css) => {
      const tab = document.querySelectorAll(css)[0]
      if (!(tab instanceof HTMLElement)) return null
      tab.focus()
      return tab.getAttribute('data-tab-id')
    }, CENTER_TABS)
    if (!tabForMenu) {
      skip('W7-c 键盘开表', '顶栏上没有标签')
    } else {
      await delay(300)
      await page.keyboard.down('Shift')
      await page.keyboard.press('F10')
      await page.keyboard.up('Shift')
      await delay(500)
      const opened = await page.evaluate(() => {
        const active = document.activeElement
        return {
          menu: Boolean(document.querySelector('[role="menu"]')),
          scope: active?.closest?.('[data-focus-scope]')?.getAttribute('data-focus-scope') ?? null,
        }
      })
      assert(opened.menu, 'Shift+F10 开得出标签动作表(删钮之后唯一的键盘入口)')
      assert(
        opened.scope === 'menu',
        '焦点当场进了那张表(`ui/Menu` 的 activateOnMount)',
        `(此刻在作用域 ${opened.scope ?? '—'})`,
      )
      await page.keyboard.press('Escape')
      await delay(500)
      const back = await page.evaluate(() => {
        const active = document.activeElement
        return {
          menu: Boolean(document.querySelector('[role="menu"]')),
          tabId: active?.getAttribute?.('data-tab-id') ?? null,
          role: active?.getAttribute?.('role') ?? null,
        }
      })
      assert(!back.menu, 'Esc 把那张表关掉了')
      assert(
        back.tabId === tabForMenu,
        '焦点结构性地回到**开它的那一格标签**上',
        `(回到 ${back.tabId ?? back.role ?? '—'},开它的是 ${tabForMenu})`,
      )
      await assertNoOrphan(page, 'W7-c Esc 关表之后')
    }

    await app.close()
    app = undefined
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
    await rm(workspaceRoot, { recursive: true, force: true })
  }

  /* ── 打表 ─────────────────────────────────────────────────────────── */
  console.log('\n────────── 逐场景读数 ──────────')
  let red = 0
  let skipped = 0
  scenarios.forEach((s, i) => {
    const bad = s.checks.filter((c) => !c.ok)
    const skips = s.checks.filter((c) => c.skipped)
    red += bad.length
    skipped += skips.length
    /*
     * 「整个场景没搭起来」与「场景绿了、其中一格如实记跳过」是两件事,标签要分得开
     * (R3:场景 5 的五条读数全绿,只有拍点 3 的生成中那半边跳过 —— 标成「跳过」
     * 会让人以为这一整格没量)。
     */
    const tag =
      bad.length > 0
        ? `红 ${bad.length}/${s.checks.length}`
        : skips.length === s.checks.length
          ? '跳过'
          : skips.length
            ? `绿(${skips.length} 条跳过)`
            : '绿'
    console.log(`场景 ${i + 1} ${tag}  ${s.name}`)
    for (const c of bad) console.log(`   ✗ ${c.message}${c.detail ? `  ${c.detail}` : ''}`)
    for (const c of skips) console.log(`   ⊘ ${c.message}(${c.detail})`)
  })
  console.log(
    `合计 ${red} 条红 / ${scenarios.reduce((n, s) => n + s.checks.length, 0)} 条断言`
      + `${skipped ? `(其中 ${skipped} 条跳过)` : ''}`,
  )

  if (red && !EXPECT_RED) {
    console.error('\n[focus-gate] FAILED')
    process.exit(1)
  }
  console.log(
    red
      ? '\n[focus-gate] 带 --expect-red:上面的红是**本批预期的读数**,不判失败'
      : `\n[focus-gate] ok —— ${scenarios.length} 个场景全绿`,
  )
}

main().catch((error) => {
  console.error('\n[focus-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
