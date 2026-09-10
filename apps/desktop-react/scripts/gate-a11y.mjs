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
 *     八屏各扫一遍:产品外壳、模型抽屉、模型服务面(Dock 上点开的一块内容 —— 收着的面 axe
 *     一条都查不到,而它恰恰是表格 / 勾选框 / 分段器 / 禁用钮最密的一块)、
 *     所有应用面(08-31 加:一整列 `role="switch"` 加一整列打开钮,而且是这道门里
 *     唯一一屏 **真全屏**的面),音乐面(09-10 加:这块壳里第一处 `role="slider"` ——
 *     两条拖杆各要说得出名字、当前值与两头),**拖拽落点菜单**(W3 裁定 9 + W3-b 裁定 8 的
 *     左移 / 右移:拖拽的键盘等价 ——
 *     每个落点都能从既有 tab 菜单到达,落定后 `announce()` 播报),
 *     和 `?gallery` 那张组件规格页(28 个展位一次
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
 * 八屏各调一次。从前只有第 5、6 两屏等动画,外壳 / 模型服务面 / 规格页是裸扫的。
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
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

/**
 * **开标签动作表**(W7-c 裁定 2/3:「分屏」那颗钮删了,这张表只有右键与
 * `Shift+F10` 两个开口)。这只函数走右键那一条 —— 键盘那一条在 [7e] 里单测。
 *
 * 返回 false = 顶栏上没有标签(跳过那一屏,不是红)。
 *
 * `detachableOnly`(U3-b,2026-09-08):开在**挪得走的**那一格上。中央区最后一格
 * 常驻内容(会话)身上,「撕成浮窗 / 移到架子 ▸ / 关闭」三项按 `canDetachTab`
 * 禁灰 —— 一格禁灰的 `Submenu` 是开不出子表的,而下面那一步要的正是「真把一格
 * 搬到架子上」。「挪得走」这一格读的是**它画不画得出 ✕**(`data-tab-close`),
 * 与 [8f] 挑靶子那一句逐字同一条:两处都不新写判据。
 */
async function openTabMenuByContext(page, { detachableOnly = false } = {}) {
  const ok = await page.evaluate((only) => {
    const tabs = Array.from(document.querySelectorAll('[data-topbar-leaf] [data-tab-id]'))
    const tab = only ? tabs.find((el) => el.querySelector('[data-tab-close]')) : tabs[0]
    if (!(tab instanceof HTMLElement)) return false
    const box = tab.getBoundingClientRect()
    tab.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(box.left + box.width / 2),
        clientY: Math.round(box.top + box.height / 2),
      }),
    )
    return true
  }, detachableOnly)
  if (ok) await delay(400)
  return ok
}

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
  /*
   * 一份**真文件**:W1 起「文件查看器」那一屏的入口是**文件树**(撤掉 Viewer 瓦
   * 之后回访一个文件的路只剩它,T0 拍点甲),所以树上得有一行点得开的东西。
   * 顺带它让叶檐那一屏有内容可扫:一格聊天 tab + 一格文件 tab,那正是要看的形。
   */
  /*
   * 故意是 **markdown 而不是源码**:源码那一支走的是语法高亮,而高亮那套配色的
   * 对比度是**产品既有的一笔账**(与 W1 无关 —— 从前这一屏扫的是「一个文件都没
   * 打开」的空态,所以它一直没被这道门照到)。这道门这一屏要照的是**查看器这只壳**
   * (零檐、状态栏、叶檐),所以夹具给它一份走正文那条路的内容。
   * **留账**:高亮配色在深色主题下的对比度要单独一批,不在 W1 里顺手改。
   */
  await writeFile(path.join(projectDir, 'alpha.md'), '# alpha\n\n一段正文,给这道门照壳用。\n')
  let server
  let app
  try {
    console.log('\n[1/13] 起一台 core')
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

    console.log('\n[2/13] 拉起应用(独立 --user-data-dir)')
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

    console.log('\n[3/13] 产品外壳:axe 全页扫描 + Tab 序走查')
    // 这一屏从前是裸扫的 —— 而颜色恰恰是最后才到的那样东西(见 settle 的文件头)。
    await settle(page, '外壳')
    await scanAxe(page, '外壳')
    await checkComposerTabOrder(page)

    /*
     * 模型抽屉(09-05 庚 补的一屏)。它进这道门的理由与后面几屏逐字相同 ——
     * **外壳那一屏看不见它**:抽屉是收着的,axe 扫的是已经排好的那棵树。
     *
     * 而它恰恰是这批新件最密的一块:一行搜索、一列 `ButtonBase` 的候选行、
     * 右栏一张卡,和一组 `role="radiogroup"` 的思考阶梯 —— 一组 radio 得说得出
     * 「什么的一组」(RadioGroup 的 `label`),每一颗得说得出自己是哪一档。
     *
     * **覆盖到哪儿为止**:这道门跑在一个全新的临时 store 上,那台机器一家
     * provider 都没配,所以扫到的是搜索行 + 「无匹配」那一格空态 + 右栏不在场
     * (三层事实都答不上来 → 整块不画,不画一张空卡)。阶梯本身的语义由单测守
     * (`composer/components/Composer.test.tsx` 的「庚」那一族,按 role=radio 取的)。
     * 反证:把 `RadioGroup` 的 `label` 拆掉 → 那一族单测当场红。
     */
    console.log('\n[4/13] 模型抽屉:开一格再扫一次')
    await clickSelector(page, '[data-testid="composer-panel"] button[aria-expanded]')
    await waitFor('模型抽屉就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-focus-scope="drawer"]'))),
    )
    await settle(page, '模型抽屉')
    await scanAxe(page, '模型抽屉', '[data-focus-scope="drawer"]')
    // 收回它(Esc 走的正是输入面板那三层次序的第②层),别把它留给下一屏。
    await page.keyboard.press('Escape')
    await waitFor('模型抽屉已收回', () =>
      page.evaluate(() => !document.querySelector('[data-focus-scope="drawer"]')),
    )

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
    console.log('\n[5/13] 模型服务面:开一块面再扫一次')
    await clickSelector(page, '[data-testid="dock-tile-providers"]')
    await waitFor('模型服务面就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid^="provider-row-"]'))),
    )
    await settle(page, '模型服务面')
    await scanAxe(page, '模型服务面', '[data-testid="providers-panel"]')

    /*
     * **检索面**(09-06 补账,检索面终稿 R10)。进这道门的理由与模型服务面逐字
     * 相同 —— **外壳那一屏看不见它**(面板收在 Dock 里)。而它恰恰是这块壳里
     * 语义最密的一处:一格 `role="listbox"`,里面只许装 `option` / `separator`
     * (页脚那几条读数因此在 ⑦ 搬到了 listbox 的**兄弟**位)、行是 `tabIndex=-1`
     * 的候选(焦点恒在输入框)、块尾那条「加载更多」加载中**不 disabled**
     * (disabled 会被剔出可达集,而焦点不该在翻页途中蒸发)。
     *
     * 这道门跑在一个全新的临时 store 上,一条会话都没有,所以扫的是
     * 「输入框 + 档位条 + 空列表 + 预览空态」那一屏。有真行之后的形由
     * `gate:search` / `gate:search-messages` 各自量它们那一半。
     *
     * 反证:把 `SearchList` 里那句 `aria-label={t('search.resultsLabel')}` 拆掉 →
     * 这一屏当场 `aria-input-field-name` / `region` 类违例。
     */
    console.log('\n[6/13] 检索面:开一块面再扫一次')
    await clickSelector(page, '[data-testid="dock-tile-search"]')
    await waitFor('检索面就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="search-panel"] input'))),
    )
    await settle(page, '检索面')
    await scanAxe(page, '检索面', '[data-testid="search-panel"]')
    // 扫完把它收回去,别把它留给下一屏(Dock 上那颗瓦是开关)。
    await clickSelector(page, '[data-testid="dock-tile-search"]')
    await waitFor('检索面已收回', () =>
      page.evaluate(() => !document.querySelector('[data-testid="search-panel"]')),
    )

    /*
     * **音乐面**(音乐收尾 · 壳半边,2026-09-10)。进这道门的理由与模型服务面
     * 逐字相同 —— **外壳那一屏看不见它**(面板收在 Dock 里)。而它是这块壳里
     * 第一处 `role="slider"`:两条拖杆(进度、音量)各要说得出自己叫什么
     * (`aria-label`)、现在是几(`aria-valuenow`)、两头在哪(`aria-valuemin/max`),
     * 外加四颗只有图标的钮(上一首 / 播放暂停 / 下一首 / 红心)各要一个名字 ——
     * 漏一个,读屏软件就只能念「滑块」和「按钮」。
     *
     * 这道门跑在一个全新的临时 store 上,那台机器上没有装过音乐 CLI,所以扫的是
     * 「后端还没配好 + 播放器没在跑 + 电台没开」那一屏(三句空态 + 停用态的钮与杆)。
     * 有真电台之后的形归 `npm run gate:music`(那一道**只写不跑**,见它自己的文件头)。
     *
     * 反证:把 `ui/Slider` 那两处 `aria-label` 拆掉 → 这一屏当场
     * `aria-input-field-name` 类红(一个 `role="slider"` 没有名字)。
     */
    console.log('\n[7/13] 音乐面:开一块面再扫一次')
    await clickSelector(page, '[data-testid="dock-tile-music"]')
    await waitFor('音乐面就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="music-panel"]'))),
    )
    await settle(page, '音乐面')
    await scanAxe(page, '音乐面', '[data-testid="music-panel"]')
    // 扫完把它收回去,别把它留给下一屏(Dock 上那颗瓦是开关)。
    await clickSelector(page, '[data-testid="dock-tile-music"]')
    await waitFor('音乐面已收回', () =>
      page.evaluate(() => !document.querySelector('[data-testid="music-panel"]')),
    )

    /*
     * 「所有应用」面(08-31 Dock/形态批)。进这道门的理由与模型服务面逐字相同 ——
     * **外壳那一屏看不见它**,而它是一整列 `role="switch"` 加一整列打开钮:
     * 每一枚开关都得说得出「什么的开关」(Switch 的 `label`),每一颗打开钮都得
     * 说得出「打开什么」;漏一个,读屏软件就只能念「开关,开」。
     *
     * 它同时是这道门里唯一一屏 **真全屏**(W2:「所有应用」的打开方式从「盖满」
     * 改成了全屏,拍点 ②)。全屏层挂在壳的根上、fixed 铺满整扇窗、`role="region"`
     * 而不是对话框(后面那些面还在,只是被盖住),所以「全屏开着的时候这一屏的
     * 无障碍树长什么样」只有在这里才扫得到 —— 顶栏、四条边上的架子、每一片别的
     * 叶此刻都在它底下且带 `inert`,axe 扫的正是那棵活树。
     * 反证:把 AppsPanel 里 Switch 的 `label` 拆掉 → 这一屏当场 critical
     * button-name 红(每一行都是,因为那颗 <button role="switch"> 只有一个空 span)。
     */
    console.log('\n[8/13] 所有应用面(全屏形态):开一块面再扫一次')
    await clickSelector(page, '[data-testid="dock-tile-apps"]')
    await waitFor('所有应用面就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid^="apps-row-"]'))),
    )
    await settle(page, '所有应用面')
    await scanAxe(page, '所有应用面', '[data-testid="apps-panel"]')
    // 扫完把它关掉(Esc 走的正是退层链的第一站:全屏),免得它挡住下一屏。
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
    console.log('\n[9/13] 文件查看器 + 叶檐:走文件树开一个文件再扫一次')
    /*
     * **先进那条带工作目录的会话**:文件树的根跟着「当前会话的工作目录」走,
     * 而当前会话是内存态 —— 不进去的话树会退回主目录(那时树上有什么就不由
     * 这道门说了算,而且那是用户自己的家目录,门不该去读它)。
     * 走的是用户真走的那条路:总览里点那一行。
     */
    await clickSelector(page, '[data-testid="dock-tile-sessions"]')
    await delay(700)
    const enteredProject = await page.evaluate((id) => {
      const row = document.querySelector(`[data-testid="session-row-${id}"]`)
      if (!(row instanceof HTMLElement)) return false
      row.click()
      return true
    }, seeded[0])
    await delay(600)
    if (!enteredProject) console.log('  · 没进得去那条会话 —— 下面两屏多半会跳过')
    /*
     * ── 入口换了(W1)────────────────────────────────────────────────────
     * 从前这一屏点的是 Dock 上那块「Viewer」瓦。**那块瓦撤了**(09-04 用户裁定:
     * 「它只在打开文件时才有意义」),回访一个文件的路只剩**文件树**(T0 拍点甲)。
     * 所以这一屏改走树:开文件面 → 单击一行 → 查看器在分栏里长出来。
     *
     * ── 扫的东西也多了一件:**叶檐** ──────────────────────────────────────
     * W1 立了「一格一檐」:一片叶只有一条檐,那条檐就是 tab 条。它是这批新件里
     * 语义最密的一块 —— `role="tablist"` / `role="tab"` / `aria-selected`,
     * 一颗 aria-hidden 的 ✕(它**不是**控件,理由在 ui/Tabs 上),外加两颗
     * `ui/IconButton`(分屏 / 隐藏的标签)。所以它自己占一屏。
     */
    await clickSelector(page, '[data-testid="dock-tile-files"]')
    await waitFor('文件树就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="files-tree"]'))),
    )
    const fileRow = await waitFor('树上画出一行文件', async () => {
      const css = '[data-testid="files-tree"] [data-file-path][data-file-type="file"]'
      const found = await page.evaluate((sel) => Boolean(document.querySelector(sel)), css)
      return found ? css : undefined
    }).catch(() => null)
    if (!fileRow) {
      console.log('  · 跳过:树上没有一行文件(夹具没搭起来)')
    } else {
      await clickSelector(page, fileRow)
      await waitFor('查看器就位', () =>
        page.evaluate(() => Boolean(document.querySelector('[data-testid="file-viewer"]'))),
      )
      /*
       * **切到「面板内」那一档**(W6-a):出厂档从 `panel` 改成了 `stage`
       * (设计 `workbench-tabs-2026-09.md` §9)。下面那一组扫的正是**面板内那一格
       * 的身份带**,所以要显式切过去 —— 那一档没有退役,它只是不再是出厂那一格。
       */
      await page.evaluate((sel) => {
        const row = document.querySelector(sel)
        row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      }, fileRow)
      await delay(400)
      await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
        const inPanel = items.find((el) => /面板内|This panel/.test(el.textContent ?? ''))
        if (inPanel instanceof HTMLElement) inPanel.click()
      })
      await waitFor('分栏里那份查看器就位', () =>
        page.evaluate(() =>
          Boolean(document.querySelector('[data-testid="files-panel"] [data-testid="file-viewer"]')),
        ),
      )
      await settle(page, '文件查看器')
      await scanAxe(page, '文件查看器', '[data-testid="file-viewer"]')
      /*
       * **一格一檐**的机器化。这一屏走的是「打开方式 = 面板内」那一档
       * (`file-open-mode` 的出厂缺省,而这道门跑在全新临时 store 上),它**不在
       * 拼贴树里** —— 所以这里问的不是「零檐」,是「**恰一条身份带**」。
       *
       * 修前(W1-a 交卷时)这一档确实零檐,而那是**病**不是规则:关一个文件只剩
       * 右键与 Esc。规则从来是「一格一檐」,面板内这一格也是一格,只是它那条檐由
       * 宿主交进查看器盒子里(树与查看器之间不许插包裹层)。
       *
       * 退役的那三件仍然一件都不在 —— 它们属于旧的 `ViewerChrome`,与这条
       * 由 `workbench/LeafStrip` 画的身份带不是一回事。
       */
      const chromes = await page.evaluate(() => {
        const viewer = document.querySelector('[data-testid="file-viewer"]')
        const tab = viewer?.querySelector('[role="tab"]')
        return {
          own: Boolean(viewer?.querySelector('[data-viewer-chrome]')),
          ownName: Boolean(viewer?.querySelector('[data-testid="viewer-name"]')),
          ownClose: Boolean(viewer?.querySelector('[data-testid="viewer-close"]')),
          tablists: viewer ? viewer.querySelectorAll('[role="tablist"]').length : 0,
          first: viewer?.firstElementChild?.getAttribute('data-testid') ?? null,
          tabText: (tab?.textContent ?? '').trim(),
          hasClose: Boolean(tab?.querySelector('[class*="close"]')),
        }
      })
      assert(
        !chromes.own && !chromes.ownName && !chromes.ownClose,
        '退役的旧檐一件都没有(viewer-name / viewer-close / data-viewer-chrome)',
      )
      assert(
        chromes.tablists === 1,
        `一格一檐:面板内这一格**恰一条**身份带(实测 ${chromes.tablists} 条 tablist;修前 0 条)`,
      )
      assert(
        chromes.first === 'viewer-strip',
        `那条身份带是查看器盒子里的第一个孩子(实测 ${chromes.first})`,
      )
      assert(
        chromes.tabText.length > 0 && chromes.hasClose,
        `它说得出这一格是谁、也关得掉:「${chromes.tabText}」+ ✕`,
      )
    }

    /*
     * 中央区的檐(W1 新 surface)。**W1-b 起它画在窗口顶栏上**(设计 §2.2 D 稿:
     * 「中央区的檐就是窗口顶栏」),不再挂在叶顶。所以这一屏扫的范围从
     * `[data-pane-chrome]`(叶上那条带)换成了 `[data-testid="topbar"]` ——
     * 顶栏上现在坐着一批新东西:每片叶一条 `role="tablist"`、一组 `role="tab"`、
     * 尾格里焦点叶的动作组。它们在外壳那一屏虽然看得见,但**那时只有一格 tab**
     * (身份带那一形);要扫到 tab 条真正的样子得先让它有两格 —— 走行菜单把落点
     * 改成「主区域」,**开着的那份当场搬进中央叶**(选档即生效),于是那一组是
     * 「聊天 + 文件」两格。
     */
    console.log('\n[8b/12] 顶栏标签组(tab 条 + 动作组):开进中央区再扫一次')
    if (!fileRow) {
      console.log('  · 跳过:上一屏没开出文件')
    } else {
      await page.evaluate((css) => {
        const row = document.querySelector(css)
        row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 }))
      }, fileRow)
      await delay(500)
      const picked = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
        const center = items.find((el) => /主区域|Main stage/.test(el.textContent ?? ''))
        if (center instanceof HTMLElement) center.click()
        return { hit: Boolean(center), texts: items.map((el) => (el.textContent ?? '').trim()) }
      })
      await delay(700)
      if (!picked.hit) {
        console.log(`  · 跳过:行菜单里没有「主区域 / Main stage」(现有:${picked.texts.join(' / ') || '—'})`)
      } else {
        const shot = await page.evaluate(() => {
          const bar = document.querySelector('[data-testid="topbar"]')
          return {
            tabs: bar ? bar.querySelectorAll('[role="tab"]').length : 0,
            // 一片叶一条 tablist —— APG 的 tabs 模式:两片叶是两组**互不相干**的
            // tab(方向键不许在两组之间游走),所以它们不是一条 tablist,
            // 也不该用 `aria-owns` 假装成一条。
            tablists: bar ? bar.querySelectorAll('[role="tablist"]').length : 0,
            // 带子自己是一格有名字的 group(读屏软件按地标/组浏览时说得出这是什么)。
            band: bar?.querySelector('[data-testid="topbar-tabs"]')?.getAttribute('aria-label') ?? null,
            /*
             * **中央叶身上零檐** —— W1-b 之后中央区里一条 tablist 都不该有。
             * **限定在中央区**(W4:架子与浮窗的身子也是拼贴树,它们那片叶头上
             * 画的正是同一条檐 —— 那两处没有第二条顶栏可借,判词在
             * `workbench/PaneLeaf.tsx` 文件头那张区域表上)。不限定的话这一条会
             * 把「檐的位置由区域决定」误判成回归。
             */
            inLeaf: document.querySelectorAll(
              '[data-pane-region="center"] [data-pane-leaf] [role="tablist"]',
            ).length,
          }
        })
        if (shot.tabs < 2) {
          console.log(`  · 跳过:顶栏上只有 ${shot.tabs} 格 tab(夹具没搭起来)`)
        } else {
          await settle(page, '顶栏标签组')
          /*
           * ── 扫的是**带子与尾格两块**,不是整条 `<header>` ────────────────────
           * W1-b 往顶栏上添的东西全在这两块里(每片叶一条 tablist + 一组 tab;
           * 尾格里焦点叶的动作组),所以两块合起来就是这一批的新 surface 全集。
           *
           * 不把 `include` 写成整条 `[data-testid="topbar"]`,是因为那样会把顶栏那个
           * `<header>` 元素本身交给 axe,而它会在这一屏上报一条**与本批无关的**
           * `landmark-no-duplicate-banner`:`FloatWindow.tsx:169` 的
           * `<header>` 坐在 `<section role="dialog">` 里,axe 认为 role 一旦被显式
           * 覆盖,那个 `section` 就不再是「分节内容」,于是里面的 `<header>` 升格成
           * 第二个 banner —— 这一屏开着两扇浮窗,于是文档里有三个。
           * **实测是存量**:同一段 include 打在 W1-a 基线(7347cb52)上,读数逐字相同
           * (`._bar_6p1qn_5` / Document has more than one banner landmark)。
           * 修法仓里已经有判例(`ProviderDetail.tsx:60`「头这一行不用 `<header>`」)。
           * **W4 把那条 `<header>` 整条退役了**(浮窗的标题栏 = 它根叶那条檐),
           * 所以这一格留账随合树自然消了 —— include 仍旧只打这两块:理由从
           * 「躲一条存量红」变成「扫的就该是本批新添的那两块 surface」。
           */
          await scanAxe(page, '顶栏标签组', '[data-testid="topbar-tabs"]')
          await scanAxe(page, '顶栏尾格(焦点叶的动作组)', '[data-testid="topbar-trailing"]')
          assert(shot.tablists >= 1, `顶栏上一片叶一条 tablist(实测 ${shot.tablists} 条)`)
          assert(Boolean(shot.band), `标签带自己有无障碍名(实测「${shot.band ?? '—'}」)`)
          assert(shot.inLeaf === 0, `中央叶身上零檐(实测 ${shot.inLeaf} 条 tablist)`)
          console.log(`  ✓ 顶栏上 ${shot.tabs} 格 tab / ${shot.tablists} 条 tablist`)

          /*
           * ── [7c] **拖拽的键盘等价**(W3 裁定 9)────────────────────────────
           * 原话:「不加新键位组合;**每个落点都能从既有 tab 菜单到达**;落定后
           * `announce()` 播报」。所以这一屏问三件事,一件都不能少:
           *  ① 那张菜单里**九档全在**(分屏四向 + 移到架子四边 + 撕成浮窗)——
           *    「能到达」是可数的,不是感觉;
           *  ② 菜单本身过 axe(它是本批新添的一块 surface);
           *  ③ 点一档之后**播报口里有话**(空播报等于没播报,`announce` 自己会把
           *    空串丢掉,所以这一条同时也钉住了「传进去的不是空串」)。
           * `aria-grabbed` 已废弃,这一屏一个字都不问它(裁定 9 末句)。
           */
          /*
           * ── [8d/12] **两格并排那一屏**(W6-a,设计 §6 / §7)────────────────
           *
           * 它进这道门的理由与叶檐那一屏逐字相同:**外壳那一屏看不见它**,
           * 而它自带三件新语义 —— 两格各是一格**有名字的 region**(格头那条不是
           * tablist,所以那块地必须自己说得出是什么)、格头上一颗 `ui/IconButton`
           * 「拆开」、中间一条 `ui/Splitter`(APG 的 window splitter:
           * role=separator + aria-valuenow/min/max + 可聚焦)。
           */
          console.log('\n[8d/12] 两格并排:格头 region 有名 + 拆开钮有 label + 分隔杆报 APG')
          const paired = await openTabMenuByContext(page)
          const joined = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
            const joins = items.filter((el) => /二合一|Join with the tab/.test(el.textContent ?? ''))
            /*
             * **挑一条按得动的**:两条里至少有一条在场(活动格在两端时另一条禁灰)。
             * `ui/Menu` 走的是**原生 `disabled`**(判词在那只文件的 `MenuItem` 上),
             * 所以判据是那一格属性,不是 `aria-disabled`。
             */
            const join = joins.find((el) => !(el instanceof HTMLButtonElement && el.disabled))
            if (!(join instanceof HTMLElement)) {
              return { ok: false, seen: joins.map((el) => (el.textContent ?? '').trim()) }
            }
            join.click()
            return { ok: true }
          })
          await delay(500)
          if (!paired || !joined.ok) {
            console.log(`  · 跳过两格并排那一屏:菜单里没有可用的二合一项 ${JSON.stringify(joined)}`)
          } else {
            const pane = await page.evaluate(() => {
              const sides = Array.from(document.querySelectorAll('[data-pair-side]'))
              const splitter = document.querySelector('[data-testid^="pair-splitter:"]')
              const unpair = document.querySelector('[data-testid^="pair-unpair:"]')
              /*
               * **格头上那颗 ✕**(W7-t / B7)。它是这一屏新长出来的一件语义:
               * 格头 = 身份 + **关这一格**,而 iconOnly 的钮必须说得出自己关的是谁
               * ——「关闭」三个字对两格并排来说是两个答案。它**关不掉就不画**
               * (`canClosePairSide`),所以这里问的是「在场的那些都说得出名字」+
               * 「至少一颗在场」;两格都关不掉这一形在这屏夹具里不成立
               * (并的是聊天 + 文件,文件那一格恒关得掉)。
               */
              const closes = Array.from(document.querySelectorAll('[data-testid^="pair-close:"]'))
              return {
                count: sides.length,
                named: sides.every((el) => (el.getAttribute('aria-label') ?? '').trim().length > 0),
                names: sides.map((el) => el.getAttribute('aria-label') ?? ''),
                role: splitter?.getAttribute('role') ?? null,
                valuenow: Number(splitter?.getAttribute('aria-valuenow')),
                tabIndex: splitter instanceof HTMLElement ? splitter.tabIndex : -2,
                unpairLabel: unpair?.getAttribute('aria-label') ?? '',
                unpairInHead: Boolean(unpair?.closest('[data-pair-head]')),
                closeCount: closes.length,
                closeNames: closes.map((el) => (el.getAttribute('aria-label') ?? '').trim()),
              }
            })
            assert(pane.count === 2, `屏幕上恰有两格(实测 ${pane.count})`)
            assert(pane.named, `每一格都是一格**有名字**的 region(实测 ${pane.names.join(' / ')})`)
            assert(pane.role === 'separator', `分隔杆报 role=separator(实测 ${pane.role})`)
            assert(Number.isFinite(pane.valuenow), `它报得出当下比例(${pane.valuenow})`)
            assert(pane.tabIndex === 0, '它可聚焦(APG:可调的 separator 进 Tab 序)')
            assert(
              pane.unpairLabel.trim().length > 0,
              `那颗「拆开」说得出自己是什么(实测「${pane.unpairLabel}」)`,
            )
            /* W7-t / B7:拆开退到缝中点那颗小把手 —— 它不再长在格头里。 */
            assert(
              !pane.unpairInHead,
              '「拆开」不在格头里(它作用在整格标签上,不属于任何一格)',
            )
            assert(
              pane.closeCount >= 1,
              `格头上有 ✕(只关这一格;实测 ${pane.closeCount} 颗)`,
            )
            assert(
              pane.closeNames.every((name) => name.length > 0),
              `每颗 ✕ 都说得出自己关的是谁(实测「${pane.closeNames.join('」「') || '—'}」)`,
            )
            await settle(page, '两格并排')
            await scanAxe(page, '两格并排', '[data-pane-region="center"]')
            // 收尾:拆回去,别把这一态留给下一屏。
            await page.evaluate(() => {
              const btn = document.querySelector('[data-testid^="pair-unpair:"]')
              if (btn instanceof HTMLElement) btn.click()
            })
            await delay(400)
          }

          /*
           * ── [7c/7e] **标签动作表**(W7-c 裁定 2/3:六项、两个开口)──────────
           *
           * W7-c 之前这里是两屏:[7c] 从檐右端那颗「分屏」钮开表数档数,[7e] 再从
           * 右键开一次、逐字比对两条路。那颗钮删掉之后 [7c] 的开口没有了 —— 而它
           * 守的那件事(**每个落点都能从表里到达,是可数的**)一个字没变,所以两屏
           * 并成一屏,平局的两边换成 **右键** 与 **Shift+F10**。
           *
           * 这一屏问六件,一件都不能少:
           *  ① 右键一格标签**开得出**那张表(不是浏览器 / 宿主的缺省菜单);
           *  ② **恰好六项**,而且**项名逐字**是裁定 3 那六句 —— 「六项」是这一批
           *    的全部内容,数错一项就是减法没做干净或者做过头了;
           *  ③ 「拆开」**不在**普通标签的表里(裁定 3:它只在两格标签上出现,
           *    不是灰掉)—— 上面 [7d] 那一屏已经证过并起来之后它在;
           *  ④ **顶栏右端只有两件可达**:那颗 ⋯(有够不着的标签时才画)与 AgentChip。
           *    「分屏」钮与型工具条都不许再长回来;
           *  ⑤ `Shift+F10` 开出**同一张**表 —— 逐项文本逐字相同。删掉那颗钮之后
           *    这是唯一的键盘入口,少了它这张表对键盘就是不可达;
           *  ⑥ 这张表**键盘走得动**(整组只占一个 Tab 位,`ui/Menu` 的 roving 档),
           *    点一档之后**播报口里有话**。
           *
           * 反证:把 `ui/Tabs` 的 `onTabMenu` 那一口摘掉 → ① 与 ⑤ 一起红。
           */
          console.log('\n[8c+8e/12] 标签动作表:右键 / Shift+F10 开同一张六项表,顶栏右端只两件')
          const openedByContext = await openTabMenuByContext(page)
          if (!openedByContext) {
            console.log('  · 跳过:顶栏上没有标签')
          } else {
            const menu = await page.evaluate(() => {
              const el = document.querySelector('[role="menu"]')
              const items = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
              return {
                open: Boolean(el),
                name: el?.getAttribute('aria-label') ?? '',
                texts: items.map((x) => (x.textContent ?? '').trim()),
                named: items.every((x) => (x.textContent ?? '').trim().length > 0),
                zeroes: items.filter((x) => x instanceof HTMLElement && x.tabIndex === 0).length,
                /* U3-b:每一项按不按得动(`ui/Menu` 走的是原生 `disabled`)。 */
                off: items
                  .filter((x) => x instanceof HTMLButtonElement && x.disabled)
                  .map((x) => (x.textContent ?? '').trim()),
                /* 这张表开在哪一格上、那一格挪不挪得走 —— 判据是**它画不画得出 ✕**
                 * (与 [8f] 挑靶子那一句逐字同一条)。下面那条断言的前提就是它。 */
                lastResident: !document
                  .querySelector('[data-topbar-leaf] [data-tab-id]')
                  ?.querySelector('[data-tab-close]'),
              }
            })
            assert(menu.open, '右键一格标签开得出动作表')
            assert(
              menu.name.trim().length > 0,
              `那张表说得出自己是什么(实测「${menu.name}」)`,
            )
            assert(menu.named, '菜单里每一项都说得出名字(零空项)')
            /*
             * **六项,逐字**(裁定 3)。中央区那一档没有「分屏 ▸」(单叶政策),
             * 也没有「拆开」(这一格不是两格并排),所以屏上是:
             *   与右边的标签二合一 / 与左边的标签二合一 / 撕成浮窗 / 移到架子 ▸ / 关闭
             * —— 五项;「拆开」是第六项,它在 [7d] 那一屏(并起来之后)出现。
             * 数字与名单一起断言:只数数目的话「二合一那两项被换成别的两项」照样绿。
             */
            const WANTED = [
              /与右边的标签二合一|Join with the tab on the right/,
              /与左边的标签二合一|Join with the tab on the left/,
              /撕成浮窗|Tear off/,
              /^(移到架子|Move to shelf)$/,
              /^(关闭|Close)$/,
            ]
            assert(
              menu.texts.length === WANTED.length,
              `普通标签上恰好 ${WANTED.length} 项(实测 ${menu.texts.length}:${menu.texts.join(' / ')})`,
            )
            for (const re of WANTED) {
              assert(
                menu.texts.some((text) => re.test(text)),
                `项名逐字对得上 ${re}(实测:${menu.texts.join(' / ')})`,
              )
            }
            assert(
              !menu.texts.some((text) => /^(拆开|Split apart)$/.test(text)),
              `普通标签上没有「拆开」(它只在两格标签上出现,不是灰掉;实测:${menu.texts.join(' / ')})`,
            )
            assert(
              !menu.texts.some((text) => /左移一位|右移一位|Move left|Move right/.test(text)),
              '「左移 / 右移」不在表里(换序靠拖拽,键盘等价升格成全局命令)',
            )
            assert(
              menu.zeroes === 1,
              `整组只占一个 Tab 位(实测 ${menu.zeroes} 项 tabIndex=0)`,
            )
            /*
             * ── **挪不走的那一格:三项禁灰,不是点下去再拒绝**(U3-b)───────────
             * 这张表此刻开在顶栏第一格上,而那一格是中央区那条常驻会话 —— 这个区域
             * 里只剩它一条,于是「撕成浮窗 / 移到架子 ▸ / 关闭」按 `canDetachTab`
             * 全部禁灰(**菜单与拖拽同一条判据、同一只产地**;拖那条路的拒绝在
             * `gate:drag` 里)。修前这三项只问 `!target`,于是菜单能把最后一格会话
             * 搬走,中央区当场空掉(`pruneRegions` 铸一片空叶、叶 id 换人 = 整台
             * 聊天区重挂)。**项还在表里**——上面「恰好 5 项」那一条就是它的另一半:
             * 禁灰说的是「此刻不行」,与「这里不存在这件事」(分屏 / 拆开的不画)
             * 是两句不同的话。
             *
             * 前提写成读数而不是假设:第一格万一画得出 ✕(将来夹具里多一条会话),
             * 这一站自己跳过,而不是红在一句不成立的前提上。
             *
             * 反证:把 `LeafActions` 那三项的 `disabled` 换回 `!target` → 当场红
             * (实测三项一条不灰)。
             */
            if (!menu.lastResident) {
              console.log(`  · 跳过禁灰那一站:顶栏第一格挪得走(它画得出 ✕)`)
            } else {
              const GUARDED = [
                /撕成浮窗|Tear off/,
                /^(移到架子|Move to shelf)$/,
                /^(关闭|Close)$/,
              ]
              const notOff = GUARDED.filter((re) => !menu.off.some((text) => re.test(text)))
              assert(
                notOff.length === 0,
                '中央区最后一格常驻内容:搬走类的三项全禁灰'
                  + `(灰的:${menu.off.join(' / ') || '—'};没灰的:${notOff.join(' / ') || '—'})`,
              )
            }
            await settle(page, '标签动作表')
            await scanAxe(page, '标签动作表', '[role="menu"]')

            /*
             * **[8f] 排在「移到架子 ▸」那一步之前**:那一步会把一格标签搬到架子上,
             * 顶栏于是只剩一格 —— 而这一站要的正是「**非活动**的那一格」。站完把表
             * 重新开一次,后面几步的前提(表开着)一个字不变。
             */
            await page.keyboard.press('Escape')
            await delay(250)
            /*
             * ── [8f] **右键一格非活动标签:表作用在被右键的那一格**(U3)──────
             *
             * U2 按用户裁定让右键**不再切标签**之后,「被右键的」与「活动的」可以是
             * 两格 —— 而这张表从 W6-c 起一直写死 `leaf.active`:右键一格非活动标签,
             * 点「关闭」关掉的是**别人**。Chrome / VS Code 的表都作用在被右键的那一格,
             * 所以这是把 U2 顺手带走的行为接回来,不是一条新裁定。
             *
             * 上面那一屏([8c+8e])量的是**活动格**上两个开口逐字相同,它一个字没改;
             * 这一站补的是**非活动格**那一形。两条一起才说得完整。
             *
             * 反证:把 `LeafActions` 里那句 `const at = …menuAt?.tabId…` 换回
             * `const at = leaf.active` → 「关掉的是被右键的那一格」当场红。
             */
            console.log('\n[8f/12] 右键非活动标签:表作用在被右键的那一格')
            const readStrip = () =>
              page.evaluate(() => {
                const tabs = Array.from(document.querySelectorAll('[data-topbar-leaf] [data-tab-id]'))
                return {
                  ids: tabs.map((el) => el.getAttribute('data-tab-id')),
                  active:
                    tabs
                      .find((el) => el.getAttribute('aria-selected') === 'true')
                      ?.getAttribute('data-tab-id') ?? null,
                  /* 只挑**画得出 ✕** 的那些当靶子:关不掉的那一格(中央区最后一格
                   * 常驻内容)走的是另一条路(播报「关不掉」),不是这一站的对象。 */
                  closable: tabs
                    .filter((el) => el.querySelector('[data-tab-close]'))
                    .map((el) => el.getAttribute('data-tab-id')),
                }
              })
            const beforeStrip = await readStrip()
            const victim = beforeStrip.closable.find((id) => id !== beforeStrip.active) ?? null
            if (!victim) {
              console.log(
                `  · 跳过:顶栏上没有「非活动且关得掉」的第二格(实测 ${beforeStrip.ids.join(' / ') || '—'})`,
              )
            } else {
              await page.evaluate((id) => {
                const el = document.querySelector(`[data-topbar-leaf] [data-tab-id="${id}"]`)
                if (!(el instanceof HTMLElement)) return
                const box = el.getBoundingClientRect()
                el.dispatchEvent(
                  new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    clientX: Math.round(box.left + box.width / 2),
                    clientY: Math.round(box.top + box.height / 2),
                  }),
                )
              }, victim)
              await delay(400)
              const clicked = await page.evaluate(() => {
                const hit = Array.from(
                  document.querySelectorAll('[role="menu"] [role="menuitem"]'),
                ).find((el) => /^(关闭|Close)$/.test((el.textContent ?? '').trim()))
                if (hit instanceof HTMLElement && hit.getAttribute('aria-disabled') !== 'true') {
                  hit.click()
                  return true
                }
                return false
              })
              await delay(600)
              const afterStrip = await readStrip()
              assert(clicked, '右键非活动标签开出的表里「关闭」按得动')
              assert(
                !afterStrip.ids.includes(victim),
                `关掉的是**被右键的那一格**(靶子 ${victim};剩 ${afterStrip.ids.join(' / ') || '—'})`,
              )
              assert(
                afterStrip.active === beforeStrip.active,
                `活动格一个字没动(前 ${beforeStrip.active} / 后 ${afterStrip.active})`,
              )
            }
            /*
             * **把这一态还回去**(与 [7d] 那句「收尾:拆回去,别把这一态留给下一屏」
             * 同一条纪律):上面那一站真的关掉了一格,而下面「移到架子 ▸」那一步还要
             * 再搬走一格 —— 不还,顶栏会空掉,`Shift+F10` 那一条就没有对象可量了。
             * 还的方式是用户自己那条路:打开方式此刻是「主区域」([8b] 设的),
             * 点一下那行文件它就回到顶栏。
             *
             * **重开时开在挪得走的那一格上**(U3-b):顶栏第一格是中央区那条常驻会话,
             * 而它此刻是这个区域里的最后一条 —— 三项搬走类的动作在它身上按
             * `canDetachTab` 禁灰(菜单与拖拽同一条判据),子表因此开不出来。
             * 这不是把断言放水:下面那一步量的是「四条边全在、项名带宾语、落定要
             * 播报」,那些话只在**真搬得动**的那一格上说得成立;开在搬不走的那一格
             * 上,量到的其实是「禁灰生效了」——那件事归 [7d]/单测,不归这一步。
             * 上一行那句「先把文件那一格点回来」正是「先补一格再搬」的现成夹具。
             */
            if (fileRow) {
              await clickSelector(page, fileRow)
              await delay(600)
            }
            const reopened = await openTabMenuByContext(page, { detachableOnly: true })
            if (!reopened) console.log('  · 表没能重新开出来 —— 下面几步会自己跳过')

            /*
             * **「移到架子 ▸」是一格子菜单**(W7-c:四行平铺是「菜单太多」的一半)。
             * 展开它,四条边全在,而且**项名带宾语**(B5:不许裸方位词)。
             */
            const sub = await page.evaluate(() => {
              const items = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
              const parent = items.find((el) => /^(移到架子|Move to shelf)$/.test((el.textContent ?? '').trim()))
              if (!(parent instanceof HTMLElement)) return null
              parent.click()
              return true
            })
            if (sub) {
              await delay(300)
              const rows = await page.evaluate(() => {
                const menus = Array.from(document.querySelectorAll('[role="menu"]'))
                const last = menus.at(-1)
                return Array.from(last?.querySelectorAll('[role="menuitem"]') ?? []).map((el) =>
                  (el.textContent ?? '').trim(),
                )
              })
              assert(rows.length === 4, `「移到架子 ▸」四条边全在(实测 ${rows.length}:${rows.join(' / ')})`)
              assert(
                rows.every((text) => /栏|shelf/i.test(text)),
                `子菜单项名带宾语,不是裸方位词(实测:${rows.join(' / ')})`,
              )
              // 点一条 —— 它与拖到那条边调的是**同一只** `dropRef`,落定要播报。
              await page.evaluate(() => {
                const menus = Array.from(document.querySelectorAll('[role="menu"]'))
                const last = menus.at(-1)
                const hit = Array.from(last?.querySelectorAll('[role="menuitem"]') ?? [])[1]
                if (hit instanceof HTMLElement) hit.click()
              })
              await delay(400)
              const spoken = await page.evaluate(
                () => document.querySelector('[data-live="polite"]')?.textContent ?? '',
              )
              assert(spoken.trim().length > 0, `落定之后播报口里有话(实测「${spoken.trim()}」)`)
            } else {
              console.log('  · 跳过子菜单那一步:表里没有「移到架子」')
            }
            await page.keyboard.press('Escape')
            await delay(250)

            /*
             * ── **顶栏右端只留两件**(裁定 2)────────────────────────────────
             * 「可达」是可数的:尾格里能按的东西恰好是那颗 ⋯(有够不着的标签时才画)
             * 与 AgentChip。「分屏」那颗钮与型工具条不许再长回来 —— 前者按 testid
             * 认(它的名字随语言变,testid 不变),后者按「檐里有没有第三格」认。
             */
            const trailing = await page.evaluate(() => {
              const box = document.querySelector('[data-testid="topbar-trailing"]')
              const buttons = Array.from(box?.querySelectorAll('button') ?? [])
              return {
                split: Boolean(document.querySelector('[data-testid^="pane-split:"]')),
                labels: buttons.map((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim()),
                /* AgentChip 没有 testid,它是尾格里那颗**带名字的**钮 —— 这一格是
                 * 读数不是判据(判据是上面那两条:没有分屏钮、最多两件)。 */
                agent: buttons.length > 0,
              }
            })
            assert(!trailing.split, '顶栏右端没有「分屏」那颗钮(W7-c 裁定 2:它删了)')
            assert(
              trailing.labels.length <= 2,
              `顶栏右端最多两件可按(实测 ${trailing.labels.length}:${trailing.labels.join(' / ')})`,
            )
            console.log(`  · 顶栏右端:${trailing.labels.join(' / ') || '—'}(AgentChip ${trailing.agent ? '在' : '不在'})`)

            /*
             * ── **`Shift+F10` 是删钮之后唯一的键盘入口**(裁定 3)───────────
             * 焦点先落到那一格标签上(`ui/Tabs` 的 roving 档:选中那一格 tabIndex=0),
             * 再按键。开出来的必须与右键那一张**逐字相同** —— 两张不同的表(哪怕内容
             * 看着差不多)正是「这条路上少一档」的下一个产地。
             */
            await page.evaluate(() => {
              const tab = document.querySelector('[data-topbar-leaf] [data-tab-id]')
              if (tab instanceof HTMLElement) tab.focus()
            })
            await delay(200)
            await page.keyboard.down('Shift')
            await page.keyboard.press('F10')
            await page.keyboard.up('Shift')
            await delay(400)
            const viaKey = await page.evaluate(() => {
              const el = document.querySelector('[role="menu"]')
              return {
                open: Boolean(el),
                name: el?.getAttribute('aria-label') ?? '',
                texts: Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]')).map(
                  (x) => (x.textContent ?? '').trim(),
                ),
              }
            })
            assert(viaKey.open, 'Shift+F10 落在焦点标签上开得出动作表(删钮之后唯一的键盘入口)')
            assert(
              JSON.stringify(viaKey.texts) === JSON.stringify(menu.texts),
              '右键与 Shift+F10 开出的是同一张表,逐项逐字相同'
                + `(键盘 ${viaKey.texts.length} 项:${viaKey.texts.join(' / ')};`
                + ` 右键 ${menu.texts.length} 项:${menu.texts.join(' / ')})`,
            )
            await page.keyboard.press('Escape')
            await delay(250)

          }
        }
      }
    }

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
    /*
     * **把「当前会话」换回没有项目的那一条**,再去扫总览。
     *
     * 理由是一笔**产品既有的账**,不是这一批的东西:带项目那条会话被选中时,
     * 行上那枚项目小签坐在「选中」那格底色上,对比度 4.45 —— 差 AA 那条线 0.05。
     * 上面两屏为了有一棵真的文件树,必须进那条带工作目录的会话;进完之后
     * 把「当前」还回去,总览那一屏量的就还是它一直在量的那一形。
     * **留账**:那 0.05 要么调 `--st-sel` 要么调小签的字色,单独一批,不在 W1 里顺手改。
     */
    await clickSelector(page, '[data-testid="dock-tile-sessions"]')
    await delay(600)
    await page.evaluate((id) => {
      const row = document.querySelector(`[data-testid="session-row-${id}"]`)
      if (row instanceof HTMLElement) row.click()
    }, seeded[1])
    await delay(500)

    console.log('\n[10/13] 会话总览(树形列表):开一块面再扫一次 + Tab 序走查')
    /*
     * **先看它在不在,再决定点不点**(W6-a)。会话总览的出厂摆法从浮窗改成了
     * 左架子(设计 §8),而钉在架子上的面进一条会话**不会收回 Dock**
     * (`expose/store` 那条「钉着的不收」)—— 于是它此刻多半还开着,再点一下
     * 那块瓦反而是把整条架子收起来。判据因此从「点开它」改成「让它开着」。
     */
    const rowsShown = () =>
      page.evaluate(() => document.querySelectorAll('[data-session-id]').length > 0)
    /*
     * **这一屏要它是一扇浮窗**:下面三条走查(摆出来时焦点落在搜索条上、Tab 序、
     * 「Esc 收回它」)量的是**一块面被打开**时的形,而钉在架子上的面既不抢焦点、
     * Esc 也收不掉它(架子是常驻家具)。W6-a 把它的出厂摆法改成了左架子(§8),
     * 所以这里显式选一次「浮窗」——用户真走的那条路(右键 → 打开方式)。
     */
    await page.evaluate(() => {
      const tile = document.querySelector('[data-testid="dock-tile-sessions"]')
      if (tile instanceof HTMLElement) {
        tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))
      }
    })
    await delay(400)
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
      const float = items.find((el) => /^(Float|浮窗)$/.test((el.textContent ?? '').trim()))
      if (float instanceof HTMLElement) float.click()
    })
    await delay(600)
    if (!(await rowsShown())) {
      await clickSelector(page, '[data-testid="dock-tile-sessions"]')
    }
    await waitFor('总览画出会话行', rowsShown)
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

    /*
     * **预览标签说得出自己是预览**(C2,设计 `docs/session-continuity-2026-09.md`
     * §4 + 拍点 5)。它接在这一屏而不是另开一屏,是因为造出一格预览标签的**唯一
     * 一条用户路**就在这块面上:在会话列表里点一行。缺省档 `preview` 于是把顶栏
     * 那一格标成预览格 —— 屏幕上是**斜体**,而斜体读屏软件看不见。
     *
     * 所以这里量的是那句**只念不看**的状态词(`.visually-hidden`,进这一格 tab
     * 的可访问名),不是量字形:「屏幕上看得出、读屏软件也说得出」是两件事,
     * 而这道门查的是后者。`data-tab-preview` 那一格只用来定位。
     *
     * 点完这一行,浮窗形的总览会自己收回 Dock(「进入 = 活干完了」,判词在
     * `expose/store` 上)—— 下面那一句 Esc 因此多半是恒等,留着是为了另一条路
     * (钉在架子上时它不收)。
     *
     * **反证**:把 `ui/Tabs.tsx` 里那句 `{tab.preview && <span
     * className="visually-hidden">…}` 拆掉 → 这一条当场红(`data-tab-preview`
     * 还在,可访问名里那个词没了)。
     */
    const rowClicked = await page.evaluate(() => {
      const row = document.querySelector('[data-focus-scope="expose"] [data-session-id]')
      if (!(row instanceof HTMLElement)) return false
      row.click()
      return true
    })
    if (rowClicked) {
      await delay(600)
      const preview = await page.evaluate(() => {
        const tab = document.querySelector('[data-topbar-leaf] [data-tab-preview]')
        if (!tab) return null
        const word = tab.querySelector('.visually-hidden')
        return { text: (word?.textContent ?? '').trim() }
      })
      assert(preview !== null, '点会话列表一行之后,顶栏上有一格预览标签(缺省档 = 预览)')
      assert(
        preview !== null && /^(预览|Preview)$/.test(preview.text),
        `预览标签带一句只念不看的状态词(实为「${preview?.text ?? '—'}」)`,
      )
    } else {
      console.log('  · 总览上没有会话行 —— 跳过预览标签那一条(不是红)')
    }

    // 收回它(Esc 走退层链,最上面那扇浮窗),免得它挡住下一屏。
    await page.keyboard.press('Escape')
    await waitFor('总览已收回', () =>
      page.evaluate(() => !document.querySelector('[data-focus-scope="expose"]')),
    )

    /*
     * **权限卡**那一屏(应用级许可 · 壳半边,2026-09-10)。
     *
     * 它进这道门的理由与前面几屏逐字相同 —— **外壳那一屏看不见它**:一张权限卡
     * 只在「某一次工具调用要审批、而且轮到它了」那一刻才长出来。而它恰恰是这批
     * 新件里语义最要紧的一块:一个 `role="group"` 加最多五颗真按钮,组的名字得
     * 说得出**在等什么**(「等待授权:<标题>」),漏了这一句读屏软件只能念出
     * 「组,允许一次,本会话,……」——五个动词,没有宾语。
     *
     * ── 这一屏为什么是**条件扫**,而不是自己造一张卡 ────────────────────────
     * 造一张真卡要一台会发工具调用的假 provider + 缺省权限档 + 一次真的工具循环。
     * 那整套支架**已经有一份**,在 `npm run gate:permission` 里(它的活就是从卡
     * 出现一路点到设置页撤销),那道门自己会对卡跑一遍 axe。这一屏因此只做两件事:
     * 卡在场就扫它 + 量那句可访问名;不在场就打印一行说清由谁负责,**不判红** ——
     * 与总览那一屏「找不到会话行打印跳过」同一条纪律。
     */
    console.log('\n[11/13] 权限卡:在场就扫(造卡那一半归 `npm run gate:permission`)')
    const permissionCard = await page.evaluate(() => {
      const el = document.querySelector('[data-permission-card]')
      if (!el) return null
      return {
        name: (el.getAttribute('aria-label') ?? '').trim(),
        role: el.getAttribute('role'),
        scope: el.getAttribute('data-focus-scope'),
        keys: [...el.querySelectorAll('button')].length,
      }
    })
    if (permissionCard) {
      await settle(page, '权限卡')
      await scanAxe(page, '权限卡', '[data-permission-card]')
      assert(permissionCard.role === 'group', '权限卡是一个 group')
      assert(
        permissionCard.scope === 'permission',
        '权限卡接在响应链上(data-focus-scope="permission")',
      )
      assert(
        permissionCard.name.length > 0 && /[:：]/.test(permissionCard.name),
        `权限卡的可访问名说得出在等什么(实为「${permissionCard.name}」)`,
      )
    } else {
      console.log('  · 此刻屏上没有权限卡 —— 跳过(造卡那一半在 `gate:permission` 里,不是红)')
    }

    // 28 = `src/dev/Gallery.tsx` 今天的 <Section> 展位数(25 件组件 +
    // useScrolledPast / useSettlePulse / useInlineEdit 三件 hook)。日志读数,不是断言。
    console.log('\n[12/13] 组件规格页(?gallery):28 个展位一次全在场')
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

    console.log('\n[13/13] 键盘走查:Dialog 圈禁与返还、Menu 方向键循环')
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
  console.log(
    '\n[a11y-gate] ok —— 九屏 axe 零违例(W3 添的是拖拽落点菜单那一屏,W6-a 添的是两格并排,'
      + '权限卡那一屏在场才扫);'
      + '键盘走查全绿(W6-c 添的是标签右键菜单那一档:右键与钮开出同一张表)',
  )
}

main().catch((error) => {
  console.error('\n[a11y-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
