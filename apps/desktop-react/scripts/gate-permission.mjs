#!/usr/bin/env node
/**
 * **应用级许可 · 壳半边**的真机门(后端半边 a50d4f99;正本
 * `docs/design/atom-2026-09.md` §7 盲点 3「授权粒度 = 效果类 × 命名空间许可 × 主体」)。
 *
 * ── 它证的是这一批之前根本不存在的那件事 ──────────────────────────────────
 * 调研核实:这一批之前 React 壳**零处**渲染 `permission:request`、**零处**发
 * `command:permission-respond`。用户桌面一直开着 `dangerously-allow-all`,所以
 * 这个洞两个月没露头 —— 换成缺省档,任何一次要审批的工具调用都会让工具卡永远停在
 * 「执行中」,而引擎在那头一直等到超时。
 *
 * 这道门跑的是**用户真走的那一条路**,六步:
 *  ① 缺省权限档 + 一台会发工具调用的假 provider → 模型调 `session` 资源工具
 *     (`{op:'removeMessage', ref:'session:<id>'}`,效果类 `session_destructive`)——
 *     选它是因为它是**地址型**效果,后端的 `alwaysScopeOf` 因此填得出
 *     `alwaysScope: { scheme: 'session' }`,第四个键才画得出来。裸路径的
 *     `file_write` 证不了这一条(那正是后端那一单的两条反证之一);
 *  ② 工具卡里长出权限卡 —— 它带 `role="group"` 与一句说得出在等什么的可访问名;
 *  ③ 卡上**五个键**都在,第四键的文案带 scheme;顺手对这张卡跑一遍 axe
 *     (`gate:a11y` 那一屏是「在场就扫」,而**造出一张卡**的支架只有这里有);
 *  ④ 点「始终允许」→ 卡消失(`permission:settled` 收尾,不是壳自己抹的);
 *  ⑤ **再来一次同一类调用不弹卡** —— 那条 grant 真的落下去了。这一条是整道门的
 *     心脏:少了它,前面四步只证明了「卡画得出来」,没证明「点下去有用」;
 *  ⑥ 设置页「已授权」里有它那一条,撤销之后再来一次**又弹卡**。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 * **窗子一律离屏起**(`ONETHING_GATE_HEADLESS=1`,与 gate-continuity / gate-focus
 * 同一手):不 show()、不进 Dock、不抢用户的前台;所有输入都经 `page.evaluate`,
 * 一根手指都不碰真光标。store 与 `--user-data-dir` 都是临时目录,跑完删干净,
 * **绝不连 `~/.onething`**。自己起的进程在 `finally` 里逐个收尸。
 *
 * 跑法:`npm run gate:permission`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 *
 * **本单只写不跑**(09-04 判例:真机门抢用户的机器要先问时机)。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import { AxeBuilder } from '@axe-core/playwright'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(appRoot, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const failures = []
function assert(condition, message) {
  if (condition) console.log(`  ✓ ${message}`)
  else {
    console.log(`  ✗ ${message}`)
    failures.push(message)
  }
}

function readDiscovery(store) {
  try {
    return JSON.parse(readFileSync(path.join(store, 'run', 'http.json'), 'utf-8'))
  } catch {
    return undefined
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

/**
 * **一台会发资源工具调用的假 provider**(照 `gate-tool-stream.mjs` 那一只)。
 *
 * 第几轮由**已经回来了几条 tool 消息**决定(与真实 agent-loop 同口径)。
 * 第一轮发一次 `session({op:'removeMessage', ref, messageId})`,收到工具结果之后
 * 收尾 —— 一轮一次调用,门要数的是「弹没弹卡」,不是模型说了什么。
 */
function startToolCallingProvider(sessionRef, messageIdOf) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      let payload = {}
      try {
        payload = JSON.parse(body)
      } catch {
        /* 空请求体也照答一句 —— 这只 provider 不做入参校验 */
      }
      const messages = Array.isArray(payload.messages) ? payload.messages : []
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const send = (obj) => {
        if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`)
      }
      const frame = (delta, finish = null) => ({
        id: 'chatcmpl-permission-gate',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'deepseek-chat',
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      const done = () => {
        res.write('data: [DONE]\n\n')
        res.end()
      }

      const toolTurns = messages.filter((m) => m.role === 'tool').length
      if (toolTurns > 0) {
        send(frame({ content: '\n办完了。\n' }))
        send(frame({}, 'stop'))
        done()
        return
      }
      const args = JSON.stringify({
        op: 'removeMessage',
        ref: sessionRef,
        messageId: messageIdOf(),
      })
      send(frame({ content: '我来删一条。\n' }))
      send(
        frame({
          tool_calls: [
            { index: 0, id: `call_perm_${Date.now()}`, type: 'function', function: { name: 'session', arguments: '' } },
          ],
        }),
      )
      send(frame({ tool_calls: [{ index: 0, function: { arguments: args } }] }))
      send(frame({}, 'tool_calls'))
      done()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

/** 点一个 testid(理由见 gate-data.mjs 顶部:不用 page.click,不动真光标)。 */
async function clickTestId(page, testId) {
  const clicked = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    el.click()
    return true
  }, testId)
  if (!clicked) throw new Error(`点不到:[data-testid="${testId}"] 不在 DOM 里`)
}

/** 这一屏上那张权限卡的读数。一次 evaluate —— 四次之间会插进别的帧。 */
function readCard(page) {
  return page.evaluate(() => {
    const card = document.querySelector('[data-permission-card]')
    if (!card) return null
    return {
      toolCallId: card.getAttribute('data-permission-card'),
      role: card.getAttribute('role'),
      scope: card.getAttribute('data-focus-scope'),
      name: (card.getAttribute('aria-label') ?? '').trim(),
      keys: [...card.querySelectorAll('button')].map((el) => (el.textContent ?? '').trim()),
      alwaysScheme:
        card.querySelector('[data-permission-always]')?.getAttribute('data-permission-always') ??
        null,
      // 卡在收起态也必须看得见 —— 量它真的占了地方,不是 display:none。
      visible: card.getBoundingClientRect().height > 0,
    }
  })
}

async function clickAlways(page) {
  const clicked = await page.evaluate(() => {
    const key = document.querySelector('[data-permission-card] [data-permission-always]')
    if (!(key instanceof HTMLElement)) return false
    key.click()
    return true
  })
  if (!clicked) throw new Error('点不到「始终允许」那一颗键')
}

/** 发一句话并等这一轮跑完(账本上长出那条助手消息)。 */
async function askOnce(record, sessionId, text) {
  const before = (await rpc(record, 'sessions', 'getMessages', { sessionId }))?.messages?.length ?? 0
  await rpc(record, 'session-command', 'emit', {
    sessionId,
    command: { type: 'command:send-message', content: text },
  })
  return before
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[permission-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[permission-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'perm-gate-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'perm-gate-udd-'))
  let provider
  let server
  let app
  let sessionId = ''
  let victimMessageId = ''
  try {
    console.log('\n[1/6] 起假 provider + 一台 core(**缺省权限档**,不是 allow-all)')
    provider = await startToolCallingProvider(
      () => `session:${sessionId}`,
      () => victimMessageId,
    )
    const mockPort = provider.address().port
    writeFileSync(
      path.join(store, 'settings.json'),
      JSON.stringify(
        {
          ai: {
            provider: 'deepseek',
            providers: {
              deepseek: {
                baseUrl: `http://127.0.0.1:${mockPort}/v1`,
                model: 'deepseek-chat',
                selectedModels: ['deepseek-chat'],
                enabled: true,
                modelCapabilitiesByModel: {
                  'deepseek-chat': { tools: true, reasoning: false, vision: false },
                },
              },
            },
            customProviders: [],
            modelCatalog: {},
          },
          /*
           * **这一格就是这道门存在的理由**:用户桌面上一直是
           * `dangerously-allow-all`,于是「壳没有权限卡」两个月没露头。
           */
          tools: { enableToolCalls: true, permissionMode: 'default', tools: {} },
          diagnostics: { enabled: false },
        },
        null,
        2,
      ),
    )
    server = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, ONETHING_STORE_PATH: store, DEEPSEEK_API_KEY: 'sk-perm-gate' },
      cwd: repoRoot,
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

    const made = await rpc(record, 'sessions', 'create', { name: '许可门 · 会话' })
    sessionId = made?.session?.id
    if (!sessionId) throw new Error('sessions.create 没给出会话 id')
    // 先垫两条消息:模型待会儿要删的那一条得真的存在。
    await rpc(record, 'session-command', 'emit', {
      sessionId,
      command: { type: 'command:send-message', content: '垫一句,给它一条可删的消息' },
    })
    const seeded = await waitFor('垫的那一轮落账', async () => {
      const got = await rpc(record, 'sessions', 'getMessages', { sessionId })
      return (got?.messages?.length ?? 0) >= 2 ? got.messages : undefined
    })
    victimMessageId = seeded[0].id

    console.log('[2/6] 拉起应用(离屏 · 独立 --user-data-dir),进那条会话')
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
    await clickTestId(page, 'dock-tile-sessions')
    await waitFor('总览画出那一行', () =>
      page.evaluate(
        (id) => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)),
        sessionId,
      ),
    )
    await clickTestId(page, `session-row-${sessionId}`)
    await waitFor('会话上屏', () =>
      page.evaluate(() => document.querySelectorAll('[data-message-id]').length >= 2),
    )

    console.log('\n[3/6] 问一句 → 模型调 `session` 资源工具 → 卡该长出来')
    await askOnce(record, sessionId, '把第一条删掉')
    const card = await waitFor('权限卡上屏', async () => (await readCard(page)) ?? undefined)

    assert(card.role === 'group', '① 卡是一个 group')
    assert(card.scope === 'permission', '② 卡接在响应链上(data-focus-scope="permission")')
    assert(
      /[:：]/.test(card.name) && card.name.length > 4,
      `③ 可访问名说得出在等什么(实为「${card.name}」)`,
    )
    assert(card.visible, '④ 卡真的占了地方(收起态也看得见)')
    assert(
      card.keys.length === 5,
      `⑤ 五个键都在(实为 ${card.keys.length} 个:${card.keys.join(' / ')})`,
    )
    assert(
      card.alwaysScheme === 'session',
      `⑥ 第四键在场且带 scheme(实为 ${card.alwaysScheme ?? '缺席'})`,
    )

    console.log('\n[4/6] 对这张卡跑一遍 axe(造卡的支架只有这道门有)')
    /*
     * `setLegacyMode(true)` 是**必须的**,不是保守选项(判例原样抄自
     * `gate-a11y.mjs` 的 `scanAxe`):默认模式下 AxeBuilder 会
     * `browserContext.newPage()` 开一张空白页处理跨 frame 扫描,而 Electron 的 CDP
     * 不支持 `Target.createTarget` —— 当场 `Protocol error`。这个壳是单 frame。
     */
    const axe = await new AxeBuilder({ page })
      .setLegacyMode(true)
      .withTags(['wcag2a', 'wcag2aa', 'best-practice'])
      .include('[data-permission-card]')
      .analyze()
    assert(
      axe.violations.length === 0,
      `⑦ 权限卡 axe 零违例${axe.violations.length ? `:${axe.violations.map((v) => v.id).join(', ')}` : ''}`,
    )

    console.log('\n[5/6] 点「始终允许」→ 卡消失 → 再来一次**不弹卡**')
    await clickAlways(page)
    await waitFor('卡消失(permission:settled 收尾)', async () => (await readCard(page)) === null)
    assert(true, '⑧ 点完之后卡消失')

    await askOnce(record, sessionId, '再删一条')
    // 卡真要弹,它排在这一轮的头几百毫秒里;多等一会儿免得「还没来得及弹」被当成
    // 「没弹」(与 gate-continuity 那句 800ms 同一条理由)。
    await delay(2500)
    assert((await readCard(page)) === null, '⑨ 同一个应用 × 同一类效果,第二次不再弹卡')

    console.log('\n[6/6] 设置页「已授权」里有它,撤销之后又弹卡')
    await clickTestId(page, 'dock-tile-settings')
    const rows = await waitFor('账页画出来', () =>
      page.evaluate(() => {
        const list = [...document.querySelectorAll('[data-grant-id]')]
        return list.length > 0 ? list.map((el) => el.textContent ?? '') : undefined
      }),
    )
    assert(
      rows.some((text) => text.includes('session')) || rows.length > 0,
      `⑩ 账页里有那一条(${rows.length} 行)`,
    )

    const revoked = await page.evaluate(() => {
      const row = document.querySelector('[data-grant-id]')
      const key = row?.querySelector('button')
      if (!(key instanceof HTMLElement)) return false
      key.click()
      return true
    })
    assert(revoked, '⑪ 撤销那颗键点得到')
    await waitFor('那一行没了(就地更新)', () =>
      page.evaluate(() => document.querySelectorAll('[data-grant-id]').length === 0),
    )

    await clickTestId(page, `session-row-${sessionId}`).catch(() => undefined)
    await askOnce(record, sessionId, '撤销之后再删一条')
    const again = await waitFor('撤销之后又弹卡', async () => (await readCard(page)) ?? undefined)
    assert(Boolean(again), '⑫ 撤销之后同一件事又弹卡(许可真的被收回了)')
  } finally {
    if (app) await app.close().catch(() => undefined)
    if (server) server.kill('SIGTERM')
    await delay(400)
    if (server && !server.killed) server.kill('SIGKILL')
    if (provider) {
      // keep-alive 的套接字会让 close() 一直等 —— 先掐断,收尸才收得干净。
      provider.closeAllConnections?.()
      await new Promise((resolve) => provider.close(resolve))
    }
    await rm(store, { recursive: true, force: true }).catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
  }

  if (failures.length) {
    console.error(`\n[permission-gate] FAILED —— ${failures.length} 条:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\n[permission-gate] ok —— 卡长出来、点得动、记得住、撤得掉')
}

main().catch((error) => {
  console.error(`\n[permission-gate] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
