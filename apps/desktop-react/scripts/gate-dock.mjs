#!/usr/bin/env node
/**
 * Dock 磁性放大的**真机门**(09-02「现在的不顺手」重做批)。
 *
 * 用户的报障是手感,手感在纸上诊断不出来 —— 这条门把「不顺手」翻译成五个读数,
 * 于是它既是改前的复现,也是改后的验收。五条各查一件事:
 *
 *  ① **指针停在一块瓦的静止中心上时,那块瓦一个像素都不许动**。逐块量
 *     「此刻的中心 − 静止的中心」。这个差在**条中段**天然是 0(左右生长对称,
 *     条居中长,一半的退让恰好抵消一半的推挤),而在**两端**不是:余弦核被条端
 *     截断,左边长的和右边长的不一样多,而条只会朝两边各退一半 —— 差额就是漂移。
 *     顺带沿条每 8px 走一遍,量**连续性**:任何一块瓦一步之内不许跳。
 *     (「一步之内不许跳」是钉住式修法的守卫:钉「那块瓦的中心」是做不到的 ——
 *     指针从一块瓦交到下一块时它会要求条瞬移十来个像素;能钉住且连续的只有
 *     **指针脚下那一点**,而钉住那一点等价于让每块瓦的中心在过它时恰好回零。)
 *  ② **入场不许有一帧跳**。两问:
 *     ②a 从条外落进来、指针不动 —— 逐帧采系数,单帧涨幅有上限、几帧内到位;
 *     ②b 从条外进来**并持续横扫** —— 这才是「不顺手」的真现场:改前的入场缓冲
 *     是「160ms 里吃一条 CSS 过渡」,而 rAF 每帧都在改目标,过渡永远追不上;
 *     160ms 一到把 `--tile-size-dur` 掰成 0ms,攒下的滞后当帧一次性补齐。
 *     指针不动时那条过渡能顺顺当当跑完(所以 ②a 单独测抓不到它),一边走一边
 *     进才现形。判据:越过入场那几帧之后,单帧涨幅不许超过**几何上限**
 *     (系数对位移的最大斜率 × 这一帧指针走了多远)的两倍。
 *  ③ **手离开要在一个回位时长内收干净**(--dur-release 的量级)。
 *  ④ **相邻两瓦零重叠**(挤压纪律)。放大走布局尺寸就该天然成立,这条是它的守卫:
 *     哪天有人改回 transform: scale,这里当场红(08-28 的「鼓包挤成一坨」)。
 *  ⑤ **reduced-motion 档瞬到**:一帧到目标,不插值。
 *
 * ── 量法 ───────────────────────────────────────────────────────────────────
 * 指针一律走 CDP `Input.dispatchMouseEvent`:只进目标窗口,**不动真光标、不抢焦点**
 * (09-01 判例:系统级合成输入干扰用户用电脑)。尺寸系数不从 JS 里读私有状态,
 * 而是量**瓦的矩形宽度 ÷ 静止宽度** —— 这样同一份脚本能原样跑在改前的代码上
 * (改前没有「系数」这个出口),before/after 才可比。
 *
 * 「等它稳住」不是「等 2 帧」:改后跟手期本身带一个指数插值,2 帧还没收敛,
 * 而改前跟手期是零过渡当帧到位。两边都用同一条「连续 3 帧矩形不变」的判据,
 * 读的才是同一件事(**静态钉住**),不是「谁的插值更快」。
 *
 * 跑法:`npm run gate:dock`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 可重复:每次一个全新的临时 store + 全新的 --user-data-dir,跑完删干净。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
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

/** ① 瓦停在自己静止中心上时的最大允许漂移(px)。1 = 一个物理像素。 */
const MAX_DRIFT_PX = 1
/** ① 沿条走的步长(px)。 */
const WALK_STEP_PX = 8
/**
 * ① 连续性:沿条走一步(8px),任何一块瓦的中心最多能挪多远。
 *
 * 这个数是**几何算出来的**,不是拍的:系数对指针位移的最大斜率是
 * `MAX_GROW·π/(2R)` = 0.35π/192 ≈ 0.00573 /px,一块瓦的宽度变化率就是它乘瓦宽
 * (44 → 0.252 px/px),而一块瓦的中心挪多快至多是它左边那些瓦的变化率之和 ——
 * 半径内至多 4 块同时在变,所以 8px 一步的上限约 8 × 0.252 × 4 ≈ 8px。
 * 取 8 是「连续」的守卫,不是「小」的守卫:钉瓦心那种做法一步会跳 10px 以上。
 */
const MAX_WALK_STEP_PX = 8
/**
 * ② 入场时单帧允许的系数涨幅(按 16.7ms 归一 —— 掉帧时一帧本来就该走得更远,
 * 那是对的物理,不该判它红)。0.08 在 md 档(44px)= 3.5px/帧。
 */
const MAX_ENTRY_STEP = 0.08
/**
 * ② 入场「到位」的判据与上限**耗时**。到位 = 离目标 0.05 以内(md 档 2.2px)。
 *
 * 判耗时不判帧数:这台机器的屏是 120Hz,同一段动作按帧数数出来是 60Hz 机器的两倍,
 * 门会跟着屏幕的刷新率变红变绿 —— 那判的就不是产品了。100ms = 6 帧 @60fps,
 * 也是编排令那句「≤ 6 帧到位」换算过来的同一个意思。
 */
const ENTRY_SETTLED = 0.05
const MAX_ENTRY_MS = 100
/** ②b 横扫时单帧涨幅的上限 = 几何上限的 2 倍。几何上限见 MAX_WALK_STEP_PX 那段。 */
const SWEEP_SLOPE_PER_PX = (0.35 * Math.PI) / (2 * 96)
const SWEEP_HEADROOM = 2
/** ②b 横扫的步长与节拍(≈ 500px/s,一次真实的扫条速度)。 */
const SWEEP_STEP_PX = 8
const SWEEP_TICK_MS = 16
/** ②b 越过入场那几帧才开始判(前几帧的鼓起由 ②a 管)。 */
const SWEEP_SKIP_FRAMES = 6
/** ③ 手离开后收回静止的上限(ms)。--dur-release 是 160ms,留一档余量。 */
const MAX_RELEASE_MS = 200
/** ④ 相邻两瓦允许的重叠(px)。0.5 是亚像素取整的余量,不是放水。 */
const MAX_OVERLAP_PX = 0.5
/** ⑤ reduced-motion 档「瞬到」的帧数上限。 */
const MAX_REDUCED_FRAMES = 1
/** 判「系数已经回到静止」的阈值。0.005 在 md 档 = 0.22px。 */
const REST_EPSILON = 0.005
/** 一帧的名义长度(ms)—— 单帧涨幅按它归一。 */
const FRAME_MS = 1000 / 60

const failures = []
const readings = {}

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
 * 量各瓦的矩形。**瓦 = 条的每个直接子 div(.wrap)里那颗 button** ——
 * 分隔线是 `<span>`,天然不进这张表;`[data-testid^=dock-tile]` 会漏掉「+」那块
 * (它没有 testId),而放大是按格子的线性次序算的,漏一格就对不上号。
 */
const READ_TILES_SRC = `[...document.querySelectorAll('[data-dock="strip"] > div')]
  .map((w) => w.querySelector('button'))
  .filter(Boolean)
  .map((t) => { const r = t.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] })`

/**
 * 等到连续 3 帧矩形不变(或超时),返回最后一次读数。
 *
 * 读瓦的那段表达式经 `new Function` 现造 —— 打包产物里这段脚本是**注入**的,
 * 把同一份读法在三个探针里各抄一遍是三处会分叉的地方。
 */
function settleTiles(page, maxMs = 900) {
  return page.evaluate(
    async ([readSrc, cap]) => {
      const read = new Function(`return ${readSrc}`)
      const t0 = performance.now()
      let prev = read()
      let stable = 0
      while (performance.now() - t0 < cap) {
        await new Promise((r) => requestAnimationFrame(r))
        const cur = read()
        const same =
          cur.length === prev.length &&
          cur.every((v, i) => v.every((n, j) => Math.abs(n - prev[i][j]) < 0.01))
        stable = same ? stable + 1 : 0
        prev = cur
        if (stable >= 3) break
      }
      return prev
    },
    [READ_TILES_SRC, maxMs],
  )
}

/** 逐帧采样 n 帧(带时间戳),给入场 / 释放两条曲线用。 */
function sampleFrames(page, frames) {
  return page.evaluate(
    async ([readSrc, n]) => {
      const read = new Function(`return ${readSrc}`)
      const out = []
      for (let i = 0; i < n; i += 1) {
        await new Promise((r) => requestAnimationFrame(r))
        out.push({ t: performance.now(), rects: read() })
      }
      return out
    },
    [READ_TILES_SRC, frames],
  )
}

function move(cdp, x, y) {
  return cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
}

/* ── 几何小工具 ───────────────────────────────────────────────────────────── */

const centerX = (r) => r[0] + r[2] / 2
const factorsOf = (rects, tileSize) => rects.map((r) => r[2] / tileSize)
const maxAbs = (xs) => xs.reduce((m, v) => Math.max(m, Math.abs(v)), 0)

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
    console.log('\n[1/8] 起一台 core')
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

    console.log('\n[2/8] 拉起应用(独立 --user-data-dir)')
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
    const cdp = await app.context().newCDPSession(page)
    console.log('  ✓ 外壳画出来了,CDP 会话已开')

    console.log('\n[3/8] 静止坐标系:把指针挪到条外,等它稳住')
    await move(cdp, 10, 10)
    const rest = await settleTiles(page)
    const tileSize = rest[0][2]
    const restCenters = rest.map(centerX)
    const probeY = rest[0][1] + rest[0][3] / 2
    console.log(
      `  静止:${rest.length} 块瓦,瓦宽 ${tileSize.toFixed(1)}px,` +
        `中心 [${restCenters.map((c) => c.toFixed(1)).join(', ')}],探针 y=${probeY.toFixed(1)}`,
    )
    readings.tileCount = rest.length
    readings.tileSize = Number(tileSize.toFixed(2))

    console.log('\n[4/8] ①a 逐块停在自己的静止中心上:那块瓦动了没有')
    const pins = []
    for (let i = 0; i < restCenters.length; i += 1) {
      await move(cdp, restCenters[i], probeY)
      const live = await settleTiles(page)
      if (live.length !== rest.length) continue
      pins.push({ i, drift: centerX(live[i]) - restCenters[i] })
    }
    readings.pinDriftPx = pins.map((s) => Number(s.drift.toFixed(2)))
    readings.pinDriftMaxPx = Number(maxAbs(pins.map((s) => s.drift)).toFixed(2))
    const worstPin = pins.reduce((a2, b2) => (Math.abs(b2.drift) > Math.abs(a2.drift) ? b2 : a2), pins[0])
    console.log(`  逐块漂移 [${readings.pinDriftPx.join(', ')}]`)
    console.log(`  最大 ${readings.pinDriftMaxPx}px(第 ${worstPin.i} 块;两端是 ${readings.pinDriftPx[0]} / ${readings.pinDriftPx[readings.pinDriftPx.length - 1]})`)
    check(
      readings.pinDriftMaxPx <= MAX_DRIFT_PX,
      `①a 每块瓦停在自己中心上时漂移 ≤ ${MAX_DRIFT_PX}px(实测 ${readings.pinDriftMaxPx}px)`,
    )

    console.log('\n[5/8] ①b 沿条每 8px 走一遍:有没有哪一步跳了')
    const walk = []
    const firstLeft = rest[0][0]
    const lastRight = rest[rest.length - 1][0] + rest[rest.length - 1][2]
    for (let x = Math.ceil(firstLeft); x <= Math.floor(lastRight); x += WALK_STEP_PX) {
      await move(cdp, x, probeY)
      const live = await settleTiles(page)
      if (live.length !== rest.length) continue
      walk.push({ x, centers: live.map(centerX) })
    }
    let walkStep = 0
    let walkAt = 0
    for (let i = 1; i < walk.length; i += 1) {
      const d = maxAbs(walk[i].centers.map((c, j) => c - walk[i - 1].centers[j]))
      if (d > walkStep) {
        walkStep = d
        walkAt = walk[i].x
      }
    }
    readings.walkSamples = walk.length
    readings.walkMaxStepPx = Number(walkStep.toFixed(2))
    console.log(`  ${walk.length} 个采样点;一步之内任何一块瓦最多挪 ${readings.walkMaxStepPx}px(x=${walkAt})`)
    check(
      readings.walkMaxStepPx <= MAX_WALK_STEP_PX,
      `①b 沿条走一步没有瞬移(任何一块瓦 ≤ ${MAX_WALK_STEP_PX}px,实测 ${readings.walkMaxStepPx}px)`,
    )

    console.log('\n[6/8] ②a 落进来不动:逐帧看它是鼓起来的还是跳过去的')
    await move(cdp, 10, 10)
    await settleTiles(page)
    const target = restCenters[Math.floor(restCenters.length / 2)]
    const entrySampling = sampleFrames(page, 45)
    await move(cdp, target, probeY)
    const entry = await entrySampling
    const entryF = entry.map((f) => factorsOf(f.rects, tileSize))
    const final = entryF[entryF.length - 1]
    const startIdx = entryF.findIndex((f) => f.some((v) => Math.abs(v - 1) > REST_EPSILON))
    const steps = []
    for (let i = Math.max(startIdx, 1); i < entryF.length; i += 1) {
      // 掉帧那一帧本来就该走得更远,判它红是判错了物理 —— 所以**只往下归一**:
      // dt 比一帧长就按比例折算回来,比一帧短则原样算(短帧里走一大步仍是跳)。
      const dt = Math.max(entry[i].t - entry[i - 1].t, 1)
      const scale = Math.min(FRAME_MS / dt, 1)
      steps.push(maxAbs(entryF[i].map((v, j) => v - entryF[i - 1][j])) * scale)
    }
    const settledAt = entryF.findIndex(
      (f, i) => i >= startIdx && f.every((v, j) => Math.abs(v - final[j]) <= ENTRY_SETTLED),
    )
    readings.entryPeakFactor = Number(Math.max(...final).toFixed(3))
    readings.entryMaxStep = Number(maxAbs(steps).toFixed(3))
    readings.entryMaxStepFrame = steps.indexOf(Math.max(...steps.map(Math.abs))) + 1
    readings.entryFrames = settledAt < 0 ? -1 : settledAt - startIdx + 1
    readings.entryMs =
      settledAt < 0 ? -1 : Number((entry[settledAt].t - entry[Math.max(startIdx - 1, 0)].t).toFixed(1))
    readings.entrySteps = steps.slice(0, 12).map((v) => Number(v.toFixed(3)))
    console.log(`  峰值系数 ${readings.entryPeakFactor};逐帧涨幅 [${readings.entrySteps.join(', ')}]`)
    console.log(
      `  最大单帧涨幅 ${readings.entryMaxStep}(第 ${readings.entryMaxStepFrame} 帧);` +
        `到位用了 ${readings.entryMs}ms(${readings.entryFrames} 帧 —— 本机屏刷新率决定帧数,所以判的是 ms)`,
    )
    check(
      readings.entryMaxStep <= MAX_ENTRY_STEP,
      `②a 入场无单帧跳变(单帧涨幅 ≤ ${MAX_ENTRY_STEP},实测 ${readings.entryMaxStep})`,
    )
    check(
      readings.entryMs > 0 && readings.entryMs <= MAX_ENTRY_MS,
      `②a 入场 ≤ ${MAX_ENTRY_MS}ms 到位(= 6 帧 @60fps;实测 ${readings.entryMs}ms)`,
    )

    console.log('\n[7/8] ②b 一边进一边扫:入场缓冲那一下的真现场')
    await move(cdp, 10, 10)
    await settleTiles(page)
    const sweepFrom = restCenters[1]
    const sweepSampling = sampleFrames(page, 45)
    for (let i = 0; i < 30; i += 1) {
      await move(cdp, sweepFrom + i * SWEEP_STEP_PX, probeY)
      await delay(SWEEP_TICK_MS)
    }
    const sweep = await sweepSampling
    const sweepF = sweep.map((f) => factorsOf(f.rects, tileSize))
    const sweepStart = sweepF.findIndex((f) => f.some((v) => Math.abs(v - 1) > REST_EPSILON))
    const sweepSteps = []
    for (let i = Math.max(sweepStart + SWEEP_SKIP_FRAMES, 1); i < sweepF.length; i += 1) {
      const dt = Math.max(sweep[i].t - sweep[i - 1].t, 1)
      const pointerPx = (SWEEP_STEP_PX * dt) / SWEEP_TICK_MS
      const geometric = SWEEP_SLOPE_PER_PX * pointerPx
      sweepSteps.push({
        step: maxAbs(sweepF[i].map((v, j) => v - sweepF[i - 1][j])),
        limit: geometric * SWEEP_HEADROOM,
        frame: i,
      })
    }
    const worstSweep = sweepSteps.reduce(
      (a2, b2) => (b2.step - b2.limit > a2.step - a2.limit ? b2 : a2),
      sweepSteps[0] ?? { step: 0, limit: 1, frame: -1 },
    )
    readings.sweepMaxStep = Number(worstSweep.step.toFixed(3))
    readings.sweepLimit = Number(worstSweep.limit.toFixed(3))
    readings.sweepWorstFrame = worstSweep.frame
    readings.sweepSteps = sweepSteps.slice(0, 16).map((v) => Number(v.step.toFixed(3)))
    console.log(`  跨过入场那几帧之后的逐帧涨幅 [${readings.sweepSteps.join(', ')}]`)
    console.log(
      `  最坏一帧 ${readings.sweepMaxStep}(第 ${readings.sweepWorstFrame} 帧;这一帧的几何上限 × ${SWEEP_HEADROOM} = ${readings.sweepLimit})`,
    )
    check(
      worstSweep.step <= worstSweep.limit,
      `②b 横扫入场全程没有一帧超出几何上限的 ${SWEEP_HEADROOM} 倍(最坏 ${readings.sweepMaxStep} vs ${readings.sweepLimit})`,
    )

    console.log('\n[8/8] ③④⑤ 释放耗时 / 相邻零重叠 / reduced-motion')
    // 此刻还停在放大态(上一步刚进条)。先量重叠,再放手量收回。
    const peak = await settleTiles(page)
    const overlaps = []
    for (let i = 0; i + 1 < peak.length; i += 1) {
      overlaps.push(peak[i][0] + peak[i][2] - peak[i + 1][0])
    }
    readings.maxOverlapPx = Number(Math.max(...overlaps).toFixed(2))
    check(
      readings.maxOverlapPx <= MAX_OVERLAP_PX,
      `④ 放大到顶时相邻两瓦零重叠(最大重叠 ${readings.maxOverlapPx}px ≤ ${MAX_OVERLAP_PX})`,
    )

    const releaseSampling = sampleFrames(page, 40)
    await move(cdp, 10, 10)
    const release = await releaseSampling
    const relF = release.map((f) => ({ t: f.t, f: factorsOf(f.rects, tileSize) }))
    const relStart = relF.findIndex((s, i) => i > 0 && maxAbs(s.f.map((v, j) => v - relF[i - 1].f[j])) > 0.001)
    const relEnd = relF.findIndex((s, i) => i >= relStart && relStart >= 0 && s.f.every((v) => v - 1 <= REST_EPSILON))
    readings.releaseMs =
      relStart < 0 || relEnd < 0 ? -1 : Number((relF[relEnd].t - relF[relStart - 1].t).toFixed(1))
    console.log(`  收回耗时 ${readings.releaseMs}ms`)
    check(
      readings.releaseMs > 0 && readings.releaseMs <= MAX_RELEASE_MS,
      `③ 手离开后 ≤ ${MAX_RELEASE_MS}ms 回到静止(实测 ${readings.releaseMs}ms)`,
    )

    console.log('\n  —— ⑤ reduced-motion 档:瞬到')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await move(cdp, 10, 10)
    await settleTiles(page)
    const reducedSampling = sampleFrames(page, 12)
    await move(cdp, target, probeY)
    const reduced = await reducedSampling
    const redF = reduced.map((f) => factorsOf(f.rects, tileSize))
    const redFinal = redF[redF.length - 1]
    const redStart = redF.findIndex((f) => f.some((v) => Math.abs(v - 1) > REST_EPSILON))
    const redDone = redF.findIndex(
      (f, i) => i >= redStart && redStart >= 0 && f.every((v, j) => Math.abs(v - redFinal[j]) <= REST_EPSILON),
    )
    readings.reducedFrames = redStart < 0 || redDone < 0 ? -1 : redDone - redStart + 1
    console.log(`  reduced-motion:${readings.reducedFrames} 帧到目标`)
    check(
      readings.reducedFrames > 0 && readings.reducedFrames <= MAX_REDUCED_FRAMES,
      `⑤ reduced-motion 档一帧到位(实测 ${readings.reducedFrames} 帧)`,
    )
    await page.emulateMedia({ reducedMotion: null })

    await app.close()
    app = undefined
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }

  console.log(`\n[dock-gate] 读数:${JSON.stringify(readings)}`)
  if (failures.length) {
    console.error(`\n[dock-gate] FAILED(${failures.length} 条):\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\n[dock-gate] ok —— 零漂移 / 入场无跳 / 收回及时 / 零重叠 / reduced 瞬到')
}

main().catch((error) => {
  console.error('\n[dock-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
