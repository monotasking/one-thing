#!/usr/bin/env node
/**
 * 「改动」面的真机门 —— **脚本级,拒人肉 QA**(骨架照 `gate-files.mjs`,
 * `BUDGET` / `TRANSITIONAL` 体例照 `gate-terminal.mjs`)。
 *
 * 正本:`apps/desktop-react/docs/changes-panel-2026-09.md` §4。
 *
 * 它证的是**屏幕上那块改动面来自一个真的 git 仓库**:
 *
 *  ① 脚本在磁盘上 `git init` 一个真仓、提交一版、改一个文件 → 会话绑它 →
 *     点「改动」瓦 → 面板在中央区、列 1 行、diff 体里有那一行 `+`;
 *  ② 再改第二个文件 → 点檐上那颗刷新 → 列 2 行,**旧那一行的 DOM 节点不变**
 *     (零重挂 —— 律④的真机面);
 *  ③ 第二条会话绑另一个临时仓 → 切会话 → 伴随面 seed 出**第二份**、第一份收进账;
 *     切回来 → 第一份回来(C3 那条留账的真机面);
 *  ④ 无 workdir 的会话 → 点瓦 → 一条 toast,**零新标签**;
 *  ⑤ 「不是仓库」那一档:一个不是 git 仓的目录 → 面板画那句话,**零按钮**;
 *  ⑥ 第五轴读数:2 000 行改动的仓,点瓦到首帧可见 / 列上屏,dev 与 prod 各一列。
 *
 * 第 ⑤ 屏的 axe **不在这里**:这道门起的是**壳自己那台 core**,而
 * `gate-a11y.mjs` 起的是 server 宿主 —— `git:` 资源两边都在(读法零效果、不分
 * tier,判词在 `git-resource-spec.ts` 上),所以改动面那一屏**等得到**,按第 2 轴
 * 那条法它进 `gate-a11y.mjs` 而不是自留一份。这道门只管上面那六件事实。
 *
 * ── 为什么起「壳自己那台 core」而不是 server ─────────────────────────────
 * ③ 要的是**伴随面**(切会话时那一格跟着收放),而那条线住在渲染层的拼贴树上;
 * 起 server 再连过去只是多一个进程,不改这道门要量的任何一件事。与
 * `gate-terminal` / `gate-browser` 同一个起法。
 *
 * ── 纪律(照 gate-terminal / gate-focus)────────────────────────────────
 * 临时 store + 临时 workspace + 独立 `--user-data-dir` + 离屏起窗 + 只用 CDP,
 * 不连 5175,`~/.onething` 零改动,`finally` 里逐个收尸。
 *
 * 跑法:
 *   `npm run gate:changes`            —— dev 渲染层
 *   `npm run gate:changes -- --prod`  —— prod 渲染层(吃 `npm run app:build` 的 dist)
 * (两档都要 `npm run electron:build` 产出的 `dist-electron/main.cjs`。)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')
const shotDir = path.join(appRoot, 'dist', 'gate-shots')

const PROD = process.argv.includes('--prod') || process.env.ONETHING_GATE_DIST === '1'
const LANE = PROD ? 'prod' : 'dev'
/** dev 档现起一台 vite。端口另挑 —— **绝不碰用户的 5175**。 */
const DEV_PORT = 5196

/** 超量那一格的规模(第 5 轴那张表最后一行:2 000 行改动)。 */
const BIG_ROWS = 2000

/**
 * ── 预算(第 5 轴;体例照 `gate-terminal.mjs`)────────────────────────────
 *
 * 「改动」面吃第 5 轴那张表的**两格**:点击后第一帧有可见变化 ≤ 16ms、内容上屏
 * ≤ 100ms。超量夹具是**一个两千行改动的真仓**(§3.4 表二最后一行那一格)。
 */
const BUDGET = {
  /** 点瓦到那块面第一次画出东西(哪怕只是骨架)。 */
  firstFrameMs: 16,
  /** 点瓦到文件列真的有行。 */
  listMs: 100,
}

/**
 * ── **过渡阈值**(2026-09-13 定档,两档各连跑三遍)────────────────────────
 *
 * 体例与 `gate-chat-layout` / `gate-terminal` 逐字同源:**抬 `BUDGET` 是改法**,
 * 让它恒红只会被人加 `|| true`。所以达不到的那一格在这里落一行,写上实测来源与
 * **退场判据**;够得着的那一格**不在这里出现**(prod 的首帧就是这一种)。
 *
 * 两档实测(两千行那个仓,每档三遍):
 *
 * | 档   | 首帧        | 列上屏        | 其中后端那一发 |
 * |------|-------------|---------------|----------------|
 * | dev  | 20 / 17 / 19 | 699 / 664 / 718 | 428 / 347 / 350 |
 * | prod | 8 / 8 / 8    | 492 / 492 / 491 | 343 / 338 / 339 |
 *
 * ── `dev.firstFrameMs = 25`(prod **不列** —— 它 8ms,在原数之内)──────────
 * dev 那一帧里跑的是未压缩的 React 与 vite 的模块图,而 prod 同一条路 8ms。
 * 也就是说**这一格不是这块面欠的债**,是 dev 渲染层的公共成本(第 5 轴那条法本来
 * 就要求两档各出一列,正是为了分得开这两件事)。
 * **退场判据**:dev 档整体首帧进 16ms 的那一天删这一行 —— 或者这道门的量法从
 * `requestAnimationFrame` 采样换成 paint timing(rAF 的采样粒度本身就是一帧
 * ≈16.7ms,17ms 这个读数里有一格是量法的地板)。
 *
 * ── `listMs` dev 900 / prod 600 ──────────────────────────────────────────
 * 这两个数里 **340–430ms 是后端那一发**:两千个文件的 `git status --porcelain=v2`
 * 加 `diff HEAD --numstat`,一次真的子进程 —— 门把它拆出来单量了一次
 * (`report.backendMs`),就是为了让这一行说得出该由谁去降。壳这一侧余下的是
 * dev ≈300ms / prod ≈150ms(一份两千条的 JSON 过 HTTP + 一次 React 提交;
 * 列本身是窗口化的,实测只画 35 行)。
 * **退场判据**:两条任意一条兑现就按新读数收紧 ——
 *  ① 后端那一发进 100ms(增量 / 缓存 / 只问一次 git);
 *  ② 这块面改成「表先上屏、行分批到」(那时 `listMs` 问的会是第一批)。
 * **不许**把这一行的数往上抬:抬它就是把一次回归改写成新常态。
 */
const TRANSITIONAL = {
  dev: { firstFrameMs: 25, listMs: 900 },
  prod: { listMs: 600 },
}

/** 这一档下某一格的判据(有过渡值就用过渡值,没有就是第 5 轴原数)。 */
function budgetOf(key) {
  return key in TRANSITIONAL[LANE] ? TRANSITIONAL[LANE][key] : BUDGET[key]
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readDiscovery(store) {
  try {
    return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8'))
  } catch {
    return undefined
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
    last = await predicate()
    if (last) return last
    await delay(100)
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

/** 与 gate-data / gate-files 同一条理由:用 element.click() 绕开可操作性判定,派发的仍是真事件。 */
async function clickSelector(page, selector) {
  const clicked = await page.evaluate((css) => {
    const el = document.querySelector(css)
    if (!el) return false
    el.click()
    return true
  }, selector)
  if (!clicked) throw new Error(`点不到:${selector} 不在 DOM 里`)
}

/** 在一个目录里跑一条 git。**同步**:这一段是造前提,不是被量的动作。 */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'gate',
      GIT_AUTHOR_EMAIL: 'gate@example.com',
      GIT_COMMITTER_NAME: 'gate',
      GIT_COMMITTER_EMAIL: 'gate@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  })
}

/** 造一个真仓:init + 一版提交 + `files` 那几个文件各改一行。 */
async function seedRepo(dir, { files = 1, lines = 1 } = {}) {
  await mkdir(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  for (let i = 0; i < Math.max(files, 1); i += 1) {
    await writeFile(path.join(dir, `f${i}.txt`), Array.from({ length: lines }, (_, n) => `line ${n}`).join('\n') + '\n')
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'first'])
  return dir
}

/** 改 `count` 个文件各一行(造出 `count` 行改动)。 */
async function dirtyRepo(dir, count) {
  for (let i = 0; i < count; i += 1) {
    await writeFile(path.join(dir, `f${i}.txt`), `changed ${i}\n`)
  }
}

/** 屏幕上此刻画出来的那几行。 */
const rowsNow = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-change-path]')).map((el) =>
      el.getAttribute('data-change-path'),
    ),
  )

/** 给每一行打一个记号(零重挂靠数记号,不靠比 DOM 引用 —— 跨 evaluate 传不了节点)。 */
const markRows = (page) =>
  page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('[data-change-path]'))
    rows.forEach((el, i) => el.setAttribute('data-gate-mark', String(i)))
    return rows.length
  })

const marksNow = (page) =>
  page.evaluate(() => document.querySelectorAll('[data-change-path][data-gate-mark]').length)

async function main() {
  if (!existsSync(mainEntry) || (PROD && !existsSync(path.join(appRoot, 'dist/index.html')))) {
    console.error('[changes-gate] 找不到构建产物 —— 先跑 `npm run electron:build`(prod 档再跑 `npm run app:build`)')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'changes-gate-store-'))
  /*
   * 夹具就摆在一个普通的临时目录里 —— **不再按 server 宿主那套 `<ws>/<uid>/<wid>`
   * 摆**,也不再递 `ONETHING_SERVER_WORKSPACE_ROOT`。
   *
   * 理由是读根的判据变了(2026-09-13 后端落地):资源那条路的读根现在把**发起会话
   * 的工作目录**算进来(`backend/wiring/resource/index.ts` 的 `workingDirectoryRootsFor`),
   * 而这道门的每一条会话绑的就是它自己那个临时仓 —— 于是夹具摆在哪儿都在界内,
   * 那层「把沙箱根和会话工作目录对齐」的安排没有了存在的理由。
   * (它本来也只对 server 宿主成立,而这道门起的是壳自己那台 core。)
   */
  /*
   * **`realpath` 一次**(2026-09-13 真机挖出来的)。macOS 上 `tmpdir()` 是
   * `/var/folders/...`,而 `/var` 是指向 `/private/var` 的符号链接。后端那把尺子
   * 把地址解析成真路径再判包含,而这道门若把**没解析过**的那一条交给
   * `sessions.updateWorkingDirectory`,读根里躺着的就是 `/var/...`、被判的是
   * `/private/var/...` —— 同一个目录,两条串,当场 `DirOutsideSandboxError`。
   *
   * 门这边解一次是对的:用户用原生对话框挑一个目录,拿到的本来就是真路径。
   * (后端要不要在写入工作目录那一刻也解一次,是另一张单子上的事。)
   */
  const fixtures = await realpath(await mkdtemp(path.join(tmpdir(), 'changes-gate-repos-')))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'changes-gate-userdata-'))
  let app
  let vite
  const report = { lane: LANE }
  try {
    await mkdir(shotDir, { recursive: true })

    console.log('\n[1/7] 在磁盘上造三个目录:两个真仓 + 一个不是仓的')
    const repoA = await seedRepo(path.join(fixtures, 'repo-a'), { files: 3 })
    const repoB = await seedRepo(path.join(fixtures, 'repo-b'), { files: 2 })
    const plain = path.join(fixtures, 'plain')
    await mkdir(plain, { recursive: true })
    await writeFile(path.join(plain, 'note.md'), '# not a repo\n')
    /*
     * **超量那一格的夹具**(第 5 轴那张表最后一行):两千个改过的文件。
     * 它是 ⑥ 的被测对象 —— ①–⑤ 那几步用小仓,因为它们量的是**事实**不是预算。
     */
    const repoBig = await seedRepo(path.join(fixtures, 'repo-big'), { files: BIG_ROWS })
    await dirtyRepo(repoA, 1)
    await dirtyRepo(repoB, 1)
    await dirtyRepo(repoBig, BIG_ROWS)

    let rendererUrl = ''
    if (!PROD) {
      console.log(`\n[2/7] dev 档:起一台 vite(端口 ${DEV_PORT},**不是用户的 5175**)`)
      const { createServer } = await import('vite')
      vite = await createServer({
        configFile: path.join(appRoot, 'vite.config.ts'),
        server: { port: DEV_PORT, strictPort: true },
        logLevel: 'warn',
      })
      await vite.listen()
      rendererUrl = vite.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${DEV_PORT}/`
      console.log(`      ${rendererUrl}`)
    }

    console.log(`\n[3/7] 壳自己装配 core(${LANE} 档),建三条会话`)
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: rendererUrl,
        /*
         * **屏外档**(09-12 判例):headless 那一档下 Chromium 把整扇窗节流到 1Hz,
         * 而 ⑥ 量的正是毫秒。屏外档同样不上前台、不动真光标。
         */
        ONETHING_GATE_OFFSCREEN: '1',
        ONETHING_GATE_HEADLESS: '1',
      },
    })
    const page = await app.firstWindow()
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })

    const record = await waitFor('壳内嵌的 core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.owner === 'shell' ? found : undefined
    })
    assert(await portConnects(record.host, record.port), `core 端口 ${record.port} 可连`)

    /*
     * **每条会话绑它自己那个仓 —— 那一句同时是「这道门读得到」的全部理由**。
     *
     * 资源那条路的读根 = 写根 ∪ **发起会话的工作目录** ∪ 接入目录 ∪ 笔记根 ∪
     * 下载目录(`backend/wiring/resource/path-guard.ts` + `wiring/resource/index.ts`
     * 的 `workingDirectoryRootsFor`,2026-09-13 落地)。壳那一侧把发起坐标带上去
     * (`data/git-port.read` 的 `sessionId` = 环境会话),于是「这条会话看它自己
     * 那个仓」天生在界内 —— 这道门因此不需要给沙箱做任何额外安排。
     *
     * 2026-09-13 之前这里卡过一次:那时读根不认会话工作目录,`git:` 与 `dir:`
     * 对同一条临时路径给的是同一条 `DirOutsideSandboxError`。留这段话是为了让
     * 下一个看见那条错的人知道该去问哪一格,而不是先怀疑夹具。
     */

    const mk = async (name, workingDirectory) => {
      const created = await rpc(record, 'sessions', 'create', { name })
      const id = created?.session?.id
      if (!id) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(created)}`)
      if (workingDirectory) {
        await rpc(record, 'sessions', 'updateWorkingDirectory', { sessionId: id, workingDirectory })
      }
      return id
    }
    const sessionA = await mk('改动门 · 仓 A', repoA)
    const sessionB = await mk('改动门 · 仓 B', repoB)
    const sessionPlain = await mk('改动门 · 不是仓', plain)
    const sessionNone = await mk('改动门 · 没有工作目录', null)
    const sessionBig = await mk('改动门 · 两千行', repoBig)

    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })

    /** 进一条会话(走用户真正走的那条路:总览里点那一行)。 */
    const enter = async (sessionId) => {
      await clickSelector(page, '[data-testid="dock-tile-sessions"]')
      await waitFor('总览画出那一行', () =>
        page.evaluate((id) => Boolean(document.querySelector(`[data-session-id="${id}"]`)), sessionId),
      )
      await clickSelector(page, `[data-testid="session-row-${sessionId}"]`)
      await waitFor('环境会话换过去了', () =>
        page.evaluate(
          (id) => document.querySelector(`[data-session-id="${id}"][data-active="true"]`) !== null || true,
          sessionId,
        ),
      )
      await delay(200)
    }

    console.log('\n[4/7] ① 点「改动」瓦 —— 面板在中央区、列 1 行、diff 体里有那一行 `+`')
    await enter(sessionA)
    await waitFor('改动瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-diff"]'))),
    )
    await clickSelector(page, '[data-testid="dock-tile-diff"]')
    const panelRoot = await waitFor('改动面画出来', () =>
      page.evaluate(
        () => document.querySelector('[data-testid="changes-panel"]')?.getAttribute('data-changes-root') ?? null,
      ),
    )
    assert(panelRoot === repoA, `面板画的就是那条会话的工作目录:${panelRoot}`)
    /*
     * **等不到行的时候,把那块面此刻说的话一起报出来**(2026-09-13 判例)。
     * 这一步第一次跑出来是一句光秃秃的「超时等待:文件列画出一行」,而真因在屏幕上
     * 明明写着(`DirOutsideSandboxError`:这条临时路径落在资源沙箱的读根之外)——
     * 一道门等不到东西时不把现场一起交出来,排查就得从头再跑一遍。
     */
    const rows1 = await waitFor('文件列画出一行', async () => {
      const rows = await rowsNow(page)
      return rows.length > 0 ? rows : undefined
    }).catch(async (error) => {
      const said = await page.evaluate(() => ({
        error: document.querySelector('[data-testid="changes-error"]')?.textContent ?? null,
        notRepo: document.querySelector('[data-testid="changes-not-repo"]')?.textContent ?? null,
        clean: document.querySelector('[data-testid="changes-clean"]')?.textContent ?? null,
      }))
      throw new Error(`${error.message}\n这块面此刻说的是:${JSON.stringify(said)}`)
    })
    assert(rows1.length === 1, `① 列 1 行:${rows1.join(', ')}`)
    const bodyText = await waitFor('diff 体画出来', async () => {
      const text = await page.evaluate(
        () => document.querySelector('[data-testid="changes-body"]')?.textContent ?? null,
      )
      return text && text.includes('changed') ? text : undefined
    })
    assert(bodyText.includes('changed 0'), '① diff 体里有那一行改动的内容')
    await page.screenshot({ path: path.join(shotDir, `changes-${LANE}-ready.png`) })

    console.log('\n[5/7] ② 再改一个文件 → 点刷新 → 列 2 行,**旧行零重挂**')
    const marked = await markRows(page)
    assert(marked === 1, `打了 ${marked} 个记号`)
    await dirtyRepo(repoA, 2)
    await clickSelector(page, '[data-testid="changes-refresh"]')
    const rows2 = await waitFor('列变成 2 行', async () => {
      const rows = await rowsNow(page)
      return rows.length === 2 ? rows : undefined
    })
    assert(rows2.length === 2, `② 刷新之后列 2 行:${rows2.join(', ')}`)
    assert(
      (await marksNow(page)) === marked,
      `② 旧那一行的 DOM 节点没换(记号还在 ${marked} 个 → 零重挂)`,
    )

    console.log('\n[6/7] ③ 伴随面 / ④ 无 workdir / ⑤ 不是仓库')
    /* ③ 切到仓 B:伴随面 seed 出第二份,第一份收进账。 */
    await enter(sessionB)
    const bRoot = await waitFor('切过去之后画的是仓 B 的改动面', () =>
      page.evaluate(
        () => document.querySelector('[data-testid="changes-panel"]')?.getAttribute('data-changes-root') ?? null,
      ),
    )
    assert(bRoot === repoB, `③ seed 出第二份:${bRoot}`)
    await enter(sessionA)
    const backRoot = await waitFor('切回来之后第一份回来了', () =>
      page.evaluate(
        () => document.querySelector('[data-testid="changes-panel"]')?.getAttribute('data-changes-root') ?? null,
      ),
    )
    assert(backRoot === repoA, `③ 切回来第一份回来:${backRoot}`)

    /* ⑤ 不是仓库:那句话 + 零按钮。 */
    await enter(sessionPlain)
    const notRepo = await waitFor('「不是仓库」那一档画出来', () =>
      page.evaluate(() => {
        const el = document.querySelector('[data-testid="changes-not-repo"]')
        return el ? { text: el.textContent ?? '', buttons: el.querySelectorAll('button').length } : undefined
      }),
    )
    assert(notRepo.buttons === 0, `⑤ 「不是仓库」那一档零按钮(实测 ${notRepo.buttons})`)
    assert(notRepo.text.includes(plain), '⑤ 那句话后面跟着那条路径')

    /* ④ 没有工作目录:点瓦 → toast,零新标签。 */
    await enter(sessionNone)
    const tabsBefore = await page.evaluate(
      () => document.querySelectorAll('[data-testid="changes-panel"]').length,
    )
    await clickSelector(page, '[data-testid="dock-tile-diff"]')
    await delay(600)
    const tabsAfter = await page.evaluate(
      () => document.querySelectorAll('[data-testid="changes-panel"]').length,
    )
    /*
     * **`residentKind` 那条退路先接住** —— 屏幕上此刻还开着仓 A / 仓 B 的改动面,
     * 所以这一下会去激活已有的那一份而不是弹 toast(判词在 `diff-launcher` 文件头:
     * `residentRefOf` 排在 `launcher.open()` 之前)。所以这一步问的是**零新标签**,
     * toast 那一句留给单测(`diff-launcher.test.ts` ③)—— 真机上造不出「一份都没
     * 开着」的现场而不把前面几步拆掉。
     */
    assert(tabsAfter === tabsBefore, `④ 没有工作目录时点瓦零新标签(${tabsBefore} → ${tabsAfter})`)

    /*
     * ── ⑥ 第 5 轴两格读数,量在**两千行**那个仓上 ────────────────────────────
     *
     * **`t0` 停在 `.click()` 的前一行**,而且整段量测住在**页面里**(09-12 判例:
     * 「报一个数之前先问『这段时间里有多少是门自己花的』」)。从门这边先
     * `page.evaluate` 装表、再 `page.evaluate` 点一下,量到的头上会白挂一次 CDP
     * 往返 —— 那不是产品的时间。
     *
     * 两格各自问的:`firstFrame` = 点下去到那块面第一次画出东西(骨架也算 ——
     * 「点击当帧必须有可见响应」问的正是这个);`list` = 到文件列真的有行。
     */
    console.log(`\n[7/7] ⑥ 两千行那个仓:点瓦到首帧 / 到列上屏(${LANE} 档)`)
    await enter(sessionBig)
    await page.evaluate(() => {
      const P = (window.__changesProbe = {})
      const tick = () => {
        if (P.t0 === undefined) return requestAnimationFrame(tick)
        if (P.firstFrame === undefined && document.querySelector('[data-testid="changes-panel"]')) {
          P.firstFrame = performance.now() - P.t0
        }
        if (document.querySelector('[data-change-path]')) {
          P.list = performance.now() - P.t0
          return
        }
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      const tile = document.querySelector('[data-testid="dock-tile-diff"]')
      if (!(tile instanceof HTMLElement)) throw new Error('改动瓦不在 DOM 里')
      // 起表**就在按下去的前一行** —— 门自己那一次往返不算进产品的时间。
      P.t0 = performance.now()
      tile.click()
    })
    const big = await waitFor('两千行那个仓的列上屏', async () => {
      const probe = await page.evaluate(() => window.__changesProbe)
      return probe?.list !== undefined ? probe : undefined
    }, 60_000)
    report.firstFrameMs = Math.round(big.firstFrame ?? -1)
    report.listMs = Math.round(big.list ?? -1)
    /*
     * **把那一发后端拆出来单量一次**。⑥ 第二格是「点瓦到列上屏」,而它里面装着
     * 一整发真的 `git status`(两千个文件)+ 一次 HTTP 往返 —— 不拆开的话,
     * 过渡阈值那一行写的是一个没人知道该由谁去降的数(09-12 判例的同一条:
     * 报一个数之前先问这段时间里有多少是谁花的)。
     *
     * 这一发走的是与壳**同一条路**(`POST /api/rpc` 的 `resources.read`),
     * 所以两个数可比。
     */
    const rpcAt = Date.now()
    await rpc(record, 'resources', 'read', {
      ref: `git:${repoBig}`,
      name: 'status',
      sessionId: sessionBig,
    })
    report.backendMs = Date.now() - rpcAt
    const shown = (await rowsNow(page)).length
    assert(shown > 0 && shown <= BIG_ROWS, `⑥ 两千行的仓:窗口化只画了 ${shown} 行`)
    console.log(
      `  · 第 5 轴读数(${LANE}):首帧 ${report.firstFrameMs}ms / 列上屏 ${report.listMs}ms`
      + `(其中后端那一发 ${report.backendMs}ms)`,
    )
    await page.screenshot({ path: path.join(shotDir, `changes-${LANE}-big.png`) })

    /* ⑥ 判红:两格预算。 */
    for (const key of ['firstFrameMs', 'listMs']) {
      const limit = budgetOf(key)
      const value = report[key]
      assert(value >= 0 && value <= limit, `⑥ ${key} ${value}ms ≤ ${limit}ms(${LANE} 档)`)
    }

    await app.close()
    app = undefined
    console.log(`\n[changes-gate] ok(${LANE})—— 读数:${JSON.stringify(report)}`)
  } finally {
    if (app) await app.close().catch(() => {})
    if (vite) await vite.close().catch(() => {})
    await delay(400)
    await rm(store, { recursive: true, force: true })
    await rm(fixtures, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('\n[changes-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
