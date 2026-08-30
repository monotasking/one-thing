#!/usr/bin/env node
/**
 * 动效档的**真机门**(08-31 阅读体验四件套 · 交付二 d)。
 *
 * 静态那半边(`npm run motion-gate`)查的是**写法**:keyframes 有没有住在产地、
 * 有没有人写字面 ms。这条门查的是**结果**:切到「无」之后,屏幕上是不是真的
 * 一个时长都不剩。两件事查不出彼此 —— 一条规规矩矩全用 var(--dur) 的样式表,
 * 只要有一个 token 忘了进档位块,静态门照样全绿而屏幕照样在动。
 *
 * 三轮,每轮重开一次应用(档位存在 localStorage 里,开场贴一次):
 *
 *  ① none  —— 遍历整棵 DOM(含浮层:门会把舞台 / 菜单 / toast 都开出来),
 *     `getComputedStyle` 断言 transition-duration / animation-duration **全 0**。
 *     两条豁免,逐条记在下面的 EXEMPT 表里。
 *  ② standard —— 断言**所有非零时长都落在 token 值集合里**。这一条抓的是
 *     「某处偷偷写了个 250ms」:它在静态门下可能藏在行内样式或 JS 里。
 *  ③ calm —— 断言五个减半的 token 真的减半了(读的是 :root 的计算值)。
 *
 * ── 两条豁免,以及为什么它们不是"放水" ────────────────────────────────────
 *  · `spin`(--dur-spin,700ms):spinner 是**进度读数**,不是装饰。一枚不转的
 *    spinner 传达的不是"安静",是"坏了"。它另有 prefers-reduced-motion 的降级
 *    (Spinner.module.css:换成一枚半透明整环),那条才是它该有的减弱形。
 *  · `toastLife`:toast 底缘那条剩余时间线,时长 = 这条 toast 还能活多久
 *    (JS 按级别以行内样式给)。归 0 等于让 toast 立刻消失。
 * 两条的共同判据:**这个数说的是"一件事要花多久",不是"一次形变要花多久"**。
 * 分类表写在 src/styles/motion.css 的文件头,那里是它的产地。
 *
 * 跑法:`node scripts/gate-motion.mjs`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 可重复:每次一个全新的临时 store,跑完删干净。
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

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

/** 阅读轴 store 的存盘键(与 src/reading/store.ts 的 `name` 同一个字符串)。 */
const READING_KEY = 'onething.reading'

/**
 * 「无」档下允许非零的动画名。判据见文件头 —— 它们的时长说的是「一件事要花多久」。
 * transition **没有**豁免:一次形变没有"寿命"可言。
 */
const EXEMPT_ANIMATIONS = new Set(['spin', 'toastLife'])

/** calm 档要减半的五个(与 src/styles/motion.css 的 calm 块同一张表)。 */
const CALM_HALVED = {
  '--dur-enter': [140, 70],
  '--dur-exit': [120, 60],
  '--dur-hover-fade': [300, 150],
  '--dur-flash': [240, 120],
  '--dur-scroll-settle': [400, 200],
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

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
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const settle = value => {
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

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败:${message}`)
  console.log(`  ✓ ${message}`)
}

/**
 * 拉起应用并把动效档写进存盘,然后重开一次让它生效。
 *
 * 为什么要重开而不是直接 setAttribute:门要证的是**整条链**(存盘 → store →
 * reading/apply → 属性 → CSS 档位块)都成立。直接贴属性只证了最后两段,
 * 而"设置面改了但 boot 时没贴上"正是最容易出的那种错。
 */
async function launchWithTier(store, tier) {
  const app = await electron.launch({
    executablePath: electronBinary,
    args: [mainEntry],
    env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '' },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(
    ([key, value]) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({ state: { fontSize: '14', density: 'comfortable', column: 'standard', motion: value, motionChosen: true }, version: 1 }),
      )
    },
    [READING_KEY, tier],
  )
  await page.reload()
  await waitFor(`档位贴上 documentElement(${tier})`, async () => {
    const probe = await page.evaluate(() => window.__reading ?? null)
    return probe && probe.applied && probe.motion === tier ? probe : undefined
  })
  return { app, page }
}

/**
 * 把能开的浮层都开出来,免得"全 0"只是因为屏幕上没东西。
 * 开不出来不算失败 —— 门的主体是遍历,浮层只是把样本铺得更宽。
 */
async function openFloatingLayers(page) {
  // Dock 得先画出来才点得着 —— 应用刚起时那一排瓦还没挂上。
  await waitFor('Dock 上的瓦就位', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid^="dock-tile"]'))),
  ).catch(() => undefined)
  const opened = await page.evaluate(async () => {
    const out = []
    // Dock 上的第一枚瓦:点开一扇浮窗(带 floatIn 出场)。
    const tile = document.querySelector('[data-testid^="dock-tile"]')
    if (tile instanceof HTMLElement) {
      tile.click()
      out.push('float')
    }
    await new Promise(r => setTimeout(r, 400))
    return out
  })
  // 真的开出来了才算数(下面「关掉即卸载」那对探针要它在场)。
  await waitFor('浮窗在场', () =>
    page.evaluate(() => document.querySelectorAll('[role="dialog"]').length > 0),
    5000,
  ).catch(() => undefined)
  return opened
}

/**
 * 关掉那扇浮窗,再等**两帧**,数还剩几扇。
 *
 * 为什么是两帧而不是「点完当场数」:React 的状态更新不是同步提交的,点完那一行
 * 读到的永远还是旧 DOM —— 那样的断言在任何档位下都会红,证不出档位的差别。
 * 两帧之后 React 一定已经提交,而 120ms 的出场动画一定还没播完。于是同一个探针
 * 在两档下给出相反的答案:「无」档下窗已经没了,standard 档下它还在(带 leaving)。
 * 一个探针 + 一个对照组,比一个绝对读数说明得多。
 *
 * 浮窗是 `role="dialog"`,头上最后一枚钮是「收回 Dock」——按**结构**找而不是按文案,
 * 门不该跟着界面语言变红变绿。
 */
function closeFloat(page) {
  return page.evaluate(async () => {
    const count = () => document.querySelectorAll('[role="dialog"]').length
    const before = count()
    if (before === 0) return { skipped: true }
    const buttons = document.querySelectorAll('[role="dialog"] header button')
    const close = buttons[buttons.length - 1]
    if (!(close instanceof HTMLElement)) return { skipped: true }
    close.click()
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return { skipped: false, before, after: count() }
  })
}

/** 遍历整棵 DOM,读每个元素的 transition/animation 时长。 */
function collectDurations(page) {
  return page.evaluate(() => {
    const rows = []
    const walk = (root) => {
      for (const el of root.querySelectorAll('*')) {
        const style = getComputedStyle(el)
        const names = style.animationName.split(',').map(s => s.trim())
        const animation = style.animationDuration.split(',').map(s => s.trim())
        const transition = style.transitionDuration.split(',').map(s => s.trim())
        const tag = el.tagName.toLowerCase()
        const mark = el.getAttribute('data-testid') || el.className?.toString?.().slice(0, 40) || ''
        for (let i = 0; i < animation.length; i += 1) {
          rows.push({ kind: 'animation', name: names[i] ?? 'none', value: animation[i], where: `${tag}.${mark}` })
        }
        for (const value of transition) {
          rows.push({ kind: 'transition', name: '', value, where: `${tag}.${mark}` })
        }
        if (el.shadowRoot) walk(el.shadowRoot)
      }
    }
    walk(document)
    return rows
  })
}

/** '0s' / '0ms' / '' 都算零。 */
function isZero(value) {
  if (!value) return true
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n === 0 : true
}

function toMs(value) {
  const n = Number.parseFloat(value)
  if (!Number.isFinite(n)) return 0
  return value.trim().endsWith('ms') ? n : n * 1000
}

async function runNone(store) {
  console.log('\n── none:切到「无」之后,屏幕上一个时长都不剩 ──────────────')
  const { app, page } = await launchWithTier(store, 'none')
  try {
    const opened = await openFloatingLayers(page)
    console.log(`  (顺手开出来的浮层:${opened.length ? opened.join(' / ') : '无'})`)
    const rows = await collectDurations(page)
    assert(rows.length > 50, `遍历到 ${rows.length} 条时长读数(样本够大)`)

    const offenders = rows.filter(r => {
      if (isZero(r.value)) return false
      return !(r.kind === 'animation' && EXEMPT_ANIMATIONS.has(r.name))
    })
    assert(
      offenders.length === 0,
      `非零时长 0 条(两条豁免:${[...EXEMPT_ANIMATIONS].join(' / ')})` +
        (offenders.length
          ? `;实际还剩:${offenders.slice(0, 12).map(o => `${o.where} ${o.kind}=${o.value}${o.name ? `(${o.name})` : ''}`).join(' · ')}`
          : ''),
    )

    // 反向断言:光有"全 0"不够 —— 档位块可能压根没被加载(比如 motion.css 没进
    // global.css),那时 :root 上的 --dur 还是 120ms 而元素恰好都没动画。
    const rootDur = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--dur').trim(),
    )
    assert(toMs(rootDur) === 0, `:root 上的 --dur 真的被档位块改成了 0(读到 ${rootDur})`)

    // 「无」档关浮窗即卸载:JS 侧的出场计时也直落(components/motion.ts 的 exitMs)。
    const immediate = await closeFloat(page)
    if (immediate.skipped) {
      console.log('  (没找到可关的浮窗,「关掉即卸载」这一条本轮跳过 —— 它另有单测钉着)')
    } else {
      assert(
        immediate.after === 0,
        `关浮窗**下一帧**就没有了:${immediate.before} → ${immediate.after}(standard 档那一轮是它的对照组)`,
      )
    }
  } finally {
    await app.close().catch(() => {})
  }
}

async function runStandard(store) {
  console.log('\n── standard:所有非零时长都在 token 值集合里 ─────────────────')
  const { app, page } = await launchWithTier(store, 'standard')
  try {
    await openFloatingLayers(page)
    // token 值集合从 :root 的计算样式里现读 —— 不在脚本里抄一份 tokens.css。
    const allowed = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      const out = new Set()
      for (const sheet of Array.from(document.styleSheets)) {
        let rules
        try {
          rules = sheet.cssRules
        } catch {
          continue
        }
        for (const rule of Array.from(rules ?? [])) {
          if (!(rule instanceof CSSStyleRule)) continue
          for (const prop of Array.from(rule.style)) {
            if (!prop.startsWith('--dur')) continue
            const value = style.getPropertyValue(prop).trim()
            if (value) out.add(value)
          }
        }
      }
      return [...out]
    })
    const allowedMs = new Set(allowed.map(v => Math.round(Number.parseFloat(v) * (v.endsWith('ms') ? 1 : 1000))))
    // toast 的寿命线时长由 JS 按级别给,不是 --dur 族;它的三档写在 tokens 里,
    // 上面那一圈已经收进来了。spinner 的 --dur-spin 同理。
    assert(allowedMs.size >= 10, `从 :root 现读到 ${allowedMs.size} 个 --dur 档值`)

    const rows = await collectDurations(page)
    const strays = rows.filter(r => !isZero(r.value) && !allowedMs.has(Math.round(toMs(r.value))))
    assert(
      strays.length === 0,
      '没有落在 token 值集合之外的时长' +
        (strays.length
          ? `;野生读数:${strays.slice(0, 12).map(s => `${s.where} ${s.kind}=${s.value}`).join(' · ')}`
          : ''),
    )

    // 「关掉即卸载」那条断言的**对照组**:同一个探针,这一档下窗必须还在
    // (它正在播 120ms 的出场)。没有这一条,那边的绿说明不了是档位起的作用。
    const held = await closeFloat(page)
    if (held.skipped) {
      console.log('  (没找到可关的浮窗,对照组本轮跳过)')
    } else {
      assert(held.after === held.before, `关浮窗后两帧仍在场(出场动画在播):${held.before} → ${held.after}`)
    }
  } finally {
    await app.close().catch(() => {})
  }
}

async function runCalm(store) {
  console.log('\n── calm:五个装饰时长减半,--dur 与 --dur-release 不动 ────────')
  const { app, page } = await launchWithTier(store, 'calm')
  try {
    const values = await page.evaluate(names => {
      const style = getComputedStyle(document.documentElement)
      const out = {}
      for (const name of names) out[name] = style.getPropertyValue(name).trim()
      return out
    }, [...Object.keys(CALM_HALVED), '--dur', '--dur-release'])

    for (const [name, [base, halved]] of Object.entries(CALM_HALVED)) {
      assert(toMs(values[name]) === halved, `${name} ${base}ms → ${values[name]}`)
    }
    assert(toMs(values['--dur']) === 120, `--dur 保持 ${values['--dur']}(跟手的基本节拍)`)
    assert(toMs(values['--dur-release']) === 160, `--dur-release 保持 ${values['--dur-release']}`)
  } finally {
    await app.close().catch(() => {})
  }
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[motion-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[motion-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'motion-gate-'))
  let server
  try {
    console.log('\n[0] 起一台 core')
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: { ...process.env, ONETHING_STORE_PATH: store },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serverErr = []
    server.stderr.on('data', chunk => serverErr.push(chunk.toString()))

    const record = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    }).catch(error => {
      throw new Error(`${error.message}\nserver stderr:\n${serverErr.join('')}`)
    })
    assert(await portConnects(record.host, record.port), `core 端口 ${record.port} 可连`)

    await runNone(store)
    await runStandard(store)
    await runCalm(store)

    console.log('\n[motion-gate] ok —— 三档都对得上:none 全 0(两条豁免)、standard 无野生时长、calm 减半')
  } finally {
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\n[motion-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
