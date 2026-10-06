#!/usr/bin/env node
/**
 * 模型服务设置面的**抗挤压真机门**(09-11 报障:「模型配置页面没有响应式布局」)。
 *
 * 立法在 `docs/design/react-shell-squeeze-rules-2026-08.md`(四律)。这条门执的是
 * 律四:**每块面在自己声明的最小宽度下零重叠**,而变窄的次序是「先截断,再有序
 * 降元素」。`gate:squeeze` 量的是会话总览那块面,量不到这一块 —— 这块面有
 * 自己的两栏骨架、自己的七列表和自己的四级退场,所以它要自己的门。
 *
 * ── 为什么静态那半不够(与 `squeeze-gate` 的分工)──────────────────────────
 * `squeeze-gate` 只查一句「声明块里有 flex:1 却没 min-width」。这一批要守的四件事
 * 它一件都看不见:
 *   ① 左栏在窄面板里到底收没收(那是 `@container` 的事,源码里只是一行查询);
 *   ② 目录此刻**真的排了几列**(display:none 的格子宽高全 0,只有排完版才知道);
 *   ③ 行尾那三颗动作钮有没有被 `overflow: clip` 吃掉(切掉的滚不到 = 功能不可达,
 *      这是 09-11 报障里最硬的一条:面板 760 档 32 件元素出面板、640 档 38 件);
 *   ④ 阈值算错的那 14px —— 它的表现是「表还是满列却排不下」,只有量排版才抓得到。
 * 所以同名的门有两半,两半都要跑(壳 CLAUDE.md「同名的门有两半就跑两半」)。
 *
 * ── 六档与它们各自该长什么样 ──────────────────────────────────────────────
 * 1280 / 1000 / 860 / 760 / 640 / 520(与 09-11 探针的六档逐字相同,所以改前改后
 * 的读数可以并排看)。**期望值不写死**:列数与左栏宽都由这道门**现算** ——
 * 它把 `styles/tokens.css` 里那几格阈值读进来,按真机量到的容器宽推出该有的档。
 * 于是改一格 token 而忘了改 @container 字面量,这道门与那条单测会一起红,
 * 而不是这道门跟着一起变得宽容(写死期望值就是那样烂掉的)。
 *
 * 另外四步不在六档里(后两步是批 2「手填模型 = 目录条目」的真机半边,
 * `docs/design/provider-settings-rework-2026-09.md` §4):
 *   [7] **面板地板**:把面板拖到 `--pv-panel-min`,律四要的就是这一句话 ——
 *       「你说你能活到 502,那就在 502 上零溢出」。
 *   [8] **临时展开左栏**:这是 `@container providers-detail` 那两条规则唯一到得了
 *       的路(详情列 = 面板 − 268)。不量它,那两条规则就是没人验过的声明。
 *   [9] **手填后取消勾选,行还在**:经界面手填 `foo-1` → 取消勾选 → 行仍在表里、
 *       这个空间的 `selectedModels` 不含它、目录口仍交出 `source:'manual'` 那一条。
 *   [10] **✕ 删手填,当前模型换人**:把 `foo-1` 勾上并设为当前 → 点 ✕ → 行没了、
 *       目录口不再有它、`model` 落到剩下的第一个勾选的。
 *   [11] **`effective` 只在后端折**(§5.5,09-10「设了上下文圆环仍 unknown」的回归):
 *       再手填 `foo-1` → 覆盖上下文 200000 → 目录口那一行 `effective.contextLength === 200000`
 *       且 `source.contextLength === 'override'`;再开一条跑 deepseek/foo-1 的会话,
 *       composer 读数环不再说「未知」,悬停卡上的窗口同为 200k —— 壳读的就是后端那一个数。
 *
 * 批 3(§6,自定义服务商 + 参数建议)再加三步,全部经界面走(排在 [11] 之后,理由见
 * `customProviderSteps` 头):
 *   [12] **直连拉目录**:门里起一个本地假 `/v1/models`(OpenAI 形 + `context_length`),经
 *       「＋ 自定义服务商」对话框建一家指向它 → 保存后目录区自动拉一次 → 行出现、目录口那一行
 *       `source:'endpoint'`、`effective.contextLength` 出处 `endpoint`;没报能力的行能力是
 *       「不知道」(null),不是「不支持」。
 *   [13] **自定义头替换密钥**:同一家在「高级」里写 `X-Test: {{apiKey}}`(经「插入密钥」钮),
 *       假站收到的请求头里是替换后的密钥,默认 Bearer 也在。
 *   [14] **参数建议芯片**:在这一家手填 `gpt-5.5` → 行上画出「≈」芯片 → 点上下文那枚 →
 *       这个空间的 `contextLengthByModel['gpt-5.5']` 有值、芯片消失。认亲读的是 models.dev
 *       缓存 —— 门起核**之前**往临时 store 里种一份精简快照(`<store>/cache/models-dev.json`,
 *       新鲜的 `fetchedAt`),离线也认得出 `gpt-5.5`。有网时起核那一段仍可能把它条件请求成真目录
 *       (09-26 实跑:建议值是真目录的 1.05M 而不是种的 400k),所以门不写死数,判的是
 *       「点了 = 目录口那一行建议的那个数进了覆盖表」。
 *
 * 跑法:`node scripts/gate-providers-squeeze.mjs`(先 `npm run app:build`)。
 * 可重复:每次一个全新的临时 store + 全新的 `--user-data-dir`,跑完删干净;
 * 窗口离屏起、焦点由 CDP 补(「真机门不许抢用户的机器」),不连 5175、不碰 ~/.onething。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

/** 六档面板宽。1280 是宽档一头,520 是报障视频里最窄那一头。 */
const BANDS = [1280, 1000, 860, 760, 640, 520]

const PROVIDER = 'deepseek'
/** 第三个 id 故意很长:名字那一列的截断只有在真挤得下不去时才醒着。 */
const MODELS = [
  'deepseek-chat',
  'deepseek-reasoner',
  'deepseek-coder-v2-instruct-0724-long-name',
  'deepseek-vl2-tiny',
]

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── token:阈值的唯一产地,这道门现算期望值 ──────────────────────────────── */

const tokensCss = readFileSync(path.join(appRoot, 'src/styles/tokens.css'), 'utf8')
  // 病历里逐字抄着旧值,不剥注释会读到 08-31 那一版的数(与单测同一条判例)。
  .replace(/\/\*[\s\S]*?\*\//g, (hit) => hit.replace(/[^\n]/g, ' '))

function token(name) {
  const hit = new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(tokensCss)
  if (!hit) throw new Error(`tokens.css 里找不到 ${name}`)
  return Number(hit[1])
}

const T = {
  railW: token('--pv-rail-w'),
  railCollapsedW: token('--pv-rail-collapsed-w'),
  railCollapseAt: token('--pv-panel-rail-collapse'),
  panelMin: token('--pv-panel-min'),
  detailStack: token('--pv-detail-stack'),
  narrow: token('--pv-catalog-narrow'),
  tight: token('--pv-catalog-tight'),
  bare: token('--pv-catalog-bare'),
  bones: token('--pv-catalog-bones'),
  floor: token('--pv-catalog-floor'),
  headStack: token('--pv-catalog-head-stack'),
  bw: token('--bw-1'),
}

/** 目录该排几列 —— 判据是**容器查询看到的那个宽**(内容盒,不含两道边框)。 */
function expectedColumns(catalogBorderBoxW) {
  const cq = catalogBorderBoxW - 2 * T.bw
  if (cq > T.narrow) return 7
  if (cq > T.tight) return 6
  if (cq > T.bare) return 5
  if (cq > T.bones) return 4
  return 3
}

/** 左栏该多宽 —— 面板自己就是容器,它没有内衬也没有边框,所以宽即 cq。 */
function expectedRailWidth(panelW, expanded) {
  if (expanded) return T.railW
  return panelW <= T.railCollapseAt ? T.railCollapsedW : T.railW
}

/* ── 起核与种子(照 09-11 探针:壳自己装配 core,不另起 server)──────────── */

function readDiscovery(store) {
  try {
    return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8'))
  } catch {
    return undefined
  }
}

async function waitFor(label, predicate, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await delay(150)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后读数:${JSON.stringify(last)}`)
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

/* ── 页面内的量尺 ──────────────────────────────────────────────────────── */

const MEASURE = () => {
  const panel = document.querySelector('[data-testid="providers-panel"]')
  if (!panel) return { error: 'providers-panel 不在 DOM 里' }
  const num = (v) => +Number(v).toFixed(1)
  const cls = (el) => (typeof el?.className === 'string' ? el.className : '')
  const localName = (el) =>
    cls(el)
      .split(/\s+/)
      .filter(Boolean)
      .map((n) => n.replace(/^_/, '').replace(/_[A-Za-z0-9]{4,}(_\d+)?$/, ''))
      .join('.')
  const txt = (el, n = 20) => (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
  const tag = (el) => {
    const tid = el.getAttribute?.('data-testid')
    const t = txt(el)
    return `${el.tagName.toLowerCase()}.${localName(el) || '—'}${tid ? `[${tid}]` : ''}${t ? `「${t}」` : ''}`
  }
  const box = (el) => {
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: num(b.left), w: num(b.width), h: num(b.height), right: num(b.right) }
  }

  const rail = panel.querySelector('[data-testid="provider-rail"]')
  const detail = [...panel.children].find((el) => /detail/i.test(cls(el)))
  const detailHead = detail?.querySelector(':scope > [class*="head"]')
  const catalog = panel.querySelector('[class*="catalog"]')
  const catalogHead = catalog?.querySelector(':scope > [class*="head"]')
  const columnsRow = panel.querySelector('[class*="columns"]')
  const poolCard = [...panel.querySelectorAll('[class*="card"]')].find((el) =>
    el.querySelector('[class*="rotation"]'),
  )
  const rotation = panel.querySelector('[class*="rotation"]')
  const enable = detailHead?.querySelector('[class*="enable"]')

  /* 列数:列头行里**真有宽度**的格子(display:none 的宽高全 0)。 */
  const colCells = columnsRow ? [...columnsRow.children] : []
  const visibleCols = colCells.filter((el) => el.getBoundingClientRect().width > 0.5)
  const colNames = visibleCols.map(
    (el) => `${localName(el) || '·'}(${num(el.getBoundingClientRect().width)})`,
  )

  const panelRect = panel.getBoundingClientRect()
  const drawn = [...panel.querySelectorAll('*')].filter((el) => {
    const b = el.getBoundingClientRect()
    return b.width > 0 && b.height > 0
  })

  /*
   * **看得见的那一块**,不是几何矩形(gate-squeeze 首跑踩出来的那条口径):
   * 一个被祖先裁掉或滚出视窗的盒子,`getBoundingClientRect()` 仍停在原处,
   * 拿它去比会和外面的东西「相交」,而屏幕上那里什么都没有。所以沿祖先链
   * 逐层与 `overflow` 不为 visible 的祖先求交,裁完宽或高 ≤ 0 = 屏幕上根本没有它。
   */
  const visibleRect = (el) => {
    let b = el.getBoundingClientRect()
    let node = el.parentElement
    while (node && node !== document.documentElement) {
      const style = getComputedStyle(node)
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        const p = node.getBoundingClientRect()
        const left = Math.max(b.left, p.left)
        const right = Math.min(b.right, p.right)
        const top = Math.max(b.top, p.top)
        const bottom = Math.min(b.bottom, p.bottom)
        if (right - left <= 0 || bottom - top <= 0) return null
        b = { left, right, top, bottom, width: right - left, height: bottom - top }
      }
      node = node.parentElement
    }
    return b.width > 0 && b.height > 0 ? b : null
  }

  /* ① 最硬那条:有没有东西**画**到这块面的右缘外面去(裁掉的不算画)。 */
  const outOfPanel = []
  for (const el of drawn) {
    const v = visibleRect(el)
    if (!v || v.right <= panelRect.right + 1) continue
    outOfPanel.push({ el: tag(el), by: num(v.right - panelRect.right) })
  }

  /* ② 四个容器:内容装不装得下(scrollWidth > clientWidth = 装不下)。 */
  const fits = (el) =>
    !el || el.clientWidth <= 0
      ? null
      : { over: Math.max(0, el.scrollWidth - el.clientWidth), scrollW: el.scrollWidth, clientW: el.clientWidth }
  const boxes = {
    catalog: fits(catalog),
    catalogHead: fits(catalogHead),
    detailHead: fits(detailHead),
    poolCard: fits(poolCard),
  }

  /* ③ 行尾那三颗钮:矩形右缘必须在目录容器的右缘之内(切掉的滚不到)。 */
  const catalogRect = catalog?.getBoundingClientRect()
  const actionButtons = [...panel.querySelectorAll('[data-testid^="configure-"]')].map((el) => {
    const b = el.getBoundingClientRect()
    return {
      el: el.getAttribute('data-testid'),
      right: num(b.right),
      w: num(b.width),
      outside: catalogRect ? num(b.right - catalogRect.right) : 0,
    }
  })

  /* ④ 横滚:哪一层真能横着滚(收起档里一条都不该有;展开档里恰好该有一条)。 */
  const hscroll = []
  for (const el of drawn) {
    if (el.clientWidth <= 0 || el.scrollWidth <= el.clientWidth + 1) continue
    if (!/auto|scroll/.test(getComputedStyle(el).overflowX)) continue
    hscroll.push({
      el: tag(el),
      isDetailBody: el === detail?.querySelector(':scope > [class*="body"]'),
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
    })
  }

  return {
    panel: box(panel),
    rail: box(rail),
    railExpanded: rail?.getAttribute('data-expanded') === 'true',
    detail: box(detail),
    catalog: box(catalog),
    colCount: visibleCols.length,
    colNames,
    boxes,
    actionButtons,
    outOfPanel,
    hscroll,
    /* 收起档里名册行只画图标:`.text` 不在场(display:none → offsetParent 为 null)。 */
    rowTextShown: (() => {
      const text = panel.querySelector('[data-testid^="provider-row-"] [class*="text"]')
      return Boolean(text && text.getBoundingClientRect().width > 0.5)
    })(),
    /* 展开/收起钮在不在场(宽档 display:none)。 */
    toggleShown: (() => {
      const el = panel.querySelector('[data-testid="provider-rail-toggle"]')
      return Boolean(el && el.getBoundingClientRect().width > 0.5)
    })(),
    /* 详情头竖排了没有:开关整条落到下一行 = 它的 top 在名字的 bottom 之下。 */
    enableStacked: (() => {
      const name = detailHead?.querySelector('h2')
      if (!name || !enable) return false
      return enable.getBoundingClientRect().top >= name.getBoundingClientRect().bottom - 1
    })(),
    /* 轮换行两行了没有:选择器整条落到标签之下。 */
    rotationStacked: (() => {
      if (!rotation) return false
      const label = rotation.firstElementChild
      const select = rotation.lastElementChild
      if (!label || !select || label === select) return false
      return select.getBoundingClientRect().top >= label.getBoundingClientRect().bottom - 1
    })(),
  }
}

/* ── 手:拖浮窗(照 09-11 探针,CDP 之外不动真光标)────────────────────── */

const DRAG = async ({ what, dx }) => {
  const win = document.querySelector('[role="dialog"]')
  if (!win) return { error: '浮窗不在 DOM 里' }
  const wr = win.getBoundingClientRect()
  let target
  let from
  let y
  if (what === 'east') {
    const handles = [...win.children].filter((el) => el.getAttribute('aria-hidden') === 'true')
    target = handles.find((el) => {
      const b = el.getBoundingClientRect()
      return Math.abs(b.right - wr.right) < 12 && b.height > wr.height * 0.5
    })
    if (!target) return { error: `找不到东把手(把手 ${handles.length} 个)` }
    const b = target.getBoundingClientRect()
    from = b.left + b.width / 2
    y = b.top + b.height / 2
  } else {
    target =
      win.querySelector('[class*="strip"], [role="tablist"]')?.parentElement
      ?? win.querySelector('[class*="strip"]')
    if (!target) return { error: '找不到檐' }
    const b = target.getBoundingClientRect()
    from = b.right - 40
    y = b.top + b.height / 2
  }
  const to = from + dx
  const frame = () => new Promise((res) => requestAnimationFrame(res))
  const mk = (type, x) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      clientX: x,
      clientY: y,
    })
  target.dispatchEvent(mk('pointerdown', from))
  for (let i = 1; i <= 8; i += 1) {
    window.dispatchEvent(mk('pointermove', from + ((to - from) * i) / 8))
    await frame()
  }
  window.dispatchEvent(mk('pointerup', to))
  await frame()
  await frame()
  const after = win.getBoundingClientRect()
  return { x: +after.left.toFixed(1), w: +after.width.toFixed(1) }
}

async function panelBox(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="providers-panel"]')
    if (!el) return null
    const b = el.getBoundingClientRect()
    return { x: +b.left.toFixed(1), w: +b.width.toFixed(1), right: +b.right.toFixed(1) }
  })
}

async function moveFloatToLeft(page) {
  for (let round = 0; round < 4; round += 1) {
    const left = await page.evaluate(() => {
      const w = document.querySelector('[role="dialog"]')
      return w ? w.getBoundingClientRect().left : -1
    })
    if (Math.abs(left - 12) <= 2) return left
    const res = await page.evaluate(DRAG, { what: 'chrome', dx: Math.round(12 - left) })
    if (res?.error) throw new Error(res.error)
    await delay(200)
  }
  return page.evaluate(() => document.querySelector('[role="dialog"]').getBoundingClientRect().left)
}

async function setPanelWidthTo(page, want) {
  let box = await panelBox(page)
  for (let round = 0; round < 6 && Math.abs(box.w - want) > 1; round += 1) {
    const res = await page.evaluate(DRAG, { what: 'east', dx: Math.round(want - box.w) })
    if (res?.error) throw new Error(res.error)
    await delay(220)
    box = await panelBox(page)
  }
  return box
}

/* ── 判 ────────────────────────────────────────────────────────────────── */

function judgeBand(label, m, failures, { expectRailExpanded = false } = {}) {
  const say = (line) => failures.push(`${label}:${line}`)

  // ① 零元素出面板右缘。
  if (m.outOfPanel.length > 0) {
    say(
      `${m.outOfPanel.length} 件画到面板右缘外面`
        + ` —— ${m.outOfPanel.slice(0, 3).map((r) => `${r.el} 出 ${r.by}px`).join(' / ')}`,
    )
  }

  // ② 四个容器都装得下自己的内容。
  for (const [name, fit] of Object.entries(m.boxes)) {
    if (!fit) continue
    if (fit.over > 1) say(`${name} 装不下内容:scrollWidth ${fit.scrollW} > clientWidth ${fit.clientW}`)
  }

  // ③ 目录列数 = 按 token 现算的档。
  const wantCols = expectedColumns(m.catalog?.w ?? 0)
  if (m.colCount !== wantCols) {
    say(`目录 ${m.colCount} 列,按 token 现算该是 ${wantCols} 列(目录宽 ${m.catalog?.w})`)
  }

  // ④ 左栏宽 = 268 或 44。
  const wantRail = expectedRailWidth(m.panel?.w ?? 0, expectRailExpanded)
  if (Math.abs((m.rail?.w ?? 0) - wantRail) > 1) {
    say(`左栏宽 ${m.rail?.w},按 token 现算该是 ${wantRail}(面板 ${m.panel?.w})`)
  }
  // 收起档里名册行只画图标,展开/收起钮在场;宽档反过来。
  const collapsed = wantRail === T.railCollapsedW
  if (collapsed && m.rowTextShown) say('收起档里名册行的名字与副行还在屏幕上(该只剩图标)')
  if (!collapsed && !expectRailExpanded && m.toggleShown) {
    say('宽档里还画着展开/收起钮(那一档没有可展开的东西)')
  }

  // ⑤ 行尾三颗动作钮全在目录容器之内(切掉的滚不到 = 功能不可达)。
  if (m.actionButtons.length === 0) say('一颗行尾动作钮都没找到(种子或选择器坏了)')
  for (const b of m.actionButtons) {
    if (b.outside > 1) say(`动作钮 ${b.el} 右缘出目录 ${b.outside}px`)
    if (b.w < 1) say(`动作钮 ${b.el} 宽 ${b.w} —— 被挤没了`)
  }

  // ⑥ 面板里不许有横滚。
  if (m.hscroll.length > 0) {
    say(`${m.hscroll.length} 层能横滚 —— ${m.hscroll.slice(0, 2).map((r) => r.el).join(' / ')}`)
  }
}

function bandLine(want, m) {
  return (
    `  档 ${String(want).padStart(4)} → 面板 ${String(m.panel?.w).padStart(6)}`
    + ` / 左栏 ${String(m.rail?.w).padStart(5)} / 详情 ${String(m.detail?.w).padStart(6)}`
    + ` / 目录 ${String(m.catalog?.w).padStart(6)} / ${m.colCount} 列`
    + ` [${m.colNames.join(' ')}]`
    + ` / 出面板 ${m.outOfPanel.length} / 横滚 ${m.hscroll.length}`
  )
}

/* ── [9][10] 批 2:手填模型 = 目录条目 ─────────────────────────────────────── */

const MANUAL = 'foo-1'

async function spaceConfig(record) {
  const read = await rpc(record, 'spaces', 'getProviderSettings', { id: 'default' })
  return read?.ai?.providers?.[PROVIDER] ?? {}
}

async function catalogRow(record, id) {
  const listed = await rpc(record, 'models', 'getWithCapabilities', { providerId: PROVIDER })
  return (listed?.models ?? []).find((row) => row.id === id)
}

const rowShown = (page, id) =>
  page.evaluate((tid) => Boolean(document.querySelector(`[data-testid="model-row-${tid}"]`)), id)

/** 行里那颗勾选框 —— 原生 input 视觉上藏着(盒子是画出来的),点它等于点盒。 */
const clickRowCheckbox = (page, id) =>
  page.evaluate((tid) => {
    const box = document.querySelector(`[data-testid="model-row-${tid}"] input[type="checkbox"]`)
    if (!box) return false
    box.click()
    return true
  }, id)

const clickTestId = (page, tid) =>
  page.evaluate((t) => {
    const el = document.querySelector(`[data-testid="${t}"]`)
    if (!el) return false
    el.click()
    return true
  }, tid)

async function manualModelSteps(page, record, failures) {
  // 回到宽档再点:窄档里「设为当前」那一格也在,但宽档是这两步的常态。
  await setPanelWidthTo(page, BANDS[0])
  await delay(300)

  console.log(`[9] 手填 ${MANUAL} → 取消勾选:行还在、selectedModels 不含它`)
  await page.getByRole('button', { name: '＋ Add model' }).click()
  const input = page.getByPlaceholder('Model id, e.g. qwen3-max')
  await input.fill(MANUAL)
  await input.press('Enter')
  await waitFor(`${MANUAL} 那一行画出来`, () => rowShown(page, MANUAL))
  await waitFor(`${MANUAL} 进了这个空间的勾选`, async () =>
    (await spaceConfig(record)).selectedModels?.includes(MANUAL),
  )
  const added = await catalogRow(record, MANUAL)
  if (added?.source !== 'manual') failures.push(`[9] 手填之后目录口没有 source:'manual' 的 ${MANUAL}(读到 ${JSON.stringify(added)})`)

  if (!(await clickRowCheckbox(page, MANUAL))) failures.push(`[9] ${MANUAL} 那一行找不到勾选框`)
  await waitFor(`${MANUAL} 从勾选里去掉`, async () =>
    !(await spaceConfig(record)).selectedModels?.includes(MANUAL),
  )
  await delay(500)
  if (!(await rowShown(page, MANUAL))) failures.push(`[9] 取消勾选之后 ${MANUAL} 那一行没了(病根:手填只活在勾选里)`)
  const unticked = await catalogRow(record, MANUAL)
  if (unticked?.source !== 'manual') failures.push(`[9] 取消勾选之后目录口不再交出 ${MANUAL}`)
  const after9 = await spaceConfig(record)
  console.log(`  行在 ${await rowShown(page, MANUAL)} / selectedModels ${JSON.stringify(after9.selectedModels)} / 目录 ${unticked?.source}`)

  console.log(`[10] 勾上 ${MANUAL} 并设为当前 → 点 ✕:行没了、model 换人`)
  // ✕ 的守卫是「勾着的最后一个不许删」—— 先保证除它之外至少还勾着一个(第一个别的行)。
  const other = await page.evaluate((manual) => {
    const rows = [...document.querySelectorAll('[data-testid^="model-row-"]')]
    const row = rows.find((el) => el.getAttribute('data-testid') !== `model-row-${manual}`)
    return row?.getAttribute('data-testid')?.slice('model-row-'.length)
  }, MANUAL)
  if (!other) throw new Error('[10] 表里除手填那一行之外一行都没有')
  if (!(await spaceConfig(record)).selectedModels?.includes(other)) {
    await clickRowCheckbox(page, other)
    await waitFor(`${other} 勾上`, async () => (await spaceConfig(record)).selectedModels?.includes(other))
  }
  await clickRowCheckbox(page, MANUAL)
  await waitFor(`${MANUAL} 重新勾上`, async () => (await spaceConfig(record)).selectedModels?.includes(MANUAL))
  await waitFor(`「设为当前」钮就位`, () =>
    page.evaluate((t) => Boolean(document.querySelector(`[data-testid="set-current-${t}"]`)), MANUAL),
  )
  await clickTestId(page, `set-current-${MANUAL}`)
  await waitFor(`${MANUAL} 成了当前模型`, async () => (await spaceConfig(record)).model === MANUAL)
  await delay(300)
  const beforeRemove = await spaceConfig(record)
  const wantModel = (beforeRemove.selectedModels ?? []).filter((id) => id !== MANUAL)[0]
  if (!(await clickTestId(page, `remove-${MANUAL}`))) failures.push(`[10] ${MANUAL} 那一行没有 ✕`)
  await waitFor(`${MANUAL} 那一行消失`, async () => !(await rowShown(page, MANUAL)))
  const after10 = await waitFor('当前模型换人', async () => {
    const config = await spaceConfig(record)
    return config.model && config.model !== MANUAL ? config : undefined
  })
  if (after10.model !== wantModel) failures.push(`[10] ✕ 之后 model 是 ${after10.model},该落到剩下第一个勾选的 ${wantModel}`)
  if (after10.selectedModels?.includes(MANUAL)) failures.push(`[10] ✕ 之后 selectedModels 仍含 ${MANUAL}`)
  if (await catalogRow(record, MANUAL)) failures.push(`[10] ✕ 之后目录口仍交出 ${MANUAL}`)
  console.log(`  行在 ${await rowShown(page, MANUAL)} / model ${after10.model} / selectedModels ${JSON.stringify(after10.selectedModels)}`)
}

/* ── [11] §5.5:effective 只在后端折 ──────────────────────────────────────── */

const OVERRIDE_WINDOW = 200_000

async function effectiveOverrideStep(page, record, failures) {
  console.log(`[11] 手填 ${MANUAL} → 覆盖上下文 ${OVERRIDE_WINDOW}:目录口 effective 与读数环同一个数`)
  const added = await rpc(record, 'models', 'addManual', { providerId: PROVIDER, modelId: MANUAL, spaceId: 'default' })
  if (added?.success === false) throw new Error(`[11] 手填 ${MANUAL} 失败:${added.error}`)
  const cur = await rpc(record, 'spaces', 'getProviderSettings', { id: 'default' })
  const ai = cur?.ai
  const config = ai?.providers?.[PROVIDER] ?? {}
  const wrote = await rpc(record, 'spaces', 'setProviderSettings', {
    id: 'default',
    ai: {
      ...ai,
      providers: {
        ...ai.providers,
        [PROVIDER]: {
          ...config,
          contextLengthByModel: { ...(config.contextLengthByModel ?? {}), [MANUAL]: OVERRIDE_WINDOW },
        },
      },
    },
  })
  if (wrote?.success === false) throw new Error(`[11] 写覆盖失败:${wrote.error}`)

  for (const spaceId of [undefined, 'default']) {
    const listed = await rpc(record, 'models', 'getWithCapabilities', {
      providerId: PROVIDER,
      ...(spaceId ? { spaceId } : {}),
    })
    const row = (listed?.models ?? []).find((m) => m.id === MANUAL)
    const label = spaceId ? `spaceId=${spaceId}` : '缺省空间'
    if (row?.effective?.contextLength !== OVERRIDE_WINDOW) {
      failures.push(`[11] 目录口(${label})${MANUAL} 的 effective.contextLength 是 ${row?.effective?.contextLength},该是 ${OVERRIDE_WINDOW}`)
    }
    if (row?.effective?.source?.contextLength !== 'override') {
      failures.push(`[11] 目录口(${label})${MANUAL} 的 effective.source.contextLength 是 ${row?.effective?.source?.contextLength},该是 override`)
    }
    // 目录别的行也都带 effective(壳不再有别的读法)。
    const bare = (listed?.models ?? []).filter((m) => !m.effective).map((m) => m.id)
    if (bare.length > 0) failures.push(`[11] 目录口(${label})有 ${bare.length} 行没带 effective:${bare.slice(0, 3).join(', ')}`)
    console.log(`  目录口(${label}):effective ${JSON.stringify({ contextLength: row?.effective?.contextLength, source: row?.effective?.source?.contextLength })}`)
  }

  // 一条跑 deepseek/foo-1 的会话,进它的 composer 读圆环。
  const made = await rpc(record, 'sessions', 'create', { name: 'providers 门 · effective' })
  const sessionId = made?.session?.id
  if (!sessionId) throw new Error('[11] sessions.create 没给出会话 id')
  await rpc(record, 'sessions', 'updateModel', { sessionId, provider: PROVIDER, model: MANUAL })
  await waitFor('Dock 上的「会话总览」瓦就位', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
  )
  await clickTestId(page, 'dock-tile-sessions')
  await waitFor('总览画出这一条会话', () =>
    page.evaluate((id) => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), sessionId),
  )
  await clickTestId(page, `session-row-${sessionId}`)

  /** 这条会话那块 composer 里的读数环(role=img、aria-label 以 Context usage 开头)。 */
  const ringLabel = () =>
    page.evaluate(() => {
      const panels = [...document.querySelectorAll('[data-testid="composer-panel"]')]
      for (const panel of panels) {
        const ring = [...panel.querySelectorAll('[role="img"][aria-label]')].find((el) =>
          (el.getAttribute('aria-label') ?? '').startsWith('Context usage'),
        )
        if (ring && ring.getClientRects().length > 0) return ring.getAttribute('aria-label')
      }
      return null
    })
  let label
  try {
    label = await waitFor('读数环说「知道」(Context usage,不是 … unknown)', async () => {
      const value = await ringLabel()
      return value === 'Context usage' ? value : undefined
    }, 15_000)
  } catch {
    label = await ringLabel()
    failures.push(`[11] 读数环的 aria-label 是 ${JSON.stringify(label)} —— 窗口没到壳上(09-10 事故形状)`)
  }

  // 悬停卡:聚焦圆环 = 开卡(onFocus 与 onMouseEnter 一一对应),读「上下文」那一行。
  await page.evaluate(() => {
    const panels = [...document.querySelectorAll('[data-testid="composer-panel"]')]
    for (const panel of panels) {
      const ring = [...panel.querySelectorAll('[role="img"][aria-label]')].find((el) =>
        (el.getAttribute('aria-label') ?? '').startsWith('Context usage') && el.getClientRects().length > 0,
      )
      if (ring) {
        ring.focus()
        return
      }
    }
  })
  const want = '200k'
  let cardText = ''
  try {
    cardText = await waitFor(`悬停卡上的窗口写 ${want}`, async () => {
      const text = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid="composer-panel"], [class*="meterCard"]')]
          .map((el) => el.textContent ?? '')
          .join('\n'),
      )
      return text.includes(`/ ${want}`) ? text : undefined
    }, 10_000)
  } catch {
    failures.push(`[11] 读数环悬停卡上找不到「/ ${want}」—— 卡上的窗口不是后端 effective 那个数`)
  }
  const line = cardText.split('\n').find((t) => t.includes(`/ ${want}`)) ?? ''
  console.log(`  读数环 aria-label=${JSON.stringify(label)} / 卡上「${line.match(/Context[^\n]*?%/)?.[0] ?? line.slice(0, 60)}」`)
}

/* ── [12][13][14] 批 3:自定义服务商 + 参数建议 ──────────────────────────── */

/**
 * 精简的 models.dev 快照(缓存文件的形状,`models-dev-cache.ts`)。`openai/gpt-5.5` 是 [14]
 * 认亲的对象;deepseek 那两型让前面几步的目录照旧有目录行(从前那几步读的是真 models.dev)。
 */
const MODELS_DEV_SNAPSHOT = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: {
      'gpt-5.5': {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        limit: { context: 400000, output: 128000 },
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
      },
    },
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    models: {
      'deepseek-chat': {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        limit: { context: 128000, output: 8192 },
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
      },
      'deepseek-reasoner': {
        id: 'deepseek-reasoner',
        name: 'DeepSeek Reasoner',
        limit: { context: 128000, output: 65536 },
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
}

async function seedModelsDevCache(store) {
  const dir = path.join(store, 'cache')
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'models-dev.json'),
    JSON.stringify({ version: 1, fetchedAt: Date.now(), data: MODELS_DEV_SNAPSHOT }),
    'utf8',
  )
}

/** 本地假转发站:`GET /v1/models` 回 OpenAI 形,记下每一发的请求头。 */
async function startFakeRelay() {
  const requests = []
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: { ...req.headers } })
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'relay-alpha', object: 'model', context_length: 131072, top_provider: { max_completion_tokens: 8192 } },
          { id: 'relay-beta', object: 'model' },
        ],
      }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `no route ${req.method} ${req.url}` } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

const RELAY_KEY = 'sk-relay-gate-7f3a'
const SUGGEST_MODEL = 'gpt-5.5'

/**
 * 排在 [11] **之后**跑:[11] 在壳背后经 RPC 写 deepseek 的覆盖,它量的是「那一格目录此刻的订阅者」
 * 补拉回来的数 —— 这三步会把设置面的选中换成自定义那一家,排在它前面就换掉了它的前提。
 * [11] 开过会话总览,设置浮窗可能被盖着,所以这里的点击一律走 DOM(`clickTestId` / `domClick`),
 * 不走要求「指针够得着」的 Playwright `click()`。
 */
async function customProviderSteps(page, record, relay, failures) {
  const domClick = (locator) => locator.evaluate((el) => el.click())

  console.log('[12] 「＋ 自定义服务商」→ 指向本地假 /v1/models → 保存后目录自动拉一次')
  await clickTestId(page, 'provider-add-custom')
  await page.getByLabel('Name · required', { exact: true }).fill('Gate relay')
  await page.getByLabel('Base URL · required', { exact: true }).fill(relay.baseUrl)
  await page.getByLabel('API key · optional', { exact: true }).fill(RELAY_KEY)
  await clickTestId(page, 'custom-provider-advanced')
  // 请求头第一行:名 / 值两只框按序,「插入密钥」钮在同一行里(设置浮窗本身也是 role=dialog,
  // 所以按行的 testid 找,不按「对话框里叫 Name 的那只框」找)。
  const headerRow = page.locator('[data-testid="custom-header-row-0"]')
  await headerRow.locator('input').first().fill('X-Test')
  await domClick(headerRow.getByRole('button', { name: 'Insert key', exact: true }))
  await clickTestId(page, 'custom-provider-submit')

  const providerId = await waitFor('这个空间里多出那一家自定义服务商', async () => {
    const read = await rpc(record, 'spaces', 'getProviderSettings', { id: 'default' })
    return read?.ai?.customProviders?.find((item) => item.name === 'Gate relay')?.id
  })
  const custom = (await rpc(record, 'spaces', 'getProviderSettings', { id: 'default' }))
    .ai.customProviders.find((item) => item.id === providerId)
  if (custom?.dialect !== 'custom-openai') failures.push(`[12] 自定义服务商的 dialect 是 ${custom?.dialect},该是 custom-openai`)
  if (custom?.headers?.['X-Test'] !== '{{apiKey}}') {
    failures.push(`[12] 自定义头落盘是 ${JSON.stringify(custom?.headers)},该是明文模板 {"X-Test":"{{apiKey}}"}`)
  }

  await waitFor('目录区画出假站交来的 relay-alpha', () => rowShown(page, 'relay-alpha'))
  const listed = await rpc(record, 'models', 'getWithCapabilities', { providerId, spaceId: 'default' })
  const alpha = (listed?.models ?? []).find((row) => row.id === 'relay-alpha')
  const beta = (listed?.models ?? []).find((row) => row.id === 'relay-beta')
  if (alpha?.source !== 'endpoint') failures.push(`[12] relay-alpha 的 source 是 ${alpha?.source},该是 endpoint`)
  if (alpha?.effective?.contextLength !== 131072 || alpha?.effective?.source?.contextLength !== 'endpoint') {
    failures.push(`[12] relay-alpha 的 effective.contextLength=${alpha?.effective?.contextLength}(${alpha?.effective?.source?.contextLength}),该是 131072(endpoint)`)
  }
  if (beta?.effective?.capabilities?.tools !== null) {
    failures.push(`[12] relay-beta 接口没报工具,effective.capabilities.tools 该是 null(不知道),读到 ${beta?.effective?.capabilities?.tools}`)
  }
  console.log(`  ${providerId}:alpha ${alpha?.source} ctx ${alpha?.effective?.contextLength}(${alpha?.effective?.source?.contextLength}) / beta tools ${beta?.effective?.capabilities?.tools}`)

  console.log('[13] 假站收到的 X-Test 是替换后的密钥(不是字面 {{apiKey}})')
  const hit = relay.requests.find((request) => request.url === '/v1/models')
  if (!hit) failures.push('[13] 假站一发 /v1/models 都没收到')
  else {
    if (hit.headers['x-test'] !== RELAY_KEY) failures.push(`[13] X-Test 收到 ${JSON.stringify(hit.headers['x-test'])},该是密钥本身`)
    if (hit.headers.authorization !== `Bearer ${RELAY_KEY}`) failures.push(`[13] Authorization 收到 ${JSON.stringify(hit.headers.authorization)},该是默认 Bearer`)
    console.log(`  X-Test=${hit.headers['x-test'] === RELAY_KEY ? '<密钥>' : hit.headers['x-test']} / Authorization=${hit.headers.authorization ? 'Bearer <密钥>' : '(无)'}`)
  }

  console.log(`[14] 手填 ${SUGGEST_MODEL} → 行上有 ≈ 芯片 → 点上下文那枚 → 覆盖表有值、芯片消失`)
  await domClick(page.getByRole('button', { name: '＋ Add model' }))
  const input = page.getByPlaceholder('Model id, e.g. qwen3-max')
  await input.fill(SUGGEST_MODEL)
  await input.press('Enter')
  const chip = `suggest-ctx-${SUGGEST_MODEL}`
  const chipShown = () =>
    page.evaluate((tid) => Boolean(document.querySelector(`[data-testid="${tid}"]`)), chip)
  try {
    await waitFor(`${SUGGEST_MODEL} 那一行画出上下文建议芯片`, chipShown)
  } catch {
    failures.push(`[14] ${SUGGEST_MODEL} 那一行没有上下文建议芯片`)
    return
  }
  // 建议值读目录口那一行(认亲读的是 models.dev 缓存:种的那份,或起核后被刷新过的真目录 ——
  // 门判的是「点了 = 那个数进了覆盖表」,不是某一个写死的数)。
  const before = (await rpc(record, 'models', 'getWithCapabilities', { providerId, spaceId: 'default' }))
    ?.models?.find((row) => row.id === SUGGEST_MODEL)
  const want = before?.suggestion?.contextLength
  if (!want) {
    failures.push(`[14] 目录口 ${SUGGEST_MODEL} 那一行没有上下文建议:${JSON.stringify(before?.suggestion ?? null)}`)
    return
  }
  const chipState = await page.evaluate((tid) => {
    const el = document.querySelector(`[data-testid="${tid}"]`)
    return el ? { disabled: el.disabled, text: el.textContent } : null
  }, chip)
  await clickTestId(page, chip)
  try {
    await waitFor('这个空间的 contextLengthByModel 写进了建议值', async () => {
      const read = await rpc(record, 'spaces', 'getProviderSettings', { id: 'default' })
      return read?.ai?.providers?.[providerId]?.contextLengthByModel?.[SUGGEST_MODEL] === want
    })
  } catch {
    const read = await rpc(record, 'spaces', 'getProviderSettings', { id: 'default' })
    failures.push(
      `[14] 点了芯片(点之前 ${JSON.stringify(chipState)}),覆盖表没有写进建议值 ${want}:`
        + JSON.stringify(read?.ai?.providers?.[providerId] ?? null),
    )
    return
  }
  try {
    await waitFor('芯片消失(那一格不再是「不知道」)', async () => !(await chipShown()))
  } catch {
    failures.push(`[14] 应用之后 ${chip} 还在屏上`)
  }
  const after = (await rpc(record, 'models', 'getWithCapabilities', { providerId, spaceId: 'default' }))
    ?.models?.find((row) => row.id === SUGGEST_MODEL)
  if (after?.effective?.source?.contextLength !== 'override') {
    failures.push(`[14] 应用之后 effective.source.contextLength 是 ${after?.effective?.source?.contextLength},该是 override`)
  }
  if (after?.suggestion?.contextLength !== undefined) failures.push('[14] 应用之后目录口仍在建议上下文')
  console.log(`  应用后 ctx ${after?.effective?.contextLength}(${after?.effective?.source?.contextLength}) / 余下建议 ${JSON.stringify(after?.suggestion ?? null)}`)
}

async function main() {
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[providers-squeeze] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'pv-squeeze-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'pv-squeeze-userdata-'))
  let app
  let relay
  const failures = []
  try {
    await seedModelsDevCache(store)
    relay = await startFakeRelay()
    console.log('\n[1/4] 拉起应用(隔离 store + 独立 user-data-dir + 离屏)')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`, '--lang=en-US'],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store, ONETHING_CREDENTIALS_KEYRING: 'file',
        ONETHING_REACT_DEV_SERVER_URL: '',
        ONETHING_GATE_HEADLESS: '1',
      },
    })
    const page = await app.firstWindow()
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    const win = await app.browserWindow(page)
    await win.evaluate((w) => w.setMinimumSize(320, 480))
    await win.evaluate((w) => w.setSize(1400, 1000))
    await delay(400)

    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    const record = await waitFor('壳内嵌 core 写出发现文件', () => readDiscovery(store))

    console.log('[2/4] 种一家 deepseek + 四个模型(含一个长 id)+ 两把假钥匙')
    const cur = await rpc(record, 'spaces', 'getProviderSettings', { id: 'default' })
    const base = cur?.ai ?? { provider: '', providers: {}, customProviders: [] }
    const wrote = await rpc(record, 'spaces', 'setProviderSettings', {
      id: 'default',
      ai: {
        ...base,
        provider: PROVIDER,
        providers: {
          ...(base.providers ?? {}),
          [PROVIDER]: {
            ...(base.providers?.[PROVIDER] ?? {}),
            enabled: true,
            model: MODELS[0],
            selectedModels: MODELS,
            contextLengthByModel: {
              [MODELS[0]]: 65536,
              [MODELS[1]]: 131072,
              [MODELS[2]]: 262144,
              [MODELS[3]]: 32768,
            },
            maxOutputByModel: {
              [MODELS[0]]: 8192,
              [MODELS[1]]: 65536,
              [MODELS[2]]: 16384,
              [MODELS[3]]: 4096,
            },
            modelCapabilitiesByModel: {
              [MODELS[0]]: { tools: true, reasoning: true, fileInput: true },
              [MODELS[1]]: {
                tools: true,
                reasoning: true,
                vision: true,
                fileInput: true,
                audio: true,
                imageOutput: true,
              },
              [MODELS[2]]: { tools: true, vision: true },
              [MODELS[3]]: { vision: true },
            },
          },
        },
        customProviders: base.customProviders ?? [],
      },
    })
    if (wrote?.success === false) throw new Error(`种设置失败:${wrote.error}`)
    for (const [apiKey, label] of [
      ['sk-gate-aaaaaaaaaaaaaaaaaaaa1111', 'primary'],
      ['sk-gate-bbbbbbbbbbbbbbbbbbbb2222', 'backup'],
    ]) {
      const done = await rpc(record, 'spaces', 'setCredential', {
        id: 'default',
        providerId: PROVIDER,
        apiKey,
        label,
      })
      if (done?.success === false) throw new Error(`灌 key 失败:${done.error}`)
    }

    console.log('[3/4] 开成浮窗、选中 deepseek、把窗贴到视口左缘')
    // 模型服务不再是一块单独的瓦(`stage/items.ts` 的 PROVIDERS_ITEM_ID 判词):
    // 点设置那块瓦 → 点导航里的模型服务,与 `gate:credential-pool` 同一条路。
    await waitFor('Dock 上的设置瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-settings"]'))),
    )
    await page.evaluate(() => document.querySelector('[data-testid="dock-tile-settings"]').click())
    await waitFor('设置页就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="settings-nav-models"]'))),
    )
    await page.evaluate(() => document.querySelector('[data-testid="settings-nav-models"]').click())
    await waitFor('名册画出 deepseek 行', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="provider-row-deepseek"]'))),
    )
    await page.evaluate(() => document.querySelector('[data-testid="provider-row-deepseek"]').click())
    await waitFor('目录行画出来了', () =>
      page.evaluate(() => document.querySelectorAll('[data-testid^="model-row-"]').length > 0),
    )
    await moveFloatToLeft(page)
    // 指针挪开:hover 会把行尾动作钮的可见性换掉,而这道门量的是常态排版。
    await page.mouse.move(4, 4)
    await delay(400)

    console.log(
      `[4/4] 六档 + 地板 + 展开态(阈值:收左栏 ≤${T.railCollapseAt} / 目录 ${T.narrow}·${T.tight}·${T.bare}·${T.bones} / 地板 ${T.floor} / 面板地板 ${T.panelMin})`,
    )
    for (const want of BANDS) {
      await setPanelWidthTo(page, want)
      await delay(350)
      const m = await page.evaluate(MEASURE)
      if (m.error) throw new Error(m.error)
      console.log(bandLine(want, m))
      judgeBand(`档 ${want}`, m, failures)
    }

    /* [7] 面板地板:律四那句「你说你能活到 502」。 */
    await setPanelWidthTo(page, T.panelMin)
    await delay(350)
    const atFloor = await page.evaluate(MEASURE)
    console.log(bandLine(T.panelMin, atFloor))
    judgeBand(`地板 ${T.panelMin}`, atFloor, failures)
    if (expectedColumns(atFloor.catalog?.w ?? 0) !== 3) {
      failures.push(`地板 ${T.panelMin}:目录在地板上不是三列(宽 ${atFloor.catalog?.w})`)
    }

    /* [8] 临时展开左栏 —— `@container providers-detail` 两条规则唯一到得了的路。 */
    await page.evaluate(() =>
      document.querySelector('[data-testid="provider-rail-toggle"]')?.click(),
    )
    await delay(350)
    const expanded = await page.evaluate(MEASURE)
    console.log(
      `  展开左栏 → 面板 ${expanded.panel?.w} / 左栏 ${expanded.rail?.w}`
        + ` / 详情 ${expanded.detail?.w}(阈值 ${T.detailStack})`
        + ` / 目录 ${expanded.catalog?.w}(地板 ${T.floor})`
        + ` / 详情头竖排 ${expanded.enableStacked} / 轮换两行 ${expanded.rotationStacked}`
        + ` / 出面板 ${expanded.outOfPanel.length} / 横滚 ${expanded.hscroll.length}`,
    )
    if (!expanded.railExpanded) failures.push('展开态:点了那颗钮,左栏没有撑开')
    if (expanded.outOfPanel.length > 0) {
      failures.push(
        `展开态:${expanded.outOfPanel.length} 件画到面板右缘外面`
          + ` —— ${expanded.outOfPanel.slice(0, 3).map((r) => `${r.el} 出 ${r.by}px`).join(' / ')}`,
      )
    }
    if ((expanded.detail?.w ?? 0) <= T.detailStack) {
      // 这一步的全部意义就是把详情列压到阈值之下 —— 压不下去那两条规则就没验过。
      if (!expanded.enableStacked) failures.push('展开态:详情头没有竖排(启用开关还在名字那一行)')
      if (!expanded.rotationStacked) failures.push('展开态:轮换行没有改两行')
      /*
       * 目录顶着它的地板(400)不肯再窄,于是详情列**必须**给出一条横滚 ——
       * 这正是「切掉的滚不到 = 功能不可达」的反面:滚得到就不算切掉。
       * 少了这一句,`.catalog` 的 `min-width` 就可能悄悄变成一次更大的 `overflow: clip`。
       */
      if ((expanded.catalog?.w ?? 0) + 1 < T.floor) {
        failures.push(`展开态:目录 ${expanded.catalog?.w} 掉到地板 ${T.floor} 之下了`)
      }
      const bodyScrolls = expanded.hscroll.filter((r) => r.isDetailBody)
      if (bodyScrolls.length !== 1) {
        failures.push(
          '展开态:详情列没有给出横滚 —— 目录顶着地板却滚不到,那就是把动作列切掉了'
            + `(此刻能横滚的层:${expanded.hscroll.length})`,
        )
      }
      if (expanded.hscroll.length !== bodyScrolls.length) {
        failures.push(`展开态:横滚不止详情列那一层(${expanded.hscroll.length} 层)`)
      }
    } else {
      failures.push(
        `展开态:详情列 ${expanded.detail?.w} 仍高于 ${T.detailStack}`
          + ' —— 这一步没能把那两条规则逼出来,门等于没验',
      )
    }
    // 再点一次收回(顺手把「两条路都收得回」也量了)。
    await page.evaluate(() =>
      document.querySelector('[data-testid="provider-rail-toggle"]')?.click(),
    )
    await delay(300)
    const back = await page.evaluate(MEASURE)
    if (back.railExpanded) failures.push('展开态:再点一次没有收回去')

    await manualModelSteps(page, record, failures)
    await effectiveOverrideStep(page, record, failures)
    await customProviderSteps(page, record, relay, failures)
  } finally {
    if (app) await app.close().catch(() => {})
    if (relay) await relay.close().catch(() => {})
    await delay(500)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\n[providers-squeeze] FAILED —— ${failures.length} 条:`)
    for (const line of failures) console.error(`  · ${line}`)
    console.error(
      '\n  律四:每块面在自己声明的最小宽度下零重叠,变窄的次序是「先截断,再有序降元素」。'
        + '\n  法条见 docs/design/react-shell-squeeze-rules-2026-08.md;阈值算式在 tokens.css 的 --pv-catalog-* 一节。',
    )
    process.exit(1)
  }
  console.log(`\n[providers-squeeze] ok —— ${BANDS.length} 档 + 地板 + 展开态,全部零溢出、列数与左栏宽逐档对上`)
}

main().catch((error) => {
  console.error('\n[providers-squeeze] FAILED:', error?.stack || error)
  process.exit(1)
})
