#!/usr/bin/env node
/**
 * 密钥池行重排的**真机门**(09-02 批 12)。
 *
 * ── 它在证什么 ──────────────────────────────────────────────────────────
 * 这一批交付的是**几何与在场**:铅笔占位、序号与输入条的竖中线、行高、一行排完、
 * 零重叠、菜单端点禁灰。这几件 jsdom 一件都量不了(它不排版),而它们恰恰是
 * 用户报障里点名的那几处(「序号错位 5px」「一行塞太多钮」)。所以单测守语义、
 * 这条门守读数,两半缺一不可。
 *
 * ── 七条断言(对应派工令 a–g)───────────────────────────────────────────
 *   a 休止 / 悬停:每行只有 ⋯ 看得见,铅笔 opacity 0 **且占着 22px**;
 *                  悬停后铅笔 opacity 1,而 ⋯ 的 x **一字不动**(无位移原则)。
 *   b 改密钥:旧尾号仍在屏上;序号 / 前缀 / 输入框 / Save 四者竖中线差 ≤ 1px;
 *             行高 ≤ 64;第 2 行副行仍在;铅笔与 ⋯ 都不在树上。
 *   c 改备注:输入框**预填现值并全选**;第 1 行尾号仍在。
 *   d 失焦不取消:打了字点卡外空白,条还在、值还在;Esc 才收回。
 *   e 添加:顶部新行**一行排完**(子元素 top 相同、两两零重叠);
 *           一进来光标落在密钥格;Add 空值禁、打字后活;提交后列表条数 +1。
 *   f 删除确认:那一行长出确认条,**别的行零位移**(行 1 的 ⋯ x/y 不变);Cancel 收回。
 *   g 菜单:五项都在;行 1 的 Move up 禁、行 2 的 Move down 禁(禁灰不消失)。
 *
 * ── 反证(照 gate:motion / gate:dock 的纪律)────────────────────────────
 * 每条断言都要能被「把实现拆掉」反证成红。本批真跑过四处,读数写在交卷里:
 *   · 摘掉 `ui/Reveal` 的占位(改成条件渲染)            → a 红(⋯ 的 x 会跳)
 *   · 摘掉 `.ordinalMid`(序号不换行高)                 → b 红(中线差 5px)
 *   · 把 `useInlineEdit` 的 `cancelOnBlur` 打开          → d 红(点空白条就没了)
 *   · 把添加行的 flex 排布拆掉(密钥格不 grow)          → e 红(子元素不再等宽排一行)
 *
 * 跑法:`npm run gate:credential-pool`(先 `npm run app:build`)。
 * 可重复:每次一个全新的临时 store + 全新的 --user-data-dir,跑完删干净。
 * 它**绝不**碰 `~/.onething`(「验证不改用户状态」)。
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

/** 两把假钥匙。尾号是断言用的锚 —— 池子只回读尾号,原文永远不回来。 */
const SEED = [
  { apiKey: 'sk-f44aaaaaaaaaaaaaaaaaaaaaaaaaaaa477', label: 'prod' },
  { apiKey: 'sk-9b1bbbbbbbbbbbbbbbbbbbbbbbbbb0c2e', label: 'backup' },
]
const PROVIDER = 'deepseek'

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

function readDiscovery(store) {
  try {
    return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8'))
  } catch {
    return undefined
  }
}

async function waitFor(label, predicate, timeoutMs = 30_000) {
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
  const response = await fetch(`http://${record.host}:${record.port}/api/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(record.token ? { authorization: `Bearer ${record.token}` } : {}),
    },
    body: JSON.stringify({ domain, method, payload }),
  })
  if (!response.ok) throw new Error(`rpc ${domain}.${method} HTTP ${response.status}`)
  return response.json()
}

/*
 * 页面里的量尺。**一份**,所有断言共用 —— 两份量尺迟早对不上号
 * (取整策略、可见性判据只要差一点,读数就没法互相印证)。
 * 类名是 CSS Modules 哈希过的,所以一律按 `[class*="…"]` 找:哈希会变,
 * 词根不会;而词根就是那份配方的名字。
 */
const PROBE = `(() => {
  const round = (n) => Math.round(n * 100) / 100
  const rect = (el) => {
    const r = el.getBoundingClientRect()
    return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height), mid: round(r.y + r.height / 2) }
  }
  const panel = document.querySelector('[data-testid="providers-panel"]')
  const anchor = panel && panel.querySelector('button[aria-label^="More actions for entry"]')
  const list = anchor ? anchor.closest('ul') : (panel && panel.querySelector('ul'))
  const rows = list ? [...list.children] : []
  const btn = (row, prefix) => row.querySelector('button[aria-label^="' + prefix + '"]')
  const describe = (row) => {
    const pencil = btn(row, 'Replace the key on entry')
    const more = btn(row, 'More actions for entry')
    const ordinal = row.firstElementChild
    const strip = row.querySelector('[class*="strip"]')
    const input = row.querySelector('input')
    const stripButtons = strip ? [...strip.children].filter((c) => c.tagName === 'BUTTON') : []
    return {
      row: rect(row),
      ordinalRect: ordinal ? rect(ordinal) : null,
      ordinalClass: ordinal ? ordinal.className : '',
      pencil: pencil ? { ...rect(pencil), opacity: getComputedStyle(pencil.parentElement).opacity, disabled: pencil.disabled } : null,
      more: more ? { ...rect(more), disabled: more.disabled } : null,
      mask: (() => { const m = row.querySelector('[class*="mask"]'); return m ? m.textContent.trim() : null })(),
      meta: (() => { const m = row.querySelector('[class*="meta"]'); return m ? { text: m.textContent.trim(), ...rect(m) } : null })(),
      prefix: (() => { const p = row.querySelector('[class*="oldPreview"], [class*="consequence"]'); return p ? { text: p.textContent.trim(), ...rect(p) } : null })(),
      input: input ? { value: input.value, type: input.type, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd, label: input.getAttribute('aria-label') || '', ...rect(input.parentElement) } : null,
      inputs: [...row.querySelectorAll('input')].map((i) => ({ label: i.getAttribute('aria-label') || '', value: i.value })),
      stripButtons: stripButtons.map((b) => ({ text: b.textContent.trim(), disabled: b.disabled, ...rect(b) })),
      stripParts: strip
        ? [...strip.children]
            .flatMap((c) => (c.className.includes('control') ? [...c.children] : [c]))
            .map((c) => ({ tag: c.tagName.toLowerCase(), ...rect(c) }))
        : [],
      buttons: [...row.querySelectorAll('button')].map((b) => ({
        label: b.getAttribute('aria-label') || b.textContent.trim(),
        opacity: getComputedStyle(b.parentElement).opacity,
        disabled: b.disabled,
        ...rect(b),
      })),
    }
  }
  /* 无障碍名:ui/Field 走的是 aria-labelledby(标签只念不看),不是 aria-label ——
     只读后者会读到空,首版就是这么把这一条量成假红的。
     (这一整段是模板字符串,里面不能出现反引号。) */
  const nameOf = (el) => {
    if (!el) return ''
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const target = document.getElementById(by)
      if (target) return target.textContent.trim()
    }
    return el.getAttribute('aria-label') || el.tagName
  }
  const activeLabel = nameOf(document.activeElement)
  const menuEl = document.querySelector('[role="menu"]')
  const menuRect = menuEl ? rect(menuEl) : null
  const panelRect = panel ? rect(panel) : null
  const menuItems = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((i) => ({
    text: i.textContent.trim(),
    disabled: i.disabled,
  }))
  const card = list ? list.closest('[class*="card"]') : null
  return { count: rows.length, rows: rows.map(describe), menuItems, menuRect, panelRect, activeLabel, card: card ? rect(card) : null }
})()`

const read = (page) => page.evaluate(PROBE)

/** 两两重叠(容差 1px,反锯齿与半像素不算)。 */
function overlaps(parts) {
  const out = []
  for (let i = 0; i < parts.length; i += 1) {
    for (let j = i + 1; j < parts.length; j += 1) {
      const a = parts[i]
      const b = parts[j]
      const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (ix > 1 && iy > 1) out.push([i, j, +ix.toFixed(1), +iy.toFixed(1)])
    }
  }
  return out
}

async function clickLabel(page, prefix, nth = 0) {
  const clicked = await page.evaluate(
    ({ p, n }) => {
      const list = [...document.querySelectorAll(`button[aria-label^="${p}"]`)]
      if (!list[n]) return false
      list[n].click()
      return true
    },
    { p: prefix, n: nth },
  )
  if (!clicked) throw new Error(`点不到:aria-label 以「${prefix}」开头的第 ${nth + 1} 颗钮`)
}

async function clickText(page, selector, text) {
  const clicked = await page.evaluate(
    ({ css, want }) => {
      const el = [...document.querySelectorAll(css)].find((e) => e.textContent.trim() === want)
      if (!el) return false
      el.click()
      return true
    },
    { css: selector, want: text },
  )
  if (!clicked) throw new Error(`点不到:${selector} 里文本恰为「${text}」的那一个`)
}

async function main() {
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[gate:credential-pool] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'pool-gate-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'pool-gate-userdata-'))
  let app
  try {
    console.log('\n[1/9] 拉起应用(隔离 store + 独立 --user-data-dir)')
    app = await electron.launch({
      executablePath: electronBinary,
      // `--lang=en-US`:断言读的是英文那一份文案(locale 缺省跟 navigator.language 走)。
      args: [mainEntry, `--user-data-dir=${userDataDir}`, '--lang=en-US'],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '' },
    })
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1280, height: 860 })
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    const record = await waitFor('壳内嵌的 core 写出发现文件', () => readDiscovery(store))

    console.log('\n[2/9] 灌两把假钥匙(DeepSeek)')
    for (const seed of SEED) {
      const done = await rpc(record, 'spaces', 'setCredential', {
        id: 'default',
        providerId: PROVIDER,
        ...seed,
      })
      if (done?.success === false) throw new Error(`灌 key 失败:${done.error}`)
    }

    await page.evaluate(() => document.querySelector('[data-testid="dock-tile-providers"]').click())
    await waitFor('模型服务面就位', () =>
      page.evaluate(() => Boolean(document.querySelector(`[data-testid="provider-row-${'deepseek'}"]`))),
    )
    await page.evaluate(() => document.querySelector('[data-testid="provider-row-deepseek"]').click())
    await waitFor('两行都画出来了', async () => {
      const state = await read(page)
      return state.count === 2 ? state : undefined
    })
    // 指针停在远处:铅笔的休止读数不能是「鼠标恰好停在那一行上」的读数。
    await page.mouse.move(5, 5)
    await delay(500)

    /* ── a 休止 / 悬停 ──────────────────────────────────────────────── */
    console.log('\n[3/9] a 休止:铅笔占位但不可见;悬停后现身而 ⋯ 一字不动')
    const rest = await read(page)
    const restRow = rest.rows[1]
    console.log(`      · 行 2 高 ${restRow.row.h};铅笔 ${restRow.pencil.w}×${restRow.pencil.h} opacity=${restRow.pencil.opacity};⋯ x=${restRow.more.x}`)
    assert(restRow.pencil.opacity === '0', `a1 休止态铅笔不可见(opacity=${restRow.pencil.opacity})`)
    assert(restRow.pencil.w === 22 && restRow.pencil.h === 22, `a2 铅笔仍占 22×22(实际 ${restRow.pencil.w}×${restRow.pencil.h})`)
    assert(
      restRow.buttons.length === 2,
      `a3 一行恰两颗钮(铅笔 + ⋯),别的动作都进了菜单(实际 ${restRow.buttons.length} 颗)`,
    )
    const moreXBefore = restRow.more.x
    await page.mouse.move(restRow.row.x + restRow.row.w / 2, restRow.row.y + restRow.row.h / 2)
    await delay(600)
    const hovered = await read(page)
    const hoveredRow = hovered.rows[1]
    console.log(`      · 悬停后铅笔 opacity=${hoveredRow.pencil.opacity};⋯ x=${hoveredRow.more.x}`)
    assert(hoveredRow.pencil.opacity === '1', `a4 悬停后铅笔现身(opacity=${hoveredRow.pencil.opacity})`)
    assert(
      Math.abs(hoveredRow.more.x - moreXBefore) < 0.5,
      `a5 ⋯ 的 x 一字不动(${moreXBefore} → ${hoveredRow.more.x})`,
    )
    await page.mouse.move(5, 5)
    await delay(400)

    /* ── g 菜单 ────────────────────────────────────────────────────── */
    console.log('\n[4/9] g 菜单:五项都在;到顶 / 到底那一项禁灰不消失')
    await clickLabel(page, 'More actions for entry 1')
    await delay(250)
    const menu1 = (await read(page)).menuItems
    console.log(`      · 行 1 菜单:${menu1.map((i) => `${i.text}${i.disabled ? '(禁)' : ''}`).join(' / ')}`)
    assert(menu1.length === 5, `g1 五项都在(实际 ${menu1.length})`)
    assert(
      menu1.map((i) => i.text).join('|') === 'Replace key…|Rename label…|Move up|Move down|Delete…',
      'g2 顺序是 换密钥 / 改备注 / 上移 / 下移 / 删除',
    )
    assert(menu1[2].disabled === true, 'g3 行 1 到顶:Move up 禁灰(而不是消失)')
    assert(menu1[3].disabled === false, 'g4 行 1 的 Move down 可用')
    // 右对齐(`ui/float` 的 below-end):⋯ 贴着行右边线,左对齐会把整张菜单
    // 甩到面板外面去(改前实测探出右缘一大截,只靠视口 clamp 兜着)。
    const opened = await read(page)
    console.log(`      · 菜单 ${opened.menuRect.x}..${(opened.menuRect.x + opened.menuRect.w).toFixed(1)};面板右缘 ${(opened.panelRect.x + opened.panelRect.w).toFixed(1)}`)
    assert(
      opened.menuRect.x + opened.menuRect.w <= opened.panelRect.x + opened.panelRect.w + 1,
      'g6 菜单右对齐 ⋯,整张都在这块面里(不探出面板右缘)',
    )
    await page.keyboard.press('Escape')
    await delay(250)
    await clickLabel(page, 'More actions for entry 2')
    await delay(250)
    const menu2 = (await read(page)).menuItems
    assert(menu2.length === 5 && menu2[3].disabled === true, 'g5 行 2 到底:Move down 禁灰,五项仍全在')
    await page.keyboard.press('Escape')
    await delay(250)

    /* ── b 改密钥 ──────────────────────────────────────────────────── */
    console.log('\n[5/9] b 改密钥:旧值留屏 + 四者竖中线 + 行高 + 动作槽收走')
    await clickLabel(page, 'Replace the key on entry 1')
    await delay(400)
    const editing = (await read(page)).rows[0]
    const mids = [
      ['序号', editing.ordinalRect.mid],
      ['前缀', editing.prefix.mid],
      ['输入框', editing.input.mid],
      ['Save', editing.stripButtons[0].mid],
    ]
    const spread = Math.max(...mids.map((m) => m[1])) - Math.min(...mids.map((m) => m[1]))
    console.log(`      · 竖中线 ${mids.map(([n, v]) => `${n}=${v}`).join(' ')} → 极差 ${spread.toFixed(2)}px`)
    console.log(`      · 行高 ${editing.row.h};旧尾号「${editing.prefix.text}」;副行「${editing.meta.text}」`)
    assert(editing.prefix.text.includes('a477'), `b1 旧尾号仍在屏上(「${editing.prefix.text}」)`)
    assert(spread <= 1, `b2 序号 / 前缀 / 输入框 / Save 竖中线差 ≤ 1px(实际 ${spread.toFixed(2)}px)`)
    assert(editing.row.h <= 64, `b3 行高 ≤ 64(实际 ${editing.row.h})`)
    assert(Boolean(editing.meta) && editing.meta.text.length > 0, `b4 第 2 行副行仍在(「${editing.meta?.text}」)`)
    assert(editing.pencil === null && editing.more === null, 'b5 铅笔与 ⋯ 都不在树上(隐掉而不是禁掉)')
    assert(editing.input.type === 'password' && editing.input.value === '', 'b6 密钥格是 password 且从空开始(原文永不回读)')

    /* ── d 失焦不取消 ──────────────────────────────────────────────── */
    console.log('\n[6/9] d 失焦不取消:点卡外空白条还在,Esc 才收回')
    await page.keyboard.type('sk-typed-here')
    /*
     * 「卡外空白」取的是**这张卡下缘再往下 6px**(卡与卡之间那道气口)——
     * 不是屏幕左边那一列:那里是 provider 名册,点下去会换一家,量到的就不再是
     * 「失焦之后这一条还在不在」而是「换了一坑之后草稿有没有跟过来」(那是另一条)。
     */
    const cardRect = (await read(page)).card
    await page.mouse.click(cardRect.x + cardRect.w / 2, cardRect.y + cardRect.h + 6)
    await delay(400)
    const blurred = (await read(page)).rows[0]
    console.log(`      · 点空白之后:输入框 ${blurred.input ? `在,值「${blurred.input.value}」` : '没了'}`)
    assert(Boolean(blurred.input), 'd1 点卡外空白之后输入框仍在')
    assert(blurred.input?.value === 'sk-typed-here', `d2 草稿一个字不丢(「${blurred.input?.value}」)`)
    /*
     * 聚焦**行里那一格**再按 Esc。选择器一定要带 `li` —— 面板里的第一个 input
     * 是左栏名册的搜索框,对着它按 Esc 关的是整块面(首版就是这么把自己量没的)。
     * Esc 由 `ui/inline-edit` 局部接住并 `preventDefault`,全局派发器因此不响应。
     */
    await page.evaluate(() =>
      document.querySelector('[data-testid="providers-panel"] li input')?.focus(),
    )
    await page.keyboard.press('Escape')
    await delay(400)
    // 反证时这一行可能整个不见了(条被 blur 收走 → 焦点落到别处 → Esc 关掉了整块面)。
    // 取不到就如实判红,而不是让脚本崩在这儿 —— 崩掉的门读不出「哪一条错了」。
    const afterEsc = (await read(page)).rows[0] ?? {}
    assert('input' in afterEsc, 'd3-pre Esc 之后这一行还在(取不到 = 前面那两条已经把它带走了)')
    assert(afterEsc.input === null, 'd3 Esc 才收回')
    assert(afterEsc.mask?.includes('a477') === true, `d4 收回之后尾号回到第 1 行(「${afterEsc.mask}」)`)

    /* ── c 改备注 ──────────────────────────────────────────────────── */
    console.log('\n[7/9] c 改备注:预填现值并全选;第 1 行尾号不动')
    await clickLabel(page, 'More actions for entry 1')
    await delay(250)
    await clickText(page, '[role="menuitem"]', 'Rename label…')
    await delay(400)
    const labeling = (await read(page)).rows[0]
    console.log(`      · 值「${labeling.input.value}」选区 [${labeling.input.selectionStart}, ${labeling.input.selectionEnd}]`)
    assert(labeling.input.value === 'prod', `c1 预填现值(「${labeling.input.value}」)`)
    assert(
      labeling.input.selectionStart === 0 && labeling.input.selectionEnd === labeling.input.value.length,
      `c2 一进来就全选([${labeling.input.selectionStart}, ${labeling.input.selectionEnd}])`,
    )
    assert(labeling.mask?.includes('a477') === true, `c3 第 1 行尾号原样留着(「${labeling.mask}」)`)
    assert(
      !labeling.ordinalClass.includes('ordinalMid'),
      'c4 改备注不换序号的行高(它对齐的仍是第 1 行)',
    )
    await page.keyboard.press('Escape')
    await delay(300)

    /* ── f 删除确认 ────────────────────────────────────────────────── */
    console.log('\n[8/9] f 删除确认:那一行长出确认条,别的行零位移')
    const beforeConfirm = (await read(page)).rows[0].more
    await clickLabel(page, 'More actions for entry 2')
    await delay(250)
    await clickText(page, '[role="menuitem"]', 'Delete…')
    await delay(400)
    const confirming = await read(page)
    const row2 = confirming.rows[1]
    console.log(`      · 确认条「${row2.prefix?.text?.slice(0, 40)}…」;行 1 的 ⋯ ${beforeConfirm.x},${beforeConfirm.y} → ${confirming.rows[0].more.x},${confirming.rows[0].more.y}`)
    assert(
      (row2.prefix?.text ?? '').startsWith('Delete this key?'),
      `f1 行 2 长出确认条(「${row2.prefix?.text?.slice(0, 30)}」)`,
    )
    assert(row2.mask?.includes('0c2e') === true, `f2 第 1 行尾号不动(「${row2.mask}」)`)
    assert(
      Math.abs(confirming.rows[0].more.x - beforeConfirm.x) < 0.5 &&
        Math.abs(confirming.rows[0].more.y - beforeConfirm.y) < 0.5,
      'f3 别的行零位移(行 1 的 ⋯ x/y 一字不动)',
    )
    await clickText(page, 'button', 'Cancel')
    await delay(400)
    const afterCancel = (await read(page)).rows[1]
    assert(afterCancel.prefix === null, 'f4 Cancel 收回确认条')
    assert((await read(page)).count === 2, 'f5 取消之后一条都没删')

    /* ── e 添加 ────────────────────────────────────────────────────── */
    console.log('\n[9/9] e 添加:顶部新行一行排完、零重叠;空值禁;提交后 +1')
    await clickText(page, 'button', '＋ Add key')
    await delay(400)
    const adding = await read(page)
    const addRow = adding.rows[0]
    const parts = addRow.stripParts
    const tops = parts.map((p) => p.y)
    const topSpread = Math.max(...tops) - Math.min(...tops)
    const bad = overlaps(parts)
    console.log(`      · 列表 ${adding.count} 行(添加行在顶);条内 ${parts.length} 件,top 极差 ${topSpread.toFixed(2)}px,重叠 ${bad.length} 处`)
    assert(adding.count === 3, `e1 添加行长在**列表顶部**(总行数 ${adding.count},第 1 行是它)`)
    assert(addRow.inputs.length === 2, `e2 一行两格(密钥 + 备注),实际 ${addRow.inputs.length}`)
    assert(topSpread <= 1, `e3 一行排完:子元素 top 极差 ≤ 1px(实际 ${topSpread.toFixed(2)}px)`)
    assert(bad.length === 0, `e4 子元素两两零重叠(实际 ${JSON.stringify(bad)})`)
    const addBtn = addRow.stripButtons[0]
    assert(addBtn.text === 'Add' && addBtn.disabled === true, `e5 Add 在空值时禁(「${addBtn.text}」disabled=${addBtn.disabled})`)
    // 两格都自动聚焦的话,后挂载的备注格会把光标从密钥格抢走(首版就是这么长的)。
    assert(adding.activeLabel === 'New key', `e5b 一进来光标落在密钥格(实际在「${adding.activeLabel}」)`)
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="providers-panel"] li input')
      input.focus()
    })
    await page.keyboard.type('sk-added-by-gate-0001')
    await delay(300)
    const typed = (await read(page)).rows[0]
    assert(typed.stripButtons[0].disabled === false, 'e6 打了字 Add 就活了')
    await clickText(page, 'button', 'Add')
    const grown = await waitFor('列表长出第 3 条', async () => {
      const state = await read(page)
      return state.count === 3 && state.rows.every((r) => r.input === null) ? state : undefined
    })
    console.log(`      · 提交后 ${grown.count} 条:${grown.rows.map((r) => r.mask).join(' / ')}`)
    assert(grown.count === 3, `e7 提交后列表条数 +1(2 → ${grown.count})`)

    console.log('\n[gate:credential-pool] 读数汇总')
    console.log(`  休止行高 ${rest.rows[0].row.h} / 改密钥行高 ${editing.row.h} / 竖中线极差 ${spread.toFixed(2)}px`)
  } finally {
    if (app) await app.close().catch(() => {})
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.error(`\n[gate:credential-pool] FAILED —— ${failures.length} 条:`)
    for (const line of failures) console.error(`  · ${line}`)
    process.exit(1)
  }
  console.log('\n[gate:credential-pool] ok')
}

main().catch((error) => {
  console.error('\n[gate:credential-pool] FAILED:', error?.stack || error)
  process.exit(1)
})
