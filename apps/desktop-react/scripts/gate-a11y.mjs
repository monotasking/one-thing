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
 *     唯一一屏 **cover 形态**的面),和 `?gallery` 那张组件规格页(15 件 ui 组件一次
 *     全在场,这是唯一能把每一件都摆上台的地方)。基线 **0** —— 有违例就修,不入基线。
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
 *   · 把 ui/Dialog.tsx 里的 `useFocusTrap(panel, open)` 注释掉  → (b)(c) 必红
 *     (焦点留在开它的那个按钮上,Esc 之后也无所谓「还」不还);
 *   · 把 ui/Menu.tsx 里的 `useRoving(ref, …)` 注释掉          → (d) 必红
 *     (方向键不再移动焦点,tabIndex 表也不再是「一个 0、其余 -1」);
 *   · 把 styles/global.css 那条 `:focus-visible` 规则注释掉    → (e) 必红
 *     (落焦元素的 outline 变成浏览器默认的 auto,颜色不是 --accent-ring)。
 * 验证记录写在汇报里。改了这条门的任何一条断言,请重跑一次它的反证。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 跑法:`node scripts/gate-a11y.mjs`
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
import { AxeBuilder } from '@axe-core/playwright'

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
 * 等这一屏上的动画**播完**再量。
 *
 * axe 的对比度那条规则读的是**此刻**的计算样式,而入场动画(--dur-enter 那一族
 * 是 opacity + transform)中途的那一帧,前景与背景都还在半透明地混着 —— 于是
 * 同一屏两次跑会得出两个数(08-31 实测:4.04/2.43 与 3.99/2.39,差的正是那一帧)。
 * 一条会抖的门比没有门更糟:它教人重跑而不是教人修。
 *
 * 判据取 `document.getAnimations()`(CSS 动画与过渡都在里面),等它们各自的
 * `finished` —— 比「睡 400ms」准:睡多久都是猜,而这是问动画本人。
 * 无限循环的动画(spinner)永远不 finished,所以只等有终点的那些;
 * 最后再给一帧,让最后一次样式重算落地。
 */
async function settleAnimations(page) {
  await page.evaluate(async () => {
    const ending = document
      .getAnimations()
      .filter((a) => {
        const d = a.effect?.getComputedTiming?.()
        return d ? d.iterations !== Infinity : true
      })
      .map((a) => a.finished.catch(() => undefined))
    await Promise.all(ending)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
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
    const items = [...menu.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')]
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

  // 方向键循环:按 count + 1 下 ↓,应当绕回第一项。
  const first = await page.evaluate(() => {
    const menu = document.querySelector('[role="menu"]')
    const items = [...menu.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')]
    return items[0].textContent?.trim() ?? ''
  })
  for (let i = 0; i < shape.count + 1; i += 1) await page.keyboard.press('ArrowDown')
  const looped = await page.evaluate(() => {
    const menu = document.querySelector('[role="menu"]')
    const items = [...menu.querySelectorAll('[role="menuitem"],[role="menuitemradio"]')]
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
  let server
  let app
  try {
    console.log('\n[1/7] 起一台 core')
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

    console.log('\n[2/7] 拉起应用(独立 --user-data-dir)')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '' },
    })
    const page = await app.firstWindow()
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    await waitFor('Dock 就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid^="dock-tile"]'))),
    )
    console.log('  ✓ 外壳画出来了')

    console.log('\n[3/7] 产品外壳:axe 全页扫描 + Tab 序走查')
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
    console.log('\n[4/7] 模型服务面:开一块面再扫一次')
    await clickSelector(page, '[data-testid="dock-tile-providers"]')
    await waitFor('模型服务面就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid^="provider-row-"]'))),
    )
    await scanAxe(page, '模型服务面', '[data-testid="providers-panel"]')

    /*
     * 「所有应用」面(08-31 Dock/形态批)。进这道门的理由与模型服务面逐字相同 ——
     * **外壳那一屏看不见它**,而它是一整列 `role="switch"` 加一整列打开钮:
     * 每一枚开关都得说得出「什么的开关」(Switch 的 `label`),每一颗打开钮都得
     * 说得出「打开什么」;漏一个,读屏软件就只能念「开关,开」。
     *
     * 它同时是这道门里唯一一屏 **cover 形态**的面:盖挂在内容栏里而不是壳根上,
     * 所以「盖开着的时候这一屏的无障碍树长什么样」只有在这里才扫得到。
     * 反证:把 AppsPanel 里 Switch 的 `label` 拆掉 → 这一屏当场 critical
     * button-name 红(每一行都是,因为那颗 <button role="switch"> 只有一个空 span)。
     */
    console.log('\n[5/7] 所有应用面(cover 形态):开一块面再扫一次')
    await clickSelector(page, '[data-testid="dock-tile-apps"]')
    await waitFor('所有应用面就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid^="apps-row-"]'))),
    )
    await settleAnimations(page)
    await scanAxe(page, '所有应用面', '[data-testid="apps-panel"]')
    // 扫完把它关掉(Esc 走的正是本批新立的退层链),免得盖着的那一层挡住下一屏。
    await page.keyboard.press('Escape')
    await waitFor('所有应用面已收回', () =>
      page.evaluate(() => !document.querySelector('[data-testid="apps-panel"]')),
    )

    console.log('\n[6/7] 组件规格页(?gallery):15 件 ui 组件一次全在场')
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
    await scanAxe(page, '规格页')

    console.log('\n[7/7] 键盘走查:Dialog 圈禁与返还、Menu 方向键循环')
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
  }

  if (failures.length) {
    console.error(`\n[a11y-gate] FAILED(${failures.length} 条):\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\n[a11y-gate] ok —— 四屏 axe 零违例;键盘走查全绿')
}

main().catch((error) => {
  console.error('\n[a11y-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
