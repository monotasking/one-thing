#!/usr/bin/env node
/**
 * **发一条 `@文件` 出去,屏幕上只许有一条用户气泡** —— 真机门(2026-09-13)。
 *
 * ══ 病 ══════════════════════════════════════════════════════════════════
 * 用户两次拿真机截图报同一件事:composer 里 `@` 选中一个文件发出去,聊天流里
 * 出现**两条**自己的话,第二条还排在 AI 的回复**后面**,而且永不消失。
 *
 * 真因不在壳里画重了,而在**引擎落库之前就把正文换掉了**:
 * `packages/core/engine/file-mentions.ts` 把 `@/abs/x.lua` 展成一整份
 * `<file …>` 块(真账本里 34KB),账本上的 `content` 于是是**模型版**,
 * 而壳那一格乐观气泡从前靠「正文逐字相同」认领自己那条消息 —— 比的两句话
 * 从来就不是同一句,所以那一格永远留屏。第二条气泡不是多发了一条,
 * 是一格没人认领的 overlay。
 *
 * 治法是**认领靠身份**:壳发送前铸好这条消息的 id 随命令带过去
 * (`SendMessageCommand.messageId`),引擎照用。
 *
 * ══ 这道门量什么 ═════════════════════════════════════════════════════════
 *  ① 发之前 0 条用户气泡(现场干净,后面的 +1 才说得出口);
 *  ② `@` 选中夹具文件 → 发出去 → 屏幕上恰好 **1 条**用户气泡、**0 格** pending;
 *  ③ **AI 回完之后仍然恰好 1 条** —— 用户看见的正是这一刻的第二条;
 *  ④ 那条气泡里是一枚 chip 不是 34KB 正文(气泡文本 < 200 字);
 *  ⑤ **账本上那条的 `content` 真的被换成了 `<file>` 块** —— 这一条是给 ①②③ 验明
 *     正身的:引擎万一哪天不再改写正文,①②③ 会因为「两句话恰好相同」而全绿,
 *     那是空过。有了 ⑤,这道门绿的时候说的才是「正文被换掉了,而屏幕仍然只有
 *     一条气泡」。
 *
 * ── 纪律(照 gate-composer-drawer / gate-chat-follow)────────────────────────
 * 窗子离屏起(`ONETHING_GATE_HEADLESS=1`),不 show()、不进 Dock、不抢前台;
 * 所有输入经 CDP,不动真光标。store / `--user-data-dir` / 工作目录都是临时目录,
 * 跑完删干净,**绝不连 `~/.onething`**、不连 5175。这道门量的是**条数**不是
 * **时刻**,所以留在 headless 那一档(1Hz 节流对「屏上有几条气泡」没有影响)。
 *
 * 跑法:`npm run gate:composer-send`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * `--app-root=<path>` 指向另一份检出的构建产物 —— 「改前 / 改后」对照就是这么跑的
 * (对照用 `git worktree`,**不用 `git stash`**:旁边还有别的批在改同一棵树)。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import { startChunkedFakeProvider } from './lib/gate-stream-provider.mjs'
import { fakeProviderAiSettings, FAKE_PROVIDER_ENV } from '../../../scripts/lib/gate-fake-provider.mjs'

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(here, '../..')
const serverEntry = path.join(repoRoot, 'dist/server/main.js')

const appRootArg = process.argv.find((arg) => arg.startsWith('--app-root='))
const appRoot = appRootArg ? path.resolve(appRootArg.slice('--app-root='.length)) : here
const mainEntry = path.join(appRoot, 'dist-electron/main.cjs')

const SESSION_NAME = '发送门 · @文件'
/**
 * 夹具文件。名字够特别,不会与这台机器上任何真文件撞;行数照真账本那一条
 * (1995 行 / 展开后 34KB),够长到 `expandFileMentions` 真的走截断那一支。
 */
const FIXTURE_NAME = 'zzsendgate-chatbot.lua'
const FIXTURE_LINES = 1995
/** 气泡里是一枚 chip 的话,文本长度就是个位数到几十;34KB 正文差三个数量级。 */
const CHIP_TEXT_MAX = 200

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

const failures = []
function assert(condition, message) {
  if (condition) console.log(`  ✓ ${message}`)
  else {
    console.log(`  ✗ ${message}`)
    failures.push(message)
  }
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

/** 点一个 testid(不用 page.click:不动真光标、不抢焦点)。 */
async function clickTestId(page, testId) {
  const clicked = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    el.click()
    return true
  }, testId)
  if (!clicked) throw new Error(`点不到:[data-testid="${testId}"] 不在 DOM 里`)
}

async function pressEnter(cdp) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', {
      type,
      windowsVirtualKeyCode: 13,
      key: 'Enter',
      code: 'Enter',
    })
  }
}

/** 把光标放进输入框(真的 focus,但只在这个离屏窗口里)—— 与 drawer 门同一只。 */
async function focusInput(page) {
  await page.evaluate(() => {
    const box = document.querySelector('[data-testid="composer-input"]')
    if (box instanceof HTMLElement) {
      box.focus()
      const range = document.createRange()
      range.selectNodeContents(box)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    }
  })
}

/**
 * 屏幕上此刻的现场:用户气泡几条、pending 几格、最后一条用户气泡里是什么。
 *
 * **pending 与真气泡是两种元素**(overlay 那一格是 `div[data-testid^=chat-pending-]`,
 * 账本那条是 `article[data-role=user]`),所以只数 `article` 会把病漏掉 ——
 * 用户看见的第二条正是那一格 overlay。两个数一起报。
 */
function readStage(page) {
  return page.evaluate(() => {
    const users = [...document.querySelectorAll('article[data-role="user"]')]
    const pending = [...document.querySelectorAll('[data-testid^="chat-pending-"]')]
    const last = users[users.length - 1]
    return {
      users: users.length,
      pending: pending.length,
      pendingText: pending.map((el) => (el.textContent ?? '').slice(0, 80)),
      lastText: (last?.textContent ?? '').trim(),
      assistants: document.querySelectorAll('article[data-role="assistant"]').length,
    }
  })
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[send-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error(`[send-gate] ${appRoot} 下找不到构建产物 —— 先跑 \`npm run app:build\``)
    process.exit(1)
  }
  console.log(`[send-gate] 被测产物:${appRoot}`)

  const store = await mkdtemp(path.join(tmpdir(), 'send-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'send-udd-'))
  const workdir = await mkdtemp(path.join(tmpdir(), 'send-cwd-'))
  let mockProvider
  let server
  let app

  const startCore = async () => {
    const child = spawn(process.execPath, [serverEntry], {
      env: { ...process.env, ...FAKE_PROVIDER_ENV, ONETHING_STORE_PATH: store },
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const err = []
    child.stderr.on('data', (chunk) => err.push(chunk.toString()))
    const record = await waitFor('core 写出发现文件', () => {
      const got = readDiscovery(store)
      return got && got.pid === child.pid ? got : undefined
    }).catch((error) => {
      throw new Error(`${error.message}\nserver stderr:\n${err.join('').slice(-2000)}`)
    })
    if (!(await portConnects(record.host, record.port))) throw new Error('core 端口连不上')
    return { child, record }
  }
  const stopCore = async (child) => {
    if (!child) return
    child.kill('SIGTERM')
    await delay(800)
    if (!child.killed) child.kill('SIGKILL')
  }

  try {
    console.log('\n[1/5] 种一个够大的夹具文件 + 假 provider + 一台 core')
    mkdirSync(workdir, { recursive: true })
    const fixturePath = path.join(workdir, FIXTURE_NAME)
    writeFileSync(
      fixturePath,
      Array.from({ length: FIXTURE_LINES }, (_, i) => `-- line ${i + 1}: 这一行是夹具,够长好把整份撑过截断线`).join('\n'),
    )
    console.log(
      `      ${FIXTURE_NAME}:${FIXTURE_LINES} 行 / ${(readFileSync(fixturePath).length / 1024).toFixed(0)}KB`,
    )

    mockProvider = await startChunkedFakeProvider(0, '收到,这是假 provider 的一句回答。', {
      pieces: 3,
      gapMs: 30,
    })
    writeFileSync(
      path.join(store, 'settings.json'),
      JSON.stringify(
        {
          ai: fakeProviderAiSettings(mockProvider.address().port),
          tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
          diagnostics: { enabled: false },
        },
        null,
        2,
      ),
    )

    const core = await startCore()
    server = core.child
    const made = await rpc(core.record, 'sessions', 'create', { name: SESSION_NAME })
    const sessionId = made?.session?.id
    if (!sessionId) throw new Error('sessions.create 没给出会话 id')
    // 工作目录 = 夹具所在地(`@` 候选按它筛,判据见 file-mentions-source)。
    await rpc(core.record, 'sessions', 'updateWorkingDirectory', {
      sessionId,
      workingDirectory: workdir,
    })

    console.log('[2/5] 拉起应用(离屏 · 独立 --user-data-dir),进那条会话')
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
    await waitFor('Dock 上的「会话总览」瓦就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
    )
    const rowShown = () =>
      page.evaluate(
        (id) => Boolean(document.querySelector(`[data-testid="session-row-${id}"]`)),
        sessionId,
      )
    for (let attempt = 0; attempt < 3 && !(await rowShown()); attempt += 1) {
      await clickTestId(page, 'dock-tile-sessions')
      await delay(500)
    }
    await waitFor('总览画出那一行', rowShown)
    await clickTestId(page, `session-row-${sessionId}`)
    await waitFor('输入框就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="composer-input"]'))),
    )
    await delay(600)

    console.log('\n[3/5] ① 发之前的现场')
    const before = await readStage(page)
    console.log(`      ${JSON.stringify(before)}`)
    assert(before.users === 0 && before.pending === 0, '① 发之前:0 条用户气泡、0 格 pending')

    console.log('\n[4/5] `@` 选中夹具文件并发出去')
    await focusInput(page)
    await cdp.send('Input.insertText', { text: '@zzsendgate' })
    await waitFor('抽屉里出现候选行', () =>
      page.evaluate(
        () => document.querySelectorAll('[data-testid="composer-drawer"] button').length > 0,
      ),
    )
    // ↵ 选中键盘位那一行 → 草稿里落一枚文件 chip(token 形)。
    await pressEnter(cdp)
    await waitFor('草稿里落进一枚 chip', () =>
      page.evaluate(() =>
        Boolean(
          document
            .querySelector('[data-testid="composer-input"]')
            ?.querySelector('span[contenteditable="false"]'),
        ),
      ),
    )
    // ↵ 发送(抽屉已经关了,这一下归发送)。
    await pressEnter(cdp)

    const afterSend = await waitFor('那条用户消息上屏', async () => {
      const stage = await readStage(page)
      return stage.users + stage.pending > 0 ? stage : undefined
    })
    console.log(`      刚发出去:${JSON.stringify(afterSend)}`)

    console.log('\n[5/5] ②③④⑤ 等 AI 回完再数')
    await waitFor('助手那条回完', async () => {
      const stage = await readStage(page)
      return stage.assistants > 0 ? stage : undefined
    }, 40_000)
    // 收尾那一拍(`run/end` → 账本换装 → overlay 认领)再给一点余量。
    await delay(2500)

    const after = await readStage(page)
    console.log(`      AI 回完之后:${JSON.stringify(after)}`)

    assert(
      after.users === before.users + 1,
      `② 账本上的用户气泡恰好 +1(${before.users} → ${after.users})`,
    )
    /*
     * ②b 是用户那句话的直译:「屏幕上出现了两条用户气泡」。数的是**人看得见的
     * 那几条**(账本气泡 + overlay 那一格),所以它一条就能说完整件事;②③ 分开
     * 留着是因为它们指认的是两个不同的东西 —— 少一条真消息与多一格没人认领的
     * overlay 是两种病,报告里不该混成一个数。
     */
    assert(
      after.users + after.pending === 1,
      `②b 屏幕上「我说的话」恰好一条(账本 ${after.users} + overlay ${after.pending})`,
    )
    assert(
      after.pending === 0,
      `③ AI 回完之后 0 格 pending(实测 ${after.pending};病着的时候这里是 1,`
      + `它就是用户截图里排在回复后面的第二条:${JSON.stringify(after.pendingText)})`,
    )
    assert(
      after.lastText.length > 0 && after.lastText.length < CHIP_TEXT_MAX,
      `④ 气泡里是一枚 chip 不是整份正文(文本 ${after.lastText.length} 字 < ${CHIP_TEXT_MAX})`,
    )
    assert(
      after.lastText.includes('zzsendgate'),
      `④b 那枚 chip 说的确实是这个文件(气泡文本:${JSON.stringify(after.lastText.slice(0, 60))})`,
    )

    /*
     * ⑤ 验明正身:去账本上读那条用户消息。引擎**真的**把 `content` 换成了
     * `<file>` 块,而 `contentParts` 里才是壳发出去的那一句 —— 没有这一条,
     * ①②③④ 会在「引擎哪天不再改写正文」的那一天因为两句话恰好相同而全绿。
     */
    const raw = await rpc(core.record, 'sessionEvents', 'listRaw', { sessionId })
    const userRow = (raw?.events ?? []).find((row) => row.type === 'user/message')
    const ledgerContent = userRow?.data?.message?.content ?? ''
    const ledgerParts = userRow?.data?.message?.contentParts ?? []
    const partsText = ledgerParts
      .filter((part) => part?.type === 'text')
      .map((part) => part?.content ?? '')
      .join('')
    console.log(
      `      账本那条:content ${ledgerContent.length} 字 / contentParts ${ledgerParts.length} 格`
      + ` / 显示文本 ${JSON.stringify(partsText.slice(0, 60))}`,
    )
    assert(
      ledgerContent.startsWith('<file ') && ledgerContent.length > 10_000,
      `⑤ 账本上的 content 真是模型版 <file> 块(${ledgerContent.length} 字)—— `
      + '这一条证明前面四条不是因为「两句话恰好相同」而绿的',
    )
    assert(
      partsText.length > 0 && partsText.length < CHIP_TEXT_MAX && partsText !== ledgerContent,
      `⑤b 显示版与模型版是两句话(${partsText.length} 字 vs ${ledgerContent.length} 字)`,
    )
  } finally {
    if (app) await app.close().catch(() => undefined)
    await stopCore(server)
    if (mockProvider) mockProvider.close()
    await rm(store, { recursive: true, force: true }).catch(() => undefined)
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined)
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined)
  }

  if (failures.length) {
    console.error(`\n[send-gate] FAILED —— ${failures.length} 条:\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log('\n[send-gate] ok —— @文件 发出去之后屏幕上只有一条用户气泡,AI 回完仍然只有一条')
}

main().catch((error) => {
  console.error(`\n[send-gate] 崩了:${error?.stack ?? error}`)
  process.exit(1)
})
