#!/usr/bin/env node
/**
 * 抗挤压真机门 —— 「窄下来不许重叠」的机器化。
 *
 * 立法在 `docs/design/react-shell-squeeze-rules-2026-08.md`(四律)。这条门执的是
 * **律四**:每个组件在自己声明的最小宽度下零重叠 —— 变窄的次序是「先截断,
 * 再有序降元素」,永不重叠。
 *
 * 做法:把会话总览钉到右架子上,厚度依次拖到 240 / 300 / 360 / 420 / 560,
 * 每一档在**真机真排版**下扫一遍架子里画着东西的盒子,两两求交。任何一对相交
 * (容差 1px)= 红,并打印元素对与档位。五档全绿才算过。
 *
 * **09-04 方向 A 之后第二个场景换了内容**:项目组连同「进组之后的会话列表
 * (ListView)」一起退役了,总览现在是**一块面三档宽**(侧栏 / 顶栏选择器 /
 * 项目 chip 按容器宽有序降元素)。所以第二场景改成 `[8/11]` 的**三档宽度在场表**
 * 加 `[9/11]` 的**行几何**:一把重叠尺量不出「谁该在场谁不该」,也量不出
 * 「同一列的右缘对没对齐」—— 那两件事各有自己的判据,理由分别写在
 * `checkWidthBands` 与 `checkRowGeometry` 头上。
 * 08-30 那条「长名把同行别的件挤出容器」的判据没丢:它变成了
 * `checkWidthBands` 里那句「工具栏三件一件都不许冲出容器右缘」。
 *
 * ── 为什么不是「可见兄弟元素两两求交」 ───────────────────────────────────
 * 立项时写的是兄弟两两。真机复现之后改了口径,理由是**兄弟检测抓不到报障那一例**:
 * 组头行里溢出的是 `.groupName`,它是 `.groupToggle` 的孩子;被它压住的 `.count`
 * 是 `.groupToggle` 的兄弟。两者是「叔侄」,不是兄弟 —— 只比兄弟的话,这条门
 * 在修前是绿的,而屏幕上字压着字。
 *
 * 所以口径改成:**所有「自己画内容的盒子」两两求交,祖孙对除外**。
 * 「自己画内容」= 直接挂着非空文本节点,或者是 svg / img / canvas / input。
 * 这是兄弟检测的超集,报障那一例正好落在超出来的那部分里。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 白名单(= 预期的覆盖,律三允许的那一族)写在 `ALLOWED_OVERLAP` 里,每条都要有
 * 理由。默认**不**整类豁免绝对定位:绝对定位恰恰是「覆盖」最常见的实现方式,
 * 整类放行等于把律三的执法面挖空。
 *
 * **律二也在这条门里**(09-03 补,`[6/11]`):composer 本体行的工具件不折行、
 * 不悬在文本的竖中线上。律二说的是「结构行里的文本永不换行,只截断」——
 * 那是**排版**,静态门看不见(`squeeze-check` 只查「flex: 1 却没 min-width」),
 * 所以它必须在这里量。判据与病历写在 `checkComposerToolRow` 头上。
 *
 * 跑法:`node scripts/gate-squeeze.mjs`
 * (仓根先 `bun run server:build`,本目录先 `npm run app:build`)。
 * 可重复:每次一个全新的临时 store + 全新的 --user-data-dir,跑完删干净。
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

/** 五档厚度。240 是架子下限(SHELF_MIN_THICKNESS),560 已经在宽档里 —— 一头一尾都要量。 */
const THICKNESSES = [240, 300, 360, 420, 560]

/**
 * 种子:**名字的形状**才是这条门的被试,不是会话条数。
 *
 * 09-04 之前项目是「组头」,那三种长名量的是组头的断行;方向 A 之后同一批名字
 * 变成了侧栏那一列与行上那枚项目 chip,断行行为一个字没变(仍是同样三种
 * `word-break` 机会),所以种子照旧 —— 换的只是它们出现在屏幕上的哪一处:
 *  - 带连字符的 uuid:CSS 允许在连字符后断行 → 会**折行**(报障视频里那一例);
 *  - 不带连字符的 32 位十六进制:没有任何断行机会 → 会**整条溢出**;
 *  - 长 kebab 路径末段:连字符很多 → 折成三四行。
 * 外加一个普通短名组当对照(它在任何档位都不该红),以及一组没有工作目录的
 * (侧栏「无项目」那一档、行上没有 chip 的那一形)。
 */
const SEED_PROJECTS = [
  { dir: '3f2a9c7e-8b41-4d6a-9f02-7c1e5b8d4a63', names: ['dm 甲', 'dm 乙', 'dm 丙'] },
  { dir: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', names: ['room 甲', 'room 乙'] },
  {
    dir: 'onething-desktop-react-shell-squeeze-fixture',
    names: ['squeeze 甲', 'squeeze 乙', 'squeeze 丙'],
  },
  { dir: 'short', names: ['短组甲', '短组乙'] },
  /*
   * 最后一组没有工作目录。第三条的标题**故意很长** —— 行几何那一步的
   * 「标题只截断不溢出」判据只有在真有一条标题挤不下时才醒着:短标题
   * `scrollWidth === clientWidth`,那条断言就是在陪跑(09-04 反证跑出来的:
   * 把 `.title` 的 `overflow` 改成 visible,短标题那一版三档全绿)。
   */
  {
    dir: null,
    names: [
      '独立甲',
      '独立乙',
      '这条会话的标题故意很长很长,长到任何一档容器宽都必须靠省略号收场,而不是把时间列挤出行外',
    ],
  },
]

/**
 * 三档容器宽的被试值(设计 §1.5 的三档:≥760 / 480–760 / <480)。
 * 760 那一档取 **800** 而不是 761:阈值上骑着的那一像素量的是舍入,不是形。
 * 这三个数说的是**容器宽**(`[data-focus-scope="expose"]` 的 inline-size),
 * 不是架子厚度 —— 两者差着架子的内衬,所以下面那只 `setExposeContainerTo`
 * 是「设一次量一次修一次」,而不是直接把这三个数当厚度去拖。
 */
const CONTAINER_BANDS = [800, 640, 460]

/**
 * 量三档要多宽的窗。800 那一档的架子厚度 ≈ 800 + 内衬,而架子上限是
 * `SHELF_MAX_RATIO 0.55 × 视口宽` —— 1280 的默认窗最多只能拖到 704,够不着。
 * 所以这一步先把窗撑到 1600(与 `narrowComposerTo` 同一只手:放开 minWidth
 * 再 setSize),量完还原。
 */
const WIDE_WINDOW = { width: 1600, height: 900 }

/**
 * ── 工作目录怎么种(08-31 改:相对路径那一套已经过期)──────────────────────
 *
 * 从前这条门靠一个临时 workspaceRoot(`ONETHING_SERVER_WORKSPACE_ROOT`)+
 * **相对路径**来种:联网宿主把每条工作目录夹进 `<workspaceRoot>/<uid>/<wid>`,
 * 绝对路径会被沙箱当场拒掉。
 *
 * `d1fa07c0`(files 域 local-trust)之后不成立了:`sessions.updateWorkingDirectory`
 * 的 http 分支在**本机可信面**上改走 ipc 那条路 —— 沙箱不再夹持,于是路径被
 * 逐字当真,而这条门绑的正是回环口(本机可信)。结果是相对名 `3f2a9c7e-…`
 * 被当成相对 cwd 的真路径去解析,后端答 `Directory does not exist`,种子步整步挂掉。
 *
 * 所以现在照 gate-files 的起法:**mkdtemp 一个真临时根,组目录是它下面真实存在
 * 的子目录,递绝对路径**,退出时整根删掉。
 *
 * 项目名形状(这条门的全部测试意图)一个字都没变:屏幕上的项目名 = 路径**末段**
 * (expose/projection.projectNameOf),所以换成绝对路径之后,那四种名字形状
 * ——32 位无断点十六进制 / uuid / 长英文串 / 短名 —— 逐字照旧。
 */
const PROJECT_DIR_NAMES = SEED_PROJECTS.flatMap((g) => (g.dir ? [g.dir] : []))

/**
 * 叶檐那一步要开的几份文件(W1)。**一长一短各几个** —— 挤压量的是
 * 「tab 条会不会换行 / 右端动作组会不会被顶出去」,长名对那两件最敏感。
 */
const LEAF_TAB_FILES = [
  'a.ts',
  'b.ts',
  'engine.ts',
  'a-very-long-file-name-that-should-truncate-not-wrap.ts',
  'another-extremely-long-module-name-for-squeeze.ts',
  'z.ts',
]

/**
 * **超量档的料**(W3-b:「30 格 tab 要横滚,不许换行、不许把动作组顶出去」)。
 *
 * 名字一律 `zz-` 打头,理由是次序:文件树按名排,第一段(6 格那一档)按**行下标**
 * 开头六行 —— 这 24 份必须排在 `z.ts` 之后,那一档量的东西才一个字都不变。
 * 内容与长度都不重要,这一档量的是「条会不会换行」,不是「名字会不会截断」。
 */
const OVERFLOW_TAB_FILES = Array.from({ length: 24 }, (_, i) => `zz-${String(i + 1).padStart(2, '0')}.ts`)

/**
 * 允许的覆盖。每条 = 一对选择器片段(按 CSS 类名 / data 属性的子串匹配),
 * 命中即跳过这一对。**加一条就要写一句理由** —— 这张表是律三的例外表,
 * 不是「门太吵了就往里塞」的地方。
 */
const ALLOWED_OVERLAP = [
  /*
   * 09-04:卡片时代那一条(`SessionCard_peek` × `SessionCard_`)随卡一起退役。
   * 新的行把两颗悬停动作放进行**内部**的一格 `.actions` 里,而重叠尺本来就跳过
   * 祖孙对 —— 于是它连一条豁免都不需要。**空表是目标**:这张表是律三的例外表,
   * 不是「门太吵了就往里塞」的地方。
   */
]

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * **「完全落在条里」的容差从产品那只文件里读**(09-06 审查:同一个 ±1 不许两处
 * 各写一遍)。产地是 `src/ui/Tabs.tsx` 的 `TAB_CLIP_EPSILON_PX` —— 它是亚像素
 * 容差,不是设计尺寸,所以门与组件必须同源:那边改了这边跟着改,那边没了这里
 * 当场红(而不是拿一个过期的数字继续判)。
 */
function tabClipEpsilonPx() {
  const src = readFileSync(path.join(appRoot, 'src/ui/Tabs.tsx'), 'utf-8')
  const hit = /export const TAB_CLIP_EPSILON_PX\s*=\s*(\d+(?:\.\d+)?)/.exec(src)
  if (!hit) {
    throw new Error(
      'gate:squeeze 读不到 src/ui/Tabs.tsx 的 TAB_CLIP_EPSILON_PX —— 容差只有一个产地,改名了就把这里一起改',
    )
  }
  return Number(hit[1])
}

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
  const body = await response.json()
  if (!body || body.ok !== true) {
    throw new Error(`rpc ${domain}.${method} 失败:${JSON.stringify(body?.error ?? body)}`)
  }
  return body.data
}

/** 点一个 testid(理由同 gate-data:这条门要证的是排版,不是命中测试)。 */
async function clickTestId(page, testId) {
  const clicked = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (!el) return false
    el.click()
    return true
  }, testId)
  if (!clicked) throw new Error(`点不到:[data-testid="${testId}"] 不在 DOM 里`)
}

/**
 * 右键一块 Dock 瓦,按菜单项的文案选一种打开方式(与 gate-focus 逐字同一手)。
 * 走的是**用户真走的那条路**:显式手势自己就说得出落点,于是它同时把「记忆」
 * 写成那一档 —— 浮窗几何那一步要的正是「宽屏时存下的一格 rect」。
 */
async function openAsFromDockMenu(page, tile, labelRe) {
  const opened = await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="dock-tile-${id}"]`)
    if (!(el instanceof HTMLElement)) return false
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))
    return true
  }, tile)
  if (!opened) return false
  await delay(350)
  const picked = await page.evaluate((source) => {
    const re = new RegExp(source)
    const items = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]'))
    const hit = items.find((el) => re.test(el.textContent ?? ''))
    if (hit instanceof HTMLElement) {
      hit.click()
      return true
    }
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return false
  }, labelRe.source)
  await delay(500)
  return picked
}

/** 会话总览这块面的**容器宽** —— 三档全靠它说话(`container-name: expose` 就长在它身上)。 */
async function measureExposeContainer(page) {
  return page.evaluate(() => {
    const el = document.querySelector('[data-focus-scope="expose"]')
    return el ? el.getBoundingClientRect().width : -1
  })
}

/**
 * 把总览的**容器宽**调到目标值 —— 手仍然是拖架子厚度(生产那只手),
 * 但判据换成容器自己的宽:容器 = 厚度 − 架子内衬,而内衬会随主题 / 边距改。
 * 拿厚度当容器宽用,就是把一个会变的差额写死进门里。
 *
 * 与 `narrowComposerTo` 同一套配方:设一次 → 量一次 → 按差额修一次(线性关系,
 * 一轮就够;第二轮留给亚像素与钳制)。真实落到多少一律打印。
 */
async function setExposeContainerTo(page, want) {
  let container = await measureExposeContainer(page)
  if (container < 0) throw new Error('会话总览不在 DOM 里 —— 三档宽这一步没有被试')
  let thickness = await page.evaluate(
    () => document.querySelector('[data-shelf="right"]')?.getBoundingClientRect().width ?? -1,
  )
  for (let round = 0; round < 3 && Math.abs(container - want) > 1; round += 1) {
    thickness = Math.round(thickness + (want - container))
    await dragThicknessTo(page, thickness)
    container = await measureExposeContainer(page)
  }
  return { container, thickness }
}

/**
 * 三档宽度的**在场表**(设计 §1.5;09-04 换掉 ListView 那个场景之后的第二把尺)。
 *
 * ── 为什么这一条不能靠上面那把重叠尺 ────────────────────────────────────
 * 「有序降元素」这件事在重叠尺眼里是**隐形**的:一件被 `display: none` 掉,
 * 它连盒子都没有,自然一对相交都不会有 —— 修前修后同样零相交。而降错元素
 * (窄档还留着侧栏、宽档却把选择器也画出来)恰恰是这一档最容易犯的病:
 * 两个范围控件同时在场时,读屏软件会念出两遍同一件事。
 * 所以这一条的判据是**在场表**:每一档里谁必须在、谁必须不在,逐条列出来。
 *
 * 第二半是**工具栏不许被挤出去**(08-30 那条报障判据的继承者):三件的右缘
 * 都必须落在容器可视区内 —— 被挤出边界不在「有序降元素」的名单里,
 * 没有谁声明过搜索框可以消失。
 *
 * 第三半只在最窄那一档问:`[选择器][+]` 同排、搜索独占第二行 —— 这正是 09-04
 * 真机走查那张 460px 截图报的病(`+` 被挤到自己一行去了),病根是 `ui/Select`
 * 的根写着 `width: 100%`,`flex-basis: auto` 于是把整行宽当成了基准尺寸。
 */
async function checkWidthBands(page, band) {
  return page.evaluate((width) => {
    const root = document.querySelector('[data-focus-scope="expose"]')
    if (!root) return { error: '会话总览不在 DOM 里' }
    const toolbar = root.querySelector('[data-testid="expose-toolbar"]')
    if (!toolbar) return { error: '工具栏不在 DOM 里' }

    const shown = (el) => {
      if (!el) return false
      const st = getComputedStyle(el)
      if (st.display === 'none' || st.visibility === 'hidden') return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }
    const rail = root.querySelector('[data-testid="expose-rail"]')
    // 窄档那只项目选择器 = 工具栏里的 combobox(ui/Select 的根)。
    const select = toolbar.querySelector('[role="combobox"]')
    const search = root.querySelector('[data-expose-search]')
    const newWide = root.querySelector('[data-testid="expose-new-session"]')
    const newNarrow = root.querySelector('[data-testid="expose-new-session-narrow"]')
    /*
     * 项目 chip:行的直接子 `<span>` 恰好是 [标题, (项目), 时间] ——
     * 三个就是带 chip,两个就是没有。按结构问而不是按类名问,是因为
     * CSS Module 的类名带哈希,而这块面刻意**没有**叫 `.chip` 的词汇
     * (ui:consume 的 shared-vocab-css 那条)。
     *
     * **问全部行,不问第一行**:没有工作目录的会话本来就没有 chip,而种子里
     * 最新的那两条恰恰是「独立甲 / 独立乙」—— 拿第一行当被试,这一条在修前修后
     * 都会说「chip 不在场」(首跑就是这么假红的)。
     */
    const chip = [...root.querySelectorAll('[data-session-id][data-depth="0"]')]
      .map((row) => [...row.children].filter((el) => el.tagName === 'SPAN'))
      .filter((spans) => spans.length === 3)
      .map((spans) => spans[1])
      .find((el) => shown(el)) ?? null

    const state = {
      rail: shown(rail),
      select: shown(select),
      search: shown(search),
      newWide: shown(newWide),
      newNarrow: shown(newNarrow),
      chip: Boolean(chip),
    }

    const problems = []
    const want = (key, expected, why) => {
      if (state[key] !== expected) {
        problems.push(`${key} 应当${expected ? '在场' : '不在场'}(${why}),实际${state[key] ? '在场' : '不在场'}`)
      }
    }
    if (width > 760) {
      want('rail', true, '≥760 档:侧栏在场')
      want('select', false, '≥760 档:侧栏已经是范围控件,顶栏不再出第二个')
      want('newWide', true, '≥760 档:「新会话」是带文字的钮')
      want('newNarrow', false, '任何一刻只有一颗新会话钮在焦点序里')
      want('chip', true, '「全部」范围下项目名在场')
    } else if (width > 480) {
      want('rail', false, '480–760 档:侧栏收起')
      want('select', true, '480–760 档:顶栏出项目选择器')
      want('newWide', true, '480–760 档:「新会话」仍是带文字的钮')
      want('newNarrow', false, '任何一刻只有一颗新会话钮在焦点序里')
      want('chip', true, '480–760 档:项目 chip 还在')
    } else {
      want('rail', false, '<480 档:侧栏收起')
      want('select', true, '<480 档:顶栏出项目选择器')
      want('chip', false, '<480 档:项目 chip 降元素')
      want('newWide', false, '<480 档:「新会话」缩成图标钮')
      want('newNarrow', true, '<480 档:图标钮上场')
    }
    want('search', true, '搜索条任何一档都在场')

    // 工具栏三件一件都不许冲出容器右缘(08-30 那条报障判据的继承者)。
    const clip = root.getBoundingClientRect()
    const seen = [`容器 ${width.toFixed(0)}`]
    for (const [name, el] of [['选择器', select], ['搜索', search], ['新会话', shown(newWide) ? newWide : newNarrow]]) {
      if (!shown(el)) continue
      const r = el.getBoundingClientRect()
      seen.push(`${name} 右缘余量 ${(clip.right - r.right).toFixed(0)}`)
      if (r.right - clip.right > 1) problems.push(`${name} 右缘冲出容器 ${(r.right - clip.right).toFixed(1)}px`)
      if (clip.left - r.left > 1) problems.push(`${name} 左缘冲出容器 ${(clip.left - r.left).toFixed(1)}px`)
    }

    // 最窄那一档:第一行 = [选择器][+],第二行 = 搜索。
    if (width <= 480 && shown(select) && shown(newNarrow) && shown(search)) {
      const a = select.getBoundingClientRect()
      const b = newNarrow.getBoundingClientRect()
      const c = search.getBoundingClientRect()
      const mid = (r) => r.top + r.height / 2
      seen.push(
        `选择器 中线 ${mid(a).toFixed(0)} 右缘 ${a.right.toFixed(0)}`
        + ` / + 中线 ${mid(b).toFixed(0)} 左缘 ${b.left.toFixed(0)} / 搜索 top ${c.top.toFixed(0)}`,
      )
      /*
       * 「同一行」的判据是**竖中线**,不是 top:两件身量不同(选择器是 sm 档的
       * 输入形,图标钮是一颗方钮),而工具栏 `align-items: center` —— 它们本来
       * 就该 top 差着几像素、中线对齐。拿 top 判会把「对的」判成红(首跑差 3px)。
       */
      if (Math.abs(mid(a) - mid(b)) > 1) {
        problems.push(
          `<480 档:选择器与「新会话」不在同一行(竖中线差 ${Math.abs(mid(a) - mid(b)).toFixed(1)}px)`
          + ' —— ui/Select 的 width:100% 又把 flex-basis 撑成整行了?',
        )
      }
      // 而且次序是 [选择器][+]:`+` 在选择器右边,不是换行换到它下面去了。
      if (b.left < a.right - 1) {
        problems.push(
          `<480 档:「新会话」没有排在选择器右边(它的左缘 ${b.left.toFixed(1)} < 选择器右缘 ${a.right.toFixed(1)})`,
        )
      }
      if (c.top < a.bottom - 1) {
        problems.push(`<480 档:搜索条没有独占第二行(它的 top ${c.top.toFixed(1)} 还在选择器下缘 ${a.bottom.toFixed(1)} 之上)`)
      }
    }
    return { problems, seen, state }
  }, band)
}

/**
 * 行的几何(设计 §1.1:一行 = 固定字形列 + 弹性标题 + 右端定宽时间列)。
 *
 * 四条判据,一条都不能由重叠尺代劳:
 *  ① **标题只截断不溢出**:`scrollWidth > clientWidth` 只有配着 `overflow: hidden`
 *     才是「截断」,否则是墨溢出到别人身上(那把尺看不见墨);
 *  ② **时间列右缘逐行对齐**(±0.5px):裁决 6 那条「标题永远从同一条竖线起笔」的
 *     另一端 —— 右端也要是一条竖线,否则一列时间读起来是锯齿;
 *  ③ **字形列左缘逐行对齐**:同一条判据的左端(普通聊天留空但**占位**);
 *  ④ **树零横向溢出**:`scrollWidth ≤ clientWidth` —— 一行挤不下时该截断,
 *     不该把整棵树推出一条横向滚动条。
 *
 * 只量顶层行(`data-depth="0"`):子行按设计缩进 26px,拿它去比左缘是在量缩进。
 * 而且只量**会话行**(`[data-session-id]`):09-04 分节可折叠之后节头也是
 * `role="treeitem"`,但它的结构是 [caret][节名] —— 没有时间列、没有第二个 span。
 * 拿 `[role="treeitem"]` 取件的话,①行结构那一条会对着节头报「少了一格」,
 * ②右缘对齐会去比一个根本没有时间列的元素。所以下面顺带断言「树上确实有节头」:
 * 哪天选择器被放宽成 treeitem,这一步的样本里就会混进它们而当场红。
 */
async function checkRowGeometry(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-focus-scope="expose"]')
    const tree = root?.querySelector('[data-testid="expose-tree"]')
    if (!root || !tree) return { error: '会话总览或树容器不在 DOM 里' }
    const rows = [...tree.querySelectorAll('[data-session-id][data-depth="0"]')]
    if (rows.length < 2) return { error: `顶层行只有 ${rows.length} 条 —— 对齐要至少两行才量得出` }
    const heads = [...tree.querySelectorAll('[data-section-id]')]

    const problems = []
    const seen = []
    // 节头与会话行是树上两种项,行几何量的是后者 —— 这一条把「样本没混进节头」钉住。
    if (heads.length === 0) {
      problems.push('树上一个分节头都没有 —— 行几何量的是「行」,它必须能与节头区分开')
    }
    if (rows.some((row) => row.hasAttribute('data-section-id'))) {
      problems.push('行几何的样本里混进了分节头(选择器被放宽成 role="treeitem" 了?)')
    }
    seen.push(`${heads.length} 个分节头(不进行几何样本)`)
    const lefts = []
    const rights = []
    for (const row of rows) {
      const spans = [...row.children].filter((el) => el.tagName === 'SPAN')
      const title = spans[0]
      const time = spans[spans.length - 1]
      const glyph = row.firstElementChild
      if (!title || !time || !glyph) {
        problems.push('行的结构对不上(字形列 / 标题 span / 时间 span 少了一格)')
        continue
      }
      if (title.scrollWidth > title.clientWidth + 1) {
        const st = getComputedStyle(title)
        if (st.overflow === 'visible' && st.overflowX === 'visible') {
          problems.push(
            `标题「${(title.textContent ?? '').slice(0, 16)}」墨宽 ${title.scrollWidth}`
            + ` > 盒宽 ${title.clientWidth},而 overflow 是 visible —— 那是溢出不是截断`,
          )
        }
      }
      lefts.push(glyph.getBoundingClientRect().left)
      rights.push(time.getBoundingClientRect().right)
    }
    const spread = (xs) => Math.max(...xs) - Math.min(...xs)
    seen.push(`${rows.length} 行:字形列左缘散布 ${spread(lefts).toFixed(2)}px,时间列右缘散布 ${spread(rights).toFixed(2)}px`)
    if (spread(lefts) > 0.5) problems.push(`字形列左缘没对齐,散布 ${spread(lefts).toFixed(2)}px(标题该从同一条竖线起笔)`)
    if (spread(rights) > 0.5) problems.push(`时间列右缘没对齐,散布 ${spread(rights).toFixed(2)}px`)

    const over = tree.scrollWidth - tree.clientWidth
    seen.push(`树 scrollWidth ${tree.scrollWidth} / clientWidth ${tree.clientWidth}`)
    if (over > 1) problems.push(`树横向溢出 ${over}px —— 挤不下时该截断,不该推出横向滚动条`)
    return { problems, seen }
  })
}

/**
 * 浮窗几何的**重钳**(设计 §4;实现是 34d91682 的 `fitFloatRect` + `useViewportReclamp`)。
 *
 * 病历逐字:宽屏上开出来的浮窗存下 `x=260 w=880`,把窗缩到 1100 之后
 * `260 + 880 = 1140 > 1100`,右边缘被裁在屏幕外 —— 用户 09-03 报的
 * 「不同宽度下 Sessions 浮窗展示奇怪」。
 *
 * 所以这一步必须**先宽后窄**:在 1400 的窗上用真手势(Dock 右键 → 浮窗)开出来,
 * 让那格「宽屏的 rect」真的被存下,再 `setSize(1100, 800)` —— 只在窄窗上开一次
 * 是量不到这个病的(那时候默认 rect 本来就是按窄视口算的)。
 * 判据是 `FLOAT_MARGIN = 16`:整扇窗四边都要落在视口内缩 16px 的框里。
 */
const FLOAT_MARGIN = 16

async function checkFloatReclamp(app, page) {
  const win = await app.browserWindow(page)
  const before = await win.evaluate((w) => ({ size: w.getSize(), min: w.getMinimumSize() }))
  await win.evaluate((w) => w.setMinimumSize(320, 480))
  try {
    await win.evaluate((w) => w.setSize(1400, 860))
    await delay(500)
    const opened = await openAsFromDockMenu(page, 'sessions', /浮窗|Float/)
    if (!opened) return { error: 'Dock 菜单里没有「浮窗 / Float」那一项 —— 这一步没有被试' }
    await waitFor('浮窗里的总览就位', () =>
      page.evaluate(() =>
        Boolean(document.querySelector('[data-focus-scope="expose"]')?.closest('[role="dialog"]')),
      ),
    )
    const wide = await page.evaluate(() => {
      const el = document.querySelector('[data-focus-scope="expose"]')?.closest('[role="dialog"]')
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.left), w: Math.round(r.width), vw: window.innerWidth }
    })
    await win.evaluate((w) => w.setSize(1100, 800))
    // 重钳走的是一条 resize + rAF 合并,给它两帧再加一点余量。
    await delay(600)
    const narrow = await page.evaluate((margin) => {
      const el = document.querySelector('[data-focus-scope="expose"]')?.closest('[role="dialog"]')
      if (!el) return { error: '缩窗之后浮窗不在 DOM 里' }
      const r = el.getBoundingClientRect()
      const problems = []
      if (r.right > window.innerWidth - margin + 0.5) {
        problems.push(`右缘 ${r.right.toFixed(1)} > 视口 ${window.innerWidth} − ${margin}`)
      }
      if (r.left < margin - 0.5) problems.push(`左缘 ${r.left.toFixed(1)} < ${margin}`)
      if (r.bottom > window.innerHeight - margin + 0.5) {
        problems.push(`下缘 ${r.bottom.toFixed(1)} > 视口高 ${window.innerHeight} − ${margin}`)
      }
      return {
        problems,
        seen: `x=${Math.round(r.left)} w=${Math.round(r.width)} 右缘=${Math.round(r.right)} 视口=${window.innerWidth}×${window.innerHeight}`,
      }
    }, FLOAT_MARGIN)
    return { ...narrow, wide: `宽窗上 x=${wide.x} w=${wide.w}(视口 ${wide.vw})` }
  } finally {
    await win.evaluate((w, back) => {
      w.setSize(back.size[0], back.size[1])
      w.setMinimumSize(back.min[0], back.min[1])
    }, before)
    await delay(500)
  }
}

/**
 * 把默认打开档改成「钉栏」(= edge:right)再重载,顺带抹掉逐项记忆。
 * 一模一样的理由见 gate-perf.mjs 的同名函数:不清 memory 的话,点 Dock 上的
 * sessions 会按记忆开到浮窗里,这条门就不在架子上量了。
 */
async function switchDefaultOpenToPinned(page) {
  // persist 中间件只在**发生过一次 set** 之后才落盘。刚启动的应用一格没动,
  // localStorage 里就没有这个键 —— 先做一次真手势(开一块面板再收回 Dock),
  // 让它落一次盘,再来改档。不伪造整份状态的理由见函数顶部注释。
  const primed = await page.evaluate(() => Boolean(localStorage.getItem('onething.stage')))
  if (!primed) {
    await clickTestId(page, 'dock-tile-files')
    await delay(300)
    await clickTestId(page, 'dock-tile-files')
    await delay(300)
  }
  const ok = await page.evaluate(() => {
    const KEY = 'onething.stage'
    const raw = localStorage.getItem(KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw)
    parsed.state = { ...(parsed.state ?? {}), defaultOpen: 'pinned', memory: {} }
    localStorage.setItem(KEY, JSON.stringify(parsed))
    return true
  })
  if (!ok) throw new Error('localStorage 里没有 onething.stage —— 应用还没落过盘')
  await page.reload()
  await waitFor('重载后 Dock 就位', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
  )
}

/**
 * 把右架子拖到指定厚度 —— 走的是**生产那只手**(EdgeShelf 的 `onHandleDown` →
 * pointermove 逐帧写本地 state → pointerup 落 store),不是伪造一份持久化状态:
 * 伪造只能摆出「松手之后」,量不到拖的过程中那一串中间厚度。
 *
 * 事件是**朝把手元素直接派发**的合成 PointerEvent,不是 Playwright 的真鼠标。
 * 这一条是试出来的,理由写清楚免得后人又换回去:把手是贴着架子内缘的 6px 竖带,
 * 真鼠标要先过命中测试(面板里的粘性行会间歇性盖住它),按下之后还要靠
 * `setPointerCapture` 把后续 move 拽回来 —— 两件事都偶发失手,实测同一段代码
 * 三跑里一次到位 240、一次只走了 8px 就断。合成事件直接落在挂着监听器的那个
 * 元素上,把「手准不准」这一层噪声整个拿掉,而被驱动的仍是生产处理器一行不差。
 *
 * 右架子的外缘不动(贴着视口右边),所以 thicknessFromPointer 就是 outer - x:
 * 想要 T 的厚度,把指针放到 x = outer - T。每一步之间等一帧,让 React 真的把
 * 那一档厚度画出来 —— 这样「逐帧路径」不是嘴上说说。
 */
async function dragThicknessTo(page, target) {
  const got = await page.evaluate(async (want) => {
    const el = document.querySelector('[data-shelf="right"] [role="separator"]')
    const aside = document.querySelector('[data-shelf="right"]')
    if (!el || !aside) return -1
    const r = el.getBoundingClientRect()
    const y = r.top + r.height / 2
    const from = r.left + r.width / 2
    const to = aside.getBoundingClientRect().right - want
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve))
    const mk = (type, x) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        clientX: x,
        clientY: y,
      })
    el.dispatchEvent(mk('pointerdown', from))
    for (let i = 1; i <= 12; i += 1) {
      el.dispatchEvent(mk('pointermove', from + ((to - from) * i) / 12))
      await frame()
    }
    el.dispatchEvent(mk('pointerup', to))
    await frame()
    await frame()
    return aside.getBoundingClientRect().width
  }, target)
  if (Math.abs(got - target) > 2) {
    throw new Error(`厚度没拖到位:想要 ${target}px,实际 ${got.toFixed(1)}px`)
  }
  await delay(150)
  return got
}

/**
 * 在页面里扫一遍架子,返回所有相交的盒子对。
 *
 * 「盒子」= 自己画内容的元素(直接文本 / svg / img / canvas / input),
 * 且与架子的可视矩形相交(滚出去的、content-visibility: hidden 跳过渲染的,
 * getBoundingClientRect 要么是 0 要么在外面,天然被滤掉)。
 * 祖孙对不比 —— 孩子画在爸爸身上是布局的定义,不是重叠。
 */
function scanOverlaps(page, tolerance, allow) {
  return page.evaluate(
    ({ tol, allowList }) => {
      const shelf = document.querySelector('[data-shelf="right"]')
      if (!shelf) return { error: '右架子不在 DOM 里' }
      const clip = shelf.getBoundingClientRect()

      const PAINTS = new Set(['SVG', 'IMG', 'CANVAS', 'INPUT', 'TEXTAREA'])
      const hasOwnText = (el) => {
        for (const node of el.childNodes) {
          if (node.nodeType === 3 && node.nodeValue && node.nodeValue.trim()) return true
        }
        return false
      }
      const describe = (el) => {
        const cls = typeof el.className === 'string' ? el.className : ''
        const testid = el.getAttribute?.('data-testid')
        const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
        return `${el.tagName.toLowerCase()}${cls ? `.${cls.trim().split(/\s+/).join('.')}` : ''}`
          + `${testid ? `[${testid}]` : ''}${text ? ` «${text}»` : ''}`
      }

      /*
       * **看得见的那一块**才是被试,不是几何矩形。
       *
       * 一个滚上去的卡,它的 getBoundingClientRect 仍然停在滚动容器上缘之外 ——
       * 拿这个矩形去比,它会和顶栏的搜索条「相交」,而屏幕上那里什么都没有
       * (滚动容器把它裁掉了)。首跑就被这一族假红淹了(七八对里六对是它)。
       * 所以每个盒子都要**沿着祖先链逐层求交**:凡是 overflow 不为 visible 的
       * 祖先,都会把后代裁到自己的盒子里。裁完宽或高 ≤ 0 = 屏幕上根本没有它。
       */
      const visibleRect = (el) => {
        let box = el.getBoundingClientRect()
        let node = el.parentElement
        while (node) {
          const st = getComputedStyle(node)
          if (st.overflowX !== 'visible' || st.overflowY !== 'visible') {
            const r = node.getBoundingClientRect()
            const left = Math.max(box.left, r.left)
            const top = Math.max(box.top, r.top)
            const right = Math.min(box.right, r.right)
            const bottom = Math.min(box.bottom, r.bottom)
            if (right <= left || bottom <= top) return null
            box = { left, top, right, bottom, width: right - left, height: bottom - top }
          }
          if (node === shelf) break
          node = node.parentElement
        }
        const left = Math.max(box.left, clip.left)
        const top = Math.max(box.top, clip.top)
        const right = Math.min(box.right, clip.right)
        const bottom = Math.min(box.bottom, clip.bottom)
        if (right - left <= 0 || bottom - top <= 0) return null
        return { left, top, right, bottom }
      }

      /*
       * 粘性头是律三**预留过**的覆盖,不是违规覆盖。
       *
       * `position: sticky` 的语义就是「内容从我底下滚过去」—— 拿它和滚过去的
       * 那些卡求交,必然对对都红,而屏幕上那正是它该有的样子。真正的预留不在
       * 布局里,在**滚动坐标系**里:`scroll-padding-top` 告诉滚动容器上面这一条
       * 是被占着的,于是 scrollIntoView 永远不会把东西停在它底下。所以这条门
       * 单独有一步去查那个预留在不在(见 checkStickyReservation),
       * 查到了才允许在这里豁免。
       *
       * 豁免的边界钉死在「同一个粘性头之内仍然要查」:groupName 压住 count
       * 就是同一个粘性头里的两件,那是本批修的病灶,一格都不许放。
       * 所以判据是**两边的粘性宿主是不是同一个**,不是「有没有沾上粘性」。
       */
      const stickyHostOf = (el) => {
        let node = el
        while (node && node !== shelf) {
          if (getComputedStyle(node).position === 'sticky') return node
          node = node.parentElement
        }
        return null
      }

      const boxes = []
      const walk = (el) => {
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') return
        if (Number(style.opacity) === 0) return
        const raw = el.getBoundingClientRect()
        if (raw.width <= 0 || raw.height <= 0) return
        if (hasOwnText(el) || PAINTS.has(el.tagName)) {
          const rect = visibleRect(el)
          // 全被裁掉 = 屏幕上没有它。这一支也顺手滤掉滚出视口的那几百张卡。
          if (rect) {
            boxes.push({
              el,
              rect,
              desc: describe(el),
              cls: el.className ?? '',
              sticky: stickyHostOf(el),
            })
          }
          return // 自己就是叶子,不再往下钻(mark / tspan 这类是它的一部分)
        }
        for (const child of el.children) walk(child)
      }
      for (const child of shelf.children) walk(child)

      const allowed = (a, b) =>
        allowList.some(
          (rule) =>
            (String(a.cls).includes(rule.a) && String(b.cls).includes(rule.b))
            || (String(b.cls).includes(rule.a) && String(a.cls).includes(rule.b)),
        )

      const hits = []
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i]
          const b = boxes[j]
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue
          // 粘性宿主不同 = 一件在粘性头里、另一件从它底下滚过去(或分属两个头)。
          // 同一个宿主(含两边都不粘)照查不误。
          if (a.sticky !== b.sticky) continue
          const ox = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left)
          const oy = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top)
          if (ox <= tol || oy <= tol) continue
          if (allowed(a, b)) continue
          hits.push({
            a: a.desc,
            b: b.desc,
            overlap: `${ox.toFixed(1)}×${oy.toFixed(1)}px`,
          })
        }
      }
      return { boxes: boxes.length, hits, sample: boxes.map((b) => b.desc) }
    },
    { tol: tolerance, allowList: allow },
  )
}

/**
 * 律三的**预留检查** —— 上面那条粘性豁免的代价。
 *
 * 允许粘性头盖住滚过去的内容,前提是它在滚动坐标系里真的把那一条留出来了:
 * 它所在的滚动容器必须声明 `scroll-padding-top`,并且不小于粘性头的高度。
 * 少了这一句,键盘 `scrollIntoView` 会把卡停在粘性头**底下** —— 焦点环在,
 * 卡看不见,那正是「覆盖没有预留」的活样本。
 *
 * 查不到粘性头 = 这一批没有粘性覆盖,直接过(不强迫谁必须做粘性头)。
 */
async function checkStickyReservation(page) {
  return page.evaluate(() => {
    const shelf = document.querySelector('[data-shelf="right"]')
    if (!shelf) return { error: '右架子不在 DOM 里' }
    const sticky = [...shelf.querySelectorAll('*')].filter(
      (el) => getComputedStyle(el).position === 'sticky' && el.getBoundingClientRect().height > 0,
    )
    if (sticky.length === 0) return { checked: 0, problems: [] }
    const problems = []
    const seen = new Set()
    for (const head of sticky) {
      let node = head.parentElement
      while (node && node !== shelf) {
        const st = getComputedStyle(node)
        if (st.overflowY === 'auto' || st.overflowY === 'scroll') break
        node = node.parentElement
      }
      if (!node || node === shelf) {
        problems.push(`粘性元素找不到滚动容器:${head.className}`)
        continue
      }
      if (seen.has(node)) continue
      seen.add(node)
      const declared = getComputedStyle(node).scrollPaddingTop
      const px = Number.parseFloat(declared)
      const need = head.getBoundingClientRect().height
      if (!Number.isFinite(px)) {
        problems.push(`滚动容器没有 scroll-padding-top(读到 "${declared}"),粘性头 ${need.toFixed(0)}px 没有预留`)
      } else if (px + 0.5 < need) {
        problems.push(`scroll-padding-top ${px}px < 粘性头 ${need.toFixed(0)}px —— 预留不够`)
      }
    }
    return { checked: sticky.length, problems }
  })
}

/**
 * 律三的**第二处预留检查**:Dock 常显钉边时,主输入按不按得到(08-31 P0)。
 *
 * 前一条查的是「滚动坐标系里留没留」,这一条查的是「屏幕坐标系里留没留」——
 * 同一条律,两种覆盖形态。判据不是求盒子相交而是 **elementFromPoint**:
 * 「这一点按下去事件落在谁身上」才是用户真正遭遇的那件事,而两个盒子相交
 * 完全可能是无害的(Dock 是圆角条,四角那一块谁都碰不到)。
 *
 * 病历:修前底边常显档下 composer 四件控件盒在 843–871,而 Dock 占 826–888——
 * 100 个采样点只有 5 个按得到(附件 / 模型 / 输入区三件是 0/25)。修法是外壳按
 * `--dock-reserve-*` 让出那一条边(components/AppShell.module.css 的 .reserve*)。
 * 反证:把那几条 padding 注释掉 → 这一步当场红回 5/100。
 *
 * 自动隐藏档不查:那时 Dock 平时不在屏上,「盖住」这件事根本不发生。
 */
async function checkDockReservation(page) {
  return page.evaluate(() => {
    const strip = document.querySelector('[data-dock="strip"]')
    if (!strip) return { error: 'Dock 条不在 DOM 里' }
    const holder = strip.parentElement
    if (holder && /hidden/i.test(holder.className)) return { skipped: '自动隐藏档,不查' }

    const buttons = [...document.querySelectorAll('button')]
    const byLabel = (re) => buttons.find((b) => re.test(b.getAttribute('aria-label') ?? ''))
    const targets = [
      ['输入区', document.querySelector('[contenteditable]') ?? document.querySelector('textarea')],
      ['附件钮', byLabel(/添加附件|Add attachment/)],
      ['模型钮', byLabel(/选择模型|Pick a model/)],
      ['发送键', byLabel(/^发送$|^Send$|停止生成|Stop generating/)],
    ]

    const problems = []
    const readings = []
    for (const [label, el] of targets) {
      if (!el) {
        problems.push(`${label}:不在场(选择器对不上就等于这条断言在陪跑)`)
        continue
      }
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) {
        problems.push(`${label}:盒子是 0×0`)
        continue
      }
      // 控件盒里均匀取 5×5 个点,逐点问「这一下落在谁身上」。
      let blocked = 0
      const total = 25
      for (let i = 1; i <= 5; i += 1) {
        for (let j = 1; j <= 5; j += 1) {
          const hit = document.elementFromPoint(r.left + (r.width * i) / 6, r.top + (r.height * j) / 6)
          if (hit?.closest('[data-dock="strip"]')) blocked += 1
        }
      }
      readings.push(`${label} ${total - blocked}/${total}`)
      if (blocked > 0) problems.push(`${label}:${blocked}/${total} 个采样点被 Dock 挡住`)
    }
    return { problems, readings }
  })
}

/**
 * 一档厚度 = **滚一遍**,每屏扫一次,取并集。
 *
 * 只扫首屏是不够的:报障那一组(uuid 组头)在 240px 档要滚两屏才露面,
 * 首屏绿不代表这一档绿。滚动步长取可视高度的 80%,留一成重叠免得跨屏的那一对
 * 两边都只露半截。
 */
async function sweep(page) {
  const scroller = await page.evaluate(() => {
    const body = document.querySelector('[data-shelf-body="right"]')
    const el = body && [...body.querySelectorAll('*')].find((x) => x.scrollHeight > x.clientHeight + 8)
    if (!el) return null
    el.scrollTop = 0
    return { height: el.clientHeight, total: el.scrollHeight }
  })
  const seen = new Map()
  const boxes = new Set()
  const step = scroller ? Math.max(120, Math.floor(scroller.height * 0.8)) : 0
  const stops = scroller ? Math.ceil((scroller.total - scroller.height) / step) + 1 : 1
  for (let i = 0; i < stops; i += 1) {
    if (scroller && i > 0) {
      await page.evaluate((top) => {
        const body = document.querySelector('[data-shelf-body="right"]')
        const el = body && [...body.querySelectorAll('*')].find((x) => x.scrollHeight > x.clientHeight + 8)
        if (el) el.scrollTop = top
      }, i * step)
      await delay(80)
    }
    const result = await scanOverlaps(page, 1, ALLOWED_OVERLAP)
    if (result.error) throw new Error(result.error)
    for (const desc of result.sample) boxes.add(desc)
    for (const hit of result.hits) seen.set(`${hit.a}|${hit.b}`, hit)
  }
  return { hits: [...seen.values()], boxes: [...boxes], steps: stops }
}

/**
 * 崩溃现场那条长 URL —— toast 挤压检查的被试。
 *
 * 形状是真机报障那一条逐字照抄:带 `?t=` 时间戳的模块 URL。它的要害是
 * **没有空格**,默认的 `overflow-wrap: normal` 在里面找不到几个断点。
 */
const CRASH_URL = 'http://localhost:5199/src/components/DockTile.tsx?t=1756612345678&import&v=0f3a9c2e'

/**
 * 挤压纪律的 **toast 版**(09-01 报障:崩溃弹框「右半边没了」)。
 *
 * ── 为什么是独立的一步,而不是让上面那把重叠尺去扫 ─────────────────────────
 * 三条理由,每条都能单独把它挡在那把尺之外:
 *   · toast 画在 `document.body` 上的 portal 里,根本不在右架子那棵树下;
 *   · 它的病是**墨溢出自己的盒子**,不是两个盒子相交 —— 盒子从头到尾是声明的
 *     320px,`getBoundingClientRect` 一个像素都没变(修前实测 320/320),
 *     一把只会说「有没有压着」的尺对这一形结构性失明;
 *   · 它被 `.toast { overflow: hidden }` 齐着边框剪掉,剪掉的那一截连盒子都没有。
 *
 * 所以判据换成**墨**:`rect.left + el.scrollWidth` 才是这段文字真正画到哪儿。
 * 两条断言,对应报障当天被怀疑过的两种病根(先量后修,量出来是第二种):
 *   ① 盒子没被撑宽:toast 盒宽 ≤ 宿主可用宽(视口减两侧固定偏移),且整只落在视口内;
 *   ② 墨没顶穿 padding:每一件内容的墨右缘 ≤ 容器 padding 内缘 —— 换句话说
 *      「墨到边框的距离 ≥ padding token」,这正是「任何内容不得触边」的机器化。
 *
 * 反证:把 `ui/Toast.module.css` 里 `.message` 那条 `overflow-wrap: anywhere`
 * 注释掉再跑 → ② 当场红(修前实测:墨画到 1290,容器 padding 内缘 1251,
 * 顶穿 39px;盒宽 320 = 声明值,① 修前修后都绿 —— 这正是它必须两条都在的理由)。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 触发走的是**生产那条路**:朝 window 派发一个真的 ErrorEvent,由
 * `services/crash.ts` 的 window.onerror 监听接住 → notify → toast。
 * 不去戳 toast hub —— 那样量的就不是崩溃弹框,是一个被摆拍的组件。
 */
async function checkToastSqueeze(page) {
  await page.evaluate((url) => {
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'TypeError: Cannot read properties of undefined (reading tile)',
        filename: url,
        lineno: 42,
        colno: 17,
        error: new TypeError('Cannot read properties of undefined (reading tile)'),
      }),
    )
  }, CRASH_URL)
  await waitFor('崩溃 toast 出场', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="toast-row"]'))),
  )
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="toast-row"]')]
    if (rows.length === 0) return { error: 'toast 不在 DOM 里' }
    const problems = []
    const seen = []
    for (const row of rows) {
      const stack = row.parentElement
      const cs = getComputedStyle(row)
      const rb = row.getBoundingClientRect()
      const padR = Number.parseFloat(cs.paddingRight)
      const padL = Number.parseFloat(cs.paddingLeft)
      const bwR = Number.parseFloat(cs.borderRightWidth)
      const bwL = Number.parseFloat(cs.borderLeftWidth)
      const innerRight = rb.right - bwR - padR
      const innerLeft = rb.left + bwL + padL

      // ① 盒子本身:没被撑宽,整只在视口里。
      const offset = Number.parseFloat(getComputedStyle(stack).right)
      const available = window.innerWidth - (Number.isFinite(offset) ? offset * 2 : 0)
      seen.push(`盒宽 ${rb.width.toFixed(0)} / 可用 ${available.toFixed(0)}`)
      if (rb.width > available + 1) {
        problems.push(`toast 盒宽 ${rb.width.toFixed(1)} > 宿主可用宽 ${available.toFixed(1)}`)
      }
      if (rb.right > window.innerWidth + 1 || rb.left < -1) {
        problems.push(`toast 盒子出视口:left=${rb.left.toFixed(1)} right=${rb.right.toFixed(1)} 视口宽 ${window.innerWidth}`)
      }

      // ② 墨:每一件内容都不许顶穿 padding 内缘。
      const PAINTS = new Set(['SVG', 'IMG', 'CANVAS'])
      const walk = (el) => {
        const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue?.trim())
        if (hasText || PAINTS.has(el.tagName)) {
          const r = el.getBoundingClientRect()
          if (r.width <= 0 || r.height <= 0) return
          const inkRight = r.left + el.scrollWidth
          const name = `${el.tagName.toLowerCase()}.${String(el.className || '').trim().split(/\s+/).join('.')}`
          seen.push(`${name} 墨→padding内缘 ${(innerRight - inkRight).toFixed(1)}`)
          if (inkRight > innerRight + 1) {
            problems.push(
              `${name}:墨画到 ${inkRight.toFixed(1)},容器 padding 内缘在 ${innerRight.toFixed(1)}`
              + ` —— 顶穿 ${(inkRight - innerRight).toFixed(1)}px(padding token ${padR}px 视觉上不存在)`,
            )
          }
          if (r.left < innerLeft - 1) {
            problems.push(`${name}:左缘 ${r.left.toFixed(1)} 越过容器 padding 内缘 ${innerLeft.toFixed(1)}`)
          }
          return
        }
        for (const child of el.children) walk(child)
      }
      for (const child of row.children) walk(child)
    }
    return { problems, seen, rows: rows.length }
  })
}

/**
 * 一个场景 = 五档厚度,逐档滚一遍扫重叠。
 * 场景名只进日志与失败行 —— 尺一把,判据一个字都不许分岔。
 * (09-04:`extra` 那格附加判据随 ListView 场景一起退役;三档在场表与行几何
 * 各自成步,理由写在 `checkWidthBands` / `checkRowGeometry` 头上。)
 */
async function sweepThicknesses(page, scenario, failures) {
  for (const target of THICKNESSES) {
    const width = await dragThicknessTo(page, target)
    const { hits, boxes, steps } = await sweep(page)
    if (process.env.SQUEEZE_DUMP) {
      console.log(`    [dump ${scenario} ${target}px]\n      ${boxes.join('\n      ')}`)
    }
    if (hits.length === 0) {
      console.log(
        `  ✓ ${scenario} ${target}px(实测 ${width.toFixed(0)})—— 滚 ${steps} 屏,${boxes.length} 个盒子,零相交`,
      )
    } else {
      console.log(
        `  ✗ ${scenario} ${target}px(实测 ${width.toFixed(0)})—— 滚 ${steps} 屏,${hits.length} 对相交:`,
      )
      for (const hit of hits.slice(0, 12)) {
        console.log(`      ${hit.overlap}\n        A ${hit.a}\n        B ${hit.b}`)
      }
      if (hits.length > 12) console.log(`      …还有 ${hits.length - 12} 对`)
      failures.push(`${scenario} ${target}px:${hits.length} 对相交`)
    }
  }
}


/**
 * 竖排 Dock 的预留检查(09-01 用户报障带截图:竖排 Dock 盖住右架子里查看器的正文)。
 *
 * 与 [4/11] 是同一条律三、同一把尺,只是换了一条边:那条量的是底边 Dock 压 composer,
 * 这条量的是**左右边 Dock 压侧架子**。判据也是同一句——把该侧架子里「自己画内容」
 * 的盒子逐个取右缘,问一次 elementFromPoint:命中 Dock 就是被盖。
 *
 * 病历:内衬第一版打在 [data-shelf-body] 上,padding 量到了(88)却没用——
 * 面板那一层是 `position:absolute; inset:0`,而**绝对定位的 inset 量的是包含块的
 * padding box**,整个把 padding 跨了过去:真机 17/19 个盒子越界、13 个采样落在 Dock 下。
 * 内衬移到 [data-panel-layer] 之后归零。
 */
async function checkSideShelfReach(page, edge) {
  await page.evaluate((e) => {
    const raw = localStorage.getItem('onething.stage')
    if (!raw) return
    const p = JSON.parse(raw)
    p.state = { ...(p.state ?? {}), dockDisplay: 'always', dockEdge: e }
    localStorage.setItem('onething.stage', JSON.stringify(p))
  }, edge)
  await page.reload()
  await waitFor('重载后 Dock 就位', () =>
    page.evaluate(() => Boolean(document.querySelector('[data-testid="dock-tile-sessions"]'))),
  )
  /* 前面几步已经把总览钉在右架子上了,重载会照原样恢复 —— 这时候再点一下 Dock 图标
   * 是「收起来」,不是「打开」(clickDockIcon 的第二下语义)。所以先问再点。 */
  const already = await page.evaluate(
    () => document.querySelector('[data-shelf-body="right"]')?.dataset.panel === 'sessions',
  )
  if (!already) await clickTestId(page, 'dock-tile-sessions')
  await waitFor('架子上出现会话总览', () =>
    page.evaluate(() => document.querySelector('[data-shelf-body="right"]')?.dataset.panel === 'sessions'),
  )
  await waitFor('总览画出会话卡', () =>
    page.evaluate(() => document.querySelectorAll('[data-session-id]').length > 0),
  )
  await delay(400)
  return await page.evaluate(() => {
    const body = document.querySelector('[data-shelf-body="right"]')
    const strip = document.querySelector('[data-dock="strip"]')
    if (!body || !strip) return { error: '侧架子或 Dock 条不在 DOM 里' }
    const sb = strip.getBoundingClientRect()
    const inDock = (el) => {
      while (el) {
        if (el.dataset && el.dataset.dock === 'strip') return true
        el = el.parentElement
      }
      return false
    }
    const draws = (el) => {
      if (['svg', 'img', 'canvas', 'input', 'textarea'].includes(el.tagName.toLowerCase())) return true
      for (const n of el.childNodes) if (n.nodeType === 3 && n.textContent.trim()) return true
      return false
    }
    const boxes = [...body.querySelectorAll('*')]
      .filter(draws)
      .map((el) => ({ el, b: el.getBoundingClientRect() }))
      .filter((x) => x.b.width > 0 && x.b.height > 0)
    let covered = 0
    let sampled = 0
    const examples = []
    for (const { el, b } of boxes) {
      const x = b.right - 2
      const y = b.top + b.height / 2
      if (x < 0 || x > innerWidth || y < 0 || y > innerHeight) continue
      sampled += 1
      if (inDock(document.elementFromPoint(x, y))) {
        covered += 1
        if (examples.length < 4) examples.push(`${el.tagName.toLowerCase()} @ ${Math.round(x)},${Math.round(y)}`)
      }
    }
    return {
      covered,
      sampled,
      examples,
      rightMost: boxes.length ? Math.round(Math.max(...boxes.map((x) => x.b.right))) : null,
      stripLeft: Math.round(sb.left),
    }
  })
}

/**
 * ── 律二在 composer 本体行上的那一步(09-03 用户报障,拍板 B:本体行改两行)──
 *
 * 报障两张截图两条病,同一个根:①窄宽度下模型药丸「deepseek-v4-pro」在连字符处
 * **折成两行**;②输入面多行时,回形针 / 药丸 / 圆环悬在输入面的**竖中线**上,
 * 发送键沉在底部 —— 四件一行里站四个高度。病根是「四件与一块会长高的文本同行」。
 *
 * 静态门为什么漏:`squeeze-check` 那条只查「`flex: 1` 却没 `min-width: 0`」——
 * 药丸不是 `flex: 1`(它没写 flex,吃的是缺省 `0 1 auto`),`.input` 则靠 `min-height`
 * 蒙了过去。**「这段文字会不会折行」是排版,只有真机量得出来**,所以补在这条门里。
 *
 * 三条判据,全部 `page.evaluate` 读真排版:
 *   ① 窄档药丸**单行**:盒高 < 2 × 行盒高,且药丸上那截文字的 `Range.getClientRects()`
 *      只有一块 —— 后者是「文本占了几行」的直接读数,不是从高度反推的。
 *   ② 多行时四件**全在输入面之下**:每件 `rect.top ≥ 输入面 rect.bottom - 1`。
 *   ③ 四件同一条**竖中线**:两两的 `top + height/2` 差 ≤ 1px。
 * ②③ 都在**输入面被敲成 6 行之后**量 —— 单行时旧写法的四件恰好也差不多齐,
 * 那一档量不出病(试过:不敲字这一步在旧写法下也绿)。
 *
 * 四件一律按**产品自己的落点**找(data-testid / aria-label / role),不按 CSS 类名:
 * 反证要把 JSX 与 CSS 一起换回旧写法,按类名找会变成「探针挂了」而不是「判据红了」。
 */
/**
 * 窄档取多窄:**盯着 composer 面板自己的宽度**,不盯窗口宽度。
 *
 * 面板宽 = 窗口宽 − 右架子厚度 − `.wrap` 的左右内缩,而架子厚度是上一步留下来的
 * 状态 —— 拿窗口宽当判据,换一次默认厚度这一步量的就是另一个宽度。所以这里
 * 反着来:设一次窗口宽 → 量一次面板 → 按差额修一次,最多修三轮(两者是线性关系,
 * 一轮就够,多的两轮是给 55% 架子钳制那种非线性留的)。真实落到多少一律打印。
 *
 * 200 这个数是**反证跑出来的**,不是拍的:09-03 把 Composer.tsx + .module.css 一起
 * 换回旧写法跑这一步,在面板 200px 上三条判据各红一条(药丸「gpt-4o」的文字占 2 行、
 * 四件的上缘还在输入面里、发送键与另外三件的竖中线差 46px)。**再宽就不成立**:
 * 这条门里药丸上写的是这台机器的默认模型「gpt-4o」(六个字符),它的 max-content
 * 很窄 —— 宽一档旧写法压根压不到它,①「药丸单行」就成了一条只会绿的断言。
 * 换一天这条门有了长模型名(报障那条是 `deepseek-v4-pro`),这个数可以放宽,
 * 但**放宽之前必须重跑一次反证**:判据的价值全在「拆掉即红」上。
 * 另一头也有底:面板再窄下去工具行自己会顶出面板(`.panel` 是 `overflow: hidden`),
 * 那时量的就是另一个病了 —— 那一档没量过,要往下调先补量。
 */
const TARGET_PANEL_W = 200
const NARROW_WINDOW = { minWidth: 320, minHeight: 480 }

async function measureComposerPanel(page) {
  return page.evaluate(() => {
    const scope = document.querySelector('[data-focus-scope="composer"]')
    return scope ? scope.getBoundingClientRect().width : -1
  })
}

async function narrowComposerTo(app, page, targetPanel) {
  const win = await app.browserWindow(page)
  const before = await win.evaluate((w) => ({ size: w.getSize(), min: w.getMinimumSize() }))
  // minWidth 在 electron/main.ts 里是 900:不放开这一格,setSize 会被当场钳回去。
  await win.evaluate((w, m) => w.setMinimumSize(m.minWidth, m.minHeight), NARROW_WINDOW)
  let width = before.size[0]
  let panel = await measureComposerPanel(page)
  for (let round = 0; round < 3 && Math.abs(panel - targetPanel) > 8; round += 1) {
    width = Math.max(NARROW_WINDOW.minWidth, Math.round(width + (targetPanel - panel)))
    await win.evaluate((w, s) => w.setSize(s.width, w.getSize()[1]), { width })
    await delay(400)
    panel = await measureComposerPanel(page)
  }
  const restore = async () => {
    await win.evaluate((w, back) => {
      w.setSize(back.size[0], back.size[1])
      w.setMinimumSize(back.min[0], back.min[1])
    }, before)
    await delay(500)
  }
  return { panel, width, restore }
}

/**
 * 把光标放进输入面。
 *
 * **不用 `page.click`**:Playwright 的点击带可操作性检查(要可见、要稳定),
 * 而这一步存心把面板挤到 200px —— 反证跑旧写法时输入面被四件挤成零宽,
 * 点击于是超时**抛异常**,判据一条都没跑到。探针要报的是「判据红了」,
 * 不是「探针自己挂了」。落焦走页面内的 `focus()`,键盘仍是真的 CDP 按键。
 */
async function focusComposerInput(page) {
  const ok = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="composer-input"]')
    if (!(el instanceof HTMLElement)) return false
    el.focus()
    return document.activeElement === el
  })
  if (!ok) throw new Error('光标进不了 composer 的输入面')
  await delay(120)
}

/** 六行:`Shift+Enter` 是产品自己的换行手势(裸 Enter 会把话发出去)。 */
async function typeSixLines(page) {
  await focusComposerInput(page)
  for (let i = 1; i <= 6; i += 1) {
    await page.keyboard.type(`第 ${i} 行`)
    if (i < 6) await page.keyboard.press('Shift+Enter')
  }
  await delay(250)
}

async function clearComposer(page) {
  const selectAll = process.platform === 'darwin' ? 'Meta+a' : 'Control+a'
  await focusComposerInput(page)
  await page.keyboard.press(selectAll)
  await page.keyboard.press('Backspace')
  await delay(200)
}

async function checkComposerToolRow(page) {
  return page.evaluate(() => {
    const scope = document.querySelector('[data-focus-scope="composer"]')
    const input = document.querySelector('[data-testid="composer-input"]')
    const send = document.querySelector('[data-testid="composer-send"]')
    const buttons = [...document.querySelectorAll('button')]
    const byLabel = (re) => buttons.find((b) => re.test(b.getAttribute('aria-label') ?? ''))
    const clip = byLabel(/添加附件|Add attachment/)
    const pill = byLabel(/选择模型|Pick a model/)
    const ring = scope?.querySelector('[role="img"]')
    if (!scope || !input || !send || !clip || !pill || !ring) {
      return {
        error: `composer 的落点对不上(scope=${!!scope} input=${!!input} 回形针=${!!clip}`
          + ` 药丸=${!!pill} 圆环=${!!ring} 发送=${!!send})—— 选择器对不上就等于这一步在陪跑`,
      }
    }

    const problems = []
    const readings = []
    const panel = scope.getBoundingClientRect()
    readings.push(`composer 面板宽 ${panel.width.toFixed(1)}`)

    // ── ① 药丸单行 ───────────────────────────────────────────────────────
    // 药丸上那截文字:新写法里是一枚 <span>(截断的产地),旧写法里是直接的文本节点。
    const labelNode =
      pill.querySelector('span') ?? [...pill.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim())
    if (!labelNode) return { error: '药丸上找不到那截文字' }
    const range = document.createRange()
    range.selectNodeContents(labelNode)
    const lineRects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0)
    const lineBox = lineRects.length ? Math.max(...lineRects.map((r) => r.height)) : 0
    const pillBox = pill.getBoundingClientRect()
    readings.push(
      `药丸「${(labelNode.textContent ?? '').trim()}」盒高 ${pillBox.height.toFixed(1)}`
      + ` / 行盒 ${lineBox.toFixed(1)} × ${lineRects.length} 块`,
    )
    if (lineRects.length !== 1) {
      problems.push(
        `① 药丸上的文字占了 ${lineRects.length} 行(律二:结构行里的文本永不换行,只截断)`,
      )
    }
    if (lineBox > 0 && pillBox.height >= lineBox * 2) {
      problems.push(
        `① 药丸盒高 ${pillBox.height.toFixed(1)} ≥ 2 × 行盒 ${lineBox.toFixed(1)} —— 它折行了`,
      )
    }

    // ── ②③ 四件退到输入面之下,而且站在同一条竖中线上 ──────────────────
    const four = [
      ['回形针', clip],
      ['药丸', pill],
      ['圆环', ring],
      ['发送键', send],
    ].map(([name, el]) => ({ name, r: el.getBoundingClientRect() }))
    const inputBox = input.getBoundingClientRect()
    readings.push(`输入面 ${inputBox.top.toFixed(1)}→${inputBox.bottom.toFixed(1)}`)
    for (const { name, r } of four) {
      readings.push(`${name} top ${r.top.toFixed(1)} 中线 ${(r.top + r.height / 2).toFixed(1)}`)
      if (r.top < inputBox.bottom - 1) {
        problems.push(
          `② ${name} 的上缘 ${r.top.toFixed(1)} 还在输入面里(输入面下缘 ${inputBox.bottom.toFixed(1)})`
          + ' —— 四件仍与会长高的文本同行',
        )
      }
    }
    for (let i = 0; i < four.length; i += 1) {
      for (let j = i + 1; j < four.length; j += 1) {
        const a = four[i]
        const b = four[j]
        const gap = Math.abs(a.r.top + a.r.height / 2 - (b.r.top + b.r.height / 2))
        if (gap > 1) {
          problems.push(`③ ${a.name} 与 ${b.name} 的竖中线差 ${gap.toFixed(1)}px(> 1px)`)
        }
      }
    }
    return { problems, readings }
  })
}

/**
 * 中央区那条檐的挤压读数(W1;**W1-b 起它画在窗口顶栏上**,设计 §2.2 D 稿)。
 * 夹具走**用户真走的那条路**:文件树行菜单选「主区域」,再逐行 ↵ 把几份文件开进
 * 中央叶 —— 不去改 store(那样量的是自己写进去的状态)。
 */
/**
 * **落区高亮不撑破叶**(W3;`ui/drag/DropOverlay` 的挤压读数)。
 *
 * 手势走 CDP `Input.dispatchMouseEvent`(纪律「真机门不许抢用户的机器」——
 * 只进这个窗口,不动真光标),拖到半路**停住不松手**再量;量完 Esc 取消,
 * 于是这一格跑完之后屏幕上的形态与跑之前逐字相同(门不该留下改动)。
 */
async function checkDropOverlay(page, cdp) {
  const problems = []
  const seen = []
  const start = await page.evaluate(() => {
    const tab = document.querySelector('[data-testid="topbar-tabs"] [role="tab"]')
    const slot = document.querySelector('[data-pane-region="center"] [data-pane-slot]')
    if (!tab || !slot) return null
    const t = tab.getBoundingClientRect()
    const s = slot.getBoundingClientRect()
    return {
      from: { x: Math.round(t.left + t.width / 2), y: Math.round(t.top + t.height / 2) },
      leaf: {
        left: Math.round(s.left), top: Math.round(s.top),
        width: Math.round(s.width), height: Math.round(s.height),
      },
    }
  })
  if (!start) return { skipped: '顶栏上没有 tab,或中央区没有叶', problems, seen }

  // 落点:叶的正中(中心区)—— 高亮此时盖的是整片叶,「撑不破」最难的那一形。
  const to = {
    x: start.leaf.left + Math.round(start.leaf.width / 2),
    y: start.leaf.top + Math.round(start.leaf.height / 2),
  }
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: start.from.x, y: start.from.y, button: 'left', buttons: 1, clickCount: 1,
  })
  for (let i = 1; i <= 6; i += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(start.from.x + ((to.x - start.from.x) * i) / 6),
      y: Math.round(start.from.y + ((to.y - start.from.y) * i) / 6),
      button: 'left', buttons: 1,
    })
    await delay(16)
  }
  const shot = await page.evaluate(() => {
    const band = document.querySelector('[data-testid="drop-overlay"]')
    const slot = document.querySelector('[data-pane-region="center"] [data-pane-slot]')
    if (!band || !slot) return null
    const b = band.getBoundingClientRect()
    const s = slot.getBoundingClientRect()
    return {
      band: { left: b.left, top: b.top, right: b.right, bottom: b.bottom },
      leaf: { left: s.left, top: s.top, right: s.right, bottom: s.bottom },
      viewport: { w: window.innerWidth, h: window.innerHeight },
    }
  })
  // 收场:Esc 取消 + 补一发松手(不留下任何形态改动)。
  await page.keyboard.press('Escape')
  await delay(120)
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 1, clickCount: 1,
  })
  await delay(200)

  if (!shot) return { skipped: '拖到半路没量到落区高亮(拖拽没起来?)', problems, seen }
  const slack = 1 // 半像素的排版舍入
  if (shot.band.left < shot.leaf.left - slack) problems.push(`左缘探出叶 ${(shot.leaf.left - shot.band.left).toFixed(1)}px`)
  if (shot.band.top < shot.leaf.top - slack) problems.push(`上缘探出叶 ${(shot.leaf.top - shot.band.top).toFixed(1)}px`)
  if (shot.band.right > shot.leaf.right + slack) problems.push(`右缘探出叶 ${(shot.band.right - shot.leaf.right).toFixed(1)}px`)
  if (shot.band.bottom > shot.leaf.bottom + slack) problems.push(`下缘探出叶 ${(shot.band.bottom - shot.leaf.bottom).toFixed(1)}px`)
  if (shot.band.right > shot.viewport.w + slack || shot.band.bottom > shot.viewport.h + slack) {
    problems.push('高亮探出视口')
  }
  seen.push(
    `高亮 ${Math.round(shot.band.left)},${Math.round(shot.band.top)}–${Math.round(shot.band.right)},${Math.round(shot.band.bottom)}`,
    `叶 ${Math.round(shot.leaf.left)},${Math.round(shot.leaf.top)}–${Math.round(shot.leaf.right)},${Math.round(shot.leaf.bottom)}`,
  )
  return { problems, seen }
}

/**
 * **全屏檐带的挤压纪律**(W2,设计 §4.3)。
 *
 * 它是这道门里第二条「一行结构件」——与顶栏那一条同族,三条判据逐字相同:
 *  ① **永不换行**:檐带里每一件的**竖直中线**只有一种取值。量中线而不是量 top ——
 *     这一行里三件身量各不相同(让位是拉满的空块、图标 14、退出钮 22),
 *     `align-items: center` 之下它们的 top 本来就该不一样,而中线必须重合;
 *  ② **退出钮不许被挤出框**:它的右缘落在檐带盒里,而且与身份那一格零重叠
 *     ——「一行一个弯腰件」,弯腰的是身份(它截断),不是钮;
 *  ③ **让位与顶栏同值**:两条带子读的是壳根上同一个 `--topbar-lead`
 *     (W2 把三档的定义从 `.bar` 提到了 `.shell`),所以左缘必须逐像素对齐。
 *
 * 夹具接着 `[10b/11]` 用:那一步已经在中央叶上开出好几格文件 tab,活动那一格
 * 就是文件(聊天那一种自述 `fullable: false`,⌘⇧↩ 落在它身上是结构化拒绝)。
 */
async function checkFullStrip(page) {
  const problems = []
  const seen = []

  // ① 先把活动 tab 切成**文件**那一格(10b 最后停在哪一格不由这一步说了算)。
  const live = await page.evaluate(() => {
    const center = document.querySelector('[data-pane-region="center"]')
    const layers = Array.from(center?.querySelectorAll('[data-pane-tab]') ?? [])
    const on = layers.find((l) => !l.hasAttribute('inert'))
    return on?.getAttribute('data-pane-tab') ?? null
  })
  if (!live) return { skipped: '中央区没有活着的那一格 tab(夹具没搭起来)' }
  if (live.startsWith('chat:')) {
    await page.evaluate(() => {
      const tabs = Array.from(
        document.querySelectorAll('[data-testid="topbar-tabs"] [role="tab"]'),
      )
      const off = tabs.find((t) => t.getAttribute('aria-selected') !== 'true')
      if (off instanceof HTMLElement) off.click()
    })
    await delay(400)
  }

  // ② ⌘⇧↩ 进全屏(全局档命令,`keymap/transitions.ts` 的出厂绑定)。
  await page.keyboard.press('Meta+Shift+Enter')
  await delay(600)

  const shot = await page.evaluate(() => {
    const strip = document.querySelector('[data-testid="full-strip"]')
    if (!strip) return { error: '全屏檐带不在场(⌘⇧↩ 没进去)' }
    const box = strip.getBoundingClientRect()
    const rowOf = (el) => {
      const r = el.getBoundingClientRect()
      return {
        mid: Math.round(r.top + r.height / 2),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
      }
    }
    const kids = Array.from(strip.children).filter((el) => el.getBoundingClientRect().width > 0)
    const exit = strip.querySelector('button')
    const title = strip.querySelector('[data-host-title]')
    const lead = strip.firstElementChild
    const bar = document.querySelector('[data-testid="topbar"]')
    // 顶栏那块让位是 `.traffic`(顶栏的第一格),两条带子读同一个变量。
    const traffic = bar?.querySelector('[data-testid="topbar-traffic"]') ?? null
    return {
      strip: {
        top: Math.round(box.top),
        left: Math.round(box.left),
        right: Math.round(box.right),
        height: Math.round(box.height),
      },
      kids: kids.map(rowOf),
      exit: exit ? rowOf(exit) : null,
      exitName: exit?.getAttribute('aria-label') ?? null,
      title: title ? rowOf(title) : null,
      leadWidth: lead ? Math.round(lead.getBoundingClientRect().width) : null,
      trafficWidth: traffic ? Math.round(traffic.getBoundingClientRect().width) : null,
    }
  })
  if (shot.error) return { skipped: shot.error }

  seen.push(`檐带 ${shot.strip.left}–${shot.strip.right}(高 ${shot.strip.height})`)
  const mids = [...new Set(shot.kids.map((k) => k.mid))]
  seen.push(`中线取值 ${mids.length} 种`)
  if (mids.length !== 1) problems.push(`檐带换行了(中线有 ${mids.length} 种:${mids.join(' / ')})`)
  // 每一件都得**待在带子里**:换行的另一种形是「溢出到带子外面」。
  const spilled = shot.kids.filter(
    (k) => k.top < shot.strip.top - 1 || k.bottom > shot.strip.top + shot.strip.height + 1,
  )
  if (spilled.length) problems.push(`有 ${spilled.length} 件溢出了檐带的上下缘`)

  if (!shot.exit) {
    problems.push('退出钮不在场')
  } else {
    seen.push(`退出钮 ${shot.exit.left}–${shot.exit.right}`)
    if (shot.exit.right > shot.strip.right + 1) {
      problems.push(`退出钮被挤出框外(右缘 ${shot.exit.right} > ${shot.strip.right})`)
    }
    if (!shot.exitName) problems.push('退出钮没有无障碍名(iconOnly 的钮必须说得出自己是谁)')
    if (shot.title && shot.title.right > shot.exit.left + 1) {
      problems.push(`身份压到了退出钮上(身份右缘 ${shot.title.right} > 钮 ${shot.exit.left})`)
    }
  }

  seen.push(`让位 ${shot.leadWidth} / 顶栏 ${shot.trafficWidth}`)
  if (shot.leadWidth === null || shot.trafficWidth === null) {
    problems.push('量不到让位那一格(檐带或顶栏的第一格不在场)')
  } else if (shot.leadWidth !== shot.trafficWidth) {
    problems.push(
      `让位与顶栏不同值(檐带 ${shot.leadWidth} ≠ 顶栏 ${shot.trafficWidth})`
        + ' —— 两条带子该读壳根上同一个 --topbar-lead',
    )
  }

  // ③ 收工:Esc 退出全屏(退层链第一站),别让它挡住后面的步骤。
  await page.keyboard.press('Escape')
  await delay(500)
  const gone = await page.evaluate(() => !document.querySelector('[data-testid="full-strip"]'))
  if (!gone) problems.push('Esc 退不出全屏')

  return { problems, seen }
}

async function checkLeafChrome(page) {
  const problems = []
  const seen = []
  /*
   * ⓪ **先进一条带工作目录的会话**:文件树的根跟着「当前会话的工作目录」走,
   * 不进去的话树会退回主目录(那时树上有什么就不由这道门说了算,而且那是用户
   * 自己的家目录 —— 门不该去读它)。逐条试,进得去哪条算哪条。
   *
   * 这一步会把总览那块瓦从架子上收回 Dock(「进入会话就把它收回」是壳的既有行为),
   * 所以**这一整步排在最后**:前面几步量的架子几何不会被它动到。
   */
  const rows = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-session-id]'))
      .map((el) => el.getAttribute('data-session-id'))
      .filter(Boolean),
  )
  for (const id of rows.slice(0, 6)) {
    await page.evaluate((sid) => {
      const row = document.querySelector(`[data-testid="session-row-${sid}"]`)
      if (row instanceof HTMLElement) row.click()
    }, id)
    await delay(500)
    await page.evaluate(() => {
      const tile = document.querySelector('[data-testid="dock-tile-files"]')
      if (tile instanceof HTMLElement) tile.click()
    })
    await delay(600)
    const got = await page.evaluate(() =>
      Boolean(
        document.querySelector('[data-testid="files-tree"] [data-file-path][data-file-type="file"]'),
      ),
    )
    if (got) break
    // 没进对:把文件面收回去再试下一条(点两下就是开 / 关)。
    await page.evaluate(() => {
      const tile = document.querySelector('[data-testid="dock-tile-files"]')
      if (tile instanceof HTMLElement) tile.click()
    })
    await delay(300)
    await page.evaluate(() => {
      const tile = document.querySelector('[data-testid="dock-tile-sessions"]')
      if (tile instanceof HTMLElement) tile.click()
    })
    await delay(500)
  }
  /*
   * ① 把文件面开出来 —— **只在它此刻没露脸时才点**(09-05 合树时抓出来的夹具病)。
   *
   * Dock 那块瓦是**三态召唤**(S1:开 / 只聚焦 / 隐藏)。上面那个循环成功的那一轮
   * 已经把文件面开出来、而且焦点跟进去了,所以这里再无条件点一下正好是「隐藏」——
   * 修前这一整档因此**必跳过**(循环成功 → 收起来 → 数到 0 行 → skip),
   * 「10b 从来没真的跑过」这件事就这么藏了一批。判据换成读屏幕:有行就不点。
   */
  const rowsCss = '[data-testid="files-tree"] [data-file-path][data-file-type="file"]'
  const countRows = () => page.evaluate((css) => document.querySelectorAll(css).length, rowsCss)
  if ((await countRows()) === 0) {
    await page.evaluate(() => {
      const tile = document.querySelector('[data-testid="dock-tile-files"]')
      if (tile instanceof HTMLElement) tile.click()
    })
    await delay(600)
  }
  const rowCount = await countRows()
  if (rowCount === 0) return { skipped: '文件树上一行文件都没有(夹具没搭起来)' }

  // ② 落点改「主区域」= 中央区那棵树。
  await page.evaluate((css) => {
    const row = document.querySelector(css)
    row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 }))
  }, rowsCss)
  await delay(400)
  const picked = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
    const center = items.find((el) => /主区域|Main stage/.test(el.textContent ?? ''))
    if (center instanceof HTMLElement) center.click()
    return Boolean(center)
  })
  if (!picked) return { skipped: '行菜单里没有「主区域 / Main stage」那一档' }
  await delay(400)

  // ③ 逐行 ↵ 开进去(↵ = 固定 tab;单击是预览,一片叶至多一个,攒不出多格)。
  const wanted = Math.min(rowCount, 6)
  for (let i = 0; i < wanted; i += 1) {
    await page.evaluate(
      ({ css, at }) => {
        const row = document.querySelectorAll(css)[at]
        if (row instanceof HTMLElement) row.focus()
      },
      { css: rowsCss, at: i },
    )
    await page.keyboard.press('Enter')
    await delay(250)
  }

  /*
   * **W1-b:那条檐搬进了窗口顶栏**(设计 §2.2 D 稿)。所以这一段量的盒换了地方:
   * 从叶顶那条带换成顶栏那条带(`[data-testid="topbar-tabs"]`),动作组换成顶栏
   * 尾格(`[data-testid="topbar-trailing"]`)。三条判据一个字没变 —— 变的只是
   * 「哪一条线上不许换行、谁不许被挤掉」的那个盒。
   */
  const shot = await page.evaluate(() => {
    const band = document.querySelector('[data-testid="topbar-tabs"]')
    if (!band) return { error: '顶栏标签带不在场' }
    const box = band.getBoundingClientRect()
    const tabs = Array.from(band.querySelectorAll('[role="tab"]')).map((el) => {
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width) }
    })
    const listEl = band.querySelector('[role="tablist"]')
    const strip = listEl?.getBoundingClientRect() ?? null
    const trailing = document.querySelector('[data-testid="topbar-trailing"]')
    const actions = trailing?.getBoundingClientRect() ?? null
    const bar = document.querySelector('[data-testid="topbar"]')?.getBoundingClientRect() ?? null
    /*
     * **肩**(W3-b `joined` 档):活动 tab 底部两侧那两块反向圆角,长在它盒子之外
     * 各 `--tab-shoulder`。它们是伪元素,量不到矩形 —— 所以量的是那句撑着它们的
     * 等式:**条的左右内边距 ≥ 肩的边长**。肩因此在任何一格上都落在条里,
     * 「肩不许撑出组的跨度」这句话由几何保证,不靠算。
     */
    const listStyle = listEl ? getComputedStyle(listEl) : null
    const shoulder = listEl
      ? {
          look: listEl.getAttribute('data-look'),
          padLeft: Math.round(parseFloat(listStyle.paddingLeft) || 0),
          padRight: Math.round(parseFloat(listStyle.paddingRight) || 0),
          size: Math.round(
            parseFloat(getComputedStyle(listEl).getPropertyValue('--tab-shoulder')) || 0,
          ),
          scrollWidth: Math.round(listEl.scrollWidth),
          clientWidth: Math.round(listEl.clientWidth),
        }
      : null
    return {
      tabs,
      shoulder,
      // 「檐的盒」在 D 稿里就是**整条顶栏**:动作组坐在它的尾格里,不在带子里。
      chrome: bar
        ? { left: Math.round(bar.left), right: Math.round(bar.right), height: Math.round(bar.height) }
        : { left: Math.round(box.left), right: Math.round(box.right), height: Math.round(box.height) },
      band: { left: Math.round(box.left), right: Math.round(box.right) },
      strip: strip ? { left: Math.round(strip.left), right: Math.round(strip.right) } : null,
      actions: actions
        ? { left: Math.round(actions.left), right: Math.round(actions.right), width: Math.round(actions.width) }
        : null,
      /*
       * **W7-c 裁定 1:标签从顶栏自己的开头排**。第一格的左缘 = 红绿灯让位的右缘
       * (全屏时让位归 0,所以那时它就是顶栏的左缘)。从前那颗「分屏」钮的在场判据
       * 删了(裁定 2:那颗钮没了),换上来的是这一格与下面「右端两件」那一格。
       */
      trafficRight: (() => {
        const t = document.querySelector('[data-testid="topbar-traffic"]')
        return t ? Math.round(t.getBoundingClientRect().right) : null
      })(),
      firstTabLeft: (() => {
        const first = band.querySelector('[role="tab"]')
        return first ? Math.round(first.getBoundingClientRect().left) : null
      })(),
      trailingButtons: Array.from(
        document.querySelectorAll('[data-testid="topbar-trailing"] button'),
      ).map((el) => {
        const r = el.getBoundingClientRect()
        return {
          label: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
        }
      }),
      hasSplitButton: Boolean(document.querySelector('[data-testid^="pane-split:"]')),
    }
  })
  if (shot.error) return { skipped: shot.error }
  if (shot.tabs.length < 2) return { skipped: `顶栏标签组上只有 ${shot.tabs.length} 格 tab` }
  /*
   * D 稿多一条判据:**标签带自己越不过尾格的左缘**。「永不挤掉右端动作组」在
   * 布局上就是这一句 —— 带子是 flex 项、组是它的绝对定位子孙,所以组再宽也出不去。
   * 少了这一条,组直接压到 AgentChip 上而 tab 条的三条判据仍然全绿。
   */
  if (shot.actions && shot.band.right > shot.actions.left + 1) {
    problems.push(`标签带越过了尾格左缘(带右缘 ${shot.band.right} > 尾格 ${shot.actions.left})`)
  }
  /*
   * ── W7-c 裁定 2:**顶栏右端只留两件**(⋯ 与 AgentChip)───────────────────
   * 「分屏」那颗钮删了 —— 它再长回来就是减法白做了。上限是**两件**:那颗 ⋯ 只在
   * 有够不着的标签时才画,所以下限不判(判了会在一条干净的条上假红)。
   */
  if (shot.hasSplitButton) problems.push('顶栏尾格里又长出了「分屏」那颗钮(W7-c 裁定 2:它删了)')
  seen.push(`右端 ${shot.trailingButtons.length} 件:${shot.trailingButtons.map((b) => b.label).join(' / ') || '—'}`)
  if (shot.trailingButtons.length > 2) {
    problems.push(
      `顶栏右端多于两件(实测 ${shot.trailingButtons.length}:`
        + `${shot.trailingButtons.map((b) => b.label).join(' / ')})`,
    )
  }
  // 右端那几件**不许被挤掉**:每一件都得有真身量,而且待在顶栏里。
  for (const b of shot.trailingButtons) {
    if (b.width <= 0) problems.push(`右端「${b.label}」被挤成 0 宽`)
    if (b.right > shot.chrome.right + 1) {
      problems.push(`右端「${b.label}」被挤出顶栏(右缘 ${b.right} > ${shot.chrome.right})`)
    }
  }

  /*
   * ── W7-c 裁定 1:**第一格标签的左缘 = 红绿灯让位的右缘** ────────────────
   * 从前它对齐的是中央叶那个矩形(`leaf-geometry` 量出来的跨度);v3 单叶之后
   * 那件事没有对象了,标签从顶栏自己的开头排。全屏时让位归 0 —— 那时这一条读作
   * 「第一格贴着顶栏左缘」,同一句话不必分两档。容差 2px:让位那格宽度在过渡里
   * 走 `--dur`,量到半路会差一两个像素。
   */
  if (shot.firstTabLeft === null || shot.trafficRight === null) {
    problems.push('量不到第一格标签或红绿灯让位')
  } else {
    seen.push(
      `带子左缘 ${shot.band.left} / 让位右缘 ${shot.trafficRight} / 第一格左缘 ${shot.firstTabLeft}`,
    )
    /*
     * **带子的左缘就是让位的右缘** —— 这是「从顶栏自己的开头排」那句话的字面量法。
     * 从前它对齐的是中央叶那个矩形(`leaf-geometry` 量出来的跨度),v3 单叶之后那件
     * 事没有对象了。全屏时让位归 0,这一条读作「带子贴着顶栏左缘」,同一句话不分档。
     */
    if (Math.abs(shot.band.left - shot.trafficRight) > 2) {
      problems.push(
        `标签带没有从让位右边起(带左缘 ${shot.band.left} ≠ 让位右缘 ${shot.trafficRight})`
          + ' —— W7-c 裁定 1:标签从顶栏自己的开头排',
      )
    }
    /*
     * 第一格 tab 与带子左缘之间**只许隔一个肩**(`--tab-shoulder`:`joined` 档活动
     * 标签底部两侧那两块反向圆角要落在条里,所以条有那么宽的内边距)。这一条挡的是
     * 「又有人在前面塞了一格」——那正是从前那套几何偏移回来的样子。
     */
    const shoulder = shot.shoulder?.padLeft ?? 0
    if (shot.firstTabLeft - shot.band.left > shoulder + 2) {
      problems.push(
        `第一格标签与带子左缘之间多出一段(${shot.firstTabLeft - shot.band.left} > 肩 ${shoulder})`,
      )
    }
  }

  /* ── W3-b:`joined` 档的两条 ─────────────────────────────────────────── */
  if (!shot.shoulder) {
    problems.push('顶栏那条 tablist 不在场')
  } else {
    seen.push(
      `look=${shot.shoulder.look} 肩 ${shot.shoulder.size} 内边距 ${shot.shoulder.padLeft}/${shot.shoulder.padRight}`,
    )
    if (shot.shoulder.look !== 'joined') {
      problems.push(`顶栏那条条不是 joined 档(读数 ${shot.shoulder.look})`)
    }
    if (shot.shoulder.size <= 0) problems.push('--tab-shoulder 没解析出来(joined 档的肩塌了)')
    if (
      shot.shoulder.padLeft < shot.shoulder.size
      || shot.shoulder.padRight < shot.shoulder.size
    ) {
      problems.push(
        `条的内边距小于肩(${shot.shoulder.padLeft}/${shot.shoulder.padRight} < ${shot.shoulder.size})—— 首末格是活动态时肩会被裁掉`,
      )
    }
  }

  seen.push(`${shot.tabs.length} 格 tab`)
  const tops = [...new Set(shot.tabs.map((t) => t.top))]
  seen.push(`top 取值 ${tops.length} 种`)
  if (tops.length !== 1) problems.push(`tab 条换行了(top 有 ${tops.length} 种:${tops.join(' / ')})`)

  if (!shot.actions) {
    problems.push('右端动作组不在场(分屏那颗钮应当恒在)')
  } else {
    seen.push(`动作组 ${shot.actions.left}–${shot.actions.right}(檐右缘 ${shot.chrome.right})`)
    if (shot.actions.right > shot.chrome.right + 1) {
      problems.push(`动作组被挤出檐外(右缘 ${shot.actions.right} > ${shot.chrome.right})`)
    }
    if (shot.actions.width <= 0) problems.push('动作组宽度塌成 0')
    if (shot.strip && shot.strip.right > shot.actions.left + 1) {
      problems.push(`tab 条与动作组重叠(${shot.strip.right} > ${shot.actions.left})`)
    }
  }

  /*
   * ── ③b 超量档:30 格 tab(W3-b)────────────────────────────────────────
   * 「多 tab 永不换行」在 6 格上量不出来 —— 6 格根本不会溢出。这一段把条灌到 30 格,
   * 再问三件事:**还是一条线**(不换行)、**动作组没被顶出去**、**条自己横滚了**
   * (`scrollWidth > clientWidth`)。第三条是前两条能同时成立的**唯一**方式:
   * 不横滚的话,30 格要么换行、要么把 tab 压成看不清的一条缝、要么把动作组挤出檐。
   */
  const targetTabs = 30
  const extra = Math.min(rowCount, targetTabs) - wanted
  for (let i = 0; i < extra; i += 1) {
    await page.evaluate(
      ({ css, at }) => {
        const row = document.querySelectorAll(css)[at]
        if (row instanceof HTMLElement) row.focus()
      },
      { css: rowsCss, at: wanted + i },
    )
    await page.keyboard.press('Enter')
    await delay(120)
  }
  await delay(300)
  const many = await page.evaluate(() => {
    const band = document.querySelector('[data-testid="topbar-tabs"]')
    const list = band?.querySelector('[role="tablist"]')
    if (!list) return null
    const tabs = Array.from(list.querySelectorAll('[role="tab"]')).map((el) => {
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top), width: Math.round(r.width) }
    })
    const style = getComputedStyle(list)
    const trailing = document.querySelector('[data-testid="topbar-trailing"]')?.getBoundingClientRect()
    const bar = document.querySelector('[data-testid="topbar"]')?.getBoundingClientRect()
    return {
      count: tabs.length,
      tops: [...new Set(tabs.map((t) => t.top))],
      minWidth: tabs.length ? Math.min(...tabs.map((t) => t.width)) : 0,
      overflowX: style.overflowX,
      flexWrap: style.flexWrap,
      scrollWidth: Math.round(list.scrollWidth),
      clientWidth: Math.round(list.clientWidth),
      actionsRight: trailing ? Math.round(trailing.right) : null,
      barRight: bar ? Math.round(bar.right) : null,
    }
  })
  if (!many) {
    problems.push('超量档:顶栏那条条不在场')
  } else {
    seen.push(
      `超量 ${many.count} 格:top ${many.tops.length} 种 · 滚 ${many.scrollWidth}/${many.clientWidth} · 最窄 ${many.minWidth}`,
    )
    if (many.count < 12) {
      problems.push(`超量档只攒出 ${many.count} 格 tab(夹具里的文件不够)`)
    }
    if (many.tops.length !== 1) {
      problems.push(`超量档 tab 条换行了(top 有 ${many.tops.length} 种:${many.tops.join(' / ')})`)
    }
    if (many.flexWrap === 'wrap') problems.push('超量档:条声明了 flex-wrap: wrap')
    if (!/auto|scroll/.test(many.overflowX)) {
      problems.push(`超量档:条不横滚(overflow-x=${many.overflowX})`)
    }
    if (many.scrollWidth <= many.clientWidth) {
      problems.push(
        `超量档:${many.count} 格都塞进了一条 ${many.clientWidth}px 的条(该溢出并横滚,读数 ${many.scrollWidth})`,
      )
    }
    if (many.minWidth <= 0) problems.push('超量档:有 tab 被压成 0 宽')
    if (many.actionsRight !== null && many.barRight !== null && many.actionsRight > many.barRight + 1) {
      problems.push(`超量档:动作组被顶出顶栏(${many.actionsRight} > ${many.barRight})`)
    }
  }

  /*
   * ── ③c **溢出要有鼠标出口**(W7-t / B1)──────────────────────────────────
   *
   * ③b 证的是「30 格塞不下时条会横滚」。审计 B 第 1 条量出来的病是**下一句**:
   * 会滚 ≠ 够得着 —— 13 格时 4 格整颗看不见,而条上竖滚轮 120 `scrollLeft`
   * 一格不动、右端没有 ⋯ 也没有箭头,**鼠标用户到不了那几格**。所以这一档
   * 问的是三件「出口」:
   *  ① 条上的**竖滚轮**映射成横滚(`ui/Tabs` 自己那一口:只映射 `deltaY`,
   *    原生监听 + `passive:false` —— 不拦的话这一下会滚外面那个竖容器);
   *  ② 条溢出时右端**有一颗 ⋯**,表里列得出够不着的那几格;
   *  ③ 点其中一格 → 它**变成活动格,而且整颗落进条的视野里**。
   *
   * 滚轮走的是 playwright 的 `mouse.wheel`(底下是 CDP `Input.dispatchMouseEvent`
   * 的 mouseWheel)—— 只进这个窗口,不动真光标(09-01 那条纪律)。
   * **反证**:把 `ui/Tabs` 里那段 wheel effect 删掉 → ① 当场红。
   *
   * ── **「+1」:表里必须两节同时在场**(09-06 审查补的一格)────────────────
   * 裁定的原话是「⋯ 出现且列出 4+1 格」—— 4 格滚出视野的 + 1 格**隐藏的**,
   * **一颗钮一张表两节**。只量滚出视野那几格的话,这一档量到的是半件事:
   * 合表这个裁定的全部内容就是「两种成因合成一张表」,而两节从未同屏出现过的
   * 门证不出它们合过。所以夹具先经**用户真走的那条路**(树行右键 →「隐藏」)
   * 藏掉一格,再断言两节的小标题都在、两节的项加起来 ≥ 4+1。
   */
  // 先藏一格:树行右键 →「隐藏」(动作单产地 = 右键菜单,与用户走的是同一条路)。
  const hid = await page.evaluate(async ({ css }) => {
    const row = document.querySelector(css)
    if (!(row instanceof HTMLElement)) return { ok: false, why: '树上没有文件行' }
    const name = row.getAttribute('data-file-path') ?? ''
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 }))
    await new Promise((r) => setTimeout(r, 260))
    const items = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
    const hide = items.find((el) => /^(隐藏|Hide)$/.test((el.textContent ?? '').trim()))
    if (!(hide instanceof HTMLElement)) {
      // 表开着就关掉它,别把一张浮层留给下一档。
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return { ok: false, why: `右键表里没有「隐藏」(${items.length} 项)` }
    }
    hide.click()
    return { ok: true, name }
  }, { css: rowsCss })
  await delay(450)
  seen.push(`B1 夹具:藏一格 ${hid.ok ? hid.name : `失败(${hid.why})`}`)
  if (!hid.ok) problems.push(`B1:夹具藏不掉一格标签 —— ${hid.why}(两节同屏这一条量不成)`)
  // 先把条滚回头:点第一格 tab(条自己会把活动格滚进视野)。
  await page.evaluate(() => {
    const first = document.querySelector('[data-testid="topbar-tabs"] [role="tablist"] [role="tab"]')
    if (first instanceof HTMLElement) first.click()
  })
  await delay(450)
  const reach = await page.evaluate(() => {
    const list = document.querySelector('[data-testid="topbar-tabs"] [role="tablist"]')
    if (!list) return null
    const r = list.getBoundingClientRect()
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      scrollLeft: Math.round(list.scrollLeft),
      room: Math.round(list.scrollWidth - list.clientWidth),
    }
  })
  if (!reach) {
    problems.push('B1:顶栏那条 tablist 不在场')
  } else if (reach.room <= 0) {
    problems.push('B1:条没有可滚的余量 —— 上一档说它溢出了,这一档却滚不动')
  } else {
    await page.mouse.move(reach.x, reach.y)
    await page.mouse.wheel(0, 120)
    await delay(350)
    const rolled = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="topbar-tabs"] [role="tablist"]')
      return list ? Math.round(list.scrollLeft) : -1
    })
    seen.push(`B1 竖滚轮 120:scrollLeft ${reach.scrollLeft} → ${rolled}(余量 ${reach.room})`)
    if (!(rolled > reach.scrollLeft)) {
      problems.push(
        `B1:条上竖滚轮 120 之后 scrollLeft 没动(${reach.scrollLeft} → ${rolled})—— 鼠标够不着滚出去的那几格`,
      )
    }

    // ② 右端那颗 ⋯(「够不着的标签」:看不见的 ∪ 隐藏的,一颗钮一张表两节)。
    const dots = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid^="pane-hidden:"]')
      if (!(btn instanceof HTMLElement)) return null
      btn.click()
      return btn.getAttribute('aria-label') ?? ''
    })
    if (dots === null) {
      problems.push('B1:条溢出了,右端却没有那颗「够不着的标签 ⋯」')
    } else {
      await delay(400)
      const table = await page.evaluate(() => {
        const menu = document.querySelector('[role="menu"]')
        const items = Array.from(menu?.querySelectorAll('[role="menuitem"]') ?? [])
        /*
         * **两节各有几项**:节小标题是 `role="presentation"`(`ui/Menu` 的
         * `MenuSection`),所以按 DOM 次序走一遍菜单的孩子,遇到小标题换节。
         * 不按文案认节 —— 文案是 i18n 的,双语各一份;节的**结构**才是判据,
         * 而两节的名字另外单独读出来给人看。
         */
        const sections = []
        for (const child of Array.from(menu?.children ?? [])) {
          if (child.getAttribute('role') === 'presentation') {
            sections.push({ label: (child.textContent ?? '').trim(), rows: [] })
          } else if (child.getAttribute('role') === 'menuitem' && sections.length > 0) {
            sections[sections.length - 1].rows.push((child.textContent ?? '').trim())
          }
        }
        return {
          open: Boolean(menu),
          count: items.length,
          sections: sections.map((sec) => ({ label: sec.label, n: sec.rows.length })),
          /*
           * 最后一项的**名字**要读它那一格主文本(`.menuMain`),不是整项的
           * `textContent` —— 隐藏那一节的每项后面还挂着一句「已隐藏」的尾注
           * (`.menuTrail`),连着读会得到「xxx.ts已隐藏」,与标签上的名字对不上。
           */
          last: (
            items[items.length - 1]?.querySelector('[class*="menuMain"]')?.textContent
            ?? items[items.length - 1]?.textContent
            ?? ''
          ).trim(),
        }
      })
      seen.push(
        `B1 ⋯「${dots}」列出 ${table.count} 格,${table.sections.length} 节:`
        + table.sections.map((sec) => `${sec.label}×${sec.n}`).join(' / '),
      )
      if (!table.open) problems.push('B1:那颗 ⋯ 点开没有表')
      /*
       * **两节同时在场**(裁定的「4+1」那个加号):看不见的那节 + 隐藏的那节。
       * 两节各自至少一项 —— 一节空就不画那一节是产品的规矩,而这一刻夹具两边都
       * 有货,只画出一节说明合表没合成。
       */
      if (table.sections.length !== 2 || table.sections.some((sec) => sec.n < 1)) {
        problems.push(
          `B1:那张表不是「两节同时在场」的样子(读到 ${table.sections.length} 节:`
          + `${table.sections.map((sec) => `${sec.label}×${sec.n}`).join(' / ') || '—'})`
          + ' —— 一颗钮一张表两节,看不见的 ∪ 隐藏的',
        )
      }
      if (table.count < 5) {
        problems.push(
          `B1:表里只列出 ${table.count} 格(该是 4 格看不见的 + 1 格隐藏的,至少 5)`,
        )
      }
      if (table.count > 0) {
        /*
         * ③ 点**最后一项** → 它成为活动格,而且**整颗**落进条的视野里。
         * 最后一项恰是**隐藏那一节**里的一格(隐藏节画在第二节),所以这一下量的
         * 正是裁定里的那个「+1」:藏起来的那一格也能从这张表里点回来、点回来之后
         * 与「看不见的」那一节里的格走的是同一条落定路(激活 + 滚进视野)。
         */
        if (table.sections.length === 2 && table.sections[1].n < 1) {
          problems.push('B1:最后一项不在「隐藏的」那一节里 —— 下面量的不是「+1」那一格')
        }
        await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
          const last = items[items.length - 1]
          if (last instanceof HTMLElement) last.click()
        })
        await delay(550)
        const landed = await page.evaluate((eps) => {
          const list = document.querySelector('[data-testid="topbar-tabs"] [role="tablist"]')
          const on = list?.querySelector('[role="tab"][aria-selected="true"]')
          if (!list || !on) return null
          const lb = list.getBoundingClientRect()
          const ab = on.getBoundingClientRect()
          return {
            label: (on.querySelector('[class*="label"]')?.textContent ?? '').trim(),
            // 容差与 `ui/Tabs.clippedTabIds` **同源**(见 `tabClipEpsilonPx`)。
            fully: ab.left >= lb.left - eps && ab.right <= lb.right + eps,
            menuGone: !document.querySelector('[role="menu"]'),
          }
        }, tabClipEpsilonPx())
        if (!landed) {
          problems.push('B1:点完那一格之后读不到活动 tab')
        } else {
          seen.push(`B1 选中「${landed.label}」完全可见=${landed.fully}`)
          if (!landed.menuGone) problems.push('B1:选了一格之后那张表没关')
          if (landed.label !== table.last) {
            problems.push(`B1:选的是「${table.last}」,活动格却是「${landed.label}」`)
          }
          if (!landed.fully) problems.push('B1:选中的那一格没有完全滚进条的视野里')
        }
      }
    }
  }

  /*
   * ④ **二合一一次,量那条分隔杆 + 两格标签的标题 + 格头**(W6-a,设计 §6)。
   *
   * W6-a 之前这里量的是「分屏之后中央区那条分隔杆」。中央区收成一条标签条之后
   * 那一形在那里不存在了(单叶政策,§2.1),而它要守的挤压纪律**原样搬到了两格
   * 标签上**,而且多了两件只有两格标签才有的:
   *  · 标签上那个 `A ⫽ B` 最大宽 260(`--tab-wide-max`),长了**只截断不换行**;
   *  · 每格顶上那条 28px 的格头:一行,名字截断,那颗钮不被挤出去。
   *
   * ── W7-t / B6:先挑一格**长名字的**标签,再与它右边那一格并 ────────────
   * 修前这一步并的是「此刻活动的那一格」—— 走到这里活动的是超量档最后开的
   * `zz-30.ts`,并出来的标签一共十几个字符,**离 260 差得远**:那条「不超过最大宽」
   * 的断言于是在陪跑,而 §6 那个 260 从来没有被真的量到过(实测 W6-a 落地时
   * 标签上限还是 160,门照样全绿)。所以这一档改成:挑条上**标签最长**的那一格
   * (夹具里那两个 50 多字符的文件名之一),再明确走「与**右边**的标签二合一」——
   * 两边都是文件,而且并出来的名字必然撑破常规上限。
   */
  const widest = await page.evaluate(() => {
    const tabs = Array.from(
      document.querySelectorAll('[data-testid="topbar-tabs"] [role="tablist"] [role="tab"]'),
    )
    // 末格没有「右边那一格」可并 —— 这一步走的正是「与右边二合一」。
    const pool = tabs.slice(0, -1)
    let best = null
    for (const el of pool) {
      const label = (el.querySelector('[class*="label"]')?.textContent ?? el.textContent ?? '').trim()
      if (!best || label.length > best.len) best = { len: label.length, label, el }
    }
    if (best?.el instanceof HTMLElement) best.el.click()
    return best ? { len: best.len, label: best.label } : null
  })
  await delay(450)
  seen.push(`二合一挑的是最长那一格:「${widest?.label ?? '—'}」(${widest?.len ?? 0} 字)`)
  /* W7-c 裁定 2:「分屏」那颗钮删了 —— 这张表的开口是**右键那一格标签**。 */
  await page.evaluate(() => {
    const tabs = Array.from(
      document.querySelectorAll('[data-testid="topbar-tabs"] [role="tablist"] [role="tab"]'),
    )
    const active = tabs.find((el) => el.getAttribute('aria-selected') === 'true') ?? tabs[0]
    if (!(active instanceof HTMLElement)) return
    const box = active.getBoundingClientRect()
    active.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: Math.round(box.left + box.width / 2),
        clientY: Math.round(box.top + box.height / 2),
      }),
    )
  })
  await delay(350)
  const joined = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'))
    const enabled = (el) => !(el instanceof HTMLButtonElement && el.disabled)
    // 明确走**右边**那一条(左边那条会把它与更短的邻居并起来,量不到 260 那一档)。
    const right = items.find(
      (el) => /与右边的标签二合一|Join with the tab on the right/.test(el.textContent ?? '') && enabled(el),
    )
    const any = items.find((el) => /二合一|Join with the tab/.test(el.textContent ?? '') && enabled(el))
    const hit = right ?? any
    if (!(hit instanceof HTMLElement)) return false
    hit.click()
    return right ? 'right' : 'any'
  })
  await delay(500)
  if (!joined) {
    problems.push('菜单里没有一条按得动的「二合一」')
    return { problems, seen }
  }
  if (joined !== 'right') seen.push('二合一走的是兜底那一条(「与右边」不可用)')
  const pair = await page.evaluate(() => {
    const el = document.querySelector('[data-testid^="pair-splitter:"]')
    const r = el?.getBoundingClientRect() ?? null
    const heads = Array.from(document.querySelectorAll('[data-pair-head]'))
    const tab = document.querySelector('[data-testid="topbar"] [role="tab"][aria-selected="true"]')
    const label = tab?.querySelector('[class*="label"]')
    /*
     * **两档上限都从声明里读**(W7-t / B6)。260 住在 `--tab-wide-max`(Tabs 族的
     * 一格档位),常规那一档住在 `--tab-max-w` —— 把数字抄进门里,哪天 token
     * 改了门会替一份过期的规格说话(与格头读 `--pair-head-h` 同一条)。
     * 修前这里读的是 `--tab-pair-max`,而那一格已经随 B6 退役 —— 读一个不存在的
     * 变量会静默落进 `: 260` 那个兜底,门于是拿一个**猜来的数**判绿。
     */
    const rootStyle = getComputedStyle(document.documentElement)
    const max = Number.parseFloat(rootStyle.getPropertyValue('--tab-wide-max'))
    const normal = Number.parseFloat(rootStyle.getPropertyValue('--tab-max-w'))
    // 条上一格**没有** `data-tab-wide` 的标签(常规那一档的对照面)。
    const plain = Array.from(
      document.querySelectorAll('[data-testid="topbar-tabs"] [role="tablist"] [role="tab"]'),
    ).find((el) => !el.hasAttribute('data-tab-wide'))
    return {
      wideFlag: tab?.hasAttribute('data-tab-wide') ?? false,
      tabMaxNormal: Number.isFinite(normal) ? normal : 160,
      plainW: plain ? Math.round(plain.getBoundingClientRect().width) : 0,
      /* 标签上那个 `A ⫽ B` 有没有**真的被削**(削了才谈得上「长了各自截断」)。 */
      labelClipped: label
        ? label.scrollWidth > label.clientWidth + 1
          && getComputedStyle(label).textOverflow === 'ellipsis'
        : false,
      labelOverflows: label ? label.scrollWidth > label.clientWidth + 1 : false,
      bar: el
        ? {
            role: el.getAttribute('role'),
            now: Number(el.getAttribute('aria-valuenow')),
            width: Math.round(r.width),
            height: Math.round(r.height),
          }
        : null,
      // 标签上那个 `A ⫽ B`:**只截断不换行**(一行高 + 不超过那格最大宽)。
      tabW: tab ? Math.round(tab.getBoundingClientRect().width) : 0,
      tabMax: Number.isFinite(max) ? max : 260,
      labelOneLine: label
        ? label.getBoundingClientRect().height < 1.6 * Number.parseFloat(getComputedStyle(label).fontSize)
        : false,
      /*
       * 格头:一行、名字截断得动、「拆开」在框里。
       * **`headH` 是声明值,不是猜的**(W6-c):设计 §6 写的 28 住在
       * `--pair-head-h` 里,门读那一格再与实测比 —— 把 28 抄进门里,哪天 token
       * 改了门会替一份过期的规格说话。
       */
      headH: Math.round(
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pair-head-h')) || 0,
      ),
      heads: heads.map((head) => {
        const box = head.getBoundingClientRect()
        const name = head.querySelector('[class*="name"]')
        const btn = head.querySelector('button')
        const nb = btn?.getBoundingClientRect() ?? null
        return {
          h: Math.round(box.height),
          nameClipped: name ? getComputedStyle(name).textOverflow === 'ellipsis' : false,
          /* W7-t / B7:那颗 ✕ **关不掉就不画** —— 在不在场自己是一格事实。 */
          hasBtn: Boolean(btn),
          btnName: btn?.getAttribute('aria-label') ?? '',
          btnInside: nb ? nb.right <= box.right + 1 && nb.left >= box.left - 1 : false,
          /*
           * **一行**(W6-c):两件缺一不可 —— 这一行不许换行(`flex-wrap`),
           * 而且里面每一件都得**竖着落在这条 28px 的带子里**。只量高度是不够的:
           * 高度是 `height:` 钉死的,内容换行只会溢出到带子外面,那一格高度读数
           * 逐字不变 —— 门会当场说绿。
           */
          noWrap: getComputedStyle(head).flexWrap !== 'wrap',
          inside: [name, btn]
            .filter(Boolean)
            .every((el) => {
              const r = el.getBoundingClientRect()
              return r.top >= box.top - 1 && r.bottom <= box.bottom + 1
            }),
        }
      }),
    }
  })
  const bar = pair.bar
  if (!bar) {
    problems.push('二合一之后那条分隔杆不在场')
  } else {
    seen.push(`杆 ${bar.width}×${bar.height} @${bar.now}`)
    if (bar.role !== 'separator') problems.push(`杆的 role 是 ${bar.role},不是 separator`)
    if (!(bar.width > 0 && bar.height > 0)) problems.push(`杆没有排出盒(${bar.width}×${bar.height})`)
    if (!Number.isFinite(bar.now)) problems.push('杆报不出 aria-valuenow')
  }
  seen.push(
    `两格标签 ${pair.tabW}px(宽档上限 ${pair.tabMax} / 常规 ${pair.tabMaxNormal};`
      + `对照的常规格 ${pair.plainW}px)| 格头 ${pair.heads.map((h) => h.h).join('/')}`,
  )
  /*
   * ── W7-t / B6:**更宽的那一档真的落到了这一格上** ────────────────────────
   * 四句话围成一个圈,少一句都能被「其实还是 160」蒙混过去:
   *  · 这一格带着 `data-tab-wide`(那是种类自述 `ContentKind.tabWide` 走完
   *    `TabSpec.wide` 之后在 DOM 上的样子);
   *  · 它**不超过** 260;
   *  · 它**超过**常规那一档 160 —— 这一句才是「宽档生效了」的证据;
   *  · 同一条条上**没戴这一格属性**的标签仍旧不超过 160(档是**这一格**的,
   *    不是整条条的)。
   * **反证**:把 `pairContentKind.tabWide` 删掉 → 第三句当场红(标签缩回 160)。
   */
  if (!pair.wideFlag) {
    problems.push('两格标签没戴 `data-tab-wide` —— 种类自述的那一档没走到 DOM 上')
  }
  if (pair.tabW > pair.tabMax + 1) {
    problems.push(`两格标签超过宽档上限:${pair.tabW} > ${pair.tabMax}`)
  }
  if (pair.tabW <= pair.tabMaxNormal + 1) {
    problems.push(
      `两格标签只有 ${pair.tabW}px,没超过常规上限 ${pair.tabMaxNormal} ——`
        + ' 要么宽档没生效,要么这一格的名字短到量不出这一档(夹具的事)',
    )
  }
  if (pair.plainW > pair.tabMaxNormal + 1) {
    problems.push(
      `常规那一格标签也被放宽到了 ${pair.plainW} > ${pair.tabMaxNormal} —— 宽档该只落在自述过的那一格上`,
    )
  }
  if (!pair.labelOneLine) problems.push('两格标签的标题换行了(挤压纪律:结构行只截断不换行)')
  // 「长了各自截断」:撑破上限的那一格必须是**省略号**收场,不是换行、不是溢出。
  if (pair.labelOverflows && !pair.labelClipped) {
    problems.push('两格标签的标题挤不下,却不是省略号收场(设计 §6:长了各自截断)')
  }
  if (pair.heads.length !== 2) {
    problems.push(`格头不是两条(实测 ${pair.heads.length})`)
  } else {
    /*
     * ── W7-t / B7:格头上那颗钮从「拆开」换成 **✕(只关这一格)** ─────────────
     * 判据因此多一格「在不在场」:那颗 ✕ **关不掉就不画**(`canClosePairSide` ——
     * 与 `ui/Tabs` 那颗逐字同一条:一颗按不动的 ✕ 与「按了没反应」在屏幕上是同一
     * 件事),所以「每格必有一颗钮」是**错的规格**。改成:在场的那些必须在框里、
     * 与名字零重叠,而且**至少有一格在场**(两格都关不掉这一形在这道门的夹具里
     * 不成立 —— 并的是两个文件)。「拆开」退到缝中点那颗小把手,由 ⑥ 收尾那一步验。
     */
    if (!pair.heads.some((head) => head.hasBtn)) {
      problems.push('两格格头上一颗 ✕ 都没有(夹具里并的是两个关得掉的文件)')
    }
    for (const [i, head] of pair.heads.entries()) {
      if (!head.nameClipped) problems.push(`格头 ${i} 的名字不截断`)
      if (head.hasBtn && !head.btnInside) problems.push(`格头 ${i} 的 ✕ 被挤出框`)
      /* ── W6-c:格头 28px 一行不换行 ───────────────────────────────── */
      if (pair.headH > 0 && Math.abs(head.h - pair.headH) > 1) {
        problems.push(`格头 ${i} 的高不是声明的 ${pair.headH}(实测 ${head.h})`)
      }
      if (!head.noWrap) problems.push(`格头 ${i} 声明了 flex-wrap: wrap(结构行只截断不换行)`)
      if (!head.inside) problems.push(`格头 ${i} 里有件竖着掉出了这条 ${head.h}px 的带子(换行了)`)
    }
  }
  seen.push(`格头声明高 ${pair.headH}`)
  /*
   * ── ⑤ **分隔杆推到两头,窄的那一格仍旧有最小格宽**(W6-c,律四)────────────
   *
   * 前面④量的是**缺省比例**下的两格。挤压纪律说的是「每个组件在自己声明的最小
   * 宽度下零重叠」,而两格标签**声明得出**那个最小宽:比例钳在 `PAIR_RATIO_MIN`
   * 20 与 `MAX` 80(`workbench/store.ts`),也就是窄的那一格**永远不少于容器的
   * 20%**。所以这一条走那条杆自己的键盘路(APG 档:Home / End 到两头)把比例
   * 推到极限,再问三件:
   *  · 两格都还排得出盒(谁都没塌成 0);
   *  · 窄的那一格 ≥ 20% 容器宽(钳制真的在);
   *  · **那一档下格头里的件仍旧不重叠、「拆开」仍旧在框里** —— 20% 正是那颗钮与
   *    名字最挤的一档,而 ④ 在 50/50 上永远量不到它。
   * 量完按 ↵ 回缺省(杆自己那一格键盘行为),不给下一步留下一个歪掉的比例。
   *
   * 反证:把 `PAIR_RATIO_MIN` 调成 2,「窄格 ≥ 20%」当场红。
   */
  const clampSeen = []
  for (const key of ['Home', 'End']) {
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid^="pair-splitter:"]')
      if (el instanceof HTMLElement) el.focus()
    })
    await page.keyboard.press(key)
    await delay(350)
    const band = await page.evaluate(() => {
      const box = document.querySelector('[data-testid^="pair:"]')
      const panes = Array.from(document.querySelectorAll('[data-pair-side]'))
      if (!box || panes.length !== 2) return null
      const total = box.getBoundingClientRect().width
      const widths = panes.map((el) => el.getBoundingClientRect().width)
      const heads = Array.from(document.querySelectorAll('[data-pair-head]')).map((head) => {
        const hb = head.getBoundingClientRect()
        const name = head.querySelector('[class*="name"]')
        const btn = head.querySelector('button')
        const nb = btn?.getBoundingClientRect() ?? null
        const rb = name?.getBoundingClientRect() ?? null
        return {
          // 没有那颗 ✕(这一格关不掉)= 没有可被挤出去的东西,不是一条红。
          btnInside: nb ? nb.right <= hb.right + 1 && nb.left >= hb.left - 1 : true,
          // 名字与钮**零重叠**(律四的原话)—— 最窄那一档才量得到。
          clear: nb && rb ? rb.right <= nb.left + 1 : true,
        }
      })
      const now = Number(
        document.querySelector('[data-testid^="pair-splitter:"]')?.getAttribute('aria-valuenow'),
      )
      return { total: Math.round(total), widths: widths.map((w) => Math.round(w)), heads, now }
    })
    if (!band) {
      problems.push(`杆推到 ${key} 之后两格读不出来`)
      continue
    }
    clampSeen.push(`${key}→${band.now}% ${band.widths.join('/')} of ${band.total}`)
    const min = Math.min(...band.widths)
    if (min <= 0) problems.push(`杆推到 ${key}:有一格塌成了 0(${band.widths.join('/')})`)
    // 20% 的下界,留 2px 给缝与亚像素。
    if (band.total > 0 && min < band.total * 0.2 - 2) {
      problems.push(
        `杆推到 ${key}:窄的那一格 ${min} < 最小格宽 ${Math.round(band.total * 0.2)}(比例 ${band.now}%)`,
      )
    }
    for (const [i, head] of band.heads.entries()) {
      if (!head.btnInside) problems.push(`杆推到 ${key}:格头 ${i} 的 ✕ 被挤出框`)
      if (!head.clear) problems.push(`杆推到 ${key}:格头 ${i} 的名字与 ✕ 重叠`)
    }
  }
  seen.push(`杆到两头 ${clampSeen.join(' · ')}`)
  // ↵ 回缺省 —— 杆自己那一格键盘行为,不给下一步留下歪比例。
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid^="pair-splitter:"]')
    if (el instanceof HTMLElement) el.focus()
  })
  await page.keyboard.press('Enter')
  await delay(300)

  /*
   * **收尾:拆回去**。两格那一种自述 `fullable: false`(与会话那一种同一条理由),
   * 留着它当活动格的话,下一步(10d 全屏檐带)按 ⌘⇧↩ 会被结构化拒绝 —— 那一步
   * 量的是檐带的几何,不该被上一步留下的形态挡住。
   */
  /*
   * **拆开只有一颗,而且长在两格中间那条缝上**(W7-t / B7)。格头 = 身份 + 关这
   * 一格,拆开作用在**整格标签**上,所以它不属于任何一格的格头。修前这里是两颗
   * 一模一样的「拆开」(一件事画两遍),而「只关这一格」一处都没有。
   */
  const seam = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('[data-testid^="pair-unpair:"]'))
    const box = document.querySelector('[data-testid^="pair:"]')?.getBoundingClientRect() ?? null
    const one = btns[0]?.getBoundingClientRect() ?? null
    const inHead = btns.some((el) => el.closest('[data-pair-head]'))
    return {
      count: btns.length,
      inHead,
      // 「在缝上」= 它横向落在两格中线附近(缝自己就在那里)。
      onSeam: box && one ? Math.abs(one.left + one.width / 2 - (box.left + box.width / 2)) < box.width : false,
      closes: Array.from(document.querySelectorAll('[data-testid^="pair-close:"]')).length,
    }
  })
  seen.push(`拆开 ${seam.count} 颗(在格头里:${seam.inHead})· 格头 ✕ ${seam.closes} 颗`)
  if (seam.count !== 1) problems.push(`「拆开」不是一颗(实测 ${seam.count} 颗)`)
  if (seam.inHead) problems.push('「拆开」长在格头里 —— 它作用在整格标签上,不属于任何一格')
  if (seam.count === 1 && !seam.onSeam) problems.push('「拆开」没长在两格中间那条缝上')
  if (seam.closes < 1) problems.push('格头上一颗 ✕ 都没有(B7:关这一格是格头自己的事)')

  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid^="pair-unpair:"]')
    if (btn instanceof HTMLElement) btn.click()
  })
  await delay(400)
  return { problems, seen }
}

async function main() {
  if (!existsSync(serverEntry)) {
    console.error(
      `[squeeze-gate] 找不到 ${path.relative(repoRoot, serverEntry)} —— 先在仓根跑 \`bun run server:build\``,
    )
    process.exit(1)
  }
  if (!existsSync(mainEntry) || !existsSync(path.join(appRoot, 'dist/index.html'))) {
    console.error('[squeeze-gate] 找不到构建产物 —— 先跑 `npm run app:build`')
    process.exit(1)
  }

  const store = await mkdtemp(path.join(tmpdir(), 'squeeze-gate-store-'))
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'squeeze-gate-userdata-'))
  /*
   * 组目录的真根。**真建出来**,并且递绝对路径 —— 理由见 PROJECT_DIR_NAMES
   * 上面那段(local-trust 之后沙箱不再夹持,路径被逐字当真)。
   */
  const projectsRoot = await mkdtemp(path.join(tmpdir(), 'squeeze-gate-projects-'))
  /** 组名(= 路径末段)→ 它的绝对路径。种子步只问这张表,不再自己拼路径。 */
  const projectDirs = new Map()
  for (const name of PROJECT_DIR_NAMES) {
    const full = path.join(projectsRoot, name)
    await mkdir(full, { recursive: true })
    /*
     * 每个项目目录里种几份**真文件**:W1 那一步(叶檐)要在中央区开出好几格 tab,
     * 而开 tab 的路只有一条 —— 文件树(撤掉 Viewer 瓦之后,T0 拍点甲)。
     * 名字故意一长一短:挤压量的是「这一条会不会换行 / 会不会把右端动作组顶出去」,
     * 而那件事对长名最敏感。
     */
    for (const file of [...LEAF_TAB_FILES, ...OVERFLOW_TAB_FILES]) {
      await writeFile(path.join(full, file), `export const squeeze = '${file}'\n`)
    }
    projectDirs.set(name, full)
  }
  let server
  let app
  const failures = []
  try {
    console.log('\n[1/11] 起一台 core,种下四种项目名形状 + 一组无项目')
    server = spawn(process.execPath, [serverEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        // `ONETHING_SERVER_WORKSPACE_ROOT` 已退役:local-trust 之后工作目录不再被
        // 夹进 workspaceRoot,种子递的是真实绝对路径(见 PROJECT_DIR_NAMES 那段)。
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const serverErr = []
    server.stderr.on('data', (chunk) => serverErr.push(chunk.toString()))

    const rec = await waitFor('core 写出发现文件', () => {
      const found = readDiscovery(store)
      return found && found.pid === server.pid ? found : undefined
    }).catch((error) => {
      throw new Error(`${error.message}\nserver stderr:\n${serverErr.join('')}`)
    })
    if (!(await portConnects(rec.host, rec.port))) throw new Error('core 端口连不上')

    let seeded = 0
    for (const group of SEED_PROJECTS) {
      for (const name of group.names) {
        const result = await rpc(rec, 'sessions', 'create', { name })
        const id = result?.session?.id
        if (!id) throw new Error(`sessions.create 没给出会话 id:${JSON.stringify(result)}`)
        if (group.dir) {
          const full = projectDirs.get(group.dir)
          const wrote = await rpc(rec, 'sessions', 'updateWorkingDirectory', {
            sessionId: id,
            workingDirectory: full,
          })
          // 这条 RPC 的失败是**返回值里的 success:false**,不是 HTTP 错误 ——
          // 不检查它,种子就会静默退化成「全都没有工作目录」(这条检查本身
          // 正是 08-31 抓到 local-trust 那次行为变化的那只手,别拆)。
          if (wrote?.success !== true) {
            throw new Error(`工作目录没写进去(${full}):${JSON.stringify(wrote)}`)
          }
        }
        await rpc(rec, 'sessions', 'addSystemMessage', {
          sessionId: id,
          message: {
            id: `squeeze-${id}`,
            role: 'user',
            content: `${name}:一段够长的预览正文,长到窄档里必须靠钳行而不是靠换行来收场。`,
            timestamp: Date.now(),
          },
        })
        seeded += 1
      }
    }
    console.log(`  ✓ 种了 ${seeded} 条会话 / ${SEED_PROJECTS.length} 组(4 个项目 + 无项目)`)

    console.log('\n[2/11] 拉起应用(独立 --user-data-dir),把会话总览钉到右架子')
    app = await electron.launch({
      executablePath: electronBinary,
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        ONETHING_STORE_PATH: store,
        ONETHING_REACT_DEV_SERVER_URL: '',
        /*
         * **离屏起窗**(09-04 S4 立的纪律「真机门不许抢用户的机器」)。窗子不 show()、
         * 不进 Dock;页面照样渲染、照样跑布局与 rAF,焦点由 CDP
         * `Emulation.setFocusEmulationEnabled` 补上(只进这个窗口,不动真光标)。
         */
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
    await switchDefaultOpenToPinned(page)
    /*
     * **显式选一次「右侧栏」**(W6-a)。这道门后面每一步问的都是
     * `[data-shelf-body="right"]`,而 W6-a 给会话总览那块瓦补了一格
     * `defaultPlacement: 左架子`(设计 §8);解析序是**记忆 > 天生 > 全局默认档**,
     * 所以「全局默认档 = 钉右边」压不过那一格天生落点 —— 它会落到左边去。
     * 用户亲手选一次(右键 → 打开方式)写的是**记忆**,记忆压过天生:这既是
     * 用户真走的那条路,也让这道门量的仍旧是右架子那一形。
     */
    await page.evaluate(() => {
      const tile = document.querySelector('[data-testid="dock-tile-sessions"]')
      if (tile instanceof HTMLElement) {
        tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }))
      }
    })
    await new Promise((r) => setTimeout(r, 400))
    await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
      const right = items.find((el) => /^(Right|右侧栏|右边)$/.test((el.textContent ?? '').trim()))
      if (right instanceof HTMLElement) right.click()
    })
    await waitFor('架子上出现会话总览', () =>
      page.evaluate(
        () => document.querySelector('[data-shelf-body="right"]')?.dataset.panel === 'sessions',
      ),
    )
    await waitFor('总览画出会话卡', () =>
      page.evaluate(() => document.querySelectorAll('[data-session-id]').length > 0),
    )
    console.log('  ✓ 钉上了,卡也画出来了')

    console.log('\n[3/11] 律三的预留检查(粘性覆盖的代价)')
    const reservation = await checkStickyReservation(page)
    if (reservation.error) throw new Error(reservation.error)
    if (reservation.problems.length) {
      for (const problem of reservation.problems) console.log(`  ✗ ${problem}`)
      failures.push(`粘性覆盖没有布局预留:${reservation.problems.length} 条`)
    } else {
      console.log(`  ✓ ${reservation.checked} 个粘性元素,滚动坐标系里都留够了位置`)
    }

    /*
     * 同一条律的第二处预留:Dock 常显钉边时,主输入按不按得到。
     * 与上一步分开报,是因为它们是**两个坐标系**里的同一件事(滚动 / 屏幕),
     * 红起来该修的地方也不同 —— 一条门该指得出该谁修。
     */
    console.log('\n[4/11] 律三的预留检查(Dock 常显覆盖的代价:主输入可达性)')
    const dockReserve = await checkDockReservation(page)
    if (dockReserve.error) throw new Error(dockReserve.error)
    if (dockReserve.skipped) {
      console.log(`  · ${dockReserve.skipped}`)
    } else if (dockReserve.problems.length) {
      for (const problem of dockReserve.problems) console.log(`  ✗ ${problem}`)
      failures.push(`Dock 覆盖没有布局预留:${dockReserve.problems.length} 条`)
    } else {
      console.log(`  ✓ composer 四件全可达(${dockReserve.readings.join(' · ')})`)
    }

    console.log('\n[5/11] 律三的预留检查(竖排 Dock:侧架子内容可达性)')
    for (const edge of ['right', 'left']) {
      const side = await checkSideShelfReach(page, edge)
      if (side.error) throw new Error(side.error)
      if (side.covered) {
        console.log(`  ✗ Dock 钉${edge}:侧架子里 ${side.covered}/${side.sampled} 个内容采样落在 Dock 底下(最右内容盒 ${side.rightMost},条左缘 ${side.stripLeft})`)
        for (const e of side.examples) console.log(`      ${e}`)
        failures.push(`Dock 钉${edge}:侧架子内容被盖 ${side.covered} 处`)
      } else {
        console.log(`  ✓ Dock 钉${edge}:侧架子 ${side.sampled} 个内容采样零被盖(最右内容盒 ${side.rightMost} vs 条左缘 ${side.stripLeft})`)
      }
    }
    /* 这一步换过 Dock 的边,**必须换回来**:后面两场景量的是架子厚度下的排版,
     * 竖排 Dock 会把主区宽度整个改掉,不还原就是拿另一套布局去判它们(试过,红一档)。 */
    await checkSideShelfReach(page, 'bottom')

    console.log('\n[6/11] 律二:composer 工具行不折行、不悬中(09-03 报障的产地)')
    const narrow = await narrowComposerTo(app, page, TARGET_PANEL_W)
    console.log(
      `    窗口宽 ${narrow.width} → composer 面板宽 ${narrow.panel.toFixed(1)}(目标 ${TARGET_PANEL_W})`,
    )
    try {
      await typeSixLines(page)
      const toolRow = await checkComposerToolRow(page)
      if (toolRow.error) throw new Error(toolRow.error)
      console.log(`    ${toolRow.readings.join(' | ')}`)
      if (toolRow.problems.length) {
        for (const problem of toolRow.problems) console.log(`  ✗ ${problem}`)
        failures.push(`composer 工具行:${toolRow.problems.length} 条`)
      } else {
        console.log('  ✓ 药丸单行 · 四件全在输入面之下 · 四件同一条竖中线')
      }
    } finally {
      /* 敲进去的字与窗口尺寸都要还原:后面两个场景量的是架子厚度下的排版,
       * 多一块六行高的输入面、少几百像素的窗口宽,量的就是另一套布局。 */
      await clearComposer(page).catch(() => {})
      await narrow.restore()
      /*
       * ── 第三样**不还了**:被窄窗收起来的那条架子由产品自己展开(W7-d 裁定 2)──
       * 窗子缩到 320 时共同预算(`stage/transitions.reclampShelves`,W7-p 裁定 3)
       * 判定右架子摆不下,把它收成细梁。W7-c 那会儿**没有反向的一句**,于是这里
       * 手动点了一下细梁上的把手把它展开 —— 否则下一步「五档厚度」找不到那根拖杆
       * (`[role="separator"]` 只在展开时画),当场抛「厚度没拖到位:实际 -1」。
       *
       * W7-d 给了反向那一句(`collapsedBy: 'budget'` + 归还那一趟),所以这一步
       * **靠产品**:`narrow.restore()` 把窗还回去,`useViewportReclamp` 那条 resize
       * 监听重钳一遍,预算装得下就把预算收起来的那条展开。手动那一段删掉之后,
       * 下一步「五档厚度」拖得到杆,就是这条裁定在真机上的**反证**:
       * 把归还那一趟拆掉 → 这道门当场红在 `[7/11]` 的「厚度没拖到位:实际 -1」。
       *
       * 只等一拍:重钳走的是 rAF 合并(判词在 `stage/viewport-reclamp.ts`)。
       */
      await delay(500)
    }

    console.log('\n[7/11] 场景①总览:五档厚度,逐档滚一遍扫重叠')
    await sweepThicknesses(page, '总览', failures)

    console.log('\n[8/11] 三档容器宽:谁在场、谁降元素、工具栏没被挤出去')
    /*
     * 窗要先撑宽:800 那一档的架子厚度够不着 `0.55 × 1280`(见 WIDE_WINDOW)。
     * 撑宽这一手与 `[6/11]` 的 `narrowComposerTo` 是同一只(放开 minWidth 再
     * setSize),量完在 finally 里还原 —— 后面几步量的是别的布局。
     */
    const winForBands = await app.browserWindow(page)
    const sizeBefore = await winForBands.evaluate((w) => ({
      size: w.getSize(),
      min: w.getMinimumSize(),
    }))
    try {
      await winForBands.evaluate((w, m) => w.setMinimumSize(m.minWidth, m.minHeight), NARROW_WINDOW)
      await winForBands.evaluate((w, s2) => w.setSize(s2.width, s2.height), WIDE_WINDOW)
      await delay(600)
      const viewport = await page.evaluate(() => window.innerWidth)
      console.log(`    窗撑到 ${viewport}(想要 ${WIDE_WINDOW.width};架子上限 = 0.55 × 视口)`)
      for (const band of CONTAINER_BANDS) {
        const { container, thickness } = await setExposeContainerTo(page, band)
        if (Math.abs(container - band) > 2) {
          console.log(`  ✗ 容器宽调不到 ${band}(实际 ${container.toFixed(1)},架子厚 ${thickness})`)
          failures.push(`容器宽 ${band}:调不到位(实际 ${container.toFixed(1)})`)
          continue
        }
        const bands = await checkWidthBands(page, container)
        if (bands.error) throw new Error(bands.error)
        console.log(`    [${band}px] ${bands.seen.join(' | ')}`)
        if (bands.problems.length) {
          for (const problem of bands.problems) console.log(`  ✗ 容器 ${band}px:${problem}`)
          failures.push(`容器宽 ${band}px:${bands.problems.length} 条`)
        } else {
          console.log(`  ✓ 容器 ${band}px:在场表逐条对上,工具栏三件都在容器里`)
        }

        // 行几何在**每一档**都问一遍:对齐是排版的性质,它在哪一档塌都算塌。
        const geom = await checkRowGeometry(page)
        if (geom.error) throw new Error(geom.error)
        console.log(`    [${band}px] ${geom.seen.join(' | ')}`)
        if (geom.problems.length) {
          for (const problem of geom.problems) console.log(`  ✗ 容器 ${band}px:${problem}`)
          failures.push(`行几何 ${band}px:${geom.problems.length} 条`)
        } else {
          console.log(`  ✓ 容器 ${band}px:标题只截断 · 两列各自一条竖线 · 树零横向溢出`)
        }
      }
    } finally {
      await winForBands.evaluate((w, back) => {
        w.setSize(back.size[0], back.size[1])
        w.setMinimumSize(back.min[0], back.min[1])
      }, sizeBefore)
      await delay(500)
    }

    console.log('\n[9/11] 浮窗几何:宽窗上开出来,缩到 1100 之后右缘不许出视口(设计 §4)')
    const float = await checkFloatReclamp(app, page)
    if (float.error) throw new Error(float.error)
    console.log(`    ${float.wide} → 缩窗后 ${float.seen}`)
    if (float.problems.length) {
      for (const problem of float.problems) console.log(`  ✗ 浮窗重钳:${problem}`)
      failures.push(`浮窗重钳:${float.problems.length} 条`)
    } else {
      console.log('  ✓ 缩窗一帧之后整扇窗回到视口内缩 16px 的框里')
    }

    console.log('\n[10/11] 挤压纪律的 toast 版(崩溃弹框里那条无断点长 URL)')
    const toast = await checkToastSqueeze(page)
    if (toast.error) throw new Error(toast.error)
    if (process.env.SQUEEZE_DUMP) console.log(`    [toast] ${toast.seen.join(' | ')}`)
    if (toast.problems.length) {
      for (const problem of toast.problems) console.log(`  ✗ ${problem}`)
      failures.push(`toast 挤压:${toast.problems.length} 条`)
    } else {
      console.log(`  ✓ ${toast.rows} 条 toast:盒子没被撑宽,墨一件都没顶穿 padding`)
    }

    console.log('\n[10b/11] 顶栏标签组:多 tab 永不换行 · 右端动作组不被挤掉 · 分隔杆在场')
    /*
     * ── 挤压纪律在拼贴台上的落点(W1;W1-b 起檐画在窗口顶栏上)──────────────
     * 四条,逐条对应设计 §10 那张「超量」状态与 §2.2 D 稿:
     *  ① **永不换行** —— 所有 tab 的 top 逐个相同(换行了就会有两种 top);
     *  ② **右端动作组永不被挤掉** —— 顶栏尾格的右缘必须落在顶栏盒里、与 tab 条零重叠
     *    (「一行一个弯腰件」:弯腰的是 tab 条,靠它自己横滚);
     *  ③ **标签带越不过尾格的左缘** —— D 稿把「挤不掉」从「算得准」换成了「结构上
     *    出不去」:带子是 flex 项、组是它的绝对定位子孙。这一条守的就是那个结构;
     *  ④ **分隔杆**:分屏之后它在场、报得出 role 与比例(可调的 separator 是控件)。
     */
    const leaf = await checkLeafChrome(page)
    if (leaf.skipped) {
      console.log(`  · 跳过:${leaf.skipped}`)
    } else {
      console.log(`    ${leaf.seen.join(' | ')}`)
      if (leaf.problems.length) {
        for (const problem of leaf.problems) console.log(`  ✗ 顶栏标签组:${problem}`)
        failures.push(`顶栏标签组:${leaf.problems.length} 条`)
      } else {
        console.log('  ✓ 顶栏标签组:tab 条一条线 · 动作组在框里且零重叠 · 右端只两件 · 第一格贴让位')
      }
    }

    /*
     * ── W7-c 裁定 4:**架子檐只一颗「收起」,浮窗檐只一颗 ✕** ─────────────
     * 被拿掉的那几件搬进了叶菜单(右键那条檐上的空白处开),所以这一步量的是
     * **减法真的做了**:那条檐右端的动作组里,宿主自己那几颗只剩一颗。
     *
     * 数的是「叶自己那一组」之后的那一格 —— 结构上它们是同一个 `.actions` span 的
     * 孩子,而叶自己那一组今天最多贡献一颗 ⋯(有够不着的标签时)。所以判据写成
     * **上限 2**(叶的 ⋯ + 宿主那一颗),而不是「恰好 1」:那样会在条太窄时假红。
     *
     * 屏幕上没有架子 / 浮窗时如实跳过 —— 这一步不自己造夹具(前面几步已经把
     * 出厂摆法折腾过一轮了,再造会把后面的读数搅乱)。
     */
    console.log('\n[10b-2/11] 架子檐与浮窗檐:减法真的做了(W7-c 裁定 4)')
    const chrome = await page.evaluate(() => {
      const readOne = (host) => {
        const strip = host.querySelector('[data-pane-chrome]')
        const actions = strip?.querySelector(':scope > span:last-child')
        const buttons = Array.from(actions?.querySelectorAll(':scope > button') ?? [])
        return {
          buttons: buttons.map((el) => (el.getAttribute('aria-label') ?? '').trim()),
        }
      }
      return {
        shelves: Array.from(document.querySelectorAll('[data-shelf]')).map((el) => ({
          side: el.getAttribute('data-shelf'),
          ...readOne(el),
        })),
        floats: Array.from(document.querySelectorAll('[data-float-body]')).map((el) => ({
          side: el.getAttribute('data-float-body'),
          ...readOne(el),
        })),
      }
    })
    const chromeProblems = []
    for (const row of [...chrome.shelves, ...chrome.floats]) {
      if (row.buttons.length === 0) continue
      if (row.buttons.length > 2) {
        chromeProblems.push(`${row.side} 的檐上还有 ${row.buttons.length} 颗钮:${row.buttons.join(' / ')}`)
      }
      for (const bad of ['弹出', 'Pop', '关闭整栏', 'Close all', '钉到边', 'Pin to edge', '上舞台', 'To stage']) {
        if (row.buttons.some((label) => label.includes(bad))) {
          chromeProblems.push(`${row.side} 的檐上还留着「${bad}」那颗钮(它该进叶菜单)`)
        }
      }
    }
    const chromeSeen = [...chrome.shelves, ...chrome.floats]
      .map((r) => `${r.side}:${r.buttons.join('+') || '—'}`)
      .join(' | ')
    if (chrome.shelves.length === 0 && chrome.floats.length === 0) {
      console.log('  · 跳过:屏幕上此刻没有架子也没有浮窗')
    } else {
      console.log(`    ${chromeSeen}`)
      if (chromeProblems.length) {
        for (const problem of chromeProblems) console.log(`  ✗ 宿主檐:${problem}`)
        failures.push(`宿主檐:${chromeProblems.length} 条`)
      } else {
        console.log('  ✓ 宿主檐:架子只剩「收起」、浮窗只剩 ✕')
      }
    }

    console.log('\n[10c/11] 落区高亮:盖住那块矩形,永不撑破叶(W3)')
    /*
     * ── 挤压纪律在拖拽上的落点(W3)───────────────────────────────────────
     * `DropOverlay` 的身量**就是**锚矩形(`ui/float` 的 `cover` 档交回来的两个数),
     * 而锚矩形是那片叶自己的矩形或它的一块子矩形 —— 所以「撑不破」在结构上成立。
     * 这一格是那句话的**真机读数**:拖到半路停住(不松手),量高亮的四条边是不是
     * 都落在叶的四条边之内,再 Esc 取消 —— 门不留下任何形态改动。
     */
    const overlay = await checkDropOverlay(page, cdp)
    if (overlay.skipped) {
      console.log(`  · 跳过:${overlay.skipped}`)
    } else {
      console.log(`    ${overlay.seen.join(' | ')}`)
      if (overlay.problems.length) {
        for (const problem of overlay.problems) console.log(`  ✗ 落区高亮:${problem}`)
        failures.push(`落区高亮:${overlay.problems.length} 条`)
      } else {
        console.log('  ✓ 落区高亮:四条边都在叶里,没有撑破')
      }
    }

    /*
     * W2 与 W3 合树时这两格都想当 `10c`,按「两边意图都留」重排:拖拽那格在前
     * (它 Esc 取消,跑完屏幕形态与跑前逐字相同),全屏这格排在它后面 —— 于是
     * 下面这句「夹具接着 10b 用」依旧成立。
     */
    console.log('\n[10d/11] 全屏檐带:一行不换行 · 退出钮在框内 · 让位与顶栏同值(W2 §4.3)')
    const fullStrip = await checkFullStrip(page)
    if (fullStrip.skipped) {
      console.log(`  · 跳过:${fullStrip.skipped}`)
    } else {
      console.log(`    ${fullStrip.seen.join(' | ')}`)
      if (fullStrip.problems.length) {
        for (const problem of fullStrip.problems) console.log(`  ✗ 全屏檐带:${problem}`)
        failures.push(`全屏檐带:${fullStrip.problems.length} 条`)
      } else {
        console.log('  ✓ 全屏檐带:一条线 · 退出钮在框里且不被身份压 · 让位与顶栏逐像素同值')
      }
    }

    console.log('\n[11/11] 收工')
    await app.close()
    app = undefined
  } finally {
    if (app) await app.close().catch(() => {})
    if (server && pidAlive(server.pid)) server.kill('SIGTERM')
    await delay(600)
    await rm(store, { recursive: true, force: true })
    await rm(userDataDir, { recursive: true, force: true })
    await rm(projectsRoot, { recursive: true, force: true })
  }

  if (failures.length) {
    console.error(`\n[squeeze-gate] FAILED(${failures.length} 档):\n  ${failures.join('\n  ')}`)
    process.exit(1)
  }
  console.log(
    '\n[squeeze-gate] ok —— 五档零重叠 · 三档在场表与行几何全对 · 浮窗重钳回框'
      + ' · 两格标签 260 截断 / 格头 28 一行 / 杆到两头仍有最小格宽(W6-c)',
  )
}

main().catch((error) => {
  console.error('\n[squeeze-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
