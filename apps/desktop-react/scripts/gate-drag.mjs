#!/usr/bin/env node
/**
 * **拖拽手感的真机门**(W6-b,设计 `apps/desktop-react/docs/workbench-tabs-2026-09.md`
 * §4 §5 §11;W3 那七条 + W3-b 那十一条整套重写)。
 *
 * ── 它为什么必须是真机门 ────────────────────────────────────────────────
 * 这一批交付的东西**全部**是「指针走到哪儿 → 屏幕上哪一块矩形亮起来 → 松手之后
 * 树变成什么样」。前两件在 jsdom 里根本不存在(它不排版,`getBoundingClientRect`
 * 一律答零),所以判据可以脱开浏览器测(`workbench/__tests__/drop.test.ts` 31 条),
 * **而链路不行**。08-30 那条判例的原话:交互时序类改动必须真机对照,jsdom 的绿
 * 不算数。
 *
 * ── 这一版的方法论:**连续不停顿的指针序列**(§10 W6-b 的原话)────────────
 * 上一版每一条都是「走到落点 → 停下 → 量」。停下之后屏幕是静止的,于是
 * 「**一直在动就没反应**」这一整类病(跟手掉帧、槽位漂、空位每帧重建、hover 底
 * 在指针经过邻居时闪一下)一条都抓不到 —— 而那正是用户报的那句「拖拽没有浏览器
 * 的丝滑、流畅和交互感」。
 *
 * 所以这一版的量法是 `stroke()`:**一边继续派 `mouseMoved` 一边采样**。
 * 微动幅度 1px、**只动横向**(竖向一动就可能跨进「放到标签上」那条带,那是另一形),
 * 采样在两发 move 之间,于是读到的每一格都是「手还在动的那一刻屏幕上真有的东西」。
 *
 * ── 十个场景(派工令 §11 那七条 + U1 两条 + U2 一条,2026-09-08)────────────
 *  ① 三种来源(会话行 / 文件行 / 标签)到标签条**每一个位置**:一律是**空位**
 *     (U1:「落到某一格正中 = 描圈二合一」那一档退役,条上只剩一种落点),
 *     浮影下那行字非空;而且**一趟扫过去再扫回来**期间挂 MutationObserver:
 *     占位是**同一个元素**、只被 `insertBefore` 挪位、`style.width` 从不回 0、
 *     `data-pair-hot` 零次 —— 用户报的「拖到顶栏标签正中闪烁」量的就是这几个数
 *  ② 按下即切换、松手不动无事、横向 6px 才浮起、竖向出带才撕下;
 *     **只有主键才切**(U2:右键 / 中键按在非活动标签上不换活动位,右键照开菜单)
 *  ③ 换序最左 / 最右 / 中间三处:顺序与活动位正确;松手有 150ms 的位移过渡
 *     (读 `transition` 与非零起始位移);**取消那三条路(Esc / pointercancel /
 *     窗口失焦)顺序不变、无残留,而且各自都是一段 150ms 的滑回**(U2 —— 从前
 *     三条都是瞬移:5ms 到家、`data-settle` 一次都没挂过);
 *     **全程标签条 / 内容区 / 其它标签三处底色逐字不变**;
 *     **刚抬起那一帧邻居一个都不动**;**最宽的那一格拖得到末位**;
 *     **右邻居恰在「被拖右缘 = 它中心」那一刻让位**(中心对中心在这里当场红)
 *  ④ **条底缘下 6–24px 那条带整段并回了换序**(U2:「放到标签上」删掉 —— 真机量到
 *     那一圈被抬起的标签盖住 92%):横着拖停 1s 不误并;压到条底缘下 12px 仍是换序
 *     (邻居仍让位、零 `data-pair-hot`、浮影提示行不出现);压在末格之后的空白上
 *     松手 = **挪到末位**(从前那一站断的是「空动作」—— 这是一条行为变化);
 *     两格的标签拖下去同样是换序,不是拒绝态
 *  ⑤ 从架子拖文件到聊天区中间 = 新标签,右带 = 二合一;浮窗不接住自己
 *  ⑥ 零重挂:换序 / 二合一 / 拆开 / 换比例四步,内容根节点同一个 DOM
 *  ⑦ 拒绝态:光标 not-allowed + 一句理由;松手弹回,树一个字不变
 *  ⑧ **顶栏末格右边那片空白 = 插到末尾**(U1;从前它不在条的矩形里,于是那片
 *     空白上判据一路问到了别的落点 —— 用户报的「顶栏末格右边空白不能放」)
 *  ⑨ **边带只对没有架子的那一边成立,而且只有 12px**(U1;用户报的「莫名钉边」):
 *     右缘 20px = 叶的右带(板),6px = 边带(膜);松手长出右架子;再拖一行到
 *     同一点,这一次落的是架子自己;左边(已经有架子)6px 处压根没有边带
 *  ⑩ **自己的外扩带不许赢过别人的条**(U2):顶栏那条条的 24px 下沿外扩盖住左右
 *     架子标签条的上半截,而从前「自己的带」先判 —— 于是把顶栏一格标签拖到架子
 *     条的上半截被判回换序。站在架子条 top + 8(仍在顶栏条的外扩里)上量:架子
 *     那条条腾出空位、提示「放到第 n 位」,松手那一格进了左架子
 *
 * ── 手势怎么派:CDP `Input.dispatchMouseEvent`,一根手指都不碰用户的机器 ───
 * 09-01 判例(系统级合成输入干扰用户用电脑,用户被迫杀掉全部任务)立的法:
 * 手势探针一律优先 CDP。这道门**没有一处** CGEvent,全部走
 * `Input.dispatchMouseEvent`(mousePressed / mouseMoved / mouseReleased,
 * `button: 'left'` + `buttons: 1`)—— 它只进这一个窗口的输入管线,真光标一动不动。
 *
 * 窗子**离屏起**(`ONETHING_GATE_HEADLESS=1`,S4 立的纪律),焦点由
 * `Emulation.setFocusEmulationEnabled` 补。
 *
 * ── 为什么 mousePressed 而不是 pointerdown ──────────────────────────────
 * Chromium 的输入管线**从鼠标事件合成 pointer 事件**:一发 `mousePressed` 到达
 * blink 之后,页面上先收到 `pointerdown` 再收到 `mousedown`。CDP 没有
 * `Input.dispatchPointerEvent` 这一口 —— 鼠标那一口就是它。所以这里派的是
 * 真实链路上真实存在的那一发,不是「模拟一个 pointerdown」。
 *
 * 跑法:`npm run gate:drag`。
 * 前置:仓根 `bun run server:build`,本目录 `npm run app:build`。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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

const OWNER_UID = 'local-user'
const OWNER_WID = 'default'

/** 判据这一头的几个数,与产品源码里的常量同源(改一边这道门当场说话)。 */
const DRAG_START_X = 6
const SETTLE_MS = 150
const TEAR_OFF_DISTANCE = 24
/**
 * **条底缘往下 12px:U2 之前是「放到标签上」,今天仍是换序**。
 *
 * 那条带(条底缘 + 6 到 + 24)整段并回了换序 —— 用户 09-08 裁定删掉二合一那一档,
 * 判词在 `src/ui/drag/constants.ts` 的 `ONTO_FROM_PX` 退役段。门仍旧站在**同一点**
 * 上量,只是断言反过来了:这里要读到的是让位、空提示行与零描圈。站在正中而不是
 * 贴着任一沿,理由没变 —— 贴着量的话一次舍入就能把这一站推到邻居那一形去,而那种
 * 红是门自己的抖。
 */
const BELOW_STRIP_OFFSET = 12
/**
 * 「在这条边上生一条新架子」那条带有多宽(`workbench/drop.ts` 的 `NEW_SHELF_BAND`)。
 * 它**不是**形态机那个 `SNAP_BAND` 24 —— 两者是两件事,判词在产品源码那一格上;
 * 场景 ⑨ 站在 6(带内)与 20(带外)两点上量,3px 的舍入预算两边都够。
 */
const NEW_SHELF_BAND = 12
/**
 * 「边越过中心」那一条断言两侧各让 3px。
 *
 * 舍入预算:CDP 把指针 x 取整,`topStrip` 把每一格矩形也取整,两处加起来天然有
 * ±1.5px 的松动 —— 2 恰好压在那条线上,3 让开它。而它仍旧咬得死:中心对中心那一版
 * 的门槛比这一版晚**半格标签宽**(60~80px),3px 的两侧各一站分得清清楚楚。
 */
const EDGE_EPS = 3

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
    await delay(120)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
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

/* ── 打表(照 gate-focus 的体例)────────────────────────────────────────── */

const scenarios = []
let current = null
function scenario(name) {
  current = { name, checks: [] }
  scenarios.push(current)
}
function assert(ok, message, detail) {
  current.checks.push({ ok: Boolean(ok), message, detail: detail === undefined ? '' : String(detail) })
  console.log(`   ${ok ? '✓' : '✗'} ${message}${detail === undefined ? '' : `  ${detail}`}`)
}

/* ── 手势:CDP 鼠标(见文件头)──────────────────────────────────────────── */

const press = (cdp, at) =>
  cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: Math.round(at.x),
    y: Math.round(at.y),
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })

const moveTo = (cdp, at) =>
  cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(at.x),
    y: Math.round(at.y),
    button: 'left',
    buttons: 1,
  })

const release = (cdp, at) =>
  cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: Math.round(at.x),
    y: Math.round(at.y),
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })

/** 松手 + 等一拍让落定跑完(要量收笔那 150ms 的用例**不用**这一只)。 */
async function releaseAt(cdp, at) {
  await release(cdp, at)
  await delay(240)
}

/**
 * **一段不停顿的指针路径**(这道门的核心量法,见文件头)。
 *
 * 从 `from` 走到 `to`,途中每一步都真的到达 blink;`sample` 给了的话,**在两发
 * move 之间**跑一次 —— 手还在动,读到的就是「一直在动的时候屏幕上真有的东西」。
 * 走完之后**不停**:继续以 1px 的幅度**横向**来回微动(竖向一动就可能跨带),
 * 一边微动一边再采几次,直到 `holdMs` 走完。
 *
 * 答的是采样表(按次序)。`release: false` 时手指还按着,由调用方自己收。
 */
async function stroke(cdp, from, to, opts = {}) {
  const { steps = 10, sample, holdMs = 0, release: shouldRelease = false, stepDelay = 12 } = opts
  const seen = []
  const take = async () => {
    if (!sample) return
    seen.push(await sample())
  }
  await press(cdp, from)
  for (let i = 1; i <= steps; i += 1) {
    await moveTo(cdp, {
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    })
    await delay(stepDelay)
    if (i >= steps - 1) await take()
  }
  // **一直在动**:1px 的来回,采样夹在两发 move 之间。
  const deadline = Date.now() + holdMs
  let flip = 0
  while (Date.now() < deadline) {
    flip = 1 - flip
    await moveTo(cdp, { x: to.x + flip, y: to.y })
    await delay(16)
    await take()
  }
  if (shouldRelease) await releaseAt(cdp, to)
  return seen
}

/** 已经按着了,再走一段(同样不停顿)。 */
async function strokeOn(cdp, from, to, opts = {}) {
  const { steps = 8, stepDelay = 12 } = opts
  for (let i = 1; i <= steps; i += 1) {
    await moveTo(cdp, {
      x: from.x + ((to.x - from.x) * i) / steps,
      y: from.y + ((to.y - from.y) * i) / steps,
    })
    await delay(stepDelay)
  }
}

/** 一发**非主键**的按下松开(右键 2 / 中键 1)。右键那一发同时是 contextmenu 的来源。 */
async function altClick(cdp, at, button) {
  const buttons = button === 'right' ? 2 : 4
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: Math.round(at.x), y: Math.round(at.y), button, buttons, clickCount: 1,
  })
  await delay(40)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: Math.round(at.x), y: Math.round(at.y), button, buttons: 0, clickCount: 1,
  })
  await delay(260)
}

/** 此刻屏幕上开着的那张菜单里的文案(没开就是空表)。 */
function menuItemsNow(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')).map((el) =>
      (el.textContent ?? '').trim(),
    ),
  )
}

/**
 * **菜单开着才按 Esc**。这道门的夹具里一直开着一扇总览浮窗(场景 ⑤ 要它),
 * 而一发没人接的 Esc 会沿响应链一路退到那扇窗上把它关掉 —— 门第一版就是这样
 * 把 ⑤⑥⑦ 一起带红的。
 */
async function closeMenuIfOpen(page) {
  if ((await menuItemsNow(page)).length === 0) return
  await page.keyboard.press('Escape')
  await delay(260)
}

/** 按文案点菜单里那一项;点不到就答 false(并把菜单收掉,免得挡住后面的场景)。 */
async function clickMenuItem(page, re) {
  const hit = await page.evaluate((source) => {
    const rx = new RegExp(source)
    const el = Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]'))
      .find((node) => rx.test((node.textContent ?? '').trim()))
    if (el instanceof HTMLElement && el.getAttribute('aria-disabled') !== 'true') {
      el.click()
      return true
    }
    return false
  }, re.source)
  await delay(400)
  // 点不着也**不**自己按 Esc:那一发会顺手关掉夹具那扇浮窗(判词在 `closeMenuIfOpen`)。
  if (!hit) await closeMenuIfOpen(page)
  return hit
}

/**
 * **把活动那一格与它右边那格并成两格**,走的是**动作单产地**那张右键菜单
 * (`workbench.pairRight`),不是拖拽。
 *
 * U2 之前这件事在门里走的是「压到条底缘下 6–24px 再松手」那条路;那一档删掉之后,
 * 拖拽这一头的二合一只剩「拖到内容区左右带」,而内容区此刻被总览那扇浮窗盖着一段
 * (场景 ⑤ 为此专门挑点)。这里要的只是**一格两格标签**这个前置条件,不是二合一
 * 本身的手感,所以走菜单那一口 —— 它与拖拽落定调的是同一只 `pairIntoIndex`
 * (`LeafActions` 上的判词:三条路一个产地)。
 */
async function pairActiveRight(page, cdp, tab) {
  /*
   * **先真的激活那一格**:那张表作用在**活动**标签上(`LeafActions` 的
   * `leaf.tabs[leaf.active + 1]`),而 U2 之后右键**不再顺手激活** —— 所以这里
   * 补一次纯点击(按下松开、位移 0)。这一句本身也是 U2 那条裁定的注脚:
   * 「右键开的是哪一格的表」今天由活动位说了算,不由右键落在谁身上说了算。
   */
  await press(cdp, { x: tab.cx, y: tab.cy })
  await releaseAt(cdp, { x: tab.cx, y: tab.cy })
  await altClick(cdp, { x: tab.cx, y: tab.cy }, 'right')
  await clickMenuItem(page, /二合一|Join with the tab on the right/)
  /*
   * 答的是**结果**而不是「点着了没有」:菜单项禁灰时点一下什么也不会发生。
   * 而且问的是**活动那一格现在是不是两格** —— 不是「条上有没有 pair」:条上早就
   * 可能有一格别的场景并出来的两格标签,拿它当读数是一次假绿(门第三版当场量到:
   * 右邻本身就是一格两格标签,`canPairRight` 禁灰、这一下什么都没发生,而断言看着
   * 上一场留下的那一格答了「并成了」,红留给了下一步「杆够不着」)。
   */
  return page.evaluate(() =>
    String(
      document.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('data-tab-id') ?? '',
    ).startsWith('pair:'),
  )
}

/**
 * 条上第一格「自己与右邻都是普通标签」的下标 —— 那才是**并得起来**的一对
 * (两格的标签不能再并,§6 末行)。没有就答 -1。
 */
function firstPairableAt(tabs) {
  return tabs.findIndex(
    (t, i) =>
      !String(t.id).startsWith('pair:')
      && i + 1 < tabs.length
      && !String(tabs[i + 1].id).startsWith('pair:'),
  )
}

/**
 * 右键一块 Dock 瓦,按菜单文案选一种打开方式(照 `gate-focus.openAsFromDockMenu`)。
 * 走的是**用户真走的那条路**,不去改 store。
 */
async function openAsFromDockMenu(page, tile, labelRe) {
  const opened = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="dock-tile-${id}"]`)
    if (!(el instanceof HTMLElement)) return false
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))
    return true
  }, tile)
  if (!opened) return false
  await delay(350)
  const picked = await page.evaluate((source) => {
    const re = new RegExp(source)
    const items = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'))
    const hit = items.find((el) => re.test(el.textContent ?? ''))
    if (hit instanceof HTMLElement) {
      hit.click()
      return true
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return false
  }, labelRe.source)
  await delay(600)
  return picked
}

async function clickSelector(page, selector) {
  const clicked = await page.evaluate((css) => {
    const el = document.querySelector(css)
    if (!el) return false
    el.click()
    return true
  }, selector)
  if (!clicked) throw new Error(`点不到:${selector} 不在 DOM 里`)
}

/** 一个选择器此刻的矩形中心(视口坐标 —— CDP 要的就是这个坐标系)。 */
function centerOf(page, selector) {
  return page.evaluate((css) => {
    const el = document.querySelector(css)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      rect: {
        left: Math.round(r.left), top: Math.round(r.top),
        width: Math.round(r.width), height: Math.round(r.height),
      },
    }
  }, selector)
}

/** 拼贴台此刻的形状 —— 断言「树前后逐字相同」读的就是它。 */
function treeShape(page) {
  return page.evaluate(() =>
    JSON.stringify(
      Object.fromEntries(
        Array.from(document.querySelectorAll('[data-pane-region]')).map((host) => [
          host.getAttribute('data-pane-region'),
          Array.from(host.querySelectorAll('[data-pane-slot]')).map((slot) => ({
            leaf: slot.getAttribute('data-pane-slot'),
            tabs: Array.from(slot.querySelectorAll('[data-pane-tab]')).map((t) =>
              t.getAttribute('data-pane-tab'),
            ),
          })),
        ]),
      ),
    ),
  )
}

/**
 * 给一批节点打上一格**身份戳**,搬完之后再问「还是不是同一个」。
 *
 * 零重挂断言的唯一诚实判法(CLAUDE.md:「前后是同一个 DOM 节点」)—— 属性会跟着
 * 重挂一起没,所以戳还在 = 那个节点从头到尾就是它。
 */
async function stamp(page, selector, mark) {
  return page.evaluate(
    ([css, m]) => {
      const el = document.querySelector(css)
      if (!el) return false
      el.setAttribute('data-gate-stamp', m)
      return true
    },
    [selector, mark],
  )
}

function stampSurvives(page, selector, mark) {
  return page.evaluate(
    ([css, m]) => document.querySelector(css)?.getAttribute('data-gate-stamp') === m,
    [selector, mark],
  )
}

/** refId 里有 `:` 与路径分隔符,直接塞进选择器会当场语法错。 */
const cssEscape = (value) => String(value).replace(/["\\]/g, '\\$&')

/**
 * **这一帧屏幕上的拖拽反馈是什么**(这道门的主读数)。
 *
 * 一次 `evaluate` 把七样一起取回来:提示行的字、空位的宽、描圈在哪一格、
 * 落区的形与矩形、氛围有几块、根上那格拒绝光标。分七次取的话它们来自七个不同的
 * 时刻 —— 而这道门量的正是「同一帧里这几样对不对得上」。
 */
function feedbackNow(page) {
  return page.evaluate(() => {
    const hint = document.querySelector('[data-testid="drag-hint"]')
    const ph = document.querySelector('[data-tab-placeholder]')
    const hot = document.querySelector('[data-pair-hot]')
    const band = document.querySelector('[data-testid="drop-overlay"]')
    const ghost = document.querySelector('[data-testid="drag-ghost"]')
    const bandRect = band?.getBoundingClientRect()
    return {
      hint: (hint?.textContent ?? '').trim(),
      ghost: Boolean(ghost),
      card: Boolean(document.querySelector('[data-testid="drag-ghost-card"]')),
      refused: ghost?.hasAttribute('data-refuse') ?? false,
      cursorRefuse: document.documentElement.hasAttribute('data-drag-refuse'),
      gapWidth: ph ? Math.round(ph.getBoundingClientRect().width) : null,
      pairHot: hot?.getAttribute('data-tab-id') ?? null,
      shape: band?.getAttribute('data-shape') ?? null,
      bandRect: bandRect
        ? { left: Math.round(bandRect.left), width: Math.round(bandRect.width) }
        : null,
      /*
       * **氛围层随 U1 退役**(用户报障「一拖整窗变色」)。这一格留着不是遗迹:
       * 它是那次退役的**读数** —— 场景 ⑤ 断言它恒为 0,谁把整窗淡亮种回来当场红。
       */
      ambient: document.querySelectorAll('[data-testid="drop-ambient"]').length,
    }
  })
}

/**
 * **一趟扫过去再扫回来,那格空位是不是同一个元素**(U1 场景 ①)。
 *
 * 病历(用户 09-08 真机):从会话行拖到顶栏标签的正中会闪 —— 病根是那条条上
 * 从前有**两种**落点按 28% 线交替(正中描圈 / 两侧空位),每交替一次宿主就
 * `clearGap()` 删掉占位再插一个新的,新占位的宽度从 0 起动画,右侧标签整排
 * 跳一格宽。三个来回量到 18 次 DOM 变动。
 *
 * 所以这道门量的不是「屏幕上有没有空位」(那一条 W6-b 就有了),是**那格空位
 * 在整趟扫描里换没换过身**:
 *   `distinct`     被插进这条条的占位**元素**有几个 —— 只许 1
 *   `zeroRestarts` 「宽度从 0 重新起动」发生了几次 —— 只许 ≤ 1(头一次插进来
 *                  那一发是正当的:`gapAt` 故意先 0 宽落地再写真宽,好让宽度过渡
 *                  有起点。第二次就是「重建」)
 *   `pairHot`      有几次给某一格描了圈 —— U1 之后从外面拖进来一次都不该有
 *
 * 读法是 MutationObserver 而不是逐帧快照:重建发生在两帧之间,快照量不到。
 * 断开之前先 `takeRecords()` 走一遍回调 —— 回调是微任务,最后那几条不这样会漏。
 */
function startGapProbe(page, leafId) {
  return page.evaluate((want) => {
    const list = document.querySelector(
      `[data-pane-chrome="${want.replace(/["\\]/g, '\\$&')}"] [role="tablist"]`,
    )
    if (!list) return false
    const state = { adds: 0, distinct: 0, zeroRestarts: 0, pairHot: 0 }
    const seen = new Set()
    const handle = (records) => {
      for (const r of records) {
        if (r.type === 'childList') {
          for (const node of Array.from(r.addedNodes)) {
            if (node.nodeType !== 1 || !node.hasAttribute('data-tab-placeholder')) continue
            state.adds += 1
            seen.add(node)
            state.distinct = seen.size
          }
          continue
        }
        if (r.attributeName === 'data-pair-hot' && r.target.hasAttribute('data-pair-hot')) {
          state.pairHot += 1
        }
        if (
          r.attributeName === 'style'
          && r.target.hasAttribute('data-tab-placeholder')
          && String(r.oldValue ?? '').includes('width: 0px')
        ) {
          state.zeroRestarts += 1
        }
      }
    }
    const obs = new MutationObserver(handle)
    obs.observe(list, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ['style', 'data-pair-hot'],
    })
    window.__gapProbe = {
      state,
      stop: () => {
        handle(obs.takeRecords())
        obs.disconnect()
        return state
      },
    }
    return true
  }, leafId)
}

function readGapProbe(page) {
  return page.evaluate(() => window.__gapProbe?.stop() ?? null)
}

/** 一条条此刻的次序 + 那几格拖拽属性。 */
function stripOrder(page, leafId) {
  return page.evaluate((want) => {
    const root = document.querySelector(
      `[data-pane-chrome="${want.replace(/["\\]/g, '\\$&')}"] [role="tablist"]`,
    )
    return Array.from(root?.querySelectorAll('[role="tab"]') ?? []).map((el) => ({
      id: el.getAttribute('data-tab-id'),
      on: el.getAttribute('aria-selected') === 'true',
      lift: el.hasAttribute('data-lift'),
      torn: el.hasAttribute('data-torn'),
      settle: el.hasAttribute('data-settle'),
      shift: el.style.transform || '',
    }))
  }, leafId)
}

/**
 * **同一帧里的「反馈 + 让位」**(场景 ④ 那条「停 1s 不误并」读的就是它)。
 *
 * 分两次 `evaluate` 取的话,提示行来自一刻、让位来自另一刻 —— 而这一条断言的
 * 正是「这两样在同一帧里同时是什么」(仍在换序 ∧ 没有描圈 ∧ 没有提示行)。
 */
function stripProbe(page, leafId) {
  return page.evaluate((want) => {
    const root = document.querySelector(
      `[data-pane-chrome="${want.replace(/["\\]/g, '\\$&')}"] [role="tablist"]`,
    )
    const hint = document.querySelector('[data-testid="drag-hint"]')
    const hot = document.querySelector('[data-pair-hot]')
    return {
      hint: (hint?.textContent ?? '').trim(),
      pairHot: hot?.getAttribute('data-tab-id') ?? null,
      card: Boolean(document.querySelector('[data-testid="drag-ghost-card"]')),
      cursorRefuse: document.documentElement.hasAttribute('data-drag-refuse'),
      shifts: Object.fromEntries(
        Array.from(root?.querySelectorAll('[role="tab"]') ?? []).map((el) => [
          el.getAttribute('data-tab-id'),
          el.hasAttribute('data-lift') ? 'LIFTED' : el.style.transform || '',
        ]),
      ),
    }
  }, leafId)
}

/**
 * **三处底色**(§4.5 第 2 条那条断言读的就是它):标签条自己、每一格标签、
 * 内容区。答的是一串字符串 —— 「逐字不变」这句话只有逐字比较才算数。
 */
function palette(page, leafId) {
  return page.evaluate((want) => {
    const chrome = document.querySelector(
      `[data-pane-chrome="${want.replace(/["\\]/g, '\\$&')}"]`,
    )
    const list = chrome?.querySelector('[role="tablist"]')
    const body = document.querySelector('[data-pane-region="center"] [data-pane-body]')
    return {
      strip: list ? getComputedStyle(list).backgroundColor : null,
      body: body ? getComputedStyle(body).backgroundColor : null,
      tabs: Array.from(list?.querySelectorAll('[role="tab"]') ?? []).map((el) => ({
        id: el.getAttribute('data-tab-id'),
        bg: getComputedStyle(el).backgroundColor,
      })),
    }
  }, leafId)
}

/**
 * 给一个 x,在**中央那片叶**里找一个 y,使这一点不被任何浮窗或拒绝区盖住。
 *
 * 与场景 ⑤ 那只 `pointIn` 同一条判词,只是横坐标由调用方点名(场景 ⑨ 要站在
 * 「离右缘 6px」这种精确的地方,不是一个比例)。**顺带避开 `[data-nodrop]`**:
 * Dock 与顶栏那两块自述不收,站上去量到的是拒绝态,而那不是这几条要问的事。
 */
function freePointAt(page, x) {
  return page.evaluate((wantX) => {
    const slot = document.querySelector('[data-pane-region="center"] [data-pane-slot]')
    if (!slot) return null
    const r = slot.getBoundingClientRect()
    const blockers = [
      ...Array.from(document.querySelectorAll('[data-float-body]')).map((el) =>
        (el.closest('[role="dialog"]') ?? el).getBoundingClientRect(),
      ),
      ...Array.from(document.querySelectorAll('[data-nodrop]')).map((el) => el.getBoundingClientRect()),
    ]
    for (const t of [0.5, 0.72, 0.86, 0.3, 0.2, 0.94]) {
      const y = Math.round(r.top + r.height * t)
      if (!blockers.some((b) => wantX >= b.left && wantX <= b.right && y >= b.top && y <= b.bottom)) {
        return { x: Math.round(wantX), y }
      }
    }
    return null
  }, x)
}

/** 顶栏那条**标签带**(不是 tablist):它的右缘就是顶栏尾格的左缘。 */
function topBand(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="topbar-tabs"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: Math.round(r.left), right: Math.round(r.right) }
  })
}

/** 此刻屏幕上有哪几条架子(判据读的是同一格 `data-shelf`)。 */
function shelvesNow(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-shelf]')).map((el) => el.getAttribute('data-shelf')),
  )
}

/**
 * **顶栏那条条上一个「底下没有别的条」的 x**(U2)。
 *
 * 架子那条檐从 y≈44 起,而顶栏那条条的下沿外扩正好 24px —— 两者在屏幕上是叠着的,
 * 而且左架子横向占 [0, ~343],顶栏标签也从 80 起排。U2 之后**指针真的落在别人那条
 * 条上时自己的外扩让开**(那正是场景 ⑩ 要的),所以凡是要量「条底缘下这一片仍是
 * 换序」的站点,横坐标必须先躲开每一条架子条的跨度 —— 不躲的话量到的是场景 ⑩ 那
 * 一形,而那是**另一条断言**的地。
 *
 * 挑法:先试给的那几个候选(通常是几格标签的中心),都被盖住就在条的矩形里从右往左
 * 找。找不到答 null(调用方自己判 —— 那说明这台夹具上没有可量的地方)。
 */
async function clearOfShelvesX(page, strip, candidates = []) {
  const spans = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-shelf] [data-pane-chrome] [role="tablist"]')).map((el) => {
      const r = el.getBoundingClientRect()
      return { left: Math.round(r.left), right: Math.round(r.left + r.width) }
    }),
  )
  const free = (x) => !spans.some((sp) => x >= sp.left && x <= sp.right)
  for (const x of candidates) {
    if (Number.isFinite(x) && free(x)) return Math.round(x)
  }
  const right = strip.rect.left + strip.rect.width
  for (let x = right - 8; x > strip.rect.left; x -= 8) {
    if (free(x)) return Math.round(x)
  }
  return null
}

/**
 * **某一条架子上那条标签条**(U2 场景 ⑩)。与 `topStrip` 同形,只是宿主换成
 * `[data-shelf="<side>"]` —— 场景 ⑩ 要站在「它的上半截」上量,而那一片正好落在
 * 顶栏那条条的 24px 下沿外扩里。
 */
function shelfStrip(page, side) {
  return page.evaluate((want) => {
    const chrome = document.querySelector(`[data-shelf="${want}"] [data-pane-chrome]`)
    const list = chrome?.querySelector('[role="tablist"]')
    if (!chrome || !list) return null
    const r = list.getBoundingClientRect()
    return {
      leafId: chrome.getAttribute('data-pane-chrome'),
      rect: {
        left: Math.round(r.left), top: Math.round(r.top),
        width: Math.round(r.width), height: Math.round(r.height),
      },
      tabs: Array.from(list.querySelectorAll('[data-tab-id]')).map((el) => {
        const box = el.getBoundingClientRect()
        return { id: el.getAttribute('data-tab-id'), left: Math.round(box.left), width: Math.round(box.width) }
      }),
    }
  }, side)
}

/** 顶栏那条条(中央区那片叶)。这一串场景几乎都在它身上量。 */
function topStrip(page) {
  return page.evaluate(() => {
    const chrome = document.querySelector('[data-testid="topbar-tabs"] [data-pane-chrome]')
      ?? document.querySelector('[data-pane-chrome]')
    const list = chrome?.querySelector('[role="tablist"]')
    if (!chrome || !list) return null
    return {
      leafId: chrome.getAttribute('data-pane-chrome'),
      rect: (() => {
        const r = list.getBoundingClientRect()
        return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
      })(),
      tabs: Array.from(list.querySelectorAll('[data-tab-id]')).map((el) => {
        const r = el.getBoundingClientRect()
        return {
          id: el.getAttribute('data-tab-id'),
          left: Math.round(r.left), width: Math.round(r.width),
          cx: Math.round(r.left + r.width / 2),
          cy: Math.round(r.top + r.height / 2),
          /*
           * **这一格摘不摘得走**(U3)。屏幕上那颗 ✕ 就是 `canDetachTab` 的读数
           * (「一颗按不动的 ✕ 与『按了没反应』在屏幕上是同一件事」),而 U3 之后
           * 它同时是「撕得走吗」的读数 —— 中央区最后一格常驻内容两样都不行。
           * 凡是要拿一格标签当**拖拽来源**去量别的事的场景,靶子都得先问这一格:
           * 挑到那一格反而会量成 U3 的拒绝态(场景 ① 第一版就这样红过)。
           */
          closable: Boolean(el.querySelector('[data-tab-close]')),
        }
      }),
    }
  })
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(`[drag-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``)
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[drag-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'drag-gate-store-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'drag-gate-ws-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'drag-gate-userdata-'))
  const cwd = path.join(workspaceRoot, OWNER_UID, OWNER_WID)
  let server
  let app
  try {
    console.log('[1/3] 造一棵真目录树 + 一台 core')
    await mkdir(cwd, { recursive: true })
    await writeFile(path.join(cwd, 'alpha.ts'), 'export const alpha = 1\n')
    await writeFile(path.join(cwd, 'beta.ts'), 'export const beta = 2\n')
    await writeFile(path.join(cwd, 'gamma.ts'), 'export const gamma = 3\n')
    /*
     * 第四份**故意不开**:场景 ① 扫条时拖的就是它。
     * 拖一格**已经开着**的内容时,它自己那一格标签的正中会落进「被拖的自己除外」
     * 那条判据(设计 §2.3 不变量 3:拖回自己身上不是一次并)—— 门第一版拖的是
     * alpha.ts 而条上恰好开着 alpha.ts,读数是那一站答 `strip` 而不是 `pairTab`,
     * **判据是对的,门的预期是错的**。换一格没开着的就没有这个交叉。
     */
    await writeFile(path.join(cwd, 'delta.ts'), 'export const delta = 4\n')

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
    server.stderr.on('data', (chunk) => serverErr.push(chunk.toString()))
    const record = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    }).catch((error) => {
      throw new Error(`${error.message}\nserver stderr:\n${serverErr.join('')}`)
    })
    if (!(await portConnects(record.host, record.port))) throw new Error('core 端口连不上')

    const created = await rpc(record, 'sessions', 'create', { name: 'drag-gate' })
    const sessionId = created?.session?.id
    if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(created)}`)
    await rpc(record, 'sessions', 'updateWorkingDirectory', { sessionId, workingDirectory: cwd })
    // 场景 ① 的第三种来源:另一条会话(拖当前那一条等于什么都没换)。
    await rpc(record, 'sessions', 'create', { name: 'drag-gate-2' })

    console.log('[2/3] 拉起应用(离屏 · 独立 --user-data-dir)')
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
    await waitFor('Dock 就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid^="dock-tile"]'))),
    )

    /*
     * **夹具**:总览开成一扇浮窗(场景 ⑤ 要它来验「浮窗不接住自己」),文件面板
     * 留在它的出厂摆法左架子(W6-a §8)。两块面落进同一条架子就会成为同一条标签
     * 条的两格,后面那一格 `content-visibility: hidden` —— 行拖不起来。
     */
    await openAsFromDockMenu(page, 'sessions', /^(Float|浮窗)$/)
    await waitFor('总览画出那一行', () =>
      page.evaluate((id) => Boolean(document.querySelector(`[data-session-id="${id}"]`)), sessionId),
    )
    await clickSelector(page, `[data-testid="session-row-${sessionId}"]`)
    await clickSelector(page, '[data-testid="dock-tile-files"]')
    await waitFor('文件树画出行', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-file-path]'))),
    )
    const pinnedLeft = await page.evaluate(() =>
      Boolean(document.querySelector('[data-shelf="left"] [data-testid="files-panel"]')),
    )
    await delay(400)

    /**
     * 把中央那条条补到 n 格(用户真走的路:单击文件行 = 开一格标签)。
     *
     * `singles` 数的是**普通标签**:前面的场景会并出两格的那一种,而
     * 「找两格来并」「找一格来换序」问的都是普通标签 —— 拿总数当条件的话,
     * 一条全是两格标签的条会被当成够用的(真机门第一版就是这样红的)。
     */
    const fillStrip = async (n, { singles = false } = {}) => {
      const count = (strip) =>
        singles ? strip.tabs.filter((t) => !t.id.startsWith('pair:')).length : strip.tabs.length
      for (const name of ['alpha.ts', 'beta.ts', 'gamma.ts']) {
        const strip = await topStrip(page)
        if (strip && count(strip) >= n) break
        const row = `[data-file-path="${path.join(cwd, name)}"]`
        if (!(await page.evaluate((css) => Boolean(document.querySelector(css)), row))) continue
        await clickSelector(page, row)
        await delay(320)
      }
      await delay(200)
      return topStrip(page)
    }

    console.log('[3/3] 逐个场景')

    /* ══ 场景 ①:三种来源 × 标签条上每一个位置 ══════════════════════════ */
    scenario('三种来源拖到标签条的每个位置:一律是空位、提示非空,占位从头到尾同一个节点')
    {
      assert(pinnedLeft, '文件面板在左架子上(出厂摆法,W6-a §8)')
      const strip = await fillStrip(3)
      assert(strip && strip.tabs.length >= 3, '中央那条条上有三格', JSON.stringify(strip?.tabs.map((t) => t.id)))

      /**
       * 一种来源走一趟:落在每一格的正中、每两格之间,各采一次读数;
       * 走到末格再**原路扫回来**,全程挂着 `startGapProbe`。
       *
       * **U1 起每一站要的都是空位**(从前正中那几站要的是描圈):条上只剩一种
       * 落点。这句话的读数不只是「每一站有空位」——`gapProbe` 那三格数才是它的
       * 硬证:占位从头到尾是同一个元素、宽度只从 0 起动过一次、`data-pair-hot`
       * 零次。反证:把 `pairTab` 那一档种回判据,`distinct` 当场变成一串,
       * `zeroRestarts` 与 `pairHot` 同时不为 0。
       */
      const sweep = async (label, from) => {
        const now = await topStrip(page)
        const stops = []
        now.tabs.forEach((tab, i) => {
          stops.push({ where: `第 ${i} 格正中`, at: { x: tab.cx, y: tab.cy } })
          stops.push({ where: `第 ${i} 格左缘`, at: { x: tab.left + 3, y: tab.cy } })
        })
        stops.push({
          where: '末格之后的空白',
          at: { x: now.rect.left + now.rect.width - 8, y: now.tabs[0].cy },
        })
        // **一趟走完,中间一次都不松手**:按下之后一路扫过去,每一站采一次。
        await press(cdp, from)
        await strokeOn(cdp, from, stops[0].at, { steps: 6 })
        /*
         * 探针**在到位之后才开**:从来源走到条上这一段里,落点会依次经过架子的叶、
         * 边带、中央叶……占位本来就该跟着建了又收。那几下不是「重建」,是落点真的
         * 换了类。要量的是**停在同一条条上来回走**时它换不换身。
         */
        const probeOn = await startGapProbe(page, now.leafId)
        assert(probeOn, `${label}:MutationObserver 挂上了那条条`)
        const seen = []
        let at = stops[0].at
        for (const stop of stops) {
          await strokeOn(cdp, at, stop.at, { steps: 4 })
          at = stop.at
          // 微动一下再读 —— 手停住的那一帧不算数(见文件头的量法)。
          await moveTo(cdp, { x: stop.at.x + 1, y: stop.at.y })
          await delay(24)
          seen.push({ ...stop, read: await feedbackNow(page) })
        }
        // **再扫回来**:同一条条上从末格走回第 1 格,一次都不松手。
        for (let i = stops.length - 2; i >= 0; i -= 1) {
          await strokeOn(cdp, at, stops[i].at, { steps: 4 })
          at = stops[i].at
          await moveTo(cdp, { x: stops[i].at.x + 1, y: stops[i].at.y })
          await delay(20)
          seen.push({ ...stops[i], where: `${stops[i].where}(回程)`, read: await feedbackNow(page) })
        }
        const probe = await readGapProbe(page)
        /*
         * **走完一趟一律 Esc 取消**:这一条量的是「过程里屏幕上有没有东西」,
         * 落定与它无关 —— 而真落一次会把夹具改掉(总览那扇浮窗盖在中央区上,
         * 松手在那儿等于把这一格丢进总览),后面几条当场没有对象可量。
         */
        await page.keyboard.press('Escape')
        await releaseAt(cdp, at)
        const missing = seen.filter((row) => !((row.read.gapWidth ?? 0) > 0))
        const blank = seen.filter((row) => row.read.hint === '')
        assert(
          missing.length === 0,
          `${label}:每一站(去程 + 回程)都是一格空位 —— 条上不再有第二种落点`,
          missing.length ? missing.map((r) => `${r.where}=${JSON.stringify(r.read)}`).join(' | ') : `${seen.length} 站`,
        )
        assert(
          blank.length === 0,
          `${label}:每一站浮影下那行字都非空`,
          blank.length ? blank.map((r) => r.where).join(' | ') : seen.map((r) => r.read.hint).join(' / '),
        )
        assert(
          probe !== null && probe.distinct === 1,
          `${label}:整趟只有**一个**占位元素(它只被 insertBefore 挪位,不重建)`,
          JSON.stringify(probe),
        )
        assert(
          probe !== null && probe.zeroRestarts <= 1,
          `${label}:占位的宽度从不回到 0 重新起动(头一发落地那次除外)`,
          JSON.stringify(probe),
        )
        assert(
          probe !== null && probe.pairHot === 0,
          `${label}:整趟 data-pair-hot 一次都没有(外来来源不再描圈)`,
          JSON.stringify(probe),
        )
      }

      const fileRow = await centerOf(page, `[data-file-path="${path.join(cwd, 'delta.ts')}"]`)
      if (fileRow) await sweep('文件行', fileRow)
      else assert(false, '文件行量得到')

      // 总览是一扇浮窗,前面那一趟可能把它挤到了后面 —— 点一下瓦把它叫回前台。
      await clickSelector(page, '[data-testid="dock-tile-sessions"]')
      await delay(500)
      await waitFor('总览就位', () =>
        page.evaluate(() => Boolean(document.querySelector('[data-session-id]'))),
      ).catch(() => {})
      const sessionRow = await centerOf(page, '[data-session-id]:not([aria-selected="true"])')
      if (sessionRow) await sweep('会话行', sessionRow)
      else assert(false, '总览里有另一条会话可拖')

      /*
       * **标签这一种来源扫的是「别人那条条」**(设计 §4.2 / §5)。
       *
       * 回到**自己**那条条的带里是**换序** —— 那一形的预示是那几格 tab 自己在动,
       * 浮影与空位一个节点都不画(裁定 4)。门第一版把它当成「没反应」红了一次:
       * 读数 `ghost:false, gapWidth:null` 恰恰是那条裁定在正确工作。
       * 所以这里挑一条**不含被拖那一格**的条(架子上文件面板那条)去扫。
       */
      const now = await topStrip(page)
      /* **靶子得是一格摘得走的标签**(U3):中央区最后一格常驻内容今天撕出去是
       * 拒绝态,拿它当来源量到的是 U3 那一条,不是这一条(判词在 `topStrip` 的
       * `closable` 上)。 */
      const tabFrom = now?.tabs.find((t) => t.closable) ?? now?.tabs[0]
      const foreign = await page.evaluate((mine) => {
        for (const chrome of Array.from(document.querySelectorAll('[data-pane-chrome]'))) {
          const id = chrome.getAttribute('data-pane-chrome')
          if (id === mine) continue
          const list = chrome.querySelector('[role="tablist"]')
          const r = list?.getBoundingClientRect()
          if (!r || r.width <= 0 || r.height <= 0) continue
          return { leafId: id, x: Math.round(r.left + 6), y: Math.round(r.top + r.height / 2) }
        }
        return null
      }, now?.leafId ?? '')
      assert(Boolean(foreign), '屏幕上有第二条标签条(架子 / 浮窗那一条)', JSON.stringify(foreign))
      if (tabFrom && foreign) {
        await press(cdp, { x: tabFrom.cx, y: tabFrom.cy })
        // 先往下拉出带(撕下),再走到别人那条条上。
        await strokeOn(cdp, { x: tabFrom.cx, y: tabFrom.cy }, { x: tabFrom.cx, y: tabFrom.cy + 200 }, { steps: 8 })
        const torn = (await stripOrder(page, now.leafId)).some((t) => t.torn)
        assert(torn, '标签:出带之后源那一格折成 0 宽')
        await strokeOn(cdp, { x: tabFrom.cx, y: tabFrom.cy + 200 }, { x: foreign.x, y: foreign.y }, { steps: 10 })
        await moveTo(cdp, { x: foreign.x + 1, y: foreign.y })
        await delay(40)
        const read = await feedbackNow(page)
        assert((read.gapWidth ?? 0) > 0, '标签:落到别人那条条上腾出一格空位(U1 起不再有描圈那一档)', JSON.stringify(read))
        assert(read.hint !== '', '标签:提示行非空', read.hint)
        await page.keyboard.press('Escape')
        await releaseAt(cdp, { x: foreign.x, y: foreign.y })
      }
    }

    /* ══ 场景 ②:按下即切换 / 松手不动无事 / 6px / 出带才撕 ═══════════ */
    scenario('按下即切换(只认主键)、松手不动无事、横向 6px 才浮起、出带才撕下')
    {
      const strip = await fillStrip(3)
      const active = strip.tabs.find((_, i) => i === 0)
      const other = strip.tabs.find((t) => t.id !== active.id)
      const wasOn = (await stripOrder(page, strip.leafId)).find((t) => t.on)?.id
      const target = strip.tabs.find((t) => t.id !== wasOn) ?? other
      await stamp(page, `[data-tab-id="${cssEscape(target.id)}"]`, 'press-node')
      const before = await treeShape(page)

      await press(cdp, { x: target.cx, y: target.cy })
      await delay(60)
      const afterPress = await stripOrder(page, strip.leafId)
      assert(
        afterPress.find((t) => t.on)?.id === target.id,
        '按下那一刻内容就切过去了(不等松手)',
        `${wasOn} → ${afterPress.find((t) => t.on)?.id}`,
      )
      assert(
        await stampSurvives(page, `[data-tab-id="${cssEscape(target.id)}"]`, 'press-node'),
        '**按下前后是同一个 DOM 节点**(条没重建,手里那格还在)',
      )

      // 走 4px:还不是拖(横向门槛 6)。
      await moveTo(cdp, { x: target.cx + 4, y: target.cy })
      await delay(40)
      let read = await stripOrder(page, strip.leafId)
      assert(!read.some((t) => t.lift), `横向 4px 还没浮起(DRAG_START_X=${DRAG_START_X})`, JSON.stringify(read.map((t) => t.lift)))
      // 走到 8px:过了门槛。
      await moveTo(cdp, { x: target.cx + 8, y: target.cy })
      await delay(40)
      read = await stripOrder(page, strip.leafId)
      assert(read.some((t) => t.lift), '横向过 6px 之后那一格浮起来了', JSON.stringify(read.map((t) => `${t.id}:${t.lift}`)))
      assert(
        !(await feedbackNow(page)).ghost,
        '条内换序时**浮影一个节点都不画**(拖的就是标签本身)',
      )

      /*
       * 竖向:带内仍是换序,出了带才折。
       *
       * **横坐标先躲开架子那条条**(U2):条底缘往下那一片正好是左架子檐所在的地,
       * 而 U2 之后指针真的落在别人那条条上时自己的外扩让开 —— 那是场景 ⑩ 的地,
       * 不是这一条要问的事(判词在 `clearOfShelvesX` 上)。
       */
      const downX = (await clearOfShelvesX(page, strip, [target.cx])) ?? target.cx
      await strokeOn(cdp, { x: target.cx + 8, y: target.cy }, { x: downX, y: target.cy }, { steps: 4 })
      await moveTo(cdp, { x: downX, y: target.cy + 20 })
      await delay(40)
      read = await stripOrder(page, strip.leafId)
      assert(!read.some((t) => t.torn), '竖向 20px 还在带里,是换序不是撕下', JSON.stringify(read.map((t) => t.torn)))
      await strokeOn(cdp, { x: downX, y: target.cy + 20 }, { x: downX, y: target.cy + 120 }, { steps: 6 })
      read = await stripOrder(page, strip.leafId)
      assert(read.some((t) => t.torn), '出了带那一格折成 0 宽(元素还在)', JSON.stringify(read.map((t) => `${t.id}:${t.torn}`)))
      assert((await feedbackNow(page)).card, '撕下之后浮影卡片接手')
      await page.keyboard.press('Escape')
      await releaseAt(cdp, { x: downX, y: target.cy + 120 })
      assert((await treeShape(page)) === before, 'Esc 之后树逐字不变')

      // 一次纯点击:按下松开,位移 0。
      const t2 = (await topStrip(page)).tabs[0]
      const beforeClick = await treeShape(page)
      await press(cdp, { x: t2.cx, y: t2.cy })
      await delay(40)
      await releaseAt(cdp, { x: t2.cx, y: t2.cy })
      assert((await treeShape(page)) === beforeClick, '按下松开不动 = 一次点击,树一个字不变')

      /*
       * **只有主键才切**(U2,2026-09-08;W6-c 交卷时那条待拍就此了结)。
       *
       * 从前 `LeafStrip.onTabDown` 对**任何**按钮都 `select` —— 右键一格非活动标签
       * 会先把它切过来再开表,中键也切。Chrome 与 VS Code 都不切:右键是「对这一格
       * 做点什么」,不是「我要看它」;连带激活的代价是用户为了看一眼某格的菜单,
       * 当前那格的内容当场没了。
       *
       * 断的是两半:活动位一个字不变 **且** 菜单真的开着 —— 只断前一半的话,
       * 「右键整个不接了」也会绿,而那是把病治成了另一种病。
       */
      const s6 = await topStrip(page)
      const onNow = (await stripOrder(page, s6.leafId)).find((t) => t.on)?.id
      const idle = s6.tabs.find((t) => t.id !== onNow)
      assert(Boolean(idle), '条上有一格非活动标签可以右键', JSON.stringify({ onNow, tabs: s6.tabs.map((t) => t.id) }))
      if (idle) {
        await altClick(cdp, { x: idle.cx, y: idle.cy }, 'right')
        const items = await menuItemsNow(page)
        assert(
          (await stripOrder(page, s6.leafId)).find((t) => t.on)?.id === onNow,
          '右键按在非活动标签上:活动位一个字不变',
          `${onNow} → ${(await stripOrder(page, s6.leafId)).find((t) => t.on)?.id}`,
        )
        assert(items.length > 0, '而且菜单真的开着(不是把右键整个不接了)', JSON.stringify(items.slice(0, 4)))
        /*
         * **只在菜单真开着的时候按 Esc**:这道门的夹具里还开着一扇总览浮窗
         * (场景 ⑤ 要它),而一发没人接的 Esc 会顺手把它关掉 —— 门第一版就是这样
         * 把后面三个场景一起带红的。收菜单改成「点一下空处」也不行:那一下会落在
         * 某块面上。所以判据是**它在不在**。
         */
        await closeMenuIfOpen(page)

        await altClick(cdp, { x: idle.cx, y: idle.cy }, 'middle')
        assert(
          (await stripOrder(page, s6.leafId)).find((t) => t.on)?.id === onNow,
          '中键按在非活动标签上:活动位同样一个字不变',
          `${onNow} → ${(await stripOrder(page, s6.leafId)).find((t) => t.on)?.id}`,
        )
        assert((await menuItemsNow(page)).length === 0, '中键什么都不开', JSON.stringify(await menuItemsNow(page)))
        await closeMenuIfOpen(page)
      }
      /*
       * **把指针停到条外,再等 hover 那段过渡跑完**:下一个场景的底色基线是「逐字
       * 比较」,而 `.tab` 的底色带一段过渡 —— 指针停在某一格标签上离场的话,基线会
       * 采在淡入淡出的中途,后面每一帧都与它不同(门第一版当场量到:基线那一格是
       * `oklab(… / 0.0064)`,一个正在消失的悬停底)。
       */
      await moveTo(cdp, { x: 8, y: 8 })
      await delay(500)
    }

    /* ══ 场景 ③:换序三处 + 150ms 滑入 + Esc + 底色逐字不变 ═══════════ */
    scenario('换序:最左/最右/中间三处正确;松手 150ms 滑入;Esc 无残留;全程三处底色不变')
    {
      const strip = await fillStrip(3)
      const order0 = (await stripOrder(page, strip.leafId)).map((t) => t.id)
      const first = strip.tabs[0]
      const last = strip.tabs[strip.tabs.length - 1]

      /*
       * **底色基线在「按下之后」量**:按下即激活会把活动那一格的底换成叶的脸
       * (那是 §4.2 第一行在工作,不是换序变色)。§4.5 管的是**换序全程** ——
       * 所以基线取激活之后那一帧,再拿它比整段拖拽里的每一帧。
       */
      await press(cdp, { x: first.cx, y: first.cy })
      await delay(80)
      const base = JSON.stringify(await palette(page, strip.leafId))

      /*
       * **(a) 刚抬起那一帧,邻居一个都不动**(§11 第 3 条的字面)。
       *
       * 它守的是「不把邻居按『拿走被拖那格之后』的位置算」那条裁定:那一版把右边
       * 的邻居整体左移一格宽再比中心,于是**手才走过 6px 的起拖阈值**、屏幕上就先
       * 跳了一下。判据换成「被拖那格朝运动方向的那条边越过邻居中心」之后,静止时
       * 落点恒等于原位,一格 transform 都不写。
       */
      await moveTo(cdp, { x: first.cx + DRAG_START_X + 1, y: first.cy })
      await delay(40)
      const liftFrame = await stripProbe(page, strip.leafId)
      const jumped = Object.entries(liftFrame.shifts).filter(([, v]) => v !== '' && v !== 'LIFTED')
      assert(
        jumped.length === 0,
        `抬起后横向刚走过 ${DRAG_START_X + 1}px:邻居的 transform 一个都不非空`,
        JSON.stringify(liftFrame.shifts),
      )

      const shots = []
      await strokeOn(cdp, { x: first.cx + DRAG_START_X + 1, y: first.cy }, { x: last.cx + last.width / 2 - 4, y: first.cy }, { steps: 12 })
      for (let i = 0; i < 4; i += 1) {
        await moveTo(cdp, { x: last.cx + last.width / 2 - 4 - i, y: first.cy })
        await delay(20)
        shots.push(JSON.stringify(await palette(page, strip.leafId)))
      }
      /*
       * **抬起那一格不放大、不改形**(§4.2 / §4.5 第 2 条)。与底色那一条一起,
       * 它们是反证二(「lift 加回 scale / 换底色」)咬得住的两条。
       * 量的是**合成矩阵的两个缩放分量**与那一格的身量:横向位移随手走,
       * 缩放与宽高一个像素都不许动。
       */
      const shape = await page.evaluate(() => {
        const el = document.querySelector('[data-lift]')
        if (!el) return null
        const m = new DOMMatrixReadOnly(getComputedStyle(el).transform)
        const r = el.getBoundingClientRect()
        return { a: m.a, d: m.d, w: Math.round(r.width), h: Math.round(r.height),
          radius: getComputedStyle(el).borderTopLeftRadius }
      })
      assert(Boolean(shape), '抬起那一格在场', JSON.stringify(shape))
      assert(
        shape && shape.a === 1 && shape.d === 1,
        '抬起那一格**不放大**(合成矩阵的两个缩放分量恒为 1)',
        JSON.stringify(shape && { a: shape.a, d: shape.d }),
      )
      assert(
        shape && shape.w === Math.round(first.width) && shape.h > 0,
        '抬起那一格**身量一个像素不变**',
        JSON.stringify({ now: shape?.w, was: Math.round(first.width) }),
      )

      const drift = shots.filter((shot) => shot !== base)
      assert(
        drift.length === 0,
        '换序全程标签条 / 内容区 / 其它标签三处底色**逐字不变**',
        drift.length ? `基线 ${base}\n     漂了 ${drift[0]}` : `${shots.length} 帧全同`,
      )

      // 松手,**不等** —— 收笔那 150ms 要当场量。
      await release(cdp, { x: last.cx + last.width / 2 - 4, y: first.cy })
      let settleRead = null
      const deadline = Date.now() + SETTLE_MS + 120
      while (Date.now() < deadline) {
        const row = await page.evaluate(() => {
          const el = document.querySelector('[data-settle]')
          if (!el) return null
          const style = getComputedStyle(el)
          return {
            id: el.getAttribute('data-tab-id'),
            transition: style.transitionProperty + ' ' + style.transitionDuration,
            transform: style.transform,
          }
        })
        if (row) {
          settleRead = row
          break
        }
        await delay(12)
      }
      assert(Boolean(settleRead), '松手之后那一格挂上了收笔态(data-settle)', JSON.stringify(settleRead))
      assert(
        settleRead && /transform/.test(settleRead.transition) && /0\.15s|150ms/.test(settleRead.transition),
        `收笔是一段 ${SETTLE_MS}ms 的位移过渡`,
        settleRead?.transition,
      )
      assert(
        settleRead && settleRead.transform !== 'none' && !/matrix\(1, 0, 0, 1, 0, 0\)/.test(settleRead.transform),
        '而且起始位移非零(它真的从手上那个位置滑过来)',
        settleRead?.transform,
      )
      await delay(SETTLE_MS + 240)

      const order1 = (await stripOrder(page, strip.leafId)).map((t) => t.id)
      assert(order1[order1.length - 1] === order0[0], '拖到最右:它排到了末尾', `${order0.join(' | ')} → ${order1.join(' | ')}`)
      assert(
        (await stripOrder(page, strip.leafId)).find((t) => t.on)?.id === order0[0],
        '而且活动位跟着它走',
      )

      // 最左。
      const nowStrip = await topStrip(page)
      const src = nowStrip.tabs[nowStrip.tabs.length - 1]
      await stroke(cdp, { x: src.cx, y: src.cy }, { x: nowStrip.tabs[0].left + 3, y: src.cy }, { steps: 12, release: true })
      await delay(SETTLE_MS + 200)
      const order2 = (await stripOrder(page, strip.leafId)).map((t) => t.id)
      assert(order2[0] === order1[order1.length - 1], '拖到最左:它排到了第一位', `${order1.join(' | ')} → ${order2.join(' | ')}`)

      // 中间。
      const s3 = await topStrip(page)
      const mover = s3.tabs[0]
      await stroke(cdp, { x: mover.cx, y: mover.cy }, { x: s3.tabs[1].cx + s3.tabs[1].width / 2 - 2, y: mover.cy }, { steps: 12, release: true })
      await delay(SETTLE_MS + 200)
      const order3 = (await stripOrder(page, strip.leafId)).map((t) => t.id)
      assert(order3[1] === order2[0], '拖到中间:它排到了第二位', `${order2.join(' | ')} → ${order3.join(' | ')}`)

      /*
       * **取消那三条路:顺序不变、无残留,而且都是一段 150ms 的滑回**(U2)。
       *
       * 设计 §4.2 末行写的就是「任何态 ── Esc / pointercancel / 窗口失焦 ──▶ 滑回
       * 原位(150ms),树一字不变」。U2 之前**三条都是瞬移**:`useTabDrag.endGesture`
       * 只 `reset()` 不 `settle()`,一摘 transform 那一格 5ms 就到家、连一次
       * `data-settle` 都没挂过(09-08 离屏探针的读数)。
       *
       * 读法与松手滑入**同一套**(上面那一段):不等,当场轮询 `[data-settle]`,
       * 读它的 `transition`(含 transform 与 150ms)与起始 `transform`(非零 ——
       * 它真的从手上那个位置滑过来)。三条路各跑一遍:两条走 window 上那两发
       * (`DragSession` 监听的就是它们),Esc 走响应链那一口。
       */
      const cancelPaths = [
        ['Esc', async () => { await page.keyboard.press('Escape') }],
        ['pointercancel', async () => {
          await page.evaluate(() => window.dispatchEvent(new Event('pointercancel')))
        }],
        ['窗口失焦', async () => {
          await page.evaluate(() => window.dispatchEvent(new Event('blur')))
        }],
      ]
      let orderBefore = order3
      for (const [label, fire] of cancelPaths) {
        const s4 = await topStrip(page)
        const escSrc = s4.tabs[0]
        await press(cdp, { x: escSrc.cx, y: escSrc.cy })
        await strokeOn(cdp, { x: escSrc.cx, y: escSrc.cy }, { x: s4.tabs[2].cx, y: escSrc.cy }, { steps: 10 })
        await fire()
        // **不等** —— 滑回那 150ms 要当场量(与松手滑入逐字同一套读法)。
        let slid = null
        const until = Date.now() + SETTLE_MS + 120
        while (Date.now() < until) {
          const row = await page.evaluate(() => {
            const el = document.querySelector('[data-settle]')
            if (!el) return null
            const style = getComputedStyle(el)
            return {
              id: el.getAttribute('data-tab-id'),
              transition: style.transitionProperty + ' ' + style.transitionDuration,
              transform: style.transform,
            }
          })
          if (row) {
            slid = row
            break
          }
          await delay(12)
        }
        assert(Boolean(slid), `${label} 之后那一格挂上了滑回态(data-settle)`, JSON.stringify(slid))
        assert(
          slid && slid.id === escSrc.id,
          `${label}:滑回的正是被拖那一格`,
          `${slid?.id} vs ${escSrc.id}`,
        )
        assert(
          slid && /transform/.test(slid.transition) && /0\.15s|150ms/.test(slid.transition),
          `${label}:滑回是一段 ${SETTLE_MS}ms 的位移过渡(从前这里是瞬移)`,
          slid?.transition,
        )
        assert(
          slid && slid.transform !== 'none' && !/matrix\(1, 0, 0, 1, 0, 0\)/.test(slid.transform),
          `${label}:首帧位移非零 —— 它真的从手上那个位置滑回来`,
          slid?.transform,
        )
        await releaseAt(cdp, { x: s4.tabs[2].cx, y: escSrc.cy })
        await delay(SETTLE_MS + 200)
        const after = await stripOrder(page, strip.leafId)
        assert(
          after.map((t) => t.id).join('|') === orderBefore.join('|'),
          `${label} 之后顺序一个字不变`,
          after.map((t) => t.id).join(' | '),
        )
        assert(
          after.every((t) => !t.lift && !t.torn && t.shift === '' && !t.settle),
          `${label} 之后抬起 / 折起 / 让位 / 收笔四样都清干净`,
          JSON.stringify(after),
        )
        assert(!(await feedbackNow(page)).ghost, `${label} 之后浮影没了`)
        orderBefore = after.map((t) => t.id)
      }

      /*
       * **(b) 最宽的那一格也拖得到末位**(§4.2:「中心对中心时宽标签要整个越过窄
       * 邻居才换位……而且永远够不到末位」)。中心对中心那一版在这里靠两句钳位特例
       * 救场;判据换成「边越过中心」之后,末位是判据自己算出来的。
       */
      const s5 = await topStrip(page)
      const widest = s5.tabs.reduce((a, b) => (b.width > a.width ? b : a), s5.tabs[0])
      const order5 = (await stripOrder(page, s5.leafId)).map((t) => t.id)
      await stroke(
        cdp,
        { x: widest.cx, y: widest.cy },
        { x: s5.rect.left + s5.rect.width - 4, y: widest.cy },
        { steps: 14, release: true },
      )
      await delay(SETTLE_MS + 240)
      const order6 = (await stripOrder(page, s5.leafId)).map((t) => t.id)
      assert(
        order6[order6.length - 1] === widest.id,
        `最宽的那一格(${widest.width}px)拖到最右 = 它排到了末尾`,
        `${order5.join(' | ')} → ${order6.join(' | ')}`,
      )

      /*
       * **(c) 让位发生在「被拖的右缘 = 邻居中心」那一刻,不是「中心 = 中心」**
       * (§4.2 的判据本体)。
       *
       * 抓的是被拖那格的中心,所以 grabDx = 半格宽,右缘 = 指针 x + 半格宽。
       * 「右缘 = 邻居中心」那一刻的指针 x 因此是 `邻居中心 - 半格宽`。两侧各让
       * `EDGE_EPS`px 各读一次:未越过时那个邻居的 transform 必须是空的,越过之后
       * 必须非空。**中心对中心那一版的门槛比这里晚半格宽**,于是「已越过」那一站
       * 读到的是空 —— 当场红。整段是一次不松手的连续路径。
       */
      const s7 = await topStrip(page)
      const src7 = s7.tabs[0]
      const half = src7.width / 2
      await press(cdp, { x: src7.cx, y: src7.cy })
      let from7 = { x: src7.cx + DRAG_START_X + 1, y: src7.cy }
      await strokeOn(cdp, { x: src7.cx, y: src7.cy }, from7, { steps: 3 })
      for (const nb of s7.tabs.slice(1)) {
        const cross = Math.round(nb.cx - half)
        for (const side of ['未越过', '已越过']) {
          const at = side === '未越过' ? cross - EDGE_EPS : cross + EDGE_EPS
          await strokeOn(cdp, from7, { x: at, y: src7.cy }, { steps: 4 })
          // 微动一格,而且**朝着背离门槛的方向** —— 手还在动才算数(见文件头的量法)。
          await moveTo(cdp, { x: at + (side === '未越过' ? -1 : 1), y: src7.cy })
          await delay(28)
          const shift = (await stripProbe(page, s7.leafId)).shifts[nb.id] ?? ''
          assert(
            side === '未越过' ? shift === '' : shift !== '',
            `右缘${side}「${nb.id}」的中心(指针 x=${at},门槛 ${cross})→ 它${side === '未越过' ? '不让位' : '让位'}`,
            JSON.stringify({ shift }),
          )
          from7 = { x: at, y: src7.cy }
        }
      }
      await page.keyboard.press('Escape')
      await releaseAt(cdp, from7)
    }

    /* ══ 场景 ④:条底缘下那条带整段并回了换序(U2)══════════════════════ */
    scenario('条底缘下 6–24px 仍是换序:停 1s 不误并;零描圈零提示行;空白上松手 = 挪到末位;两格标签同理')
    {
      const strip = await fillStrip(3, { singles: true })
      const src = strip.tabs[0]
      const host = strip.tabs[1]
      /*
       * 这一整场的坐标全部取自**按下之前**那一次 `topStrip`:拖拽期间那几格带着
       * transform,活矩形早就不是它们的槽位了(编舞读的也正是抬起那一刻的基准)。
       */
      const belowY = Math.round(strip.rect.top + strip.rect.height + BELOW_STRIP_OFFSET)

      /*
       * **(a) 换序途中停住 1s,一个字都不许发生。**
       *
       * 这一条就是用户报的那句「换序途中稍一停顿就误并」的反证 —— 按时间判的那一版
       * (在邻居正中停够 300ms 就并)在这里必红。停的是**横向**:1px 的抖动只走 x。
       * U2 之后竖向那一头也不再有第二形,但这一条一个字不用改:它守的是「换序途中
       * 不许自己变成别的动作」,而那句话现在**更强**了。
       */
      await press(cdp, { x: src.cx, y: src.cy })
      await strokeOn(cdp, { x: src.cx, y: src.cy }, { x: host.cx, y: src.cy }, { steps: 10 })
      const held = []
      const until = Date.now() + 1000
      let flip = 0
      while (Date.now() < until) {
        flip = 1 - flip
        await moveTo(cdp, { x: host.cx + flip, y: src.cy })
        await delay(24)
        held.push(await stripProbe(page, strip.leafId))
      }
      const misfired = held.filter((r) => r.pairHot !== null || r.hint !== '')
      assert(
        misfired.length === 0,
        `横着拖到邻居正中停住 1s:全程没有描圈、没有提示行(${held.length} 帧)`,
        misfired.length ? JSON.stringify(misfired[0]) : `${held.length} 帧全空`,
      )
      const droppedShift = held.filter((r) => (r.shifts[host.id] ?? '') === '')
      assert(
        droppedShift.length === 0,
        '而且全程仍旧是换序 —— 那个邻居一直让着位',
        droppedShift.length ? JSON.stringify(droppedShift[0].shifts) : JSON.stringify(held[0].shifts),
      )

      /*
       * **(b) 压到条底缘下 12px:仍是换序**(U2 —— 这一站的断言整个反过来了)。
       *
       * 从前这里是「放到标签上」:邻居的让位全部清零、指针底下那一格描一圈、浮影
       * 下多一行「与 X 二合一」。真机(09-08 离屏探针)量到那一圈**被抬起的那一格
       * 盖住 92%** —— 抬起那格 `z-index: 2`、底不透明,而这一形里它照旧跟手,于是
       * 它正压在指针底下那一格上,用户只剩提示行能看。用户裁定整条带删掉。
       *
       * 所以今天这一站要读到的是三件事:邻居**仍在让位**、`data-pair-hot` 零、
       * 提示行为空(条内换序全程不画浮影也不写字,W7-c 裁定 5)。
       */
      /*
       * **横坐标先躲开架子那条条**(U2,判词在 `clearOfShelvesX` 上):条底缘往下
       * 那一片正好是左架子檐所在的地,而指针真的落在别人那条条上时自己的外扩让开
       * —— 那是场景 ⑩ 的地。这一条问的是「没有别人的条时,这一片是不是仍然换序」。
       */
      const belowX = (await clearOfShelvesX(page, strip, [host.cx])) ?? host.cx
      await strokeOn(cdp, { x: host.cx, y: src.cy }, { x: belowX, y: src.cy }, { steps: 4 })
      await strokeOn(cdp, { x: belowX, y: src.cy }, { x: belowX, y: belowY }, { steps: 6 })
      await moveTo(cdp, { x: belowX + 1, y: belowY })
      await delay(60)
      const below = await stripProbe(page, strip.leafId)
      assert(
        below.pairHot === null,
        `压到条底缘下 ${BELOW_STRIP_OFFSET}px:谁都不描圈(那条带 U2 整段删掉了)`,
        JSON.stringify(below.pairHot),
      )
      assert(below.hint === '', '浮影下那行字**不出现** —— 这一形仍是条内换序', below.hint)
      assert(!below.card, '卡片也不画:屏幕上动的还是只有那一格标签', JSON.stringify(below.card))
      const shiftedBelow = Object.entries(below.shifts).filter(([, v]) => v !== '' && v !== 'LIFTED')
      assert(
        shiftedBelow.length > 0,
        '而且邻居**仍在让位** —— 它就是换序,不是第二形',
        JSON.stringify(below.shifts),
      )
      assert(
        Object.values(below.shifts).includes('LIFTED'),
        '被拖那一格照旧抬着(它没被折起来 —— 这一片仍在带里)',
        JSON.stringify(below.shifts),
      )

      /* **(c) 回到条内:照旧是换序,一个跃迁都没发生过。** */
      await strokeOn(cdp, { x: belowX + 1, y: belowY }, { x: belowX, y: src.cy }, { steps: 6 })
      await moveTo(cdp, { x: belowX + 1, y: src.cy })
      await delay(60)
      const back = await stripProbe(page, strip.leafId)
      assert(back.pairHot === null, '回到条内:照旧谁都不描圈', JSON.stringify(back.pairHot))
      assert(
        Object.entries(back.shifts).filter(([, v]) => v !== '' && v !== 'LIFTED').length > 0,
        '让位照旧在 —— 上下走这一趟没有任何一次形态跃迁',
        JSON.stringify(back.shifts),
      )
      await page.keyboard.press('Escape')
      await releaseAt(cdp, { x: belowX, y: src.cy })
      await delay(SETTLE_MS + 200)

      /*
       * **(d) 压在末格之后的空白上松手 = 挪到末位**(U2 的**行为变化**,门要改口)。
       *
       * 从前这一站断的是「空动作」:那一形是 onto,而 onto 在空白上没有目标,树一个
       * 字不变。今天那条带就是换序,末格之后的空白 x 落在条的矩形里(U1 起顶栏那一组
       * 的条铺到标签带的右缘),所以判据答的是「插到末尾」—— 与在条里横着拖到最右
       * 逐字同一件事。
       */
      const s2 = await topStrip(page)
      const lastTab = s2.tabs[s2.tabs.length - 1]
      // 同一条纪律:这一站也要躲开架子那条条(判词在 `clearOfShelvesX` 上)。
      // 兜底扫的是条的右段,而那一段本来就在末格右边 —— 仍旧是「末格之后的空白」。
      const blankX = (await clearOfShelvesX(page, s2, [lastTab.left + lastTab.width + 8]))
        ?? (lastTab.left + lastTab.width + 8)
      const belowY2 = Math.round(s2.rect.top + s2.rect.height + BELOW_STRIP_OFFSET)
      const hasBlank = blankX > lastTab.left + lastTab.width && blankX < s2.rect.left + s2.rect.width - 2
      assert(hasBlank, '条上末格之后还有空白可压', JSON.stringify({ blankX, right: s2.rect.left + s2.rect.width }))
      const mover = s2.tabs.find((t) => !String(t.id).startsWith('pair:')) ?? s2.tabs[0]
      const before2 = (await stripOrder(page, s2.leafId)).map((t) => t.id)
      if (hasBlank && mover.id !== before2[before2.length - 1]) {
        await press(cdp, { x: mover.cx, y: mover.cy })
        await strokeOn(cdp, { x: mover.cx, y: mover.cy }, { x: blankX, y: belowY2 }, { steps: 10 })
        await moveTo(cdp, { x: blankX + 1, y: belowY2 })
        await delay(60)
        const blank = await stripProbe(page, s2.leafId)
        assert(blank.pairHot === null, '压在末格之后的空白上:谁都不描圈', JSON.stringify(blank.pairHot))
        assert(blank.hint === '', '也不写字(条内换序不画浮影那一套)', blank.hint)
        await releaseAt(cdp, { x: blankX, y: belowY2 })
        await delay(SETTLE_MS + 240)
        const after2 = (await stripOrder(page, s2.leafId)).map((t) => t.id)
        assert(
          after2[after2.length - 1] === mover.id,
          '松手 = **挪到末位**(U2 行为变化:从前这一站是空动作)',
          `${before2.join(' | ')} → ${after2.join(' | ')}`,
        )
      } else {
        assert(false, '条上有一格不在末位的普通标签可以拖', JSON.stringify({ mover: mover.id, before2 }))
      }

      /*
       * **(e) 两格的标签拖下去,同样是换序,不是拒绝态**(U2)。
       *
       * 从前那一形是 onto 的拒绝态(§6 末行:两格的标签不能再并)—— 而那条拒绝
       * 只在「压下去 = 要并」这个前提下才成立。带删掉之后前提没有了:一格两格标签
       * 在自己那条条上换个位置,与普通标签逐字相同。
       *
       * 那一格两格标签走**动作单产地**那张右键菜单造出来(判词在 `pairActiveRight`
       * 上):这里要的是前置条件,不是二合一本身的手感。
       */
      const s3 = await fillStrip(3, { singles: true })
      // 种子:自己与右邻都得是普通标签(判词在 `firstPairableAt` 上)。
      const seedAt = firstPairableAt(s3.tabs)
      const seed = seedAt >= 0 ? s3.tabs[seedAt] : null
      const paired = seed ? await pairActiveRight(page, cdp, seed) : false
      assert(paired, '菜单里那一项把活动格与右邻并成了两格', JSON.stringify(s3.tabs.map((t) => t.id)))
      const s4 = await topStrip(page)
      const pairTab = s4.tabs.find((t) => String(t.id).startsWith('pair:'))
      const other = s4.tabs.find((t) => t.id !== pairTab?.id)
      const belowY3 = Math.round(s4.rect.top + s4.rect.height + BELOW_STRIP_OFFSET)
      assert(Boolean(pairTab && other), '条上有一格两格标签、还有另一格', JSON.stringify(s4.tabs.map((t) => t.id)))
      if (pairTab && other) {
        // 同一条纪律:躲开架子那条条(不躲的话这一下落的是架子,那是场景 ⑩ 的地)。
        const belowX3 = (await clearOfShelvesX(page, s4, [other.cx])) ?? other.cx
        await press(cdp, { x: pairTab.cx, y: pairTab.cy })
        await strokeOn(cdp, { x: pairTab.cx, y: pairTab.cy }, { x: belowX3, y: pairTab.cy }, { steps: 6 })
        await strokeOn(cdp, { x: belowX3, y: pairTab.cy }, { x: belowX3, y: belowY3 }, { steps: 6 })
        await moveTo(cdp, { x: belowX3 + 1, y: belowY3 })
        await delay(60)
        const dragged = await stripProbe(page, s4.leafId)
        assert(!dragged.cursorRefuse, '两格标签拖到条底缘下:**不是**拒绝态了', JSON.stringify(dragged.cursorRefuse))
        assert(dragged.pairHot === null, '谁都不描圈', JSON.stringify(dragged.pairHot))
        assert(
          Object.values(dragged.shifts).includes('LIFTED'),
          '而且它就是换序 —— 那一格还抬着(没被折起来交给浮影)',
          JSON.stringify(dragged.shifts),
        )
        assert(!dragged.card, '卡片不画', JSON.stringify(dragged.card))
        await releaseAt(cdp, { x: belowX3, y: belowY3 })
        await delay(SETTLE_MS + 240)
        const after3 = (await stripOrder(page, s4.leafId)).map((t) => t.id)
        assert(after3.includes(pairTab.id), '松手之后那一格两格标签还在条上(换序,不是被吃掉)', after3.join(' | '))
      }
    }

    /* ══ 场景 ⑤:架子 → 聊天区中间 / 右带;浮窗不接住自己 ═════════════ */
    scenario('从架子拖文件到聊天区:中间 = 新标签,右带 = 二合一;浮窗不接住自己')
    {
      /*
       * **绕开那扇浮窗,而不是把它收起来**(门第三版的修法)。
       *
       * 总览是一扇 880×520 的居中浮窗,正盖住聊天区的中段;点 Dock 那块瓦是**开关**,
       * 但它此刻是焦点面,连点两下只会「收起 → 再开」,读数是浮窗还在。
       * 而这一条要量的是「落到**聊天区**的中间 / 右带会怎样」,不是「浮窗能不能收」
       * —— 后者是 gate:focus 的地。所以这里改成:在中央叶里挑一个**不被任何浮窗
       * 盖住**的点。判据本身一个字都不用绕:「叶重叠时取最上」照旧成立,只是探针
       * 站到了没有第二片叶的地方。
       */
      const pointIn = (fx) =>
        page.evaluate((wantFx) => {
          const slot = document.querySelector('[data-pane-region="center"] [data-pane-slot]')
          if (!slot) return null
          const r = slot.getBoundingClientRect()
          const floats = Array.from(document.querySelectorAll('[data-float-body]')).map((el) => {
            const win = el.closest('[role="dialog"]') ?? el
            return win.getBoundingClientRect()
          })
          const x = r.left + r.width * wantFx
          // 从叶的竖向中线往下找,直到落在所有浮窗之外(叶比浮窗高,总找得到)。
          for (const t of [0.5, 0.72, 0.86, 0.94, 0.2, 0.08]) {
            const y = r.top + r.height * t
            if (!floats.some((f) => x >= f.left && x <= f.right && y >= f.top && y <= f.bottom)) {
              return { x: Math.round(x), y: Math.round(y), leaf: {
                left: Math.round(r.left), top: Math.round(r.top),
                width: Math.round(r.width), height: Math.round(r.height),
              } }
            }
          }
          return null
        }, fx)
      const midPoint = await pointIn(0.5)
      const rightPoint = await pointIn(1 - 0.28 / 2)
      const leaf = midPoint ? { rect: midPoint.leaf, y: midPoint.y } : null
      const row = await centerOf(page, `[data-file-path="${path.join(cwd, 'gamma.ts')}"]`)
      assert(
        Boolean(leaf && row && rightPoint),
        '中央叶里找得到不被浮窗盖住的中点与右带点',
        JSON.stringify({ mid: midPoint, right: rightPoint }),
      )
      if (leaf && row && midPoint && rightPoint) {
        const gammaId = `file:${path.join(cwd, 'gamma.ts')}`
        const before = (await stripOrder(page, (await topStrip(page)).leafId)).length
        // 中间:一路走过去、不停顿,途中量氛围与提示。
        const mid = { x: midPoint.x, y: midPoint.y }
        const seen = await stroke(cdp, row, mid, { steps: 12, holdMs: 200, sample: () => feedbackNow(page) })
        const last = seen[seen.length - 1]
        assert(last.shape === 'slab', '中间那一档画的是一块铺满整片叶的板', JSON.stringify(last))
        assert(last.ambient === 0, '**氛围层随 U1 退役**:屏幕上没有一块淡亮(用户报的「一拖整窗变色」)', String(last.ambient))
        assert(last.hint !== '', '提示行说的是「开成新标签」这一档', last.hint)
        await releaseAt(cdp, mid)
        const strip2 = await topStrip(page)
        assert(
          strip2.tabs.some((t) => t.id === gammaId),
          '松手之后它成了中央那条条上的一格新标签',
          strip2.tabs.map((t) => t.id).join(' | '),
        )
        assert(strip2.tabs.length === before + 1, '条上多了一格,不是替换', `${before} → ${strip2.tabs.length}`)

        // 右带 28%:二合一。
        const row2 = await centerOf(page, `[data-file-path="${path.join(cwd, 'alpha.ts')}"]`)
        const rightBand = { x: rightPoint.x, y: rightPoint.y }
        if (row2) {
          const seen2 = await stroke(cdp, row2, rightBand, { steps: 12, holdMs: 160, sample: () => feedbackNow(page) })
          const r2 = seen2[seen2.length - 1]
          assert(r2.shape === 'slab', '右带那一档画的是「落下后占的那一半」(与中间同一种板,差的只是矩形)', JSON.stringify(r2))
          assert(
            r2.bandRect && Math.abs(r2.bandRect.width - Math.round(leaf.rect.width / 2)) <= 2,
            '而且那一半就是叶的一半宽',
            JSON.stringify({ band: r2.bandRect?.width, half: Math.round(leaf.rect.width / 2) }),
          )
          assert(r2.hint !== '', '提示行说的是「与 X 二合一」', r2.hint)
          const tabsBefore = (await topStrip(page)).tabs.length
          await releaseAt(cdp, rightBand)
          const strip3 = await topStrip(page)
          const paired = await page.evaluate(() =>
            Array.from(document.querySelectorAll('[data-tab-slots]')).map((el) => el.getAttribute('data-tab-id')),
          )
          assert(paired.length > 0, '松手之后条上有一格装着两份', JSON.stringify(paired))
          assert(strip3.tabs.length <= tabsBefore + 1, '而且没有多长出一片叶(单叶政策)', `${tabsBefore} → ${strip3.tabs.length}`)
        }
      }

      /*
       * **浮窗不接住自己**(§8):从总览那扇浮窗里拖一条会话行出来,指针停在
       * **那扇窗自己身上** —— 落点该是窗底下那片叶,不是它自己。
       */
      const float = await centerOf(page, '[data-float-body]')
      const sessionRow = await centerOf(page, '[data-session-id]:not([aria-selected="true"])')
      if (float && sessionRow) {
        await press(cdp, sessionRow)
        await strokeOn(cdp, sessionRow, { x: float.x, y: float.y }, { steps: 10 })
        await moveTo(cdp, { x: float.x + 1, y: float.y })
        await delay(40)
        const read = await page.evaluate(() => {
          const band = document.querySelector('[data-testid="drop-overlay"]')
          if (!band) return null
          const r = band.getBoundingClientRect()
          return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
        })
        assert(Boolean(read), '停在那扇浮窗身上时有落区', JSON.stringify(read))
        assert(
          read && (read.width > float.rect.width + 8 || read.height > float.rect.height + 8),
          '**落区不是那扇窗自己** —— 它比窗大得多(判的是窗底下那片叶)',
          JSON.stringify({ band: read, float: float.rect }),
        )
        await page.keyboard.press('Escape')
        await releaseAt(cdp, { x: float.x, y: float.y })
      } else {
        assert(false, '总览浮窗与一条会话行都在场', JSON.stringify({ float: Boolean(float), row: Boolean(sessionRow) }))
      }
    }

    /* ══ 场景 ⑥:零重挂(换序 / 二合一 / 拆开 / 换比例)══════════════ */
    scenario('零重挂:换序、二合一、拆开、换比例四步,内容根节点同一个 DOM')
    {
      const bodySel = '[data-pane-region="center"] [data-pane-body]'
      await stamp(page, bodySel, 'body-node')
      const strip = await fillStrip(2, { singles: true })

      // ① 换序。
      const a = strip.tabs[0]
      const b = strip.tabs[1]
      await stroke(cdp, { x: a.cx, y: a.cy }, { x: b.cx + b.width / 2 - 2, y: a.cy }, { steps: 10, release: true })
      await delay(SETTLE_MS + 200)
      assert(await stampSurvives(page, bodySel, 'body-node'), '换序之后内容根还是同一个节点')

      /*
       * ② 二合一。**U2 改走动作单产地那张右键菜单**:从前这里走的是「压到条底缘下
       * 6–24px 再松手」,而那条带整段删掉了(判词在 `pairActiveRight` 上)。这一条
       * 断的是「二合一之后内容根还是同一个节点」,与它由哪条路触发无关 —— 三条路
       * (菜单 / 拖到内容区左右带 / 从前那条带)调的本来就是同一只 `pairIntoIndex`。
       */
      let s2 = await fillStrip(2, { singles: true })
      /*
       * **先保证条上真有并排的两格普通标签**:走到这一步时条上多半已经有一两格
       * 两格标签(⑤ 与本场景自己并出来的),而两格的标签不能再并 —— 于是「有两格
       * 普通标签」不等于「有并排的两格普通标签」。补一格没开过的文件(它接在末尾,
       * 与末位那格普通标签相邻),这一条才有对象可量。
       */
      if (firstPairableAt(s2.tabs) < 0) {
        const spare = `[data-file-path="${path.join(cwd, 'delta.ts')}"]`
        if (await page.evaluate((css) => Boolean(document.querySelector(css)), spare)) {
          await clickSelector(page, spare)
          await delay(360)
          s2 = await topStrip(page)
        }
      }
      const pairableAt = firstPairableAt(s2.tabs)
      if (pairableAt >= 0) {
        const paired = await pairActiveRight(page, cdp, s2.tabs[pairableAt])
        assert(paired, '菜单里那一项把两格并成了一格(而且它成了活动那一格)', JSON.stringify(s2.tabs.map((t) => t.id)))
        assert(await stampSurvives(page, bodySel, 'body-node'), '二合一之后内容根还是同一个节点')
      } else {
        assert(false, '条上有并排的两格普通标签可以并', JSON.stringify(s2.tabs.map((t) => t.id)))
      }

      /*
       * ③ 换比例(拖那根分隔杆)。
       *
       * **抓点由命中测试挑,而且要真的问一句「比例变了没有」**(W7-t / B7)。
       * 修前这里按的是 `centerOf` 那一点,而那一点身上此刻站着三样东西:B7 新添
       * 的缝中点拆开把手(`pair.module.css` 的 `.seamHandle`)、右边那格
       * (抓手有意溢出到缝两边,右半边被后一个兄弟盖着)、以及这道门此刻还开着
       * 的那块会话总览浮面(实测 y≈204–689)。三样都在,于是这一下按在别人身上,
       * 杆一动没动 —— 而旧断言只问「内容根还是同一个节点」,对空动作是绿的。
       */
      /*
       * **屏幕上那条杆,不是 DOM 里第一条**(U2 修)。条上可能同时有好几格两格标签
       * (⑤ 并出来的、本场景并出来的),而后台那几格的内容层是 `inert` / 不可见的
       * —— `querySelector` 取到的第一条很可能属于一格**没在屏幕上**的标签,于是
       * 「杆上有没有鼠标够得着的一段」恒为 null。判据换成:在**所有**杆里找第一条
       * 真的接得到指针的,后面几步都对着它那一条问。
       */
      const seamPick = await page.evaluate(() => {
        const bars = Array.from(document.querySelectorAll('[data-testid^="pair-splitter"]'))
        for (let i = 0; i < bars.length; i += 1) {
          const bar = bars[i]
          const r = bar.getBoundingClientRect()
          if (r.width <= 0 || r.height <= 0) continue
          /*
           * x 也要扫:那条 6px 的抓手**有意溢出**到 1px 的缝两边
           * (`Splitter.module.css`「抓手比列宽」),而右边那格是它的后一个兄弟、
           * 又是 `position: relative` —— 于是抓手的右半边被右格盖着,只有左半边
           * 真的接得到指针。y 也要扫:B7 那颗拆开小把手压在正中,而这道门此刻还
           * 开着的那块会话总览把杆的中段整个盖住。
           */
          for (let y = r.top + 8; y < r.top + r.height - 8; y += 12) {
            for (const x of [r.left + 1, r.left + Math.round(r.width / 2), r.left + r.width - 1]) {
              const top = document.elementFromPoint(Math.round(x), Math.round(y))
              if (top === bar || (top && bar.contains(top))) {
                return { index: i, grab: { x: Math.round(x), y: Math.round(y) } }
              }
            }
          }
        }
        return null
      })
      const seam = seamPick
      const ratioNow = () =>
        page.evaluate((i) => {
          const el = document.querySelectorAll('[data-testid^="pair-splitter"]')[i]
          const now = Number(el?.getAttribute('aria-valuenow'))
          return Number.isFinite(now) ? now : null
        }, seamPick?.index ?? 0)
      if (seam) {
        const before = await ratioNow()
        /*
         * **抓点由命中测试挑,不由几何猜**。两件东西会盖住杆的一段:B7 那颗
         * 拆开小把手(压在正中),以及这道门此刻还开着的那块会话总览(实测它
         * 从 y≈204 铺到 689,把杆的中段整个盖住 —— 旧代码按的正是那一点,于是
         * 这一步一直在按一块别人的面,而旧断言只问「内容根还在不在」,对
         * 「一动没动」是绿的)。所以沿杆自上而下找第一段**顶上真的是它自己**的
         * 位置;一段都找不到 = 这条杆鼠标够不着,那本身就是一条红。
         */
        const grabAt = seam.grab
        assert(grabAt !== null, '这条杆身上有鼠标够得着的一段(把手只吃掉中间一小截)')
        if (grabAt !== null) {
          const grab = grabAt
          await stroke(cdp, grab, { x: grab.x - 60, y: grab.y }, { steps: 8, release: true })
          await delay(240)
          const after = await ratioNow()
          assert(
            before !== null && after !== null && after < before,
            '按住那一段往左拖 60px:比例真的变小了(不是一次空动作)',
            `${before} → ${after} @${grab.x},${grab.y}`,
          )
        }
        assert(await stampSurvives(page, bodySel, 'body-node'), '换比例之后内容根还是同一个节点')
      } else {
        assert(false, '屏幕上那一格两格标签里有一根够得着的分隔杆', 'pair-splitter 一条都没接到指针')
      }
      // ④ 拆开 —— W7-t / B7 起它是**缝中点那颗小把手**(格头上换成了只关这一格的 ✕)。
      const unpaired = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid^="pair-unpair"]')
        if (!(btn instanceof HTMLElement)) return false
        btn.click()
        return true
      })
      await delay(320)
      assert(unpaired, '缝中点那颗「拆开」按得到')
      if (unpaired) {
        assert(await stampSurvives(page, bodySel, 'body-node'), '拆开之后内容根还是同一个节点')
      }
    }

    /* ══ 场景 ⑦:拒绝态 —— 光标、理由、弹回 ═══════════════════════════ */
    scenario('拒绝区:not-allowed 光标 + 一句理由;松手弹回,树一个字不变')
    {
      const dock = await centerOf(page, '[data-dock="strip"]')
      const row = await centerOf(page, `[data-file-path="${path.join(cwd, 'beta.ts')}"]`)
      assert(Boolean(dock && row), 'Dock 与文件行都量得到', JSON.stringify(dock?.rect))
      if (dock && row) {
        const before = await treeShape(page)
        const seen = await stroke(cdp, row, dock, { steps: 12, holdMs: 160, sample: () => feedbackNow(page) })
        const read = seen[seen.length - 1]
        assert(read.refused, 'Dock 上是拒绝态(浮影变灰虚线)', JSON.stringify(read))
        assert(read.cursorRefuse, '而且整扇窗的光标换成了 not-allowed(根属性驱动)')
        assert(read.hint !== '', '拒绝也说得出理由,不静默', read.hint)
        assert(read.shape === null, '拒绝时不画一块接受色的高亮')
        await releaseAt(cdp, dock)
        assert((await treeShape(page)) === before, '松手之后树逐字不变(弹回,空动作)')
        assert(
          !(await page.evaluate(() => document.documentElement.hasAttribute('data-drag-refuse'))),
          '拒绝光标在结束路径上摘掉了(留着的话整扇窗从此都是禁止光标)',
        )
      }

      // 顶栏尾格同理。
      const trailing = await centerOf(page, '[data-testid="topbar-trailing"]')
      const row2 = await centerOf(page, `[data-file-path="${path.join(cwd, 'beta.ts')}"]`)
      if (trailing && row2 && trailing.rect.width > 0) {
        const seen = await stroke(cdp, row2, trailing, { steps: 10, holdMs: 120, sample: () => feedbackNow(page) })
        assert(seen[seen.length - 1].refused, '顶栏尾格也是拒绝区', JSON.stringify(seen[seen.length - 1]))
        await releaseAt(cdp, trailing)
      } else {
        assert(false, '顶栏尾格量得到', JSON.stringify(trailing?.rect))
      }
    }

    /* ══ 场景 ⑧:顶栏末格右边那片空白 = 插到末尾(U1)══════════════════ */
    scenario('顶栏末格右边的空白 = 插到末尾(U1;它今天靠两条 CSS 的先后成立)')
    {
      /*
       * 用户 09-08 报的是「顶栏末格右边那片空白不能放」。**施工时真机量下来,
       * 那片空白今天是收得住的** —— 顶栏那条 tablist 恰好铺满了整条标签带
       * (`LeafStrip.module.css` 的 `.tabs > * { flex: 1 }` 压过了 `ui/Tabs` 自己的
       * `.bar { flex: none }`,两条特异性打平、只靠层叠次序分胜负)。也就是说这件
       * 事今天是由**两条写在别处的 CSS 的先后**决定的,而拖拽那一头看不见它。
       *
       * 所以 U1 做了两件事:量法那一头把它写成保证(`drop-geometry.stripRectOf`:
       * 条收东西的地 = 那条带),这道门从**行为**那一头钉住同一句话 —— 那片空白上
       * 有没有空位、说的是不是「放到第 n 位」、松手接不接在末尾。
       * 真正会在那儿答「这里不能放」的只剩顶栏**尾格**(`data-nodrop`,设计 §5
       * 第一行的拒绝区),场景 ⑦ 量的就是它。
       */
      const strip = await topStrip(page)
      const band = await topBand(page)
      const lastRight = strip.tabs[strip.tabs.length - 1].left + strip.tabs[strip.tabs.length - 1].width
      /*
       * 量的是**末格右缘到那条带右缘**之间那片地,不是 tablist 的右缘 —— 后者
       * 今天恰好与带子右缘重合(`.tabs > * { flex: 1 }` 压过了 `.bar { flex: none }`),
       * 而这一条要问的是「用户眼里那片空白」,它的左界永远是最后一格标签。
       */
      assert(
        Boolean(band) && band.right - lastRight > 24,
        '末格右边到顶栏动作组之间真有一片空白(不然这一条没有对象可量)',
        JSON.stringify({ lastRight, band }),
      )
      let row = await centerOf(page, '[data-session-id]:not([aria-selected="true"])')
      if (!row) {
        await clickSelector(page, '[data-testid="dock-tile-sessions"]')
        await delay(500)
        row = await centerOf(page, '[data-session-id]:not([aria-selected="true"])')
      }
      assert(Boolean(row), '总览里有另一条会话可拖', JSON.stringify(Boolean(row)))
      if (band && row && band.right - lastRight > 24) {
        const blank = { x: Math.round((lastRight + band.right) / 2), y: strip.tabs[0].cy }
        const want = strip.tabs.length + 1
        const beforeIds = strip.tabs.map((t) => t.id)
        const seen = await stroke(cdp, row, blank, { steps: 12, holdMs: 200, sample: () => feedbackNow(page) })
        const read = seen[seen.length - 1]
        assert((read.gapWidth ?? 0) > 0, '那片空白上腾出一格空位', JSON.stringify(read))
        assert(
          read.hint.includes(String(want)),
          `提示行说的是「放到第 ${want} 位」(n = 格数 + 1)`,
          `${read.hint}`,
        )
        const gapAtEnd = await page.evaluate((leafId) => {
          const list = document.querySelector(
            `[data-pane-chrome="${leafId.replace(/["\\]/g, '\\$&')}"] [role="tablist"]`,
          )
          const ph = list?.querySelector('[data-tab-placeholder]')
          if (!ph) return null
          return ph.nextElementSibling === null
        }, strip.leafId)
        assert(gapAtEnd === true, '那格空位排在**末尾**(它后面一个兄弟都没有)', String(gapAtEnd))
        await releaseAt(cdp, blank)
        const after = await topStrip(page)
        const added = after.tabs.filter((t) => !beforeIds.includes(t.id)).map((t) => t.id)
        assert(added.length === 1, '松手之后条上多了一格', JSON.stringify({ beforeIds, now: after.tabs.map((t) => t.id) }))
        assert(
          added.length === 1 && after.tabs[after.tabs.length - 1].id === added[0],
          '而且它**接在末尾**,不是插在中间',
          after.tabs.map((t) => t.id).join(' | '),
        )
      }
    }

    /* ══ 场景 ⑨:边带 —— 12px,而且只对没有架子的那一边(U1)════════════ */
    scenario('边带:12px 窄带、只在那边还没有架子时出现;松手长出新架子')
    {
      /*
       * 病历(用户 09-08 真机):24px 的四条边带排在叶之前,于是**任何**一次贴边
       * 经过都判「钉边」;而左边明明开着文件架子时,那条带说的「钉到左侧架子」
       * 更是无处可去 —— 用户原话「莫名钉边」。两条修一起量:带收到 12,而且
       * 只对**还没有架子**的那一边成立。
       */
      const before = await shelvesNow(page)
      assert(before.includes('left'), '夹具出厂:左架子(files)在', JSON.stringify(before))
      assert(!before.includes('right'), '夹具出厂:右架子还没有', JSON.stringify(before))
      const width = await page.evaluate(() => window.innerWidth)
      const nearRight = await freePointAt(page, width - 20)
      const onRightEdge = await freePointAt(page, width - 6)
      /*
       * 拖的是**从没开过的那一份**(`delta.ts`)。拖一份此刻正当着中央叶活动标签
       * 的文件过去,整片叶答的是 `back`(「松手放回」,设计 §5 最后一行)——
       * 判据是对的,而这一条要量的是右带与边带,那就得挑一份不触发它的。
       * 门第一版拖的是 `beta.ts`,而前面几场恰好把它留成了活动标签,当场红。
       */
      const row = await centerOf(page, `[data-file-path="${path.join(cwd, 'delta.ts')}"]`)
      assert(
        Boolean(nearRight && onRightEdge && row),
        '右缘那两点与一行文件都量得到',
        JSON.stringify({ nearRight, onRightEdge }),
      )
      if (nearRight && onRightEdge && row && !before.includes('right')) {
        // (a) 离右缘 20px:**带外** —— 该是叶的右带那块板,不是膜。
        await press(cdp, row)
        await strokeOn(cdp, row, nearRight, { steps: 12 })
        await moveTo(cdp, { x: nearRight.x + 1, y: nearRight.y })
        await delay(40)
        const outside = await feedbackNow(page)
        assert(
          outside.shape === 'slab',
          `离右缘 20px(> ${NEW_SHELF_BAND})是叶的右带:一块板,不是边带那层膜`,
          JSON.stringify(outside),
        )
        assert(
          !/钉成|Pin as a new/.test(outside.hint),
          '而且那行字说的不是「钉成架子」',
          outside.hint,
        )
        // (b) 离右缘 6px:**带内** —— 一层 12 宽的膜 + 「钉成右侧架子」。
        await strokeOn(cdp, nearRight, onRightEdge, { steps: 6 })
        await moveTo(cdp, { x: onRightEdge.x, y: onRightEdge.y + 1 })
        await delay(40)
        const inside = await feedbackNow(page)
        assert(inside.shape === 'film', '离右缘 6px 是边带:一层膜', JSON.stringify(inside))
        assert(
          inside.bandRect !== null && Math.abs(inside.bandRect.width - NEW_SHELF_BAND) <= 1,
          `而且那条膜就是 ${NEW_SHELF_BAND} 宽(24 那一版在这里读 24)`,
          JSON.stringify(inside.bandRect),
        )
        assert(/钉成|Pin as a new/.test(inside.hint), '那行字说的是「钉成右侧架子」', inside.hint)
        await releaseAt(cdp, onRightEdge)
        await delay(400)
        const grown = await shelvesNow(page)
        assert(grown.includes('right'), '松手之后右架子长出来了', JSON.stringify(grown))
        const holds = await page.evaluate(
          (want) =>
            Boolean(
              document.querySelector(`[data-shelf="right"] [data-tab-id="${want.replace(/["\\]/g, '\\$&')}"]`),
            ),
          `file:${path.join(cwd, 'delta.ts')}`,
        )
        assert(holds, '而且它装着刚拖过去的那一格', String(holds))
      }

      // (c) 右架子在了 —— 同一点上边带**不再出现**,落的是架子自己。
      const after = await shelvesNow(page)
      const row2 = await centerOf(page, `[data-file-path="${path.join(cwd, 'alpha.ts')}"]`)
      const againEdge = await freePointAt(page, width - 6)
      if (after.includes('right') && row2 && againEdge) {
        const seen = await stroke(cdp, row2, againEdge, { steps: 12, holdMs: 160, sample: () => feedbackNow(page) })
        const read = seen[seen.length - 1]
        assert(read.shape !== 'film', '那条边已经有架子了 —— 同一点上不再是边带', JSON.stringify(read))
        assert(!/钉成|Pin as a new/.test(read.hint), '那行字也不再说「钉成架子」', read.hint)
        await page.keyboard.press('Escape')
        await releaseAt(cdp, againEdge)
      } else {
        assert(false, '右架子在场且还有一行文件可拖', JSON.stringify({ after, row2: Boolean(row2) }))
      }

      // (d) 左边本来就有架子:6px 处照旧不是边带。
      const leftPoint = await freePointAt(page, 6)
      const row3 = await centerOf(page, `[data-file-path="${path.join(cwd, 'gamma.ts')}"]`)
      if (leftPoint && row3) {
        const seen = await stroke(cdp, row3, leftPoint, { steps: 12, holdMs: 160, sample: () => feedbackNow(page) })
        const read = seen[seen.length - 1]
        assert(read.shape !== 'film', '左边那 6px 落在左架子身上,不是边带', JSON.stringify(read))
        assert(!/钉成|Pin as a new/.test(read.hint), '那行字也不说「钉成左侧架子」', read.hint)
        await page.keyboard.press('Escape')
        await releaseAt(cdp, leftPoint)
      } else {
        assert(false, '左缘那一点与一行文件都量得到', JSON.stringify({ leftPoint, row3: Boolean(row3) }))
      }
    }

    /* ══ 场景 ⑩:自己的外扩带不许赢过别人的条(U2)═══════════════════════ */
    scenario('把顶栏一格标签拖到左架子标签条的上半截:落的是架子那条条,不是回换序')
    {
      /*
       * ── 病历(用户 09-08)────────────────────────────────────────────────
       * 顶栏那条标签条的**下沿 24px 外扩**(`bandSlack = TEAR_OFF_DISTANCE`,
       * 「离条这么近仍算在带里」)盖住左右架子标签条的上半截 —— 架子檐从 y≈44 起、
       * 条 34px 高,两者在屏幕上就是叠着的。而从前「自己的带」先判(`useContentDrag`
       * 那句 `wants = inline && band.phase === 'inside'`),于是指针明明压在架子那条
       * 条上,这一帧仍被判成条内换序:架子那条条一动不动,松手什么也没发生。
       *
       * 修法是 W7-c 那条「落在条上的赢过只是够得着的」的**对偶**:指针**真的落在**
       * (不算任何外扩)另一条条的矩形上时,自己那条外扩让开
       * (`useContentDrag.onForeignStrip`)。
       *
       * ── 反证 ────────────────────────────────────────────────────────────
       * 把 `wants` 那一行的 `&& !onForeignStrip(...)` 挖掉,这一条当场红:
       * 架子那条条上没有空位、提示行为空、松手之后那一格还在顶栏。
       */
      const strip = await fillStrip(3, { singles: true })
      const shelf = await shelfStrip(page, 'left')
      assert(Boolean(shelf), '左架子那条标签条在场', JSON.stringify(shelf))
      const mover = strip.tabs.find((t) => !String(t.id).startsWith('pair:')) ?? strip.tabs[0]
      if (shelf && mover) {
        /*
         * **上半截**:架子条 top + 8。它同时满足两件事 —— 落在架子那条条的矩形里
         * (0 ≤ 8 < 34),而且落在顶栏那条条的下沿外扩里(顶栏条底缘 ~44,+24 = 68)。
         * 这一点正是病历里那一片。
         */
        const target = { x: Math.round(shelf.rect.left + shelf.rect.width / 2), y: shelf.rect.top + 8 }
        const overlaps = target.y <= strip.rect.top + strip.rect.height + TEAR_OFF_DISTANCE
        assert(
          overlaps,
          `这一点确实落在顶栏那条条的 ${TEAR_OFF_DISTANCE}px 下沿外扩里(不然这一条没有对象可量)`,
          JSON.stringify({ target, topBottom: strip.rect.top + strip.rect.height }),
        )
        const seen = await stroke(cdp, { x: mover.cx, y: mover.cy }, target, {
          steps: 14,
          holdMs: 220,
          sample: () => feedbackNow(page),
        })
        const read = seen[seen.length - 1]
        assert((read.gapWidth ?? 0) > 0, '架子那条条上腾出了一格空位', JSON.stringify(read))
        assert(/放到第|Drop at position/.test(read.hint), '提示行说的是「放到第 n 位」', read.hint)
        const shelfIdsBefore = shelf.tabs.map((t) => t.id)
        await releaseAt(cdp, target)
        await delay(SETTLE_MS + 300)
        const shelfAfter = await shelfStrip(page, 'left')
        const topAfter = await topStrip(page)
        assert(
          Boolean(shelfAfter) && shelfAfter.tabs.some((t) => t.id === mover.id),
          '松手之后那一格进了左架子',
          JSON.stringify({ before: shelfIdsBefore, after: shelfAfter?.tabs.map((t) => t.id) }),
        )
        assert(
          !topAfter.tabs.some((t) => t.id === mover.id),
          '而且它不在顶栏那条条上了(是搬过去,不是复制)',
          JSON.stringify(topAfter.tabs.map((t) => t.id)),
        )
      }
    }

    /* ══ 场景 ⑪:常驻内容的家(U3)═══════════════════════════════════════ */
    scenario('拖进架子的会话关得掉;中央区最后一格会话撕不走、有两格时撕得走')
    {
      /*
       * ── 病历(用户 09-08)────────────────────────────────────────────────
       * 「从 sessions 长按能放进面板,放进去之后关不掉」。`canDetachTab` 按**传进来
       * 的那棵树**数常驻种类,于是被拖进架子 / 浮窗的会话在那棵树里是唯一一格会话,
       * 当场被判成「最后一格常驻」:✕ 不画、⌘W 播报「关不掉」,而中央区还好好地
       * 站着一格会话。
       *
       * U3 的修法是把「区域」交给判据:守卫只对**那一种自述的家**
       * (`resident.region`)成立。同一条判据反过来还堵住了另一半 —— 中央区最后
       * 一格会话**撕不走**,而且要说出口(不是静默地把家搬空)。
       *
       * ── 反证 ────────────────────────────────────────────────────────────
       *  · 把 `canDetachTab` 里那句 `?.resident?.region === region` 换回
       *    `?.resident` → ①b 红(架子上那一格画不出 ✕);
       *  · 把 `useTabDrag` 那一格 `rules` 整格删掉 → ②a/②b/②c 红(撕出去被判成放行,
       *    松手之后中央区真的空了)。
       */
      /** 拒绝那句话取自字典,门里不再抄一份中文(与场景 ⑨ 的边带提示同一体例)。 */
      const REFUSE_RE = /中央区要留一格|The center must keep one tab/

      // 总览可能被前面几场挤到后面 —— 点一下瓦把它叫回前台(与场景 ① 同一句)。
      await clickSelector(page, '[data-testid="dock-tile-sessions"]')
      await delay(500)
      const shelf = await shelfStrip(page, 'left')
      const row = await centerOf(page, '[data-session-id]:not([aria-selected="true"])')
      assert(
        Boolean(shelf && row),
        '① 左架子那条条与总览里另一条会话都在场',
        JSON.stringify({ shelf: shelf?.leafId, row: Boolean(row) }),
      )
      if (shelf && row) {
        const onStrip = {
          x: Math.round(shelf.rect.left + shelf.rect.width / 2),
          y: Math.round(shelf.rect.top + shelf.rect.height / 2),
        }
        await stroke(cdp, { x: row.x, y: row.y }, onStrip, { steps: 14, holdMs: 160, release: true })
        await delay(SETTLE_MS + 300)
        const landedStrip = await shelfStrip(page, 'left')
        const landed = (landedStrip?.tabs ?? []).find((t) => String(t.id).startsWith('session:'))
        assert(
          Boolean(landed),
          '①a 那一行落进了左架子,成了一格会话标签',
          JSON.stringify(landedStrip?.tabs.map((t) => t.id)),
        )
        if (landed) {
          const closable = await page.evaluate(
            (id) =>
              Boolean(
                document
                  .querySelector(`[data-shelf="left"] [data-tab-id="${id}"]`)
                  ?.querySelector('[data-tab-close]'),
              ),
            landed.id,
          )
          assert(closable, '①b 架子上那一格会话画得出 ✕(守卫只在它自述的家里成立)', landed.id)
          await page.evaluate((id) => {
            const el = document.querySelector(
              `[data-shelf="left"] [data-tab-id="${id}"] [data-tab-close]`,
            )
            if (el instanceof HTMLElement) el.click()
          }, landed.id)
          await delay(500)
          const gone = await shelfStrip(page, 'left')
          assert(
            !(gone?.tabs ?? []).some((t) => t.id === landed.id),
            '①c 点那颗 ✕ 真的关掉了,树里没有它了',
            JSON.stringify(gone?.tabs.map((t) => t.id)),
          )
        }
      }

      // ── ② 中央区最后一格会话往下撕到左架子的内容区 = 拒绝态,树一字不变 ──
      const shelfNow = await shelfStrip(page, 'left')
      const centerStrip = await topStrip(page)
      const centerSessions = (centerStrip?.tabs ?? []).filter((t) =>
        String(t.id).startsWith('session:'),
      )
      assert(
        centerSessions.length === 1,
        '② 前提:此刻中央区恰好一格会话(不然这一条量的是另一件事)',
        JSON.stringify(centerStrip?.tabs.map((t) => t.id)),
      )
      /*
       * **落点取架子条正下方 80px** —— 那是架子那片叶的内容区(不是条),所以判据
       * 走的是 §5 的 ④⑤⑥ 那几档而不是 `strip`。三档都会把这一格搬进 `edge:left`,
       * 而 U3 的判据问的正是「区域变不变」,不是「哪一档落点」。
       */
      const intoShelfBody = shelfNow
        ? {
          x: Math.round(shelfNow.rect.left + shelfNow.rect.width / 2),
          y: Math.round(shelfNow.rect.top + shelfNow.rect.height + 80),
        }
        : null
      if (shelfNow && intoShelfBody && centerSessions.length === 1) {
        const before = await treeShape(page)
        const seen = await stroke(
          cdp,
          { x: centerSessions[0].cx, y: centerSessions[0].cy },
          intoShelfBody,
          { steps: 14, holdMs: 240, sample: () => feedbackNow(page) },
        )
        const read = seen[seen.length - 1]
        assert(read.cursorRefuse === true, '②a 根上挂着 data-drag-refuse', JSON.stringify(read))
        assert(read.refused === true, '②b 浮影自己也是拒绝的形', JSON.stringify(read))
        assert(REFUSE_RE.test(read.hint), '②c 而且说得出理由(不是静默拒绝)', read.hint)
        await releaseAt(cdp, intoShelfBody)
        await delay(SETTLE_MS + 300)
        assert((await treeShape(page)) === before, '②d 松手之后树一个字不变')

        // ── ③ 中央区有两格会话时,同一个手势放行(读数不是恒真)──────────────
        const row2 = await centerOf(page, '[data-session-id]:not([aria-selected="true"])')
        const bar = await topStrip(page)
        if (row2 && bar) {
          const ontoTop = {
            x: Math.round(bar.rect.left + bar.rect.width - 8),
            y: Math.round(bar.rect.top + bar.rect.height / 2),
          }
          await stroke(cdp, { x: row2.x, y: row2.y }, ontoTop, { steps: 14, holdMs: 160, release: true })
          await delay(SETTLE_MS + 400)
        }
        const twoUp = await topStrip(page)
        const twoSessions = (twoUp?.tabs ?? []).filter((t) => String(t.id).startsWith('session:'))
        assert(
          twoSessions.length >= 2,
          '③ 前提:中央区此刻有两格会话',
          JSON.stringify(twoUp?.tabs.map((t) => t.id)),
        )
        if (twoSessions.length >= 2) {
          const seen2 = await stroke(
            cdp,
            { x: twoSessions[0].cx, y: twoSessions[0].cy },
            intoShelfBody,
            { steps: 14, holdMs: 240, sample: () => feedbackNow(page) },
          )
          const read2 = seen2[seen2.length - 1]
          assert(
            read2.cursorRefuse === false && !REFUSE_RE.test(read2.hint),
            '③a 同一个手势这次放行(读数不是恒为拒绝)',
            JSON.stringify(read2),
          )
          await releaseAt(cdp, intoShelfBody)
          await delay(SETTLE_MS + 300)
          const shelfEnd = await shelfStrip(page, 'left')
          assert(
            (shelfEnd?.tabs ?? []).some((t) => String(t.id).startsWith('session:')),
            '③b 松手之后它真的进了左架子',
            JSON.stringify(shelfEnd?.tabs.map((t) => t.id)),
          )
        }
      }
    }

    await app.close()
    app = undefined
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }

  console.log('\n────────── 逐场景读数 ──────────')
  let red = 0
  scenarios.forEach((s, i) => {
    const bad = s.checks.filter((c) => !c.ok)
    red += bad.length
    console.log(`场景 ${i + 1} ${bad.length ? `红 ${bad.length}/${s.checks.length}` : '绿'}  ${s.name}`)
    for (const c of bad) console.log(`   ✗ ${c.message}${c.detail ? `  ${c.detail}` : ''}`)
  })
  const total = scenarios.reduce((n, s) => n + s.checks.length, 0)
  console.log(`合计 ${red} 条红 / ${total} 条断言`)
  if (red) {
    console.error('\n[drag-gate] FAILED')
    process.exit(1)
  }
  console.log(`\n[drag-gate] ok —— ${scenarios.length} 个场景全绿`)
}

main().catch((error) => {
  console.error('\n[drag-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
