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
  // ① 把文件面开出来。
  await page.evaluate(() => {
    const tile = document.querySelector('[data-testid="dock-tile-files"]')
    if (tile instanceof HTMLElement) tile.click()
  })
  await delay(600)
  const rowsCss = '[data-testid="files-tree"] [data-file-path][data-file-type="file"]'
  const rowCount = await page.evaluate((css) => document.querySelectorAll(css).length, rowsCss)
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
    const strip = band.querySelector('[role="tablist"]')?.getBoundingClientRect() ?? null
    const trailing = document.querySelector('[data-testid="topbar-trailing"]')
    const actions = trailing?.getBoundingClientRect() ?? null
    const bar = document.querySelector('[data-testid="topbar"]')?.getBoundingClientRect() ?? null
    return {
      tabs,
      // 「檐的盒」在 D 稿里就是**整条顶栏**:动作组坐在它的尾格里,不在带子里。
      chrome: bar
        ? { left: Math.round(bar.left), right: Math.round(bar.right), height: Math.round(bar.height) }
        : { left: Math.round(box.left), right: Math.round(box.right), height: Math.round(box.height) },
      band: { left: Math.round(box.left), right: Math.round(box.right) },
      strip: strip ? { left: Math.round(strip.left), right: Math.round(strip.right) } : null,
      actions: actions
        ? { left: Math.round(actions.left), right: Math.round(actions.right), width: Math.round(actions.width) }
        : null,
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
  if (!shot.hasSplitButton) problems.push('顶栏尾格里没有那颗分屏钮(焦点叶的动作组不在场)')

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

  // ④ 分屏一次,量分隔杆。
  await page.evaluate(() => {
    const split = document.querySelector('[data-testid^="pane-split:"]')
    if (split instanceof HTMLElement) split.click()
  })
  await delay(350)
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[role="menuitem"]'))
    const right = items.find((el) => /在右侧|To the right/.test(el.textContent ?? ''))
    if (right instanceof HTMLElement) right.click()
  })
  await delay(500)
  const bar = await page.evaluate(() => {
    const el = document.querySelector('[data-testid^="pane-splitter:"]')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      role: el.getAttribute('role'),
      now: Number(el.getAttribute('aria-valuenow')),
      width: Math.round(r.width),
      height: Math.round(r.height),
    }
  })
  if (!bar) {
    problems.push('分屏之后分隔杆不在场')
  } else {
    seen.push(`杆 ${bar.width}×${bar.height} @${bar.now}`)
    if (bar.role !== 'separator') problems.push(`杆的 role 是 ${bar.role},不是 separator`)
    if (!(bar.width > 0 && bar.height > 0)) problems.push(`杆没有排出盒(${bar.width}×${bar.height})`)
    if (!Number.isFinite(bar.now)) problems.push('杆报不出 aria-valuenow')
  }
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
    for (const file of LEAF_TAB_FILES) {
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
    await clickTestId(page, 'dock-tile-sessions')
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
        console.log('  ✓ 顶栏标签组:tab 条一条线 · 动作组在框里且零重叠 · 分隔杆报得出比例')
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
  console.log('\n[squeeze-gate] ok —— 五档零重叠 · 三档在场表与行几何全对 · 浮窗重钳回框')
}

main().catch((error) => {
  console.error('\n[squeeze-gate] FAILED:', error?.stack || error)
  process.exit(1)
})
