#!/usr/bin/env node
/**
 * C2 收尾批的真机门 ①:Vue 宿主(`apps/electron`)聊天链路。
 *
 * C2(`docs/design/client-sdk-2026-09.md` §5.2)把 renderer 的 40 多个域客户端
 * 换成了 `@onething/client` 的 `clientApi(router)`(过线走 `platform/client.ts` 的
 * `currentClient().api(router)`,底下是新写的 `platform/electron-transport.ts`)。
 * 这道门要证的是「换了传输实现之后,真的 Electron 主进程 + 真的 core,聊天这条
 * 链路(发送 → 账本 → 流式回复上屏)没有被破坏」。
 *
 * **留账,别误读**:`platform/electron-transport.ts` 的 `events()`(把
 * `onSessionEvent` / `onSessionStream` / `onSettingsChanged` 三条 IPC 推送合成
 * 一条 `AsyncIterable`)在 Vue 生产路径上**没有调用点** ——
 * `services/ipc-hub.ts` 仍然直接骑 `platformApi.onSessionEvent` /
 * `onSessionStream`(未搬,不在 C2 范围内),`platform/electron.ts` 把它们原样
 * 转发到 `electronAPI`,不经过 `client.events`。所以这道门证的是「发送这条 RPC
 * 路径(`sessionCommands.emit` → `clientApi` → `electron-transport.invoke` →
 * `electronAPI.rpcInvoke`)没坏,且账本→推送→上屏这条老路一如既往」,不是
 * 「三条推送合流」本身 —— 那件事由
 * `packages/renderer/platform/__tests__/electron-transport.test.ts` 直接钉。
 *
 * 跑法:仓根先 `bun run vue:build`(electron-vite build → out/;根 `build` 自 2026-09-03 起是 React 壳),然后
 * `node scripts/gate-vue-host.mjs`。每次一个全新的临时 store + user-data-dir,
 * 跑完删干净;绝不碰 `~/.onething`。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import electronBinary from 'electron'
import { startFakeProvider, fakeProviderAiSettings, FAKE_PROVIDER_ENV } from './lib/gate-fake-provider.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainEntry = path.join(repoRoot, 'out/main/index.js')
const rendererIndex = path.join(repoRoot, 'out/renderer/index.html')

const TYPED_TEXT = 'gate-vue-host:这一句是从 Vue 输入框发出去的'
const REPLY_TEXT = 'gate-vue-host:这是假 provider 的流式回答,分三片送达。'
const MOCK_PORT = 18781

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败:${message}`)
  console.log(`  ✓ ${message}`)
}

async function waitFor(label, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last) return last
    await delay(200)
  }
  throw new Error(`超时(${timeoutMs}ms)等待:${label}`)
}

/** 屏幕上按 `.message[data-message-id]` 取的那棵树(role 取自 message.role 那个类名)。 */
function readScreenTree(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.message[data-message-id]')).map(el => ({
      id: el.getAttribute('data-message-id'),
      role: el.classList.contains('user') ? 'user' : el.classList.contains('assistant') ? 'assistant' : 'other',
      text: el.textContent ?? '',
    })),
  )
}

async function main() {
  if (!existsSync(mainEntry) || !existsSync(rendererIndex)) {
    console.error('[gate-vue-host] 找不到构建产物 —— 先在仓根跑 `bun run build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'gate-vue-host-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'gate-vue-host-userdata-'))
  let mockServer
  let app

  try {
    console.log('\n[1/6] 起假 provider,写隔离 settings.json')
    mockServer = await startFakeProvider(MOCK_PORT, REPLY_TEXT)
    writeFileSync(path.join(store, 'settings.json'), JSON.stringify({
      ai: fakeProviderAiSettings(MOCK_PORT),
      tools: { enableToolCalls: false, permissionMode: 'dangerously-allow-all', tools: {} },
      diagnostics: { enabled: false },
    }, null, 2))
    assert(existsSync(path.join(store, 'settings.json')), `隔离 store:${store}`)

    console.log('\n[2/6] 拉起 Vue 桌面(真 Electron 主进程,真 core)')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ...FAKE_PROVIDER_ENV,
        ONETHING_STORE_PATH: store,
        NODE_ENV: 'production', // 强制走 out/renderer 那份构建产物,不去打 5173 的 vite dev server
        ONETHING_DEV_VERBOSE: '',
      },
    })
    const mainProcess = app.process()
    const stderrLines = []
    mainProcess.stderr?.on('data', chunk => stderrLines.push(chunk.toString()))

    const page = await waitFor('主窗口打开', async () => {
      const windows = app.windows()
      return windows.length > 0 ? windows[0] : undefined
    }).catch(error => {
      throw new Error(`${error.message}\nstderr 尾:\n${stderrLines.slice(-40).join('')}`)
    })
    await page.waitForLoadState('domcontentloaded')

    console.log('\n[3/6] 等 core 装配完(发现文件落盘)')
    const discoveryPath = path.join(store, 'run', 'http.json')
    const record = await waitFor('core 写出发现文件', () => {
      try {
        const found = JSON.parse(readFileSync(discoveryPath, 'utf-8'))
        return found?.owner ? found : undefined
      } catch {
        return undefined
      }
    }, 30_000).catch(error => {
      throw new Error(`${error.message}\nstderr 尾:\n${stderrLines.slice(-60).join('')}`)
    })
    assert(record.owner === 'shell' || record.owner === 'desktop', `owner=${record.owner}`)

    console.log('\n[4/6] 冷启动落在「没有活跃会话」——点 New Chat 起一条草稿会话')
    await waitFor('New Chat 按钮在 DOM 里', () =>
      page.evaluate(() => Array.from(document.querySelectorAll('button, [role="button"], a'))
        .some(el => (el.textContent || '').includes('New Chat'))),
    )
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .find(el => (el.textContent || '').includes('New Chat'))
      btn?.click()
    })
    await waitFor('composer 输入区在 DOM 里', () =>
      page.evaluate(() => Boolean(document.querySelector('.composer-input [contenteditable="true"]'))),
    )

    console.log('\n[5/6] ① 在输入框里真敲一句、真发送')
    await page.click('.composer-input [contenteditable="true"]')
    await page.keyboard.type(TYPED_TEXT, { delay: 5 })
    await page.click('.send-btn')

    const afterSend = await waitFor('那句话出现在屏幕的消息树上', async () => {
      const tree = await readScreenTree(page)
      const hit = tree.find(row => row.role === 'user' && row.text.includes(TYPED_TEXT))
      return hit ? { tree, hit } : undefined
    })
    assert(Boolean(afterSend.hit.id), `用户消息落屏,id=${afterSend.hit.id}`)

    console.log('\n[6/6] ② 假 provider 的流式回复经推送链路(IPC 桥)上屏')
    const afterReply = await waitFor('assistant 消息出现且带上了假 provider 的整段回答', async () => {
      const tree = await readScreenTree(page)
      const hit = tree.find(row => row.role === 'assistant' && row.text.includes(REPLY_TEXT))
      return hit ? { tree, hit } : undefined
    }, 20_000).catch(async error => {
      const tree = await readScreenTree(page).catch(() => [])
      throw new Error(`${error.message}\n当前屏幕树:${JSON.stringify(tree)}\nstderr 尾:\n${stderrLines.slice(-60).join('')}`)
    })
    assert(Boolean(afterReply.hit.id), `assistant 回复落屏,id=${afterReply.hit.id}`)

    console.log('\n[gate-vue-host] 全绿:发送 → 账本 → 流式回复上屏,链路完整')
  } finally {
    console.log('\n[清理] 关应用 / 停假 provider / 删临时目录')
    await app?.close().catch(() => {})
    await new Promise(resolve => mockServer ? mockServer.close(resolve) : resolve())
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
    // 电子多进程收尸兜底(GPU / utility 子进程偶尔逃逸 app.close())。
    spawnSync('pkill', ['-f', `--user-data-dir=${userDataDir}`], { stdio: 'ignore' })
  }
}

main().catch(error => {
  console.error('\n[gate-vue-host] 红:', error.message)
  process.exitCode = 1
})
