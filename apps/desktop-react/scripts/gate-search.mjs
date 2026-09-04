#!/usr/bin/env node
/**
 * 检索面的真机门(09-01)—— **脚本级,拒人肉 QA**。
 *
 * 它证两件用户当天报过的事,两件都只有真排版才量得到:
 *
 *  ① **空词是浏览态,不是无态**,而且它就在**默认那一档(「所有」)上**。空输入框
 *     列的是**全部会话**(每页 20 条),底下常驻一行读数:装不下时是「加载更多」,
 *     取尽时是「共 N 条 · 已全部显示」。报障原话:「我要能够在这里面看到所有的条数,
 *     所有的记录,要能够翻页」—— 从前那里恒定 8 条、没有读数、没有下一页。
 *     种子刻意超过一页(SEED_SESSIONS > 一页 20),否则「翻页」根本演不出来。
 *
 *     (S4b 中途曾把这几条断言搬到「会话」那一档上 —— 那是一次没被裁定过的行为
 *     变化,**已修**:壳在**零词元**时不发 `category: 'all'`(后端的 `'all'` 是不
 *     分页的分组总览),而是问自述里声明了 `browse` 的那些能力。所以这几条断言
 *     搬回默认档,而且**门里不出现任何一个能力 id** —— 它证的正是「不用切档」。)
 *
 *  ②b **文件那一档的根跟着会话工作目录走**(S4b 修)。第 5 步进会话之后再搜,
 *      种在那条会话工作目录下的文件必须搜得到 —— 后端的根列表认的是**它自己**那条
 *      `getCurrentSessionId()`,而 React 壳从不告诉后端当前会话是谁,所以这条根由壳
 *      作为 `filters.dir` 结构地递回去(设计 §9)。门里从前有一句显式的
 *      `sessions.switch` 补偿,**已删** —— 有它就等于替壳把这件事做了,病照样在。
 *
 *  ② **行首那颗徽装得下它自己的字**。报障截图:徽列按四字符(CHAT / MSG / MD)
 *     写死 34px,八字符的 NOTEBOOK 直接把字顶到胶囊边框外面。
 *     徽上的字是**数据**不是文案(扩展名大写;没有扩展名就是整个文件名大写),
 *     没有一张可以枚举完的词表 —— 所以门不去背词表,它在真排版上量三件:
 *       · 每颗徽的字**不许画到胶囊边框外面**(报障的字面形);
 *       · 现实词表里的徽**一个都不该出现省略号**(内容宽 ≤ 内容盒宽);
 *       · 所有行的**原文从同一条竖线起笔**(徽列按最宽那颗对齐 —— 这正是
 *         「胶囊 hug 内容」之后最容易丢的那件事,丢了列表就扫不动了),
 *         底部那条读数行也在同一条竖线上。
 *     外加一个**离谱长名**当反面对照:它该被封顶 + 省略,而不是撑破边框。
 *
 * ── 为什么这一半必须真机 ─────────────────────────────────────────────────
 * 这一批的样式是 CSS Modules,在 vitest 里 `import s from './x.module.css'` 拿回来的
 * 只是一张类名映射,那份 CSS 从来没有进过 jsdom 的样式表 —— jsdom 也不排版,
 * `getComputedStyle(chip).width` 恒等于空、`scrollWidth` 恒等于 0。
 * 静态那一半守在产地上(`src/search/components/search-css.test.ts`:断言写死宽的
 * 那一行不许回来);**几何**只有这里量得到。两半都要在。
 *
 * 跑法:`node scripts/gate-search.mjs`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 可重复:每次全新的临时 store + 临时 workspace,跑完删干净(收尸在 finally 里)。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

/** 沙箱根的两段 —— 与 `ownerSandboxRoot(root, uid, wid)` 的拼法一致(同 gate-files)。 */
const OWNER_UID = 'local-user'
const OWNER_WID = 'default'

/** 一页多少条 —— 与 `src/search/transitions.ts` 的 SEARCH_FIRST_PAGE 是同一个数。 */
const FIRST_PAGE = 20
/** 种子会话数。必须 > 一页,否则「翻页」这件事在屏幕上根本不发生。 */
const SEED_SESSIONS = 25

/**
 * 徽的被试词表。**不是「现有词表的全集」** —— 徽上的字来自路径,全集不存在。
 * 这里挑的是三类各自的最坏一例:
 *  · 四字符档(报障之前唯一装得下的那一档):MD / TS / JSON;
 *  · 报障那一例本身:无扩展名的 `notebook` → NOTEBOOK(八字符);
 *  · 更长的现实词:`.stylesheet` → STYLESHEET(十字符)。
 * 文件名都带同一个词根 `note`,一次查询把它们全召出来。
 */
const BADGE_FILES = [
  { name: 'note.md', badge: 'MD' },
  { name: 'note.ts', badge: 'TS' },
  { name: 'note.json', badge: 'JSON' },
  { name: 'notebook', badge: 'NOTEBOOK' },
  { name: 'note.stylesheet', badge: 'STYLESHEET' },
]

/**
 * 反面对照:一个**离谱**的无扩展名长文件名。它的徽会是整个文件名大写(40+ 字符),
 * 该有的结果是「封顶 + 省略号」,**不是**撑破边框。词表内的那五个一个都不该省略,
 * 这一个该省略 —— 两件事一起断言,才证明封顶不是把所有徽都切了。
 */
const LONG_FILE = { name: 'note-extremely-long-name-without-extension', badgeStartsWith: 'NOTE' }

const SEARCH_QUERY = 'note'

/**
 * 带工作目录的那条会话的名字。它要**独一无二**:第 5 步靠在检索面里搜这个名字
 * 把它选中(= 进会话),名字撞车就会选到别的那条,文件侧的根跟着错。
 */
const FIRST_SESSION_NAME = '检索门 · 带工作目录的那条'

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

/**
 * 与 gate-files 同一条理由:用 element.click() 绕开可操作性判定,派发的仍是真事件。
 *
 * 顺带满足 09-01 那条纪律(**真机输入探针禁抢用户的机器**):这条门从头到尾
 * 一次 `page.mouse` / `page.keyboard` 都不用 —— 全部是**页面内的 DOM 派发**,
 * 只落在目标窗口里,不动真光标、不抢前台焦点。用户可以一边跑门一边用电脑。
 */
async function clickSelector(page, selector) {
  const clicked = await page.evaluate(css => {
    const el = document.querySelector(css)
    if (!el) return false
    el.click()
    return true
  }, selector)
  if (!clicked) throw new Error(`点不到:${selector} 不在 DOM 里`)
}

/**
 * 换一档:点那一格 radio。文案随语言变,所以收一张**候选表**逐个试。
 */
async function selectTab(page, labels) {
  const ok = await page.evaluate(names => {
    const tabs = [...document.querySelectorAll('[data-testid="search-panel"] [role="radio"]')]
    for (const name of names) {
      const el = tabs.find(node => (node.textContent ?? '').trim() === name)
      if (el) {
        el.click()
        return true
      }
    }
    return false
  }, labels)
  if (!ok) throw new Error(`tab 条上没有「${labels.join(' / ')}」这一格`)
}

/** 「不挑」那一档(它在壳自己的字典里,不在任何一份自述里)。 */
const ALL_TAB_LABELS = ['所有', 'All']

/** 文件那一档的两种写法(它的名字来自 `search.capability.files`)。 */
const FILES_TAB = ['文件', 'Files']

/**
 * 等这张列表画出至少一行。
 *
 * **不是一句 waitFor 就够**(第一版是,四跑里红了一次):这一步依赖两件互不相干的
 * 异步 —— 面板开出来、会话列表到手。哪一件没成都长得一样(一行都没有),
 * 而 waitFor 的超时只会报一句 `undefined`,查不出是哪一件。
 * 所以这里自己轮询:每一轮记下当时的处境,**面板不在就再点一次**(Dock 上那颗瓦
 * 是开关,一次误触就会把它收回去),超时时把最后一次处境原样报出来。
 */
async function waitForRows(page, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await readList(page)
    if (last.rows > 0) return last
    if (!last.panel) {
      await clickSelector(page, '[data-testid="dock-tile-search"]').catch(() => {})
    }
    await delay(200)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次处境:${JSON.stringify(last)}`)
}

/** 屏幕上此刻的行(不含底部那条 item)与底部那一行说的话。 */
function readList(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="search-panel"]')
    if (!panel) return { panel: false, rows: 0, more: null, readouts: [] }
    const all = [...panel.querySelectorAll('[role="option"]')]
    const rows = all.filter(el => el.getAttribute('data-row') !== 'more')
    const more = panel.querySelector('[data-testid="search-more"]')
    /*
     * 取尽之后那条读数不是 option,是一段 p —— 两者只会出现一个。
     * **不按字面筛**:这台默认是英文界面(实测第一版按「共 / 已显示」筛,
     * 屏幕上写的是 "25 results · all shown",于是筛了个空,门自己红了一次)。
     * 语言是数据,判据交给调用方去问「那个数在不在这句话里」。
     */
    const readouts = [...panel.querySelectorAll('p')].map(el => (el.textContent ?? '').trim())
    return {
      panel: true,
      rows: rows.length,
      more: more ? (more.textContent ?? '').trim() : null,
      readouts,
      // 一行都没有时,这句话说明是「会话还没到手」还是「真的一条都没有」。
      empty: (panel.querySelector('p')?.textContent ?? '').trim(),
    }
  })
}

/** 把词打进检索框(走真事件,不是改 state)。 */
async function typeQuery(page, value) {
  await page.evaluate(text => {
    const input = document.querySelector('[data-testid="search-panel"] input')
    if (!input) throw new Error('检索框不在 DOM 里')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

/**
 * 逐颗徽量。一行的三个孩子按次序就是 徽 / 原文 / 出处,徽里面还有一层弯腰的字 ——
 * 所以这里按**位置**取,不往生产代码里加一个只为门存在的 data 属性。
 */
function measureBadges(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-testid="search-panel"]')
    if (!panel) return { error: '检索面板不在 DOM 里' }
    const rows = [...panel.querySelectorAll('[role="option"]')].filter(
      el => el.getAttribute('data-row') !== 'more',
    )
    const chips = rows.map(row => {
      const chip = row.children[0]
      const inner = chip.children[0]
      const text = row.children[1]
      const chipBox = chip.getBoundingClientRect()
      const innerBox = inner.getBoundingClientRect()
      const chipStyle = getComputedStyle(chip)
      return {
        word: (inner.textContent ?? '').trim(),
        // 「内容宽 ≤ 胶囊内容盒宽」:相等即刚好装下,大于就是要弯腰(省略号)。
        contentWidth: inner.scrollWidth,
        boxWidth: inner.clientWidth,
        /*
         * 「字画到边框外面没有」的判据是**两件一起**,不是一个矩形。
         *
         * 第一版只比 `getBoundingClientRect()`:那量的是**盒子**,而溢出的行内文字
         * 根本不进盒子的矩形 —— 拿掉 overflow:hidden 之后它照样绿(真跑过,反证失效)。
         * 真正的判据是:内容宽超过内容盒的那一刻,**必须有人在裁**;
         * 「既装不下又不裁」就是报障那一形。
         */
        innerRight: innerBox.right,
        chipRight: chipBox.right - parseFloat(chipStyle.borderRightWidth || '0'),
        clipped: getComputedStyle(inner).overflowX === 'hidden',
        chipWidth: chipBox.width,
        maxWidth: parseFloat(chipStyle.maxWidth || 'NaN'),
        textLeft: text.getBoundingClientRect().left,
      }
    })
    // 底部那条读数行的字也该落在同一条竖线上(它是同一份 subgrid 的第二列)。
    const tail = panel.querySelector('[data-testid="search-more"]') ?? null
    const tailText = tail ? tail.children[0] : null
    return { chips, tailLeft: tailText ? tailText.getBoundingClientRect().left : null }
  })
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[search-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[search-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'search-gate-store-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'search-gate-ws-'))
  const cwd = path.join(workspaceRoot, OWNER_UID, OWNER_WID)
  let server
  let app
  try {
    await mkdir(shotDir, { recursive: true })

    console.log('\n[1/5] 在磁盘上种出徽的被试文件')
    await mkdir(cwd, { recursive: true })
    for (const file of [...BADGE_FILES, LONG_FILE]) {
      await writeFile(path.join(cwd, file.name), 'gate\n')
    }

    console.log(`\n[2/5] 起一台 core,建 ${SEED_SESSIONS} 条会话(> 一页 ${FIRST_PAGE},翻页才演得出来)`)
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

    for (let i = 0; i < SEED_SESSIONS; i += 1) {
      const name = i === 0 ? FIRST_SESSION_NAME : `检索门 · 会话 ${i + 1}`
      const created = await rpc(record, 'sessions', 'create', { name })
      const id = created?.session?.id
      if (!id) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(created)}`)
      // 第一条落一个工作目录:检索面的文件侧按**活跃会话的工作目录**取根。
      if (i === 0) {
        await rpc(record, 'sessions', 'updateWorkingDirectory', {
          sessionId: id,
          workingDirectory: cwd,
        })
      }
    }
    const listed = await rpc(record, 'sessions', 'listMeta', {})
    assert(
      (listed.sessions ?? []).length === SEED_SESSIONS,
      `core 侧确认有 ${SEED_SESSIONS} 条会话`,
    )

    console.log('\n[3/5] 拉起应用,打开检索面板(空词)')
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
    /*
     * **不走总览进会话**(第一版走过,不稳):带工作目录的那条会话在总览里归进了
     * 一个项目组,组里的卡要先进组才画得出来 —— 而「落工作目录」这一发与列表重拉
     * 是两件异步的事,于是同一段代码有时看得到那张散卡、有时看不到(实测一跑绿
     * 一跑红)。这条门要证的是检索面,不是总览的分组时序。
     *
     * 换成**用检索面自己进会话**(第 5 步):它本来就有这条路(点一行 = enterSession),
     * 顺带把那条路也真跑了一遍。第 4 步的浏览态断言与「哪条会话是活跃的」无关,
     * 所以它先跑,一格都不用等。
     */
    await waitFor('检索瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-search"]'))),
    )
    await clickSelector(page, '[data-testid="dock-tile-search"]')
    await waitFor('检索面板就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="search-panel"] input'))),
    )

    console.log('\n[4/5] 空词 = 浏览态(默认那一档上):全部条数看得见、翻得了页')
    /*
     * ── 一档都不切 ──────────────────────────────────────────────────────
     * 面板刚开出来就在「所有」上。**这里刻意不 selectTab** —— 报障那一形就是
     * 「打开检索面,空输入框,我要看到全部记录并能翻页」,切一次档就把病绕过去了。
     *
     * 壳这一侧的做法(设计 §9):零词元时不发 `category: 'all'`(那是不分页的
     * 分组总览),改问自述里声明了 `browse` 的那些能力 —— 今天只有一个,于是
     * 屏幕上是一张平铺的会话列表。**门里不出现那个能力的名字**:它要证的正是
     * 「用户不用知道去问谁」。
     */
    const activeTab = await page.evaluate(() => {
      const on = document.querySelector('[data-testid="search-panel"] [role="radio"][aria-checked="true"]')
      return (on?.textContent ?? '').trim()
    })
    assert(
      ALL_TAB_LABELS.includes(activeTab),
      `面板开出来就停在「不挑」那一档上(此刻是「${activeTab}」)—— 下面几条都不切档`,
    )
    const first = await waitForRows(page, '浏览态第一页画出来')
    console.log('  · 第一页读数:', JSON.stringify(first))
    assert(
      first.rows === FIRST_PAGE,
      `空词只画一页(${first.rows} 行)—— 500 条会话不会一次铺满 DOM`,
    )
    /*
     * ── S4b:第一页那一行**不再报总数**,而这是更诚实的一版 ────────────────
     * 从前壳手上有整张会话表,所以第一页就说得出「共 25 条」。今天这一档的行
     * 来自 `search.query`,而它这一路(空词绕开索引调旧 `searchChats`,S3b)
     * **不下发 total** —— 于是判据表(`transitions.moreState`)落在
     * 「给满了、后面可能还有,但没人说过有」那一格:画「加载更多」,**不猜一个数**。
     *
     * 「看得到全部条数」这件事没有丢,它挪到了**取尽那一刻**(下面第二页那条
     * 断言):真数只有在后端说完之后才是真的。
     */
    assert(
      first.more !== null,
      `底部常驻一条能按的 item(还没取尽,所以不许诺总数):「${first.more}」`,
    )
    /*
     * 底部那条 item 的**缩进**在这里量:它与上面各行的正文从同一条竖线起笔。
     * 从前靠一句 `padding-left: calc(… 徽宽 …)`,徽列改成内容自适应之后那个 calc
     * 算不出来了,改成认领同一份 subgrid —— 这一条就是那次改法的真机证明。
     * (放在浏览态量,是因为这一屏一定有那颗能按的 item;搜索态取尽时它是一段 p。)
     */
    const browseGeom = await measureBadges(page)
    assert(
      browseGeom.tailLeft !== null
        && Math.abs(browseGeom.tailLeft - browseGeom.chips[0].textLeft) <= 0.5,
      `底部那条 item 的字与各行正文同一条竖线(偏差 ${Math.abs(
        (browseGeom.tailLeft ?? 0) - browseGeom.chips[0].textLeft,
      ).toFixed(2)}px)`,
    )

    // 报障那一屏的取证:空输入框 + 一整页会话。
    await page.screenshot({ path: path.join(shotDir, 'search-browse-first-page.png') })
    /*
     * 第二张:把列表滚到底,让**底部那一行**自己出现在图里。
     * 它是列表的最后一条 item(08-31 拍板的形制:跟着列表滚、跟着列表排、
     * 进 ↑↓ 轮转的末位),不是一颗钉在面板下缘的悬浮控件 —— 所以「看得见它」
     * 这件事在屏幕上就是「滚到底」。图与形制一致,不为了好看去挪它的位置。
     */
    await page.evaluate(() => {
      const body = document.querySelector('[data-testid="search-more"]')?.parentElement
      if (body) body.scrollTop = body.scrollHeight
    })
    await delay(200)
    await page.screenshot({ path: path.join(shotDir, 'search-browse-readout.png') })

    await clickSelector(page, '[data-testid="search-more"]')
    const second = await waitFor('翻页之后', async () => {
      const state = await readList(page)
      return state.rows > FIRST_PAGE ? state : undefined
    }, 10_000)
    console.log('  · 翻页后读数:', JSON.stringify(second))
    assert(second.rows === SEED_SESSIONS, `翻一页就把剩下的都放出来了(${second.rows} 行 = 全部)`)
    assert(second.more === null, '取尽那一刻「加载更多」不再是能按的 item')
    const tailReadout = second.readouts.find(text => text.includes(String(SEED_SESSIONS)))
    assert(Boolean(tailReadout), `换成一条读数,报的仍然是全部条数:「${tailReadout}」`)
    await page.screenshot({ path: path.join(shotDir, 'search-browse-all-shown.png') })

    console.log('\n[5/5] 用检索面自己进那条会话(文件侧按活跃会话的工作目录取根),再量行首徽')
    // 一直都在「所有」这一档上(第 4 步没切过档),直接打字。
    await typeQuery(page, FIRST_SESSION_NAME)
    await waitForRows(page, '那条会话在命中里')
    // 点一行 = enterSession + 收回 Dock(面板自己那条路,顺带真跑一遍)。
    await clickSelector(page, '[data-testid="search-panel"] [role="option"][data-row="0"]')
    await waitFor('面板收回 Dock 了', () =>
      page.evaluate(() => !document.querySelector('[data-testid="search-panel"]')),
    )
    /*
     * ── ②b:这里**没有任何补偿**,而这正是断言的一半 ──────────────────────
     * 从前这一步有一句 `rpc(record, 'sessions', 'switch', …)`,把**后端**的当前会话
     * 拨到那条带工作目录的会话上 —— 因为后端的根列表(`getSearchDirs()`)认的是
     * 它自己那条 `getCurrentSessionId()`,而 React 壳从不告诉它当前会话是谁。
     * 那一句是把病绕过去,不是治它。
     *
     * S4b 修之后根由**壳**结构地递回去(`filters.dir` = `useSessionCwd()`,
     * files 在自述里声明了这一格),所以这一句删了:下面那几颗徽能被量到,
     * 本身就证明「会话 cwd 下种的文件搜得到」。
     * 反证:把壳的 `filters.dir` 摘掉 → 「文件命中画出来」当场超时红。
     */
    await clickSelector(page, '[data-testid="dock-tile-search"]')
    await waitFor('检索面板又开出来', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="search-panel"] input'))),
    )
    await typeQuery(page, SEARCH_QUERY)
    const measured = await waitFor('文件命中画出来', async () => {
      const state = await measureBadges(page)
      if (state.error) return undefined
      const words = new Set(state.chips.map(c => c.word))
      return BADGE_FILES.every(f => words.has(f.badge)) ? state : undefined
    })
    console.log(
      '  · 徽读数:',
      JSON.stringify(
        measured.chips.map(c => ({
          w: c.word,
          content: Math.round(c.contentWidth),
          box: Math.round(c.boxWidth),
          chip: Math.round(c.chipWidth),
        })),
      ),
    )

    // ① 字不许画到胶囊边框外面 —— 报障那一形的字面判据,**每一颗都要过**。
    for (const chip of measured.chips) {
      const fits = chip.contentWidth <= chip.boxWidth + 1
      assert(
        chip.innerRight <= chip.chipRight + 0.5 && (fits || chip.clipped),
        `徽「${chip.word}」的字没有画出胶囊边框`
          + `(${fits ? `装得下:内容 ${chip.contentWidth} ≤ 内容盒 ${chip.boxWidth}` : `装不下但被裁住:内容 ${chip.contentWidth} > 内容盒 ${chip.boxWidth},overflow 已裁`})`,
      )
    }

    // ② 现实词表里的徽一个都不该出现省略号(内容宽 ≤ 内容盒宽)。
    for (const file of BADGE_FILES) {
      const chip = measured.chips.find(c => c.word === file.badge)
      if (!chip) throw new Error(`屏幕上没有徽「${file.badge}」—— 种子文件 ${file.name} 没被搜到?`)
      assert(
        chip.contentWidth <= chip.boxWidth + 1,
        `徽「${chip.word}」完整装下,不需要弯腰(内容 ${chip.contentWidth} ≤ 内容盒 ${chip.boxWidth})`,
      )
    }

    // ③ 反面对照:离谱长名被封顶 + 省略,而不是撑破边框(上面 ① 已经证过它没撑破)。
    const long = measured.chips.find(
      c => c.word.startsWith(LONG_FILE.badgeStartsWith) && c.word.length > 12,
    )
    if (!long) throw new Error('屏幕上没有那个离谱长名的徽 —— 反面对照失效')
    assert(
      Math.abs(long.chipWidth - long.maxWidth) <= 1,
      `离谱长名的徽被上限接住(宽 ${long.chipWidth.toFixed(1)} = max-width ${long.maxWidth}）`,
    )
    assert(
      long.contentWidth > long.boxWidth,
      '它确实在弯腰(内容宽 > 内容盒宽 = 省略号出场),而不是把行挤没',
    )

    // ④ 全列按最宽那颗对齐:所有行的原文从同一条竖线起笔,底部读数行也在同一条线上。
    const lefts = measured.chips.map(c => c.textLeft)
    const spread = Math.max(...lefts) - Math.min(...lefts)
    assert(
      spread <= 0.5,
      `所有行的原文从同一条竖线起笔(最大偏差 ${spread.toFixed(2)}px)—— 徽列按最宽那颗对齐`,
    )
    if (measured.tailLeft !== null) {
      assert(
        Math.abs(measured.tailLeft - lefts[0]) <= 0.5,
        `底部那条读数行的字也在同一条竖线上(偏差 ${Math.abs(measured.tailLeft - lefts[0]).toFixed(2)}px)`,
      )
    }
    await page.screenshot({ path: path.join(shotDir, 'search-badges.png') })

    /*
     * ── ②b 的正面断言:**文件那一档**上,会话 cwd 下种的文件全都在 ──────────
     * 上面量徽是在「所有」那一档(要同时看得见各类的徽)。这里切到文件档再问一次:
     * 这一档的行只可能来自 `files` 能力,而它的扫描根就是壳递过去的那一格
     * `filters.dir`(= 活跃会话的工作目录)。五个种子文件一个都不能少。
     */
    await selectTab(page, FILES_TAB)
    const inFiles = await waitFor('文件档把会话工作目录下的种子文件全搜出来', async () => {
      const state = await measureBadges(page)
      if (state.error) return undefined
      const words = new Set(state.chips.map(c => c.word))
      return BADGE_FILES.every(f => words.has(f.badge)) ? state : undefined
    })
    assert(
      BADGE_FILES.every(f => inFiles.chips.some(c => c.word === f.badge)),
      `文件档搜的是**活跃会话的工作目录**(壳递的 filters.dir):`
        + `${BADGE_FILES.map(f => f.name).join(' / ')} 全都在`,
    )

    await app.close()
    app = undefined
    console.log(
      `\n[search-gate] ok —— 默认档空词浏览态(全量 / 读数 / 翻页,一档没切)`
        + ` + 文件档跟着会话工作目录走(壳递 filters.dir,门里没有补偿)`
        + ` + 行首徽零溢出(截图:${path.relative(appRoot, shotDir)}/)`,
    )
  } finally {
    // 收尸:自己起的每一个进程都在这里逐个杀掉,临时目录一并删干净。
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    if (server && pidAlive(server.pid)) server.kill('SIGKILL')
    await rm(store, { recursive: true, force: true })
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\n[search-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
