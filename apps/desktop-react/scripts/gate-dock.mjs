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
 *  ⑧ **静息态那张脸**:把镜头从头到尾用一遍之后回到静息,截图与开场那张**同**
 *     —— 判据是**没有一个通道差得过 1/255**(09-13 从「逐字节」松到这里,量出来的
 *     理由整段写在 `comparePng` 上面)。它守的是「这套东西只在放大的时候存在」——
 *     用完不留痕。
 *     (跨版本的 before/after 截图也照样存下来,但那一份**不适合当断言**:放大从
 *     布局尺寸改成 transform 之后,瓦各自上了合成层,圆角与描边的抗锯齿必然重算 ——
 *     真机实测 7.3% 的像素差 1/255、144 个像素差到 24,全在瓦的圆角曲线上。
 *     几何那一半由 ④⑥ 逐字钉着,像素那一半只报读数不判红。)
 *  ⑩ **让位量跟着大小档走**(09-13 追补):四条边 × sm / md / lg 停稳后量**条的内侧边
 *     到 `.main` 内容边**的间距,恒等于 12(= --sp-3)。它守的是一条只有真机看得见的
 *     病:`--dock-thick` / `--dock-reserve-*` 从前声明在 tokens.css 的 `:root`,而
 *     `--dock-tile` 是外壳在 `.shell` 上覆写的 —— **自定义属性里的 `var()` 在声明那条
 *     calc 的元素上代入**,于是式子在 `:root` 那一层就把瓦代成了 44px,三档换的那个数
 *     永远到不了它。改前实测:四条边 × 三档,`.main` 那一边的 padding 恒为 86,
 *     间距 sm 20 / md 12 / lg 4。静态那一半在 `dock-reserve-css.test.ts`
 *     (式子声明在 `.shell` 上),这一条量的是后果。
 *  ⑪ **放大后探出条外的那一截也算在坞上**(09-13 追补):四条边 × md / lg 两档幅度,
 *     指针先落在瓦中心线上开镜头,再抬到「该瓦放大后内侧边之内 3px」那条线,沿**这块瓦
 *     自己**的中段匀速扫过,`data-lens` 必须全程是 `on`;再加一条 —— 从横边切到竖边
 *     之后每块瓦身上的 `--tile-dx-x` 必须是空的。
 *     两件事各对一条病:前者是**交叉轴死带**(旧判据只问条的矩形,而放大的瓦朝内长出
 *     条外 `瓦身量 × (峰值 − 1) − 9px`:md/md 6.4、lg/lg 22.2、sm/md 3.6 —— 3px 这个
 *     深度落在所有有死带的档里,sm/sm 的 −1.8 是「压根没探出」所以那一档不在表上);
 *     后者是**换轴后旧轴位移没清**(CSS 侧一条 translate() 合两轴,换边不重挂 DOM)。
 *     **为什么不横扫整条**:放大后两块瓦之间恒有一条 9px 的缝(⑤ 钉着「缝恒等于静止缝」),
 *     缝**在条的盒子之上**那一段是真空 —— 指针落进去时它离开的是条的整棵子树,
 *     `mouseleave` 照常发,镜头收起来是**设计**不是死带。所以整条横扫的亮灯占比
 *     结构上不可能是 100%,那个数这道门**只报不判**(见读数 `⑪ 整条横扫亮灯占比`)。
 *
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
import { inflateSync } from 'node:zlib'
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
/**
 * ⑩ 条外留白的目标值(px)与容差。12 = --sp-3,与「让位 = 条厚 + 两侧各 --sp-3」
 * 那条式子同源;0.5 是亚像素取整的余量,不是放水(改前的读数是 20 / 12 / 4,
 * 差着一个数量级,0.5 与 2 在这里判出来的是同一件事)。
 */
const RESERVE_GAP_PX = 12
const RESERVE_GAP_TOL = 0.5
/** ⑩ 要走一遍的四条边与三档大小。 */
const ALL_EDGES = ['bottom', 'top', 'left', 'right']
const ALL_SIZES = ['sm', 'md', 'lg']
/**
 * ⑪ 扫的那条线扎多深(px,从**放大后**那块瓦的内侧边往条那一侧量)。
 * 3 落在所有「有死带」的档里:md 档瓦 / md 幅度探出 6.4、lg 幅度 17.4、
 * lg 档瓦 / lg 幅度 22.2;sm 瓦 / sm 幅度是 −1.8(压根没探出),所以幅度那一维
 * 只走 md / lg —— 一个没有死带的档上,这条判据是恒真的,放进来只会让门更慢。
 */
const OVERHANG_PROBE_PX = 3
/** ⑪ 幅度两档(设置 → Dock → 放大幅度)。 */
const PROBE_LEVELS = ['md', 'lg']
/**
 * ⑪ 每块瓦沿主轴扫它自己的**中段**:±0.3 × 静止瓦身量。
 * 不扫满整块瓦是有理由的:瓦越偏离指针缩得越小,探出的那一截跟着变薄 ——
 * ±0.3 处峰值系数还有 1.337(md 幅度),离那条线还有 2.4px;扫到 ±0.63(放大后的
 * 边缘)只剩 0.5px,那已经是在量亚像素取整而不是在量这条判据。
 */
const TILE_RIDE_SPAN = 0.3
/** ⑪ 每档抽几块瓦(首 / 中 / 末)。整条都扫一遍只是把同一条判据重复十次。 */
const RIDE_SAMPLES = 3
/** 设置页与 Dock 设置那几件的取件口(值是数据,门按值点 —— 见 ui/Segmented 那一行)。 */
const SETTINGS_TILE = '[data-testid="dock-tile-settings"]'
const SETTINGS_NAV_DOCK = '[data-testid="settings-nav-dock"]'
const SEG = {
  edge: '[data-testid="dock-settings-edge"]',
  size: '[data-testid="dock-settings-size"]',
  level: '[data-testid="dock-settings-magnify-level"]',
}

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

/**
 * ⑩⑪ 的读数:条的矩形、`.main` 的**内容边**(边框盒去掉四向 padding —— 让位就写在
 * 那四格上)、镜头开关、各瓦(那颗 button)的矩形,以及瓦身上两格位移的**原文**
 * (空串 = 那一格没写,正是 ⑪ 后半那条判据要的)。
 *
 * `.main` 用 `document.querySelector('main')` 取:这一层是语义标签、全壳只有一个,
 * 而它的 CSS Module 类名带哈希,门里写不出来。
 */
const LAYOUT_SRC = `(() => {
  const strip = document.querySelector('[data-dock="strip"]')
  const main = document.querySelector('main')
  const sr = strip.getBoundingClientRect()
  const mr = main.getBoundingClientRect()
  const cs = getComputedStyle(main)
  const n = (k) => Number.parseFloat(cs.getPropertyValue(k)) || 0
  const box = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height] }
  const wraps = [...strip.querySelectorAll(':scope > [data-dock-tile]')]
  return {
    strip: [sr.left, sr.top, sr.width, sr.height],
    content: [mr.left + n('padding-left'), mr.top + n('padding-top'), mr.right - n('padding-right'), mr.bottom - n('padding-bottom')],
    pad: [n('padding-top'), n('padding-right'), n('padding-bottom'), n('padding-left')],
    lens: strip.getAttribute('data-lens'),
    tiles: wraps.map((w) => w.querySelector('button')).filter(Boolean).map(box),
    dxX: wraps.map((t) => t.style.getPropertyValue('--tile-dx-x')),
    dxY: wraps.map((t) => t.style.getPropertyValue('--tile-dx-y')),
  }
})()`

const readLayout = (page) => page.evaluate(LAYOUT_SRC)

/**
 * 等这份读数连续 3 帧不变(带一段起量前的静默期,理由与 `settle` 那段逐字同源)。
 * 与 `settle` 分开是因为它多量两件 `settle` 看不见的东西:`.main` 的 padding
 * (让位的落点,条是 fixed 的、padding 变了条一个像素都不动)与瓦身上的位移原文。
 */
function settleLayout(page, maxMs = 2500, minMs = 400) {
  return page.evaluate(
    async ([src, cap, floor]) => {
      const read = new Function(`return ${src}`)
      const same = (a, b) =>
        a.tiles.length === b.tiles.length &&
        a.strip.every((v, i) => Math.abs(v - b.strip[i]) < 0.01) &&
        a.content.every((v, i) => Math.abs(v - b.content[i]) < 0.01)
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
    [LAYOUT_SRC, maxMs, minMs],
  )
}

/** 逐帧采**镜头开关**(⑪ 的那一格读数),n 帧。 */
function sampleLens(page, frames) {
  return page.evaluate(async (n) => {
    const strip = document.querySelector('[data-dock="strip"]')
    const out = []
    for (let i = 0; i < n; i += 1) {
      await new Promise((r) => requestAnimationFrame(r))
      out.push(strip.getAttribute('data-lens'))
    }
    return out
  }, frames)
}

/** 点一个选择器(走元素自己的 click:**不动指针**,免得把手放到设置页上去)。 */
async function clickIn(page, selector) {
  const hit = await page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return false
    el.scrollIntoView({ block: 'center' })
    el.click()
    return true
  }, selector)
  if (!hit) throw new Error(`点不到:${selector}`)
}

/**
 * 往形态机的存盘里合进几格,**版本号原样留着**(读回来是几就写回几)——
 * ⑨ 那一段写死 `version` 是它自己的历史包袱,这里不跟。改完要 reload 才生效。
 */
async function writeStagePrefs(page, patch) {
  await page.evaluate(
    ([key, next]) => {
      const raw = window.localStorage.getItem(key)
      const prev = raw ? JSON.parse(raw) : { state: {} }
      window.localStorage.setItem(
        key,
        JSON.stringify({ ...prev, state: { ...prev.state, ...next } }),
      )
    },
    [STAGE_KEY, patch],
  )
}

/**
 * 换一格 Dock 设置。**走真控件、不重载**:
 *  · ⑩ 要证的是「换大小档之后让位自己跟着走」,而那正是一次**活的**覆写;
 *  · ⑪ 后半要证的是换轴之后旧轴的位移被摘掉,而那条病只在**不重挂 DOM** 时才现形
 *    —— 重载一次瓦全新建,inline style 天然是空的,判据会空过。
 */
const setDockPref = (page, which, value) => clickIn(page, `${SEG[which]} [data-value="${value}"]`)

/* ── ⑩⑪ 的几何小工具(按边转身;"内侧" = 朝内容那一头)────────────────────── */

/** 条的内侧边坐标(横边取 y、竖边取 x)。strip = [l, t, w, h]。 */
const stripInnerOf = {
  bottom: (r) => r[1],
  top: (r) => r[1] + r[3],
  left: (r) => r[0] + r[2],
  right: (r) => r[0],
}
/** `.main` 内容边在那一侧的坐标。content = [l, t, r, b]。 */
const contentEdgeOf = {
  bottom: (c) => c[3],
  top: (c) => c[1],
  left: (c) => c[0],
  right: (c) => c[2],
}
/** 条内侧边与内容边之间的净间距(恒为正,朝哪边都一样读)。 */
const reserveGapOf = (edge, layout) => {
  const inner = stripInnerOf[edge](layout.strip)
  const content = contentEdgeOf[edge](layout.content)
  return edge === 'bottom' || edge === 'right' ? inner - content : content - inner
}
/** 一块瓦(button 矩形)的内侧边坐标。 */
const tileInnerOf = {
  bottom: (r) => r[1],
  top: (r) => r[1] + r[3],
  left: (r) => r[0] + r[2],
  right: (r) => r[0],
}
/** 从内侧边往**条那一侧**扎 d px 得到的交叉轴坐标。 */
const probeLineOf = (edge, innerEdge, d) =>
  edge === 'bottom' || edge === 'right' ? innerEdge + d : innerEdge - d
/** 主轴坐标(横边 = x,竖边 = y)。 */
const isHorizontal = (edge) => edge === 'bottom' || edge === 'top'
const mainCenterOf = (edge, r) => (isHorizontal(edge) ? r[0] + r[2] / 2 : r[1] + r[3] / 2)
const mainSizeOf = (edge, r) => (isHorizontal(edge) ? r[2] : r[3])
/** 把 (主轴, 交叉轴) 翻成 CDP 要的 (x, y)。 */
const atPoint = (edge, main, cross) => (isHorizontal(edge) ? [main, cross] : [cross, main])

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

/* ── ⑧ 的两张图怎么比 ─────────────────────────────────────────────────────────
 * **判据从「逐字节」松到「没有一个通道差得过 1/255」**(09-13 改,理由是量出来的):
 *
 * ⑧ 问的是「这套东西用完不留痕」—— 几何那一半由 ④⑥ 逐字钉着,这一条守的是**画面**。
 * 而画面这一侧有一层它管不着的噪声:放大从布局尺寸改成 transform 之后瓦各自上了
 * 合成层,合成层的取整与抗锯齿会重算 —— 这个文件原来就写着这句话(见 ⑧ 那一段的
 * 括号:跨版本 before/after「7.3% 的像素差 1/255」),只是当时认为同一次跑里不会出现。
 *
 * 09-13 实测它会:把这道门从「窗子亮在屏上」改成屏外档(ONETHING_GATE_OFFSCREEN,
 * 理由见上面 launch 那一段)之后,开场与收场那两张图连着四次跑都差 —— 而差的是
 * **6038/234952 个像素、每个通道最多差 1**,且差的地方**包括条盒之外那几行纯色背景**
 * (第 0 行 1274 个、第 15/16 行各约 1280 个)。条外的纯底色不可能因为 Dock 的放大而变,
 * 所以这不是产品的痕迹,是**捕获这一侧**的取整。
 *
 * 逐字节那条判据于是在量一件它本来就声明不管的事。松到 1/255:任何真的残留
 * (一格没缩回去的瓦、一条没退的投影、一个亮着的开关)都是几十上百的通道差,
 * 照样当场红;读数里两张图的 sha、差了几个像素、最大差多少,一条不少地报出来。
 * ────────────────────────────────────────────────────────────────────────── */

/** ⑧ 允许的**单通道**最大差(255 制)。1 = 合成层取整的那一档,不是放水。 */
const SHOT_CHANNEL_TOL = 1

/**
 * 解一张 8 位 PNG(色型 2 = RGB / 6 = RGBA)成 {w, h, bpp, px}。
 * 手写是因为这道门不许多一个依赖;认不出的格式返回 undefined,调用方退回逐字节比。
 */
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) return undefined
  let i = 8
  let ihdr
  const idat = []
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i)
    const type = buf.toString('ascii', i + 4, i + 8)
    const data = buf.subarray(i + 8, i + 8 + len)
    if (type === 'IHDR') {
      ihdr = {
        w: data.readUInt32BE(0),
        h: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
        interlace: data[12],
      }
    } else if (type === 'IDAT') idat.push(data)
    i += 12 + len
  }
  if (!ihdr || ihdr.depth !== 8 || ihdr.interlace !== 0) return undefined
  const channels = ihdr.color === 2 ? 3 : ihdr.color === 6 ? 4 : 0
  if (!channels) return undefined
  const raw = inflateSync(Buffer.concat(idat))
  const stride = ihdr.w * channels
  const px = Buffer.alloc(stride * ihdr.h)
  let prev = Buffer.alloc(stride)
  let pos = 0
  for (let y = 0; y < ihdr.h; y += 1) {
    const filter = raw[pos]
    pos += 1
    const line = Buffer.from(raw.subarray(pos, pos + stride))
    pos += stride
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      if (filter === 1) line[x] = (line[x] + a) & 255
      else if (filter === 2) line[x] = (line[x] + b) & 255
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    }
    line.copy(px, y * stride)
    prev = line
  }
  return { w: ihdr.w, h: ihdr.h, channels, px }
}

/** 两张图差多少:{ differing, maxDelta } —— 解不出来就返回 undefined。 */
function comparePng(a, b) {
  const x = decodePng(a)
  const y = decodePng(b)
  if (!x || !y || x.w !== y.w || x.h !== y.h || x.channels !== y.channels) return undefined
  let differing = 0
  let maxDelta = 0
  for (let o = 0; o < x.px.length; o += x.channels) {
    let d = 0
    for (let k = 0; k < 3; k += 1) d = Math.max(d, Math.abs(x.px[o + k] - y.px[o + k]))
    if (d > 0) differing += 1
    if (d > maxDelta) maxDelta = d
  }
  return { differing, maxDelta, pixels: x.w * x.h }
}

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
    console.log('\n[1/12] 起一台 core')
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

    console.log('\n[2/12] 拉起应用(独立 --user-data-dir)')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: '',
        /*
         * **屏外档,不是隐藏档**(09-13 补齐;判词在 `electron/main.ts` 的
         * `GATE_OFFSCREEN` 上)。这道门整条都在量「一帧里动了多少」,而隐藏档下
         * Chromium 把整扇窗按 1Hz 节流 —— 那一档量到的是节流器不是产品。
         * 两个开关一起传:`HEADLESS` 管「别自己 show()」,`OFFSCREEN` 管
         * 「摆到屏外再 showInactive()」,于是它在合成、却既不上屏也不抢焦点。
         * (09-13 之前这里两个都没传,窗子会弹到用户脸上 —— 那是漏的,不是设计。)
         */
        ONETHING_GATE_HEADLESS: '1',
        ONETHING_GATE_OFFSCREEN: '1',
      },
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

    console.log('\n[3/12] 静息态:指针挪到条外,量基准 + 存截图')
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

    console.log('\n[4/12] ①a 入场落定后指针纹丝不动:60 帧里有几帧变了')
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

    console.log('\n[5/12] ② 匀速扫过 + ①b 骤停:抖动的两条读数')
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

    console.log('\n[6/12] ⑤ 放大到顶:相邻缝与静止缝逐字节同(零重叠的强化式)')
    const peak = settledAfterSweep
    const peakGaps = peak.tiles.slice(1).map((r, i) => r[0] - (peak.tiles[i][0] + peak.tiles[i][2]))
    readings.gapDriftPx = Number(maxAbs(peakGaps.map((g, i) => g - restGaps[i])).toFixed(2))
    readings.minGapPx = Number(Math.min(...peakGaps).toFixed(2))
    console.log(`  最小缝 ${readings.minGapPx}px;与静止缝最大差 ${readings.gapDriftPx}px`)
    check(
      readings.gapDriftPx <= MAX_GAP_DRIFT_PX,
      `⑤ 相邻缝恒等于静止缝(最大差 ${readings.gapDriftPx}px ≤ ${MAX_GAP_DRIFT_PX})`,
    )

    console.log('\n[7/12] ③ 入场:逐帧看它是鼓起来的还是跳过去的')
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

    console.log('\n[8/12] ④ 收回 + ⑥ 确定性')
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

    console.log('\n[9/12] ⑦ reduced-motion 档:瞬到')
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
    // 收场那张也落盘(只在给了 DOCK_GATE_OUT 时):⑧ 红的时候要看的是**两张图的差**,
    // 只留开场那一张等于把证据丢了一半。
    if (outDir) writeFileSync(path.join(outDir, 'dock-closing.png'), closing)
    const shotDiff = comparePng(shot, closing)
    readings.closingShotDiffPx = shotDiff ? shotDiff.differing : -1
    readings.closingShotMaxDelta = shotDiff ? shotDiff.maxDelta : -1
    readings.closingShotPixels = shotDiff ? shotDiff.pixels : -1
    console.log(
      shotDiff
        ? `  收场 vs 开场:${shotDiff.differing}/${shotDiff.pixels} 个像素有差,单通道最大差 ${shotDiff.maxDelta}(容差 ${SHOT_CHANNEL_TOL})`
        : '  收场 vs 开场:解不开这张 PNG,退回逐字节比',
    )
    check(
      shotDiff
        ? shotDiff.maxDelta <= SHOT_CHANNEL_TOL
        : readings.closingShotSha256 === readings.restShotSha256,
      `⑧ 用完回到静息那张脸与开场同(单通道差 ≤ ${SHOT_CHANNEL_TOL};实测${shotDiff ? ` ${shotDiff.maxDelta},${shotDiff.differing}/${shotDiff.pixels} 个像素` : `逐字节 ${readings.restShotSha256} vs ${readings.closingShotSha256}`})`,
    )

    console.log('\n[10/12] ⑨ 设置里关掉磁性放大:匀速扫一遍,屏幕上一个像素都不许动')
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

    console.log('\n[11/12] ⑩ 四条边 × 三档大小:条内侧边到 .main 内容边恒为 12')
    /*
     * ⑨ 把放大关了,而 ⑪ 要用它 —— 顺带把边 / 沿边 / 档 / 幅度归到一个已知起点。
     * 这一发走**存盘 + reload**(与 ⑨ 同一手),后面 12 + 8 次换档才走真控件:
     * 起点要的是「确定」,而判据要的是「活的覆写」。
     */
    await writeStagePrefs(page, {
      dockMagnify: true,
      dockDisplay: 'always',
      dockEdge: 'bottom',
      dockAlign: 'center',
      dockSize: 'md',
      dockMagnifyLevel: 'md',
    })
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await waitFor('Dock 回来了', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-dock="strip"] > div button'))),
    )
    await waitFor('主题贴到 :root 上', () =>
      page.evaluate(() =>
        Boolean(
          getComputedStyle(document.documentElement).getPropertyValue('--ui-surface-panel-bg').trim(),
        ),
      ),
    )
    // 设置 → Dock。换边 / 换档从这里点,**指针一步都不用动**(clickIn 走元素自己的 click)。
    await clickIn(page, SETTINGS_TILE)
    await waitFor('设置页上屏', () =>
      page.evaluate((sel) => Boolean(document.querySelector(sel)), SETTINGS_NAV_DOCK),
    )
    await clickIn(page, SETTINGS_NAV_DOCK)
    await waitFor('Dock 设置页就位', () =>
      page.evaluate((sel) => Boolean(document.querySelector(sel)), SEG.edge),
    )

    /** 把指针停到内容区正中 —— 四条边都够远,量静态几何时它在哪都一样。 */
    const parkInContent = async (layout) => {
      const c = layout.content
      await move(cdp, (c[0] + c[2]) / 2, (c[1] + c[3]) / 2)
    }

    readings.reserveGaps = {}
    readings.reservePad = {}
    const gapOffenders = []
    for (const edge of ALL_EDGES) {
      await setDockPref(page, 'edge', edge)
      await settleLayout(page)
      for (const size of ALL_SIZES) {
        await setDockPref(page, 'size', size)
        let layout = await settleLayout(page)
        await parkInContent(layout)
        layout = await settleLayout(page, 2500, 260)
        const gap = Number(reserveGapOf(edge, layout).toFixed(2))
        const key = `${edge}/${size}`
        readings.reserveGaps[key] = gap
        // padding 那一格按边取:横边看上下、竖边看左右(pad = [上, 右, 下, 左])。
        readings.reservePad[key] = Number(
          layout.pad[{ top: 0, right: 1, bottom: 2, left: 3 }[edge]].toFixed(2),
        )
        if (Math.abs(gap - RESERVE_GAP_PX) > RESERVE_GAP_TOL) gapOffenders.push(`${key}=${gap}`)
      }
    }
    console.log(`  条外留白:${JSON.stringify(readings.reserveGaps)}`)
    console.log(`  .main 那一边的 padding:${JSON.stringify(readings.reservePad)}`)
    check(
      gapOffenders.length === 0,
      `⑩ 四条边 × 三档,条内侧到内容边恒为 ${RESERVE_GAP_PX}±${RESERVE_GAP_TOL}px(越界 ${gapOffenders.length} 格${gapOffenders.length ? ':' + gapOffenders.join(' ') : ''})`,
    )

    console.log('\n[12/12] ⑪ 放大后探出条外的那一截也算在坞上 + 换轴摘掉旧轴位移')
    await setDockPref(page, 'size', 'md')
    await settleLayout(page)
    readings.overhangPx = {}
    readings.rideLensOn = {}
    readings.fullSweepLensOn = {}
    const rideOffenders = []
    for (const edge of ALL_EDGES) {
      await setDockPref(page, 'edge', edge)
      await settleLayout(page)
      for (const level of PROBE_LEVELS) {
        await setDockPref(page, 'level', level)
        let rest = await settleLayout(page)
        await parkInContent(rest)
        rest = await settleLayout(page, 2500, 260)
        const key = `${edge}/${level}`
        const cross0 = isHorizontal(edge)
          ? rest.strip[1] + rest.strip[3] / 2
          : rest.strip[0] + rest.strip[2] / 2
        const idx = [
          0,
          Math.floor((rest.tiles.length - 1) / 2),
          rest.tiles.length - 1,
        ].slice(0, RIDE_SAMPLES)
        let onFrames = 0
        let allFrames = 0
        let overhang = 0
        let midLine = null
        for (const i of idx) {
          // ① 先落在瓦中心线上,把镜头开起来(探出的那一截只有开着镜头才存在)。
          const [cx, cy] = atPoint(edge, mainCenterOf(edge, rest.tiles[i]), cross0)
          await move(cdp, cx, cy)
          await settle(page, 1200, ENTER_SETTLE_MS)
          const peak = await readLayout(page)
          if (peak.lens !== 'on') {
            rideOffenders.push(`${key}#${i} 进条就没开镜头`)
            continue
          }
          const pr = peak.tiles[i]
          const out = Math.abs(tileInnerOf[edge](pr) - stripInnerOf[edge](rest.strip))
          overhang = Math.max(overhang, Number(out.toFixed(2)))
          const line = probeLineOf(edge, tileInnerOf[edge](pr), OVERHANG_PROBE_PX)
          if (midLine === null || i === idx[Math.floor(idx.length / 2)]) midLine = line
          // ② 抬到那条线上,沿这块瓦自己的中段匀速扫过去。
          const c = mainCenterOf(edge, pr)
          const span = TILE_RIDE_SPAN * mainSizeOf(edge, rest.tiles[i])
          const from = c - span
          const steps = Math.max(1, Math.ceil((span * 2) / SWEEP_STEP_PX))
          const [sx, sy] = atPoint(edge, from, line)
          await move(cdp, sx, sy)
          await delay(60)
          const sampling = sampleLens(page, steps + 2)
          for (let k = 1; k <= steps; k += 1) {
            const [mx, my] = atPoint(edge, from + k * SWEEP_STEP_PX, line)
            await move(cdp, mx, my)
            await delay(SWEEP_TICK_MS)
          }
          const frames = await sampling
          onFrames += frames.filter((v) => v === 'on').length
          allFrames += frames.length
        }
        readings.overhangPx[key] = overhang
        readings.rideLensOn[key] = allFrames ? Number(((onFrames / allFrames) * 100).toFixed(1)) : -1
        if (readings.rideLensOn[key] !== 100) rideOffenders.push(`${key}=${readings.rideLensOn[key]}%`)

        /*
         * 只报不判的那一格:同一条线上**横扫整条**。放大后两瓦之间恒有一条 9px 的缝
         * (⑤ 钉着它),缝在条盒之上那一段是真空 —— 指针掉进去就离开了条的整棵子树,
         * `mouseleave` 照常发。所以这个数结构上到不了 100,它量的是「死带治好之后
         * 能亮多少」,与改前的 0% 对照着看(见门头 ⑪ 那段)。
         */
        const first = mainCenterOf(edge, rest.tiles[0])
        const last = mainCenterOf(edge, rest.tiles[rest.tiles.length - 1])
        const [ex, ey] = atPoint(edge, first, cross0)
        await move(cdp, ex, ey)
        await settle(page, 1200, ENTER_SETTLE_MS)
        const [lx, ly] = atPoint(edge, first, midLine)
        await move(cdp, lx, ly)
        await delay(60)
        const fullSteps = Math.max(1, Math.ceil((last - first) / (SWEEP_STEP_PX * 2)))
        const fullSampling = sampleLens(page, fullSteps + 2)
        for (let k = 1; k <= fullSteps; k += 1) {
          const [mx, my] = atPoint(edge, first + k * SWEEP_STEP_PX * 2, midLine)
          await move(cdp, mx, my)
          await delay(SWEEP_TICK_MS)
        }
        const fullFrames = await fullSampling
        readings.fullSweepLensOn[key] = Number(
          ((fullFrames.filter((v) => v === 'on').length / fullFrames.length) * 100).toFixed(1),
        )
        await parkInContent(rest)
      }
    }
    console.log(`  放大后探出条外(px):${JSON.stringify(readings.overhangPx)}`)
    console.log(`  内侧 +${OVERHANG_PROBE_PX}px 线上骑过瓦身,亮灯帧占比:${JSON.stringify(readings.rideLensOn)}`)
    console.log(`  同一条线整条横扫的亮灯占比(只报不判,缝是结构性的):${JSON.stringify(readings.fullSweepLensOn)}`)
    check(
      rideOffenders.length === 0,
      `⑪ 四条边 × md/lg 幅度,内侧 +${OVERHANG_PROBE_PX}px 线上骑过瓦身全程亮灯(不达标 ${rideOffenders.length} 格${rideOffenders.length ? ':' + rideOffenders.join(' ') : ''})`,
    )

    /*
     * ⑪ 后半:换轴。先回底边扫一遍把 `--tile-dx-x` 写满,再**活着**切到右边并让它
     * 重画一次 —— 瓦是按 item id 做 key 的,换边不重挂 DOM,旧轴那一格会原样留在
     * 瓦身上被 CSS 那条合两轴的 translate() 读到(真机:第一块 −3.79,扫完整条可到 −15)。
     */
    await setDockPref(page, 'edge', 'bottom')
    await setDockPref(page, 'level', 'md')
    const beforeSwitch = await settleLayout(page)
    {
      const cross = beforeSwitch.strip[1] + beforeSwitch.strip[3] / 2
      const from = mainCenterOf('bottom', beforeSwitch.tiles[0])
      const to = mainCenterOf('bottom', beforeSwitch.tiles[beforeSwitch.tiles.length - 1])
      for (let x = from; x <= to; x += SWEEP_STEP_PX * 2) {
        await move(cdp, x, cross)
        await delay(SWEEP_TICK_MS)
      }
    }
    const painted = await readLayout(page)
    readings.dxXBeforeSwitch = painted.dxX.filter((v) => v !== '').length
    await setDockPref(page, 'edge', 'right')
    const afterSwitch = await settleLayout(page)
    await move(
      cdp,
      afterSwitch.strip[0] + afterSwitch.strip[2] / 2,
      mainCenterOf('right', afterSwitch.tiles[Math.floor(afterSwitch.tiles.length / 2)]),
    )
    await settle(page, 1200, ENTER_SETTLE_MS)
    const switched = await readLayout(page)
    readings.dxXAfterSwitch = switched.dxX.filter((v) => v !== '').length
    readings.dxXResidue = switched.dxX.filter((v) => v !== '')
    readings.dxYAfterSwitch = switched.dxY.filter((v) => v !== '').length
    console.log(
      `  切边前写了 ${readings.dxXBeforeSwitch} 格 --tile-dx-x;切到右边重画之后残留 ${readings.dxXAfterSwitch} 格${readings.dxXAfterSwitch ? '(' + readings.dxXResidue.join(', ') + ')' : ''},--tile-dx-y ${readings.dxYAfterSwitch} 格`,
    )
    check(
      readings.dxXBeforeSwitch > 0 &&
        readings.dxXAfterSwitch === 0 &&
        readings.dxYAfterSwitch === switched.dxY.length,
      `⑪ 从横边切到竖边之后每块瓦的 --tile-dx-x 都是空的(实测残留 ${readings.dxXAfterSwitch} 格;切前写过 ${readings.dxXBeforeSwitch} 格,切后 y 轴 ${readings.dxYAfterSwitch}/${switched.dxY.length} 格有值)`,
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
    '\n[dock-gate] ok —— 手停画面停 / 匀速零抖 / 入场无跳 / 收回归位 / 缝恒定 / 确定 / reduced 瞬到 / 关掉即静止 / 让位跟档 / 探出那一截也算在坞上',
  )
}

main().catch((error) => {
  console.error('\n[dock-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
