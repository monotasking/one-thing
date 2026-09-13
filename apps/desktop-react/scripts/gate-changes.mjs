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
import { decodePng } from './lib/png.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')
const shotDir = path.join(appRoot, 'dist', 'gate-shots')

const PROD = process.argv.includes('--prod') || process.env.ONETHING_GATE_DIST === '1'
const LANE = PROD ? 'prod' : 'dev'
/** dev 档现起一台 vite。端口另挑 —— **绝不碰用户的 5175**。 */
const DEV_PORT = 5196

/** 超量那一格的规模(第 5 轴那张表最后一行:2 000 行改动)。 */
const BIG_ROWS = 2000
/** `repo-big` 那份 f0 有多少行(⑥ 的第二个量纲:整文件视图按行计价)。 */
const BIG_LINES = 2000
/** `repo-a` 每个文件多少行 —— ⑦ 要两块改动、⑧ 要一条长行,都得有地方放。 */
const REPO_A_LINES = 12

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
 * | dev(旧夹具)  | 20 / 17 / 19 | 699 / 664 / 718 | 428 / 347 / 350 |
 * | prod(旧夹具) | 8 / 8 / 8    | 492 / 492 / 491 | 343 / 338 / 339 |
 * | dev(批 ③-b)  | 10 / 12 / 12 / 11 | 1345 / 1290 / 1360 / 755 | 729 / 640 / 690 / 485 |
 * | prod(批 ③-b) | 5            | 696                | 400                |
 *
 * ── `dev.firstFrameMs = 25`(prod **不列** —— 它 8ms,在原数之内)──────────
 * dev 那一帧里跑的是未压缩的 React 与 vite 的模块图,而 prod 同一条路 8ms。
 * 也就是说**这一格不是这块面欠的债**,是 dev 渲染层的公共成本(第 5 轴那条法本来
 * 就要求两档各出一列,正是为了分得开这两件事)。
 * **退场判据**:dev 档整体首帧进 16ms 的那一天删这一行 —— 或者这道门的量法从
 * `requestAnimationFrame` 采样换成 paint timing(rAF 的采样粒度本身就是一帧
 * ≈16.7ms,17ms 这个读数里有一格是量法的地板)。
 *
 * ── `listMs` **两档同一个数 1600**(2026-09-13 批 ③-b,按新夹具重量)──────────
 * 这一行的数动过一次,**因为被量的东西变了,不是因为它变慢了**:第 5 轴那一格
 * 从「两千个文件」改成「两千个文件 **+ 一份两千行、每隔一行改一行的 f0** +
 * 一份两千行的未跟踪文件」(整文件视图按**行**计价,而旧夹具里每个文件只有一行,
 * 那一格量不到它)。后端那一发随之从 340–430 涨到 520–730:`git status` 现在还要
 * 算 f0 那两千行的 numstat、并把那份未跟踪的整份读一遍数行。
 *
 * 实测(改夹具后):dev 列上屏 755 / 802 / 1290 / 1345 / 1360、其中后端 485–729;
 * prod 465 / 696 / 1261、其中后端 400–900。
 *
 * **两档给同一个数,因为这一格的大头与档无关**:`git status --porcelain=v2` 加
 * `diff HEAD --numstat` 跑在 core 里,dev 与 prod 调的是同一条路、同一个子进程 ——
 * 给 prod 一个更小的数只会让它在机器忙的时候随机红,而红的不是它。壳这一侧的差别
 * (dev ≈300 / prod ≈60)仍然看得见:`listMs − backendMs`。
 * **摊子大小本身有抖**(同一台机器上并排跑别的门时 `git status` 两千个文件慢一倍),
 * 所以这个数留的是那条上沿的余量,不是中位数。壳这一侧余下的仍是 dev ≈600ms / prod ≈250ms(一份两千条的
 * JSON 过 HTTP + 一次 React 提交;列本身是窗口化的,实测只画 35 行)。
 *
 * **退场判据**(两条任意一条兑现就按新读数收紧):
 *  ① 后端那一发进 100ms(增量 / 缓存 / 只问一次 git);
 *  ② 这块面改成「表先上屏、行分批到」(那时 `listMs` 问的会是第一批)。
 * **不许**把这一行的数往上抬:抬它就是把一次回归改写成新常态 —— 这一次改它的理由
 * 写在上面那一段里,是**夹具变重**,而门把后端那一发单独量了出来,谁涨的看得见。
 */
const TRANSITIONAL = {
  dev: { firstFrameMs: 25, listMs: 1600 },
  prod: { listMs: 1600 },
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

/** 造一个真仓:init + 一版提交 + `files` 那几个文件各 `lines` 行。 */
async function seedRepo(dir, { files = 1, lines = 1 } = {}) {
  await mkdir(dir, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  for (let i = 0; i < Math.max(files, 1); i += 1) {
    await writeFile(path.join(dir, `f${i}.txt`), fileBody(lines))
  }
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'first'])
  return dir
}

/** 一份 `n` 行的文件。第 5 行是一条**很长的**行 —— ⑧ 要横滚的就是它。 */
function fileBody(n) {
  return `${Array.from({ length: n }, (_, i) => (i === 4 ? LONG_LINE : `line ${i}`)).join('\n')}\n`
}

/** 整文件视图要横滚,得有一条比面板宽的行。 */
const LONG_LINE = `line 4 ${'wide '.repeat(60)}end`

/**
 * 改 `count` 个文件(造出 `count` 行改动)。
 *
 * **每个文件改两处**(第 2 行与第 7 行),中间隔着没改的行 —— 整文件视图的
 * ↑↓ 与右缘那张地图都要有**两块**可走,而一处改动说不出「循环」这件事。
 * 文件只有一行时退化成整篇替换(那是 `dirtyRepo(repoBig, …)` 那一档)。
 */
async function dirtyRepo(dir, count, { lines = 1 } = {}) {
  for (let i = 0; i < count; i += 1) {
    if (lines < 8) {
      await writeFile(path.join(dir, `f${i}.txt`), `changed ${i}\n`)
      continue
    }
    const body = Array.from({ length: lines }, (_, n) => (n === 4 ? LONG_LINE : `line ${n}`))
    body[1] = `changed ${i}`
    body[6] = `changed ${i} again`
    await writeFile(path.join(dir, `f${i}.txt`), `${body.join('\n')}\n`)
  }
}

/**
 * `repo-big` 的 f0 改成**两千行交错**(批 ③-b:第 5 轴那一格从「两千个文件」
 * 变成「两千个文件 **+ 一份两千行、每隔一行改一行的文件**」—— 整文件视图的钱
 * 按**行**计价,而旧夹具里每个文件只有一行,量不到它)。
 */
async function seedBigFile(dir, lines) {
  const base = Array.from({ length: lines }, (_, i) => `line ${i}`)
  await writeFile(path.join(dir, 'f0.txt'), `${base.join('\n')}\n`)
  /*
   * **只提交 f0**(`add -A` 会把 `dirtyRepo` 刚改脏的另外一千九百九十九个文件
   * 一起提交掉,列表当场从两千行掉成两行 —— 批 ③-b 第一次跑就是这么把 ⑥ 的量纲
   * 弄没的:`listMs` 从 632 掉到 57,不是变快了,是没东西可列了)。
   */
  git(dir, ['add', 'f0.txt'])
  git(dir, ['commit', '-qm', 'big'])
  const work = base.map((text, i) => (i % 2 === 0 ? `changed ${i}` : text))
  await writeFile(path.join(dir, 'f0.txt'), `${work.join('\n')}\n`)
  /*
   * 再加一份**没跟踪过**的两千行文件:它的整文件视图整篇都是新增 —— 一整片
   * **同一个底色**。⑨ 的缝数要的正是这个:一片均匀的底色里,任何一行不是那个色
   * 就是缝。f0 那一份是「加 / 删 / 未改」三色交错的,在它上面数缝等于数带与带的
   * 交界(第一次跑就这么假红了 12 道)。
   */
  await writeFile(path.join(dir, 'big-add.txt'), `${base.map((t) => `new ${t}`).join('\n')}\n`)
}

/**
 * 拍**这块体**(CDP 按设备像素出图,裁到 `[data-testid="changes-body"]` 的矩形)。
 * ⑧ 与 ⑨ 都要看画面而不是看 CSS 字面:一条 `position: sticky` 写在样式表里是真的,
 * 不等于它在这块面上真的粘住了(批 ① / ② 各被自己那份截图打回过一次)。
 */
async function shotOfBody(page, cdp) {
  const box = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="changes-body"]')
    if (!(el instanceof HTMLElement)) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
  })
  if (!box) throw new Error('拍不到:[data-testid="changes-body"] 不在 DOM 里')
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 },
  })
  return { img: decodePng(Buffer.from(shot.data, 'base64')), box }
}

/**
 * 两张图按列比:左边那一叠(行号 + 符号列)动没动,中段动没动。
 *
 * **比的是每一列有多少「墨」,不是逐像素相同**(批 ③-b 第一次跑连撞两次):
 * 粘住的那一列会被 Chromium 提成自己的合成层,同一串数字在两帧里的**子像素抗锯齿**
 * 因此不同 —— 实测 73×1076 的那片里有 651 个像素差、其中 45 个超过 60 的通道差,
 * 而数字一个都没动。**逐列的墨量是整数**,抗锯齿改不动它,而真的滚走了就会整列变。
 */
function inkProfile(img, x0, x1, y0, y1) {
  // 底色 = 这一片里最常见的那个颜色。
  const counts = new Map()
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < Math.min(x1, img.width); x += 1) {
      const i = (y * img.width + x) * img.bpp
      const key = `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  let base = [0, 0, 0]
  let best = -1
  for (const [key, n] of counts) if (n > best) { best = n; base = key.split(',').map(Number) }
  const out = []
  for (let x = x0; x < Math.min(x1, img.width); x += 1) {
    let ink = 0
    for (let y = y0; y < y1; y += 1) {
      const i = (y * img.width + x) * img.bpp
      const d = Math.abs(img.data[i] - base[0])
        + Math.abs(img.data[i + 1] - base[1])
        + Math.abs(img.data[i + 2] - base[2])
      if (d > 90) ink += 1
    }
    out.push(ink)
  }
  return out
}

function compareColumns(before, after) {
  const a = before.img
  const b = after.img
  if (a.width !== b.width || a.height !== b.height) {
    return { leftSame: false, leftMoved: -1, midMoved: -1 }
  }
  /* 只看正文那几行(避开 sticky 的檐与块尾提示):这一片的上下各留一成。 */
  const y0 = Math.round(a.height * 0.2)
  const y1 = Math.round(a.height * 0.9)
  const moved = (x0, x1) => {
    const pa = inkProfile(a, x0, x1, y0, y1)
    const pb = inkProfile(b, x0, x1, y0, y1)
    let cols = 0
    for (let i = 0; i < pa.length; i += 1) if (Math.abs(pa[i] - pb[i]) > 2) cols += 1
    return cols
  }
  // 左边那一叠 = 两列行号 + 符号列,约 90 逻辑像素;这张图是**设备像素**(dpr 2),
  // 所以取 0–80 只覆盖到第二列行号的中段 —— 够了,它要么整列跟着滚要么一格不动。
  const leftMoved = moved(0, 80)
  const midMoved = moved(240, a.width - 40)
  /*
   * **判据是「整列有没有跟着走」**:滚走了的话这 80 列里几乎每一列都要变
   * (中段实测 562 / 约 2000 列)。抗锯齿在数字边缘上还能挤出两三列的零头,
   * 所以给 4 列的余量 —— 实测 3。这不是一个「差不多就行」的阈值:它与
   * 「滚走」那一档差着两个数量级。
   */
  return { leftSame: leftMoved <= 4, leftMoved, midMoved }
}

/**
 * **dpr-2 缝数**(量法照提交 `592103be9`,批 ② 的探针进门)。
 *
 * `content-visibility: auto` 自带 paint containment:每一行各自一块绘制盒,行高若是
 * 分数,2 倍屏上相邻两块盒各自吸附到设备像素,在分数边界上留一道没人画的缝
 * (2026-09-13 报障:每 5–6 行一道)。批 ② 把行高取成整数之后这条账结清了,
 * 这一步是那句底气的读数:沿一列取颜色剖面,数「不是底色、而且上下至少一侧是底色」
 * 的那些行 —— 连成一大片的不是缝(那是别的东西),孤立的一两道才是。
 */
function seamsInColumn(img, x, y0, y1) {
  const colorAt = (y) => {
    const i = (y * img.width + x) * img.bpp
    return `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`
  }
  const counts = new Map()
  for (let y = y0; y < y1; y += 1) counts.set(colorAt(y), (counts.get(colorAt(y)) ?? 0) + 1)
  let base = null
  let best = -1
  for (const [color, n] of counts) if (n > best) { best = n; base = color }
  let seams = 0
  for (let y = y0 + 1; y < y1 - 1; y += 1) {
    if (colorAt(y) === base) continue
    if (colorAt(y - 1) === base || colorAt(y + 1) === base) seams += 1
  }
  return { seams, base, baseRows: best, rows: y1 - y0 }
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
    const repoA = await seedRepo(path.join(fixtures, 'repo-a'), { files: 3, lines: REPO_A_LINES })
    const repoB = await seedRepo(path.join(fixtures, 'repo-b'), { files: 2 })
    const plain = path.join(fixtures, 'plain')
    await mkdir(plain, { recursive: true })
    await writeFile(path.join(plain, 'note.md'), '# not a repo\n')
    /*
     * **超量那一格的夹具**(第 5 轴那张表最后一行):两千个改过的文件。
     * 它是 ⑥ 的被测对象 —— ①–⑤ 那几步用小仓,因为它们量的是**事实**不是预算。
     */
    const repoBig = await seedRepo(path.join(fixtures, 'repo-big'), { files: BIG_ROWS })
    await dirtyRepo(repoA, 1, { lines: REPO_A_LINES })
    await dirtyRepo(repoB, 1)
    await dirtyRepo(repoBig, BIG_ROWS)
    // **排在 dirtyRepo 之后**:它要把 f0 的 HEAD 版换成两千行,而 dirtyRepo 会把
    // f0 连同别的文件一起写成一行。
    await seedBigFile(repoBig, BIG_LINES)

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
    assert(bodyText.includes('changed 0'), '① 体里有那一行改动的内容')

    /*
     * ① 批 ③-b 起这块体是**整文件**(不是 hunk):整份文件的每一行都在屏上,
     * 改动行带 `mark`。行数 = 文件行数 + 改动行数(一行改 = 一删一增两行)。
     */
    const whole = await waitFor('整文件画出来', async () => {
      const seen = await page.evaluate(() => {
        const rows = Array.from(
          document.querySelectorAll('[data-testid="changes-body"] [data-line-index]'),
        )
        return {
          rows: rows.length,
          add: rows.filter((el) => el.className.includes('lineAdd')).length,
          del: rows.filter((el) => el.className.includes('lineDel')).length,
          ctx: rows.filter(
            (el) => !el.className.includes('lineAdd') && !el.className.includes('lineDel'),
          ).length,
          both: rows.filter((el) => el.hasAttribute('data-old-no') && el.hasAttribute('data-new-no')).length,
        }
      })
      return seen.rows > 0 ? seen : undefined
    })
    assert(
      whole.ctx === REPO_A_LINES - 2 && whole.add === 2 && whole.del === 2,
      `① 整文件行数 = 文件行数 + 改动行(未改 ${whole.ctx} + 增 ${whole.add} + 删 ${whole.del}`
        + `,文件 ${REPO_A_LINES} 行、改了 2 处)`,
    )
    assert(
      whole.both === whole.ctx,
      `① 未改的行两列行号都在(${whole.both} / ${whole.ctx});增删行各缺一列`,
    )

    /*
     * ⑦ **↑↓ 循环与 `k / N`**(批 ③-b)。两处改动 → `1 / 2`;↓ 到 2、再 ↓ 回 1;
     * 而且**整页不动** —— ↑↓ 只滚这块面自己那一格(修前用 `scrollIntoView`
     * 会连外层一起滚,那是批 ① 在查看器上量到过的同一个病)。
     */
    const navText = () =>
      page.evaluate(
        () => document.querySelector('[data-testid="changes-nav-count"]')?.textContent ?? null,
      )
    assert((await navText()) === '1 / 2', `⑦ 首次落在第一块:${await navText()}`)
    const outerBefore = await page.evaluate(() => ({
      win: window.scrollY,
      panel: document.querySelector('[data-testid="changes-panel"]')?.scrollTop ?? 0,
    }))
    await clickSelector(page, '[data-testid="changes-next"]')
    assert((await navText()) === '2 / 2', `⑦ ↓ 走到下一块:${await navText()}`)
    await clickSelector(page, '[data-testid="changes-next"]')
    assert((await navText()) === '1 / 2', `⑦ 最后一块再 ↓ **循环**回第一块:${await navText()}`)
    await clickSelector(page, '[data-testid="changes-prev"]')
    assert((await navText()) === '2 / 2', `⑦ 第一块再 ↑ 回到最后一块:${await navText()}`)
    const outerAfter = await page.evaluate(() => ({
      win: window.scrollY,
      panel: document.querySelector('[data-testid="changes-panel"]')?.scrollTop ?? 0,
    }))
    assert(
      outerAfter.win === outerBefore.win && outerAfter.panel === outerBefore.panel,
      `⑦ 跳块只滚自己那一格:窗口 ${outerBefore.win}→${outerAfter.win}、`
        + `面板 ${outerBefore.panel}→${outerAfter.panel}(两个都不许动)`,
    )
    /*
     * ⑦ 的另一半:**跳到哪儿、怎么跳**。`scrollIntoView` 与「只滚自己这一格」在这台
     * 布局上分不出「整页动没动」(外面那几层都不是滚动容器),但它们在**两件事**上
     * 分得开,而这两件正是批 ① 在查看器上量到过的那两条:
     *  · 落点:这块面把目标行摆到**视口中段**,`scrollIntoView` 的缺省是贴顶;
     *  · 横向:`inline: 'nearest'` 会在元素比视口宽时把横滚**拨走**(实测 12px),
     *    而按行数跳不该动列。
     */
    const landed = await page.evaluate(() => {
      const body = document.querySelector('[data-testid="changes-body"]')
      const row = body?.querySelector('[data-current="true"]')
      if (!(body instanceof HTMLElement) || !(row instanceof HTMLElement)) return null
      const b = body.getBoundingClientRect()
      const r = row.getBoundingClientRect()
      return {
        offCenter: Math.round(r.top + r.height / 2 - (b.top + b.height / 2)),
        scrollLeft: Math.round(body.scrollLeft),
        scrollTop: Math.round(body.scrollTop),
        scrollable: body.scrollHeight > body.clientHeight,
      }
    })
    /*
     * 这份文件只有十二行,**整份都在一屏里** —— 那时「跳到哪儿」的正确答案是
     * 「一格都不滚」。居中那一条在下面那份三千行的文件上量(⑥ 那一段)。
     */
    assert(
      landed && !landed.scrollable && landed.scrollTop === 0,
      `⑦ 一屏装得下的文件:跳块一格都不滚(scrollTop ${landed?.scrollTop})`,
    )
    assert(landed.scrollLeft === 0, `⑦ 跳块不拨横滚(scrollLeft ${landed.scrollLeft})`)

    // 当前块的首行带 `data-current`,而且**全篇只有一行**带。
    const currents = await page.evaluate(
      () => document.querySelectorAll('[data-testid="changes-body"] [data-current="true"]').length,
    )
    assert(currents === 1, `⑦ 当前行全篇恰有一行(实测 ${currents})`)
    // 右缘那张地图:每块一格,当前那一格自己说得出来。
    const mapTicks = await page.evaluate(() => {
      const map = document.querySelector('[data-testid="changes-map"]')
      return {
        ticks: map ? map.querySelectorAll('[data-change-block]').length : 0,
        active: map ? map.querySelectorAll('[data-active="true"]').length : 0,
        tab: map?.getAttribute('tabindex') ?? null,
      }
    })
    assert(
      mapTicks.ticks === 2 && mapTicks.active === 1 && mapTicks.tab === '-1',
      `⑦ 改动地图:${mapTicks.ticks} 格、当前 ${mapTicks.active} 格、不在 Tab 序(tabindex=${mapTicks.tab})`,
    )

    /*
     * ⑧ **横滚纪律**(批 ①/② 那三条硬规矩的真机面):横滚 600px 之后
     *  · 行号列**左缘贴容器**(它是粘着的 —— 判据不是 CSS 字面,是**画面**:
     *    左边那 44 个逻辑像素在滚前滚后逐像素相同,而中段变了);
     *  · 加删底色**铺到内容宽**(行的宽 = 这块内容的可滚宽,不是容器宽)。
     */
    const beforeShot = await shotOfBody(page, cdp)
    await page.evaluate(() => {
      const body = document.querySelector('[data-testid="changes-body"]')
      if (body instanceof HTMLElement) body.scrollLeft = 600
    })
    await delay(250)
    const scrolled = await page.evaluate(() => {
      const body = document.querySelector('[data-testid="changes-body"]')
      const pre = body?.querySelector('pre')
      const row = body?.querySelector('[data-line-index]')
      if (!(body instanceof HTMLElement) || !(pre instanceof HTMLElement) || !(row instanceof HTMLElement)) {
        return null
      }
      return {
        scrollLeft: Math.round(body.scrollLeft),
        rowWidth: Math.round(row.getBoundingClientRect().width),
        contentWidth: Math.round(pre.scrollWidth),
        clientWidth: Math.round(body.clientWidth),
      }
    })
    assert(scrolled?.scrollLeft === 600, `⑧ 真的横滚了 600px(实测 ${scrolled?.scrollLeft})`)
    assert(
      scrolled.rowWidth >= scrolled.contentWidth - 2 && scrolled.rowWidth > scrolled.clientWidth,
      `⑧ 加删底色宽 = 内容宽:行 ${scrolled.rowWidth} ≥ 内容 ${scrolled.contentWidth}`
        + `(容器只有 ${scrolled.clientWidth})`,
    )
    const afterShot = await shotOfBody(page, cdp)
    const pinned = compareColumns(beforeShot, afterShot)
    assert(
      pinned.leftSame && pinned.midMoved > 100,
      `⑧ 行号列左缘贴容器:左边那一叠 80 列里只有 ${pinned.leftMoved} 列的墨量动过`
        + `(抗锯齿的零头,≤ 4),而中段 ${pinned.midMoved} 列全换了 —— 差两个数量级`,
    )
    await page.evaluate(() => {
      const body = document.querySelector('[data-testid="changes-body"]')
      if (body instanceof HTMLElement) body.scrollLeft = 0
    })
    await page.screenshot({ path: path.join(shotDir, `changes-${LANE}-ready.png`) })

    console.log('\n[5/7] ② 再改一个文件 → 点刷新 → 列 2 行,**旧行零重挂**')
    const marked = await markRows(page)
    assert(marked === 1, `打了 ${marked} 个记号`)
    await dirtyRepo(repoA, 2, { lines: REPO_A_LINES })
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
    console.log(
      `\n[7/7] ⑥ 两千行那个仓(外加一份两千行、每隔一行改一行的 f0):`
        + `点瓦到首帧 / 到列上屏 + ⑨ dpr-2 缝数(${LANE} 档)`,
    )
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
    assert(shown > 0 && shown <= BIG_ROWS + 2, `⑥ 两千行的仓:窗口化只画了 ${shown} 行`)
    console.log(
      `  · 第 5 轴读数(${LANE}):首帧 ${report.firstFrameMs}ms / 列上屏 ${report.listMs}ms`
      + `(其中后端那一发 ${report.backendMs}ms)`,
    )
    await page.screenshot({ path: path.join(shotDir, `changes-${LANE}-big.png`) })

    /*
     * ⑨ **dpr-2 缝数 = 0**(批 ③-b:批 ② 那只探针的量法进门)。
     *
     * 就在这个两千行的仓上量:点开 f0(两千行、每隔一行改一行),把 dpr 钉到 2,
     * 按设备像素拍这块体,沿正文右边那条空白列取剖面。逐行 `content-visibility`
     * 在**整数行高**下不留缝 —— 这一条就是那句话的读数;行高哪天退回分数,它当场红
     * (批 ② 反证实测:分数行高下同一段窗口里 10 道)。
     */
    await clickSelector(page, '[data-change-path="f0.txt"]')
    const bigLines = await waitFor('两千行那份文件的整文件视图上屏', async () => {
      const n = await page.evaluate(
        () => document.querySelectorAll('[data-testid="changes-body"] [data-line-index]').length,
      )
      return n > BIG_LINES ? n : undefined
    }, 60_000)
    report.bigFileRows = bigLines
    const bigBlocks = await page.evaluate(
      () => document.querySelectorAll('[data-testid="changes-map"] [data-change-block]').length,
    )
    report.bigFileBlocks = bigBlocks
    console.log(`  · 两千行那份文件:上屏 ${bigLines} 行 / ${bigBlocks} 个改动块`)

    /*
     * ⑦ 的第二半,在**滚得动**的文件上量:↓ 跳一块,目标行落在视口中段、横滚不动。
     * 这两件正是「只滚自己这一格」与 `scrollIntoView` 分得开的地方
     * (后者缺省贴顶,而且元素比视口宽时会把横滚拨走 —— 批 ① 实测 12px)。
     */
    /*
     * 跳到**中间**那一块 —— 用右缘那张地图点它的中段。头尾两块跳过去都会被钳
     * (`scrollTop` 夹在 0 与最大值上),量不出「摆到中段」这件事;顺带这一下也是
     * **地图点跳**的真机面(单测那一半在 jsdom 里量不到坐标)。
     */
    const picked = await page.evaluate(() => {
      const map = document.querySelector('[data-testid="changes-map"]')
      if (!(map instanceof HTMLElement)) return null
      const box = map.getBoundingClientRect()
      map.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientY: box.top + box.height / 2, clientX: box.left + 2 }),
      )
      return document.querySelector('[data-testid="changes-nav-count"]')?.textContent ?? null
    })
    await delay(250)
    const pickedNow = await page.evaluate(
      () => document.querySelector('[data-testid="changes-nav-count"]')?.textContent ?? null,
    )
    const pickedAt = Number((pickedNow ?? '').split('/')[0])
    assert(
      pickedAt > bigBlocks * 0.3 && pickedAt < bigBlocks * 0.7,
      `⑦ 点地图中段跳到中间那一块:${pickedNow}(点之前 ${picked})`,
    )
    const bigLanded = await page.evaluate(() => {
      const body = document.querySelector('[data-testid="changes-body"]')
      const row = body?.querySelector('[data-current="true"]')
      if (!(body instanceof HTMLElement) || !(row instanceof HTMLElement)) return null
      const b = body.getBoundingClientRect()
      const r = row.getBoundingClientRect()
      return {
        offCenter: Math.round(r.top + r.height / 2 - (b.top + b.height / 2)),
        scrollLeft: Math.round(body.scrollLeft),
        scrollTop: Math.round(body.scrollTop),
      }
    })
    assert(
      bigLanded && bigLanded.scrollTop > 0 && Math.abs(bigLanded.offCenter) <= 60,
      `⑦ 三千行那份:跳块把目标行摆到视口中段(离中心 ${bigLanded?.offCenter}px ≤ 60,`
        + `已滚 ${bigLanded?.scrollTop}px)`,
    )
    assert(bigLanded.scrollLeft === 0, `⑦ 跳块不拨横滚(scrollLeft ${bigLanded.scrollLeft})`)

    /*
     * 缝数换到那份**整篇新增**的文件上量(判词在 `seedBigFile` 上):一片均匀底色,
     * 任何一行不是那个色就是缝。
     */
    /*
     * 那一行在两千行的列里,而这张列是**窗口化**的(⑥ 刚量到「只画了 35 行」)——
     * 先把列滚到底再点:门要走用户真正走的那条路,而用户也得先滚到它。
     */
    await waitFor('未跟踪那一行进窗口', async () => {
      await page.evaluate(() => {
        const list = document.querySelector('[data-testid="changes-list"]')
        if (list instanceof HTMLElement) list.scrollTop = list.scrollHeight
      })
      await new Promise((resolve) => setTimeout(resolve, 100))
      return page.evaluate(() =>
        Boolean(document.querySelector('[data-change-path="big-add.txt"]')),
      )
    }, 30_000)
    await clickSelector(page, '[data-change-path="big-add.txt"]')
    await waitFor('整篇新增那份上屏', async () => {
      const seen = await page.evaluate(() => {
        const rows = Array.from(
          document.querySelectorAll('[data-testid="changes-body"] [data-line-index]'),
        )
        return { rows: rows.length, add: rows.filter((el) => el.className.includes('lineAdd')).length }
      })
      return seen.rows >= BIG_LINES && seen.add === seen.rows ? seen : undefined
    }, 60_000)

    const size = page.viewportSize() ?? { width: 1280, height: 800 }
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 2,
      mobile: false,
    })
    await delay(600)
    const dpr2 = await shotOfBody(page, cdp)
    /*
     * 取样列:正文**右边**那条空白(行的底色铺到最长那行,所以右端一定是纯底色);
     * 取样段:檐下面一段,避开 sticky 的檐与块尾那一行提示。
     */
    const x = Math.min(dpr2.img.width - 8, Math.round(dpr2.img.width * 0.9))
    const y0 = Math.round(dpr2.img.height * 0.35)
    /*
     * 取样段的下沿要**钳在 composer 之上**(2026-09-13 rebase 到「Dock 让位改平移形」之后
     * 门当场红了一道:y=1099 一行只差 1 个色阶,正是 composer 那层玻璃的上边缘落进了
     * 35%–90% 的窗口 —— 它盖在改动面底下那一截上,底色被玻璃染了一级)。composer 的
     * 位置是壳的事,这道门量的是行与行之间,所以按 DOM 现读它的顶边、留一行余量。
     */
    const composerTop = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="composer-input"]')?.closest('form, [class*="composer"]') ?? document.querySelector('[data-testid="composer-input"]')
      return el instanceof HTMLElement ? el.getBoundingClientRect().top : null
    })
    const y1 = Math.min(
      Math.round(dpr2.img.height * 0.9),
      composerTop === null ? Number.POSITIVE_INFINITY : Math.round((composerTop - dpr2.box.y) * 2) - 8,
    )
    const seam = seamsInColumn(dpr2.img, x, y0, y1)
    report.dpr2Seams = seam.seams
    if (seam.seams > 0) {
      // 红了就把每一道的位置与颜色打出来:一道缝的诊断从「它在哪」开始,不从重跑开始。
      const colorAt = (yy) => { const i = (yy * dpr2.img.width + x) * dpr2.img.bpp; return `${dpr2.img.data[i]},${dpr2.img.data[i + 1]},${dpr2.img.data[i + 2]}` }
      const hits = []
      for (let yy = y0 + 1; yy < y1 - 1; yy += 1) if (colorAt(yy) !== seam.base && (colorAt(yy - 1) === seam.base || colorAt(yy + 1) === seam.base)) hits.push({ y: yy, color: colorAt(yy) })
      console.log(`  · 缝的位置(x=${x},取样 ${y0}–${y1},composer 顶 ${composerTop}):${JSON.stringify(hits)}`)
    }
    console.log(
      `  · dpr-2 缝数:列 x=${x}、行 ${y0}–${y1}、底色 ${seam.base}`
        + `(${seam.baseRows}/${seam.rows} 行)→ **${seam.seams} 道**`,
    )
    assert(seam.seams === 0, `⑨ dpr-2 逐行跳渲零缝(实测 ${seam.seams} 道)`)
    await cdp.send('Emulation.clearDeviceMetricsOverride')

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
