#!/usr/bin/env node
/**
 * React 壳 D2 的验收门 —— **脚本级,拒人肉 QA**(方案 §4 P1 那一行「主题变量数
 * 逐项断言」)。
 *
 * D0 的门证「连得上」,D1 的门证「屏幕上画的是 core 里的会话」。
 * D2 要证的是**屏幕上的颜色就是主题管道算出来的那一份**,所以这一条门问四件事,
 * dark / light 两个模式各问一轮:
 *
 *  ① 脚本用发现文件里的 token 直接把设置写成那个模式(`settings.saveSettings`),
 *     再直接问 core 要那一套变量表(`themes.apply`)—— 这一份是**事实**,
 *     全程绕开应用;
 *  ② 拉起应用 → 断言它自己判出来的 `{themeId, mode}` 与脚本算的一样
 *     (应用不许自己另判一套);
 *  ③ 断言应用内 `getComputedStyle(document.documentElement)` 上**抽样 12 个
 *     `--ui-*` 键**与那张表**逐字相等**(不是「有值就行」);
 *  ④ 断言桥的激活标记 `data-theme-bridge` 在场,且 `--surface-2` 的计算值
 *     **不再是 palette 的静态值** —— 也就是桥真的接管了,不是变量贴上去了
 *     但没人消费。
 *
 * 跑法:`node scripts/gate-theme.mjs`
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
// Electron 本体不在这个应用里重装一份 —— 理由见 gate-connect.mjs 顶部那段。
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

/**
 * 抽样的 12 个键。刻意**横跨六族**(面 / 墨 / 线 / accent / 状态 / 浮层),
 * 每一个都是 theme-bridge.css 里真的被消费的那一头 —— 抽一族全对不算过。
 */
const SAMPLE_KEYS = [
  '--ui-surface-app-bg',
  '--ui-surface-sidebar-bg',
  '--ui-surface-panel-bg',
  '--ui-surface-floating-bg',
  '--ui-text-primary-fg',
  '--ui-text-secondary-fg',
  /*
   * 从前这里是 `--ui-text-muted-fg`。2026-08-31 视觉守恒批把 --text-3 从「直取
   * muted」改成「从 --ui-text-primary-fg 按 70% 现兑」(理由与 36 组主题标定写在
   * theme-bridge.css),那个键从此**没有消费者** —— 留在抽样表里就违反了上面那句
   * 「每一个都是真的被消费的那一头」。换成同族里仍然直取的 faint(--text-4 吃它),
   * 墨族的抽样密度一点没降。
   */
  '--ui-text-faint-fg',
  '--ui-border-subtle-border',
  '--ui-border-default-border',
  '--ui-action-primary-bg',
  '--ui-status-danger-fg',
  '--ui-surface-tooltip-bg',
]

/** palette.css 里 `--surface-2` 的静态值。桥接管之后它必须**不再**是这个。 */
const PALETTE_SURFACE_2 = '#ffffff'
/** 与 theme-source.ts 同一个兜底 id。 */
const DEFAULT_THEME_ID = 'flexoki'

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

/** 用发现文件里的 token 打一条真 RPC(与 gate-data.mjs 逐字同款)。 */
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

/**
 * 跑一个模式的完整一轮。
 *
 * **每个模式重新拉起一次应用**,不靠推送面切换 —— 门要证的是「取数 → 判 → 贴」
 * 这条链在两个模式下都成立,重新启动是最不含糊的驱动方式(设置变更今天也确实
 * 没有 HTTP 推送面,见 src/theme/theme-port.ts 文件头的缺口记录)。
 */
async function runMode(record, store, mode) {
  console.log(`\n── ${mode} ──────────────────────────────────────────────`)

  // ① 把设置写成这个模式,并算出「事实」那一份变量表。
  const current = await rpc(record, 'settings', 'getSettings', {})
  const settings = current?.settings
  if (!settings) throw new Error('settings.getSettings 没给出设置')
  const saved = await rpc(record, 'settings', 'saveSettings', { ...settings, theme: mode })
  assert(saved?.success === true, `设置里的 theme 写成了 '${mode}'`)

  const expectedThemeId =
    (mode === 'dark' ? settings.general?.darkThemeId : settings.general?.lightThemeId) ||
    DEFAULT_THEME_ID
  const applied = await rpc(record, 'themes', 'apply', { themeId: expectedThemeId, mode })
  const table = applied?.cssVariables
  assert(
    applied?.success === true && table && Object.keys(table).length > 0,
    `core 给出 ${expectedThemeId}/${mode} 的变量表(${Object.keys(table ?? {}).length} 个键)`,
  )
  const missing = SAMPLE_KEYS.filter(k => !(k in table))
  assert(missing.length === 0, `抽样的 ${SAMPLE_KEYS.length} 个键都在表里`)

  // ② 拉起应用,等它自己判完并贴上。
  let app
  try {
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '' },
    })
    const page = await app.firstWindow()
    const probe = await waitFor('渲染层把主题变量贴上 :root', async () => {
      const value = await page.evaluate(() => window.__d2 ?? null)
      return value && value.applied ? value : undefined
    })
    assert(
      probe.themeId === expectedThemeId && probe.mode === mode,
      `应用判出的主题与脚本一致:${probe.themeId}/${probe.mode}`,
    )
    assert(
      probe.count === Object.keys(table).length,
      `贴上去的键数与表一致:${probe.count}`,
    )

    // ③ 抽样逐字比对计算样式。
    const computed = await page.evaluate(keys => {
      const style = getComputedStyle(document.documentElement)
      const out = {}
      for (const key of keys) out[key] = style.getPropertyValue(key).trim()
      return out
    }, SAMPLE_KEYS)
    const mismatched = SAMPLE_KEYS.filter(k => computed[k] !== String(table[k]).trim())
    assert(
      mismatched.length === 0,
      `抽样 ${SAMPLE_KEYS.length} 个 --ui-* 键与表逐字相等` +
        (mismatched.length
          ? `(不等:${mismatched
              .map(k => `${k} 屏上=${computed[k]} 表里=${table[k]}`)
              .join(' / ')})`
          : ''),
    )

    // ④ 桥真的接管了。
    const bridge = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return {
        marked: document.documentElement.hasAttribute('data-theme-bridge'),
        surface2: style.getPropertyValue('--surface-2').trim(),
        text1: style.getPropertyValue('--text-1').trim(),
        colorScheme: style.colorScheme,
      }
    })
    assert(bridge.marked, '桥的激活标记 data-theme-bridge 在场')
    assert(
      bridge.surface2.toLowerCase() !== PALETTE_SURFACE_2,
      `--surface-2 不再是 palette 静态值(现在是 ${bridge.surface2})`,
    )
    assert(
      bridge.surface2.toLowerCase() === String(table['--ui-surface-panel-bg']).trim().toLowerCase(),
      '--surface-2 就是主题的 --ui-surface-panel-bg',
    )
    assert(
      bridge.text1.toLowerCase() === String(table['--ui-text-primary-fg']).trim().toLowerCase(),
      '--text-1 就是主题的 --ui-text-primary-fg',
    )
    assert(bridge.colorScheme === mode, `color-scheme 跟着明暗走:${bridge.colorScheme}`)
  } finally {
    if (app) await app.close().catch(() => {})
  }
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[d2-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[d2-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'd2-gate-'))
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

    for (const mode of ['light', 'dark']) {
      await runMode(record, store, mode)
    }

    console.log('\n[d2-gate] ok —— 两个模式的颜色都来自主题管道,桥已接管')
  } finally {
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\n[d2-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
