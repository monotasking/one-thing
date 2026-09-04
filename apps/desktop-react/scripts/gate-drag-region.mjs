#!/usr/bin/env node
/**
 * **窗口拖拽区的真机门**(W1-b,设计 `docs/design/workbench-2026-09.md` §2.2)。
 *
 * 立这道门的直接理由:W1-b 把中央区的檐整条搬进了窗口顶栏,而顶栏**就是这扇窗
 * 唯一能拖动的地方**(`titleBarStyle: 'hiddenInset'`,系统标题栏已摘)。于是那条带上
 * 多了一批可点的东西,而 `-webkit-app-region` 的三条判例每一条都是**静默**破的:
 *
 *  ① `no-drag` 摘掉的是一块**面积**。08-31 真机探针读到 `traffic {w:80, h:0}` ——
 *     屏幕上一模一样、单测全绿(它量的是声明,不是排出来的盒),那 80px 却照样是
 *     拖拽把手,点红绿灯变成拖窗。所以这道门量的是**排出来的盒**。
 *  ② `no-drag` 只在 drag 元素**同一分支的子孙**上才生效。标签组一旦 portal 到
 *     body,那句声明还在、屏幕上一个像素都不差,拖拽当场破。
 *  ③ 组与组之间、红绿灯与右端动作组之外的空白**仍然要能拖窗**(设计原话)。
 *     顺手在带子上写一句 no-drag,这条带就再也拖不动了 —— 也看不出来。
 *
 * ── 这道门量什么、不量什么 ────────────────────────────────────────────────
 *
 * **CDP 半边(缺省跑的这一半)**:真 Electron、真排版、真 computed style。
 *  · `.traffic` 排出来的盒 w>0 **且** h>0(判例 ①);
 *  · 每一组标签、每一条 tab、尾格动作组:computed `-webkit-app-region` = `no-drag`,
 *    而且 `closest('[data-testid="topbar"]')` 非空(判例 ②。选择器用 testid 而不是
 *    `.bar` —— CSS Modules 的类名是哈希过的,`.bar` 在真机上根本不存在);
 *  · 组与组之间的空白、组右边到尾格之间的空白:那一点上**生效的**区域是 `drag`
 *    (判例 ③。`-webkit-app-region` 不继承,所以判据是「从这一点向上找到的第一个
 *    声明过它的祖先」——那正是 Chromium 算拖拽区的口径);
 *  · **几何**:每一组的 left/width 与它所代表的那片叶的 `getBoundingClientRect()`
 *    相差 ≤ 1px(夹到带子两端之后 —— 中央区在没有左架子时是从 x=0 起的,而带子
 *    从红绿灯让位之后才起,那一段的夹紧是**设计要的**,不是偏差);
 *    分屏成两片、开一条右架子、拖一次分隔杆之后各重量一次。
 *
 * **CGEvent 半边(默认不跑)**:`ONETHING_GATE_REAL_MOUSE=1` 才开。
 * ⚠️ **它会动真鼠标**:在窗口标题栏上按下、拖一段、松开,量窗口位置有没有跟着走。
 * 这是 `-webkit-app-region` 唯一真正的验收 —— 它在浏览器里没有任何可观察的运行
 * 后果,CDP 注入的鼠标事件也到不了窗口管理器那一层。但系统级合成输入会抢用户的
 * 机器(09-01 判例:用户被迫杀掉全部任务),所以**它必须由用户点头才跑**,
 * 而且这一批交卷时没有跑过。今天开着这个开关只会打出一行说明并跳过 —— 真要跑,
 * 得先把这一段实现完,并当面告知「本段会动真鼠标」。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 * 真 Electron + 隔离 `--user-data-dir` + 一次性临时 store,跑完删干净;
 * 窗子**离屏**起(`ONETHING_GATE_HEADLESS=1`),焦点由 CDP
 * `Emulation.setFocusEmulationEnabled` 补 —— 门不许抢用户的机器。
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

const EXPECT_RED = process.argv.includes('--expect-red')
/** ⚠️ 开它 = 允许这道门**动真鼠标**。见文件头。 */
const REAL_MOUSE = process.env.ONETHING_GATE_REAL_MOUSE === '1'

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
    last = await Promise.resolve()
      .then(predicate)
      .catch((error) => ({ pending: String(error?.message ?? error) }))
    if (last && !last.pending) return last
    await delay(150)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}

async function rpc(record, domain, method, payload = {}) {
  const res = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(record.token ? { authorization: `Bearer ${record.token}` } : {}),
    },
    body: JSON.stringify({ domain, method, payload }),
  })
  if (!res.ok) throw new Error(`rpc ${domain}.${method} HTTP ${res.status}`)
  const body = await res.json()
  if (!body || body.ok !== true) {
    throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  }
  return body.data
}

/** 与 gate-files 同一条理由:用 element.click() 绕开可操作性判定,派发的仍是真事件。 */
async function clickSelector(page, selector) {
  const clicked = await page.evaluate((css) => {
    const el = document.querySelector(css)
    if (!el) return false
    el.click()
    return true
  }, selector)
  if (!clicked) throw new Error(`点不到:${selector} 不在 DOM 里`)
}

/* ── 记分板 ───────────────────────────────────────────────────────────── */

const scenarios = []
let current = null

function scenario(name) {
  current = { name, checks: [] }
  scenarios.push(current)
  console.log(`\n[场景 ${scenarios.length}] ${name}`)
}

function assert(ok, message, detail) {
  current.checks.push({ ok: Boolean(ok), message, detail })
  console.log(`  ${ok ? '✓' : '✗'} ${message}${detail ? `  ${detail}` : ''}`)
}

function skip(message, why) {
  current.checks.push({ ok: true, skipped: true, message, detail: why })
  console.log(`  ⊘ ${message}(${why})`)
}

/**
 * **这一点上生效的拖拽区**。`-webkit-app-region` 不继承,所以「这一点能不能拖窗」
 * 的判据不是那个元素自己的 computed 值,而是**从它往上找到的第一个声明过它的
 * 祖先** —— 那正是 Chromium 算拖拽区的口径(声明 drag 的元素把自己的边框盒加进
 * 拖拽区,声明 no-drag 的减出去,没声明的两不管)。
 */
const REGION_AT = `(x, y) => {
  let el = document.elementFromPoint(x, y)
  const chain = []
  while (el) {
    const v = getComputedStyle(el).getPropertyValue('-webkit-app-region').trim()
    chain.push((el.dataset && el.dataset.testid) || el.tagName)
    if (v && v !== 'none') return { region: v, at: chain[chain.length - 1], chain }
    el = el.parentElement
  }
  return { region: 'none', at: chain[0] ?? null, chain }
}`

/**
 * 顶栏此刻的全景读数:让位块、每一组标签、每一条 tab、尾格。
 *
 * 它是一**串源码**而不是一个函数,理由与 `REGION_AT` 相同:playwright 的
 * `page.evaluate` 收字符串时把它当**表达式**求值 —— 直接递一个箭头函数进去
 * 只会得到那个函数本身(序列化成 undefined,而且一声不吭)。所以调用点一律是
 * `(${'${源码}'})()`,由 `topbarShot()` 那一句包好,别处不再拼。
 */
const TOPBAR_SHOT = `() => {
  const round = (r) => ({
    left: Math.round(r.left), right: Math.round(r.right),
    top: Math.round(r.top), bottom: Math.round(r.bottom),
    width: Math.round(r.width), height: Math.round(r.height),
  })
  const region = (el) => getComputedStyle(el).getPropertyValue('-webkit-app-region').trim()
  const bar = document.querySelector('[data-testid="topbar"]')
  const band = document.querySelector('[data-testid="topbar-tabs"]')
  const trailing = document.querySelector('[data-testid="topbar-trailing"]')
  const traffic = document.querySelector('[data-testid="topbar-traffic"]')
  if (!bar || !band) return { error: '顶栏或标签带不在场' }
  /* **从整份文档里找组,不是只在带子里找** —— portal 出去的那一形要报得出
     「它跑了」,而不是含糊的「0 组」(两种破法的读数必须分得开)。 */
  const groups = Array.from(document.querySelectorAll('[data-topbar-leaf]')).map((g) => {
    const id = g.getAttribute('data-topbar-leaf')
    const slot = document.querySelector('[data-pane-region="center"] [data-pane-slot="' + id + '"]')
    const tabs = Array.from(g.querySelectorAll('[role="tab"]')).map((t) => ({
      text: (t.textContent || '').trim().slice(0, 24),
      box: round(t.getBoundingClientRect()),
      region: region(t),
      inBar: Boolean(t.closest('[data-testid="topbar"]')),
      selected: t.getAttribute('aria-selected') === 'true',
    }))
    return {
      id,
      box: round(g.getBoundingClientRect()),
      region: region(g),
      inBar: Boolean(g.closest('[data-testid="topbar"]')),
      inBand: band.contains(g),
      leaf: slot ? round(slot.getBoundingClientRect()) : null,
      tabs,
      /* 这一组里 tab 右边那一截空白 —— 它必须**还能拖窗**。 */
      blankX: tabs.length
        ? Math.round((Math.max(...tabs.map((t) => t.box.right)) + g.getBoundingClientRect().right) / 2)
        : null,
      tabsRight: tabs.length ? Math.max(...tabs.map((t) => t.box.right)) : null,
    }
  })
  return {
    bar: round(bar.getBoundingClientRect()),
    barRegion: region(bar),
    band: round(band.getBoundingClientRect()),
    bandRegion: region(band),
    traffic: traffic ? { box: round(traffic.getBoundingClientRect()), region: region(traffic) } : null,
    trailing: trailing
      ? { box: round(trailing.getBoundingClientRect()), region: region(trailing), inBar: Boolean(trailing.closest('[data-testid="topbar"]')) }
      : null,
    groups,
  }
}`

/** 取一次顶栏全景。见 `TOPBAR_SHOT` 头上那条「字符串是表达式」的判例。 */
const topbarShot = (page) => page.evaluate(`(${TOPBAR_SHOT})()`)

/**
 * 一组标签**该**落在哪儿:那片叶的跨度,夹到带子的两端。
 * 夹紧本身是设计要的(§2.2:左右架子上方不放标签;红绿灯那一段只有让位与拖拽区),
 * 所以门量的是**夹过之后**的期望值,不是叶的原始矩形。
 */
function expectedBox(group, band) {
  if (!group.leaf) return null
  const left = Math.max(group.leaf.left, band.left)
  const right = Math.min(group.leaf.right, band.right)
  return { left, right: Math.max(left, right) }
}

function checkAlignment(shot, where) {
  if (shot.error) {
    skip(`${where}:标签组与叶对齐`, shot.error)
    return
  }
  for (const group of shot.groups) {
    const want = expectedBox(group, shot.band)
    if (!want) {
      skip(`${where}:组 ${group.id} 与叶对齐`, '这一组在中央区里找不到对应的格子')
      continue
    }
    const dLeft = Math.abs(group.box.left - want.left)
    const dRight = Math.abs(group.box.right - want.right)
    assert(
      dLeft <= 1 && dRight <= 1,
      `${where}:组 ${group.id} 精确坐在那片叶正上方(±1px)`,
      `(组 ${group.box.left}–${group.box.right} / 期望 ${want.left}–${want.right};叶 ${group.leaf.left}–${group.leaf.right},带 ${shot.band.left}–${shot.band.right})`,
    )
  }
  // 两组之间零重叠 —— 顶栏上两组标签压在一起是这条落位规则唯一不许出的错。
  const sorted = [...shot.groups].sort((a, b) => a.box.left - b.box.left)
  let overlap = null
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].box.left < sorted[i - 1].box.right - 1) {
      overlap = `${sorted[i - 1].id}(至 ${sorted[i - 1].box.right})与 ${sorted[i].id}(自 ${sorted[i].box.left})`
    }
  }
  if (shot.groups.length > 1) {
    assert(!overlap, `${where}:组与组零重叠`, overlap ? `(${overlap})` : `(${shot.groups.length} 组)`)
  }
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[drag-region-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[drag-region-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const shotDir = path.join(appRoot, 'dist/gate-shots')
  await mkdir(shotDir, { recursive: true })
  const store = await mkdtemp(path.join(tmpdir(), 'drag-gate-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'drag-gate-userdata-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'drag-gate-ws-'))
  let server
  let app
  try {
    // 一棵最小的树:分屏要「叶里有两格 tab」才切得动,所以至少开得出两个文件。
    await writeFile(path.join(workspaceRoot, 'a.ts'), "export const gate = 'drag'\n")
    await writeFile(path.join(workspaceRoot, 'b.ts'), "export const other = 'drag'\n")
    await mkdir(path.join(workspaceRoot, 'notes'), { recursive: true })
    await writeFile(path.join(workspaceRoot, 'notes', 'alpha.md'), '# alpha\n')

    console.log('[1/3] 起一台 core')
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

    const created = await rpc(record, 'sessions', 'create', { name: 'drag-region-gate' })
    const sessionId = created?.session?.id
    if (!sessionId) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(created)}`)
    await rpc(record, 'sessions', 'updateWorkingDirectory', {
      sessionId,
      workingDirectory: workspaceRoot,
    })

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
    // 进那条夹具会话(门要走用户真正走的那条路;文件树的根跟着当前会话的工作目录走)。
    await waitFor('总览画出那一行', () =>
      page.evaluate((id) => Boolean(document.querySelector(`[data-session-id="${id}"]`)), sessionId),
    ).catch(async () => {
      await clickSelector(page, '[data-testid="dock-tile-sessions"]')
      await delay(700)
    })
    await clickSelector(page, `[data-testid="session-row-${sessionId}"]`).catch(() => {})
    await delay(500)

    console.log('[3/3] 逐个场景')

    /* ── 场景 1:让位块排出来的盒 ───────────────────────────────────────── */
    scenario('红绿灯让位:量的是**排出来的盒**,不是声明(80×0 血案)')
    let shot = await topbarShot(page)
    if (shot.error) throw new Error(`顶栏读不到:${shot.error}`)
    console.log(`  · 顶栏 ${shot.bar.left}–${shot.bar.right} 高 ${shot.bar.height};带 ${shot.band.left}–${shot.band.right}`)
    if (!shot.traffic) {
      skip('让位块排出来的盒 w>0 且 h>0', '这台上没有让位块')
    } else {
      assert(
        shot.traffic.box.width > 0 && shot.traffic.box.height > 0,
        '让位块排出来的盒 w>0 **且** h>0(h=0 等于什么都没摘)',
        `(${shot.traffic.box.width}×${shot.traffic.box.height})`,
      )
      assert(
        shot.traffic.region === 'no-drag',
        '让位块 computed `-webkit-app-region` = no-drag(拖到灯上是按灯,不是拖窗)',
        `(${shot.traffic.region || '—'})`,
      )
    }
    assert(shot.barRegion === 'drag', '带本身是 drag —— 这扇窗唯一拖得动的地方', `(${shot.barRegion || '—'})`)

    /* ── 场景 2:可点的每一件都 no-drag,而且都在带子里 ─────────────────── */
    scenario('每一件可点的都 no-drag,而且是拖拽带**同一分支的子孙**(portal 出去当场静默破)')
    assert(shot.groups.length > 0, '顶栏上画得出标签组', `(${shot.groups.length} 组)`)
    for (const group of shot.groups) {
      /*
       * **组自己不许 no-drag**(施工时先写错过一次,这道门当场抓出来):组铺满
       * 那片叶的整段跨度,tab 只占左边一小截 —— 在组上写 no-drag 等于把
       * 「红绿灯与动作组之外的空白仍是拖窗区」整条抹掉,单叶那一形下顶栏从灯到
       * AgentChip 之间一处都拖不动,而屏幕上一个像素看不出来。
       */
      assert(
        group.region !== 'no-drag' && group.inBar && group.inBand,
        `组 ${group.id}:在带子里,而且**组自己不是 no-drag**(组里的空白要还能拖窗)`,
        `(region ${group.region || 'none'} / inBar ${group.inBar} / inBand ${group.inBand})`,
      )
      for (const tab of group.tabs) {
        assert(
          tab.region === 'no-drag' && tab.inBar,
          `  tab「${tab.text || '—'}」:no-drag 且在带子里`,
          `(region ${tab.region || '—'})`,
        )
      }
    }
    if (!shot.trailing) {
      skip('尾格动作组 no-drag', '尾格不在场')
    } else {
      assert(
        shot.trailing.region === 'no-drag' && shot.trailing.inBar,
        '尾格(焦点叶的动作组 + AgentChip):no-drag 且在带子里',
        `(region ${shot.trailing.region || '—'})`,
      )
    }

    /* ── 场景 3:空白仍然拖得动 ─────────────────────────────────────────── */
    scenario('组之间与让位之外的空白**仍是拖窗区**(顺手在带子上写一句 no-drag 就整条拖不动)')
    assert(
      shot.bandRegion === '' || shot.bandRegion === 'none' || shot.bandRegion === 'auto',
      '带子自己不声明 app-region —— 它让顶栏那句 drag 透下来',
      `(${shot.bandRegion || 'none'})`,
    )
    const midY = Math.round((shot.bar.top + shot.bar.bottom) / 2)
    /*
     * 取样点:①最后一组的右缘与尾格左缘之间(组与动作组之间那一截);
     * ②两组之间(分屏之后才有,这里先量①)。都要答 drag。
     */
    const lastGroup = shot.groups[shot.groups.length - 1]
    const gapX = lastGroup && shot.trailing
      ? Math.round((Math.max(lastGroup.box.right, shot.band.left) + shot.trailing.box.left) / 2)
      : null
    if (gapX === null || gapX <= lastGroup.box.right || gapX >= shot.trailing.box.left) {
      skip('组右边到尾格之间的空白仍是 drag', '这一形下那一截宽度不足以取点')
    } else {
      const at = await page.evaluate(`(${REGION_AT})(${gapX}, ${midY})`)
      assert(
        at.region === 'drag',
        '组右边到尾格之间的空白:那一点上生效的是 drag',
        `(x=${gapX} → ${at.region} @ ${at.at};链 ${at.chain.slice(0, 3).join(' < ')})`,
      )
    }
    if (shot.traffic && shot.traffic.box.width > 2) {
      const at = await page.evaluate(
        `(${REGION_AT})(${Math.round(shot.traffic.box.left + shot.traffic.box.width / 2)}, ${midY})`,
      )
      assert(
        at.region === 'no-drag',
        '红绿灯那一段:那一点上生效的是 no-drag(点灯不是拖窗)',
        `(→ ${at.region} @ ${at.at})`,
      )
    }
    if (lastGroup && lastGroup.tabs.length > 0) {
      const tab = lastGroup.tabs[0]
      const at = await page.evaluate(
        `(${REGION_AT})(${Math.round(tab.box.left + tab.box.width / 2)}, ${Math.round((tab.box.top + tab.box.bottom) / 2)})`,
      )
      assert(
        at.region === 'no-drag',
        '标签上:那一点上生效的是 no-drag(点标签不是拖窗)',
        `(→ ${at.region} @ ${at.at})`,
      )
    }
    /*
     * **单叶那一形最要紧的一条**:一组铺满整条带子,tab 只占左边一小截。
     * 组里 tab 右边那一大片必须**还能拖窗** —— 少了这一条,顶栏从红绿灯到
     * AgentChip 之间一处都拖不动,而屏幕上一个像素都看不出来(施工时真踩过)。
     */
    for (const group of shot.groups) {
      if (group.blankX === null || group.blankX <= group.tabsRight + 2) {
        skip(`组 ${group.id} 里 tab 右边那片空白仍是 drag`, 'tab 铺满了这一组,没有空白可取点')
        continue
      }
      const at = await page.evaluate(`(${REGION_AT})(${group.blankX}, ${midY})`)
      assert(
        at.region === 'drag',
        `组 ${group.id} 里 tab 右边那片空白:那一点上生效的是 drag(**这是最容易写死的一格**)`,
        `(x=${group.blankX} → ${at.region} @ ${at.at})`,
      )
    }

    /* ── 场景 4:单叶的几何 ─────────────────────────────────────────────── */
    scenario('单叶:那一组精确坐在那片叶正上方(夹到带子两端)')
    checkAlignment(shot, '单叶')
    // 留一张**连体**的相片:活动标签与它下面那片叶同一底色、无下边、盖住顶栏底线。
    await page.screenshot({ path: path.join(shotDir, 'topbar-tabs-single.png') })

    /* ── 场景 5:分屏成两片 ─────────────────────────────────────────────── */
    scenario('分屏两片:两组各坐各的、零重叠;组之间的空白仍是拖窗区')
    const opened = await openTwoTabsInCenter(page)
    if (!opened.ok) {
      skip('分屏两片之后重量', opened.why)
    } else {
      const split = await splitFocusLeaf(page)
      if (!split.ok) {
        skip('分屏两片之后重量', split.why)
      } else {
        await delay(500)
        shot = await topbarShot(page)
        assert(shot.groups.length === 2, '分屏之后顶栏上是两组', `(${shot.groups.length} 组)`)
        checkAlignment(shot, '分屏两片')
        await page.screenshot({ path: path.join(shotDir, 'topbar-tabs-split.png') })
        if (shot.groups.length === 2) {
          const sorted = [...shot.groups].sort((a, b) => a.box.left - b.box.left)
          const between = Math.round((sorted[0].box.right + sorted[1].box.left) / 2)
          if (sorted[1].box.left - sorted[0].box.right >= 2) {
            const at = await page.evaluate(`(${REGION_AT})(${between}, ${midY})`)
            assert(
              at.region === 'drag',
              '两组之间那一截空白:那一点上生效的是 drag',
              `(x=${between} → ${at.region} @ ${at.at})`,
            )
          } else {
            skip('两组之间那一截空白仍是 drag', '两组紧挨着,量不出中间那一点')
          }
        }
      }
    }

    /* ── 场景 6:架子收展 / 拖比例之后重量一次 ──────────────────────────── */
    scenario('架子收展、拖分隔杆之后**重量一次**仍然对齐(几何不重算 = 这里红)')
    const shelved = await pinFilesToRightEdge(page)
    if (!shelved.ok) {
      skip('开一条右架子之后重量', shelved.why)
    } else {
      await delay(600)
      const after = await topbarShot(page)
      console.log(`  · 开架子后带 ${after.band.left}–${after.band.right}`)
      checkAlignment(after, '开右架子')
      shot = after
    }
    const dragged = await nudgeSplitter(page)
    if (!dragged.ok) {
      skip('拖一次分隔杆之后重量', dragged.why)
    } else {
      await delay(500)
      const after = await topbarShot(page)
      console.log(`  · 拖杆后 ${after.groups.map((g) => `${g.id}:${g.box.left}–${g.box.right}`).join('  ')}`)
      checkAlignment(after, '拖分隔杆')
    }

    /* ── CGEvent 半边:默认不跑 ─────────────────────────────────────────── */
    scenario('CGEvent 半边(真鼠标拖窗)')
    if (!REAL_MOUSE) {
      skip(
        '真鼠标在顶栏空白处拖一段 → 窗口跟着走',
        'ONETHING_GATE_REAL_MOUSE 没开 —— 这一段会动真鼠标,须用户点头',
      )
    } else {
      skip(
        '真鼠标在顶栏空白处拖一段 → 窗口跟着走',
        '开关开着,但这一段本批**没有实现**:实现它之前先当面告知「本段会动真鼠标」',
      )
    }

    await app.close()
    app = undefined
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
    await rm(workspaceRoot, { recursive: true, force: true })
  }

  /* ── 打表 ─────────────────────────────────────────────────────────── */
  console.log('\n────────── 逐场景读数 ──────────')
  let red = 0
  let skipped = 0
  scenarios.forEach((s, i) => {
    const bad = s.checks.filter((c) => !c.ok)
    const skips = s.checks.filter((c) => c.skipped)
    red += bad.length
    skipped += skips.length
    const tag =
      bad.length > 0
        ? `红 ${bad.length}/${s.checks.length}`
        : skips.length === s.checks.length
          ? '跳过'
          : skips.length
            ? `绿(${skips.length} 条跳过)`
            : '绿'
    console.log(`场景 ${i + 1} ${tag}  ${s.name}`)
    for (const c of bad) console.log(`   ✗ ${c.message}${c.detail ? `  ${c.detail}` : ''}`)
    for (const c of skips) console.log(`   ⊘ ${c.message}(${c.detail})`)
  })
  console.log(
    `合计 ${red} 条红 / ${scenarios.reduce((n, s) => n + s.checks.length, 0)} 条断言`
      + `${skipped ? `(其中 ${skipped} 条跳过)` : ''}`,
  )

  if (red && !EXPECT_RED) {
    console.error('\n[drag-region-gate] FAILED')
    process.exit(1)
  }
  console.log(
    red
      ? '\n[drag-region-gate] 带 --expect-red:上面的红是**本批预期的读数**,不判失败'
      : `\n[drag-region-gate] ok —— ${scenarios.length} 个场景全绿`,
  )
}

/* ── 夹具:走用户真走的那条路 ─────────────────────────────────────────── */

/**
 * 把中央叶开成两格 tab(分屏要「切出去之后原叶不空」)。
 * 路子与 gate:squeeze / gate:focus 逐字相同:文件面板 → 行菜单选「主区域」→ ↵ 开。
 */
async function openTwoTabsInCenter(page) {
  await clickSelector(page, '[data-testid="dock-tile-files"]').catch(() => {})
  await delay(700)
  const rowCss = '[data-testid="files-tree"] [data-file-path][data-file-type="file"]'
  const rows = await page.evaluate((css) => document.querySelectorAll(css).length, rowCss)
  if (rows === 0) return { ok: false, why: '文件树上一行文件都没有(夹具没搭起来)' }
  await page.evaluate((css) => {
    const row = document.querySelector(css)
    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 }))
  }, rowCss)
  await delay(400)
  const picked = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
    const center = items.find((el) => /主区域|Main stage/.test(el.textContent ?? ''))
    if (center instanceof HTMLElement) center.click()
    return Boolean(center)
  })
  if (!picked) return { ok: false, why: '行菜单里没有「主区域 / Main stage」那一档' }
  await delay(400)
  // ↵ 开(单击是预览 tab,一片叶至多一个,攒不出第二格)。
  await page.evaluate((css) => {
    const row = document.querySelectorAll(css)[0]
    if (row instanceof HTMLElement) row.focus()
  }, rowCss)
  await page.keyboard.press('Enter')
  await delay(600)
  const tabs = await page.evaluate(
    () => document.querySelectorAll('[data-testid="topbar-tabs"] [role="tab"]').length,
  )
  return tabs >= 2 ? { ok: true } : { ok: false, why: `顶栏上只有 ${tabs} 格 tab` }
}

/** 走顶栏右端那颗「分屏」钮 → 菜单「在右侧」。 */
async function splitFocusLeaf(page) {
  const opened = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid^="pane-split:"]')
    if (!(btn instanceof HTMLElement)) return false
    btn.click()
    return true
  })
  if (!opened) return { ok: false, why: '顶栏右端没有那颗分屏钮' }
  await delay(350)
  const picked = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
    const right = items.find((el) => /在右侧|To the right/.test(el.textContent ?? ''))
    if (right instanceof HTMLElement && right.getAttribute('aria-disabled') !== 'true') {
      right.click()
      return true
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return false
  })
  return picked ? { ok: true } : { ok: false, why: '分屏菜单里那一项按不动(只有一格 tab?)' }
}

/** 把文件面板钉到右边 —— 中央区因此变窄,标签组必须跟着挪。 */
async function pinFilesToRightEdge(page) {
  const opened = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="dock-tile-files"]')
    if (!(el instanceof HTMLElement)) return false
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))
    return true
  })
  if (!opened) return { ok: false, why: 'Dock 上没有那块瓦' }
  await delay(350)
  const picked = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'))
    const right = items.find((el) => /^(Right|右边)$/.test((el.textContent ?? '').trim()))
    if (right instanceof HTMLElement) {
      right.click()
      return true
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return false
  })
  return picked ? { ok: true } : { ok: false, why: 'Dock 菜单里没有「右边」那一档' }
}

/**
 * 拖一次分隔杆。走**键盘**那一路(`ui/Splitter` 是 `role="separator"` + 方向键)——
 * 它与指针拖落到的是同一口 `onCommit`,而且不必合成指针事件。
 */
async function nudgeSplitter(page) {
  const focused = await page.evaluate(() => {
    const sep = document.querySelector('[data-pane-seam] [role="separator"]')
    if (!(sep instanceof HTMLElement)) return false
    sep.focus()
    return document.activeElement === sep
  })
  if (!focused) return { ok: false, why: '树上没有分隔杆(没分屏?)' }
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press('ArrowLeft')
    await delay(80)
  }
  return { ok: true }
}

main().catch((error) => {
  console.error('\n[drag-region-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
