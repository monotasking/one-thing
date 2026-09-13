#!/usr/bin/env node
/**
 * 工作区「真切换」的真机门(09-01)—— **脚本级,拒人肉 QA**。
 *
 * 用户裁定:「workspace 的切换现在是假的,真正实现 workspace 的切换」。
 * 这条门证的就是那句话的反面 —— 切换之后**世界真的换了**,而且换得干净。
 *
 * ── 它证什么(十一条) ────────────────────────────────────────────────────
 *  ① **会话列表按空间过滤**:两个空间各有自己的会话,切过去只看得见本空间那些,
 *     另一个空间的一条都不在 DOM 里。
 *  ② **新会话归属正确**:在空间 B 里从界面上建一条,回到 core 侧读 `listMeta`,
 *     那条的 `workspaceId` 必须是 B。这一格是壳与引擎之间**唯一**的接缝 ——
 *     漏了它,凭证 / 接入目录 / provider 设置全都会在下一次起流时找错空间
 *     (后端一律由 `session.workspaceId` 派生,它从来没有「当前空间」的概念)。
 *  ③ **provider 设置按空间**:两个空间各配一套(默认家 + 勾选的型),
 *     切过去屏幕上读到的是本空间那一套。
 *  ④ **凭证池按空间**:两个空间各一把 key,尾号不同;切过去尾号跟着换。
 *  ⑤ **切换不闪、不掀面、不卡**:切换前后那块会话面**两头都在场**(面没被掀掉),
 *     切换之后的首帧就有内容(没有骨架、没有空屏那一档),而且换空间这一拍的
 *     **最长帧**在第五轴「来回切」的预算内。**「同一个 DOM 节点」那句话已经作废**
 *     —— 见下面「⑤ 的第三次口径更正」。
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
 *  ⑪ **全局瓦携带**(S1,09-10;正本 `docs/dock-scope-2026-09.md` §2):
 *     ⑧ 说的是「整套换新」,这一条说的是它的**例外** —— 「工作区」这块瓦是
 *     `level: 'app'`,它不属于哪个工作区,是这台壳的。所以开着的那扇浮窗切过去
 *     **同区域同矩形**;而在新空间把它关掉、切回来它**也不在**(进场那棵树上
 *     那格旧影被剥掉了)。两句缺一不可:只证前一句的话,「端过去但不剥」也是绿的。
 *
 * ── ⑤ 的**第三次口径更正**(09-12;前两次的判词留在第 4 步那两段注释里)────
 * ⑤ 出生那天(`e389473b`,09-01)与当天改口那一次(`6182af4b`)写的都是同一句:
 * 「切换前后 `expose-overview-scroll` 是**同一个 DOM 节点**」。那时它是**免费**
 * 成立的 —— 面板挂在 `stage/` 上,拼贴树**全局只有一棵**,换空间只换树里的数据,
 * 那片叶从头到尾没动过。
 *
 * W4(`a86b79d5`,09-05)把瓦搬进了**按空间隔离的拼贴树**(`WORKBENCH_PER_SPACE`,
 * 叶 id 带空间前缀,`PaneTree` 拿 `key={leaf.id}` 画,holder 绑的是组件实例),
 * 而「会话总览」这块瓦是 `level: 'space'` —— `docs/dock-scope-2026-09.md` §2.2
 * 那张表白纸黑字拍过:**总览本来就按空间过滤**;S1 携带(⑪)只搬 `level: 'app'`
 * 那一类。于是两个空间 = 两棵树 = 两片叶 = **两个 DOM 节点**:重挂是**设计**,
 * 不是回归。今天没有任何一版产品代码能让那句话绿 —— 它已经不是一条可证的断言。
 *
 * **为什么改断言而不改产品**,两条:
 *  · 把瓦表里 `sessions` 的 level 改成 `'app'` 能让节点同一性回来,代价是**默认
 *    空间的总览端到别的空间去显示别人的会话** —— 那当场砸掉同一道门的 ①
 *    (「另一个空间的会话一条都不在 DOM 里」)。拿一条断言的绿换另一条断言的红,
 *    是把门当目标。
 *  · 壳 `CLAUDE.md` 那条「树 / 面常驻铁律」管的是**一个空间之内**的开关浮层:
 *    别因为开了别的面就把人正看着的这块面掀掉。换工作区不在其列 —— 换的是世界,
 *    不是面。
 *
 * 所以 ⑤ 换成两句**今天可证**的:
 *  ① 切换**前后**那块面的滚动容器 `[data-testid="expose-overview-scroll"]`
 *    **都在场** —— 两个空间各自那格都画出来了。两头都读:只读切完那一头的话,
 *    「切之前它就没开」也会绿。
 *  ② 换空间这一拍的**最长帧**(`long-animation-frame`)在预算内 —— **重挂合法
 *    不等于重挂可以慢**,它的代价归**第五轴**那张表管(`BUDGET.switchLongestFrameMs`,
 *    与 `gate:chat-layout` ⑦ 同一把尺、同一个探针体例)。
 * 「一帧之内新世界就在屏上 / 没有骨架 / 不发请求」那半句**原样保留**:它量的是
 * 「切换是纯投影」,与节点同一性无关,W4 一个字都没动它。
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
 * **这道门自己给「工作区序号直达」绑一对键**(K2)。
 *
 * ── 为什么要绑 ──────────────────────────────────────────────────────────
 * 09-12 用户裁定 2 推翻了 08-31 那条:`workspace.slot:*` **出厂不绑键**(⌘1–9 归
 * 焦点叶的第 n 格标签)。而这道门有三段要的是「**一次按键**换一个世界」——
 * ⑤ 量的是「换空间这一拍一帧就位 / 最长帧多长」,那一段的取样窗口只有 120ms,
 * 换成「开工作区面板再点一格」会把面板那几帧算进产品的账里(第 5 轴那条
 * 「门的读数不许把门自己的时间算进产品」)。
 *
 * ── 为什么这不是绕开产品 ────────────────────────────────────────────────
 * 绑的是**产品自己那条改绑路**的结果(`onething.keymap` 的 overrides,设置页录一次
 * 写的就是这一格),命令本身一个字没动 —— 「想要的人自己绑一个」正是那次裁定的
 * 原话。键位挑 **⌘⌥1 / ⌘⌥2**:出厂全表零冲突(带 ⌥ 的只有四条架子与两条换序,
 * 都是方向键),所以这一对不会与任何一条真命令抢。
 *
 * 剩下那几段「切到某个空间」不需要量时间,走的是产品的切换器(`switchSpace`)。
 */
const SLOT_KEYMAP_SEED = {
  version: 4,
  state: {
    overrides: {
      'workspace.slot:1': [{ meta: true, alt: true, key: '1' }],
      'workspace.slot:2': [{ meta: true, alt: true, key: '2' }],
    },
  },
}

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

/**
 * ── ⑤ 的预算(与 `gate:chat-layout` 同一把尺)──────────────────────────────
 * 第五轴那张表(用户 09-10 立)里「来回切 ≤ 50ms」那一格 —— 换空间就是「来回切」
 * 的一种,W4 之后它多了一笔重挂的账,那笔账照这个数收。`BUDGET` 就是那张表,
 * **一个数都不动**;真达不到就照 `gate-chat-layout.mjs` 的体例把过渡值写进
 * `TRANSITIONAL`,每一行印来源与退场判据,达标之后删行而不是改小。
 *
 * 这道门只有**一档**(它要 `dist/` 才跑得起来 = prod 渲染层),所以过渡表是平的,
 * 没有 dev / prod 两列。
 *
 * 量法:页内 `long-animation-frame` 观察器。这个条目本身的门槛就是 50ms ——
 * 也就是说 `longest === 0`(一条都没报)与「这一拍里没有任何一帧超过预算」是
 * 同一句话,预算 50 在这里读作**零长帧**。
 */
const BUDGET = {
  /** ⑤ 换空间那一拍里最长的那一帧。第五轴「来回切 ≤ 50ms」。 */
  switchLongestFrameMs: 50,
}

/** 过渡档(体例同 `gate-chat-layout.mjs`)。**今天是空的** —— 实测就在原数之内。 */
const TRANSITIONAL = {}

/** 这一格今天的判据(有过渡值就用过渡值,没有就是第五轴原数)。 */
function budgetOf(key) {
  return key in TRANSITIONAL ? TRANSITIONAL[key] : BUDGET[key]
}

/** 判据后面那句「这是过渡档」的尾巴。没有过渡值的格子是空串。 */
function laneNote(key) {
  return key in TRANSITIONAL
    ? `(**过渡档**;第五轴原数 ${BUDGET[key]}ms —— 达标之后删掉过渡表那一行)`
    : ''
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
 * **关掉某块 Dock 面** —— 照 `stage/open-item.ts` 的**召唤四态**点,而不是把瓦当
 * 两态开关点一下就算数。
 *
 * 四态是:没开就开 / 看不见就露出来 / **看得见没聚焦就只聚焦** / 焦点已在里面才收起。
 * 于是「关掉一块开着但没聚焦的面」在今天是**两下**,而不是一下(判词与真机逐次
 * 读数写在 ⑫ 那一步的注释里)。封顶 3 下:四态里最远的一条路就是三步,再多就不是
 * 「点不到」而是「点了不管用」—— 那时让调用处那句 `assert` 当场红,别在这里等。
 *
 * `stillOpen()` 由调用处给:这只函数不认识任何一块面的账长什么样。
 */
async function closeStageItem(page, itemId, stillOpen) {
  for (let i = 0; i < 3; i += 1) {
    if (!(await stillOpen())) return
    await clickSelector(page, `[data-testid="dock-tile-${itemId}"]`)
    await delay(250)
  }
}

/**
 * 屏幕上此刻的会话行。读的是 `[data-session-id]`(= `session-row-<id>`)那一族的
 * **标题文字** —— 断言按名字写(名字是种子给的),不依赖后端现给的 id。
 *
 * 09-04 方向 A:卡网格换成了树形列表,testid 从 `card-<id>` 改名
 * `session-row-<id>`,行里那三颗动作钮各有自己的前缀(`session-row-peek-` /
 * `-pin-` / `-caret-`)。这里按 `[data-session-id]` 取行(动作钮身上没有这个属性),
 * 于是不必再逐个排除前缀 —— 少一份会跟着改名漂的名单。
 */
function readCards(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-session-id]')]
    return {
      titles: rows.map(el => (el.textContent || '').trim()),
      count: rows.length,
      // 骨架在不在(切换那一刻屏幕上不许有它)。
      skeleton: Boolean(document.querySelector('[data-skeleton], [class*="skeleton"]')),
    }
  })
}


/**
 * ⑤ 的量尺:页内 `long-animation-frame` 观察器。装一次(`installFrameProbe`),
 * 之后 `frameMark` 取一个号、`frameHarvest` 收这一段里最长的那一帧。
 *
 * 时刻的产地必须在**页内** —— 与 `gate-chat-layout.mjs` 的探针同一条理由:脚本
 * 这一侧的墙钟带着一次 CDP 往返,拿它量 50ms 的预算,往返本身就吃掉一小半。
 *
 * `long-animation-frame` 的条目门槛是 50ms,所以「一条都没报」= 这一段里没有
 * 任何一帧超过预算。观察器装不上(旧内核 / 被关掉)时 `known: false`,那一条**跳过**
 * 而不是假装绿。
 */
async function installFrameProbe(page) {
  await page.evaluate(() => {
    if (window.__wsFrames) return
    const probe = (window.__wsFrames = { loaf: [] })
    try {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) probe.loaf.push(entry.duration)
      }).observe({ type: 'long-animation-frame', buffered: true })
    } catch (error) {
      probe.err = String(error)
    }
  })
}

/** 取号:此刻已经收到多少条长帧。探针没装上给 -1。 */
function frameMark(page) {
  return page.evaluate(() => (window.__wsFrames && !window.__wsFrames.err ? window.__wsFrames.loaf.length : -1))
}

/** 收号:从 `mark` 到现在这一段里,最长的那一帧有多长、一共几条。 */
function frameHarvest(page, mark) {
  return page.evaluate(m => {
    const probe = window.__wsFrames
    if (!probe || probe.err || m < 0) return { known: false, longest: 0, frames: 0 }
    const seen = probe.loaf.slice(m)
    return { known: true, longest: Math.round(Math.max(0, ...seen)), frames: seen.length }
  }, mark)
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
 * **切到某个空间**(K2 之前这道门按 ⌘1 / ⌘2)。
 *
 * ── 为什么不再按键 ──────────────────────────────────────────────────────
 * 09-12 用户裁定 2 推翻了 08-31 那条:`workspace.slot:*` **出厂不绑键**
 * (⌘1–9 归焦点叶的第 n 格标签)。所以 ⌘1 从今天起既不是切空间的键,也不能拿来
 * 当切空间的手段 —— 它此刻做的事取决于焦点在不在一片叶上,那是一个**不确定**
 * 的落点,而门要的是确定。
 *
 * 换成产品自己的那条真路:点切换器上那一格(`workspace-switch-<id>`);它不在屏上
 * 就先把那块瓦召唤出来再点 —— 与第 8 步开头那两行逐字同一手(那一手本来就在,
 * 这里只是把它抽成一只函数,六个调用点共用)。
 */
/**
 * **按序号直达键换空间**(⌘⌥n;这一趟由门自己绑上,判词在 `SLOT_KEYMAP_SEED`)。
 *
 * ⑫ 与 ⑬ 那两段**必须**走它而不是 `switchSpace`:切换器不在屏上时 `switchSpace`
 * 会先把「工作区」那块瓦开出来,而那块瓦是 `level: 'app'`(**随人走**)—— 开在 B
 * 里再切回 A,它就被携带进 A 的树里,于是 ⑫ 最后那句「切回 A 它也不在」当场红。
 * 那不是产品回归,是门自己把被测的那格状态改了(「验证不改状态」的同一族坑)。
 */
async function switchSpaceByKey(page, slot) {
  await pressCombo(page, String(slot), { meta: true, alt: true })
  await delay(250)
}

async function switchSpace(page, spaceId) {
  await clickSelector(page, `[data-testid="workspace-switch-${spaceId}"]`).catch(async () => {
    await openPanel(page, 'workspace', '[data-testid^="workspace-switch-"]')
    await clickSelector(page, `[data-testid="workspace-switch-${spaceId}"]`)
  })
  await delay(200)
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

/** 落盘那份拼贴台档案(`onething.workbench`)。与 `readStagePersist` 同一体例。 */
function readWorkbenchPersist(page) {
  return page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem('onething.workbench') || '{}')
    } catch {
      return {}
    }
  })
}

/**
 * 某个空间那一格账里,这个 refId 坐在哪个区域(不在任何一棵树上 = null)。
 *
 * 读的是**盘上那份账**而不是屏幕:携带这件事的事实就落在 `byWorkspace[空间].regions`
 * 里,而屏幕只画当前空间那一份 —— 「它在 B 里也在右架子上」这句话要两个空间各读一次。
 */
function regionOfRefIn(persisted, spaceId, refId) {
  const regions = persisted?.state?.byWorkspace?.[spaceId]?.regions
  if (!regions) return null
  const walk = node => {
    if (!node) return false
    if (node.kind === 'leaf') return (node.tabs || []).some(t => `${t.kind}:${t.key}` === refId)
    return walk(node.a) || walk(node.b)
  }
  for (const [region, tree] of Object.entries(regions)) if (walk(tree)) return region
  return null
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

/**
 * 某个空间那一格账里**每一片叶**的 `{region, id, active, tabs}`(K2 的标签族要它)。
 *
 * 读的还是**盘上那份账**(与 `regionOfRefIn` 逐字同一手):一格标签坐在第几格、
 * 哪一格是活动的,这两件事本来就落在树节点上(`PaneLeafNode.tabs` / `.active`),
 * 所以不必给产品加任何探针 —— 「按 ⌘⇧] 之后活动格换了没有」量的是同一份真东西。
 */
function leavesOfPersist(persisted, spaceId) {
  const regions = persisted?.state?.byWorkspace?.[spaceId]?.regions
  if (!regions) return []
  const out = []
  const walk = (node, region) => {
    if (!node) return
    if (node.kind === 'leaf') {
      out.push({
        region,
        id: node.id,
        active: node.active ?? 0,
        tabs: (node.tabs || []).map(t => `${t.kind}:${t.key}`),
      })
      return
    }
    walk(node.a, region)
    walk(node.b, region)
  }
  for (const [region, tree] of Object.entries(regions)) walk(tree, region)
  return out
}

/** 装着这个 refId(或这一种 `kind:`)的那片叶。没有 = null。 */
function leafHolding(leaves, needle) {
  return leaves.find(leaf => leaf.tabs.some(t => (needle.endsWith(':') ? t.startsWith(needle) : t === needle))) ?? null
}

/**
 * **把键盘焦点放进这片叶**(K2 的标签族全是叶响应者 —— 叶不在活动路径上,那几个
 * 键就该穿过去,所以每一段先把这一格前提摆好)。
 *
 * 落焦口用的是叶根那个元素(它带着 `FocusScope` 的 `scopeProps`,`tabIndex={-1}`
 * 正是为了「焦点能被送到根上」而存在),判据是**产品自己那条 `focusin` 同步路**
 * —— 门这一句 `.focus()` 只是把手放上去,「活动路径变了没有」由产品的树回答,
 * 而这一函数读回 `window.__focus.dump()` 当场核一遍。
 *
 * 为什么不点 tab:点一格会话标签走的是 `focusInto: 'composer'`(切一格会话 = 要
 * 打字),而 composer 挂在 `.center` 上、**不在这片叶里** —— 那时叶不在活动路径
 * 上,⌘T 一族确实不该响(与今天 ⌘W 在输入框里不关标签是同一格既存行为)。
 */
async function tryFocusLeaf(page, leafId) {
  return page.evaluate(id => {
    const el = document.querySelector(`[data-pane-leaf="${id}"]`)
    if (!(el instanceof HTMLElement)) return 'no-element'
    el.focus()
    const d = window.__focus?.dump?.()
    if (!d) return 'no-probe'
    const onPath = d.path
      .map(instanceId => d.nodes.find(n => n.instanceId === instanceId))
      .some(n => n?.scope === 'leaf' && n?.owner === id)
    return onPath ? 'ok' : 'off-path'
  }, leafId)
}

/** 同上,但**进不去就红** —— 核心那几段的前提不许静默降级。 */
async function focusLeaf(page, leafId) {
  const ok = await tryFocusLeaf(page, leafId)
  assert(ok === 'ok', `⑬ 前提:焦点进了叶 ${leafId}(读回 ${ok})`)
}

/** 这片叶此刻的样子(按 id 现读一次盘)。 */
async function leafNow(page, spaceId, leafId) {
  const leaf = leavesOfPersist(await readWorkbenchPersist(page), spaceId).find(l => l.id === leafId)
  if (!leaf) throw new Error(`盘上找不到叶 ${leafId}`)
  return leaf
}

/** 等这片叶变成想要的样子(落盘是 300ms 节流的,所以是等不是读一次)。 */
async function waitLeaf(page, spaceId, leafId, label, predicate) {
  let seen = null
  await waitFor(label, async () => {
    seen = await leafNow(page, spaceId, leafId)
    return predicate(seen)
  }, 12_000)
  return seen
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

    console.log('\n[1/13] 在磁盘上种出两个空间各自的工作目录')
    for (const [key, dir] of Object.entries(dirs)) {
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, `${key}-only.txt`), 'gate\n')
    }

    console.log('\n[2/13] 起一台 core,建第二个空间 + 两边各自的会话 / 设置 / 凭证')
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

    console.log('\n[3/13] 拉起应用(默认空间),会话列表只该有默认空间那两条')
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
    /*
     * 键位种子 + 一次 reload(persist 在 store 建起来那一刻读一次 localStorage,
     * 所以非 reload 不可)。判词整段在 `SLOT_KEYMAP_SEED` 上。
     */
    await page.evaluate(seed => localStorage.setItem('onething.keymap', JSON.stringify(seed)), SLOT_KEYMAP_SEED)
    await page.reload()
    await waitFor('reload 之后渲染层再完成一次 RPC 往返', async () => {
      const value = await page.evaluate(() => window.__d0 ?? null)
      return value && value.rpcOk ? value : undefined
    })
    const slotBound = await page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem('onething.keymap') || '{}')?.state?.overrides?.['workspace.slot:1'] ?? null
      } catch {
        return null
      }
    })
    assert(Boolean(slotBound), '前提:序号直达那一对键这一趟绑上了(出厂不绑 —— K2 裁定 2)')

    // ⑤ 的量尺,装在窗口起来之后、任何一次切换之前(`buffered: true`,装早了也不亏)。
    await installFrameProbe(page)

    await openPanel(page, 'sessions', '[data-session-id]')
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

    console.log('\n[4/13] 切到第二个空间:面板开合也是家具;两边都开着时零重挂 + 一帧就位')
    /*
     * 切换走 **⌘⌥2**(工作区序号直达;K2 起它出厂不绑,这一趟由门自己绑上 ——
     * 判词整段在 `SLOT_KEYMAP_SEED` 上),页面内 DOM 派发 —— 不动真光标、
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
        new KeyboardEvent('keydown', { key: '2', metaKey: true, altKey: true, bubbles: true, cancelable: true }),
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
    await openPanel(page, 'sessions', '[data-session-id]')
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
     * 两个空间现在都开着会话面。来回切一次,量 ⑤ 要的那三件:
     *  · **一帧就位** —— 切换是纯投影(账本重投影 + 家具摊开),不发一次请求;
     *  · **面两头都在场** —— 切之前那格开着,切过去那格也画出来了;
     *  · **这一拍不卡** —— 最长帧在第五轴「来回切」的预算内。
     *
     * 抓的是滚动容器而不是某张卡的父节点:卡会换、组会换(两个空间的会话落在
     * 不同项目下,分节本来就该重画)。第一版抓行的 `.parentElement`(= 分节的
     * section)红过一次 —— 那是量错了东西。
     *
     * **这里从前写的是「同一个 DOM 节点」,09-12 作废**:W4 之后两个空间各是一棵树
     * 上的一片叶,重挂是设计。完整判词在文件头「⑤ 的第三次口径更正」。
     */
    const paneBefore = await page.evaluate(() =>
      Boolean(document.querySelector('[data-testid="expose-overview-scroll"]')),
    )
    const frameMarkBefore = await frameMark(page)
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '1', metaKey: true, altKey: true, bubbles: true, cancelable: true }),
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
    const paneAfter = await page.evaluate(() =>
      Boolean(document.querySelector('[data-testid="expose-overview-scroll"]')),
    )
    const switchFrames = await frameHarvest(page, frameMarkBefore)
    console.log(
      `  · 换空间这一拍:面在场 前=${paneBefore} 后=${paneAfter};`
      + `最长帧=${switchFrames.known ? `${switchFrames.longest}ms(≥50ms 的帧 ${switchFrames.frames} 个)` : '探针没装上'}`,
    )
    assert(
      paneBefore && paneAfter,
      '⑤ 切换**前后**那块面都在场(面没被掀掉;W4 之后两个空间各一片叶,重挂是设计 —— 见文件头第三次口径更正)',
    )
    if (switchFrames.known) {
      assert(
        switchFrames.longest <= budgetOf('switchLongestFrameMs'),
        `⑤ 换空间这一拍最长帧 ${switchFrames.longest}ms ≤ ${budgetOf('switchLongestFrameMs')}ms`
        + `${laneNote('switchLongestFrameMs')} —— 重挂合法不等于重挂可以慢`,
      )
    } else {
      skip('⑤ 最长帧:`long-animation-frame` 观察器没装上(这一版内核不给),这一格没量到')
    }

    // 回到第二个空间,后面几步都在它里面做。
    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '2', metaKey: true, altKey: true, bubbles: true, cancelable: true }),
      )
    })
    await delay(120)
    await page.screenshot({ path: path.join(shotDir, 'workspace-switched.png') })

    console.log('\n[5/13] 进这个空间的会话,文件面的根跟着换')
    /*
     * 文件根**不是**按空间取的,它按**活跃会话的工作目录**取
     * (`files-source.useSessionCwd`)—— 而会话跟着空间走,所以根是被带过来的。
     * 这一条要证的正是那条传导链真的通:两个空间的会话落在两个不同的目录下,
     * 切过去再进会话,`data-root` 必须是第二个空间那个目录。
     *
     * 顺带证了另一半:切换那一刻旧会话被 `onSessionsRemoved` 从形态机上摘掉
     * (它不在新世界的列表里),所以这里点开的一定是新空间那条。
     */
    await clickSelector(page, '[data-session-id]')
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

    console.log('\n[6/13] 在第二个空间里从界面上建一条会话,回 core 侧核归属')
    const before = new Set((await rpc(record, 'sessions', 'listMeta', {})).sessions.map(s => s.id))
    // 上一步开了文件面,会话面让位给了它 —— 先把会话面开回来,那颗「+」才在 DOM 里。
    /* 09-04 方向 A:组头那颗 `+` 随项目组退役,「新会话」搬到工具栏。 */
    await openPanel(page, 'sessions', '[data-testid="expose-new-session"]')
    await clickSelector(page, '[data-testid="expose-new-session"]')
    const fresh = await waitFor('core 侧看到那条新会话', async () => {
      const listed = await rpc(record, 'sessions', 'listMeta', {})
      return listed.sessions.find(s => !before.has(s.id))
    })
    console.log('  · 新会话:', JSON.stringify({ id: fresh.id, workspaceId: fresh.workspaceId }))
    assert(
      fresh.workspaceId === workId,
      `② 新会话落在第二个空间上(workspaceId=${fresh.workspaceId})—— 这一格是壳与引擎唯一的接缝`,
    )

    console.log('\n[7/13] 模型服务面:provider 设置与凭证池跟着空间走')
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


    console.log('\n[8/13] 四条架子的快捷键:⌘⌥←/→/↓/↑ 各开各收')
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

    console.log('\n[9/13] 家具按空间隔离:切过去是出厂,切回来原样')
    const furnishedInDefault = collapsedOf(await readStagePersist(page), DEFAULT_SPACE_ID)
    console.log('  · 默认空间此刻的四条架子:', JSON.stringify(furnishedInDefault))
    assert(
      furnishedInDefault.left && furnishedInDefault.bottom && furnishedInDefault.top && !furnishedInDefault.right,
      '⑧ 默认空间里摆好了一套可辨认的家具(左/下/上收起,右展开)',
    )

    await switchSpace(page, workId)
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

    await switchSpace(page, DEFAULT_SPACE_ID)
    assert(
      JSON.stringify(collapsedOf(await readStagePersist(page), DEFAULT_SPACE_ID)) ===
        JSON.stringify(furnishedInDefault),
      '⑧ 切回来 = 当初那一套,逐格相同',
    )
    await page.screenshot({ path: path.join(shotDir, 'workspace-furniture.png') })

    console.log('\n[10/13] 空间自己配的 provider 不被全局盖掉(报障 ① 的另一半)')
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
    await switchSpace(page, workId)
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

    console.log('\n[11/13] 建一个工作区:建完看得见(报障 ②)')
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

    console.log('\n[12/13] 全局瓦携带:开着的「工作区」浮窗跟着人走(S1,正本 docs/dock-scope-2026-09.md §2)')
    /*
     * 用户原话:「切工作区时,『工作区』这块瓦该在哪一段(浮窗 / 架子 / 中央)就还在
     * 哪一段,两个工作区里它不能一个在这一个在那」。这一屏证两句话,而且**两句缺一
     * 不可** —— 只证第一句的话,「换空间时把 app 级的格原样端过去、但进场那棵树上
     * 那格旧影一个字不剥」也是绿的,而那种实现下「在 B 关掉、切回 A 它又冒出来」:
     *
     *  ① 在 A 把它开成一扇浮窗 → 切到 B:**同一个区域、同一个矩形**;
     *  ② 在 B 把它关回 Dock → 切回 A:**它不在任何一棵树上**(旧影被剥了)。
     *
     * 落点为什么用「先钉记忆再点瓦」而不是走右键菜单:菜单里那几行「打开方式」身上
     * 没有 testid,而这一步要的是一个**确定的落点**,不是「菜单点得开」这件事本身
     * (那是 gate:dock 的地盘)。位置记忆是产品自己的真路 —— 用户亲手浮过一次之后
     * 盘上留下的就是这一格,所以这不是绕开产品,是把那一次手势的**结果**直接摆好。
     */
    await switchSpaceByKey(page, 1)
    await page.evaluate(spaceId => {
      const raw = JSON.parse(localStorage.getItem('onething.stage') || '{}')
      const ledger = raw?.state?.byWorkspace ?? {}
      const slot = ledger[spaceId] ?? {}
      ledger[spaceId] = { ...slot, memory: { ...(slot.memory ?? {}), workspace: { kind: 'float' } } }
      raw.state = { ...(raw.state ?? {}), byWorkspace: ledger }
      localStorage.setItem('onething.stage', JSON.stringify(raw))
    }, DEFAULT_SPACE_ID)
    await page.reload()
    await waitFor('Dock 回来了', async () =>
      page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-workspace"]'))))

    await openPanel(page, 'workspace', '[data-testid^="workspace-switch-"]')
    await delay(250)
    const seatInA = regionOfRefIn(await readWorkbenchPersist(page), DEFAULT_SPACE_ID, 'panel:workspace')
    const rectInA = (await readStagePersist(page))?.state?.byWorkspace?.[DEFAULT_SPACE_ID]?.floats?.workspace
    console.log('  · 在 A:', seatInA, JSON.stringify(rectInA))
    assert(
      typeof seatInA === 'string' && seatInA.startsWith('float:'),
      `⑫ 前提:它在 A 里开着,而且是一扇浮窗(读到 ${seatInA})`,
    )
    assert(Boolean(rectInA), '⑫ 前提:那扇窗有一份矩形')

    await switchSpaceByKey(page, 2)
    await delay(300)
    const seatInB = regionOfRefIn(await readWorkbenchPersist(page), workId, 'panel:workspace')
    const rectInB = (await readStagePersist(page))?.state?.byWorkspace?.[workId]?.floats?.workspace
    console.log('  · 切到 B:', seatInB, JSON.stringify(rectInB))
    assert(seatInB === seatInA, `⑫ 切过去**还在同一段**(${seatInA} → ${seatInB})`)
    assert(
      JSON.stringify(rectInB) === JSON.stringify(rectInA),
      '⑫ **连 rect 一起搬** —— 同一个角、同样大小',
    )
    await page.screenshot({ path: path.join(shotDir, 'workspace-carry-in-b.png') })

    /*
     * 在 B 关掉它。**这里从前写的是「瓦是开关:再点一次 = 收回 Dock」,09-12 作废** ——
     * 与 ⑤ 同一类的口径过期,只是它埋在一句*前提*里,而前提在 ⑤ 红着的那段日子里
     * 从来没被跑到过(assert 抛,这一步够不着),所以它是被 ⑤ 的红盖住的第二处旧账。
     *
     * 点瓦今天走的是 `stage/open-item.ts` 的**召唤四态**(W7-p 裁定 6:点瓦与
     * `toggle:<面>` 快捷键从此逐字相同):没开就开 / 看不见就露出来 /
     * **看得见没聚焦就只聚焦** / 焦点已在里面才收起来。切过来那一下焦点并不在这扇
     * 浮窗里(实测 `document.activeElement` 在窗外),所以第一下点击换来的是「送焦点」,
     * 第二下才是「收回 Dock」—— 真机逐次读数:一次 `float:workspace` / 两次 `null` /
     * 三次 `float:workspace`(又开了)。**产品按合同在跑**,是这道门在用四态机器之前
     * 的两态词汇说话。
     *
     * 所以这一步改成**照四态开到目的地**:点到它真的不在树上为止(封顶 3 下 ——
     * 四态里最远的一条路是「露出来 → 聚焦 → 收起」)。它仍然是一句**前提**:
     * 关不掉当场红,而 ⑫ 要证的那句(切回 A 那格旧影被剥掉)一个字没松。
     */
    await closeStageItem(page, 'workspace', async () =>
      regionOfRefIn(await readWorkbenchPersist(page), workId, 'panel:workspace') !== null,
    )
    assert(
      regionOfRefIn(await readWorkbenchPersist(page), workId, 'panel:workspace') === null,
      '⑫ 前提:在 B 里它确实被关掉了(照召唤四态点到它真的不在树上 —— 判词见上)',
    )

    await switchSpaceByKey(page, 1)
    await delay(300)
    const backInA = regionOfRefIn(await readWorkbenchPersist(page), DEFAULT_SPACE_ID, 'panel:workspace')
    console.log('  · 切回 A:', backInA)
    assert(
      backInA === null,
      '⑫ **在 B 关掉、切回 A 它也不在** —— 进场那棵树上那格旧影被剥掉了(反证:拆掉 `stripByLevel` 这一条当场红)',
    )
    await page.screenshot({ path: path.join(shotDir, 'workspace-carry-closed.png') })

    console.log('\n[13/13] 标签族:⌘T / ⌘N 跟着焦点走,⌘⇧] 环绕,⌘1 / ⌘9,⌘W + ⌘⇧T(K2)')
    /*
     * ── 报障本身就在这一段里 ─────────────────────────────────────────────
     * 用户原话:「焦点在浏览器里按 ⌘T,该开的是一格新浏览器标签,不是一条新会话」。
     * K2 的裁定是**两个「新」键都跟着焦点走**(⌘T「这一排里再来一格同类」、
     * ⌘N「新建这一种内容」),没有应用层兜底。所以这一屏逐条量的是「同一个键在
     * 不同内容里做不同的事」,而不是「这个键响不响」。
     *
     * 键怎么送:**页面内 DOM 派发**(`pressCombo` → `window.dispatchEvent`),
     * 与本门其余几段逐字同一条纪律 —— 不动真光标、不抢前台焦点。它到得了产品那
     * 唯一的派发器(window 捕获相位),而**焦点归属由 `focusTree` 说**,不由操作
     * 系统那一侧的窗口焦点说;所以这几段的前提是 `focusLeaf`(判词在它上头)。
     *
     * 读数口是**盘上那份拼贴台账**(`leavesOfPersist`):一格标签坐第几格、哪一格
     * 是活动的,本来就落在树节点上。零新增探针。
     */
    await switchSpaceByKey(page, 1)
    const leavesA = leavesOfPersist(await readWorkbenchPersist(page), DEFAULT_SPACE_ID)
    const sessionLeaf = leafHolding(leavesA, 'session:')
    assert(Boolean(sessionLeaf), '⑬ 前提:默认空间里有一片会话叶(出厂那一片)')
    const sessionLeafId = sessionLeaf.id
    console.log('  · 会话叶:', sessionLeafId, JSON.stringify(sessionLeaf.tabs), 'active', sessionLeaf.active)

    /* ⑬a 会话叶 ⌘T:紧挨着当前那一格开出一格**新会话**标签。 */
    await focusLeaf(page, sessionLeafId)
    const beforeNew = await leafNow(page, DEFAULT_SPACE_ID, sessionLeafId)
    await pressCombo(page, 't', { meta: true })
    const afterNew = await waitLeaf(
      page,
      DEFAULT_SPACE_ID,
      sessionLeafId,
      '⌘T 在会话叶上开出一格',
      leaf => leaf.tabs.length === beforeNew.tabs.length + 1,
    )
    console.log('  · ⑬a ⌘T 之后:', JSON.stringify(afterNew.tabs), 'active', afterNew.active)
    const bornAt = beforeNew.active + 1
    assert(
      afterNew.tabs[bornAt]?.startsWith('session:'),
      `⑬a 会话叶 ⌘T 开出的是一格**会话**标签,而且就在当前那一格旁边(第 ${bornAt} 格读到 ${afterNew.tabs[bornAt]})`,
    )
    assert(
      afterNew.tabs[bornAt] !== beforeNew.tabs[beforeNew.active],
      '⑬a 它是**新**那一条,不是把老那一格再摆一遍',
    )
    assert(afterNew.active === bornAt, '⑬a 新那一格当场是活动格(开什么就看什么)')

    /* ⑬b ⌘⇧] 环绕:最后一格的下一格是第一格(浏览器惯例)。 */
    await focusLeaf(page, sessionLeafId)
    const count = afterNew.tabs.length
    await pressCombo(page, ']', { meta: true, shift: true })
    const wrapped = await waitLeaf(
      page,
      DEFAULT_SPACE_ID,
      sessionLeafId,
      '⌘⇧] 从最后一格绕回第一格',
      leaf => leaf.active === (count - 1 + 1) % count,
    )
    console.log('  · ⑬b ⌘⇧] 之后 active:', wrapped.active, `(共 ${count} 格)`)
    assert(wrapped.active === 0, '⑬b **环绕**:站在最后一格上按 ⌘⇧] 回到第一格')

    /* ⑬c ⌘1 / ⌘9:第 n 格,而 9 是「最后一格」(不管一共几格)。 */
    await focusLeaf(page, sessionLeafId)
    await pressCombo(page, '9', { meta: true })
    const last = await waitLeaf(page, DEFAULT_SPACE_ID, sessionLeafId, '⌘9 跳到最后一格', leaf => leaf.active === count - 1)
    console.log('  · ⑬c ⌘9 之后 active:', last.active)
    await focusLeaf(page, sessionLeafId)
    await pressCombo(page, '1', { meta: true })
    const first = await waitLeaf(page, DEFAULT_SPACE_ID, sessionLeafId, '⌘1 跳到第一格', leaf => leaf.active === 0)
    assert(first.active === 0 && last.active === count - 1, '⑬c ⌘1 = 第一格、⌘9 = 最后一格')
    /*
     * **⌘1 不再切工作区**(09-12 裁定 2,用户原话「非常讨厌这个设计」)。这一句
     * 与上面那一句是同一下按键的两面:它跳了标签,而且**没有**换世界。
     */
    const spaceAfter = await page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem('onething.workspace') || '{}')?.state?.currentId ?? null
      } catch {
        return null
      }
    })
    assert(
      spaceAfter === null || spaceAfter === DEFAULT_SPACE_ID,
      `⑬c ⌘1 **不再切工作区**(还在 ${spaceAfter ?? '(账里没记)'})`,
    )

    /* ⑬d ⌘W 关掉、⌘⇧T 拿回来,而且回到原来那一格。 */
    await focusLeaf(page, sessionLeafId)
    await pressCombo(page, ']', { meta: true, shift: true })
    await waitLeaf(page, DEFAULT_SPACE_ID, sessionLeafId, '站到第二格上', leaf => leaf.active === 1)
    const doomed = (await leafNow(page, DEFAULT_SPACE_ID, sessionLeafId)).tabs[1]
    await focusLeaf(page, sessionLeafId)
    await pressCombo(page, 'w', { meta: true })
    await waitLeaf(page, DEFAULT_SPACE_ID, sessionLeafId, '⌘W 关掉那一格', leaf => leaf.tabs.length === count - 1)
    await focusLeaf(page, sessionLeafId)
    await pressCombo(page, 't', { meta: true, shift: true })
    const back = await waitLeaf(
      page,
      DEFAULT_SPACE_ID,
      sessionLeafId,
      '⌘⇧T 把它拿回来',
      leaf => leaf.tabs.length === count,
    )
    console.log('  · ⑬d ⌘W → ⌘⇧T:', doomed, '→', JSON.stringify(back.tabs))
    assert(back.tabs[1] === doomed, `⑬d ⌘⇧T 拿回来的是**那一格**、而且回到原来第 1 格(读到 ${back.tabs[1]})`)

    /*
     * ⑬e **没自述 `spawn` 的那一种,⌘T 是个哑键**(键穿过去,标签数一格不变)。
     *
     * 样本取的是**面板**那一种(这道门手上现成有一块:工作区那块瓦),而派工单
     * 点名的是查看器 —— 两者在判据上是同一格:`ContentKind.spawn` 缺席。换样本
     * 的理由是「这道门开不出一份文件」(那是 `gate:files` 的地盘,在这里现造一条
     * 开文件的路等于把两道门的活揉在一起);查看器那一格由单测
     * `content/__tests__/kind-spawn.test.ts` 的「没自述 `spawn` 的种类」一节钉。
     */
    await openPanel(page, 'workspace', '[data-testid^="workspace-switch-"]')
    await delay(250)
    const panelLeaf = leafHolding(
      leavesOfPersist(await readWorkbenchPersist(page), DEFAULT_SPACE_ID),
      'panel:workspace',
    )
    if (!panelLeaf) {
      skip('⑬e 工作区那块瓦此刻不在树上,哑键那一档由单测钉(`kind-spawn.test.ts`)')
    } else if ((await tryFocusLeaf(page, panelLeaf.id)) !== 'ok') {
      skip('⑬e 焦点进不去那片面板叶(它此刻 inert),哑键那一档由单测钉')
    } else {
      const beforeDumb = await leafNow(page, DEFAULT_SPACE_ID, panelLeaf.id)
      await pressCombo(page, 't', { meta: true })
      await delay(700)
      const afterDumb = await leafNow(page, DEFAULT_SPACE_ID, panelLeaf.id)
      console.log('  · ⑬e 面板叶 ⌘T:', JSON.stringify(beforeDumb.tabs), '→', JSON.stringify(afterDumb.tabs))
      assert(
        afterDumb.tabs.length === beforeDumb.tabs.length,
        '⑬e 没自述 `spawn` 的那一种 ⌘T **不响**(标签数一格没变,键穿过去)',
      )
    }

    /* ⑬f / ⑬g 浏览器叶:⌘T 开浏览器标签,⌘N **也是浏览器标签**(报障那一句)。 */
    let browserWhy = ''
    await clickSelector(page, '[data-testid="dock-tile-browser"]').catch(e => {
      browserWhy = `点不到那块瓦:${e.message}`
    })
    const browserLeaf = await (async () => {
      let found = null
      await waitFor('浏览器叶出现在树上', async () => {
        found = leafHolding(
          leavesOfPersist(await readWorkbenchPersist(page), DEFAULT_SPACE_ID),
          'browser:',
        )
        return Boolean(found)
      }, 20_000).catch(e => {
        browserWhy = browserWhy || e.message
      })
      return found
    })()
    if (!browserLeaf) {
      /*
       * **说清为什么没量到**(不许一句「开不出来」了事):列出账上那几格 tab、
       * 树上那几片叶、以及 Dock 上有没有那块瓦 —— 三样合起来就分得开「瓦不在」
       * 「后端拒」「摆了但账没落」三种。
       */
      const tabsSeen = await rpc(record, 'resources', 'read', { ref: 'browser:@all', name: 'tabs' }).catch(e => ({ error: e.message }))
      const tileSeen = await page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-browser"]')))
      console.log('  · ⑬f/⑬g 现场:瓦在场 =', tileSeen, '/ 账上 tabs =', JSON.stringify(tabsSeen?.value ?? tabsSeen), '/ 树上叶 =', JSON.stringify(leavesOfPersist(await readWorkbenchPersist(page), DEFAULT_SPACE_ID).map(l => l.tabs)))
      /*
       * **真因在上面那行现场读数里**(2026-09-12 实测):这道门起的 core 是
       * **独立那台 server**,壳是 attach 上去的,所以 `installBrowserHost()` 与
       * 终端宿主都没在那个进程里跑 —— `resources read browser:@all` 原话答的是
       * `No resource is registered for scheme: browser`。那**不是产品缺陷,是这
       * 道门的架构**;浏览器那两段的家因此在 `gate:browser` ㉒(它自己装配 core),
       * 终端那一段在 `gate:terminal` ⑪。这一句是带现场读数的 skip,不是假绿。
       */
      skip(`⑬f/⑬g 这道门的壳 attach 在独立 server core 上,进程里没有 browser 宿主(${browserWhy || '等不到那片叶'})—— 那两段在 \`gate:browser\` ㉒`)
    } else if ((await tryFocusLeaf(page, browserLeaf.id)) !== 'ok') {
      skip('⑬f/⑬g 焦点进不去那片浏览器叶(它此刻 inert / 还没铺根),这两段由 `gate:browser` 的 ㉒ 接')
    } else {
      const b0 = await leafNow(page, DEFAULT_SPACE_ID, browserLeaf.id)
      await pressCombo(page, 't', { meta: true })
      const b1 = await waitLeaf(
        page,
        DEFAULT_SPACE_ID,
        browserLeaf.id,
        '⌘T 在浏览器叶上开出一格',
        leaf => leaf.tabs.length === b0.tabs.length + 1,
      )
      const bornBrowserAt = b0.active + 1
      console.log('  · ⑬f ⌘T 之后:', JSON.stringify(b1.tabs))
      assert(
        b1.tabs[bornBrowserAt]?.startsWith('browser:'),
        `⑬f 浏览器叶 ⌘T 开出的是**一格浏览器标签**,而且就在旁边(第 ${bornBrowserAt} 格读到 ${b1.tabs[bornBrowserAt]})`,
      )
      await focusLeaf(page, browserLeaf.id)
      const b1Now = await leafNow(page, DEFAULT_SPACE_ID, browserLeaf.id)
      await pressCombo(page, 'n', { meta: true })
      const b2 = await waitLeaf(
        page,
        DEFAULT_SPACE_ID,
        browserLeaf.id,
        '⌘N 在浏览器叶上开出一格',
        leaf => leaf.tabs.length === b1Now.tabs.length + 1,
      )
      const bornByN = b1Now.active + 1
      console.log('  · ⑬g ⌘N 之后:', JSON.stringify(b2.tabs))
      /*
       * **这一句就是报障**:⌘N 从前是全局的「新建会话」,于是人在浏览器里按它
       * 开出来一条会话。K2 之后它是 `content.new`(`app: false`)—— 新建**这一种**。
       * 反证:把 `content.new` 从 `LEAF_ANSWERS` 里拆掉 → 这一格读到的会是
       * 「标签数没变」(它不再兜底成新会话,所以不会变成 `session:`)。
       */
      assert(
        b2.tabs[bornByN]?.startsWith('browser:'),
        `⑬g **⌘N 在浏览器叶里开的是浏览器标签,不是会话**(报障本身;第 ${bornByN} 格读到 ${b2.tabs[bornByN]})`,
      )
      assert(
        !b2.tabs.some((t, i) => i === bornByN && t.startsWith('session:')),
        '⑬g 它一格会话都没多开',
      )
    }

    /*
     * ⑬h 终端叶 ⌘T 开出的是一格终端。
     *
     * **先把底架展开**:终端出厂落 `edge:bottom`,而第 8 步把那一条收起来了 ——
     * 收起来的架子里那片叶是 `inert`(2026-09-12「收起 ≠ 关闭」:树身保挂载,
     * 但不可交互),而一片 inert 的叶**本来就不该**接住 ⌘T(响应链问的是可交互
     * 的那一段)。所以这一句不是绕开产品,是把前提摆对。
     */
    if (collapsedOf(await readStagePersist(page), DEFAULT_SPACE_ID)?.bottom === true) {
      await pressCombo(page, 'ArrowDown', { meta: true, alt: true })
      await delay(200)
    }
    let terminalWhy = ''
    await clickSelector(page, '[data-testid="dock-tile-terminal"]').catch(e => {
      terminalWhy = `点不到那块瓦:${e.message}`
    })
    let terminalLeaf = null
    await waitFor('终端叶出现在树上', async () => {
      terminalLeaf = leafHolding(
        leavesOfPersist(await readWorkbenchPersist(page), DEFAULT_SPACE_ID),
        'terminal:',
      )
      return Boolean(terminalLeaf)
    }, 20_000).catch(e => {
      terminalWhy = terminalWhy || e.message
    })
    if (!terminalLeaf) {
      const tileSeen = await page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-terminal"]')))
      const caps = await rpc(record, 'capabilities', 'get', {}).catch(() => null)
      console.log('  · ⑬h 现场:瓦在场 =', tileSeen, '/ capabilities.terminal =', caps?.terminal ?? '(问不到)')
      // 同上:attach 上去的壳没有 terminal 宿主(`hasTerminalHost()` 为假)。
      skip(`⑬h 同上,进程里没有 terminal 宿主(${terminalWhy || '等不到那片叶'})—— 那一段在 \`gate:terminal\` ⑪`)
    } else if ((await tryFocusLeaf(page, terminalLeaf.id)) !== 'ok') {
      skip('⑬h 焦点进不去那片终端叶(它此刻 inert / 还没铺根),这一段由 `gate:terminal` 接')
    } else {
      const t0 = await leafNow(page, DEFAULT_SPACE_ID, terminalLeaf.id)
      await pressCombo(page, 't', { meta: true })
      const t1 = await waitLeaf(
        page,
        DEFAULT_SPACE_ID,
        terminalLeaf.id,
        '⌘T 在终端叶上开出一格',
        leaf => leaf.tabs.length === t0.tabs.length + 1,
      )
      const bornTermAt = t0.active + 1
      console.log('  · ⑬h ⌘T 之后:', JSON.stringify(t1.tabs))
      assert(
        t1.tabs[bornTermAt]?.startsWith('terminal:'),
        `⑬h 终端叶 ⌘T 开出的是**一格终端**(第 ${bornTermAt} 格读到 ${t1.tabs[bornTermAt]})`,
      )
    }
    await page.screenshot({ path: path.join(shotDir, 'workspace-tab-family.png') })

    await app.close()
    app = undefined
    console.log(
      `\n[workspace-gate] ok —— 切换真的换世界(列表 / 归属 / provider 设置 / 凭证 / 面不掀且这一拍不卡 / 家具 / 四条架子键`
        + ` / 全局瓦携带 / 标签族 ⌘T·⌘N·⌘⇧]·⌘1·⌘9·⌘W+⌘⇧T)`
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
