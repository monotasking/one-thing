#!/usr/bin/env node
/**
 * Dock 磁性放大的**真机门**(09-02 第二轮:用户试过 9cbdb496 那版后报「新的还不如
 * 旧的,有抖动感」,整套推倒重做)。
 *
 * 上一轮这条门问的是「指针脚下那块瓦动了没有」——它绿了,而用户手上的感受是红的。
 * 说明那五条读数没有把「抖动」翻译进来。这一轮补的两条才是抖动的机器定义,它们
 * 各自对应一种**镜头本不该有的自由度**:
 *
 *  ① **手停着,屏幕就该是死的。** 上一版的放大量是一条 rAF 环上的临界阻尼,
 *     指针停下之后它还要收好几帧;条又跟着指针平移(shift),两条量各有各的相位。
 *     于是「手已经不动了,画面还在爬」。两问:
 *     ①a 入场落定后指针纹丝不动,连采 60 帧,**任何一块瓦的矩形有一点变化就算一帧**;
 *     ①b 匀速扫过之后**骤停**,量它还要几帧才咬住最终值(这一条才抓得到跟手期的
 *        尾巴 —— ①a 那种「停久了」的场景阻尼早就收干净了)。
 *
 *  ② **手匀速走,每块瓦就该匀速走。** 指针 2px/帧从条左扫到条右,逐帧记每块瓦
 *     中心与底板左缘的位置,量两件事:
 *     ②a **方向反转次数**(死区 0.1px,滤掉亚像素噪声)。纯几何有它天然的下界:
 *        每块瓦被指针扫过时先被左边推右、再被右边推左,**两个拐点 = 2 次反转**。
 *        多出来的都是抖 —— 而抖的来源不止一个阻尼:
 *        **余弦钟形的半径若不是瓦距的整数倍,整条 Dock 会呼吸**。
 *        (Hann 窗以 hop = R/k(k 为 ≥2 的整数)重叠相加恒为常数 —— 就是信号处理里
 *        的 COLA 条件。半径 R = k·pitch 时 Σ 各瓦的放大量恒定 ⇒ 条的总长恒定 ⇒
 *        不呼吸;R = 1.81·pitch(上一版的 96px / 53px)时那条和会随指针起伏,
 *        条一伸一缩,每块瓦都跟着来回。纯几何数值模型:R=1.81p 每块瓦 15–19 次反转,
 *        R=2p 降到 2–4 次。)
 *     ②b **8 帧窗口内的非单调量**(窗口内走过的总路程 − 净位移)。反转次数说
 *        「抖了几下」,这一条说「抖多大」——拐点处的曲率会贡献一点点(模型 0.27px),
 *        真正的抖动会大一个量级。
 *
 * 余下六条是上一轮留下来的守卫,判据按新做法重写:
 *  ③ 入场不许有一帧跳(单帧涨幅 ≤ 声明的缓动 × 时长算得出的几何上限)。
 *  ④ 手离开 ≤ 200ms 回基准,且**基准矩形与进条前逐字节同**。
 *  ⑤ 放大到顶时相邻两瓦不但不重叠,**缝还得与静止时逐字节相等**(新几何的恒等式:
 *     dx 的定义使相邻缝恒等于静止缝,见 dock-lens.ts;这条是它的守卫)。
 *  ⑥ **确定性**:同一个 x 进两次,几何逐字相同(纯函数 + 布局基准的直接后果;
 *     任何缓存 / 冻结 / 插值状态回来都会让这条红)。
 *  ⑦ reduced-motion(= 动效档「无」)瞬到。
 *  ⑧ **静息态那张脸**:把镜头从头到尾用一遍之后回到静息,截图与开场那张**字节级
 *     相同**。它守的是「这套东西只在放大的时候存在」——用完不留痕。
 *     (跨版本的 before/after 截图也照样存下来,但那一份**不适合当断言**:放大从
 *     布局尺寸改成 transform 之后,瓦各自上了合成层,圆角与描边的抗锯齿必然重算 ——
 *     真机实测 7.3% 的像素差 1/255、144 个像素差到 24,全在瓦的圆角曲线上。
 *     几何那一半由 ④⑥ 逐字钉着,像素那一半只报读数不判红。)
 *  ⑨ **设置里关掉磁性放大之后,匀速扫一遍全程零变化**(09-02 追补,对齐 macOS
 *     Dock 偏好里那枚「放大」开关)。关掉不该是「放大到 1 倍」——后者仍在逐帧写
 *     十几组自定义属性、仍挂着镜头开关,只是数字碰巧是 1;这条判的是**矩形逐字不变**,
 *     写 1 也能过,所以它守的是「不抖」,而 `dock-lens-hook.test.tsx` 那条单测守的是
 *     「一格都不写」。两条各守一半,合起来才是「这条链根本不跑」。
 *
 * ── 量法 ───────────────────────────────────────────────────────────────────
 * 指针一律走 CDP `Input.dispatchMouseEvent`:只进目标窗口,**不动真光标、不抢焦点**
 * (09-01 判例:系统级合成输入干扰用户用电脑)。尺寸系数不读 JS 私有状态,而是量
 * **瓦的矩形宽度 ÷ 静止宽度**,所以同一份脚本原样跑得动改前的代码,before/after 才可比。
 *
 * 跑法:`npm run gate:dock`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 截图与读数落在 `DOCK_GATE_OUT` 指定的目录(不给就落进临时目录,只打 sha256)。
 * 可重复:每次一个全新的临时 store + 全新的 --user-data-dir,跑完删干净。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
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

/* ── 判据(每条都写清「为什么是这个数」)───────────────────────────────────── */

/** ①a 指针停着连采多少帧。60 帧 @60Hz = 一秒;阻尼那条尾巴远短于它,采不到才叫干净。 */
const STILL_FRAMES = 60
/** ①a 判「这一帧变了」的阈值(px)。0.02 在亚像素噪声之上、在任何真实位移之下。 */
const STILL_EPSILON = 0.02
/** ①b 骤停后允许再花几帧咬住最终值。纯几何是当帧(rAF 合帧最多差一帧),取 2 留一帧余量。 */
const MAX_TAIL_FRAMES = 2

/** ② 扫条的步长(px/帧)与节拍(ms)。2px/帧 ≈ 120px/s,一次从容的横扫。 */
const SWEEP_STEP_PX = 2
const SWEEP_TICK_MS = 1000 / 60
/** ②a 方向反转的死区(px)。亚像素取整噪声在 0.02 量级,0.1 滤得掉又漏不掉真位移。 */
const REVERSAL_DEADBAND_PX = 0.1
/**
 * ②a 允许的反转次数。纯几何的下界是 **2**(每块瓦被扫过时的两个拐点);
 * 分隔线让瓦距在那一处不是等距,COLA 在局部破掉,数值模型给到 4。取 6 留两次余量,
 * 抓的是「十几次」那个量级(模型:半径不是整数倍瓦距时 15–19 次)。
 */
const MAX_REVERSALS = 6
/** ②b 8 帧窗口(≈130ms,一次「手感」的时间尺度)内允许的非单调量(px)。模型 0.27。 */
const WOBBLE_WINDOW = 8
const MAX_WOBBLE_PX = 0.5

/** ③ 峰值缩放与镜头开合时长 —— 与 tokens.css 的 --dock-lens-max / --dur-dock-lens 同值。 */
const LENS_MAX = 1.35
const LENS_MS = 140
/**
 * ③ `--ease-soft` = cubic-bezier(0.33, 0, 0.67, 1) 的最大斜率(数值解 1.493):
 * 一段缓动最快的那一瞬比匀速快多少倍。入场时一块瓦一共要涨 (Smax−1),一帧占整段的
 * FRAME_MS/LENS_MS,所以**几何上限** = (Smax−1) × 最大斜率 × 一帧的份额。
 * 留 1.25 的余量给帧间抖动 —— 超出这个数才叫「跳」,而不是「快」。
 */
const EASE_SOFT_PEAK_SLOPE = 1.493
const ENTRY_HEADROOM = 1.25
/** ③ 入场「到位」的判据与上限耗时。判 ms 不判帧:本机 120Hz,按帧数会跟着刷新率变红变绿。 */
const ENTRY_SETTLED = 0.05
const MAX_ENTRY_MS = 220
/** ④ 手离开后收回静止的上限(ms)。--dur-dock-lens 是 140ms,留一档余量。 */
const MAX_RELEASE_MS = 200
/** ④⑥ 判「两份矩形逐字节同」的阈值(px)。 */
const SAME_RECT_PX = 0.05
/** ⑤ 放大到顶时,相邻缝与静止缝允许的差(px)。0.5 是亚像素取整的余量,不是放水。 */
const MAX_GAP_DRIFT_PX = 0.5
/** ⑦ reduced-motion 档「瞬到」的帧数上限。 */
const MAX_REDUCED_FRAMES = 1
/**
 * 刚把指针挪上条之后,起量前先静默这么久(ms)。必须**大于 --dur-dock-lens(140)**:
 * 镜头开合期间矩形是在变的,但开合起步前有几帧一动不动,不设这个下界就会在那几帧
 * 上判「已经稳住了」。320 ≈ 两个开合时长。
 */
const ENTER_SETTLE_MS = 320
/** ⑨ 关掉放大之后扫多少帧。与 ①a 同一个量级,足够长到任何插值都藏不住。 */
const OFF_SWEEP_FRAMES = 60
/** 形态机存盘的键与版本(与 src/stage/store.ts 的 `name` / STAGE_PERSIST_VERSION 同源)。 */
const STAGE_KEY = 'onething.stage'
const STAGE_VERSION = 7
/** 判「系数已经回到静止」的阈值。0.005 在 md 档 = 0.22px。 */
const REST_EPSILON = 0.005
/** 一帧的名义长度(ms)—— 单帧涨幅按它归一。 */
const FRAME_MS = 1000 / 60

const MAX_ENTRY_STEP = (LENS_MAX - 1) * EASE_SOFT_PEAK_SLOPE * (FRAME_MS / LENS_MS) * ENTRY_HEADROOM

const failures = []
const readings = {}
const outDir = process.env.DOCK_GATE_OUT

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
    last = await predicate()
    if (last) return last
    await delay(150)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}

function check(ok, message) {
  if (ok) console.log(`  ✓ ${message}`)
  else {
    console.log(`  ✗ ${message}`)
    failures.push(message)
  }
}

/* ── 页面里的探针 ─────────────────────────────────────────────────────────── */

/**
 * 量各瓦的矩形。**瓦 = 条的每个直接子 div 里那颗 button** —— 分隔线是 `<span>`,
 * 天然不进这张表;`[data-testid^=dock-tile]` 会漏掉「+」那块(它没有 testId),
 * 而放大按格子的线性次序算,漏一格就对不上号。
 * 第一格是**底板**(条自己的矩形):新做法里底板是一个独立子元素,取不到就退回条本身,
 * 于是同一份读法在改前改后都成立。
 */
const READ_SRC = `(() => {
  const strip = document.querySelector('[data-dock="strip"]')
  const plate = strip.querySelector('[data-dock="plate"]') ?? strip
  const box = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }
  return {
    viewport: [window.innerWidth, window.innerHeight],
    plate: box(plate),
    tiles: [...strip.children]
      .map((w) => (w.tagName === 'DIV' ? w.querySelector('button') : null))
      .filter(Boolean)
      .map(box),
  }
})()`

/**
 * 等到连续 3 帧读数不变(或超时),返回最后一次。
 *
 * `minMs` 是**起量前的静默期**,专治一类假绿:指针刚落到条上时,mousemove → rAF →
 * 写几何 → 过渡起步要过几帧,这几帧里矩形一动不动 —— 「连续 3 帧不变」当场就满足了,
 * 于是 settle 在镜头还没开之前就返回,后面那 60 帧静止采样正好采到开合过程,
 * 判出一个根本不存在的「手停着画面还在动」。所以凡是**刚挪上条**的地方都给一段
 * 比 --dur-dock-lens 长的静默期(09-02 真机上这条假红出现过一次:3 帧 / 1.25px)。
 */
function settle(page, maxMs = 900, minMs = 0) {
  return page.evaluate(
    async ([src, cap, floor]) => {
      const read = new Function(`return ${src}`)
      const same = (a, b) =>
        a.tiles.length === b.tiles.length &&
        a.plate.every((n, j) => Math.abs(n - b.plate[j]) < 0.01) &&
        a.tiles.every((v, i) => v.every((n, j) => Math.abs(n - b.tiles[i][j]) < 0.01))
      const t0 = performance.now()
      let prev = read()
      let stable = 0
      while (performance.now() - t0 < cap) {
        await new Promise((r) => requestAnimationFrame(r))
        const cur = read()
        stable = same(cur, prev) ? stable + 1 : 0
        prev = cur
        if (stable >= 3 && performance.now() - t0 >= floor) break
      }
      return prev
    },
    [READ_SRC, maxMs, minMs],
  )
}

/** 逐帧采样 n 帧(带时间戳)。 */
function sampleFrames(page, frames) {
  return page.evaluate(
    async ([src, n]) => {
      const read = new Function(`return ${src}`)
      const out = []
      for (let i = 0; i < n; i += 1) {
        await new Promise((r) => requestAnimationFrame(r))
        out.push({ t: performance.now(), ...read() })
      }
      return out
    },
    [READ_SRC, frames],
  )
}

function move(cdp, x, y) {
  return cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
}

/* ── 几何小工具 ───────────────────────────────────────────────────────────── */

const centerX = (r) => r[0] + r[2] / 2
const factorsOf = (tiles, tileSize) => tiles.map((r) => r[2] / tileSize)
const maxAbs = (xs) => xs.reduce((m, v) => Math.max(m, Math.abs(v)), 0)

/** 一条位置序列的方向反转次数(死区之内的抖动不算一次运动)。 */
function reversals(series, deadband) {
  let dir = 0
  let count = 0
  let ext = series[0]
  for (const v of series) {
    if (Math.abs(v - ext) < deadband) continue
    const d = Math.sign(v - ext)
    if (dir !== 0 && d !== dir) count += 1
    dir = d
    ext = v
  }
  return count
}

/** 任意 w 帧窗口内的**非单调量** = 窗口里走过的总路程 − 净位移。单调段恒为 0。 */
function wobble(series, w) {
  let worst = 0
  for (let i = w; i < series.length; i += 1) {
    let travel = 0
    for (let j = i - w + 1; j <= i; j += 1) travel += Math.abs(series[j] - series[j - 1])
    worst = Math.max(worst, travel - Math.abs(series[i] - series[i - w]))
  }
  return worst
}

/** 两份读数逐字节同? */
const sameRects = (a, b) =>
  a.tiles.length === b.tiles.length &&
  a.plate.every((n, j) => Math.abs(n - b.plate[j]) <= SAME_RECT_PX) &&
  a.tiles.every((v, i) => v.every((n, j) => Math.abs(n - b.tiles[i][j]) <= SAME_RECT_PX))

/* ── 主流程 ───────────────────────────────────────────────────────────────── */

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[dock-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[dock-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'dock-gate-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'dock-gate-userdata-'))
  let server
  let app
  try {
    console.log('\n[1/10] 起一台 core')
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, ONETHING_STORE_PATH: store },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serverErr = []
    server.stderr.on('data', (chunk) => serverErr.push(chunk.toString()))
    const rec = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    }).catch((error) => {
      throw new Error(`${error.message}\nserver stderr:\n${serverErr.join('')}`)
    })
    if (!(await portConnects(rec.host, rec.port))) throw new Error('core 端口连不上')
    console.log('  ✓ core 起来了')

    console.log('\n[2/10] 拉起应用(独立 --user-data-dir)')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '' },
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitFor('Dock 就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-dock="strip"] > div button'))),
    )
    /*
     * 还要等**主题落地**才量:⑧ 比的是静息态的像素,而主题是异步贴到 :root 上的一组
     * `--ui-*`。贴上之前 `--surface-2` 落回 palette.css 的浅色缺省(#ffffff),瓦是白的;
     * 贴上之后才是这台真正的样子。09-02 真机上抓到过一次:两趟跑的截图差了 7 万像素,
     * 追下去是这条竞态,与被测的放大一点关系都没有。
     */
    await waitFor('主题贴到 :root 上', () =>
      page.evaluate(() =>
        Boolean(
          getComputedStyle(document.documentElement).getPropertyValue('--ui-surface-panel-bg').trim(),
        ),
      ),
    )
    /*
     * 最后等**窗口身量稳住**。Electron 起窗之后还会自己调一两次大小(还原上次的
     * 身量、显示器 DPI 生效…),而 Dock 是居中的浮层 —— 窗口一宽一窄,整条就横着挪。
     * 09-02 真机上吃过一次:量出「一帧跳 113px」的抖动,追下去是窗口在扫描中途变了宽,
     * 与被测的放大毫无关系。所以先等它连续 10 帧不变,再开量;下面每一段还会核对一次。
     */
    const viewport = await waitFor('窗口身量稳住', () =>
      page.evaluate(async () => {
        let prev = [window.innerWidth, window.innerHeight]
        for (let i = 0; i < 10; i += 1) {
          await new Promise((r) => requestAnimationFrame(r))
          const cur = [window.innerWidth, window.innerHeight]
          if (cur[0] !== prev[0] || cur[1] !== prev[1]) return null
          prev = cur
        }
        return prev
      }),
    )
    readings.viewport = viewport
    const cdp = await app.context().newCDPSession(page)
    console.log(`  ✓ 外壳画出来了(窗口 ${viewport.join('×')}),CDP 会话已开`)

    console.log('\n[3/10] 静息态:指针挪到条外,量基准 + 存截图')
    await move(cdp, 10, 10)
    const rest = await settle(page)
    const tileSize = rest.tiles[0][2]
    const restCenters = rest.tiles.map(centerX)
    const restGaps = rest.tiles.slice(1).map((r, i) => r[0] - (rest.tiles[i][0] + rest.tiles[i][2]))
    const probeY = rest.tiles[0][1] + rest.tiles[0][3] / 2
    readings.tileCount = rest.tiles.length
    readings.tileSize = Number(tileSize.toFixed(2))
    readings.restPlate = rest.plate.map((n) => Number(n.toFixed(2)))
    console.log(
      `  静止:${rest.tiles.length} 块瓦,瓦宽 ${tileSize.toFixed(1)}px,底板 [${readings.restPlate.join(', ')}],探针 y=${probeY.toFixed(1)}`,
    )
    // ⑧ 截的是**视口里那一块固定的区域**(基准矩形外扩 12px),不是元素本身 ——
    // 新做法的底板是条的一个子元素、会长到条外去,截元素两边框不住同一块地方。
    const clip = {
      x: Math.max(0, Math.floor(rest.plate[0] - 12)),
      y: Math.max(0, Math.floor(rest.plate[1] - 12)),
      width: Math.ceil(rest.plate[2] + 24),
      height: Math.ceil(rest.plate[3] + 24),
    }
    const shot = await page.screenshot({ clip })
    readings.restShotSha256 = createHash('sha256').update(shot).digest('hex').slice(0, 16)
    readings.restShotBytes = shot.length
    if (outDir) writeFileSync(path.join(outDir, 'dock-rest.png'), shot)
    console.log(`  静息截图 ${shot.length}B sha256:${readings.restShotSha256}`)

    console.log('\n[4/10] ①a 入场落定后指针纹丝不动:60 帧里有几帧变了')
    const target = restCenters[Math.floor(restCenters.length / 2)]
    await move(cdp, target, probeY)
    await settle(page, 1200, ENTER_SETTLE_MS)
    const still = await sampleFrames(page, STILL_FRAMES)
    let stillChanged = 0
    let stillWorst = 0
    for (let i = 1; i < still.length; i += 1) {
      const d = Math.max(
        maxAbs(still[i].plate.map((n, j) => n - still[i - 1].plate[j])),
        ...still[i].tiles.map((r, k) => maxAbs(r.map((n, j) => n - still[i - 1].tiles[k][j]))),
      )
      if (d > STILL_EPSILON) stillChanged += 1
      stillWorst = Math.max(stillWorst, d)
    }
    readings.stillChangedFrames = stillChanged
    readings.stillWorstPx = Number(stillWorst.toFixed(3))
    console.log(`  ${still.length} 帧里 ${stillChanged} 帧有变化,最大一帧动了 ${readings.stillWorstPx}px`)
    check(stillChanged === 0, `①a 手停着画面就是死的(${STILL_FRAMES} 帧里 0 帧变化,实测 ${stillChanged} 帧)`)

    console.log('\n[5/10] ② 匀速扫过 + ①b 骤停:抖动的两条读数')
    await move(cdp, 10, 10)
    await settle(page)
    const sweepFrom = restCenters[0]
    const sweepTo = restCenters[restCenters.length - 1]
    const steps = Math.ceil((sweepTo - sweepFrom) / SWEEP_STEP_PX)
    // 先进条并等镜头开完 —— ② 问的是**跟手**,不是入场(入场归 ③)。
    await move(cdp, sweepFrom, probeY)
    await settle(page, 1200, ENTER_SETTLE_MS)
    const sweepSampling = sampleFrames(page, steps + 8)
    for (let i = 1; i <= steps; i += 1) {
      await move(cdp, sweepFrom + i * SWEEP_STEP_PX, probeY)
      await delay(SWEEP_TICK_MS)
    }
    const sweep = await sweepSampling
    // 扫完之后的尾巴(①b):最后一次 move 之后还在动的那几帧。
    const tail = await sampleFrames(page, 12)
    const settledAfterSweep = await settle(page)

    // 扫描期间窗口 / 瓦数变了的话,下面那两条读的就不是同一件事 —— 当场判无效,
    // 不许把「窗口挪了窝」记成「镜头在抖」。
    const viewports = [...new Set(sweep.map((f) => f.viewport.join('×')))]
    readings.sweepViewports = viewports
    const counts = [...new Set(sweep.map((f) => f.tiles.length))]
    const plateMoves = sweep.map((f) => f.plate[0])
    readings.sweepTileCounts = counts
    readings.sweepPlateRange = [Math.min(...plateMoves), Math.max(...plateMoves)].map((n) => Number(n.toFixed(2)))
    if (counts.length > 1) console.log(`  ⚠ 扫描期间瓦数变过:${counts.join(' → ')}`)
    const tileSeries = rest.tiles.map((_, i) => sweep.map((f) => centerX(f.tiles[i] ?? [NaN, 0, 0, 0])))
    const plateSeries = sweep.map((f) => f.plate[0])
    readings.sweepFrames = sweep.length
    readings.tileReversals = tileSeries.map((s) => reversals(s, REVERSAL_DEADBAND_PX))
    readings.plateReversals = reversals(plateSeries, REVERSAL_DEADBAND_PX)
    readings.tileReversalMax = Math.max(...readings.tileReversals)
    readings.tileWobblePx = Number(Math.max(...tileSeries.map((s) => wobble(s, WOBBLE_WINDOW))).toFixed(3))
    readings.plateWobblePx = Number(wobble(plateSeries, WOBBLE_WINDOW).toFixed(3))
    console.log(`  ${sweep.length} 帧;逐块反转次数 [${readings.tileReversals.join(', ')}],底板 ${readings.plateReversals}`)
    console.log(`  ${WOBBLE_WINDOW} 帧窗口内非单调量:瓦 ${readings.tileWobblePx}px,底板 ${readings.plateWobblePx}px`)
    {
      const worst = tileSeries.reduce((a2, s2) => (wobble(s2, WOBBLE_WINDOW) > wobble(a2, WOBBLE_WINDOW) ? s2 : a2), tileSeries[0])
      let at = 1
      for (let i = 2; i < worst.length; i += 1) if (Math.abs(worst[i] - worst[i - 1]) > Math.abs(worst[at] - worst[at - 1])) at = i
      console.log(`  最坏那块瓦第 ${at} 帧跳了 ${(worst[at] - worst[at - 1]).toFixed(2)}px;前后 [${worst.slice(Math.max(at - 4, 0), at + 4).map((v) => v.toFixed(1)).join(', ')}]`)
      console.log(`  扫描期间瓦数 ${readings.sweepTileCounts.join('/')},底板左缘 ${readings.sweepPlateRange.join(' -> ')}`)
    }
    check(
      viewports.length === 1 && counts.length === 1,
      `② 读数有效(扫描全程窗口与瓦数不变;实测 窗口 ${viewports.join(' / ')},瓦数 ${counts.join(' / ')})`,
    )
    check(
      readings.tileReversalMax <= MAX_REVERSALS && readings.plateReversals <= MAX_REVERSALS,
      `②a 匀速扫过零抖动(方向反转 ≤ ${MAX_REVERSALS};实测 瓦 ${readings.tileReversalMax} / 底板 ${readings.plateReversals})`,
    )
    check(
      readings.tileWobblePx <= MAX_WOBBLE_PX && readings.plateWobblePx <= MAX_WOBBLE_PX,
      `②b ${WOBBLE_WINDOW} 帧窗口内非单调量 ≤ ${MAX_WOBBLE_PX}px(实测 瓦 ${readings.tileWobblePx} / 底板 ${readings.plateWobblePx})`,
    )

    let tailFrames = tail.length
    for (let i = 0; i < tail.length; i += 1) {
      if (tail.slice(i).every((f) => sameRects(f, settledAfterSweep))) {
        tailFrames = i
        break
      }
    }
    readings.tailFrames = tailFrames
    readings.tailDriftPx = Number(
      maxAbs(tail[0].tiles.flatMap((r, k) => r.map((n, j) => n - settledAfterSweep.tiles[k][j]))).toFixed(3),
    )
    console.log(`  骤停后 ${tailFrames} 帧咬住最终值(第一帧离终值 ${readings.tailDriftPx}px)`)
    check(
      tailFrames <= MAX_TAIL_FRAMES,
      `①b 手一停画面就停(骤停后 ≤ ${MAX_TAIL_FRAMES} 帧到终值,实测 ${tailFrames} 帧)`,
    )

    console.log('\n[6/10] ⑤ 放大到顶:相邻缝与静止缝逐字节同(零重叠的强化式)')
    const peak = settledAfterSweep
    const peakGaps = peak.tiles.slice(1).map((r, i) => r[0] - (peak.tiles[i][0] + peak.tiles[i][2]))
    readings.gapDriftPx = Number(maxAbs(peakGaps.map((g, i) => g - restGaps[i])).toFixed(2))
    readings.minGapPx = Number(Math.min(...peakGaps).toFixed(2))
    console.log(`  最小缝 ${readings.minGapPx}px;与静止缝最大差 ${readings.gapDriftPx}px`)
    check(
      readings.gapDriftPx <= MAX_GAP_DRIFT_PX,
      `⑤ 相邻缝恒等于静止缝(最大差 ${readings.gapDriftPx}px ≤ ${MAX_GAP_DRIFT_PX})`,
    )

    console.log('\n[7/10] ③ 入场:逐帧看它是鼓起来的还是跳过去的')
    await move(cdp, 10, 10)
    await settle(page)
    const entrySampling = sampleFrames(page, 45)
    await move(cdp, target, probeY)
    const entry = await entrySampling
    const entryF = entry.map((f) => factorsOf(f.tiles, tileSize))
    const final = entryF[entryF.length - 1]
    const startIdx = entryF.findIndex((f) => f.some((v) => Math.abs(v - 1) > REST_EPSILON))
    const entrySteps = []
    for (let i = Math.max(startIdx, 1); i < entryF.length; i += 1) {
      // 掉帧那一帧本来就该走得更远,判它红是判错了物理 —— 所以**只往下归一**。
      const dt = Math.max(entry[i].t - entry[i - 1].t, 1)
      entrySteps.push(maxAbs(entryF[i].map((v, j) => v - entryF[i - 1][j])) * Math.min(FRAME_MS / dt, 1))
    }
    const settledAt = entryF.findIndex(
      (f, i) => i >= startIdx && f.every((v, j) => Math.abs(v - final[j]) <= ENTRY_SETTLED),
    )
    readings.entryPeakFactor = Number(Math.max(...final).toFixed(3))
    readings.entryMaxStep = Number(maxAbs(entrySteps).toFixed(3))
    readings.entryMaxStepPx = Number((maxAbs(entrySteps) * tileSize).toFixed(2))
    readings.entryMs =
      settledAt < 0 ? -1 : Number((entry[settledAt].t - entry[Math.max(startIdx - 1, 0)].t).toFixed(1))
    readings.entrySteps = entrySteps.slice(0, 14).map((v) => Number(v.toFixed(3)))
    console.log(`  峰值系数 ${readings.entryPeakFactor};逐帧涨幅 [${readings.entrySteps.join(', ')}]`)
    console.log(
      `  最大单帧涨幅 ${readings.entryMaxStep}(= ${readings.entryMaxStepPx}px);到位 ${readings.entryMs}ms`,
    )
    check(
      readings.entryMaxStep <= MAX_ENTRY_STEP,
      `③ 入场无单帧跳变(几何上限 ${MAX_ENTRY_STEP.toFixed(3)},实测 ${readings.entryMaxStep})`,
    )
    check(
      readings.entryMs > 0 && readings.entryMs <= MAX_ENTRY_MS,
      `③ 入场 ≤ ${MAX_ENTRY_MS}ms 到位(实测 ${readings.entryMs}ms)`,
    )

    console.log('\n[8/10] ④ 收回 + ⑥ 确定性')
    const releaseSampling = sampleFrames(page, 40)
    await move(cdp, 10, 10)
    const release = await releaseSampling
    const relF = release.map((f) => ({ t: f.t, f: factorsOf(f.tiles, tileSize) }))
    const relStart = relF.findIndex((s, i) => i > 0 && maxAbs(s.f.map((v, j) => v - relF[i - 1].f[j])) > 0.001)
    const relEnd = relF.findIndex(
      (s, i) => i >= relStart && relStart >= 0 && s.f.every((v) => v - 1 <= REST_EPSILON),
    )
    readings.releaseMs =
      relStart < 0 || relEnd < 0 ? -1 : Number((relF[relEnd].t - relF[relStart - 1].t).toFixed(1))
    const backToRest = await settle(page)
    readings.restReturnSame = sameRects(backToRest, rest)
    console.log(`  收回耗时 ${readings.releaseMs}ms;回到的基准与进条前${readings.restReturnSame ? '逐字节同' : '**不同**'}`)
    check(
      readings.releaseMs > 0 && readings.releaseMs <= MAX_RELEASE_MS,
      `④ 手离开后 ≤ ${MAX_RELEASE_MS}ms 回到静止(实测 ${readings.releaseMs}ms)`,
    )
    check(readings.restReturnSame, '④ 回到的基准矩形与进条前逐字节相同')

    await move(cdp, target, probeY)
    const first = await settle(page, 1200, ENTER_SETTLE_MS)
    await move(cdp, 10, 10)
    await settle(page, 1200, ENTER_SETTLE_MS)
    await move(cdp, target, probeY)
    const second = await settle(page, 1200, ENTER_SETTLE_MS)
    readings.deterministic = sameRects(first, second)
    check(readings.deterministic, '⑥ 同一个 x 进两次,几何逐字相同(确定性)')

    console.log('\n[9/10] ⑦ reduced-motion 档:瞬到')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await move(cdp, 10, 10)
    await settle(page)
    const reducedSampling = sampleFrames(page, 12)
    await move(cdp, target, probeY)
    const reduced = await reducedSampling
    const redF = reduced.map((f) => factorsOf(f.tiles, tileSize))
    const redFinal = redF[redF.length - 1]
    const redStart = redF.findIndex((f) => f.some((v) => Math.abs(v - 1) > REST_EPSILON))
    const redDone = redF.findIndex(
      (f, i) => i >= redStart && redStart >= 0 && f.every((v, j) => Math.abs(v - redFinal[j]) <= REST_EPSILON),
    )
    readings.reducedFrames = redStart < 0 || redDone < 0 ? -1 : redDone - redStart + 1
    console.log(`  reduced-motion:${readings.reducedFrames} 帧到目标`)
    check(
      readings.reducedFrames > 0 && readings.reducedFrames <= MAX_REDUCED_FRAMES,
      `⑦ reduced-motion 档一帧到位(实测 ${readings.reducedFrames} 帧)`,
    )
    await page.emulateMedia({ reducedMotion: null })

    // ⑧ 用完不留痕:镜头从头到尾走了一遍,回到静息的那张脸得与开场那张逐字节相同。
    await move(cdp, 10, 10)
    await settle(page, 1200, ENTER_SETTLE_MS)
    const closing = await page.screenshot({ clip })
    readings.closingShotSha256 = createHash('sha256').update(closing).digest('hex').slice(0, 16)
    check(
      readings.closingShotSha256 === readings.restShotSha256,
      `⑧ 用完回到静息那张脸与开场逐字节相同(${readings.restShotSha256} vs ${readings.closingShotSha256})`,
    )

    console.log('\n[10/10] ⑨ 设置里关掉磁性放大:匀速扫一遍,屏幕上一个像素都不许动')
    /*
     * 走**存盘 + reload** 而不是直接改 DOM:门要证的是整条链(设置 → 存盘 → store →
     * Dock → useDockLens)都成立,贴个属性只证了最后一段(与 gate-motion 同一手)。
     */
    await move(cdp, 10, 10)
    await page.evaluate(
      ([key, version]) => {
        const raw = window.localStorage.getItem(key)
        const prev = raw ? JSON.parse(raw) : { state: {}, version }
        window.localStorage.setItem(
          key,
          JSON.stringify({ ...prev, state: { ...prev.state, dockMagnify: false }, version }),
        )
      },
      [STAGE_KEY, STAGE_VERSION],
    )
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await waitFor('关掉放大之后 Dock 还在', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-dock="strip"] > div button'))),
    )
    await waitFor('主题贴到 :root 上', () =>
      page.evaluate(() =>
        Boolean(
          getComputedStyle(document.documentElement).getPropertyValue('--ui-surface-panel-bg').trim(),
        ),
      ),
    )
    await move(cdp, 10, 10)
    const offRest = await settle(page)
    const offSampling = sampleFrames(page, OFF_SWEEP_FRAMES)
    for (let i = 0; i < OFF_SWEEP_FRAMES - 4; i += 1) {
      await move(cdp, restCenters[0] + i * 8, probeY)
      await delay(SWEEP_TICK_MS)
    }
    const off = await offSampling
    const offMoved = off.filter((f) => !sameRects(f, offRest)).length
    readings.offSweepMovedFrames = offMoved
    readings.offLensAttr = await page.evaluate(() =>
      document.querySelector('[data-dock="strip"]')?.getAttribute('data-lens'),
    )
    console.log(
      `  ${off.length} 帧里 ${offMoved} 帧动过;镜头开关 data-lens=${JSON.stringify(readings.offLensAttr)}`,
    )
    check(
      offMoved === 0 && readings.offLensAttr === null,
      `⑨ 关掉放大之后指针扫过条:${OFF_SWEEP_FRAMES} 帧零变化且镜头开关始终没挂(实测 ${offMoved} 帧 / ${JSON.stringify(readings.offLensAttr)})`,
    )

    await app.close()
    app = undefined
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }

  if (outDir) writeFileSync(path.join(outDir, 'dock-readings.json'), JSON.stringify(readings, null, 2))
  console.log(`\n[dock-gate] 读数:${JSON.stringify(readings)}`)
  if (failures.length) {
    console.error(`\n[dock-gate] FAILED(${failures.length} 条):\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log(
    '\n[dock-gate] ok —— 手停画面停 / 匀速零抖 / 入场无跳 / 收回归位 / 缝恒定 / 确定 / reduced 瞬到 / 关掉即静止',
  )
}

main().catch((error) => {
  console.error('\n[dock-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
