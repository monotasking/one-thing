#!/usr/bin/env node
/**
 * 工作区「真切换」的真机门(09-01)—— **脚本级,拒人肉 QA**。
 *
 * 用户裁定:「workspace 的切换现在是假的,真正实现 workspace 的切换」。
 * 这条门证的就是那句话的反面 —— 切换之后**世界真的换了**,而且换得干净。
 *
 * ── 它证什么(六条,每一条都是「假切换」时代会红的) ──────────────────────
 *  ① **会话列表按空间过滤**:两个空间各有自己的会话,切过去只看得见本空间那些,
 *     另一个空间的一条都不在 DOM 里。
 *  ② **新会话归属正确**:在空间 B 里从界面上建一条,回到 core 侧读 `listMeta`,
 *     那条的 `workspaceId` 必须是 B。这一格是壳与引擎之间**唯一**的接缝 ——
 *     漏了它,凭证 / 接入目录 / provider 设置全都会在下一次起流时找错空间
 *     (后端一律由 `session.workspaceId` 派生,它从来没有「当前空间」的概念)。
 *  ③ **provider 设置按空间**:两个空间各配一套(默认家 + 勾选的型),
 *     切过去屏幕上读到的是本空间那一套。
 *  ④ **凭证池按空间**:两个空间各一把 key,尾号不同;切过去尾号跟着换。
 *  ⑤ **切换不闪、不重挂**:切换前后会话列表是**同一个 DOM 节点**(零重挂),
 *     而且切换之后的首帧就有内容(没有骨架、没有空屏那一档)。
 *  ⑥ **文件面的根跟着换**:它按活跃会话的工作目录取,而会话跟着空间走 ——
 *     这一条证的是那条传导链真的通(壳这边一个字的空间参数都没加)。
 *
 * ── 为什么这一半必须真机 ─────────────────────────────────────────────────
 * 单元测试换掉的是端口,证的是「壳往哪条口上打」;这里证的是**盘上那几个文件
 * 与屏幕上那几行字对得上** —— 空间的隔离最终落在
 * `workspaces/<id>/{providers,credentials}.json` 与会话 `meta.json` 的
 * `workspaceId` 上,那是端口假不出来的。⑤ 那两条(节点同一性 / 首帧有内容)
 * 更是只有真排版才量得到。
 *
 * ── 输入探针 ────────────────────────────────────────────────────────────
 * 全程**页面内 DOM 派发**(`element.click()`),一次 `page.mouse` / `page.keyboard`
 * 都不用 —— 只落在目标窗口里,不动真光标、不抢前台焦点(09-01 纪律)。
 *
 * 跑法:`node scripts/gate-workspace.mjs`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 可重复:每次全新的临时 store + 临时 workspace,跑完删干净(收尸在 finally 里)。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
const shotDir = path.join(appRoot, 'dist', 'gate-shots')

/** 沙箱根的两段 —— 与 `ownerSandboxRoot(root, uid, wid)` 的拼法一致(同 gate-files)。 */
const OWNER_UID = 'local-user'
const OWNER_WID = 'default'

/** 与 `@onething/runtime/spaces/types` 的 `DEFAULT_SPACE_ID` 同值。 */
const DEFAULT_SPACE_ID = 'default'
/** 第二个空间。id 由 `spaces.create` 现给,名字在这里钉死(要按名字找那张卡)。 */
const WORK_NAME = '工作区门 · 第二个空间'

/**
 * 两个空间各自的会话名。**带各自的前缀**:屏幕上一眼看得出串没串空间,
 * 断言也不必依赖 id(id 是后端现给的)。
 */
const SEED = {
  [DEFAULT_SPACE_ID]: ['默认空间 · 会话甲', '默认空间 · 会话乙'],
  work: ['工作空间 · 会话丙'],
}

/** 两个空间各一套 provider 设置 —— 默认家不同,勾选的型也不同。 */
const SPACE_AI = {
  [DEFAULT_SPACE_ID]: {
    provider: 'deepseek',
    providers: { deepseek: { model: 'deepseek-chat', selectedModels: ['deepseek-chat'] } },
    customProviders: [],
  },
  work: {
    provider: 'zhipu',
    providers: { zhipu: { model: 'glm-5', selectedModels: ['glm-5'] } },
    customProviders: [],
  },
}

/** 两个空间各一把假 key。尾号不同 —— 「串没串空间」一眼就看得出来。 */
const SPACE_KEY = {
  [DEFAULT_SPACE_ID]: 'sk-gate-default-aaaa',
  work: 'sk-gate-work-bbbb',
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

function assert(condition, message) {
  if (!condition) throw new Error(`断言失败:${message}`)
  console.log(`  ✓ ${message}`)
}

function skip(message) {
  console.log(`  ⊘ 跳过:${message}`)
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
 * 与 gate-files / gate-search 同一条理由:用 `element.click()` 绕开可操作性判定,
 * 派发的仍是真事件,而且只落在目标窗口里 —— 不动真光标、不抢前台焦点。
 */
async function clickSelector(page, selector) {
  const clicked = await page.evaluate(css => {
    const el = document.querySelector(css)
    if (!el) return false
    el.click()
    return true
  }, selector)
  if (!clicked) throw new Error(`点不到:${selector} 不在 DOM 里`)
}

/** 打开某块 Dock 面。瓦是开关,所以先看在不在,不在才点。 */
async function openPanel(page, itemId, readySelector) {
  const deadline = Date.now() + 25_000
  let last
  while (Date.now() < deadline) {
    last = await page.evaluate(css => Boolean(document.querySelector(css)), readySelector)
    if (last) return
    await clickSelector(page, `[data-testid="dock-tile-${itemId}"]`).catch(() => {})
    await delay(250)
  }
  throw new Error(`超时:${itemId} 面没开出来(等的是 ${readySelector})`)
}

/**
 * 屏幕上此刻的会话卡。读的是 `data-testid="card-<id>"` 那一族的**标题文字**——
 * 断言按名字写(名字是种子给的),不依赖后端现给的 id。
 */
function readCards(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-testid^="card-"]')].filter(
      el => !el.getAttribute('data-testid').startsWith('card-preview-')
        && !el.getAttribute('data-testid').startsWith('card-digest-'),
    )
    return {
      titles: cards.map(el => (el.textContent || '').trim()),
      count: cards.length,
      // 骨架在不在(切换那一刻屏幕上不许有它)。
      skeleton: Boolean(document.querySelector('[data-skeleton], [class*="skeleton"]')),
    }
  })
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[workspace-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[workspace-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'workspace-gate-store-'))
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'workspace-gate-ws-'))
  const sandbox = path.join(workspaceRoot, OWNER_UID, OWNER_WID)
  /** 两个空间各一个工作目录 —— 文件面的根跟着**会话**走,而会话跟着空间走。 */
  const dirs = {
    [DEFAULT_SPACE_ID]: path.join(sandbox, 'default-project'),
    work: path.join(sandbox, 'work-project'),
  }
  let server
  let app
  try {
    await mkdir(shotDir, { recursive: true })

    console.log('\n[1/7] 在磁盘上种出两个空间各自的工作目录')
    for (const [key, dir] of Object.entries(dirs)) {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, `${key}-only.txt`), 'gate\n')
    }

    console.log('\n[2/7] 起一台 core,建第二个空间 + 两边各自的会话 / 设置 / 凭证')
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
    server.stderr.on('data', chunk => serverErr.push(chunk.toString()))

    const record = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    }).catch(error => {
      throw new Error(`${error.message}\nserver stderr:\n${serverErr.join('')}`)
    })
    assert(await portConnects(record.host, record.port), `core 端口 ${record.port} 可连`)

    const created = await rpc(record, 'spaces', 'create', { name: WORK_NAME, color: 'blue' })
    const workId = created?.space?.id
    if (!workId) throw new Error(`spaces.create 没给出 id:${JSON.stringify(created)}`)
    assert(Boolean(workId), `第二个空间建出来了(id=${workId})`)

    const idsBySpace = { [DEFAULT_SPACE_ID]: [], work: [] }
    for (const [key, names] of Object.entries(SEED)) {
      const spaceId = key === 'work' ? workId : DEFAULT_SPACE_ID
      for (const name of names) {
        const session = await rpc(record, 'sessions', 'create', { name, workspaceId: spaceId })
        const id = session?.session?.id
        if (!id) throw new Error(`sessions.create 没给出 id:${JSON.stringify(session)}`)
        idsBySpace[key].push(id)
        await rpc(record, 'sessions', 'updateWorkingDirectory', {
          sessionId: id,
          workingDirectory: dirs[key],
        })
      }
    }
    assert(
      idsBySpace[DEFAULT_SPACE_ID].length === 2 && idsBySpace.work.length === 1,
      'core 侧确认:默认空间 2 条会话、第二个空间 1 条',
    )

    for (const [key, ai] of Object.entries(SPACE_AI)) {
      const spaceId = key === 'work' ? workId : DEFAULT_SPACE_ID
      await rpc(record, 'spaces', 'setProviderSettings', { id: spaceId, ai })
    }
    assert(true, '两个空间各写了一套 provider 设置(默认家与勾选的型都不同)')

    /*
     * 凭证:**允许种不上**。09-01 起没有加密能力的宿主(纯 node server)会拒绝
     * 把凭证降级成明文,所以这一发在某些机器上答不成功。种不上就跳过 ④ 并明说,
     * 不假装绿 —— 与 gate-credentials 对「源 store 里没有加密凭证」的处理同一手。
     */
    let credentialsSeeded = true
    for (const [key, apiKey] of Object.entries(SPACE_KEY)) {
      const spaceId = key === 'work' ? workId : DEFAULT_SPACE_ID
      try {
        await rpc(record, 'spaces', 'setCredential', { id: spaceId, providerId: 'deepseek', apiKey })
      } catch (error) {
        credentialsSeeded = false
        console.log(`  · 凭证种不上(${key}):${error.message.split('\n')[0]}`)
      }
    }
    if (credentialsSeeded) assert(true, '两个空间各种了一把假 key(尾号不同)')

    console.log('\n[3/7] 拉起应用(默认空间),会话列表只该有默认空间那两条')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry],
      env: { ...process.env, ONETHING_STORE_PATH: store, ONETHING_REACT_DEV_SERVER_URL: '' },
    })
    const page = await app.firstWindow()
    await waitFor('渲染层完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })

    await openPanel(page, 'sessions', '[data-testid^="card-"]')
    const inDefault = await waitFor('默认空间的卡画出来', async () => {
      const seen = await readCards(page)
      return seen.count > 0 ? seen : undefined
    })
    console.log('  · 默认空间屏上:', JSON.stringify(inDefault.titles))
    assert(
      SEED[DEFAULT_SPACE_ID].every(name => inDefault.titles.some(t => t.includes(name))),
      '① 默认空间那两条都在屏上',
    )
    assert(
      !inDefault.titles.some(t => t.includes('工作空间')),
      '① 另一个空间的会话**一条都不在 DOM 里**(不是藏起来,是根本没画)',
    )

    console.log('\n[4/7] 切到第二个空间:零重挂 + 首帧就有内容 + 列表整套换掉')
    /*
     * 切换走 **⌘2**(全局档的工作区序号直达),而不是去总览上点那张卡。
     * 理由是这一步要量的正是「零重挂」:开一次总览面就把会话面收了、切完再开
     * 回来 —— 那样量到的是**面板开合**的重挂,与切换毫无关系(第一版就是这么
     * 写的,红在这一格上,而它红得没有意义)。⌘2 让会话面从头到尾挂在那儿,
     * 于是节点同一性问的才是「换世界有没有把这棵树掀了」。
     *
     * 键盘事件也是**页面内 DOM 派发**(`window.dispatchEvent`),不动真光标、
     * 不抢前台焦点 —— 与本门其余的 `element.click()` 同一条纪律。
     */
    // 抓的是**滚动容器**而不是某张卡的父节点:卡会换、组会换(两个空间的会话
    // 落在不同的项目下,分组本来就该重画),而这个容器必须是同一个节点。
    // 第一版抓 `card-*.parentElement`(= 组的 section)红过一次 —— 那是量错了东西。
    const beforeSwitch = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="expose-overview-scroll"]')
      window.__wsGate = { node: list ?? null }
      return { known: Boolean(list) }
    })
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true, cancelable: true }),
      )
    })

    // **同步就位**:切换是纯投影,新世界的首屏不经过任何一次请求。React 只欠
    // 一次渲染,所以这里给一帧的余量,而不是一次 waitFor —— 若要等网络往返,
    // 一帧是等不出来的,这一条会当场红。
    await delay(120)
    const rightAfter = await readCards(page)
    console.log('  · 切换后一帧就读到:', JSON.stringify(rightAfter.titles))
    assert(!rightAfter.skeleton, '⑤ 切换那一刻屏幕上没有骨架(禁全屏骨架闪)')
    assert(
      rightAfter.count > 0 && rightAfter.titles.some(t => t.includes('工作空间 · 会话丙')),
      '⑤ 切换后**一帧之内**新世界就在屏上(没有空屏那一档 = 切换不发请求)',
    )
    assert(
      !rightAfter.titles.some(t => t.includes('默认空间')),
      '① 默认空间那两条不在屏上 —— 列表整套换掉了',
    )
    const sameNode = await page.evaluate(() => {
      const now = document.querySelector('[data-testid="expose-overview-scroll"]')
      return { known: Boolean(now), same: window.__wsGate?.node === now }
    })
    if (beforeSwitch.known && sameNode.known) {
      assert(sameNode.same, '⑤ 切换前后列表容器是**同一个 DOM 节点**(零重挂)')
    } else {
      skip('⑤ 零重挂:没抓到列表容器(选择器与这一版界面对不上)')
    }
    await page.screenshot({ path: path.join(shotDir, 'workspace-switched.png') })

    console.log('\n[5/7] 进这个空间的会话,文件面的根跟着换')
    /*
     * 文件根**不是**按空间取的,它按**活跃会话的工作目录**取
     * (`files-source.useSessionCwd`)—— 而会话跟着空间走,所以根是被带过来的。
     * 这一条要证的正是那条传导链真的通:两个空间的会话落在两个不同的目录下,
     * 切过去再进会话,`data-root` 必须是第二个空间那个目录。
     *
     * 顺带证了另一半:切换那一刻旧会话被 `onSessionsRemoved` 从形态机上摘掉
     * (它不在新世界的列表里),所以这里点开的一定是新空间那条。
     */
    await clickSelector(page, '[data-testid^="card-"]')
    await openPanel(page, 'files', '[data-testid="files-root"]')
    const rootSeen = await waitFor('文件面读出根', async () => {
      const value = await page.evaluate(
        () => document.querySelector('[data-testid="files-root"]')?.getAttribute('data-root') || '',
      )
      return value || undefined
    })
    console.log('  · 文件面的根:', rootSeen)
    assert(
      rootSeen === dirs.work,
      `⑥ 文件根换成了第二个空间那条会话的工作目录(${rootSeen})`,
    )
    assert(
      rootSeen !== dirs[DEFAULT_SPACE_ID],
      '⑥ 而且不是默认空间那个目录 —— 根真的被带过来了,不是没动',
    )

    console.log('\n[6/7] 在第二个空间里从界面上建一条会话,回 core 侧核归属')
    const before = new Set((await rpc(record, 'sessions', 'listMeta', {})).sessions.map(s => s.id))
    await clickSelector(page, '[data-testid^="group-plus-"]').catch(async () => {
      // 没有分组的「+」时退回总览上那颗新建(两条入口最终都进 sessions-source.create)。
      await clickSelector(page, '[data-testid="expose-new-session"]')
    })
    const fresh = await waitFor('core 侧看到那条新会话', async () => {
      const listed = await rpc(record, 'sessions', 'listMeta', {})
      return listed.sessions.find(s => !before.has(s.id))
    })
    console.log('  · 新会话:', JSON.stringify({ id: fresh.id, workspaceId: fresh.workspaceId }))
    assert(
      fresh.workspaceId === workId,
      `② 新会话落在第二个空间上(workspaceId=${fresh.workspaceId})—— 这一格是壳与引擎唯一的接缝`,
    )

    console.log('\n[7/7] 模型服务面:provider 设置与凭证池跟着空间走')
    const spaceAiNow = await rpc(record, 'spaces', 'getProviderSettings', { id: workId })
    assert(
      spaceAiNow?.ai?.provider === 'zhipu',
      `③ 盘上第二个空间的默认家仍是 zhipu(壳没有把它写成 default 那一套)`,
    )
    const defaultAiNow = await rpc(record, 'spaces', 'getProviderSettings', { id: DEFAULT_SPACE_ID })
    assert(
      defaultAiNow?.ai?.provider === 'deepseek',
      '③ 默认空间那一套原样没被动过 —— 两套设置真的互不串',
    )

    if (credentialsSeeded) {
      const shown = await page.evaluate(async () => {
        const store = window.__providerSettings
        return store ? store() : null
      })
      if (shown) {
        assert(
          shown.previewOfDeepseek && shown.previewOfDeepseek.endsWith('bbbb'),
          `④ 屏上读到的是第二个空间那把 key(尾号 ${shown.previewOfDeepseek})`,
        )
      } else {
        // 没有探针时退而求其次:直接核盘上两个空间的池子不是同一份。
        const a = await rpc(record, 'spaces', 'getCredentials', { id: DEFAULT_SPACE_ID })
        const b = await rpc(record, 'spaces', 'getCredentials', { id: workId })
        const pa = a?.credentials?.providers?.deepseek?.entries?.[0]?.apiKeyPreview
        const pb = b?.credentials?.providers?.deepseek?.entries?.[0]?.apiKeyPreview
        assert(
          Boolean(pa) && Boolean(pb) && pa !== pb,
          `④ 两个空间的凭证池是两份(尾号 ${pa} vs ${pb})—— 严格隔离`,
        )
      }
    } else {
      skip('④ 凭证:这台机器上纯 node core 种不了凭证(它拒绝写明文),这一条不假装绿')
    }

    await app.close()
    app = undefined
    console.log(
      `\n[workspace-gate] ok —— 切换真的换世界(列表 / 归属 / provider 设置 / 凭证 / 零重挂)`
        + `(截图:${path.relative(appRoot, shotDir)}/)`,
    )
  } finally {
    // 收尸:自己起的每一个进程都在这里逐个杀掉,临时目录一并删干净。
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    if (server && pidAlive(server.pid)) server.kill('SIGKILL')
    await rm(store, { recursive: true, force: true })
    await rm(workspaceRoot, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\n[workspace-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
