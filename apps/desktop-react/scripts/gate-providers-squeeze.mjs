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
 * 另外两步不在六档里:
 *   [7] **面板地板**:把面板拖到 `--pv-panel-min`,律四要的就是这一句话 ——
 *       「你说你能活到 502,那就在 502 上零溢出」。
 *   [8] **临时展开左栏**:这是 `@container providers-detail` 那两条规则唯一到得了
 *       的路(详情列 = 面板 − 268)。不量它,那两条规则就是没人验过的声明。
 *
 * 跑法:`node scripts/gate-providers-squeeze.mjs`(先 `npm run app:build`)。
 * 可重复:每次一个全新的临时 store + 全新的 `--user-data-dir`,跑完删干净;
 * 窗口离屏起、焦点由 CDP 补(「真机门不许抢用户的机器」),不连 5175、不碰 ~/.onething。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
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

async function main() {
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[providers-squeeze] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'pv-squeeze-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'pv-squeeze-userdata-'))
  let app
  const failures = []
  try {
    console.log('\n[1/4] 拉起应用(隔离 store + 独立 user-data-dir + 离屏)')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`, '--lang=en-US'],
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
    await waitFor('Dock 上的 providers 瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-providers"]'))),
    )
    await page.evaluate(() => document.querySelector('[data-testid="dock-tile-providers"]').click())
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
  } finally {
    if (app) await app.close().catch(() => {})
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
