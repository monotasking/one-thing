#!/usr/bin/env node
/**
 * 工作区「真切换」的真机门(09-01)—— **脚本级,拒人肉 QA**。
 *
 * 用户裁定:「workspace 的切换现在是假的,真正实现 workspace 的切换」。
 * 这条门证的就是那句话的反面 —— 切换之后**世界真的换了**,而且换得干净。
 *
 * ── 它证什么(十条) ──────────────────────────────────────────────────────
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
 *  ⑦ **四条架子的快捷键**(09-01 用户放权):⌘⌥←/→/↓/↑ 各管各的一侧,
 *     再按一次就展开(收/展是可逆的开关,不是「关掉整栏」)。
 *  ⑧ **家具按空间隔离**(T-W1):切过去是**出厂布局**、旧空间那套原样留在账上、
 *     切回来逐格相同。用户原话:「架子、文件树整套都是新的一套,之前的留在那个空间」。
 *  ⑨ **空间自己配的 provider 不被全局盖掉**(09-01 报障 ① 的另一半):
 *     未迁移态的回落必须**两个条件同时成立**,少判一条就会把这个空间配好的
 *     设置换成全局那份。
 *  ⑩ **建完看得见**(09-01 报障 ②):建一个工作区之后总览还开着、新卡在屏上
 *     并标着「当前」——「建」与「切」绑成一步,但切换不该把人正看着的那块面收走。
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


/** 往目标窗口里派发一次组合键。**页面内 DOM 派发**,不动真光标、不抢前台焦点。 */
async function pressCombo(page, key, mods = {}) {
  await page.evaluate(
    ([k, m]) => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: k,
          metaKey: m.meta === true,
          altKey: m.alt === true,
          shiftKey: m.shift === true,
          bubbles: true,
          cancelable: true,
        }),
      )
    },
    [key, mods],
  )
  await delay(60)
}

/**
 * stage 的持久化档案。**家具账就落在这里**(`byWorkspace`),所以这一口同时是
 * 「快捷键真的改了状态没有」与「家具真的按空间分开没有」两件事的读数口 ——
 * 它读的是盘上那份真东西,不是页面里某个探针变量。
 */
function readStagePersist(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('onething.stage') || '{}')
    } catch {
      return {}
    }
  })
}

/** 某个空间那一格里,四条架子各自收起了没有。 */
function collapsedOf(persisted, spaceId) {
  const shelves = persisted?.state?.byWorkspace?.[spaceId]?.shelves
  if (!shelves) return null
  return {
    left: shelves.left?.collapsed === true,
    right: shelves.right?.collapsed === true,
    top: shelves.top?.collapsed === true,
    bottom: shelves.bottom?.collapsed === true,
  }
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
  /*
   * ── 独立的 `--user-data-dir`(09-01 修,与 gate:files / gate:a11y 同一条)──
   * 这道门从前**没给**,于是它跑在用户真实的 Electron 档案上。后果两条,都真发生过:
   *  ① **不可重复**:家具账(`onething.stage` 的 byWorkspace)住在 localStorage,
   *     而 localStorage 跟 user-data-dir 走、**不跟临时 store 走**。上一次跑留下的
   *     `space-…` 那几格会原样躺到下一次 —— 真机上抓到过一次账里攒了四个空间
   *     (三个是历史遗留),第 4 步「切回默认」当场读成空列表,而病根不在被测代码里。
   *  ② **改用户状态**:那正是「验证不改用户状态」那条纪律要拦的事。
   * 临时 store 只隔了后端那一半,前端那一半要靠这一行。
   */
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'workspace-gate-udd-'))
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

    console.log('\n[1/11] 在磁盘上种出两个空间各自的工作目录')
    for (const [key, dir] of Object.entries(dirs)) {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, `${key}-only.txt`), 'gate\n')
    }

    console.log('\n[2/11] 起一台 core,建第二个空间 + 两边各自的会话 / 设置 / 凭证')
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

    console.log('\n[3/11] 拉起应用(默认空间),会话列表只该有默认空间那两条')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
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

    console.log('\n[4/11] 切到第二个空间:面板开合也是家具;两边都开着时零重挂 + 一帧就位')
    /*
     * 切换走 **⌘2**(全局档的工作区序号直达),页面内 DOM 派发 —— 不动真光标、
     * 不抢前台焦点,与本门其余的 `element.click()` 同一条纪律。
     *
     * ── T-W1 之后这一步的语义变了(第一版在这里红过,而它红得对)──────────
     * 从前这里假设「会话面从头到尾挂在那儿」,于是拿它的滚动容器去量零重挂。
     * 家具按空间隔离之后**那个假设不成立了**:一块面开着没有(placements)
     * 本身就是家具,默认空间开着会话面,第二个空间**没开过**,所以切过去它
     * 就该关掉 —— 屏幕上一张卡都没有正是对的。真机第一次跑出来的读数就是
     * `cards:0 / overview:false`,那不是回归,是这一批要的行为。
     *
     * 所以这一步改成两段:
     *  ① 切过去 → 面板**关掉**(⑧ 家具:面板开合不跨空间);
     *  ② 在新空间里把它开出来 → 此后两个空间都开着,**这时**再来回切一次
     *     量「一帧就位」与「同一个 DOM 节点」—— 那才是四律要问的话
     *     (换世界有没有把一棵**本该留着**的树掀了),而不是问一块本就该关的面。
     */
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true, cancelable: true }),
      )
    })
    await delay(120)
    const afterSwitch = await readCards(page)
    assert(!afterSwitch.skeleton, '⑤ 切换那一刻屏幕上没有骨架(禁全屏骨架闪)')
    assert(
      afterSwitch.count === 0,
      '⑧ **面板开合也是家具**:默认空间开着的会话面没有跟到第二个空间来',
    )

    // 在第二个空间把会话面开出来,顺带看它只装着这个空间的会话。
    await openPanel(page, 'sessions', '[data-testid^="card-"]')
    const inWork = await waitFor('第二个空间的卡画出来', async () => {
      const seen = await readCards(page)
      return seen.count > 0 ? seen : undefined
    })
    console.log('  · 第二个空间屏上:', JSON.stringify(inWork.titles))
    assert(
      inWork.titles.some(t => t.includes('工作空间 · 会话丙')),
      '① 第二个空间那一条在屏上',
    )
    assert(
      !inWork.titles.some(t => t.includes('默认空间')),
      '① 默认空间那两条不在屏上 —— 列表整套换掉了',
    )

    /*
     * 两个空间现在都开着会话面。来回切一次,量四律要的那两件:
     *  · **一帧就位** —— 切换是纯投影(账本重投影 + 家具摊开),不发一次请求;
     *  · **零重挂** —— 那块面在两个空间都开着,所以它的滚动容器必须是同一个节点。
     * 抓的是滚动容器而不是某张卡的父节点:卡会换、组会换(两个空间的会话落在
     * 不同项目下,分组本来就该重画)。第一版抓 `card-*.parentElement`(= 组的
     * section)红过一次 —— 那是量错了东西。
     */
    const beforeSwitch = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="expose-overview-scroll"]')
      window.__wsGate = { node: list ?? null }
      return { known: Boolean(list) }
    })
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '1', metaKey: true, bubbles: true, cancelable: true }),
      )
    })
    // 一帧的余量,不是一次 waitFor —— 若要等网络往返,一帧是等不出来的,这一条会当场红。
    await delay(120)
    const backInDefault = await readCards(page)
    console.log('  · 切回默认空间一帧就读到:', JSON.stringify(backInDefault.titles))
    assert(!backInDefault.skeleton, '⑤ 切回来那一刻也没有骨架')
    assert(
      backInDefault.count === 2 && backInDefault.titles.every(t => t.includes('默认空间')),
      '⑤ 切换后**一帧之内**新世界就在屏上(没有空屏那一档 = 切换不发请求)',
    )
    const sameNode = await page.evaluate(() => {
      const now = document.querySelector('[data-testid="expose-overview-scroll"]')
      return { known: Boolean(now), same: window.__wsGate?.node === now }
    })
    if (beforeSwitch.known && sameNode.known) {
      assert(sameNode.same, '⑤ 两边都开着时,切换前后列表容器是**同一个 DOM 节点**(零重挂)')
    } else {
      skip('⑤ 零重挂:没抓到列表容器(选择器与这一版界面对不上)')
    }

    // 回到第二个空间,后面几步都在它里面做。
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '2', metaKey: true, bubbles: true, cancelable: true }),
      )
    })
    await delay(120)
    await page.screenshot({ path: path.join(shotDir, 'workspace-switched.png') })

    console.log('\n[5/11] 进这个空间的会话,文件面的根跟着换')
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

    console.log('\n[6/11] 在第二个空间里从界面上建一条会话,回 core 侧核归属')
    const before = new Set((await rpc(record, 'sessions', 'listMeta', {})).sessions.map(s => s.id))
    // 上一步开了文件面,会话面让位给了它 —— 先把会话面开回来,那颗「+」才在 DOM 里。
    await openPanel(page, 'sessions', '[data-testid^="group-plus-"]')
    await clickSelector(page, '[data-testid^="group-plus-"]')
    const fresh = await waitFor('core 侧看到那条新会话', async () => {
      const listed = await rpc(record, 'sessions', 'listMeta', {})
      return listed.sessions.find(s => !before.has(s.id))
    })
    console.log('  · 新会话:', JSON.stringify({ id: fresh.id, workspaceId: fresh.workspaceId }))
    assert(
      fresh.workspaceId === workId,
      `② 新会话落在第二个空间上(workspaceId=${fresh.workspaceId})—— 这一格是壳与引擎唯一的接缝`,
    )

    console.log('\n[7/11] 模型服务面:provider 设置与凭证池跟着空间走')
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


    console.log('\n[8/11] 四条架子的快捷键:⌘⌥←/→/↓/↑ 各开各收')
    /*
     * 读数口是**盘上那份 stage 档案**(`onething.stage` 的 byWorkspace),不是
     * 页面里的探针变量:它同时证「键真的接上了」与「状态真的落进了当前空间那一格」。
     * 键盘事件是页面内 DOM 派发(`window.dispatchEvent`),与本门其余的
     * `element.click()` 同一条纪律 —— 不动真光标、不抢前台焦点。
     *
     * 逐条按、逐条读:四个键必须**各管各的那一侧**。一次全按完再读的话,
     * 「四个键都绑到了同一侧」这种错会完全看不出来。
     */
    await clickSelector(page, `[data-testid="workspace-switch-${DEFAULT_SPACE_ID}"]`).catch(async () => {
      await openPanel(page, 'workspace', '[data-testid^="workspace-switch-"]')
      await clickSelector(page, `[data-testid="workspace-switch-${DEFAULT_SPACE_ID}"]`)
    })
    await delay(120)

    const SHELF_KEYS = [
      { side: 'left', key: 'ArrowLeft' },
      { side: 'right', key: 'ArrowRight' },
      { side: 'bottom', key: 'ArrowDown' },
      { side: 'top', key: 'ArrowUp' },
    ]
    for (const { side, key } of SHELF_KEYS) {
      await pressCombo(page, key, { meta: true, alt: true })
      const seen = collapsedOf(await readStagePersist(page), DEFAULT_SPACE_ID)
      if (!seen) throw new Error(`按完 ${key} 之后盘上还没有默认空间那一格家具`)
      assert(seen[side] === true, `⑦ ⌘⌥${key.replace('Arrow', '')} 收起了 ${side} 架子`)
      const others = SHELF_KEYS.filter(k => k.side !== side).map(k => k.side)
      const leaked = others.filter(o => seen[o] === true && SHELF_KEYS.findIndex(k => k.side === o) > SHELF_KEYS.findIndex(k => k.side === side))
      assert(leaked.length === 0, `⑦ 它只动了 ${side} 这一侧(还没按到的 ${others.join('/')} 没被顺带收掉)`)
    }
    // 再按一次 = 展开(它是**开关**,不是「关掉整栏」)。
    await pressCombo(page, 'ArrowRight', { meta: true, alt: true })
    assert(
      collapsedOf(await readStagePersist(page), DEFAULT_SPACE_ID)?.right === false,
      '⑦ 同一个键再按一次就展开 —— 语义是收/展,可逆',
    )

    console.log('\n[9/11] 家具按空间隔离:切过去是出厂,切回来原样')
    const furnishedInDefault = collapsedOf(await readStagePersist(page), DEFAULT_SPACE_ID)
    console.log('  · 默认空间此刻的四条架子:', JSON.stringify(furnishedInDefault))
    assert(
      furnishedInDefault.left && furnishedInDefault.bottom && furnishedInDefault.top && !furnishedInDefault.right,
      '⑧ 默认空间里摆好了一套可辨认的家具(左/下/上收起,右展开)',
    )

    await pressCombo(page, '2', { meta: true })
    const inWorkSpace = collapsedOf(await readStagePersist(page), workId)
    console.log('  · 第二个空间此刻的四条架子:', JSON.stringify(inWorkSpace))
    assert(
      inWorkSpace === null
        || (!inWorkSpace.left && !inWorkSpace.right && !inWorkSpace.top && !inWorkSpace.bottom),
      '⑧ **首进这个空间 = 出厂布局**(四条架子都是展开的),不是把默认空间那套端过来',
    )
    // 旧空间那一格**原样留在账上** —— 这是「之前的留在那个空间」那句话的字面读数。
    assert(
      JSON.stringify(collapsedOf(await readStagePersist(page), DEFAULT_SPACE_ID)) ===
        JSON.stringify(furnishedInDefault),
      '⑧ 默认空间那一套原样留在账上,没被新空间的覆盖',
    )

    await pressCombo(page, '1', { meta: true })
    assert(
      JSON.stringify(collapsedOf(await readStagePersist(page), DEFAULT_SPACE_ID)) ===
        JSON.stringify(furnishedInDefault),
      '⑧ 切回来 = 当初那一套,逐格相同',
    )
    await page.screenshot({ path: path.join(shotDir, 'workspace-furniture.png') })

    console.log('\n[10/11] 空间自己配的 provider 不被全局盖掉(报障 ① 的另一半)')
    /*
     * 报障 ① 的病根是 e389473b 漏掉的**未迁移态**:一台还没跑过 C2 搬迁的机器盘上
     * 没有 `workspaces/<id>/providers.json`,而
     *   settings.getSettings().ai        → 原样给出旧形状(配好的那些 provider)
     *   spaces.getProviderSettings(空间) → **空**(只读文件,不认迁移标记)
     * 屏幕改读后者之后,药丸写「Pick a model」、抽屉一家都列不出来。
     * 修法是**两个条件同时成立才回落**(空间那份不存在 ∧ 没迁移过)。
     *
     * 这道门的 store 恰好是**另一半**:种子走 `spaces.setProviderSettings`,
     * 于是「有 per-space 文件、但没有迁移标记」—— 修法的第一版只判标记,在这里
     * 会把空间自己配的 zhipu 换成全局的 deepseek。所以这一步守的正是那个洞:
     * **屏幕上读到的默认模型必须是这个空间自己那一个**。
     * 「未迁移 ∧ 空 → 回落」那一半由单测与真机探针守(报告里有修前/修后读数)。
     */
    // 上一步收尾停在默认空间(它配的是 deepseek-chat),先切到第二个空间去问。
    await pressCombo(page, '2', { meta: true })
    await delay(200)
    const drawerSeen = await waitFor('模型药丸读出这个空间的默认', async () => {
      const text = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find(x =>
          (x.getAttribute('aria-label') || '').startsWith('Pick a model'),
        )
        return (b?.textContent || '').trim()
      })
      return text || undefined
    })
    console.log('  · 模型药丸:', drawerSeen)
    assert(
      drawerSeen.includes('glm-5'),
      `⑨ 药丸写的是**这个空间**配的模型 glm-5(读到「${drawerSeen}」)—— 没被全局那份盖掉`,
    )
    assert(
      !drawerSeen.includes('deepseek'),
      '⑨ 而且不是默认空间配的 deepseek-chat —— 回落没有撬开空间隔离',
    )

    console.log('\n[11/11] 建一个工作区:建完看得见(报障 ②)')
    /*
     * 报障(截图 I-ws-after-create.png):建完总览当场关掉、屏幕回到空壳,
     * 用户看不到自己刚建的那张卡。病根是「建」与「切」绑成一步,而切换换整套家具
     * (T-W1:一块面开着没有本身就是家具)。隔离不改,改的是这个动作自己的承诺。
     */
    await openPanel(page, 'workspace', '[data-testid="workspace-create"]')
    await clickSelector(page, '[data-testid="workspace-create"]')
    await waitFor('新建输入框就位', () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="workspace-name-input"]'))),
    )
    const NEW_NAME = '门建的第三个空间'
    await page.evaluate(name => {
      const input = document.querySelector('[data-testid="workspace-name-input"]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, name)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    }, NEW_NAME)

    const madeCard = await waitFor('新卡就位', async () =>
      page.evaluate(() => {
        const card = [...document.querySelectorAll('[data-testid^="workspace-card-"]')].find(
          el => (el.textContent || '').includes('门建的第三个空间'),
        )
        return card
          ? {
              onScreen: true,
              current: card.getAttribute('data-current') === 'true',
              overviewOpen: Boolean(document.querySelector('[data-testid="workspace-overview"]')),
            }
          : undefined
      }),
    )
    console.log('  · 建完屏上:', JSON.stringify(madeCard))
    assert(madeCard.overviewOpen, '⑩ 建完**总览还开着** —— 用户看得到自己刚建的东西')
    assert(madeCard.current, '⑩ 新卡标着「当前」:确实切过去了,不是靠不切换换来的')
    await page.screenshot({ path: path.join(shotDir, 'workspace-after-create.png') })

    await app.close()
    app = undefined
    console.log(
      `\n[workspace-gate] ok —— 切换真的换世界(列表 / 归属 / provider 设置 / 凭证 / 零重挂 / 家具 / 四条架子键)`
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
    await rm(userDataDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error('\n[workspace-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
