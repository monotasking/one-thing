#!/usr/bin/env node
/**
 * **ACP 名册的壳侧真机门**(A1-b,正本 `docs/design/acp-integration-2026-09.md` §3.8 / §11.2)。
 *
 * ── 起法照 `gate-terminal`:壳自当 core ───────────────────────────────────
 * 名册的探测跑在**装配它的那台 core** 上(`acp.detect` 在 PATH 上找可执行、取版本号),
 * 而 React 壳的主进程在装配前先灌了登录 shell 的 PATH(`electron/login-shell-env.ts`)——
 * 拿独立 server 来量的话,量到的是另一台进程眼里的 PATH。所以不起 server,让壳自己装配
 * (`assembleOwnCore`,发现文件 owner = `shell`)。
 *
 * ── 两步 ────────────────────────────────────────────────────────────────
 *  ① 设置页「Agent」那一页列出种子 agent 与探测结果:至少 `claude-code` / `gemini` / `codex`
 *     三行在场;这台机器上**探测到了**的那几台,名册行与详情都写出了 `acp.getAgents` 报的
 *     那个版本号(没装的那几台读作「未安装」,门不假设这台机器装了什么)。
 *     另:**模型服务**那一页的名册里没有 ACP / claude-code-agent 那两家(2026-09-26 用户裁定:
 *     agent 不许被画成普通模型)。
 *  ② 模型选择器:agent 行住在「Agent」那一组(`picker-agent-group`),不在任何模型的组里;
 *     每一行带来源字、**没有窗口那一格**;经 core 的 `/api/rpc` 种一台命令不存在的自定义
 *     agent(确定性:它一定探测不到)→ 那一行置灰(`data-agent-missing` + 不透明度真的比
 *     普通行低)且悬停出装法提示。
 *
 * 反证:把 `composer/components/DrawerModelPicker.tsx` 里 `missing ? s.pickRowMissing : null`
 * 那一支挖掉 → ② 的「不透明度更低」当场红。
 *
 * ── 纪律(照 gate-terminal)─────────────────────────────────────────────
 * 临时 store(`settings.json` 里注册表开关关着 —— 不联网)+ 独立 `--user-data-dir` +
 * `ONETHING_GATE_HEADLESS=1` + 只用 CDP,不连 5175,`~/.onething` 零改动,
 * `finally` 里删掉种下的那一台并逐个收尸。
 *
 * 跑法:
 *   `npm run gate:acp-shell`            —— dev 渲染层(现起一台 vite,端口 5194)
 *   `npm run gate:acp-shell -- --prod`  —— prod 渲染层(吃 `npm run app:build` 的 dist)
 * (两档都要 `npm run electron:build` 产出的 `dist-electron/main.cjs`。)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

const PROD = process.argv.includes('--prod') || process.env.ONETHING_GATE_DIST === '1'
const LANE = PROD ? 'prod' : 'dev'

/** dev 档的 vite 端口。不是 5175(用户的),也不与别的门撞(5195–5199 都有人占)。 */
const DEV_PORT = Number(process.env.ONETHING_GATE_VITE_PORT ?? 5194)

/** 种下的那一台:命令一定不存在,所以它一定探测不到。 */
const TEMP_AGENT = 'gate-missing-agent'
const SEED_IDS = ['claude-code', 'gemini', 'codex']

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failed = false
function step(ok, line) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${line}`)
  if (!ok) failed = true
}

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
  const envelope = await response.json()
  if (envelope?.ok === false) throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(envelope)}`)
  return envelope?.data ?? envelope
}

const click = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) throw new Error(`找不到 ${sel}`)
    el.click()
  }, selector)

/** 模型抽屉的行用 mousedown 选中(抽屉判例);门只要点开药丸,不选行。 */
async function openModelDrawer(page) {
  await waitFor('模型药丸就位', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-model-pill"]'))),
  )
  await click(page, '[data-testid="composer-model-pill"]')
  await waitFor('Agent 那一组画出来', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="picker-agent-group"]'))),
  )
}

async function main() {
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[acp-shell-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'acp-shell-gate-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'acp-shell-gate-userdata-'))
  // 注册表不联网(门要确定性);名册只剩种子 + 种下的那一台。
  writeFileSync(
    path.join(store, 'settings.json'),
    JSON.stringify({ acp: { enabled: true, agents: [], registry: { enabled: false } } }, null, 2),
  )
  let app
  let vite
  let record
  try {
    let rendererUrl = ''
    if (!PROD) {
      const { createServer } = await import('vite')
      vite = await createServer({
        configFile: path.join(appRoot, 'vite.config.ts'),
        server: { port: DEV_PORT, strictPort: true },
        logLevel: 'warn',
      })
      await vite.listen()
      rendererUrl = vite.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${DEV_PORT}/`
    }
    console.log(`[acp-shell-gate] ${LANE} 档;壳自己装配 core(临时 store ${store})`)
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      /*
       * **cwd = 仓根**。未打包时种子目录按 `process.cwd()/resources/acp-agents` 解
       * (`getBuiltinResourcePath`),而 `electron:dev` 把 Electron 起在 `apps/desktop-react`
       * 下 —— 那里没有 `resources/`,名册里一台种子都不会有(A1-b 施工时量出来的存量缺口,
       * 内建 skills 同一条路同病;留账在交卷里,不在这道门里修)。门量的是壳,所以让它站在
       * 种子找得到的地方。
       */
      cwd: repoRoot,
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: rendererUrl,
        ONETHING_GATE_HEADLESS: '1',
      },
    })
    const page = await app.firstWindow()
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })

    record = await waitFor('壳内嵌的 core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.owner === 'shell' ? found : undefined
    })
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })

    // 种一台命令不存在的自定义 agent,并让 core 探测一遍(它一定探测不到)。
    const added = await rpc(record, 'acp', 'addAgent', {
      config: { id: TEMP_AGENT, name: 'Gate Missing', enabled: true, command: 'onething-gate-no-such-binary-7f3a', args: [] },
    })
    if (!added?.success) throw new Error(`acp.addAgent 没成:${JSON.stringify(added)}`)
    const detected = await rpc(record, 'acp', 'detect', {})
    const roster = detected?.agents ?? []
    const byId = new Map(roster.map((row) => [row.config.id, row]))

    // ── ① 设置页「Agent」 ─────────────────────────────────────────────────
    await click(page, '[data-testid="dock-tile-settings"]')
    await waitFor('设置页就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="settings-nav-agents"]'))),
    )
    await click(page, '[data-testid="settings-nav-agents"]')
    await waitFor('名册画出种子', () =>
      page.evaluate((ids) => ids.every((id) => document.querySelector(`[data-testid="agent-row-${id}"]`)), SEED_IDS),
    ).catch(async (error) => {
      const text = await page.evaluate(() => document.querySelector('[data-testid="agents-panel"]')?.textContent ?? '(没有 agents-panel)')
      throw new Error(`${error.message}\n名册(rpc):${[...byId.keys()].join(',')}\n此刻那一页:${text.slice(0, 600)}`)
    })
    // 打开这一页会再探测一遍(方案 §11.2);等那一发落地(钮上的 aria-busy 撤掉),
    // 再以 core 此刻的名册为准去对屏上的字 —— 屏上画的就是这一份。
    await delay(300)
    await waitFor('这一页的那一发探测落地', () =>
      page.evaluate(() => document.querySelector('[data-testid="agents-detect"]')?.getAttribute('aria-busy') !== 'true'),
      30_000,
    )
    for (const row of (await rpc(record, 'acp', 'getAgents', {}))?.agents ?? []) byId.set(row.config.id, row)
    const seen = []
    let versionsOk = true
    for (const id of SEED_IDS) {
      const state = byId.get(id)
      const rowText = await page.evaluate(
        (rowId) => document.querySelector(`[data-testid="agent-row-${rowId}"]`)?.textContent ?? '',
        id,
      )
      const installed = Boolean(state?.detect?.installed)
      const version = state?.detect?.version
      if (installed && version) {
        const ok = rowText.includes(version)
        if (!ok) versionsOk = false
        seen.push(`${id}=${version}${ok ? '' : '(行上没写版本)'}`)
      } else {
        seen.push(`${id}=${installed ? '已装无版本' : '未安装'}`)
      }
    }
    // 详情那一侧:点第一台探测到版本的,详情的安装行要写出同一个版本号。
    const firstInstalled = SEED_IDS.find((id) => byId.get(id)?.detect?.installed && byId.get(id)?.detect?.version)
    let detailOk = true
    if (firstInstalled) {
      await click(page, `[data-testid="agent-row-${firstInstalled}"]`)
      const text = await waitFor('详情那一台换过来', () =>
        page.evaluate(
          (id) => document.querySelector(`[data-testid="agent-detail-${id}"] [data-testid="agent-install-state"]`)?.textContent,
          firstInstalled,
        ),
      )
      detailOk = text.includes(byId.get(firstInstalled).detect.version)
    }
    step(
      versionsOk && detailOk,
      `① 设置·Agent 列出 ${SEED_IDS.join(' / ')} 三行,探测读数上屏:${seen.join(', ')}${firstInstalled ? `;详情(${firstInstalled})写出同一版本` : ';三台没有一台报出版本号,版本断言空过'}`,
    )

    await click(page, '[data-testid="settings-nav-models"]')
    await waitFor('模型服务名册画出来', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid^="provider-row-"]'))),
    )
    const agentFamilies = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="provider-row-"]')]
        .map((el) => el.getAttribute('data-testid').slice('provider-row-'.length))
        .filter((id) => id === 'acp' || id === 'claude-code-agent'),
    )
    step(agentFamilies.length === 0, `① 模型服务名册里没有 agent 那两家(实测:${agentFamilies.join(',') || '无'})`)

    await click(page, '[data-testid="dock-tile-settings"]')
    await waitFor('设置页已收回', () =>
      page.evaluate(() => !document.querySelector('[data-testid="settings-panel"]')),
    )

    // ── ② 模型选择器 ─────────────────────────────────────────────────────
    const made = await rpc(record, 'sessions', 'create', { name: 'acp shell gate' })
    const sessionId = made?.session?.id
    if (!sessionId) throw new Error('sessions.create 没给出会话 id')
    const rowShown = () =>
      page.evaluate((id) => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), sessionId)
    for (let attempt = 0; attempt < 3 && !(await rowShown()); attempt += 1) {
      await click(page, '[data-testid="dock-tile-sessions"]')
      await delay(500)
    }
    await waitFor('总览画出那一行', rowShown)
    await click(page, `[data-testid="session-row-${sessionId}"]`)
    await openModelDrawer(page)

    const picker = await waitFor('种下的那一台出现在 Agent 组里', () =>
      page.evaluate((tempId) => {
        const group = document.querySelector('[data-testid="picker-agent-group"]')
        const temp = group?.querySelector(`[data-testid="picker-agent-${tempId}"]`)
        if (!temp) return undefined
        const rows = [...group.querySelectorAll('[data-testid^="picker-agent-"]')].filter(
          (el) => el !== group && el.getAttribute('data-testid') !== 'picker-agent-source',
        )
        // 模型的组里有没有任何一行 agent:agent 的行只许住在 Agent 那一组。
        const scroll = group.parentElement
        const outside = [...scroll.children]
          .filter((el) => el !== group)
          .flatMap((el) => [...el.querySelectorAll('button')].map((b) => b.textContent ?? ''))
          .filter((text) => text.includes(tempId))
        const ready = rows.find(
          (el) => el.dataset.agentMissing !== 'true' && getComputedStyle(el).backgroundColor === 'rgba(0, 0, 0, 0)',
        )
        return {
          count: rows.length,
          labels: rows.map((el) => el.getAttribute('data-testid').slice('picker-agent-'.length)),
          everyHasSource: rows.every((el) => Boolean(el.querySelector('[data-testid="picker-agent-source"]'))),
          // 窗口那一格是一个「数字 + k/M」的读数;agent 行一格都不该有。
          anyWindow: rows.some((el) => /\b\d+(\.\d+)?\s?[kKmM]\b/.test(el.textContent ?? '')),
          outside: outside.length,
          missingFlag: temp.dataset.agentMissing === 'true',
          missingOpacity: Number(getComputedStyle(temp).opacity),
          readyOpacity: ready ? Number(getComputedStyle(ready).opacity) : null,
          // 对照行:模型组里**没有底色**的那一行(有底色的是键盘位 / 选中那一行)。
          modelRowOpacity: (() => {
            const other = [...scroll.children]
              .filter((el) => el !== group)
              .flatMap((el) => [...el.querySelectorAll('button')])
              .find((b) => getComputedStyle(b).backgroundColor === 'rgba(0, 0, 0, 0)')
            return other ? Number(getComputedStyle(other).opacity) : null
          })(),
        }
      }, TEMP_AGENT),
    ).catch(async (error) => {
      const text = await page.evaluate(() => document.querySelector('[data-testid="picker-agent-group"]')?.textContent ?? '(没有 Agent 组)')
      const roster = ((await rpc(record, 'acp', 'getAgents', {}))?.agents ?? []).map((r) => `${r.config.id}:${r.config.enabled}`)
      throw new Error(`${error.message}\nAgent 组此刻:${text.slice(0, 400)}\n名册(rpc):${roster.join(',')}`)
    })
    // 置灰 = 整行淡显(降透明,判词在 `--composer-agent-missing-opacity` 那一格上)。对照取
    // 模型组里一行普通的、或一台就绪的 agent 行;淡显那一行的不透明度必须真的比它低。
    const compareTo = picker.modelRowOpacity ?? picker.readyOpacity
    const greyed = picker.missingFlag && compareTo !== null && picker.missingOpacity < compareTo
    step(
      picker.outside === 0 && picker.everyHasSource && !picker.anyWindow,
      `② Agent 组 ${picker.count} 行(${picker.labels.join(', ')}):模型组里 agent 行 ${picker.outside} 条,每行带来源字=${picker.everyHasSource},窗口格=${picker.anyWindow ? '有' : '无'}`,
    )
    step(
      greyed,
      `② 未安装的 ${TEMP_AGENT} 置灰:flag=${picker.missingFlag},不透明度 ${picker.missingOpacity} vs 对照 ${compareTo}`,
    )

    // 悬停给装法(CDP 指针,只进这个窗口)。
    const box = await page.evaluate((tempId) => {
      const r = document.querySelector(`[data-testid="picker-agent-${tempId}"]`).getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, TEMP_AGENT)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
    const tip = await waitFor(
      '悬停出装法提示',
      () => page.evaluate(() => document.querySelector('[role="tooltip"]')?.textContent || undefined),
      5_000,
    ).catch(() => '')
    step(Boolean(tip), `② 悬停未安装那一行出提示:「${tip}」`)
  } finally {
    if (record) await rpc(record, 'acp', 'removeAgent', { agentId: TEMP_AGENT }).catch(() => {})
    if (app) await app.close().catch(() => {})
    if (vite) await vite.close().catch(() => {})
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
  }
  if (failed) {
    console.error('[acp-shell-gate] FAIL')
    process.exit(1)
  }
  console.log('[acp-shell-gate] ok')
}

main().catch((error) => {
  console.error('\n[acp-shell-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
