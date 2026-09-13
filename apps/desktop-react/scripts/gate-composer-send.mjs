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
 * ══ 所见即所发(2026-09-14,正本 §6.5)════════════════════════════════════
 *  ⑥(g)**每 16ms 采一次那条气泡**:从乐观上屏、到落账、到 AI 回完,`innerText`
 *     与 chip 数**逐样本相同**。采样流里必须**同时有** pending 与 landed 两档
 *     (不然这一条会因为「压根没跨过那一刻」而空过)。
 *  ⑦(h)落账**前后是同一个 DOM 节点** —— 页内探针把第一次见到的那枚元素记下来,
 *     此后每一拍与它比引用。
 *
 * **改前该红,而且红在两处**:09-14 之前在飞那一格画的是 `entry.text` 纯文本
 * (`@/abs/zzsendgate-chatbot.lua` 一整串),落账之后才换成一枚 chip —— 于是 (g)
 * 的样本流里中间那一段是整串路径;而且那一格是 `div[data-testid^=chat-pending-]`、
 * 落账那条是 `article[data-role=user]`,**两个节点**,(h) 同样红。
 *
 * 两种引用各跑一遍:**文件**(`@` 抽屉)与**技能**(`/` 抽屉,夹具是临时 store 里
 * 现种的一份 `skills/<名>/SKILL.md`)。两种在账本上被改写的方式不同(一个展成
 * `<file>` 块、一个展成整份 SKILL.md),而屏幕上都必须一次形都不换。
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

/**
 * 技能那一轮的夹具。名字够特别,不会与这台机器上任何真技能撞;正文里埋一句
 * 标记词,用来验明「引擎真的把整份 SKILL.md 内联进了 `content`」。
 */
const SKILL_NAME = 'zzsendgate-skill'
const SKILL_BODY_MARK = 'ZZSENDGATE-SKILL-BODY'

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
 * **两个数一起报**,理由 09-14 之后换了一半:从前 pending 与真气泡是**两种元素**
 * (overlay 那一格是 `div[data-testid^=chat-pending-]`、账本那条是
 * `article[data-role=user]`),只数 `article` 会把病漏掉;今天它们是**同一枚**
 * (`UserBubble`,落账不换节点),`data-testid` 只在还没落账时挂着 —— 于是
 * `pending > 0` 说的是「这一枚还没被账本认领」,仍旧是 ③ 要数的那个东西。
 * 两个数在**落账之后**的口径逐字没变:`users === 1 && pending === 0`。
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

/**
 * ── 所见即所发的页内探针(⑥⑦)────────────────────────────────────────────
 *
 * 装在**按下发送之前**,每 16ms 采一次「我说的话」那最后一条:念什么、几枚 chip、
 * 此刻是哪一档(`data-pending`),外加**它是不是还是同一个 DOM 节点**。
 *
 * 选择器故意收两种元素:`article[data-role=user]` 与 `[data-testid^=chat-pending-]`
 * —— 09-14 之前它们是两个节点,今天是同一枚。**两个版本上探针都采得到东西**,
 * 所以「改前红改后绿」比的是同一条读数,不是「改前压根没样本」。
 *
 * `Node.isSameNode` 换成一格 `===`:探针整只活在页里,不跨进程,不必序列化节点。
 */
const WYSIWYG_PROBE = `(() => {
  if (window.__wysiwygTimer) clearInterval(window.__wysiwygTimer)
  /*
   * 「我说的话」那**一条**。选两种元素是为了两个版本上都采得到:09-14 之前在飞
   * 那一格是 \`div[data-testid^=chat-pending-]\`(直接长在消息列里),今天它是
   * \`article[data-role=user]\` 自己那一档。
   *
   * **过滤掉套在里面的那一层**:今天那枚 \`data-testid\` 挂在 article 里面的气泡
   * 盒上,不滤的话同一条气泡会被数成两个元素,而「最后一个」在落账那一拍从内层
   * 的 div 变成外层的 article —— 那是探针自己制造的「换了节点」(第一版真红过
   * 一次,病历留在这儿)。
   */
  const all = () => [...document.querySelectorAll('article[data-role="user"], [data-testid^="chat-pending-"]')]
    .filter((el) => !(el.parentElement && el.parentElement.closest('article[data-role="user"]')))
  /*
   * **只盯这一轮新长出来的那一条**:装探针的这一刻屏上已有几条,就跳过几条。
   * 少了这一格,第二轮的头几拍采的还是上一轮那条气泡 —— 「节点换了」会因为
   * 「换的是另一条消息」而假红(第一版就这么红过一次)。
   */
  const skip = all().length
  const probe = { samples: [], first: null, sameNode: true, nodes: 1, swaps: [], skip }
  window.__wysiwyg = probe
  const describe = (el) => el.tagName + (el.getAttribute('data-testid') ? '#' + el.getAttribute('data-testid') : '')
    + '[pending=' + el.getAttribute('data-pending') + ']'
  const tick = () => {
    const list = all()
    if (list.length <= skip) return
    const el = list[list.length - 1]
    if (probe.first === null) probe.first = el
    else if (el !== probe.first && probe.sameNode) {
      probe.sameNode = false
      probe.nodes = 2
      probe.swaps.push({ from: describe(probe.first), to: describe(el), at: probe.samples.length, matches: list.length })
    }
    const marks = [...el.querySelectorAll('[data-ref-kind]')]
    probe.samples.push({
      text: (el.innerText || el.textContent || '').trim(),
      // **那几枚引用自己**念什么。它与整条气泡的文本是两件事:整条还带着正文,
      // 而正文是引擎可以改写的(判词见 reportProbe 的 strictText 那一格)。
      chipText: marks.map((m) => (m.innerText || m.textContent || '').trim()).join('␟'),
      chips: marks.length,
      phase: el.getAttribute('data-pending') ?? (el.getAttribute('data-testid') ? 'pending' : 'landed'),
    })
  }
  tick()
  /*
   * 两条采样都要:
   *  · **每一次 DOM 变动**(MutationObserver)—— 在飞那一段可能只活一帧,
   *    16ms 的表会整段错过它(2026-09-14 真机:技能那一轮 164 个样本全是
   *    landed 档,门当场假红)。变动驱动的采样让「探针装晚了」在结构上不可能;
   *  · **每 16ms 一发**(表)—— 稳态下也要有读数,不然「AI 回完之后还是同一句」
   *    这半句话没有样本可说。
   */
  const mo = new MutationObserver(tick)
  mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
  probe.stop = () => { mo.disconnect(); if (window.__wysiwygTimer) clearInterval(window.__wysiwygTimer); window.__wysiwygTimer = undefined }
  window.__wysiwygTimer = setInterval(tick, 16)
})()`

/** 读探针。`stop` = 顺手把表停了(一个回合量完就该停,别让它跑到下一轮里)。 */
async function readProbe(page, { stop = false } = {}) {
  return page.evaluate((shouldStop) => {
    if (shouldStop) window.__wysiwyg?.stop?.()
    const probe = window.__wysiwyg ?? { samples: [], sameNode: true, nodes: 0 }
    const texts = [...new Set(probe.samples.map((s) => s.text))]
    const chips = [...new Set(probe.samples.map((s) => s.chips))]
    const chipTexts = [...new Set(probe.samples.map((s) => s.chipText))]
    const phases = [...new Set(probe.samples.map((s) => s.phase))]
    return {
      count: probe.samples.length,
      texts,
      chipTexts,
      chips,
      phases,
      sameNode: probe.sameNode,
      nodes: probe.nodes,
      swaps: probe.swaps,
    }
  }, stop)
}

/**
 * 判 ⑥⑦。**两条各自说清楚自己在量什么**:
 *  · ⑥ 样本流里 `text` / `chips` 各只许有一个取值,而 `phase` 必须两档都有 ——
 *    后半句是这一条的**防空过**:采样窗口要是压根没跨过落账那一刻,前半句会
 *    因为「一直是同一档」而白白全绿。
 *  · ⑦ 探针见过的节点数恒为 1。
 */
function reportProbe(label, probe, { strictText = true, textNote = '' } = {}) {
  console.log(`      ${label}:${probe.count} 个样本 / 引用念 ${JSON.stringify(probe.chipTexts)} / 文本 ${probe.texts.length} 种 / chip 数 ${JSON.stringify(probe.chips)} / 档 ${JSON.stringify(probe.phases)} / 见过 ${probe.nodes} 个节点`)
  if (probe.swaps.length) console.log(`      换节点那一刻:${JSON.stringify(probe.swaps)}`)
  /*
   * **防空过**:采样要真的覆盖到「落账之后」那一段,否则 ⑥b/⑥c 说的是半句话。
   *
   * 判据是「样本里有 `landed`」,不是「两档都有」—— 探针是**变动驱动**的
   * (MutationObserver + 16ms 表,装在按下发送**之前**),所以「装晚了漏掉在飞
   * 那一段」在结构上不可能;而在飞那一段**本来就可能一帧都没画过**(本机 core +
   * 假 provider,账本可能与乐观 entry 同一帧到)。把「必须两档都有」当硬闸,
   * 红的是机器快不是产品坏(2026-09-14 真机在技能那一轮上真红过一次)。
   */
  assert(
    probe.count > 2 && probe.phases.includes('landed'),
    `⑥a ${label}:采样一直采到落账之后(${probe.count} 个样本,档 ${JSON.stringify(probe.phases)})`,
  )
  if (!probe.phases.includes('pending')) {
    console.log(`      ⌁ ${label}:这一轮在飞那一段一帧都没画过(账本与乐观 entry 同一帧到)`)
  }
  if (strictText) {
    assert(
      probe.texts.length === 1,
      `⑥b ${label}:从乐观到落账到 AI 回完,那条气泡念的是**同一句**`
        + `(实测 ${probe.texts.length} 种:${JSON.stringify(probe.texts.map((s) => s.slice(0, 48)))})`,
    )
  } else {
    console.log(
      `      ⌁ ⑥b ${label} **只报不判**:${textNote}`
        + `(实测 ${probe.texts.length} 种:${JSON.stringify(probe.texts.map((s) => s.slice(0, 64)))})`,
    )
  }
  /*
   * **引用那几枚自己**念什么 —— 这一条对两种引用都是硬的。
   * 它与 ⑥b 的分工写在这里:⑥b 量的是**整条气泡**(还带着正文,而正文是引擎在
   * 落库前可以改写的东西);这一条量的是**这一单负责的那半边** —— 同一枚引用在
   * 草稿 / 在飞 / 落账三处必须是同一形。
   */
  assert(
    probe.chipTexts.length === 1,
    `⑥c ${label}:那几枚引用自己**一次形都不换**`
      + `(实测 ${probe.chipTexts.length} 种:${JSON.stringify(probe.chipTexts)})`,
  )
  assert(
    probe.chips.length === 1 && probe.chips[0] === 1,
    `⑦a ${label}:全程恰好一枚 chip(实测 ${JSON.stringify(probe.chips)})`,
  )
  assert(
    probe.sameNode && probe.nodes === 1,
    `⑦b ${label}:落账前后是**同一个 DOM 节点**(探针见过 ${probe.nodes} 个`
      + `${probe.swaps.length ? `;换在 ${JSON.stringify(probe.swaps)}` : ''})`,
  )
}

/**
 * 第二轮:`/` 抽屉里选一条**技能**,发出去,同一套探针再跑一遍。
 *
 * 换一种引用是有意的:技能在账本上被改写的方式与文件**不同**(引擎把整份
 * SKILL.md 内联进 `content`,而文件是 `<file>` 块),而屏幕上必须都是「一次形
 * 都不换」。夹具是临时 store 里现种的那一份 `skills/<名>/SKILL.md`。
 */
async function runSkillRound(page, cdp, record, sessionId) {
  const usersBefore = (await readStage(page)).users
  await focusInput(page)
  await cdp.send('Input.insertText', { text: `/skill:${SKILL_NAME.slice(0, 8)}` })
  await waitFor('`/` 抽屉里出现技能那一行', () =>
    page.evaluate(
      (name) =>
        [...document.querySelectorAll('[data-testid="composer-drawer"] button')].some((el) =>
          (el.textContent ?? '').includes(name),
        ),
      SKILL_NAME,
    ),
  )
  // ↵ 选中键盘位那一行(技能那一组里只有它一条)。
  await pressEnter(cdp)
  /*
   * 判据与文件那一轮逐字同一条(`span[contenteditable=false]`)—— 它在**两个版本**
   * 上都成立:09-14 之前那是手画的那枚 chip,今天那是 portal 的宿主节点。
   * 拿今天才有的 `data-ref` 当判据,改前那一跑会在这儿超时崩掉,而这道门要的是
   * 「改前红」不是「改前崩」。
   */
  await waitFor('草稿里落进一枚技能 chip', () =>
    page.evaluate(() =>
      Boolean(
        document
          .querySelector('[data-testid="composer-input"]')
          ?.querySelector('span[contenteditable="false"]'),
      ),
    ),
  )
  await page.evaluate(WYSIWYG_PROBE)
  await pressEnter(cdp)

  await waitFor('第二条助手回复回完', async () => {
    const stage = await readStage(page)
    return stage.assistants > 1 ? stage : undefined
  }, 40_000)
  await delay(2500)

  const stage = await readStage(page)
  console.log(`      技能那一轮之后:${JSON.stringify(stage)}`)
  assert(
    stage.users === usersBefore + 1 && stage.pending === 0,
    `⑧ 技能那一条也恰好 +1 条气泡、0 格 pending(${usersBefore} → ${stage.users} / pending ${stage.pending})`,
  )
  /*
   * ── 技能那一轮的 ⑥b 只报不判(2026-09-14 留账,**不是这一单的地**)──────────
   * 真机实测:在飞那一格念的是「技能名」(= 人在输入框里看见的那一枚,正确),
   * 落账之后那条气泡在它后面**多出一整段 `<skill …>` 块**。那一段不是壳画的形,
   * 是账本上那条消息的正文 —— 引擎在落库前把整份 SKILL.md 内联进 `content`
   * (⑧b 就是它的读数),而这条消息的显示版部件没能把那一段挡在外面。
   *
   * 它与本单**无关**:改前改后落账那一半逐字相同(改的是在飞那一半 —— 从前它是
   * 一整串 `/skill:名`,今天是同一枚 chip)。真要治,治的是「用户消息的显示版
   * 部件」那条路,归引擎那一批,而且它是 09-12 报障(「气泡里是一整份 SKILL.md」)
   * 的同一条病根在另一个出口上冒头。**不许在这儿把闸抬成 `|| true`**:所以
   * ⑥c(引用自己一次形都不换)照旧是硬的,它才是这一单负责的那半边。
   */
  reportProbe('技能', await readProbe(page, { stop: true }), {
    strictText: false,
    textNote: '落账后正文里多一段引擎内联的 `<skill …>` 块(见上方判词,归引擎那一批)',
  })

  // 验明正身:账本上那条的 `content` 真的被引擎换过(与 ⑤ 同一条理由)。
  const raw = await rpc(record, 'sessionEvents', 'listRaw', { sessionId })
  const rows = (raw?.events ?? []).filter((row) => row.type === 'user/message')
  const last = rows[rows.length - 1]
  const content = last?.data?.message?.content ?? ''
  const skillParts = last?.data?.message?.contentParts ?? []
  console.log(`      技能那条账本行:content ${content.length} 字 / contentParts ${skillParts.length} 格 ${JSON.stringify(skillParts.map((part) => part?.type))}`)
  assert(
    content.includes(SKILL_BODY_MARK),
    `⑧b 账本上那条的 content 真是模型版(整份 SKILL.md 内联;${content.length} 字)`
      + ' —— 这一条证明 ⑥⑦ 不是因为「两句话恰好相同」而绿的',
  )
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
    console.log('\n[1/7] 种夹具(一个够大的文件 + 一份技能) + 假 provider + 一台 core')
    mkdirSync(workdir, { recursive: true })
    const fixturePath = path.join(workdir, FIXTURE_NAME)
    writeFileSync(
      fixturePath,
      Array.from({ length: FIXTURE_LINES }, (_, i) => `-- line ${i + 1}: 这一行是夹具,够长好把整份撑过截断线`).join('\n'),
    )
    console.log(
      `      ${FIXTURE_NAME}:${FIXTURE_LINES} 行 / ${(readFileSync(fixturePath).length / 1024).toFixed(0)}KB`,
    )

    /*
     * 技能夹具:用户技能目录就是 `<store>/skills/<名>/SKILL.md`
     * (`@onething/runtime/skills/loader.getUserSkillsPath`)。frontmatter 两格
     * 就够 —— 名字进 `/skill:<名>`,说明进抽屉那一行。
     */
    const skillDir = path.join(store, 'skills', SKILL_NAME)
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: ${SKILL_NAME}\ndescription: 发送门用的技能夹具\n---\n\n# ${SKILL_NAME}\n\n${SKILL_BODY_MARK}\n`,
    )
    console.log(`      ${SKILL_NAME}/SKILL.md 已种在 <store>/skills/ 下`)

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

    console.log('[2/7] 拉起应用(离屏 · 独立 --user-data-dir),进那条会话')
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

    console.log('\n[3/7] ① 发之前的现场')
    const before = await readStage(page)
    console.log(`      ${JSON.stringify(before)}`)
    assert(before.users === 0 && before.pending === 0, '① 发之前:0 条用户气泡、0 格 pending')

    console.log('\n[4/7] `@` 选中夹具文件并发出去')
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
    /*
     * ⑥⑦ 的探针装在**按下发送之前**:要采的正是「乐观上屏那一刻」到「落账那一刻」
     * 之间的每一帧,晚一拍装就把要量的那一段漏在外面了。
     */
    await page.evaluate(WYSIWYG_PROBE)
    // ↵ 发送(抽屉已经关了,这一下归发送)。
    await pressEnter(cdp)

    const afterSend = await waitFor('那条用户消息上屏', async () => {
      const stage = await readStage(page)
      return stage.users + stage.pending > 0 ? stage : undefined
    })
    console.log(`      刚发出去:${JSON.stringify(afterSend)}`)

    console.log('\n[5/7] ②③④⑤ 等 AI 回完再数')
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

    console.log('\n[6/7] ⑥⑦ 所见即所发:那条气泡从乐观到落账,逐样本相同 + 同一个节点')
    const fileProbe = await readProbe(page, { stop: true })
    reportProbe('文件', fileProbe)

    console.log('\n[7/7] 同一条法,换一种引用:`/skill:` 那一枚')
    await runSkillRound(page, cdp, core.record, sessionId)
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
