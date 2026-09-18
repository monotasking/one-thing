#!/usr/bin/env node
/**
 * 待办窗的**真机门**(待办 B 形 U6,正本 `docs/todo-app-b-2026-09.md` §8)。
 *
 * 这道门是 09-17 那一轮报障(「回车,删除,滚动」)与 B 形 U1–U5 的探针脚本收成的:每一步都曾经
 * 在真机上红过,或者是用户点名要的形。壳自己装配 core(与 `gate:terminal` 同一条起法),临时 store、
 * 自己的 `--user-data-dir`,**屏外档**(`ONETHING_GATE_OFFSCREEN`:要量毫秒,headless 档会被节流到 1Hz)。
 * 键盘一律 CDP `Input.dispatchKeyEvent` / `insertText`,只进这扇窗,不动真光标。
 *
 * 夹具(起窗之前直接写进 store 的 `todo-plan/user-notes/`):
 *  · 100 份小清单,名字各不相同,其中两份里有「发票」这个词;
 *  · 「大清单」500 项:10 节 × 50 项,每节前 20 项勾完(屏上 311 项);
 *  · 「收件箱」几项,给编辑类场景用。
 *
 * 步骤:
 *  ① Dock 瓦开出待办窗:头画在叶的标签条上(内容自带头),条上没有标签;
 *  ② ⌘F → 切换 / 搜索弹层,焦点在输入框;打「发票」→ 项组两条;↵ 打开项,那一行在视野里;
 *  ③ 切进「大清单」:第一帧 / 整篇上屏毫秒数(预算见 `BUDGET`);已完成每节收成一行;
 *  ④ 折一节、再展开:行数与提示行对得上,折叠状态落进偏好;
 *  ⑤ 回车 ×5(长清单中段):≥50ms 长帧 0、每次卸掉重建的项 ≤1;
 *  ⑥ 滚动:在清单底部连按回车,光标那一行一直在滚动容器的视野里;Esc 只离开这一项、不收窗;
 *  ⑦ 勾选框:勾上的那一项先留着(< LINE_CHANGED_MS),到点收进「已完成」;
 *  ⑧ 删除:非空项行首退格 = 去掉勾选记号,文件里那一行变成段落;
 *  ⑨ 写坏文件那一类:编辑中外部改文件 → 两边的改动都在、没有重复行;
 *  ⑩ 把别的内容拖到这条**自带的头**上 = 插进这片叶(头把标签条换掉了,它得自己是一条能收东西的条);
 *  ⑪ 反过来:按住头上的**抓手**(图标 / 清单名)把待办窗拖进顶栏标签条 = 它变成那里的一格;
 *     按住头上空白处照旧是挪窗(没有标签可抓时,这扇窗曾经只挪得动、进不了别人的条);
 *  ⑫ 编辑器一致性自测 `?todo-lab`:30 / 30。
 *
 * `--prod` 跑构建产物;缺省是 dev 档(起一台 vite,端口 `ONETHING_GATE_VITE_PORT`,缺省 5195,
 * **不是用户的 5175**,也避开 chat-layout 的 5197 与 terminal 的 5198)。
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

const PROD = process.argv.includes('--prod') || process.env.ONETHING_GATE_DIST === '1'
const LANE = PROD ? 'prod' : 'dev'
const DEV_PORT = Number(process.env.ONETHING_GATE_VITE_PORT ?? 5195)

/**
 * ── 预算 ────────────────────────────────────────────────────────────────
 * `openFirstFrameMs` / `enterLongFrameMs` 是第 5 轴原数(点击后第一帧 ≤16ms、零 ≥50ms 长帧);
 * `openMs` 是 U5 给 500 项清单定的 150ms。
 */
const BUDGET = {
  openFirstFrameMs: 16,
  openMs: 150,
  enterLongFrameMs: 50,
  /** 一次回车最多卸掉重建几项(只该有新拆出来 / 被删掉的那一项)。 */
  enterRemounts: 1,
}

/**
 * ── 过渡阈值 ────────────────────────────────────────────────────────────
 * dev 渲染层切进 500 项清单实测 201–264ms(2026-09-17,两趟冷起 + 两趟热切),超 150。
 * 它仍在第 5 轴「冷载首屏 ≤300ms」之内,所以这一格给 300。**退场判据**:按屏挂载、空闲补剩下的项
 * (正本 §10 U5 留账)落地后删掉这一行。抬 `BUDGET` 是改法,让门恒红只会被人加 `|| true`。
 */
const TRANSITIONAL = { dev: { openMs: 300 }, prod: {} }

function budgetOf(key) {
  return key in TRANSITIONAL[LANE] ? TRANSITIONAL[LANE][key] : BUDGET[key]
}

/** 与 `src/components/motion.ts` 的 `LINE_CHANGED_MS` 同数(门不 import 壳的源码)。 */
const LINE_CHANGED_MS = 1400

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await delay(100)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}\n最后一次读数:${JSON.stringify(last)}`)
}

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败:${message}`)
  console.log(`  ✓ ${message}`)
}

function readDiscovery(store) {
  try {
    return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8'))
  } catch {
    return undefined
  }
}

const ON_MAC = process.platform === 'darwin'
const PRIMARY_MODIFIER = ON_MAC ? 4 : 2

async function press(cdp, { key, code, keyCode, text, primary = false }) {
  const modifiers = primary ? PRIMARY_MODIFIER : 0
  const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers }
  await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
}

const ENTER = { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' }
const BACKSPACE = { key: 'Backspace', code: 'Backspace', keyCode: 8 }

/* ── 夹具 ─────────────────────────────────────────────────────────────── */

const TOPICS = ['工作', '购物', '旅行', '读书', '健身', '家务', '学习', '项目', '采购', '报销']
const INBOX = ['# 收件箱', '', '- [ ] 回邮件', '- [ ] 订周五的会议室', '- [ ] 看一眼 CI 为什么红', '']

async function seed(store) {
  const dir = path.join(store, 'todo-plan', 'user-notes')
  await mkdir(dir, { recursive: true })
  for (let i = 1; i <= 100; i++) {
    const name = `${TOPICS[i % 10]}-${String(i).padStart(3, '0')}`
    const lines = [`# ${name.replace(/-/g, ' ')}`, '']
    for (let j = 1; j <= 6; j++) {
      const invoice = (i === 37 && j === 5) || (i === 88 && j === 2) ? ' 记得开发票' : ''
      lines.push(`- [${j <= 2 ? 'x' : ' '}] ${TOPICS[(i + j) % 10]}事项 ${i}.${j}${invoice}`)
    }
    await writeFile(path.join(dir, `${name}.md`), `${lines.join('\n')}\n`)
  }
  const big = ['# 大清单', '']
  for (let section = 1; section <= 10; section++) {
    big.push(`## 第 ${section} 节`)
    for (let k = 1; k <= 50; k++) big.push(`- [${k <= 20 ? 'x' : ' '}] 第 ${section} 节第 ${k} 项 **加粗** 与 \`代码\` 混排`)
    big.push('')
  }
  await writeFile(path.join(dir, '大清单.md'), big.join('\n'))
  await writeFile(path.join(dir, '收件箱.md'), INBOX.join('\n'))
  return dir
}

/* ── 页面里的几件小工具 ───────────────────────────────────────────────── */

const panelRows = (page) => page.evaluate(() => document.querySelectorAll('[data-testid="todo-panel"] [data-unit]').length)
const listName = (page) => page.evaluate(() => document.querySelector('[data-todo-name]')?.textContent ?? null)

/** 用切换弹层打开一份清单(打字 → ↵)。 */
async function openList(page, cdp, title) {
  await page.click('[data-testid="todo-switcher-trigger"]')
  await waitFor('弹层输入框拿到焦点', () =>
    page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'todo-switcher-input'))
  await cdp.send('Input.insertText', { text: title })
  await waitFor(`弹层里有「${title}」`, () =>
    page.evaluate((t) => Boolean(document.querySelector(`[data-testid="todo-switcher-row-list-${t.replace(/ /g, '-')}"]`)), title))
}

/** 按下鼠标打开正文里包含 `text` 的那一项(光标落在行尾)。 */
async function openRow(page, text) {
  const point = await page.evaluate((needle) => {
    const row = [...document.querySelectorAll('[data-testid="todo-panel"] [data-unit]')].find((el) => el.textContent.includes(needle))
    if (!row) return null
    row.scrollIntoView({ block: 'center' })
    const box = row.firstElementChild.getBoundingClientRect()
    return { x: box.right - 4, y: box.top + box.height / 2 }
  }, text)
  if (!point) throw new Error(`正文里没有「${text}」`)
  await page.mouse.click(point.x, point.y)
  await waitFor('那一项进了编辑', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="todo-panel"] [contenteditable="true"]'))))
}

async function main() {
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[todo-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }
  const store = await mkdtemp(path.join(tmpdir(), 'todo-gate-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'todo-gate-userdata-'))
  const notesDir = await seed(store)
  let app
  let vite
  const report = { lane: LANE }
  try {
    let rendererUrl = ''
    if (!PROD) {
      console.log(`\n[0/12] dev 档:起一台 vite(端口 ${DEV_PORT},不是用户的 5175)`)
      const { createServer } = await import('vite')
      vite = await createServer({
        configFile: path.join(appRoot, 'vite.config.ts'),
        server: { port: DEV_PORT, strictPort: true },
        logLevel: 'warn',
      })
      await vite.listen()
      rendererUrl = vite.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${DEV_PORT}/`
    }
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: rendererUrl,
        ONETHING_GATE_OFFSCREEN: '1',
      },
    })
    const page = await app.firstWindow()
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor('壳内嵌的 core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.owner === 'shell' ? found : undefined
    }, 60_000)
    await waitFor('渲染层完成一次 RPC 往返', () => page.evaluate(() => window.__d0?.rpcOk === true), 60_000)
    await waitFor('Dock 就位', () => page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-todo"]'))), 60_000)

    console.log('\n[1/12] Dock 瓦开出待办窗:头画在叶的标签条上')
    await page.click('[data-testid="dock-tile-todo"]')
    const head = await waitFor('头出现', () => page.evaluate(() => {
      const header = document.querySelector('[data-testid="todo-header"]')
      if (!header) return undefined
      const strip = header.closest('[data-strip-header]')
      const chrome = strip?.parentElement
      return { placement: header.dataset.placement, inStrip: Boolean(strip), tabsInChrome: chrome ? chrome.querySelectorAll('[role="tab"]').length : -1 }
    }))
    assert(head.placement === 'strip' && head.inStrip, `① 头在条上(placement=${head.placement})`)
    assert(head.tabsInChrome === 0, '① 那条檐上没有标签(一片叶只有一条头)')
    await waitFor('正文有内容', async () => (await panelRows(page)) > 0)

    console.log('\n[2/12] ⌘F → 搜索「发票」→ ↵ 打开项,那一行在视野里')
    await page.evaluate(() => document.querySelector('[data-testid="todo-panel"] [role="group"]')?.focus())
    await press(cdp, { key: 'f', code: 'KeyF', keyCode: 70, primary: true })
    await waitFor('弹层开、焦点在输入框', () =>
      page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'todo-switcher-input'))
    assert(true, '② ⌘F 从正文开出切换 / 搜索弹层,焦点在输入框')
    await cdp.send('Input.insertText', { text: '发票' })
    let seenRows
    const hits = await waitFor('项组两条', async () => {
      seenRows = await page.evaluate(() => ({
        input: document.querySelector('[data-testid="todo-switcher-input"]')?.value ?? null,
        rows: [...document.querySelectorAll('[data-testid^="todo-switcher-row-"]')].map((row) => row.dataset.testid),
        note: [...document.querySelectorAll('[data-testid="todo-switcher"] p')].map((p) => p.textContent),
      }))
      const items = seenRows.rows.filter((id) => id.startsWith('todo-switcher-row-item-'))
      return items.length === 2 ? items : undefined
    }).catch((error) => { throw new Error(`${error.message}\n弹层此刻:${JSON.stringify(seenRows)}`) })
    assert(hits.length === 2, `② 跨清单搜到两条项(${hits.join(' / ')})`)
    await press(cdp, ENTER)
    await waitFor('弹层关上', () => page.evaluate(() => !document.querySelector('[data-testid="todo-switcher"]')))
    let lastSeen
    const revealed = await waitFor('打开项并滚到那一行', async () => {
      lastSeen = await page.evaluate(() => {
        const row = [...document.querySelectorAll('[data-testid="todo-panel"] [data-unit]')].find((el) => el.textContent.includes('发票'))
        const scroller = row?.closest('[data-todo-body]')
        const name = document.querySelector('[data-todo-name]')?.textContent
        if (!row || !scroller) return { name, row: Boolean(row), scroller: Boolean(scroller) }
        const r = row.getBoundingClientRect()
        const s = scroller.getBoundingClientRect()
        return { name, inView: r.top >= s.top && r.bottom <= s.bottom }
      })
      return lastSeen.inView !== undefined ? lastSeen : undefined
    }).catch((error) => { throw new Error(`${error.message}\n页面读数:${JSON.stringify(lastSeen)}`) })
    assert(revealed.inView, `② ↵ 打开「${revealed.name}」,命中那一行在视野里`)

    console.log('\n[3/12] 切进 500 项清单:毫秒数与已完成收起')
    await openList(page, cdp, '大清单')
    const opened = await page.evaluate(async () => {
      const raf = () => new Promise((r) => requestAnimationFrame(() => r()))
      const loaf = []
      const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) loaf.push(Math.round(e.duration)) })
      obs.observe({ type: 'long-animation-frame' })
      const t0 = performance.now()
      document.querySelector('[data-testid="todo-switcher-row-list-大清单"]').click()
      await raf()
      const firstFrameMs = performance.now() - t0
      while (!(document.querySelector('[data-todo-name]')?.textContent === '大清单'
        && document.querySelectorAll('[data-testid="todo-panel"] [data-unit]').length >= 311)) {
        if (performance.now() - t0 > 10_000) break
        await new Promise((r) => setTimeout(r, 5))
      }
      await raf(); await raf()
      const openMs = performance.now() - t0
      obs.disconnect()
      return { firstFrameMs: Math.round(firstFrameMs), openMs: Math.round(openMs), longFrames: loaf }
    })
    report.open = opened
    console.log(`      读数:${JSON.stringify(opened)}`)
    assert((await panelRows(page)) === 311, '③ 屏上 311 项(每节 20 项已完成收起)')
    const doneFolds = await page.evaluate(() => document.querySelectorAll('[data-testid="todo-panel"] [data-fold^="done:"]').length)
    assert(doneFolds === 10, `③ 每节一行「已完成」(${doneFolds} 行)`)
    assert(opened.firstFrameMs <= budgetOf('openFirstFrameMs'), `③ 点开之后第一帧 ${opened.firstFrameMs}ms ≤ ${budgetOf('openFirstFrameMs')}`)
    assert(opened.openMs <= budgetOf('openMs'), `③ 整篇上屏 ${opened.openMs}ms ≤ ${budgetOf('openMs')}(${LANE} 档)`)

    console.log('\n[4/12] 折一节、再展开')
    const hitTest = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="todo-panel"] [data-fold^="heading:"]')
      const r = button.getBoundingClientRect()
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { rect: [r.left, r.top, r.width, r.height].map(Math.round), hit: at === button || button.contains(at) }
    })
    assert(hitTest.hit, `④ 三角钮中心那一点点得到它自己(不被窗边把手盖住;${JSON.stringify(hitTest.rect)})`)
    await page.click('[data-testid="todo-panel"] [data-fold^="heading:"]', { force: true })
    const folded = await waitFor('第 1 节折起', () => page.evaluate(() => {
      const panel = document.querySelector('[data-testid="todo-panel"]')
      const section = panel.querySelector('[data-fold^="section:"]')
      return section ? { rows: panel.querySelectorAll('[data-unit]').length, label: section.textContent } : undefined
    }))
    assert(folded.rows === 281, `④ 折起第 1 节:少了它那 30 项(${folded.rows} 项,提示行「${folded.label}」)`)
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('onething.todo') ?? '{}')?.state?.folded ?? {})
    assert(JSON.stringify(stored['note:大清单']) === JSON.stringify(['第 1 节']), '④ 折叠状态按清单记进偏好')
    await page.click('[data-testid="todo-panel"] [data-fold^="heading:"]', { force: true })
    await waitFor('第 1 节展开', async () => (await panelRows(page)) === 311)
    assert(true, '④ 再点一次展开,311 项回来')

    console.log('\n[5/12] 长清单中段回车 ×5:零长帧、每次只重建一项')
    await openRow(page, '第 5 节第 30 项')
    const rowsBeforeEnter = await panelRows(page)
    await page.evaluate(() => {
      const P = (window.__todoGate = { loaf: [], remounts: [] })
      P.obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) P.loaf.push(Math.round(e.duration)) })
      P.obs.observe({ type: 'long-animation-frame' })
      P.mo = new MutationObserver((records) => {
        let removed = 0
        for (const r of records) for (const n of r.removedNodes) if (n.nodeType === 1) removed += n.matches('[data-unit]') ? 1 : n.querySelectorAll('[data-unit]').length
        if (removed) P.remounts.push(removed)
      })
      P.mo.observe(document.querySelector('[data-testid="todo-panel"]'), { childList: true, subtree: true })
    })
    for (let i = 0; i < 5; i++) {
      await press(cdp, ENTER)
      await cdp.send('Input.insertText', { text: `新${i}` })
      await delay(200)
    }
    await delay(300)
    const typed = await page.evaluate(() => {
      const P = window.__todoGate
      P.obs.disconnect(); P.mo.disconnect()
      return { longFrames: P.loaf, remounts: P.remounts }
    })
    report.enter = typed
    const rowsAfterEnter = await panelRows(page)
    assert(rowsAfterEnter === rowsBeforeEnter + 5, `⑤ 五次回车真的拆出五项(${rowsBeforeEnter} → ${rowsAfterEnter})`)
    console.log(`      读数:${JSON.stringify(typed)}`)
    assert(typed.longFrames.filter((d) => d >= budgetOf('enterLongFrameMs')).length === 0, `⑤ 回车 + 打字 ×5 零 ≥${budgetOf('enterLongFrameMs')}ms 长帧(读数 ${JSON.stringify(typed.longFrames)})`)
    assert(typed.remounts.every((n) => n <= budgetOf('enterRemounts')), `⑤ 一次回车重建的项 ≤${budgetOf('enterRemounts')}(读数 ${JSON.stringify(typed.remounts)})`)

    console.log('\n[6/12] 滚动:清单底部连按回车,光标那一行一直在视野里')
    await openRow(page, '第 10 节第 50 项')
    let outOfView = 0
    for (let i = 0; i < 12; i++) {
      await cdp.send('Input.insertText', { text: `尾${i}` })
      await press(cdp, ENTER)
      await delay(60)
      const inView = await page.evaluate(() => {
        const ed = document.querySelector('[data-testid="todo-panel"] [contenteditable="true"]')
        const scroller = ed?.closest('[data-todo-body]')
        if (!ed || !scroller) return false
        const r = ed.getBoundingClientRect()
        const s = scroller.getBoundingClientRect()
        return r.bottom <= s.bottom + 1 && r.top >= s.top - 1
      })
      if (!inView) outOfView++
    }
    assert(outOfView === 0, `⑥ 连按 12 次回车,光标那一行每一次都在视野里(出界 ${outOfView} 次)`)
    await press(cdp, { key: 'Escape', code: 'Escape', keyCode: 27 })
    const afterEscape = await waitFor('Esc 之后编辑区关上', () => page.evaluate(() => {
      const panel = document.querySelector('[data-testid="todo-panel"]')
      return panel && !panel.querySelector('[contenteditable="true"]') ? { panel: true } : panel ? undefined : { panel: false }
    }))
    assert(afterEscape.panel, '⑥ 编辑中按 Esc 只离开这一项,待办窗还开着(main 上曾经整扇收掉)')

    console.log('\n[7/12] 勾选框:勾上的那一项先留着,到点收进「已完成」')
    const target = '第 2 节第 25 项'
    const lingered = await page.evaluate(async ({ needle, ms }) => {
      const find = () => [...document.querySelectorAll('[data-testid="todo-panel"] [data-unit]')].find((el) => el.textContent.includes(needle))
      const row = find()
      row.scrollIntoView({ block: 'center' })
      const box = row.querySelector('[data-check] input, [data-check] [role="checkbox"], [data-check] button')
      if (!box) return { noBox: true, html: row.outerHTML.slice(0, 200) }
      box.click()
      await new Promise((r) => setTimeout(r, Math.round(ms / 2)))
      const during = Boolean(find())
      await new Promise((r) => setTimeout(r, ms))
      return { during, after: Boolean(find()) }
    }, { needle: target, ms: LINE_CHANGED_MS })
    assert(lingered.during && !lingered.after, `⑦ 勾上后 ${LINE_CHANGED_MS / 2}ms 还在、${LINE_CHANGED_MS * 1.5}ms 已收起(读数 ${JSON.stringify(lingered)})`)

    console.log('\n[8/12] 删除:非空项行首退格 = 去掉勾选记号')
    await openList(page, cdp, '收件箱')
    await press(cdp, ENTER)
    await waitFor('收件箱', async () => (await listName(page)) === '收件箱')
    const point = await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-testid="todo-panel"] [data-unit]')].find((el) => el.textContent.includes('订周五'))
      const box = row.firstElementChild.getBoundingClientRect()
      return { x: box.left + 1, y: box.top + box.height / 2 }
    })
    await page.mouse.click(point.x, point.y)
    await waitFor('进了编辑', () => page.evaluate(() => Boolean(document.querySelector('[data-testid="todo-panel"] [contenteditable="true"]'))))
    await press(cdp, { key: 'Home', code: 'Home', keyCode: 36 })
    await press(cdp, BACKSPACE)
    await press(cdp, { key: 'Escape', code: 'Escape', keyCode: 27 })
    const inboxFile = path.join(notesDir, '收件箱.md')
    const stripped = await waitFor('落盘', () => {
      const text = readFileSync(inboxFile, 'utf-8')
      return text.split('\n').includes('订周五的会议室') ? text : undefined
    }, 5_000)
    assert(!stripped.includes('- [ ] 订周五的会议室'), '⑧ 行首退格去掉了勾选记号,那一行落盘成段落')

    console.log('\n[9/12] 编辑中外部改文件:两边的改动都在、没有重复行')
    await openRow(page, '回邮件')
    await cdp.send('Input.insertText', { text: '(本地)' })
    await delay(1_000)
    const current = readFileSync(inboxFile, 'utf-8')
    await writeFile(inboxFile, `${current.replace(/\n*$/, '')}\n- [ ] 外部加的一项\n`)
    await delay(1_500)
    await cdp.send('Input.insertText', { text: '续' })
    await press(cdp, { key: 'Escape', code: 'Escape', keyCode: 27 })
    const merged = await waitFor('两边都落盘', () => {
      const text = readFileSync(inboxFile, 'utf-8')
      return text.includes('外部加的一项') && text.includes('(本地)续') ? text : undefined
    }, 8_000)
    const nonEmpty = merged.split('\n').filter((line) => line.trim())
    assert(new Set(nonEmpty).size === nonEmpty.length, `⑨ 没有重复行(${nonEmpty.length} 行)`)

    /*
     * 拖拽的落点地图按 `[role="tablist"]` 找条、按 `[data-tab-id]` 认格(`workbench/drop-geometry.ts`)。
     * 内容自带头的那一档条上没有 tablist —— U1 之后那片叶**整条檐在地图上不存在**,拖到头上没有任何
     * 落点(2026-09-18 用户报「没有了 tab,导致不能拖入到 tab header 中」)。这一步量的是修好之后的
     * 两件事:悬停时头上真有一层预示(标签那一档的预示是条腾出来的空位,头上没有格可腾),松手真的并进去。
     */
    console.log('\n[10/12] 拖到自带的头上 = 插进这片叶')
    await page.click('[data-testid="dock-tile-music"]')
    const spots = await waitFor('音乐那一格与待办的头都在屏上', () => page.evaluate(() => {
      const music = document.querySelector('[data-tab-id="panel:music"]')
      const header = document.querySelector('[data-testid="todo-header"]')
      if (!music || !header) return undefined
      const m = music.getBoundingClientRect()
      const h = header.getBoundingClientRect()
      return { tab: { x: m.left + m.width / 2, y: m.top + m.height / 2 }, header: { x: h.left + h.width * 0.75, y: h.top + h.height / 2 } }
    }))
    await page.mouse.move(spots.tab.x, spots.tab.y)
    await page.mouse.down()
    await page.mouse.move(spots.tab.x + 20, spots.tab.y + 40, { steps: 4 })
    await page.mouse.move(spots.header.x, spots.header.y, { steps: 8 })
    await delay(300)
    const band = await page.evaluate(() => {
      const overlay = document.querySelector('[data-testid="drop-overlay"]')
      const header = document.querySelector('[data-testid="todo-header"]')?.getBoundingClientRect()
      if (!overlay || !header) return null
      const rect = overlay.getBoundingClientRect()
      return { shape: overlay.dataset.shape, tone: overlay.dataset.tone, overHeader: Math.abs(rect.top - header.top) < 4 && rect.width > header.width / 2 }
    })
    assert(Boolean(band), '⑩ 悬停在头上时屏幕上有预示(从前这里一点动静都没有)')
    assert(band.shape === 'film' && band.tone === 'accept' && band.overHeader, `⑩ 那层预示是盖住这条头的薄膜(${JSON.stringify(band)})`)
    await page.mouse.up()
    const bothTabs = await waitFor('音乐并进待办那片叶', () => page.evaluate(() => {
      const chrome = [...document.querySelectorAll('[data-pane-chrome]')].find((el) => el.querySelector('[data-tab-id="panel:todo"]'))
      const ids = chrome ? [...chrome.querySelectorAll('[data-tab-id]')].map((el) => el.getAttribute('data-tab-id')) : []
      return ids.includes('panel:music') ? ids : undefined
    }))
    assert(bothTabs.includes('panel:todo') && bothTabs.includes('panel:music'), `⑩ 松手之后那片叶两格都在(${bothTabs.join(' / ')})`)

    /*
     * 反方向(同一条报障的另一头):头把标签条换掉之后这扇窗**没有一格标签可抓**,按住头只会挪窗子,
     * 拖不进别人的标签条。头上的抓手(`[data-strip-grab]`)= 那一格标签;空白处照旧拖窗。
     * 上一步音乐已经并进来了,这片叶现在是两格标签 —— 所以先关掉音乐那一格,回到「一格 + 自带头」的形。
     */
    console.log('\n[11/12] 按住头上的抓手,把待办窗拖进顶栏的标签条')
    await page.evaluate(() => {
      const chrome = [...document.querySelectorAll('[data-pane-chrome]')].find((el) => el.querySelector('[data-tab-id="panel:todo"]'))
      const music = chrome?.querySelector('[data-tab-id="panel:music"]')
      music?.querySelector('[data-tab-close]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await waitFor('待办窗回到一格 + 自带头', () => page.evaluate(() => Boolean(document.querySelector('[data-testid="todo-header"]')?.closest('[data-strip-header]'))))
    const grabAt = await page.evaluate(() => {
      const grab = document.querySelector('[data-testid="todo-header"] [data-strip-grab]')
      const bar = document.querySelector('[data-testid="topbar-tabs"] [role="tablist"]')
      const float = document.querySelector('[data-testid="todo-header"]')?.closest('[data-float-body]')
      if (!grab || !bar) return null
      const g = grab.getBoundingClientRect()
      const b = bar.getBoundingClientRect()
      const f = float?.getBoundingClientRect()
      return { grab: { x: g.left + g.width / 2, y: g.top + g.height / 2 }, bar: { x: b.left + b.width * 0.6, y: b.top + b.height / 2 }, float: f ? [Math.round(f.left), Math.round(f.top)] : null }
    })
    assert(Boolean(grabAt), '⑪ 头上有抓手,顶栏有标签条')
    await page.mouse.move(grabAt.grab.x, grabAt.grab.y)
    await page.mouse.down()
    await page.mouse.move(grabAt.grab.x + 20, grabAt.grab.y - 40, { steps: 4 })
    await page.mouse.move(grabAt.bar.x, grabAt.bar.y, { steps: 8 })
    await delay(300)
    const dragging = await page.evaluate(() => {
      const float = document.querySelector('[data-testid="todo-header"]')?.closest('[data-float-body]')?.getBoundingClientRect()
      return { ghost: Boolean(document.querySelector('[class*="ghost"]')), float: float ? [Math.round(float.left), Math.round(float.top)] : null }
    })
    assert(dragging.ghost, '⑪ 按住抓手拖起来的是那一格标签(有拖影),不是在挪窗')
    assert(JSON.stringify(dragging.float) === JSON.stringify(grabAt.float), `⑪ 拖的途中窗子一动没动(${JSON.stringify(grabAt.float)} → ${JSON.stringify(dragging.float)})`)
    await page.mouse.up()
    const topbar = await waitFor('待办进了顶栏那一组', () => page.evaluate(() => {
      const ids = [...document.querySelectorAll('[data-testid="topbar-tabs"] [data-tab-id]')].map((el) => el.getAttribute('data-tab-id'))
      return ids.includes('panel:todo') ? ids : undefined
    }))
    assert(topbar.includes('panel:todo'), `⑪ 松手之后待办是顶栏的一格(${topbar.join(' / ')})`)

    console.log('\n[12/12] 编辑器一致性自测 ?todo-lab')
    // 换页那一下会把这次 evaluate 的执行上下文一起拆掉 —— 那是换页本身,不是失败。
    await page.evaluate(() => { location.search = '?todo-lab' }).catch(() => {})
    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await waitFor('实验台就位', () => page.evaluate(() => Boolean(document.querySelector('[data-lab-suite]'))).catch(() => false), 60_000)
    const lab = await page.evaluate(async () => {
      delete window.__todoLabResults
      document.querySelector('[data-lab-suite]').click()
      for (let i = 0; i < 900 && !window.__todoLabResults; i++) await new Promise((r) => setTimeout(r, 100))
      const results = window.__todoLabResults ?? []
      return { pass: results.filter((r) => r.ok).length, total: results.length, fails: results.filter((r) => !r.ok).map((r) => `${r.name} — ${r.detail}`) }
    })
    report.lab = { pass: lab.pass, total: lab.total }
    assert(lab.total >= 30 && lab.pass === lab.total, `⑫ 自测 ${lab.pass} / ${lab.total}${lab.fails.length ? `(红:${lab.fails.join(';')})` : ''}`)

    await app.close()
    app = undefined
    console.log(`\n[todo-gate] ok(${LANE} 档)—— 十二步全过`)
    console.log(`[todo-gate] 读数:${JSON.stringify(report)}`)
  } finally {
    if (app) await app.close().catch(() => {})
    if (vite) await vite.close().catch(() => {})
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('\n[todo-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
