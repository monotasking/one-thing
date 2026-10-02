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
 *     另:**模型服务**那一页的名册里没有 ACP 那一家(2026-09-26 用户裁定;本地 CLI `claude-code-agent` A6-b 已退役:
 *     agent 不许被画成普通模型)。
 *  ② 模型选择器:agent 行住在「Agent」那一组(`picker-agent-group`),不在任何模型的组里;
 *     每一行带来源字、**没有窗口那一格**;经 core 的 `/api/rpc` 种一台命令不存在的自定义
 *     agent(确定性:它一定探测不到)→ 那一行置灰(`data-agent-missing` + 不透明度真的比
 *     普通行低)且悬停出装法提示。
 *
 *  ③ agent 会话(A2-c):一条会话绑到一台说 ACP 的假 agent(仓里的 `fake-agent.mjs`,与根
 *     `gate:acp` 同一只夹具),经 `acp.sessionOptions` 叫醒它 → 会话状态经 `acp:session-state`
 *     推到壳 → 模型药丸写的是 agent 报的 `category: 'model'` 那一格的名字(Alpha),模式粒写
 *     `modes` 的当前模式(Ask,只读 —— 夹具没有 `category: 'mode'` 的选项);点药丸在右卡把
 *     模型换成 Beta → 假 agent 的调用账里有一条 `set beta`(= `acp.setSessionOption` 真到了
 *     agent)且药丸换成 Beta。
 *  ④ 同一条会话里打 `/`:抽屉有「Agent 命令」一组,列着假 agent `session/new` 之后推来的
 *     `/review`。
 *
 *  ⑤ 权限卡按 agent 的选项画(A3-d):另一台假 agent(`FAKE_AGENT_PERMISSION=1`,缺省
 *     `unattended` = 拒 —— 卡真的要上屏)收到 `@perm1` 就在工具之前发一次四选项审批;
 *     屏上那张卡有四颗带 `data-permission-choice` 的钮,字是 agent 的原话
 *     (Allow / Always Allow / Reject / Always Reject);**人手**按下 `once` 那一颗 →
 *     假 agent 的调用账里那一问的结局是 `opt-allow-once`。
 *  ⑥ agent 开的终端(A3-d):同一台(`FAKE_AGENT_TERMINAL=1`)收到 `@term` 先问一次起命令的
 *     许可(人手答「允许一次」),然后起 `sh -c 'sleep 1; echo hi'`;它活着的那一秒里右键
 *     Dock 的终端瓦,菜单里「Agent」那一组有一行「Gate Perm 开的 · …」。这一步要桌面宿主
 *     (终端要 `hasTerminalHost()`),所以住在这只门里,不在 `gate:acp`。
 *
 *  ⑦ 工具卡保真(A2-c):第三台假 agent(`FAKE_AGENT_RICH_TOOLS=1`,`unattended: 'allow'` —— 终端桥
 *     不问就起)收到 `@rich` 跑一遍 A2-a 的剧本:`edit_file`(kind edit,带 locations 与 diff)+
 *     一次 `execute`(内容块是一格真终端)。屏上:那一行的工具名是 `edit_file`(不是文件名、不是
 *     `edit`);拉开抽屉有一块 diff,两侧是 `beta` / `BETA`;卡脚列着 `rich.txt:3`;execute 那一步的
 *     卡脚有「打开终端」。也要桌面宿主(终端桥要 `hasTerminalHost()`)。
 *
 *  ⑧ 从 Agent 导入(A5-b):第四台假 agent(`FAKE_AGENT_CAPS=list,fork,load`)的目录里预先放两条存着的
 *     会话(带 `history`,与根 `gate:acp` ⑳ 同一只夹具)。会话侧栏「从 Agent 导入…」→ 挑这一台 → 目录
 *     (主进程的 `dialog.showOpenDialog` 被门换成直接答临时工作目录 —— 系统对话框 CDP 够不着)→ 名单
 *     两行;axe 扫这扇窗;点第一行 → 本地多一条会话、正文里有夹具回放的那句话、一条「已导入 N 条」;
 *     再开一次 → 那一行写「已导入」,点它不多建一条。
 *  ⑨ 崩溃退避(A5-b):同一台 agent 连着 kill -9 并各发一条消息让它自动重连,直到 `backoff.latched`;
 *     设置页「Agent」那一台的进程行写「连不上,已停止重试」并有「重新连接」;点下去 → 闩撤掉。
 *     ⑧⑨ 都要 A5-a 的四条 RPC:先探一发 `acp.listRemoteSessions`,答不上来就整步 SKIP 并说「等 A5-a」。
 *
 * 反证:把 `content/permission/PermissionCard.tsx` 里 `if (ask.choices)` 那一支挖掉 → ⑤ 的
 * 「四颗 agent 的钮」当场红(卡退回五钮);把 `composer/components/DrawerModelPicker.tsx` 里 `missing ? s.pickRowMissing : null`
 * 那一支挖掉 → ② 的「不透明度更低」当场红;把 `composer/agent-claims.ts` 认领 `model` 的那一支
 * 挖掉 → ③ 的药丸退回写 agent id,当场红;把 `content/tools/presenters/index.ts` 里类别表那一行
 * (`registerToolPresenter(kindPresenter)`)注掉 → ⑦ 的第一条当场红:没有类别表,`edit_file` 落兜底,
 * 名字还是它,但文件名摘要没了、图标退成扳手(diff 块兜底照样画 —— `changes` 在场就画是另一条法,
 * 所以反证判的是「行按类别借了 edit 的画法」那一格,不是 diff)。
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
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { AxeBuilder } from '@axe-core/playwright'
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
/** ③④ 那一台:真说 ACP 的假 agent(`packages/backend/runtime/acp/__tests__/fixtures/fake-agent.mjs`)。 */
const FAKE_AGENT = 'gate-fake-agent'
const fakeAgentScript = path.join(repoRoot, 'packages/backend/runtime/acp/__tests__/fixtures/fake-agent.mjs')
const SEED_IDS = ['claude-code', 'gemini', 'codex']
/** ⑤⑥ 那一台:同一只假 agent,打开审批与终端两条剧本;`unattended` 不写 = 缺省拒,卡真的上屏。 */
const PERM_AGENT = 'gate-perm-agent'
const PERM_AGENT_NAME = 'Gate Perm'
/** ⑦ 那一台:同一只假 agent,打开 A2-a 的 `@rich` 剧本;无人应答放行,终端桥不问就起。 */
const RICH_AGENT = 'gate-rich-agent'
/** ⑧⑨ 那一台:同一只假 agent,声明 list / fork / load;目录里预先放两条存着的会话。 */
const LIFE_AGENT = 'gate-life-agent'
const LIFE_AGENT_NAME = 'Gate Life'

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

/**
 * **屏上看得见的那块输入面板**。一片会话叶一块面板,而停靠池会留着刚离开的那几片(藏着、
 * 不卸载)—— `querySelector` 拿到的第一块未必是人正看着的那一块。③④ 的读与点都经它。
 */
const PANEL = '[data-testid="composer-panel"]'

const liveText = (page, sub) =>
  page.evaluate(
    ({ panelSel, sub }) =>
      [...document.querySelectorAll(panelSel)].find((el) => el.checkVisibility())?.querySelector(sub)?.textContent ??
      undefined,
    { panelSel: PANEL, sub },
  )

const clickLive = (page, sub) =>
  page.evaluate(
    ({ panelSel, sub }) => {
      const el = [...document.querySelectorAll(panelSel)].find((p) => p.checkVisibility())?.querySelector(sub)
      if (!el) throw new Error(`看得见的面板里找不到 ${sub}`)
      el.click()
    },
    { panelSel: PANEL, sub },
  )

/**
 * **真指针按一下**(09-29 立,起因:`page.evaluate(() => option.click())` 是一发合成 click,不带
 * pointerdown —— 宿主的点外关(`ui/float.useFloatDismiss`,听的是 window 上的 pointerdown)
 * 一次都没被问到,于是「按下 Select 的选项 → 抽屉在捕获相位先关 → 选项的 click 永远没跑」
 * 这一形在 ③ 上绿了两个月,真机上是「抽屉整个没了、什么都没选上」)。凡是**选**一项
 * (下拉的选项 / 抽屉与挑选窗里的行)一律走这里:`page.mouse` 经 CDP 只进这扇窗,发的是
 * 完整的 pointerdown → mousedown → pointerup → mouseup → click,与人手逐字同序。
 *
 * `find` 在页面里跑,交回要按的那一个元素(找不到交 null)。按之前 Playwright 自己滚进视野、
 * 验中心点真落在它身上 —— 落在别的东西上时按下去只会静默地点错(② 悬停那一格踩过:
 * 行在滚动口外,指针打在输入框上)。
 */
async function pressReal(page, label, find, arg) {
  const handle = await page.evaluateHandle(find, arg)
  const el = handle.asElement()
  if (!el) {
    await handle.dispose()
    throw new Error(`真指针:找不到 ${label}`)
  }
  try {
    // ElementHandle.click = 滚进视野 → 等它稳定、可点 → 验中心点没被别的东西盖着 → page.mouse 按下松开。
    await el.click({ timeout: 5_000 })
  } catch (error) {
    throw new Error(`真指针:按 ${label} 没成:${error.message.split('\n')[0]}`)
  } finally {
    await el.dispose()
  }
}

/** 看得见的那块输入面板里的 `sub`(`pressReal` 的定位函数;在页面里跑,只能用参数)。 */
const inLivePanel = ({ panelSel, sub }) =>
  [...document.querySelectorAll(panelSel)].find((el) => el.checkVisibility())?.querySelector(sub) ?? null

/** 整页里第一个 `sel`(`pressReal` 的定位函数)。 */
const inDocument = (sel) => document.querySelector(sel)

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
  const workDir = realpathSync(await mkdtemp(path.join(tmpdir(), 'acp-shell-gate-work-')))
  const fakeAgentDir = path.join(store, 'fake-agent')
  const permAgentDir = path.join(store, 'fake-agent-perm')
  const richAgentDir = path.join(store, 'fake-agent-rich')
  const lifeAgentDir = path.join(store, 'fake-agent-life')
  /*
   * ⑧ 的两条存着的会话(夹具的会话文件形:`<dir>/<id>.json`;`history` 在 `session/load` 时按序回放,
   * `title` / `updatedAt` 进 `session/list` 的答复)。cwd = 临时工作目录 —— 门挑的就是它。
   */
  mkdirSync(lifeAgentDir, { recursive: true })
  const storedNow = Date.now()
  for (const [id, title, reply, ago] of [
    ['stored-a', 'Stored alpha', 'imported reply alpha', 60_000],
    ['stored-b', 'Stored beta', 'imported reply beta', 3_600_000],
  ]) {
    writeFileSync(
      path.join(lifeAgentDir, `${id}.json`),
      JSON.stringify({
        id,
        cwd: workDir,
        model: 'alpha',
        turns: 0,
        title,
        updatedAt: new Date(storedNow - ago).toISOString(),
        history: [
          { kind: 'user', text: `hello ${id}` },
          { kind: 'agent', text: reply },
        ],
      }),
    )
  }
  /*
   * 注册表不联网(门要确定性);名册 = 种子 + ③④ 那一台假 agent(env 与根 `gate:acp` 同一份形:
   * `FAKE_AGENT_PUSH_COMMANDS=1` 让它 `session/new` 一答完就推命令表;`unattended: 'allow'` 是
   * A3-a 之后的字段名,③④ 不验审批)+ ② 里经 RPC 现种的那一台。
   */
  writeFileSync(
    path.join(store, 'settings.json'),
    JSON.stringify(
      {
        acp: {
          enabled: true,
          registry: { enabled: false },
          agents: [
            {
              id: FAKE_AGENT,
              name: 'Gate Fake',
              enabled: true,
              command: process.execPath,
              args: [fakeAgentScript],
              env: { FAKE_AGENT_CAPS: 'load', FAKE_AGENT_DIR: fakeAgentDir, FAKE_AGENT_PUSH_COMMANDS: '1' },
              unattended: 'allow',
            },
            {
              id: PERM_AGENT,
              name: PERM_AGENT_NAME,
              enabled: true,
              command: process.execPath,
              args: [fakeAgentScript],
              env: { FAKE_AGENT_CAPS: 'load', FAKE_AGENT_DIR: permAgentDir, FAKE_AGENT_PERMISSION: '1', FAKE_AGENT_TERMINAL: '1' },
            },
            {
              id: RICH_AGENT,
              name: 'Gate Rich',
              enabled: true,
              command: process.execPath,
              args: [fakeAgentScript],
              env: { FAKE_AGENT_CAPS: 'load', FAKE_AGENT_DIR: richAgentDir, FAKE_AGENT_RICH_TOOLS: '1' },
              unattended: 'allow',
            },
            {
              id: LIFE_AGENT,
              name: LIFE_AGENT_NAME,
              enabled: true,
              command: process.execPath,
              args: [fakeAgentScript],
              env: { FAKE_AGENT_CAPS: 'list,fork,load', FAKE_AGENT_DIR: lifeAgentDir },
              unattended: 'allow',
            },
          ],
        },
        // 正常模式:⑤⑥ 的卡要真的上屏(`dangerously-allow-all` 会让许可核一张都不问;与 `gate:acp` 同一格)。
        tools: { enableToolCalls: false, permissionMode: 'normal', tools: {} },
      },
      null,
      2,
    ),
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
    // 渲染层的错话攒着:首屏等不到时一并报出来(否则只有一句「超时」)。
    const consoleErrors = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300))
    })
    page.on('pageerror', (error) => consoleErrors.push(String(error?.message ?? error).slice(0, 300)))
    const cdp = await app.context().newCDPSession(page)
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true })

    record = await waitFor('壳内嵌的 core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.owner === 'shell' ? found : undefined
    })
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    }).catch((error) => {
      throw new Error(`${error.message}\n渲染层错话:${consoleErrors.slice(0, 6).join('\n') || '(无)'}`)
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
        .filter((id) => id === 'acp'),
    )
    step(agentFamilies.length === 0, `① 模型服务名册里没有 agent 那一家(实测:${agentFamilies.join(',') || '无'})`)

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

    // 悬停给装法(CDP 指针,只进这个窗口)。先把那一行滚进抽屉的可视段:⑦ 多种了一台假 agent 之后
    // Agent 组 9 行,最后那一行(种的这一台)落在抽屉滚动口之外,取它的矩形中心会打在输入框上
    // (探针读数:elementFromPoint = composer-input,没有任何 tooltip 节点)—— 指针根本没到那一行。
    const box = await page.evaluate((tempId) => {
      const row = document.querySelector(`[data-testid="picker-agent-${tempId}"]`)
      row.scrollIntoView({ block: 'center' })
      const r = row.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }, TEMP_AGENT)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
    const tip = await waitFor(
      '悬停出装法提示',
      () => page.evaluate(() => document.querySelector('[role="tooltip"]')?.textContent || undefined),
      5_000,
    ).catch(async () => {
      const probe = await page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y)
        return {
          tips: [...document.querySelectorAll('[role="tooltip"]')].map((el) => el.textContent),
          hit: hit ? `${hit.tagName}.${hit.className} ${hit.closest('[data-testid]')?.getAttribute('data-testid') ?? ''}` : null,
        }
      }, box)
      return `(没等到)${JSON.stringify(probe)}`
    })
    step(Boolean(tip) && !tip.startsWith('(没等到)'), `② 悬停未安装那一行出提示:「${tip}」`)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
    // 收起抽屉(药丸是开合钮),③ 从一块干净的面板起。
    await click(page, '[data-testid="composer-model-pill"]')

    // ── ③ agent 会话:药丸 / 模式粒按 category 认领 ─────────────────────
    const agentMade = await rpc(record, 'sessions', 'create', { name: 'acp shell gate · agent' })
    const agentSessionId = agentMade?.session?.id
    if (!agentSessionId) throw new Error('sessions.create 没给出 agent 会话 id')
    await rpc(record, 'sessions', 'updateWorkingDirectory', { sessionId: agentSessionId, workingDirectory: workDir })
    const agentRowShown = () =>
      page.evaluate((id) => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), agentSessionId)
    for (let attempt = 0; attempt < 3 && !(await agentRowShown()); attempt += 1) {
      await click(page, '[data-testid="dock-tile-sessions"]')
      await delay(500)
    }
    await waitFor('总览画出 agent 会话那一行', agentRowShown)
    await click(page, `[data-testid="session-row-${agentSessionId}"]`)
    /*
     * 选 agent 走**人手那条路**:开药丸抽屉、按下 Agent 组里那一行(抽屉判例:行用 mousedown 选中)。
     * 不走 `sessions.updateModel` 直写 —— 那一发不推会话摘要,壳上的药丸不会跟着换(量出来的)。
     */
    await clickLive(page, '[data-testid="composer-model-pill"]')
    await waitFor('Agent 组里有假 agent 那一行', () => liveText(page, `[data-testid="picker-agent-${FAKE_AGENT}"]`))
    // 真指针(`pressReal` 头上那条):从前是一发合成 mousedown,问不到抽屉的点外关。
    await pressReal(page, `抽屉里 ${FAKE_AGENT} 那一行`, inLivePanel, {
      panelSel: PANEL,
      sub: `[data-testid="picker-agent-${FAKE_AGENT}"]`,
    })
    await waitFor('药丸写着 agent id(还没叫醒它)', async () =>
      (await liveText(page, '[data-testid="composer-model-pill"]'))?.includes(FAKE_AGENT) || undefined,
    )
    // 叫醒:这一发让后端连上假 agent、开会话;之后的状态全走 `acp:session-state` 推到壳。
    const woke = await rpc(record, 'acp', 'sessionOptions', { agentId: FAKE_AGENT, sessionId: agentSessionId })
    if (!woke?.success) throw new Error(`acp.sessionOptions 没成:${JSON.stringify(woke)}`)
    const claimed = await waitFor('药丸与模式粒换成 agent 报的值', async () => {
      const pill = await liveText(page, '[data-testid="composer-model-pill"]')
      const mode = await liveText(page, '[data-testid="composer-mode-pill"]')
      const settable = await page.evaluate(
        ({ panelSel }) =>
          [...document.querySelectorAll(panelSel)]
            .find((el) => el.checkVisibility())
            ?.querySelector('[data-testid="composer-mode-pill"]')
            ?.getAttribute('data-mode-settable'),
        { panelSel: PANEL },
      )
      return pill?.includes('Alpha') && mode ? { pill, mode, settable } : undefined
    }).catch(async (error) => {
      throw new Error(`${error.message}\n此刻药丸:${await liveText(page, '[data-testid="composer-model-pill"]')}`)
    })
    step(
      claimed.pill.includes('Alpha') && claimed.mode === 'Ask' && claimed.settable === 'false',
      `③ 药丸认领 category=model → 「${claimed.pill}」;模式粒 → 「${claimed.mode}」(只读=${claimed.settable === 'false'})`,
    )

    await clickLive(page, '[data-testid="composer-model-pill"]')
    const COMBO = '[data-testid="agent-options-card"] [data-agent-option="model"] [role="combobox"]'
    await waitFor('右卡的模型下拉就位', () => liveText(page, COMBO))
    // 开下拉与按选项都走真指针:09-29 事故那一形(按下选项 → 抽屉在捕获相位先关 → 什么都没选上)
    // 只有带 pointerdown 的一按才问得出来,`option.click()` 在这里绿了两个月。
    await pressReal(page, '右卡的模型下拉', inLivePanel, { panelSel: PANEL, sub: COMBO })
    await waitFor('模型下拉展开', () =>
      page.evaluate(() => [...document.querySelectorAll('[role="option"]')].some((el) => el.textContent?.includes('Beta'))),
    )
    await pressReal(
      page,
      '下拉里的 Beta',
      (text) => [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent?.includes(text)) ?? null,
      'Beta',
    )
    // 选完抽屉**留着**(卡上换成新值);只有左栏那一行选中才收抽屉。抽屉没了 = 事故复发。
    const drawerKept = await page.evaluate(
      ({ panelSel }) =>
        Boolean(
          [...document.querySelectorAll(panelSel)]
            .find((el) => el.checkVisibility())
            ?.querySelector('[data-testid="agent-options-card"]')
            ?.checkVisibility(),
        ),
      { panelSel: PANEL },
    )
    step(drawerKept, `③ 真指针按下选项之后模型抽屉还在(右卡 ${drawerKept ? '在场' : '没了 —— 点外关把选项那一下当成了外面'})`)
    const setCall = await waitFor('假 agent 收到 set_config_option = beta', () => {
      const file = path.join(fakeAgentDir, 'calls.log')
      if (!existsSync(file)) return undefined
      return readFileSync(file, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((entry) => entry.method === 'set' && entry.value === 'beta')
    }).catch(() => undefined)
    const pillAfter = await waitFor('药丸换成 Beta', async () => {
      const text = (await liveText(page, '[data-testid="composer-model-pill"]')) ?? ''
      return text.includes('Beta') ? text : undefined
    }).catch(() => '')
    step(Boolean(setCall) && Boolean(pillAfter), `③ 右卡把模型换成 Beta:agent 收到 set=${setCall ? 'beta' : '无'};药丸「${pillAfter}」`)
    await clickLive(page, '[data-testid="composer-model-pill"]')

    // ── ④ `/` 抽屉并入 agent 推来的命令 ────────────────────────────────
    await page.evaluate(({ panelSel }) => {
      const panel = [...document.querySelectorAll(panelSel)].find((el) => el.checkVisibility())
      panel.querySelector('[contenteditable="true"]').focus()
    }, { panelSel: PANEL })
    await page.keyboard.type('/')
    const commandsSeen = await waitFor('「Agent 命令」一组列出 /review', async () => {
      const text = (await liveText(page, '[data-testid="composer-drawer"]')) ?? ''
      return text.includes('/review') && /Agent 命令|Agent commands/.test(text) ? text : undefined
    }).catch(async () => `(没等到)${(await liveText(page, '[data-testid="composer-drawer"]')) ?? ''}`)
    step(
      commandsSeen.includes('/review') && !commandsSeen.startsWith('(没等到)'),
      `④ 斜杠抽屉:Agent 命令一组在场,列着 agent 推来的 /review(抽屉字面前 120 字:${commandsSeen.slice(0, 120)})`,
    )
    await page.keyboard.press('Backspace')

    // ── ⑤ 权限卡按 agent 的选项画,人手按 once ───────────────────────────
    const permMade = await rpc(record, 'sessions', 'create', { name: 'acp shell gate · perm' })
    const permSessionId = permMade?.session?.id
    if (!permSessionId) throw new Error('sessions.create 没给出 perm 会话 id')
    await rpc(record, 'sessions', 'updateWorkingDirectory', { sessionId: permSessionId, workingDirectory: workDir })
    await rpc(record, 'sessions', 'updateModel', { sessionId: permSessionId, provider: 'acp', model: PERM_AGENT })
    const permRowShown = () =>
      page.evaluate((id) => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), permSessionId)
    for (let attempt = 0; attempt < 3 && !(await permRowShown()); attempt += 1) {
      await click(page, '[data-testid="dock-tile-sessions"]')
      await delay(500)
    }
    await waitFor('总览画出 perm 会话那一行', permRowShown)
    await click(page, `[data-testid="session-row-${permSessionId}"]`)
    await delay(300)
    const sendToPerm = (content) =>
      rpc(record, 'session-command', 'emit', {
        sessionId: permSessionId,
        command: { type: 'command:send-message', content, suppressTitleGeneration: true },
      })
    /** 屏上看得见的、还能答的那几张卡(已答 / 排队的不算)。 */
    const liveCards = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-permission-card]')]
          .filter((el) => el.checkVisibility() && !el.hasAttribute('data-answered') && !el.hasAttribute('data-queued'))
          .map((el) => ({
            id: el.getAttribute('data-permission-card'),
            choices: [...el.querySelectorAll('[data-permission-choice]')].map((b) => ({
              kind: b.getAttribute('data-permission-choice'),
              label: b.textContent,
            })),
            decisions: [...el.querySelectorAll('[data-permission-decision]')].map((b) => b.getAttribute('data-permission-decision')),
          })),
      )
    /** 人手按一颗钮:那张卡上 `data-permission-decision` = decision 的那一颗(CDP 指针,只进这扇窗)。 */
    const pressOnCard = async (cardId, decision) => {
      const box = await page.evaluate(
        ({ cardId, decision }) => {
          const card = [...document.querySelectorAll('[data-permission-card]')].find(
            (el) => el.getAttribute('data-permission-card') === cardId && el.checkVisibility(),
          )
          const button = card?.querySelector(`[data-permission-decision="${decision}"]`)
          if (!button) return null
          button.scrollIntoView({ block: 'center' })
          const r = button.getBoundingClientRect()
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
        },
        { cardId, decision },
      )
      if (!box) throw new Error(`卡 ${cardId} 上找不到 ${decision} 那一颗`)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 })
    }
    const permCalls = () => {
      const file = path.join(permAgentDir, 'calls.log')
      if (!existsSync(file)) return []
      return readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    }

    await sendToPerm('@perm1 跑一下构建')
    const card = await waitFor(
      '带 agent 选项的权限卡上屏',
      async () => (await liveCards()).find((c) => c.choices.length > 0 || c.decisions.length > 0),
      30_000,
    ).catch(async (error) => {
      const text = await page.evaluate(() => document.querySelector('[data-testid="composer-panel"]')?.closest('[data-pane-leaf]')?.textContent ?? '')
      throw new Error(`${error.message}\n会话叶此刻:${text.slice(0, 500)}`)
    })
    const kinds = card.choices.map((c) => c.kind)
    const wantKinds = ['once', 'always', 'reject', 'reject-always']
    const labelsOk = card.choices.map((c) => c.label).join('|') === 'Allow|Always Allow|Reject|Always Reject'
    step(
      kinds.length === 4 && wantKinds.every((k) => kinds.includes(k)) && labelsOk,
      `⑤ 权限卡按 agent 的选项画:${card.choices.map((c) => `${c.kind}=「${c.label}」`).join(' · ') || '(一颗 agent 的钮都没有)'};整排 ${card.decisions.join(',')}`,
    )
    if (kinds.includes('once')) await pressOnCard(card.id, 'once')
    const permOutcome = await waitFor('假 agent 记下那一问的结局', () =>
      permCalls().find((call) => call.method === 'permission'),
    ).catch(() => undefined)
    step(
      permOutcome?.outcome?.optionId === 'opt-allow-once',
      `⑤ 人手按 once → agent 收到 ${JSON.stringify(permOutcome?.outcome ?? null)}`,
    )

    // ── ⑥ agent 开的终端出现在「Agent」那一组 ─────────────────────────────
    await sendToPerm('@term 起个终端')
    // 起命令之前先问一次许可(bash 效果,本地那五钮):人手答「允许一次」。
    const termCard = await waitFor(
      '起命令的许可卡上屏',
      async () => (await liveCards()).find((c) => c.decisions.includes('once') && c.id !== card.id),
      30_000,
    )
    await pressOnCard(termCard.id, 'once')
    const agentTerminal = await waitFor(
      'terminal.list 里出现 agent 开的那一格',
      async () =>
        ((await rpc(record, 'terminal', 'list', {}))?.terminals ?? []).find(
          (row) => row.owner?.kind === 'acp' && row.owner?.agentId === PERM_AGENT && !row.exited,
        ),
      15_000,
    )
    // 它只活一秒(`sleep 1; echo hi` 之后 agent 就 release)—— 立刻右键终端瓦。菜单一旦画出来就不再
    // 跟着名单变(没有常驻订阅),所以只要补拉那一发赶在 release 之前回来就读得到。
    await page.evaluate(() => {
      const tile = document.querySelector('[data-testid="dock-tile-terminal"]')
      if (!(tile instanceof HTMLElement)) throw new Error('找不到终端瓦')
      const rect = tile.getBoundingClientRect()
      tile.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }),
      )
    })
    const menuRow = await waitFor(
      '菜单里「Agent」那一组有那一行',
      () =>
        page.evaluate((terminalId) => {
          const label = document.querySelector(`[data-terminal-row="${terminalId}"]`)
          if (!label) return undefined
          const item = label.closest('[role="menuitem"]')
          // 往上找这一行所在的组头:同一张菜单里它前面最近的那一个 section。
          let heading = ''
          for (let el = item?.previousElementSibling; el; el = el.previousElementSibling) {
            if (el.getAttribute('role') === 'presentation' && !el.matches('hr, [role="separator"]') && el.textContent) {
              heading = el.textContent
              break
            }
          }
          return { text: label.textContent, owner: label.getAttribute('data-terminal-owner'), heading }
        }, agentTerminal.id),
      5_000,
    ).catch(async () => ({
      text: `(没画出来)菜单此刻:${await page.evaluate(() => [...document.querySelectorAll('[role="menu"]')].map((m) => m.textContent).join(' / '))}`,
      owner: null,
      heading: '',
    }))
    step(
      menuRow.owner === 'acp' && menuRow.heading === 'Agent' && (menuRow.text ?? '').includes(PERM_AGENT_NAME),
      `⑥ agent 开的终端 ${agentTerminal.id}:组头「${menuRow.heading}」,那一行「${menuRow.text}」`,
    )
    await page.keyboard.press('Escape')
    // 第二张卡(`sleep 30` 那一格)也答掉,让这一轮收场,不留一个挂着的 agent 给收尸。
    const sleeperCard = await waitFor(
      '第二张起命令的卡',
      async () => (await liveCards()).find((c) => c.decisions.includes('once') && c.id !== termCard.id && c.id !== card.id),
      10_000,
    ).catch(() => undefined)
    if (sleeperCard) await pressOnCard(sleeperCard.id, 'once')

    // ── ⑦ 工具卡保真:类别表 / diff / 卡脚位置 / 打开终端 ─────────────────
    const richMade = await rpc(record, 'sessions', 'create', { name: 'acp shell gate · rich' })
    const richSessionId = richMade?.session?.id
    if (!richSessionId) throw new Error('sessions.create 没给出 rich 会话 id')
    await rpc(record, 'sessions', 'updateWorkingDirectory', { sessionId: richSessionId, workingDirectory: workDir })
    await rpc(record, 'sessions', 'updateModel', { sessionId: richSessionId, provider: 'acp', model: RICH_AGENT })
    const richRowShown = () =>
      page.evaluate((id) => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)), richSessionId)
    for (let attempt = 0; attempt < 3 && !(await richRowShown()); attempt += 1) {
      await click(page, '[data-testid="dock-tile-sessions"]')
      await delay(500)
    }
    await waitFor('总览画出 rich 会话那一行', richRowShown)
    await click(page, `[data-testid="session-row-${richSessionId}"]`)
    await delay(300)
    await rpc(record, 'session-command', 'emit', {
      sessionId: richSessionId,
      command: { type: 'command:send-message', content: '@rich 改一下 rich.txt 再跑个 echo', suppressTitleGeneration: true },
    })
    /** 看得见的那张装着 `rich-edit-*` 的卡(停靠池里藏着的叶不算)。 */
    const RICH_CARD = `[data-tool-card]:has([data-call-id^="rich-edit-"])`
    await waitFor(
      'edit_file 那一步收场(结局带着类别)',
      () =>
        page.evaluate((sel) => {
          const card = [...document.querySelectorAll(sel)].find((el) => el.checkVisibility())
          return card?.querySelector('[data-call-id^="rich-edit-"]')?.getAttribute('data-tool-status') === 'completed' &&
            card?.querySelector('[data-call-id^="rich-exec-"]')?.getAttribute('data-tool-status') === 'completed'
            ? true
            : undefined
        }, RICH_CARD),
      30_000,
    ).catch(async (error) => {
      const text = await page.evaluate(() => document.querySelector('[data-testid="chat-stream"]')?.textContent ?? '')
      throw new Error(`${error.message}\n会话此刻:${text.slice(0, 500)}`)
    })
    // 多步卡收起时只露活槽位那一行:先展开整张卡,再拉开 edit_file 那一行的抽屉。
    await page.evaluate((sel) => {
      const card = [...document.querySelectorAll(sel)].find((el) => el.checkVisibility())
      const head = card?.querySelector('[data-tool-head]')
      if (head && head.getAttribute('aria-expanded') !== 'true') head.click()
    }, RICH_CARD)
    await delay(250)
    await page.evaluate((sel) => {
      const card = [...document.querySelectorAll(sel)].find((el) => el.checkVisibility())
      const row = card?.querySelector('[data-call-id^="rich-edit-"]')
      if (!(row instanceof HTMLElement)) throw new Error('找不到 edit_file 那一行')
      if (row.getAttribute('aria-expanded') !== 'true') row.click()
    }, RICH_CARD)
    const rich = await waitFor(
      '抽屉里的 diff 块画出来',
      () =>
        page.evaluate((sel) => {
          const card = [...document.querySelectorAll(sel)].find((el) => el.checkVisibility())
          if (!card) return undefined
          const row = card.querySelector('[data-call-id^="rich-edit-"]')
          const diff = card.querySelector('[data-block-kind="diff"]')
          if (!row || !diff) return undefined
          const editFoot = card.querySelector(`[data-tool-foot="${row.getAttribute('data-call-id')}"]`)
          const execRow = card.querySelector('[data-call-id^="rich-exec-"]')
          const execFoot = execRow ? card.querySelector(`[data-tool-foot="${execRow.getAttribute('data-call-id')}"]`) : null
          const terminal = execFoot?.querySelector('[data-tool-terminal]')
          return {
            name: row.querySelector('[class*="toolName"]')?.textContent ?? '',
            summary: row.querySelector('[class*="toolSummary"]')?.textContent ?? '',
            diffText: diff.textContent ?? '',
            locations: [...(editFoot?.querySelectorAll('[data-tool-location]') ?? [])].map((el) => el.getAttribute('data-tool-location')),
            terminal: terminal
              ? { id: terminal.getAttribute('data-tool-terminal'), text: terminal.textContent, disabled: terminal.getAttribute('aria-disabled') === 'true' }
              : null,
          }
        }, RICH_CARD),
      10_000,
    ).catch(async (error) => {
      const text = await page.evaluate(
        (sel) => [...document.querySelectorAll(sel)].find((el) => el.checkVisibility())?.textContent ?? '(卡不在)',
        RICH_CARD,
      )
      return { name: '', summary: '', diffText: '', locations: [], terminal: null, error: `${error.message} · 卡此刻:${text.slice(0, 300)}` }
    })
    step(
      rich.name === 'edit_file' && rich.summary === 'rich.txt',
      `⑦ 工具名 = agent 起的那个:「${rich.name}」,文件名进摘要「${rich.summary}」${rich.error ? `(${rich.error})` : ''}`,
    )
    step(
      rich.diffText.includes('beta') && rich.diffText.includes('BETA'),
      `⑦ 抽屉里一块 diff,两侧 beta / BETA(diff 字面前 80 字:${rich.diffText.slice(0, 80).replace(/\s+/g, ' ')})`,
    )
    step(
      rich.locations.some((loc) => /rich\.txt:3$/.test(loc ?? '')),
      `⑦ 卡脚列出位置:${rich.locations.join(' · ') || '(没有)'}`,
    )
    step(
      Boolean(rich.terminal) && /打开终端|Open terminal/.test(rich.terminal?.text ?? ''),
      `⑦ execute 那一步卡脚有「打开终端」:${rich.terminal ? `${rich.terminal.id}(${rich.terminal.disabled ? '已关,灰' : '可点'})` : '(没有)'}`,
    )

    // ── ⑧ 从 Agent 导入(A5-b)───────────────────────────────────────────
    /*
     * 先探一发:A5-a 的四条 RPC 在不在这份构建里。不在 = 整步 SKIP(说清等谁),⑨ 同理。
     * 在就顺手拿到「core 眼里的名单」,屏上对它。
     */
    let lifeReady = true
    let probe
    try {
      probe = await rpc(record, 'acp', 'listRemoteSessions', { agentId: LIFE_AGENT, cwd: workDir })
    } catch (error) {
      lifeReady = false
      console.log(`SKIP ⑧⑨ 等 A5-a:acp.listRemoteSessions 在这份构建里答不上来(${String(error?.message ?? error).slice(0, 160)})`)
    }
    if (lifeReady) {
      const coreIds = (probe?.ok ? probe.sessions : []).map((row) => row.acpSessionId).sort()
      /*
       * 系统对话框 CDP 够不着 —— 换掉主进程那一口:`electron/host-ports.ts` 的 dialog 端口在调用时才去
       * `dialog.showOpenDialog`,所以在这里把它换成「直接答临时工作目录」就是那一次挑选。只在这扇窗里、
       * 这一次 electron 进程里生效,门收尸时整个进程一起走。
       */
      await app.evaluate(({ dialog }, dir) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] })
      }, workDir)
      const sessionsBefore = ((await rpc(record, 'sessions', 'listMeta', {}))?.sessions ?? []).length
      const importRowShown = () =>
        page.evaluate(() => {
          const el = document.querySelector('[data-testid="expose-acp-import"]')
          return el instanceof HTMLElement && el.checkVisibility() ? el.textContent : undefined
        })
      for (let attempt = 0; attempt < 3 && !(await importRowShown()); attempt += 1) {
        await click(page, '[data-testid="dock-tile-sessions"]')
        await delay(500)
      }
      const importLabel = await waitFor('会话侧栏里「从 Agent 导入…」那一行', importRowShown)
      const openPicker = async () => {
        await click(page, '[data-testid="expose-acp-import"]')
        await waitFor('挑 agent 那一步', () =>
          page.evaluate((id) => Boolean(document.querySelector(`[data-testid="acp-import-agent-${id}"]`)), LIFE_AGENT),
        )
        await pressReal(page, `挑选窗里 ${LIFE_AGENT} 那一行`, inDocument, `[data-testid="acp-import-agent-${LIFE_AGENT}"]`)
      }
      await openPicker()
      const listed = await waitFor(
        '名单两行上屏',
        () =>
          page.evaluate(() => {
            const rows = [...document.querySelectorAll('[data-testid^="acp-import-session-"]')]
            if (rows.length === 0) {
              const refused = document.querySelector('[data-testid="acp-import-refused"], [data-testid="acp-import-empty"], [data-testid="acp-import-error"]')
              return refused ? { refused: refused.textContent } : undefined
            }
            return {
              ids: rows.map((el) => el.getAttribute('data-testid').slice('acp-import-session-'.length)).sort(),
              texts: rows.map((el) => el.textContent),
              cwd: document.querySelector('[data-testid="acp-import-cwd"]')?.textContent ?? '',
            }
          }),
        20_000,
      )
      step(
        !listed.refused && listed.ids.join(',') === 'stored-a,stored-b' && coreIds.join(',') === 'stored-a,stored-b',
        `⑧ 入口「${importLabel}」→ 挑 ${LIFE_AGENT} → 目录 ${listed.cwd || '(无)'} → 名单 ${listed.refused ? `(拒:${listed.refused})` : listed.ids.join(' / ')}(core:${coreIds.join(' / ') || '无'});行字 ${(listed.texts ?? []).join(' | ')}`,
      )
      const axe = await new AxeBuilder({ page })
        .setLegacyMode(true)
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        .include('[role="dialog"]')
        .analyze()
      for (const v of axe.violations) {
        console.log(`      [${v.impact}] ${v.id} —— ${v.help}`)
        for (const node of v.nodes.slice(0, 4)) console.log(`        ${node.target.join(' ')}`)
      }
      step(axe.violations.length === 0, `⑧ 导入窗 axe 零违例(过了 ${axe.passes.length} 条规则)`)

      await pressReal(page, '挑选窗里 stored-a 那一行', inDocument, '[data-testid="acp-import-session-stored-a"]')
      await waitFor('窗关掉', () => page.evaluate(() => !document.querySelector('[data-testid="acp-import-sessions"]')), 20_000)
      const afterAdopt = (await rpc(record, 'sessions', 'listMeta', {}))?.sessions ?? []
      const adopted = await waitFor(
        '会话正文里有回放的那句话',
        () =>
          page.evaluate(() => {
            const stream = [...document.querySelectorAll('[data-testid="chat-stream"]')].find((el) => el.checkVisibility())
            const text = stream?.textContent ?? ''
            return text.includes('imported reply alpha') ? { text: text.slice(0, 120) } : undefined
          }),
        20_000,
      ).catch(async () => ({
        text: `(没等到)${await page.evaluate(() => [...document.querySelectorAll('[data-testid="chat-stream"]')].find((el) => el.checkVisibility())?.textContent?.slice(0, 200) ?? '(没有可见会话)')}`,
      }))
      const toast = await waitFor('「已导入 N 条」', () =>
        page.evaluate(() => {
          const hit = [...document.querySelectorAll('[role="status"], [role="alert"], [data-testid^="toast"]')]
            .map((el) => el.textContent ?? '')
            .find((text) => /已导入|Imported/.test(text))
          return hit
        }),
        8_000,
      ).catch(() => '(没见到)')
      step(
        afterAdopt.length === sessionsBefore + 1 && !adopted.text.startsWith('(没等到)') && toast !== '(没见到)',
        `⑧ 点 stored-a → 本地会话 ${sessionsBefore}→${afterAdopt.length} 条,正文见回放「imported reply alpha」,提示「${toast}」`,
      )
      // 再开一次:那一行写「已导入」,点它进同一条(不多建)。
      await openPicker()
      const again = await waitFor('第二次打开名单上屏,stored-a 标着已导入', () =>
        page.evaluate(() => {
          const el = document.querySelector('[data-testid="acp-import-session-stored-a"]')
          return el?.getAttribute('data-adopted') === 'true' ? el.textContent : undefined
        }),
      ).catch(() => '(没标)')
      await pressReal(page, '挑选窗里 stored-a 那一行', inDocument, '[data-testid="acp-import-session-stored-a"]')
      await waitFor('窗关掉', () => page.evaluate(() => !document.querySelector('[data-testid="acp-import-sessions"]')), 20_000)
      await delay(500)
      const afterSecond = ((await rpc(record, 'sessions', 'listMeta', {}))?.sessions ?? []).length
      step(
        again !== '(没标)' && afterSecond === afterAdopt.length,
        `⑧ 再开一次:stored-a 那一行「${again}」,点它不多建(${afterAdopt.length}→${afterSecond})`,
      )

      // ── ⑨ 崩溃退避:连 kill 四次,闩上;设置页「重新连接」撤闩 ────────────
      const lifeSessionId = (await rpc(record, 'acp', 'listRemoteSessions', { agentId: LIFE_AGENT, cwd: workDir }))
        ?.sessions?.find((row) => row.acpSessionId === 'stored-a')?.adoptedSessionId
      const lifeRow = async () =>
        ((await rpc(record, 'acp', 'getAgents', {}))?.agents ?? []).find((row) => row.config.id === LIFE_AGENT)
      const trail = []
      let latchedRow
      for (let round = 1; round <= 5 && lifeSessionId && !latchedRow; round += 1) {
        const before = await waitFor(`第 ${round} 轮:${LIFE_AGENT} 有活进程`, async () => {
          const row = await lifeRow()
          if (row?.backoff?.latched) return row
          return row?.status === 'connected' && row.pid ? row : undefined
        }, 20_000).catch(() => undefined)
        if (before?.backoff?.latched) {
          latchedRow = before
          break
        }
        if (!before?.pid) {
          // 这一轮还没进程:发一条消息把它拉起来(第一轮的 load 之后它本来就活着)。
          await rpc(record, 'session-command', 'emit', {
            sessionId: lifeSessionId,
            command: { type: 'command:send-message', content: `ping ${round}`, suppressTitleGeneration: true },
          })
          continue
        }
        try {
          process.kill(before.pid, 'SIGKILL')
        } catch {
          // 已经没了就算了。
        }
        trail.push(`kill#${round}(pid ${before.pid})`)
        await waitFor('那一行不再是 connected', async () => ((await lifeRow())?.status !== 'connected' ? true : undefined), 10_000).catch(() => undefined)
        await rpc(record, 'session-command', 'emit', {
          sessionId: lifeSessionId,
          command: { type: 'command:send-message', content: `ping after kill ${round}`, suppressTitleGeneration: true },
        })
        const settled = await waitFor(`第 ${round} 次 kill 之后:重连或闩上`, async () => {
          const row = await lifeRow()
          if (row?.backoff?.latched) return row
          return row?.status === 'connected' && row.pid && row.pid !== before.pid ? row : undefined
        }, 20_000).catch(() => undefined)
        trail.push(settled?.backoff?.latched ? '闩上' : settled ? `重连(pid ${settled.pid})` : '(没等到)')
        if (settled?.backoff?.latched) latchedRow = settled
      }
      step(Boolean(latchedRow), `⑨ 连 kill 之后闩上:${trail.join(' → ') || '(没开始)'};backoff=${JSON.stringify(latchedRow?.backoff ?? null)}`)

      await click(page, '[data-testid="dock-tile-settings"]')
      await waitFor('设置页就位', () =>
        page.evaluate(() => Boolean(document.querySelector('[data-testid="settings-nav-agents"]'))),
      )
      await click(page, '[data-testid="settings-nav-agents"]')
      await waitFor('名册里有这一台', () =>
        page.evaluate((id) => Boolean(document.querySelector(`[data-testid="agent-row-${id}"]`)), LIFE_AGENT),
      )
      await click(page, `[data-testid="agent-row-${LIFE_AGENT}"]`)
      const gaveUp = await waitFor('进程行写「已停止重试」且有「重新连接」', () =>
        page.evaluate((id) => {
          const cell = document.querySelector(`[data-testid="agent-detail-${id}"] [data-testid="agent-process"]`)
          const button = cell?.querySelector('[data-testid="agent-reconnect"]')
          return cell?.getAttribute('data-backoff-latched') === 'true' && button ? { text: cell.textContent } : undefined
        }, LIFE_AGENT),
        15_000,
      ).catch(() => undefined)
      step(Boolean(gaveUp), `⑨ Agent 页:进程行「${gaveUp?.text ?? '(没闩上 / 没画钮)'}」`)
      if (gaveUp) {
        await click(page, `[data-testid="agent-detail-${LIFE_AGENT}"] [data-testid="agent-reconnect"]`)
        const cleared = await waitFor('闩撤掉', () =>
          page.evaluate((id) => {
            const cell = document.querySelector(`[data-testid="agent-detail-${id}"] [data-testid="agent-process"]`)
            return cell?.getAttribute('data-backoff-latched') === 'false' ? cell.textContent : undefined
          }, LIFE_AGENT),
          20_000,
        ).catch(() => undefined)
        const row = await lifeRow()
        step(
          Boolean(cleared) && !row?.backoff?.latched,
          `⑨ 点「重新连接」→ 进程行「${cleared ?? '(没撤)'}」,core 那一行 backoff=${JSON.stringify(row?.backoff ?? null)} status=${row?.status}`,
        )
      }
    }
  } finally {
    if (record) await rpc(record, 'acp', 'removeAgent', { agentId: TEMP_AGENT }).catch(() => {})
    if (app) await app.close().catch(() => {})
    if (vite) await vite.close().catch(() => {})
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
    await rm(workDir, { recursive: true, force: true })
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
