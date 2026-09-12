#!/usr/bin/env node
/**
 * composer 抽屉的真机门(09-12,用户报障「command / file 出现的动画很突兀」
 * 与「补全命令后没有空格」)。
 *
 * jsdom 那一半量的是**判据写了什么**(`DrawerPickList` 的四态、`argHintOf` 的
 * 解析表、`ComposerInput.test.tsx` 的草稿口)。这道门量的是**真的排版之后**
 * 那几件只有浏览器说得出来的事:
 *
 *  ① 抽屉打开之后**没有「先出一行再长整列」的两段跳** —— 高度序列的相邻差里
 *     比一行还大的跳变最多一次(留一帧掉帧的余量),而且那一段真的**动了好几帧**
 *     (瞬跳只会留下一个差,动画会留下十几个);
 *  ② 敲字收窄候选时高度**连续** —— 相邻采样差的最大值 < 整列高度的 50%;
 *  ③ 从头到尾**没画过「无匹配」** —— 候选还在飞的时候说「无匹配」是一句不成立
 *     的话,而「先说一句不成立的话再改口」正是报障里那份突兀;
 *  ④ 补全一条命令之后,**那个空格真的占了宽度**(`white-space: pre-wrap` 那条
 *     修法的真机一半 —— jsdom 量不出空白折叠)。
 *
 * ── 超量与两档宽 ──────────────────────────────────────────────────────────
 * 夹具是 80 个同前缀的文件落在这条会话的工作目录下,`files.list` 的
 * `FILE_MENTION_LIMIT` 是 50,所以抽屉真的会长到封顶那一档(`--composer-drawer-max`
 * 与中央区 40% 取小)。**窄 360 与宽 900 各跑一遍**:窄档过 `@container
 * composerDrawer (max-width: 448px)` 那条线,用法那一格会被收掉 —— 一并量。
 *
 * ── 为什么第一发就打 `@zzcand` 而不是只打一个 `@` ────────────────────────
 * 空词的候选表由**这台机器的搜索根**说了算(桌面那侧是 home + 下载目录 + 笔记根
 * + 按会话解析的接入目录),条数与内容因人而异 —— 拿它当夹具,这道门量的就成了
 * 「跑门的人硬盘上有什么」。所以第一发就带上夹具自己的前缀:两段跳那件事一个字
 * 没少(候选从零 → 一行「正在找…」→ 50 行),而读数是确定的。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * **窗子一律离屏起**(`ONETHING_GATE_HEADLESS=1`,与 gate-chat-follow / gate-focus
 * 同一手):不 show()、不进 Dock、不抢用户的前台;所有输入都经 CDP,一根手指都不
 * 碰真光标。store 与 `--user-data-dir` 都是临时目录,跑完删干净,**绝不连
 * `~/.onething`**、不连 5175。
 *
 * 跑法:`npm run gate:composer-drawer`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * `--app-root=<path>` 指向另一份检出的构建产物 —— 「改前 / 改后」对照就是这么跑的
 * (对照用 `git worktree`,**不用 `git stash`**:旁边还有别的批在改同一棵树)。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(here, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')

const appRootArg = process.argv.find((arg) => arg.startsWith('--app-root='))
const appRoot = appRootArg ? path.resolve(appRootArg.slice('--app-root='.length)) : here
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

const SESSION_NAME = '抽屉门 · composer'
/** 夹具文件数。> FILE_MENTION_LIMIT(50),所以候选真的会被后端截到封顶那一档。 */
const SEED_FILES = 80
/** 候选前缀 —— 够特别,不会与这台机器上任何真文件撞。 */
const PREFIX = 'zzcand'
/** 两档宽:窄的过 `@container composerDrawer (max-width: 448px)` 那条线。 */
const WIDTHS = [
  { label: '窄 360', width: 360, height: 900, narrow: true },
  { label: '宽 900', width: 900, height: 900, narrow: false },
]
/** 「无匹配」两门语言各一份 —— 门跑在全新 store 上,locale 由这台机器说了算。 */
const NO_MATCH = ['无匹配', 'No match']

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
    await delay(120)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}

const failures = []
function assert(condition, message) {
  if (condition) console.log(`  ✓ ${message}`)
  else {
    console.log(`  ✗ ${message}`)
    failures.push(message)
  }
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

/** 点一个 testid(不用 page.click:不动真光标、不抢焦点)。 */
async function clickTestId(page, testId) {
  const clicked = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    el.click()
    return true
  }, testId)
  if (!clicked) throw new Error(`点不到:[data-testid="${testId}"] 不在 DOM 里`)
}

/**
 * 支一台 rAF 录像机:每一帧记一次玻璃面板的高、候选行数、以及**这一帧屏幕上
 * 有没有出现过「无匹配」**。
 *
 * 为什么是页内 rAF 而不是外面每 16ms 拉一次:两次拉取之间会插进别的帧,读到的
 * 就不是连着的同一串布局 —— 而这道门比的正是**相邻两帧之间**的差。
 * (与 gate-chat-follow 的丸录像机同一条纪律:短命的读数必须在它活着的时候取。)
 */
async function startRecorder(page) {
  await page.evaluate((noMatch) => {
    window.__drawer = { samples: [], sawNoMatch: false, stop: false }
    const tick = () => {
      if (window.__drawer.stop) return
      const panel = document.querySelector('[data-testid="composer-panel"]')
      if (panel) {
        const rect = panel.getBoundingClientRect()
        const text = panel.textContent ?? ''
        if (noMatch.some((word) => text.includes(word))) window.__drawer.sawNoMatch = true
        window.__drawer.samples.push({
          t: performance.now(),
          h: Math.round(rect.height * 10) / 10,
          rows: panel.querySelectorAll('button').length,
        })
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, NO_MATCH)
}

async function readRecorder(page, { reset = true } = {}) {
  return page.evaluate((doReset) => {
    const got = {
      samples: window.__drawer.samples.slice(),
      sawNoMatch: window.__drawer.sawNoMatch,
    }
    if (doReset) window.__drawer.samples = []
    return got
  }, reset)
}

async function stopRecorder(page) {
  await page.evaluate(() => {
    if (window.__drawer) window.__drawer.stop = true
  })
}

/** 一串高度读数的形状:总增长、相邻差的最大值、大于一行的跳变有几次、动了几帧。 */
function shapeOf(samples, rowHeight) {
  const heights = samples.map((s) => s.h)
  if (heights.length < 2) return { span: 0, maxStep: 0, bigJumps: 0, movingFrames: 0, heights }
  let maxStep = 0
  let bigJumps = 0
  let movingFrames = 0
  for (let i = 1; i < heights.length; i += 1) {
    const step = Math.abs(heights[i] - heights[i - 1])
    if (step > maxStep) maxStep = step
    if (step > rowHeight) bigJumps += 1
    if (step > 0.5) movingFrames += 1
  }
  return {
    span: Math.max(...heights) - Math.min(...heights),
    maxStep: Math.round(maxStep * 10) / 10,
    bigJumps,
    movingFrames,
    heights,
  }
}

/** 候选行的行高(取抽屉里那些按钮的中位数)—— 判「比一行还大的跳变」用它。 */
async function rowHeightOf(page) {
  const got = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="composer-panel"]')
    if (!panel) return []
    return Array.from(panel.querySelectorAll('button'))
      .map((el) => el.getBoundingClientRect().height)
      .filter((h) => h > 12 && h < 80)
      .sort((a, b) => a - b)
  })
  if (!got.length) return 32
  return Math.round(got[Math.floor(got.length / 2)])
}

/** 把光标放进输入框(真的 focus,但只在这个离屏窗口里)。 */
async function focusInput(page) {
  await page.evaluate(() => {
    const box = document.querySelector('[data-testid="composer-input"]')
    if (box instanceof HTMLElement) {
      box.focus()
      const range = document.createRange()
      range.selectNodeContents(box)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  })
}

async function clearInput(page) {
  await page.evaluate(() => {
    const box = document.querySelector('[data-testid="composer-input"]')
    if (box instanceof HTMLElement) {
      box.innerHTML = ''
      box.dispatchEvent(new Event('input', { bubbles: true }))
    }
  })
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[drawer-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error(`[drawer-gate] ${appRoot} 下找不到构建产物 —— 先跑 \`npm run app:build\``)
    process.exit(1)
  }
  console.log(`[drawer-gate] 被测产物:${appRoot}`)

  const store = await mkdtemp(path.join(tmpdir(), 'drawer-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'drawer-udd-'))
  const workdir = await mkdtemp(path.join(tmpdir(), 'drawer-cwd-'))
  let server
  let app
  try {
    console.log(`\n[1/4] 种 ${SEED_FILES} 个候选文件 + 一台 core`)
    mkdirSync(workdir, { recursive: true })
    for (let i = 0; i < SEED_FILES; i += 1) {
      writeFileSync(path.join(workdir, `${PREFIX}-${String(i).padStart(2, '0')}.txt`), 'x')
    }
    writeFileSync(
      path.join(store, 'settings.json'),
      JSON.stringify({ diagnostics: { enabled: false } }, null, 2),
    )

    server = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, ONETHING_STORE_PATH: store },
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serverErr = []
    server.stderr.on('data', (chunk) => serverErr.push(chunk.toString()))
    const record = await waitFor('core 写出发现文件', () => {
      const got = readDiscovery(store)
      return got && got.pid === server.pid ? got : undefined
    }).catch((error) => {
      throw new Error(`${error.message}\nserver stderr:\n${serverErr.join('')}`)
    })
    if (!(await portConnects(record.host, record.port))) throw new Error('core 端口连不上')

    const made = await rpc(record, 'sessions', 'create', { name: SESSION_NAME })
    const sessionId = made?.session?.id
    if (!sessionId) throw new Error('sessions.create 没给出会话 id')
    // 工作目录 = 夹具那一堆文件所在的地方(`@` 候选按它筛,判据见 file-mentions-source)。
    await rpc(record, 'sessions', 'updateWorkingDirectory', {
      sessionId,
      workingDirectory: workdir,
    })

    console.log('[2/4] 拉起应用(离屏 · 独立 --user-data-dir),进那条会话')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: '',
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
    await waitFor('Dock 上的「会话总览」瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
    )
    const rowShown = () =>
      page.evaluate(
        (id) => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)),
        sessionId,
      )
    for (let attempt = 0; attempt < 3 && !(await rowShown()); attempt += 1) {
      await clickTestId(page, 'dock-tile-sessions')
      await delay(500)
    }
    await waitFor('总览画出那一行', rowShown)
    await clickTestId(page, `session-row-${sessionId}`)
    await waitFor('输入框就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-input"]'))),
    )
    await delay(600)

    console.log('\n[3/4] ①②③ 两档宽各跑一遍')
    const report = []
    for (const size of WIDTHS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: size.width,
        height: size.height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await delay(500)
      await clearInput(page)
      await delay(300)
      await startRecorder(page)

      // ── 开抽屉:一发把 `@<前缀>` 打进去(为什么不是只打一个 `@`,见文件头)。
      await focusInput(page)
      await cdp.send('Input.insertText', { text: `@${PREFIX}` })
      await delay(800)
      const open = await readRecorder(page)
      const rowH = await rowHeightOf(page)
      const openShape = shapeOf(open.samples, rowH)
      const rowsOpen = await page.evaluate(
        () =>
          document.querySelectorAll('[data-testid="composer-panel"] button').length,
      )

      /*
       * ── 敲字收窄:`-19` 把封顶的那一列收到**一条**。
       *
       * 第一版打的是 `-1`(50 → 10 条):10 行仍然高过 `.pickScroll` 的封顶,
       * 高度于是一动不动,②那条断言**空过** —— 一条靠「什么都没发生」而绿的守卫
       * 不算守住(与检索面第四条不变量那条判例同一个坑)。收到一条才真的掉下
       * 封顶线,那一段是不是长出来的才有得看。
       */
      await cdp.send('Input.insertText', { text: '-19' })
      await delay(400)
      const typed = await readRecorder(page)
      const typeShape = shapeOf(typed.samples, rowH)
      const fullList = Math.max(openShape.span, 1)

      /*
       * 用法那一格看不看得见 —— **要开的是命令抽屉**,不是刚才那一列文件候选。
       * (第一版写在文件那一趟的末尾,于是两档都答「没有用法」:量错了住户。)
       */
      await clearInput(page)
      await delay(250)
      await focusInput(page)
      await cdp.send('Input.insertText', { text: '/cd' })
      await delay(400)
      const usageShown = await page.evaluate(() => {
        /*
         * **量的是它占不占地方,不是 textContent 里有没有它** —— `display: none`
         * 的元素照样进 textContent,第一版就是这么两档都答「看得见」的。
         */
        const panel = document.querySelector('[data-testid="composer-panel"]')
        if (!panel) return false
        return Array.from(panel.querySelectorAll('span')).some(
          (el) =>
            (el.textContent ?? '').trim() === '/cd <path>'
            && el.getBoundingClientRect().width > 0,
        )
      })

      console.log(
        `\n  【${size.label}】行高 ${rowH}px · 开抽屉后 ${rowsOpen} 个候选行\n`
          + `    开:增长 ${Math.round(openShape.span)}px / 最大相邻差 ${openShape.maxStep}px`
          + ` / 大跳 ${openShape.bigJumps} 次 / 动了 ${openShape.movingFrames} 帧\n`
          + `    敲:变化 ${Math.round(typeShape.span)}px / 最大相邻差 ${typeShape.maxStep}px`
          + ` / 大跳 ${typeShape.bigJumps} 次 / 动了 ${typeShape.movingFrames} 帧\n`
          + `    「无匹配」出现过:${open.sawNoMatch || typed.sawNoMatch}`,
      )

      assert(
        rowsOpen >= 20,
        `${size.label}:抽屉真的长成了一整列(${rowsOpen} 个候选行 —— 夹具 ${SEED_FILES} 个文件,后端封顶 50)`,
      )
      /*
       * ① 两段跳。两条一起:**次数**(比一行还大的跳变最多一次,留一帧掉帧的
       * 余量)与**幅度**(那一次也不许超过整段增长的四分之一)。
       *
       * 只数次数是**抓不住这条病**的 —— 对照组实测:改前那一下是 0 → 244.5px
       * **一帧到位**,而它也只算「一次大跳」,照样绿。判据得说出「那一下有多大」:
       * 改前 244.5/329 = 74%,改后 34.7–41.4/329 = 10.5–12.6%。
       */
      assert(
        openShape.bigJumps <= 1 && openShape.maxStep < openShape.span * 0.25,
        `${size.label} ①:开抽屉没有「先出一行再长整列」的两段跳`
          + `(大跳 ${openShape.bigJumps} 次 ≤ 1,最大那一下 ${openShape.maxStep}px`
          + ` = 整段 ${Math.round(openShape.span)}px 的 ${Math.round((openShape.maxStep / Math.max(openShape.span, 1)) * 100)}% < 25%)`,
      )
      // ① 的另一半:它真的**动了**,不是一帧到位。
      assert(
        openShape.movingFrames >= 5,
        `${size.label} ①:那一段是长出来的不是跳出来的(动了 ${openShape.movingFrames} 帧 ≥ 5)`,
      )
      // ② 敲字之后的变化连续。
      assert(
        typeShape.maxStep < fullList * 0.5,
        `${size.label} ②:敲字后高度连续(最大相邻差 ${typeShape.maxStep}px < 整列 ${Math.round(fullList)}px 的一半)`,
      )
      // ③ 从来没说过「无匹配」。
      assert(
        !open.sawNoMatch && !typed.sawNoMatch,
        `${size.label} ③:从头到尾没画过「无匹配」(候选在飞时说它就是一句不成立的话)`,
      )
      report.push({ ...size, rowH, rowsOpen, openShape, typeShape, usageShown })
      await clearInput(page)
      await delay(300)
    }

    // 窄档收掉用法那一格,宽档画它(那条 `@container` 的真机一半)。
    const narrow = report.find((r) => r.narrow)
    const wide = report.find((r) => !r.narrow)
    if (wide?.usageShown) {
      assert(
        !narrow?.usageShown,
        `窄档收掉命令行的「用法」那一格(@container 448 那条线;宽档看得见=${wide.usageShown}、窄档=${narrow?.usageShown})`,
      )
    } else {
      console.log('  · 这份产物里命令行还没有「用法」那一格 —— 窄档那条断言跳过(对照组)')
    }

    console.log('\n[4/4] ④ 补全一条命令之后,那个空格真的占了宽度')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await delay(300)
    await clearInput(page)
    await focusInput(page)
    await cdp.send('Input.insertText', { text: '/cd' })
    await delay(500)
    // ↵ 选中抽屉里键盘位那一行(这块可编辑区自己接的结构键)。
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 13,
      key: 'Enter',
      code: 'Enter',
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      windowsVirtualKeyCode: 13,
      key: 'Enter',
      code: 'Enter',
    })
    await delay(400)
    const gap = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="composer-input"]')
      if (!box) return { ok: false, reason: '输入框不在' }
      const chip = box.querySelector('span[contenteditable="false"]')
      if (!chip) return { ok: false, reason: '命令徽没插进去', text: box.textContent }
      let node = chip.nextSibling
      while (node && node.nodeType !== Node.TEXT_NODE) node = node.nextSibling
      if (!node) return { ok: false, reason: '命令徽后面没有文本节点' }
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, Math.min(1, node.textContent?.length ?? 0))
      const rect = range.getBoundingClientRect()
      return {
        ok: true,
        raw: JSON.stringify(node.textContent),
        width: Math.round(rect.width * 100) / 100,
        whiteSpace: getComputedStyle(box).whiteSpace,
      }
    })
    console.log(`  现场:${JSON.stringify(gap)}`)
    assert(
      gap.ok === true && gap.width > 0,
      `④ 命令徽之后那个空格真的占了宽度(${gap.width ?? '—'}px > 0;white-space=${gap.whiteSpace ?? '—'})`,
    )

    await stopRecorder(page)
  } finally {
    if (app) await app.close().catch(() => undefined)
    if (server) server.kill('SIGTERM')
    await delay(400)
    if (server && !server.killed) server.kill('SIGKILL')
    await rm(store, { recursive: true, force: true }).catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined)
  }

  if (failures.length) {
    console.error(`\n[drawer-gate] FAILED —— ${failures.length} 条:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\n[drawer-gate] ok —— 抽屉的高度是长出来的,候选在飞时不说「无匹配」,补全后的空格看得见')
}

main().catch((error) => {
  console.error(`\n[drawer-gate] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
