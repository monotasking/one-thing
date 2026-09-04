#!/usr/bin/env node
/**
 * 无障碍的**真机门**(A11y 线 · A3-2)。立法见
 * `docs/design/react-shell-a11y-2026-08.md`。
 *
 * 静态那一半是 lint(`eslint-plugin-jsx-a11y`,零违例、零基线):它查的是**写法**
 * ——有没有给没文字的按钮起名字、有没有把 aria 属性挂在不支持它的角色上。
 * 这条门查的是**结果**:真机真排版下,一棵真的无障碍树长什么样,以及键盘走一遍
 * 到底走不走得通。两件事查不出彼此 —— 一份 lint 全绿的代码,完全可能开出一扇
 * 焦点根本进不去的浮层。
 *
 * 两段:
 *
 *  ① **axe 全页扫描**(@axe-core/playwright,wcag2a / wcag2aa / best-practice)。
 *     四屏各扫一遍:产品外壳、模型服务面(Dock 上点开的一块内容 —— 收着的面 axe
 *     一条都查不到,而它恰恰是表格 / 勾选框 / 分段器 / 禁用钮最密的一块)、
 *     所有应用面(08-31 加:一整列 `role="switch"` 加一整列打开钮,而且是这道门里
 *     唯一一屏 **cover 形态**的面),和 `?gallery` 那张组件规格页(28 个展位一次
 *     全在场,这是唯一能把每一件都摆上台的地方)。基线 **0** —— 有违例就修,不入基线。
 *     这个数是**日志里的一句话,不是断言**:规格页加一件展位不该让这条门变红,
 *     所以它跟着 `src/dev/Gallery.tsx` 的 `<Section>` 数走,由改那张页的人顺手改。
 *
 *  ② **键盘走查**(手写断言,axe 查不到的那一半)。axe 是静态分析一棵树,它看不见
 *     「按 Tab 会走到哪」「Esc 之后焦点回没回来」。五条:
 *       a. Tab 序覆盖 composer 的主控件(输入区与发送键都够得着);
 *       b. 开 Dialog:焦点进圈,Tab 出不去;
 *       c. Esc 关 Dialog:焦点**回到开它的那个元素**;
 *       d. Menu:方向键在项之间循环,整组只占一个 Tab 位;
 *       e. 每个落焦元素身上都有**我们的**柔光环(--accent-ring 的色),
 *          不是浏览器那圈默认 outline。
 *
 * ── 焦点环认哪一种载体 ──────────────────────────────────────────────────
 * outline 与 box-shadow 两种都认,判据只有一条:**环的颜色 = --accent-ring 的计算值**。
 * 全局兜底(styles/global.css 的 `:focus-visible`)画的是 outline;Input 那一族
 * 自己用 box-shadow 画在外壳上。两种载体的取舍与那段层叠账写在 global.css 里,
 * 这条门只问「有没有画、画的是不是我们那个色」——它不该替谁规定用哪个属性。
 * ──────────────────────────────────────────────────────────────────────
 *
 * ── 反证(照 gate:motion 的纪律)────────────────────────────────────────
 * 每一条断言都要能被「把实现拆掉」反证成红,否则它只是在陪跑。三处已经真验过:
 *   · 把 ui/Dialog.tsx 那层 `<FocusScope scope="dialog" activateOnMount onEscape=…>`
 *     换成一个普通 `<div>`                                    → (b)(c) 必红
 *     (焦点留在开它的那个按钮上,Esc 之后也无所谓「还」不还)。
 *     **09-02 R1 起圈禁与归还都不再是这件组件自己的事**:圈禁是 `modal` 行为档的
 *     缺省(判据在 `src/focus/tab-trap.ts`,由 `src/focus/dispatch.ts` 那唯一的
 *     派发器执行),归还是结构性的(路径缩回父,焦点回它上次所在的元素)。
 *     旧那只 `ui/a11y/focus-trap` 已删 —— 这一条从前写的是「注释掉
 *     `useFocusTrap(panel, open)`」,那句话今天在源码里找不到落点了;
 *   · 把 ui/Menu.tsx 里的 `useRoving(ref, …)` 注释掉          → (d) 必红
 *     (方向键不再移动焦点,tabIndex 表也不再是「一个 0、其余 -1」);
 *   · 把 styles/global.css 那条 `:focus-visible` 规则注释掉    → (e) 必红
 *     (落焦元素的 outline 变成浏览器默认的 auto,颜色不是 --accent-ring)。
 * 验证记录写在汇报里。改了这条门的任何一条断言,请重跑一次它的反证。
 * ──────────────────────────────────────────────────────────────────────
 *
 * ── 判例:这道门为什么等「真信号」而不是睡一觉(09-02 抖动根治)──────────
 * 病:这道门约 1/3~1/4 概率红,同一构建重跑就绿,三批各自记过档。形态两种(第三种
 * 见 `gate-a11y-settle.mjs` 里 `PARK` 的注释):
 *   ① axe 报 `color-contrast`,配色是 `#9d9b94 on #3c3b39` 这种设计里根本不存在的一对;
 *   ② 外壳屏「Tab 走 38 站(应 40)」「两个 input 只有光标没有环」。
 *
 * 根因**不是产品回归,是扫早了**。门从前开扫的判据只有两条:`__d0.rpcOk` 与
 * 「Dock 瓦在 DOM 里」,两条都不管颜色;而这台壳的颜色是异步来的
 * (`main.tsx` 里 `startThemeSource()` 是 fire-and-forget,要再走一趟
 * `themes.apply` RPC)。09-02 探针在「门开扫那一刻」实测到的原始读数,三趟两中:
 *   `{"d2":{"applied":false,"count":0},"bridge":false,"accent":"#7c6fa0","bg":""}`
 * —— 主题没落定,**`--bg` 连定义都还没有**(读出来是空串),axe 只好拿底下透出来
 * 的东西算对比度;146ms 后桥落地,accent 从 `#7c6fa0` 跳到 `#4385BE`、
 * `bg` 从空串变 `#282726`,并**当场起 21 条过渡**,过渡中途每一帧前景背景都在混色。
 * axe 自己那一注入 + 跑一遍要几百毫秒,所以红不红取决于对比度那条规则**恰好在
 * 这段混色里的哪一帧读到样式** —— 这正是「1/4 概率、同构建重跑就绿」的形状。
 *
 * 治:`gate-a11y-settle.mjs` 的 `waitForScreenSettled` —— 等 `window.__d2.applied`
 * 与 `data-theme-bridge`(主题自己的探针,不是启发式)、等色值与可聚焦元素计数
 * 连续 3 帧逐字不变、等有终点的动画排空(排空后还会有新的起来,所以是循环)。
 * 六屏各调一次。从前只有第 5、6 两屏等动画,外壳 / 模型服务面 / 规格页是裸扫的。
 *
 * 读数(同一构建、同一台机器,每组连跑 5 次):
 *   · **修前 0 红 / 5**(这一轮没抖出来 —— 病历里的 1/4 是三批各自记的历史读数);
 *   · **修后 0 红 / 5**;
 *   · **反证**(把五处 `settle()` 全拆掉,其余一字不改)**1 红 / 5**:
 *     文件查看器屏 `[serious] color-contrast`,`._noteDetail` 与 `._statusLink`
 *     两处,读数 `4.12(前景 #9d9c95,背景 #3b3a38)`,要求 4.5 —— 与病历里
 *     `#9d9b94 on #3c3b39` 是同一段过渡上相邻的一帧,签名对得上。
 * 也就是说:这道等待不是保险,是这道门此刻唯一没在赌运气的地方。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 跑法:`node scripts/gate-a11y.mjs`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 可重复:每次一个全新的临时 store + 全新的 --user-data-dir,跑完删干净。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import { AxeBuilder } from '@axe-core/playwright'
import { waitForScreenSettled } from './gate-a11y-settle.mjs'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

/** axe 跑哪几套标签。best-practice 也进 —— 它管的正是「按钮有没有名字」那一族。 */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']

/**
 * axe 的逐条豁免。**空表是目标**:有违例就去修,不往这里塞。
 * 加一条必须写清「为什么这不是真问题」,而不是「这条太吵了」。
 */
const AXE_EXEMPT = [
  // 目前一条都没有。
]

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

/** 种子走 core 的 RPC 口(与 gate-data / gate-squeeze 逐字同一条)。 */
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

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    // 探针**允许当场炸**:换页那一刻旧的执行上下文会被销毁,page.evaluate 抛
    // 「Execution context was destroyed」——那正是「还没到」的一种,不是失败。
    last = await Promise.resolve()
      .then(predicate)
      .catch((error) => ({ pending: String(error?.message ?? error) }))
    if (last && !last.pending) return last
    await delay(150)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}

/**
 * 「这一屏可以量了」。判据与那段病历在 `gate-a11y-settle.mjs` 的文件头里,
 * 一句话:等主题真的落定、色值与可聚焦计数连续三帧不变、没有还在播的过渡 ——
 * 而不是睡一段猜出来的时间。**每一屏扫描之前都要调**(从前只有第 5、6 两屏
 * 等动画,外壳 / 模型服务面 / 规格页三屏是裸扫的,那正是抖动的产地)。
 */
async function settle(page, label, opts) {
  const report = await waitForScreenSettled(page, label, opts)
  console.log(
    `      · ${label} 稳了(${report.frames} 帧;accent=${report.accent}`
      + ` bg=${report.bg} 可聚焦 ${report.focusables} 个`
      + `${report.theme ? `;主题 ${report.theme.themeId}/${report.theme.mode} 贴了 ${report.theme.count} 个变量` : ''})`,
  )
}

/** 与 gate-files.mjs 同一条理由:用 element.click() 绕开可操作性判定,派发的仍是真事件。 */
async function clickSelector(page, selector) {
  const clicked = await page.evaluate((css) => {
    const el = document.querySelector(css)
    if (!el) return false
    el.click()
    return true
  }, selector)
  if (!clicked) throw new Error(`点不到:${selector} 不在 DOM 里`)
}

const failures = []

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`)
    return true
  }
  console.log(`  ✗ ${message}`)
  failures.push(message)
  return false
}

/* ── ① axe ─────────────────────────────────────────────────────────────── */

async function scanAxe(page, screen, include) {
  /*
   * `setLegacyMode(true)` 是**必须的**,不是保守选项:默认模式下 AxeBuilder 会
   * `browserContext.newPage()` 开一张空白页去处理跨 frame 的扫描,而 Electron 的
   * CDP 不支持 `Target.createTarget` —— 当场 `Protocol error (Target.createTarget):
   * Not supported`。legacy 模式只在当前页里注入并跑,正是这台需要的
   * (这个壳是单 frame,没有 iframe 要跨)。
   */
  /*
   * `include` = 只扫这一块子树。给「开出来的一块面」用:整页扫会把外壳那一份
   * 又扫一遍(外壳自己那一屏已经扫过了),于是同一条问题在两屏各报一次,而修它的
   * 那一批与开这块面的这一批常常不是同一批 —— 一条门该指得出该谁修。
   * 不给 include 就是整页扫,外壳与规格页两屏走的仍是原来那条路。
   */
  const builder = new AxeBuilder({ page }).setLegacyMode(true).withTags(AXE_TAGS)
  const result = await (include ? builder.include(include) : builder).analyze()
  const violations = result.violations.filter((v) => !AXE_EXEMPT.includes(v.id))
  const skipped = result.violations.length - violations.length
  if (violations.length === 0) {
    console.log(
      `  ✓ ${screen}:axe 零违例(过了 ${result.passes.length} 条规则${skipped ? `,豁免 ${skipped} 条` : ''})`,
    )
    return
  }
  console.log(`  ✗ ${screen}:axe ${violations.length} 条违例`)
  for (const v of violations) {
    console.log(`      [${v.impact}] ${v.id} —— ${v.help}`)
    for (const node of v.nodes.slice(0, 4)) {
      console.log(`        ${node.target.join(' ')}`)
      const summary = (node.failureSummary ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
      if (summary[1]) console.log(`          ${summary[1]}`)
    }
    if (v.nodes.length > 4) console.log(`        …还有 ${v.nodes.length - 4} 处`)
  }
  failures.push(`${screen}:axe ${violations.length} 条违例`)
}

/* ── ② 键盘走查 ────────────────────────────────────────────────────────── */

/**
 * 焦点环的判据:两种载体都认(outline / box-shadow),色必须**等于** --accent-ring。
 *
 * 颜色比的是**数值**不是字符串:token 的计算值是 `rgba(67, 133, 190, .18)`
 * (自定义属性保留作者写法,`.18` 没有前导 0),而 `outlineColor` 是浏览器序列化过的
 * `rgba(67, 133, 190, 0.18)` —— 逐字比会把每一站都判成裸的。首跑就是这么假红的。
 *
 * ── 曾经的一族豁免:文本输入(08-31 视觉守恒批**退役**)───────────────────
 * 光标(caret)本身也算焦点指示,WCAG 2.4.7 认这个形 —— 所以从前这道门把
 * 「`contenteditable` / `<input>` / `<textarea>` 落焦却周身没有环」记进「文本输入」
 * 一栏而不是判红,并把 composer 的三处输入(.input / .askFree / .modelSearchInput)
 * 留在那一栏里等 composer 批拍板。
 *
 * 板拍了,口径统一到 ui/Input 那一副:**文本输入类的环画在看得见的外框上**
 * (`.panel:has(.input:focus)` / `.askBar:has(.askFree:focus)` /
 * `.modelSearch:has(.modelSearchInput:focus)`),输入本体的 `outline: none` 从此
 * 各自配着替代品。于是 `caret` 那一栏应当**空着** —— 下面把它从「记一笔」升成
 * 一条断言。反证:把 Composer.module.css 里 `.panel:has(.input:focus)` 注释掉,
 * composer 的输入区当场落回这一栏,门必红。
 *
 * 判据仍然是元素的种类而不是它的类名 —— 不写选择器白名单,那种表会变成往里塞
 * 东西的地方;caret 这一栏也照旧算出来,只是从「统计口径」变成了「必须为零」。
 *
 * ── 往上找几层 ────────────────────────────────────────────────────────
 * 从 4 层放宽到 6:composer 那块看得见的外框(`.panel`)离输入本体隔着
 * writeRow → mode → bodyRow 三层,加上 `.panel` 自己正好第 4 跳 —— 旧的
 * `hop < 4` 在第 4 跳之前就停了,环明明画着却查不到。上限是「找得到最远的那个
 * 真外框」,不是一个审美数字。
 * ──────────────────────────────────────────────────────────────────────
 */
function ringProbeSource() {
  return () => {
    const el = document.activeElement
    if (!el || el === document.body) return { none: true }
    const style = getComputedStyle(el)
    const ring = getComputedStyle(document.documentElement).getPropertyValue('--accent-ring').trim()
    /** `rgba(67, 133, 190, .18)` → `67,133,190,0.18`。比数不比字面。 */
    const chan = (v) => {
      const nums = String(v).match(/-?\d*\.?\d+/g)
      if (!nums) return null
      const parts = nums.slice(0, 4).map((n) => Number(n))
      while (parts.length < 4) parts.push(1)
      return parts.join(',')
    }
    const want = chan(ring)
    const outline = `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`
    // 环也可能画在祖先上(Input 那一族:input 自己 outline:none,环在 .field 外壳上)。
    let carrier = null
    let node = el
    for (let hop = 0; node && hop < 6; hop += 1) {
      const st = getComputedStyle(node)
      if (st.outlineStyle !== 'none' && chan(st.outlineColor) === want) {
        carrier = 'outline'
        break
      }
      const shadowColors = (st.boxShadow ?? '').match(/rgba?\([^)]*\)/g) ?? []
      if (shadowColors.some((c) => chan(c) === want)) {
        carrier = 'box-shadow'
        break
      }
      node = node.parentElement
    }
    const tag = el.tagName.toLowerCase()
    return {
      tag,
      testid: el.getAttribute('data-testid'),
      role: el.getAttribute('role'),
      name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 28),
      carrier,
      textEntry: tag === 'input' || tag === 'textarea' || el.isContentEditable,
      outline,
      ring,
    }
  }
}

/** 按 Tab n 下,记下每一站的落点与它的环。 */
async function walkTabOrder(page, steps) {
  const stops = []
  for (let i = 0; i < steps; i += 1) {
    await page.keyboard.press('Tab')
    stops.push(await page.evaluate(ringProbeSource()))
  }
  return stops
}

async function checkComposerTabOrder(page) {
  // 从文档开头出发:先把焦点摆到 body,Tab 才从第一站开始走。
  await page.evaluate(() => {
    const el = document.activeElement
    if (el instanceof HTMLElement) el.blur()
  })
  const stops = await walkTabOrder(page, 40)
  const reached = new Set(stops.map((s) => s.testid).filter(Boolean))
  const named = stops.filter((s) => !s.none)
  assert(
    named.length > 0,
    `Tab 走 40 步,落焦 ${named.length} 站(站点样本:${named.slice(0, 6).map((s) => s.testid ?? s.role ?? s.tag).join(' → ')})`,
  )
  assert(reached.has('composer-send'), 'Tab 序覆盖 composer 的发送键([data-testid="composer-send"])')
  const editable = stops.some((s) => s.tag === 'textarea' || s.role === 'textbox' || s.name === '')
  assert(editable, 'Tab 序里有可输入的落点(composer 的输入区)')

  // 每一站都要有我们的环。这一条是「黄圈」那条报障的机器化。
  const ringed = named.filter((s) => s.carrier)
  const caret = named.filter((s) => !s.carrier && s.textEntry)
  const bare = named.filter((s) => !s.carrier && !s.textEntry)
  assert(
    bare.length === 0,
    '每个落焦元素身上都是 --accent-ring 的柔光环,没有浏览器默认 outline'
      + (bare.length
        ? `;裸着的:${bare.slice(0, 8).map((s) => `${s.tag}${s.testid ? `[${s.testid}]` : ''} outline=${s.outline} vs ring=「${s.ring}」`).join(' · ')}`
        : ''),
  )
  // 文本输入也得画环(08-31 起)。从前这一栏是「靠光标指示焦点」的统计口径,
  // 现在口径统一到 ui/Input:环画在看得见的外框上,所以这一栏必须空着。
  assert(
    caret.length === 0,
    '文本输入也画着外框环(不再靠光标豁免)'
      + (caret.length
        ? `;只有光标的:${caret.map((s) => `${s.tag}${s.role ? `[${s.role}]` : ''}${s.testid ? `[${s.testid}]` : ''}`).join(' · ')}`
        : ''),
  )
  const carriers = new Set(ringed.map((s) => s.carrier))
  console.log(
    `      ${ringed.length} 站画着环(载体:${[...carriers].join(' / ') || '—'})`,
  )
}

/**
 * 会话总览的 **Tab 序**(09-04 方向 A,设计 §3.1)。
 *
 * 一块装着几百条会话的面,它的 Tab 位只许有**四个**:侧栏(一个,内部走 roving)、
 * 搜索条、新会话、树容器(一个,活动行走 `aria-activedescendant`)。
 * 行**一个都不进 Tab 序** —— 469 条会话不该是 469 次 Tab,这正是选 tree +
 * activedescendant 而不是「每行一个 button」的全部理由,所以它得被钉住。
 *
 * 走法从**搜索条**出发(这块面摆出来时焦点就在它身上,`restingTarget` 第一档):
 * 先反着走两下证「侧栏是一个 Tab 位」(第一下进侧栏、第二下就出了这块面),
 * 再正着走**五**下:前四站按次序读出来,第五站证「树是最后一个 Tab 位」——
 * 行如果长了 tabIndex,它们排在树容器之后,只走四下看不见(反证跑出来的)。
 */
async function checkExposeTabOrder(page) {
  const probe = () =>
    page.evaluate(() => {
      const el = document.activeElement
      const inExpose = Boolean(el?.closest?.('[data-focus-scope="expose"]'))
      const testid = el?.getAttribute?.('data-testid') ?? null
      return {
        testid,
        role: el?.getAttribute?.('role') ?? null,
        inExpose,
        inRail: Boolean(el?.closest?.('[data-testid="expose-rail"]')),
        railSelected: el?.getAttribute?.('aria-selected') === 'true',
        isSearch: Boolean(el?.hasAttribute?.('data-expose-search')),
        isRow: Boolean(el?.hasAttribute?.('data-session-id')),
      }
    })

  const start = await probe()
  assert(start.isSearch, `总览摆出来时焦点落在搜索条上(此刻在 [${start.testid ?? start.role ?? '—'}])`)

  await page.keyboard.press('Shift+Tab')
  const back1 = await probe()
  assert(back1.inRail && back1.railSelected, `搜索条往回一下 = 侧栏当前那一项(此刻在 [${back1.testid ?? '—'}])`)
  await page.keyboard.press('Shift+Tab')
  const back2 = await probe()
  assert(!back2.inRail, `侧栏只占**一个** Tab 位:再往回一下就出了侧栏(到了 [${back2.testid ?? back2.role ?? '—'}])`)

  /*
   * 走**五**下不是四下:第五下是这一条断言的全部价值 —— 行如果长了 tabIndex,
   * 它们排在树容器**之后**(它们是树的孩子),四下正好停在树上就看不见。
   * 反证跑出来的:给 SessionRow 加一句 tabIndex={0},四下版全绿。
   */
  const forward = []
  for (let i = 0; i < 5; i += 1) {
    await page.keyboard.press('Tab')
    forward.push(await probe())
  }
  const trail = forward.map((f) => f.testid ?? f.role ?? '(无名)')
  assert(
    forward[0].inRail && forward[1].isSearch
      && forward[2].testid === 'expose-new-session'
      && forward[3].testid === 'expose-tree',
    `Tab 序 = 侧栏 → 搜索 → 新会话 → 树(实走:${trail.join(' → ')})`,
  )
  assert(
    forward.every((f) => !f.isRow),
    `Tab 序里一条会话行都没有(实走:${trail.join(' → ')})`,
  )
  assert(
    !forward[4].inExpose,
    `树是这块面**最后**一个 Tab 位:再按一下就出了这块面(到了 [${trail[4]}])`,
  )
}

async function checkDialog(page) {
  // Gallery 上那颗「open dialog」。用 el.click() 而不是真鼠标:这条门要证的是
  // 焦点与语义,不是命中测试(同 gate:squeeze / gate:data 的口径)。
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(
      (el) => (el.textContent ?? '').trim() === 'open dialog',
    )
    if (!btn) return false
    btn.focus()
    window.__a11yAnchor = btn
    btn.click()
    return true
  })
  if (!assert(opened, 'Gallery 上找得到「open dialog」触发器')) return
  await waitFor('对话框在场', () =>
    page.evaluate(() => Boolean(document.querySelector('[role="dialog"][aria-modal="true"]'))),
  )

  const inside = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
    return {
      focusInside: Boolean(dialog && dialog.contains(document.activeElement)),
      labelled: Boolean(dialog?.getAttribute('aria-labelledby') || dialog?.getAttribute('aria-label')),
      labelText:
        document.getElementById(dialog?.getAttribute('aria-labelledby') ?? '')?.textContent?.trim()
        ?? dialog?.getAttribute('aria-label')
        ?? '',
    }
  })
  assert(inside.focusInside, '开对话框:焦点落进面板里')
  assert(inside.labelled, `对话框有无障碍名(读到「${inside.labelText}」)`)

  // Tab 圈禁:连按 12 下,焦点一次都不许离开面板。
  for (let i = 0; i < 12; i += 1) await page.keyboard.press('Tab')
  const stillInside = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
    return Boolean(dialog && dialog.contains(document.activeElement))
  })
  assert(stillInside, 'Tab 连按 12 下,焦点仍在面板内(圈禁成立)')

  await page.keyboard.press('Escape')
  await delay(200)
  const returned = await page.evaluate(() => ({
    closed: !document.querySelector('[role="dialog"][aria-modal="true"]'),
    back: document.activeElement === window.__a11yAnchor,
    now: document.activeElement?.textContent?.trim().slice(0, 24) ?? '(body)',
  }))
  assert(returned.closed, 'Esc 关掉对话框')
  assert(returned.back, `Esc 之后焦点还给了开它的那个元素(现在停在「${returned.now}」)`)
}

async function checkMenu(page) {
  const opened = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((el) =>
      (el.textContent ?? '').toLowerCase().includes('menu'),
    )
    if (!btn) return false
    btn.focus()
    window.__a11yMenuAnchor = btn
    btn.click()
    return true
  })
  if (!assert(opened, 'Gallery 上找得到打开菜单的触发器')) return
  await waitFor('菜单在场', () =>
    page.evaluate(() => Boolean(document.querySelector('[role="menu"]'))),
  )

  const shape = await page.evaluate(() => {
    const menu = document.querySelector('[role="menu"]')
    const items = [...menu.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')].filter(
      (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true',
    )
    return {
      focusInMenu: menu.contains(document.activeElement),
      count: items.length,
      tabIndexes: items.map((el) => el.tabIndex),
    }
  })
  assert(shape.focusInMenu, '开菜单:焦点进了菜单')
  assert(
    shape.count > 1 && shape.tabIndexes.filter((t) => t === 0).length === 1,
    `整组只占一个 Tab 位(${shape.count} 项,tabIndex 表 ${JSON.stringify(shape.tabIndexes)})`,
  )

  /*
   * 方向键循环:按 count + 1 下 ↓,应当绕回第一项。
   *
   * **组 = 做得动的那些项**(09-02 批 12 补口)。`a11y/roving` 的入组判据
   * (`itemsOf`)本来就把 `disabled` / `aria-disabled` 排掉 —— 方向键该在
   * 做得动的项之间走。规格页的菜单从这一批起有一项是禁灰的样品,
   * 上面三处取项因此都跟着筛一道:不筛的话这条门量的是「表里有几行」,
   * 而它要问的是「方向键会停在几处」,两者从此不是同一个数。
   */
  const first = await page.evaluate(() => {
    const menu = document.querySelector('[role="menu"]')
    const items = [...menu.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')].filter(
      (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true',
    )
    return items[0].textContent?.trim() ?? ''
  })
  for (let i = 0; i < shape.count + 1; i += 1) await page.keyboard.press('ArrowDown')
  const looped = await page.evaluate(() => {
    const menu = document.querySelector('[role="menu"]')
    const items = [...menu.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')].filter(
      (el) => !el.disabled && el.getAttribute('aria-disabled') !== 'true',
    )
    return {
      at: document.activeElement?.textContent?.trim() ?? '',
      isFirst: document.activeElement === items[0],
      ones: items.map((el) => el.tabIndex).filter((t) => t === 0).length,
    }
  })
  assert(looped.isFirst, `↓ 按 ${shape.count + 1} 下绕回首项「${first}」(现在停在「${looped.at}」)`)
  assert(looped.ones === 1, '走完之后仍然只有一项在 Tab 序里')

  await page.keyboard.press('Escape')
  await delay(200)
  const back = await page.evaluate(() => ({
    closed: !document.querySelector('[role="menu"]'),
    back: document.activeElement === window.__a11yMenuAnchor,
  }))
  assert(back.closed, 'Esc 关掉菜单')
  assert(back.back, 'Esc 之后焦点还给了开它的那个元素')
}

/* ── 主流程 ───────────────────────────────────────────────────────────── */

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[a11y-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[a11y-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'a11y-gate-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'a11y-gate-userdata-'))
  /*
   * 会话总览那一屏要有**真行**才扫得到东西(空树上没有 treeitem、没有分节头、
   * 侧栏也长不出项目那一档)。所以这道门从 09-04 起种两条会话,其中一条落在
   * 一个真实存在的临时目录下 —— `sessions.updateWorkingDirectory` 在本机可信面
   * 上把路径逐字当真,不存在的目录会被当场拒掉(gate-squeeze 那条判例)。
   */
  const projectsRoot = await mkdtemp(path.join(tmpdir(), 'a11y-gate-projects-'))
  const projectDir = path.join(projectsRoot, 'a11y-fixture-project')
  await mkdir(projectDir, { recursive: true })
  let server
  let app
  try {
    console.log('\n[1/9] 起一台 core')
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
    // 种两条会话:一条带项目(侧栏因此长出项目那一档),一条无项目(「无项目」那一档)。
    const seeded = []
    for (const [name, dir] of [['会话总览 · 带项目', projectDir], ['会话总览 · 无项目', null]]) {
      const created = await rpc(rec, 'sessions', 'create', { name })
      const id = created?.session?.id
      if (!id) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(created)}`)
      if (dir) {
        const wrote = await rpc(rec, 'sessions', 'updateWorkingDirectory', {
          sessionId: id,
          workingDirectory: dir,
        })
        if (wrote?.success !== true) throw new Error(`工作目录没写进去:${JSON.stringify(wrote)}`)
      }
      seeded.push(id)
    }
    console.log(`  ✓ core 起来了,种了 ${seeded.length} 条会话`)

    console.log('\n[2/9] 拉起应用(独立 --user-data-dir)')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: '',
        /*
         * **窗子离屏起**(09-04 S4,纪律「真机门不许抢用户的机器」)。不 show()、
         * 不进 Dock;页面照样渲染、照样跑布局与 rAF。焦点由下面那一句 CDP
         * `Emulation.setFocusEmulationEnabled` 补 —— 判词与一致性证据写在
         * `electron/main.ts` 的 `ONETHING_GATE_HEADLESS` 那一段上。
         */
        ONETHING_GATE_HEADLESS: '1',
      },
    })
    const page = await app.firstWindow()
    // 离屏窗要自己补「我有焦点」,否则 `:focus-visible` / Tab 序走查量的是一台失焦的页。
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await waitFor('Dock 就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid^="dock-tile"]'))),
    )
    console.log('  ✓ 外壳画出来了')

    console.log('\n[3/9] 产品外壳:axe 全页扫描 + Tab 序走查')
    // 这一屏从前是裸扫的 —— 而颜色恰恰是最后才到的那样东西(见 settle 的文件头)。
    await settle(page, '外壳')
    await scanAxe(page, '外壳')
    await checkComposerTabOrder(page)

    /*
     * 模型服务面(批一)。它进这道门的理由与规格页一样:**外壳那一屏看不见它** ——
     * 面板收在 Dock 里,axe 扫的是已经排好的那棵树,没画出来的东西它一条都查不到。
     * 一块带表格、勾选框、分段器与两处禁用钮的面,恰恰是最容易漏名字的那种。
     *
     * **覆盖到哪儿为止**:这道门跑在一个全新的临时 store 上,那台机器一把密钥都没有,
     * 所以扫到的是左栏名册 / 家头(启用开关)/ 模式分段器 / 密钥卡 / 目录的空态;
     * 模型行那几个勾选框**不在场**(目录是空的)。它们的名字由单测守
     * (`providers/components/__tests__`,按 `勾选 {model}` 取的)。
     * 反证:把家头那枚 Switch 的 `label` 拆掉 → 这一屏当场 critical button-name 红
     * (2026-08-31 真跑过一轮)。
     */
    console.log('\n[4/9] 模型服务面:开一块面再扫一次')
    await clickSelector(page, '[data-testid="dock-tile-providers"]')
    await waitFor('模型服务面就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid^="provider-row-"]'))),
    )
    await settle(page, '模型服务面')
    await scanAxe(page, '模型服务面', '[data-testid="providers-panel"]')

    /*
     * 「所有应用」面(08-31 Dock/形态批)。进这道门的理由与模型服务面逐字相同 ——
     * **外壳那一屏看不见它**,而它是一整列 `role="switch"` 加一整列打开钮:
     * 每一枚开关都得说得出「什么的开关」(Switch 的 `label`),每一颗打开钮都得
     * 说得出「打开什么」;漏一个,读屏软件就只能念「开关,开」。
     *
     * 它同时是这道门里唯一一屏 **cover 形态**的面:盖挂在壳的根上、fixed 铺满
     * 整扇窗(09-01 用户推翻「只接管内容栏」之后如此),所以「盖开着的时候这一屏
     * 的无障碍树长什么样」只有在这里才扫得到。盖满整扇窗之后这一屏更值钱了 ——
     * 顶带 / 顶栏 / 四条边上的架子此刻全在盖底下,axe 扫的是整棵活树。
     * 反证:把 AppsPanel 里 Switch 的 `label` 拆掉 → 这一屏当场 critical
     * button-name 红(每一行都是,因为那颗 <button role="switch"> 只有一个空 span)。
     */
    console.log('\n[5/9] 所有应用面(cover 形态):开一块面再扫一次')
    await clickSelector(page, '[data-testid="dock-tile-apps"]')
    await waitFor('所有应用面就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid^="apps-row-"]'))),
    )
    await settle(page, '所有应用面')
    await scanAxe(page, '所有应用面', '[data-testid="apps-panel"]')
    // 扫完把它关掉(Esc 走的正是本批新立的退层链),免得盖着的那一层挡住下一屏。
    await page.keyboard.press('Escape')
    await waitFor('所有应用面已收回', () =>
      page.evaluate(() => !document.querySelector('[data-testid="apps-panel"]')),
    )

    /*
     * 文件查看器(09-01 F2 补扫描屏;F1 留账的那处「一行插入」)。
     *
     * 它进这道门的理由与前两屏逐字相同:**外壳那一屏看不见它**。而它恰恰是这批
     * 新件最密的一块 —— 檐上那颗 IconButton(第 18 件:aria-label + Tooltip)、
     * 脚上那一排状态链接、以及「一个文件都没打开」那一格空态。
     *
     * 这道门跑在一个全新的临时 store 上,没有会话也就没有工作目录,所以这里扫的是
     * **空态那一屏**(有檐、有脚、有那句实话)。「打开一份真文件之后长什么样」
     * 由 gate:files 那道门验(它自己建了一棵真目录树)—— 两道门各扫各的那一半,
     * 不在这里再造一次目录树。
     */
    console.log('\n[6/9] 文件查看器(空态):开一块面再扫一次')
    await clickSelector(page, '[data-testid="dock-tile-viewer"]')
    await waitFor('查看器就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="file-viewer"]'))),
    )
    await settle(page, '文件查看器')
    await scanAxe(page, '文件查看器', '[data-testid="file-viewer"]')
    /*
     * 收回它。**关闭钮在宿主檐上,不在查看器里**(09-01 合檐:浮窗 / 舞台 / 盖
     * 三种宿主自带 header,查看器那条整条不画,身份与关闭都归宿主)——
     * 所以这里点的是浮窗那颗关闭,不是 `viewer-close`。
     * 顺手把合檐这件事在这道门里也钉一条:这一屏上**只有一条檐**。
     */
    const chromes = await page.evaluate(() => {
      const viewer = document.querySelector('[data-testid="file-viewer"]')
      const host = viewer?.closest('[role="dialog"]')
      return {
        own: Boolean(viewer?.querySelector('[data-viewer-chrome]')),
        host: Boolean(host?.querySelector('header')),
      }
    })
    assert(chromes.host && !chromes.own, '合檐:宿主檐在场,查看器自己那条不画(修前两条叠着)')
    await page.evaluate(() => {
      const host = document.querySelector('[data-testid="file-viewer"]')?.closest('[role="dialog"]')
      const buttons = Array.from(host?.querySelectorAll('header button') ?? [])
      const close = buttons[buttons.length - 1]
      if (!close) throw new Error('宿主檐上没有关闭钮')
      close.click()
    })
    await waitFor('查看器收回', () =>
      page.evaluate(() => !document.querySelector('[data-testid="file-viewer"]')),
    )

    /*
     * 会话总览(09-04 方向 A 重建之后补的一屏)。
     *
     * 它进这道门的理由与前三屏逐字相同 —— **外壳那一屏看不见它**;而它是全壳
     * 语义最密的一块:一只 `role="listbox"` 的侧栏、一只 `role="tree"` 的列表
     * (`role="group"` 的分节 + `role="treeitem"` 的行 + `aria-activedescendant`)、
     * 一只 `ui/Select`、一条搜索框,加上行里三颗 `tabIndex=-1` 的图标钮。
     * 「树的项故意不可聚焦」这一形尤其值得被 axe 与 Tab 走查各查一遍:
     * 前者管语义对不对,后者管 Tab 位有没有炸成几百个(axe 看不见这件事)。
     *
     * 扫的范围钉在这块面自己的作用域根上(`[data-focus-scope="expose"]`),
     * 与前三屏同一条理由:外壳那一份别再报第二遍。
     */
    console.log('\n[7/9] 会话总览(树形列表):开一块面再扫一次 + Tab 序走查')
    await clickSelector(page, '[data-testid="dock-tile-sessions"]')
    await waitFor('总览画出会话行', () =>
      page.evaluate(() => document.querySelectorAll('[data-session-id]').length > 0),
    )
    await settle(page, '会话总览')
    await scanAxe(page, '会话总览', '[data-focus-scope="expose"]')
    await checkExposeTabOrder(page)
    /*
     * 09-04:分节可折叠(用户报「分组没法收」)。**收起来的那一态要单独扫一遍**
     * —— 它换掉的正是 axe 最在意的那几格:节头的 `aria-expanded` 翻面,而它下面
     * 那只 `role="group"` 整个从 DOM 里走了。少扫这一态,「收起后 tree 里只剩
     * 光秃秃的 treeitem」这类结构错就没人看得见。
     */
    const headId = await page.evaluate(() => {
      const head = document.querySelector('[data-focus-scope="expose"] [data-section-id]')
      return head ? head.getAttribute('data-section-id') : null
    })
    assert(headId !== null, '会话总览上有分节头(它是树的一项,可折叠)')
    const before = await page.evaluate((id) => {
      const head = document.querySelector(`[data-section-id="${id}"]`)
      return { role: head?.getAttribute('role') ?? null, level: head?.getAttribute('aria-level') ?? null }
    }, headId)
    assert(
      before.role === 'treeitem' && before.level === '1',
      `分节头是 aria-level=1 的 treeitem(实为 role=${before.role ?? '—'} level=${before.level ?? '—'})`,
    )
    await clickSelector(page, `[data-section-id="${headId}"]`)
    // 收展是一次 React 提交 —— 同一个 evaluate 里点完就读会读到上一帧(实测)。
    await settle(page, '会话总览(收起一节)')
    const folded = await page.evaluate((id) => {
      const head = document.querySelector(`[data-section-id="${id}"]`)
      return {
        expanded: head?.getAttribute('aria-expanded') ?? null,
        // 收起来的那一节不再有自己的 group(不留空壳)。
        group: Boolean(document.querySelector(`[aria-labelledby="expose-section-${id}"]`)),
      }
    }, headId)
    assert(folded.expanded === 'false', `点一下节头它收起来了(aria-expanded=${folded.expanded ?? '—'})`)
    assert(folded.group === false, '收起来的节不留一只空的 role="group"')
    await scanAxe(page, '会话总览(收起一节)', '[data-focus-scope="expose"]')
    // 展回去,别把这一态留给下一屏。
    await clickSelector(page, '[data-focus-scope="expose"] [data-section-id]')
    // 收回它(Esc 走退层链,最上面那扇浮窗),免得它挡住下一屏。
    await page.keyboard.press('Escape')
    await waitFor('总览已收回', () =>
      page.evaluate(() => !document.querySelector('[data-focus-scope="expose"]')),
    )

    // 28 = `src/dev/Gallery.tsx` 今天的 <Section> 展位数(25 件组件 +
    // useScrolledPast / useSettlePulse / useInlineEdit 三件 hook)。日志读数,不是断言。
    console.log('\n[8/9] 组件规格页(?gallery):28 个展位一次全在场')
    /*
     * 生产窗口是 loadFile 读本地文件,没有 router —— 换页靠改 location.search
     * 再等一次重载(App.tsx 读的就是这个查询参数)。
     */
    await page.evaluate(() => {
      window.location.search = '?gallery'
    })
    await waitFor('规格页就位', () =>
      page.evaluate(() =>
        Boolean([...document.querySelectorAll('button')].some((el) => (el.textContent ?? '').trim() === 'open dialog')),
      ),
    )
    /*
     * 这一屏是**整页重载**(改 location.search),所以 `startThemeSource()` 从头
     * 再跑一遍 —— 主题又是异步到的。六屏里它是最需要这道等待的一屏。
     */
    await settle(page, '规格页')
    await scanAxe(page, '规格页')

    console.log('\n[9/9] 键盘走查:Dialog 圈禁与返还、Menu 方向键循环')
    await checkDialog(page)
    await checkMenu(page)

    await app.close()
    app = undefined
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
    await rm(projectsRoot, { recursive: true, force: true })
  }

  if (failures.length) {
    console.error(`\n[a11y-gate] FAILED(${failures.length} 条):\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\n[a11y-gate] ok —— 六屏 axe 零违例;键盘走查全绿')
}

main().catch((error) => {
  console.error('\n[a11y-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
