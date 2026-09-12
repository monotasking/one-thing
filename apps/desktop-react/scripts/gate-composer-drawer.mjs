#!/usr/bin/env node
/**
 * composer 抽屉的真机门。
 *
 * ══ 09-12 第二批:断言整张换过 ═══════════════════════════════════════════
 * 第一批(9013cf67)量的是「那一段是**长**出来的不是跳出来的」—— 它守的是一条
 * 高度动画真的在跑。用户当天看完的回话把那条判据本身判掉了:
 *
 *   「它太慢了,我能看到它先很短、再慢慢长出来;能不能直接看到一个固定长度、
 *     固定宽度的最终结果」
 *
 * 外加此前那条:「会把内容往上顶,有时顶有时不顶;出现得突兀,像没加载好」。
 *
 * 所以今天这道门量的是**相反的四件事**:
 *
 *  (a) **即显** —— `@` 敲下去之后,抽屉的高从第一次「开着」那一帧起就是最终值
 *      (允许一帧的排版余量),而那个最终值 = `--composer-drawer-h` 解出来的数
 *      (矮窗上再夹一道 `--center-h` 的一半)。
 *  (b) **固定** —— 候选到达前后(loading → ready)、敲字收窄、候选 0 条,
 *      三种情况下抽屉的高**逐样本相同**:一个值,不是一个区间。
 *  (c) **不推正文** —— 开抽屉前后 `chat-stream` 的 `scrollTop`、最后一条消息的
 *      `getBoundingClientRect().top`、以及 `--composer-h` 三样**零变化**;
 *      **贴底跟随与上翻浏览各跑一遍**(病根正是这两种状态下表现不同:
 *      跟随时列表为了继续贴底把正文往上推,浏览时只是被盖住)。
 *  (d) **「无匹配」在 ready 之前从没出现过** —— 候选还在飞时说它就是一句
 *      不成立的话(第一批立的,一个字没改)。
 *  (e) 命令徽之后那个空格真的占了宽度(第一批立的,一个字没改)。
 *  (f) **另两位住户**(模型 / 执行状态)没被落下:它们不吃固定框(高按内容),
 *      但同样浮在面板上方、同样不推正文;顺手量一次接缝 —— 抽屉的下边缘就是
 *      面板的上边缘(一条线,不是两层描边也不是一道缝)。
 *
 * ── 夹具 ──────────────────────────────────────────────────────────────────
 * 两份,各服务一半:
 *   · 工作目录下 80 个同前缀文件 —— `files.list` 的 `FILE_MENTION_LIMIT` 是 50,
 *     所以候选真的会多到框里滚起来(「超量」那一格)。
 *   · `seedLargeLedger` 小档 24 条消息 —— (c) 要一片**滚得动**的聊天流,
 *     否则「贴底」与「上翻」是同一个位置,那道断言空过(照 gate-chat-follow)。
 *
 * **窄 360 与宽 900 各跑一遍**:窄档过 `@container composerDrawer
 * (max-width: 448px)` 那条线,命令行的「用法」那一格会被收掉 —— 一并量。
 *
 * ── 为什么第一发就打 `@<前缀>` 而不是只打一个 `@` ────────────────────────
 * 空词的候选表由**这台机器的搜索根**说了算(home + 下载目录 + 笔记根 + 按会话
 * 解析的接入目录),条数与内容因人而异 —— 拿它当夹具,量的就成了「跑门的人硬盘上
 * 有什么」。带上夹具自己的前缀,读数是确定的,而「loading → ready」那一段一帧没少。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * **窗子一律离屏起**(`ONETHING_GATE_HEADLESS=1`,与 gate-chat-follow / gate-focus
 * 同一手):不 show()、不进 Dock、不抢用户的前台;所有输入都经 CDP,一根手指都不
 * 碰真光标。store 与 `--user-data-dir` 都是临时目录,跑完删干净,**绝不连
 * `~/.onething`**、不连 5175。
 *
 * 这道门量的是**几何**不是**时刻**,所以它留在 headless 那一档(1Hz 节流对
 * 「开抽屉前后这两个数一不一样」没有影响);采样走页内 rAF,节流下帧少但每一帧
 * 仍然是真排版 —— 抽屉若真的在长高,少几帧只会让相邻差更大,判据只会更容易红。
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
import { seedLargeLedger } from './lib/seed-large-ledger.mjs'

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(here, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')

const appRootArg = process.argv.find((arg) => arg.startsWith('--app-root='))
const appRoot = appRootArg ? path.resolve(appRootArg.slice('--app-root='.length)) : here
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

const SESSION_NAME = '抽屉门 · composer'
/** 夹具文件数。> FILE_MENTION_LIMIT(50),所以候选真的会多到框里滚起来。 */
const SEED_FILES = 80
/** 候选前缀 —— 够特别,不会与这台机器上任何真文件撞。 */
const PREFIX = 'zzcand'
/** 一个**一定**命中不到的词:(b) 的第三种情况「候选 0 条」。 */
const NO_HIT = 'zzzz'
/**
 * (c) 那片聊天流的起底。小一档就够 —— 这道门量的是**几何**不是排版账
 * (那是 `gate:chat-layout` 的活),所以尺寸解算、大结果与图片一律关掉。
 * 24 条在 900 与 360 两档上都长过一屏,「贴底」与「上翻」才是两个位置。
 */
const SEED_FIXTURE = {
  messages: 24,
  toolCallsPerTurn: [1, 1],
  targetBytes: 0,
  targetToolCalls: 0,
  largeResults: 0,
  images: 0,
}
/** 两档宽:窄的过 `@container composerDrawer (max-width: 448px)` 那条线。 */
const WIDTHS = [
  { label: '窄 360', width: 360, height: 900, narrow: true },
  { label: '宽 900', width: 900, height: 900, narrow: false },
]
/** 「无匹配」两门语言各一份 —— 门跑在全新 store 上,locale 由这台机器说了算。 */
const NO_MATCH = ['无匹配', 'No match']
/** 几何比对的容差:半个像素。亚像素排版下 0 是量不出来的,0.5 才是「没动」。 */
const EPS = 0.5

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
 * 支一台 rAF 录像机:每一帧记一次**抽屉自己**的高、它开着没有、以及这一帧屏幕上
 * 有没有出现过「无匹配」。
 *
 * ── 为什么量的是抽屉不是整块面板(第一批量的是面板)────────────────────────
 * 这一批之后**面板的高与抽屉开不开无关** —— 那正是 (c) 要证的事。继续量面板,
 * (a)(b) 会因为「面板恒定」而全绿,而那是空过:它证的是这道门选错了尺子。
 *
 * ── 「开着没有」的判据是类名,不是高度 ────────────────────────────────────
 * `drawerOpen` 这个类在改前改后**都在**(改的是它做什么,不是它叫什么),所以
 * 两份产物用同一把尺子。拿「高 > 0」当判据就是替改前那一版把最开头几帧藏起来。
 *
 * 为什么是页内 rAF 而不是外面每 16ms 拉一次:两次拉取之间会插进别的帧,读到的
 * 就不是连着的同一串布局 —— 而这道门比的正是**相邻两帧之间**的差。
 */
async function startRecorder(page) {
  await page.evaluate((noMatch) => {
    /** 抽屉那一格:新产物有 testid,旧产物靠类名认(对照组也要量得到)。 */
    window.__drawerEl = () => {
      const panel = document.querySelector('[data-testid="composer-panel"]')
      if (!panel) return null
      const tagged = panel.querySelector('[data-testid="composer-drawer"]')
      if (tagged) return tagged
      return (
        Array.from(panel.children).find(
          (el) => typeof el.className === 'string' && /drawer/i.test(el.className),
        ) ?? null
      )
    }
    window.__drawer = { samples: [], sawNoMatch: false, stop: false }
    const tick = () => {
      if (window.__drawer.stop) return
      const panel = document.querySelector('[data-testid="composer-panel"]')
      const el = window.__drawerEl()
      if (panel && el) {
        const text = panel.textContent ?? ''
        if (noMatch.some((word) => text.includes(word))) window.__drawer.sawNoMatch = true
        window.__drawer.samples.push({
          t: Math.round(performance.now()),
          h: Math.round(el.getBoundingClientRect().height * 10) / 10,
          op: Math.round(Number.parseFloat(getComputedStyle(el).opacity) * 100) / 100,
          open: /drawerOpen/i.test(String(el.className)),
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

/** 抽屉开着那些帧的高 —— (a)(b) 两条都只看这一串。 */
function openHeights(samples) {
  return samples.filter((s) => s.open).map((s) => s.h)
}

/**
 * 淡入用了多久 —— 从第一帧「开着」到第一帧「不透明了」。
 * 这是**读数**不是判据(节流的机器上帧稀,量出来的只会偏大);判据是下面那条
 * `fadeContract`,它读的是**级联解出来的过渡声明**,一个毫秒的门时间都不含。
 */
function fadeMs(samples) {
  const open = samples.filter((s) => s.open)
  if (!open.length) return undefined
  const opaque = open.find((s) => (s.op ?? 1) >= 0.99)
  return opaque ? opaque.t - open[0].t : undefined
}

/**
 * 抽屉**声明**的过渡:开着的时候它到底在动哪几个属性、动多久。
 * 读的是 `getComputedStyle`(级联解出来的真值,动效档也算在内),不是源文本 ——
 * 所以它同时守得住「有人把 `--dur-drawer` 调回 220」与「有人给 height 加回一条过渡」。
 */
async function fadeContract(page) {
  return page.evaluate(() => {
    const el = window.__drawerEl()
    if (!el) return undefined
    const css = getComputedStyle(el)
    return {
      property: css.transitionProperty,
      duration: css.transitionDuration,
      maxMs: Math.max(
        0,
        ...css.transitionDuration
          .split(',')
          .map((d) => (d.trim().endsWith('ms') ? Number.parseFloat(d) : Number.parseFloat(d) * 1000))
          .filter((n) => Number.isFinite(n)),
      ),
    }
  })
}

/**
 * 这一版产物**说**抽屉该有多高:`min(--composer-drawer-h, --center-h * 0.5)`。
 * 没有那个 token = 对照组(改前那一版),返回 undefined。
 */
async function declaredDrawerHeight(page) {
  return page.evaluate(() => {
    const dock = document.querySelector('[data-testid="composer-dock"]')
    if (!dock) return undefined
    const css = getComputedStyle(dock)
    const px = (name) => {
      const raw = css.getPropertyValue(name).trim()
      const n = Number.parseFloat(raw)
      return raw.endsWith('px') && Number.isFinite(n) ? n : undefined
    }
    const fixed = px('--composer-drawer-h')
    if (fixed === undefined) return undefined
    const center = px('--center-h')
    return center === undefined ? fixed : Math.min(fixed, center * 0.5)
  })
}

/** (c) 的三个读数:滚动位、最后一条消息的上缘、`--composer-h`。 */
async function readGeometry(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector('[data-testid="chat-stream"]')
    const messages = document.querySelectorAll('[data-message-id]')
    const last = messages[messages.length - 1]
    const dock = document.querySelector('[data-testid="composer-dock"]')
    return {
      scrollTop: scroll ? Math.round(scroll.scrollTop * 10) / 10 : null,
      scrollable: scroll ? scroll.scrollHeight - scroll.clientHeight : null,
      lastTop: last ? Math.round(last.getBoundingClientRect().top * 10) / 10 : null,
      composerH: dock
        ? getComputedStyle(dock).getPropertyValue('--composer-h').trim()
        : null,
      messages: messages.length,
    }
  })
}

/** 滚到底 / 从底往上翻一段(与人拖滚动条同一条路径)。 */
async function scrollChat(page, mode) {
  await page.evaluate((how) => {
    const el = document.querySelector('[data-testid="chat-stream"]')
    if (!el) return
    el.scrollTop = how === 'browse' ? Math.max(0, el.scrollHeight - el.clientHeight - 300) : el.scrollHeight
    el.dispatchEvent(new Event('scroll', { bubbles: true }))
  }, mode)
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

  const startCore = async () => {
    const child = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, ONETHING_STORE_PATH: store },
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const err = []
    child.stderr.on('data', (chunk) => err.push(chunk.toString()))
    const record = await waitFor('core 写出发现文件', () => {
      const got = readDiscovery(store)
      return got && got.pid === child.pid ? got : undefined
    }).catch((error) => {
      throw new Error(`${error.message}\nserver stderr:\n${err.join('')}`)
    })
    if (!(await portConnects(record.host, record.port))) throw new Error('core 端口连不上')
    return { child, record }
  }
  const stopCore = async (child) => {
    if (!child) return
    child.kill('SIGTERM')
    await delay(600)
    if (!child.killed) child.kill('SIGKILL')
  }

  try {
    console.log(`\n[1/6] 种 ${SEED_FILES} 个候选文件 + 一台 core`)
    mkdirSync(workdir, { recursive: true })
    for (let i = 0; i < SEED_FILES; i += 1) {
      writeFileSync(path.join(workdir, `${PREFIX}-${String(i).padStart(2, '0')}.txt`), 'x')
    }
    writeFileSync(
      path.join(store, 'settings.json'),
      JSON.stringify({ diagnostics: { enabled: false } }, null, 2),
    )

    let core = await startCore()
    server = core.child
    const made = await rpc(core.record, 'sessions', 'create', { name: SESSION_NAME })
    const sessionId = made?.session?.id
    if (!sessionId) throw new Error('sessions.create 没给出会话 id')
    // 工作目录 = 夹具那一堆文件所在的地方(`@` 候选按它筛,判据见 file-mentions-source)。
    await rpc(core.record, 'sessions', 'updateWorkingDirectory', {
      sessionId,
      workingDirectory: workdir,
    })

    /*
     * **趁 core 停着写账本**:活着的 core 会按字节大小认出「外来写手」并抛
     * `SessionEventWriteError`;停一次再起 = 冷读一遍,那道闸压根不碰
     * (与 gate-chat-follow 逐字同一手)。
     */
    console.log('[2/6] 停 core,直写一片滚得动的聊天流,再起')
    await stopCore(server)
    const seeded = seedLargeLedger(store, sessionId, SEED_FIXTURE)
    core = await startCore()
    server = core.child
    console.log(
      `      起底:${(seeded.bytes / 1024).toFixed(0)}KB / ${seeded.messages} 条 / ${seeded.toolCalls} 张卡`,
    )

    console.log('[3/6] 拉起应用(离屏 · 独立 --user-data-dir),进那条会话')
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
    await waitFor('聊天流折出那些消息', () =>
      page.evaluate(() => document.querySelectorAll('[data-message-id]').length >= 4),
    )
    await delay(800)

    console.log('\n[4/6] (a)(b)(c)(d) 两档宽各跑一遍')
    const report = []
    for (const size of WIDTHS) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: size.width,
        height: size.height,
        deviceScaleFactor: 1,
        mobile: false,
      })
      await delay(600)
      await clearInput(page)
      await delay(300)
      await startRecorder(page)

      /* ── (a) 开抽屉:一发把 `@<前缀>` 打进去,采 800ms ───────────────────── */
      await focusInput(page)
      await cdp.send('Input.insertText', { text: `@${PREFIX}` })
      await delay(800)
      const opened = await readRecorder(page)
      const declared = await declaredDrawerHeight(page)
      const fade = await fadeContract(page)
      const fadeSampled = fadeMs(opened.samples)
      const openH = openHeights(opened.samples)
      const finalH = openH.length ? openH[openH.length - 1] : 0
      /** 从第一帧「开着」到第一次达到最终值,中间隔了几个采样(0 = 第一帧就是)。 */
      const settleAt = openH.findIndex((h) => Math.abs(h - finalH) <= EPS)
      const rowsOpen = await page.evaluate(
        () => document.querySelectorAll('[data-testid="composer-panel"] button').length,
      )

      /* ── (b) 三种情况:候选到齐前后已经在上面那 800ms 里;再收窄两次、再打一个
       *      一定落空的词。三段的开着帧**合起来**只许有一个高度值。 */
      await cdp.send('Input.insertText', { text: '-1' })
      await delay(400)
      const narrowed1 = await readRecorder(page)
      await cdp.send('Input.insertText', { text: '9' })
      await delay(400)
      const narrowed2 = await readRecorder(page)
      await clearInput(page)
      await delay(250)
      await focusInput(page)
      await cdp.send('Input.insertText', { text: `@${NO_HIT}` })
      await delay(700)
      const empty = await readRecorder(page)

      const allOpen = [
        ...openH,
        ...openHeights(narrowed1.samples),
        ...openHeights(narrowed2.samples),
        ...openHeights(empty.samples),
      ]
      const distinct = [...new Set(allOpen.map((h) => Math.round(h)))].sort((a, b) => a - b)
      const sawNoMatch =
        opened.sawNoMatch || narrowed1.sawNoMatch || narrowed2.sawNoMatch
      const emptySawNoMatch = empty.sawNoMatch

      /* ── 用法那一格看不看得见 —— **要开的是命令抽屉**,不是文件候选那一列。 */
      await clearInput(page)
      await delay(250)
      await focusInput(page)
      await cdp.send('Input.insertText', { text: '/cd' })
      await delay(400)
      const usageShown = await page.evaluate(() => {
        /* 量的是它占不占地方,不是 textContent 里有没有它 —— `display: none`
         * 的元素照样进 textContent。 */
        const panel = document.querySelector('[data-testid="composer-panel"]')
        if (!panel) return false
        return Array.from(panel.querySelectorAll('span')).some(
          (el) =>
            (el.textContent ?? '').trim() === '/cd <path>'
            && el.getBoundingClientRect().width > 0,
        )
      })
      await clearInput(page)
      await delay(300)
      await stopRecorder(page)

      console.log(
        `\n  【${size.label}】开抽屉后 ${rowsOpen} 个候选行 · 这一版声明的框高 `
          + `${declared === undefined ? '—(对照组:没有 --composer-drawer-h)' : `${Math.round(declared)}px`}\n`
          + `    (a) 开着的帧:${openH.length} 个;高度序列前 6 个 ${JSON.stringify(openH.slice(0, 6))}`
          + ` → 最终 ${finalH}px,第 ${settleAt} 个采样到位\n`
          + `    (a) 淡入:声明 ${fade?.duration ?? '—'}(属性 ${fade?.property ?? '—'}),采样到不透明用了 ${fadeSampled ?? '—'}ms\n`
          + `    (b) 四段合起来出现过的高度:${JSON.stringify(distinct)}\n`
          + `    (d)「无匹配」在候选飞行期出现过:${sawNoMatch}`,
      )

      assert(
        rowsOpen >= 20,
        `${size.label}:抽屉真的长成了一整列(${rowsOpen} 个候选行 —— 夹具 ${SEED_FILES} 个文件,后端封顶 50)`,
      )

      // (a) 即显:第一帧「开着」就是最终值,最多让一帧的排版余量。
      assert(
        openH.length > 0 && settleAt >= 0 && settleAt <= 1,
        `${size.label} (a):开出来就是最终大小(第 ${settleAt} 个采样到位 ≤ 1;`
          + `开着的帧共 ${openH.length} 个,最终 ${finalH}px)`,
      )
      // (a) 的另一半:那个最终值就是这一版**声明**的框高,不是内容碰巧撑出来的。
      if (declared === undefined) {
        console.log('  · 这份产物里没有 --composer-drawer-h —— 框高那条断言跳过(对照组)')
      } else {
        assert(
          Math.abs(finalH - declared) <= 1,
          `${size.label} (a):最终高 = min(--composer-drawer-h, --center-h/2) 解出来的那个数`
            + `(量到 ${finalH}px,声明 ${Math.round(declared)}px,差 ${Math.round(Math.abs(finalH - declared) * 10) / 10}px ≤ 1)`,
        )
      }
      /*
       * (a) 的第三半:**出现那一下只许淡入,而且要短**。
       * 高度那两条守的是几何,这一条守的是**时间** —— 抽屉即便一帧到位,配上一条
       * 220ms 的淡入照样读作「正在出现」。120ms 是上限不是目标(今天 `--dur-drawer`
       * 是 80);超过它,或者过渡里再出现 height / grid-template-rows,当场红。
       */
      assert(
        fade !== undefined
          && fade.maxMs <= 120
          && !/height|grid-template-rows/.test(fade.property),
        `${size.label} (a):出现那一下只淡入且 ≤ 120ms`
          + `(声明 ${fade?.duration ?? '—'} / 属性 ${fade?.property ?? '—'};采样 ${fadeSampled ?? '—'}ms)`,
      )
      // (b) 固定:loading→ready、收窄两次、0 条,四段合起来只许一个高度值。
      assert(
        distinct.length === 1,
        `${size.label} (b):候选到达前后 / 敲字收窄 / 0 条,抽屉高**逐样本相同**`
          + `(出现过的高度 ${JSON.stringify(distinct)},只许一个)`,
      )
      // (d) 候选在飞时从来没说过「无匹配」。
      assert(
        !sawNoMatch,
        `${size.label} (d):候选在飞时没画过「无匹配」(那是一句不成立的话)`,
      )
      // (d) 的补票:真的 0 条时它**该**出现 —— 否则上一条靠「这句话根本没实现」空过。
      assert(
        emptySawNoMatch,
        `${size.label} (d):真的一条都没有时「无匹配」出得来(上一条不许靠「没实现」而绿)`,
      )

      /* ── (c) 不推正文:贴底跟随 / 上翻浏览各一遍 ─────────────────────────── */
      for (const mode of ['pinned', 'browse']) {
        await clearInput(page)
        await delay(250)
        await scrollChat(page, mode)
        await delay(500)
        const before = await readGeometry(page)
        await focusInput(page)
        await cdp.send('Input.insertText', { text: `@${PREFIX}` })
        await delay(800)
        const after = await readGeometry(page)
        await clearInput(page)
        await delay(300)

        const label = mode === 'pinned' ? '贴底跟随' : '上翻浏览'
        console.log(
          `    (c)【${size.label} · ${label}】scrollTop ${before.scrollTop} → ${after.scrollTop}`
            + ` / 末条上缘 ${before.lastTop} → ${after.lastTop}`
            + ` / --composer-h ${before.composerH} → ${after.composerH}`
            + ` / 可滚 ${Math.round(before.scrollable ?? 0)}px`,
        )
        // 夹具真的滚得动,否则下面三条全是「什么都没发生」的空过。
        assert(
          (before.scrollable ?? 0) > 200 && (before.messages ?? 0) >= 4,
          `${size.label} · ${label}:这片聊天流真的滚得动(可滚 ${Math.round(before.scrollable ?? 0)}px > 200,${before.messages} 条)`,
        )
        assert(
          before.scrollTop !== null
            && after.scrollTop !== null
            && Math.abs(after.scrollTop - before.scrollTop) <= EPS,
          `${size.label} · ${label} (c):开抽屉不动 scrollTop(${before.scrollTop} → ${after.scrollTop})`,
        )
        assert(
          before.lastTop !== null
            && after.lastTop !== null
            && Math.abs(after.lastTop - before.lastTop) <= EPS,
          `${size.label} · ${label} (c):最后一条消息**一像素不动**(上缘 ${before.lastTop} → ${after.lastTop})`,
        )
        assert(
          before.composerH !== null && before.composerH === after.composerH,
          `${size.label} · ${label} (c):--composer-h 开抽屉前后相同(${before.composerH} → ${after.composerH})`,
        )
      }

      report.push({ ...size, rowsOpen, distinct, usageShown })
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

    /*
     * ── (f) 另两位住户:模型 / 执行状态 ────────────────────────────────────
     * 「一个槽四种住户」是这块面的骨架。上面四条量的全是**打字驱动**那两位;
     * 这一条守的是另两位没有被落下 —— 它们不吃固定框(高按内容),但**同样浮在
     * 面板上方、同样不推正文**。少了它,「四位共用一个槽」就只有两位被门看着。
     *
     * 它顺手证一件几何:抽屉的**下边缘就是面板的上边缘**(接缝处一条线,不是
     * 两层描边也不是一道缝)—— 这件事在固定框那两位身上同样成立,而这里量一次
     * 就够:两位共用同一条 `.drawer` 规则。
     */
    console.log('\n[5/6] (f) 模型抽屉:不吃固定框,但同样浮在上方、同样不推正文')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await delay(300)
    await clearInput(page)
    await scrollChat(page, 'pinned')
    await delay(500)
    const beforeModel = await readGeometry(page)
    const openedModel = await page.evaluate(() => {
      /* 模型药丸没有 testid,但它是这块面里唯一带 `aria-expanded` 的钮
       * (状态条那一枚只在有执行流水时才在,这条门跑在一条闲着的会话上)。 */
      const pill = document.querySelector('[data-testid="composer-panel"] button[aria-expanded]')
      if (!(pill instanceof HTMLElement)) return false
      pill.click()
      return true
    })
    await delay(600)
    const modelShape = await page.evaluate(() => {
      const el = window.__drawerEl()
      const panel = document.querySelector('[data-testid="composer-panel"]')
      if (!el || !panel) return undefined
      const a = el.getBoundingClientRect()
      const b = panel.getBoundingClientRect()
      return {
        open: /drawerOpen/i.test(String(el.className)),
        fixed: /drawerFixed/i.test(String(el.className)),
        h: Math.round(a.height * 10) / 10,
        seam: Math.round((a.bottom - b.top) * 10) / 10,
      }
    })
    const afterModel = await readGeometry(page)
    console.log(
      `  现场:${JSON.stringify(modelShape)} · --composer-h ${beforeModel.composerH} → ${afterModel.composerH}`
        + ` · scrollTop ${beforeModel.scrollTop} → ${afterModel.scrollTop}`,
    )
    assert(
      openedModel && modelShape?.open === true && (modelShape?.h ?? 0) > 40,
      `(f) 模型抽屉开得出来(高 ${modelShape?.h ?? '—'}px > 40)`,
    )
    assert(
      modelShape?.fixed === false,
      `(f) 它**不**吃固定框 —— 高按内容(右栏那张卡定),固定框只给打字驱动的两位`,
    )
    assert(
      modelShape !== undefined && Math.abs(modelShape.seam) <= 1,
      `(f) 接缝:抽屉下缘就是面板上缘(差 ${modelShape?.seam ?? '—'}px ≤ 1 —— 一条线,不是两层描边也不是一道缝)`,
    )
    assert(
      beforeModel.composerH === afterModel.composerH
        && Math.abs((afterModel.scrollTop ?? 0) - (beforeModel.scrollTop ?? 0)) <= EPS
        && Math.abs((afterModel.lastTop ?? 0) - (beforeModel.lastTop ?? 0)) <= EPS,
      `(f) 它同样不推正文(--composer-h ${beforeModel.composerH} → ${afterModel.composerH};`
        + `scrollTop ${beforeModel.scrollTop} → ${afterModel.scrollTop};末条上缘 ${beforeModel.lastTop} → ${afterModel.lastTop})`,
    )
    await page.evaluate(() => {
      const pill = document.querySelector('[data-testid="composer-panel"] button[aria-expanded="true"]')
      if (pill instanceof HTMLElement) pill.click()
    })
    await delay(300)

    console.log('\n[6/6] (e) 补全一条命令之后,那个空格真的占了宽度')
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
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp.send('Input.dispatchKeyEvent', {
        type,
        windowsVirtualKeyCode: 13,
        key: 'Enter',
        code: 'Enter',
      })
    }
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
      `(e) 命令徽之后那个空格真的占了宽度(${gap.width ?? '—'}px > 0;white-space=${gap.whiteSpace ?? '—'})`,
    )
  } finally {
    if (app) await app.close().catch(() => undefined)
    await stopCore(server)
    await rm(store, { recursive: true, force: true }).catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined)
  }

  if (failures.length) {
    console.error(`\n[drawer-gate] FAILED —— ${failures.length} 条:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log(
    '\n[drawer-gate] ok —— 抽屉一出来就是最终大小、框不随内容变、开合不动正文一个像素',
  )
}

main().catch((error) => {
  console.error(`\n[drawer-gate] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
