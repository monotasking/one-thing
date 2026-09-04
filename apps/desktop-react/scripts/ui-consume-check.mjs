#!/usr/bin/env node
/**
 * **组件消费义务**的机器化(09-01 立法,起因见 CLAUDE.md 施工纪律「基础件先行」)。
 *
 * 一句话:**业务面出现 `src/ui/` 已有职责的手写实现 = 违例**。
 * 法条本身早就写在 CLAUDE.md 的禁令区(禁 native title、图标钮必须消费 ui 库件、
 * 键盘选择两态分离……),这个脚本是它们的执法官 —— 从前每一条都靠人盯,
 * 于是「新壳里键盘选择列表各写各的」这种事能一路长到用户眼前。
 *
 * ── 扫描面 ──────────────────────────────────────────────────────────────
 * `src/**` 里除 `src/ui/**`(组件库自己)与 `src/styles/**`(全局样式产地)之外的
 * 一切 `.ts` / `.tsx` / `.module.css`。测试文件**照扫**:测试里手写一遍等于
 * 把手写这件事钉进夹具,下一个人照抄。
 * ──────────────────────────────────────────────────────────────────────
 *
 * ── 规则表(可增行;每条附判例)─────────────────────────────────────────
 * 每条规则给出 `id` / `severity` / `judge`。severity:
 *   'violation'  = 违例,基线只减不增,新增即红;
 *   'debt'       = 不违例但欠一笔(如结构件还没接基座),同样只减不增,
 *                  新增即红 —— 「不违例」说的是不用改写法,不是可以随便再长。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 跑法:`npm run ui:consume`(= check 打全表 + gate 判棘轮)。
 * 只想看全表:`node scripts/ui-consume-check.mjs`。
 * 基线:`docs/audit/ui-consume-baseline-2026-09-01.txt`。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(appRoot, 'src')

/** 组件库自己与全局样式产地不受这条门管 —— 它们**就是**被消费的那一头。 */
const EXEMPT_DIRS = [path.join(srcDir, 'ui'), path.join(srcDir, 'styles')]

/**
 * `all: true` 时**连 `src/ui/` 与 `src/styles/` 一起扫** —— 响应链那三条问的是
 * 「机制住在哪儿」,组件库自己正是要被收编的一头(`ui/float.ts` 的 Esc 捕获、
 * `ui/a11y/focus-trap.ts` 的圈禁),漏扫它们等于把清单删掉一半。
 */
function walk(dir, opts = {}) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (!opts.all && EXEMPT_DIRS.some((d) => full === d || full.startsWith(`${d}${path.sep}`))) {
        continue
      }
      out.push(...walk(full, opts))
      continue
    }
    if (/\.(tsx?|module\.css)$/.test(full)) out.push(full)
  }
  return out
}

/** 注释里的病历文本会让断言自红(读样式表源文本的门先剥注释 —— 本仓既有纪律)。 */
function stripComments(text, isCss) {
  const blanked = text.replace(/\/\*[\s\S]*?\*\//g, (b) => b.replace(/[^\n]/g, ' '))
  if (isCss) return blanked
  return blanked.replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + ' '.repeat(m.length - lead.length))
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length

const isTest = (file) => /(^|[\\/])__tests__[\\/]|\.test\.tsx?$/.test(file)

/**
 * 逐处豁免:在**命中那一行往上 8 行以内**写
 * `ui-consume-allow: <规则 id> — <理由>` 即摘掉这一条。
 *
 * 8 行而不是 1 行:本仓的豁免理由从来不是半句话,`/* … *\/` 一块注释四五行是常态,
 * 而标记写在**块首**。窗口太窄的后果是「写了理由却不生效」,人只会改成去改规则。
 *
 * 理由不是可选的:没有 `—`(或 `--`)后面那句话的豁免**不生效** ——
 * 一条摘不掉又说不出理由的规则,要么去修,要么去改规则,不该悄悄哑掉。
 */
const WAIVER = /ui-consume-allow:\s*([\w-]+)\s*(?:—|--)\s*\S/
const WAIVER_WINDOW = 8

function waived(lines, rule, line) {
  for (let at = line - 1; at >= Math.max(0, line - 1 - WAIVER_WINDOW); at -= 1) {
    const m = lines[at]?.match(WAIVER)
    if (m && m[1] === rule) return true
  }
  return false
}

/* ────────────────────────────────────────────────────────────────────────
 * 规则 ①  kbd-select —— 键盘选择列表的两个状态
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 「把选中位交给鼠标」的写法。判的是**改选中位**的 setter 名族。
 *
 * 刻意**不**收 `onHover` / `setHover` 这一族:一个名字里就写着 hover 的 setter,
 * 按名字说的就是一个 hover 状态,不是选中位 —— TOC 琴键(toc/PianoKeys.tsx)
 * 正是这一形:`hoverIndex` 与 `currentIndex` 本来就是两个独立状态,它合规。
 * 代价是「把 setPickIndex 改名叫 onHover 再挂上去」绕得过这条 —— 那一格由
 * 规则 ①-b 兜:手写走行本身就已经违例,而收敛进的原语根本没有 hover 入口。
 */
const SELECT_SETTER =
  /\b(set(Active|Selected|Cursor|Current|Highlight|Focused|Pick)\w*|selectRow|setIndex)\s*\(/

/**
 * ①-a 鼠标经过写选中位 —— **hover ≠ active** 那条裁定的正面违例。
 * 判例(09-01):composer 的 @ / 抽屉与工作区快切各挂一句
 * `onMouseEnter={() => setCursor(i)}`,于是①鼠标停在列表上时 ↵ 落在鼠标那一行;
 * ②`scrollIntoView` 滚动后浏览器在**指针静止**的情况下补一发 mouseenter,
 * 键盘位当场被拽走(二次污染)。修法不是给 mouseenter 加判据,是**根本不写**。
 */
function ruleHoverWritesActive(file, text) {
  const hits = []
  const re = /on(?:MouseEnter|MouseOver|PointerEnter|PointerOver)\s*=\s*\{([^}]*(?:\}[^}]*)??)\}/g
  let m
  while ((m = re.exec(text)) !== null) {
    if (!SELECT_SETTER.test(m[1])) continue
    hits.push({ rule: 'kbd-select-hover', file, line: lineOf(text, m.index), note: 'mouseenter 改选中位' })
  }
  return hits
}

/**
 * ①-b 自己手写一套 ↑↓ 走行 —— 该消费 `ui/a11y/list-selection`(焦点留在输入框的
 * 候选列表)或 `ui/a11y/roving`(焦点真的落在项上的菜单 / tab 条)。
 * 判例:同一份「加一减一取模」在 composer / 工作区快切 / 检索面板 / 跳转条里
 * 各写了一遍,四份走法就配着四份 hover 处理 —— 收敛掉走法才收得掉那条病。
 */
const KEY_NAV = /['"]Arrow(Down|Up)['"]/
const CONSUMES_NAV = /from\s+['"][^'"]*a11y\/(list-selection|roving)['"]/

function ruleHandwrittenKeyNav(file, text) {
  // 测试文件**按**方向键,不**实现**方向键 —— 收它只会逼着每份用例去 import
  // 一个它根本不用的原语。裸钮那条规则照旧扫测试(手写一遍会被下一个人照抄)。
  if (isTest(file)) return []
  if (!KEY_NAV.test(text)) return []
  if (CONSUMES_NAV.test(text)) return []
  const m = text.match(KEY_NAV)
  return [
    {
      rule: 'kbd-select-handwritten',
      file,
      line: lineOf(text, text.indexOf(m[0])),
      note: '手写 ↑↓ 走行,未消费 a11y 原语',
    },
  ]
}

/* ────────────────────────────────────────────────────────────────────────
 * 规则 ②  tooltip —— 提示一律 `ui/Tooltip`
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * native `title=` 早已是禁令;这里补上另一半:**自绘一层提示结构**。
 * 判据是「文件里出现 tooltip 形态的标识(类名 / testid / 变量),却没 import
 * ui/Tooltip」。判例:提示的定位、延时、箭头、层级四件事各写一遍必然走形,
 * 而 hover 提示恰恰是最容易被当成「就几行」的那一类。
 */
/**
 * 判据只认**贴在元素身上**的提示皮肤:`className={…tooltip…}`(tsx)或
 * 一条 `.tooltip*` 选择器(module.css)。刻意不认裸字符串 —— 一个 token 名
 * (`--kf-tooltip`)、一句用例描述里出现 "tooltip" 都不是自绘一层提示。
 */
const TOOLTIP_CLASS = /className=\{?[^}>]*\b\w*[Tt]ooltip\w*\b/
const TOOLTIP_SELECTOR = /(^|[\s,])\.[\w-]*tooltip[\w-]*[\s,:{]/i
const CONSUMES_TOOLTIP = /from\s+['"][^'"]*ui\/Tooltip['"]/

function ruleHandwrittenTooltip(file, text, isCss) {
  if (!isCss && CONSUMES_TOOLTIP.test(text)) return []
  const shape = isCss ? TOOLTIP_SELECTOR : TOOLTIP_CLASS
  const m = text.match(shape)
  if (!m) return []
  return [{ rule: 'tooltip-handwritten', file, line: lineOf(text, text.indexOf(m[0])), note: '自绘提示层' }]
}

/**
 * native `title=` —— 禁令的字面执法。只判**小写标签**(真 HTML 元素)身上的
 * 那个属性:大写开头的是组件,它的 `title` 是一个普通 prop(PanelShell 的标题、
 * Dialog 的标题……),与浏览器那个会飘出灰底小方块的 title attribute 无关。
 * 这一格的区分做不好,门就会把「所有带标题的面」全报成违例。
 */
function ruleNativeTitle(file, tags) {
  return tags
    .filter((tag) => /^[a-z]/.test(tag.name) && /\stitle\s*=\s*[{"']/.test(tag.attrs))
    .map((tag) => ({ rule: 'tooltip-native-title', file, line: tag.line, note: `native title= on <${tag.name}>` }))
}

/* ────────────────────────────────────────────────────────────────────────
 * 规则 ③  图标钮的 hover 配方
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 「图标按钮必须消费 ui 库件」的样式侧执法:业务面自己的样式表里,
 * 一条**图标钮命名**的 `:hover` 规则 = 又画了一遍 IconButton 的配方。
 * 判例:hover 不合规范屡犯的病根就是各面自绘(CLAUDE.md 禁令区原话)。
 * 这是**命名近似**,不是语义判定 —— 改了名字就绕得过去,所以它配着
 * bare-button 那条一起看:真正的判据是「有没有消费 ui/IconButton」。
 */
const ICON_BTN_SELECTOR =
  /(^|[\s,])\.[\w-]*(iconBtn|btnIcon|iconButton|icon-btn|toolBtn|actionBtn|ghostBtn)[\w-]*(:hover|:where[^{]*hover)/i

function ruleIconButtonHover(file, css) {
  const hits = []
  css.split('\n').forEach((line, i) => {
    if (ICON_BTN_SELECTOR.test(line)) {
      hits.push({ rule: 'icon-button-hover', file, line: i + 1, note: '业务面自绘图标钮 hover' })
    }
  })
  return hits
}

/* ────────────────────────────────────────────────────────────────────────
 * 规则 ④  裸 `<button>` 三类判
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 一个业务面里的 `<button>` 按**它是什么**分三类,判法各不相同:
 *   · `bare-button-text`       文字动作钮 → 违例,该 `ui/Button` / `ui/AsyncButton`
 *   · `bare-button-icon`       图标钮     → 违例,该 `ui/IconButton`
 *   · `bare-button-structural` 瓦/卡/行/键/选项 → **不违例**(视觉本该定制),
 *                              但欠一笔:该消费 `ui/ButtonBase`(只清 UA 的极小件)。
 * 判例:用户 09-01 点名清查,业务面 88 处裸钮 / 42 文件,而消费 ui/Button 族的
 * 只有 20 文件 —— 「各写各的」在按钮这一格最密。
 */
const STRUCTURAL_ROLE = /role\s*=\s*["'](option|tab|treeitem|gridcell|row|menuitem\w*)["']/
const STRUCTURAL_CLASS =
  /className=\{?[^}>]*\b\w*(row|tile|card|key|cell|item|chip|seg|tab|dot|swatch|node|thumb|crumb|pill|track|head|slot|shelf|preview|entry|option|day|page)\w*\b/i

/**
 * 极简 JSX 开标签扫描:`<Name …attrs…>` + 到配对闭合标签之间的内容。
 * 属性串里跳过花括号(`onClick={() => f(a > b)}` 里的 `>` 不是标签结尾)与引号。
 * 不建 AST 是刻意的:这条门要在几十毫秒内跑完并且零依赖,而它判的都是
 * **写法层面**的形状 —— 真要语义判定,那是 lint 规则该干的事。
 */
function scanTags(text) {
  const out = []
  const re = /<([A-Za-z][\w.-]*)\b/g
  let m
  while ((m = re.exec(text)) !== null) {
    const name = m[1]
    let i = m.index + m[0].length
    let depth = 0
    let quote = ''
    while (i < text.length) {
      const ch = text[i]
      if (quote) {
        if (ch === quote) quote = ''
      } else if (ch === '"' || ch === "'" || ch === '`') quote = ch
      else if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
      else if (ch === '>' && depth === 0) break
      i += 1
    }
    const attrs = text.slice(m.index, i + 1)
    const close = text.indexOf(`</${name}>`, i)
    const body = close === -1 ? '' : text.slice(i + 1, close)
    out.push({ name, index: m.index, line: lineOf(text, m.index), attrs, body })
  }
  return out
}

/** 内容里有没有**人读的字**(文本节点或一句 `t('…')`)。 */
function hasText(body) {
  const withoutTags = body.replace(/<[^>]*>/g, ' ')
  if (/\bt\(\s*['"]/.test(body)) return true
  return /[\p{L}\p{N}]/u.test(withoutTags.replace(/\{[^}]*\}/g, ' '))
}

function ruleBareButton(file, tags) {
  return tags
    .filter((tag) => tag.name === 'button')
    .map(({ line, attrs, body }) => {
      if (STRUCTURAL_ROLE.test(attrs) || STRUCTURAL_CLASS.test(attrs)) {
        return { rule: 'bare-button-structural', file, line, note: '结构件裸钮,欠 ui/ButtonBase' }
      }
      if (!hasText(body)) return { rule: 'bare-button-icon', file, line, note: '图标钮,该 ui/IconButton' }
      return { rule: 'bare-button-text', file, line, note: '文字动作钮,该 ui/Button' }
    })
}

/* ────────────────────────────────────────────────────────────────────────
 * 规则 ⑤  手写忙布尔 —— 该迁 data/kernel 的 createMutation
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 一个 source 自己记一格 `saving / busy / loading / pending / inflight` 布尔,
 * 就是把「谁在写、写的是哪一格」这件事重新手写了一遍 —— 而那正是
 * `data/kernel` 的 `createMutation` 存在的理由(交互稳定律③要的是**逐格**
 * pending,不是整面一颗)。
 *
 * 判例(09-01,model service 勾选闪烁):`providers/store.ts` 的 `saving: boolean`
 * 是整面共享的一颗,一次勾选把整张模型表连同「设为当前」钮一起禁灰 ——
 * 病型 B(全局忙布尔把整面禁灰,粒度病)叠 E(过快往返的无意义闪)。
 * 全仓存量 5 处:providers/store.ts、providers/auth.ts、data/viewer-source.ts、
 * data/chat-source.ts、workspace/store.ts;其中 providers/store.ts 那处已在
 * 09-01 批 1 迁到 `settingsMutation`,基线只收其余四处。
 *
 * **刻意只扫 `.ts`,不扫 `.tsx`**:组件 props 里的同名字段(`saving: boolean`)
 * 是 store 那一格的下游 —— 上游迁掉了,下游自然跟着换成逐格的 key 集合。
 * 两头都扫就是同一笔账记两遍,还会把「组件收一个 pending 布尔」这种完全
 * 合规的写法(AsyncButton 内部就是这么收的)判成违例。
 *
 * data/kernel 自己不受这条管:它**就是**被消费的那一头(`MutationSnapshot.pending`)。
 */
const BUSY_FIELD = /^[ \t]*(saving|busy|loading|pending|inflight)\??:\s*boolean/gm

const isKernel = (file) => /(^|[\\/])data[\\/]kernel[\\/]/.test(file)

function ruleAsyncBusyBoolean(file, text) {
  if (isTest(file) || isKernel(file) || !file.endsWith('.ts')) return []
  const hits = []
  let m
  BUSY_FIELD.lastIndex = 0
  while ((m = BUSY_FIELD.exec(text)) !== null) {
    hits.push({
      rule: 'async-busy-boolean',
      file,
      line: lineOf(text, m.index),
      note: '手写忙布尔,该迁 data/kernel createMutation(律③逐格 pending)',
    })
  }
  return hits
}

/* ────────────────────────────────────────────────────────────────────────
 * 规则 ⑥  浮层散场行为的手写 —— 该消费 ui/float 的 useFloatDismiss
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 「点外面关掉」与「Esc 在捕获相位认领关闭」曾是浮层散场的两半,CLAUDE.md 禁令区
 * 把它们判给了唯一产地 `ui/float`(`useFloatDismiss`)。这条规则是字面执法。
 *
 * 判例:Menu 与 Popover 曾各抄一份散场逻辑,而「Esc 该由谁认领」那条判例
 * **修过三轮** —— 产地越多越漂,每修一轮都要去找齐所有抄本。
 *
 * ── R3(09-03):**Esc 那半边退役,点外关那半边留着** ──────────────────────
 * 设计 §8 的原话是「现有 `float-handwritten` 规则退役(**被 I2 覆盖**)」。
 * 括号里那句理由只对**一半**成立:`keydown` 捕获相位那条探针问的正是 I2 问的
 * 同一件事(「keydown 监听住在哪儿」),而 I2 现在是硬闸、允许区只有 `src/focus/`,
 * 判得比它严 —— 那半边留着就是同一笔账记两遍(`focus/dispatch.ts` 那唯一一行
 * 还得为它写一条豁免)。所以 keydown 探针**删掉**,连同那条豁免。
 *
 * 点外关那半边 I2 一个字都没覆盖(它判的是 `pointerdown`,不是 keydown),
 * 而「浮层行为单产地 = ui/float」这条禁令在 CLAUDE.md 里仍然立着 ——
 * 整条规则退役 = 白白丢掉这一格的执法。所以这只函数现在只剩点外关。
 */
const FLOAT_POINTERDOWN = /window\.addEventListener\(\s*['"]pointerdown['"]/g

function ruleHandwrittenFloat(file, text) {
  if (isTest(file)) return []
  const hits = []
  FLOAT_POINTERDOWN.lastIndex = 0
  let m
  while ((m = FLOAT_POINTERDOWN.exec(text)) !== null) {
    hits.push({
      rule: 'float-handwritten',
      file,
      line: lineOf(text, m.index),
      note: '手写点外关(window pointerdown),该消费 ui/float useFloatDismiss',
    })
  }
  return hits
}

/* ────────────────────────────────────────────────────────────────────────
 * 规则 ⑦  Spinner 的落点 —— 只许在按钮内或状态栏
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * 法条原文(CLAUDE.md 禁令区):**「Spinner 只许出现在按钮内或状态栏;
 * 列表/卡的加载态用文字或骨架」**。
 *
 * ── 为什么这条门判的是「每一处」,不是「非法的那几处」──────────────────
 * 「它在不在按钮里」是**上下文**,而这套门是行级的形状判定,静态判不出来:
 * 一颗 Spinner 可能长在 `<Button>` 的 children 里,也可能隔着两层 `<span>`
 * 长在状态栏那条带子里,还可能被抽成一个变量再插进去。给判据加「往上找几层
 * 有没有 Button」那种启发式,只会得到一条**既漏又误**的规则(而误报的代价是
 * 下一个人去改规则,不是去改代码 —— 判例:icon-button-hover 那条命名近似
 * 规则的注释里已经写过同一件事)。
 *
 * 所以这条反过来做:**命中全部,合法的那些逐处就地豁免**。
 * 每一处合法的 Spinner 都要在自己头上写一行
 * `ui-consume-allow: spinner-placement — <它在按钮内 / 状态栏的理由>`,
 * 于是**每一颗转圈都在原地说明自己为什么合法** —— 而不是躲在一份别处的基线里。
 * 这也是它不入基线的理由:基线是「暂时留着的账」,而这些是「永久正确的落点」,
 * 两者混在一起会让基线越来越不像一张待办表。
 *
 * ── 判例(批 6,09-02:五处判定、四处换文字)────────────────────────────
 *  · FileViewer 首载那一颗 —— 去掉,旁边的文字说的是同一句;
 *  · FileDetailPopover —— 去掉,错误分支本就纯文字,两态同形;
 *  · ToolRow —— 去掉,**不是状态栏**:行尾读数已经写着「运行中」,
 *    首图标还在脉冲,转圈是第三遍说同一件事;
 *  · ResearchSegment —— 去掉,**不是状态栏**:prose 流里那块 surface-1
 *    已经写着「正在阅读…」外加一条进度副行。
 * 留下来的四处(providers 两张卡的钮内 × 3、FileViewer 状态栏 × 1)
 * 正是这条法说的两个允许位。
 *
 * 扫描面刻意收窄到**业务面的 `.tsx`**:`src/ui/**` 是被消费的那一头(walk 已排除),
 * `src/dev/**` 是规格页(它的职责就是把每件组件摊平并排,那里的 Spinner 是**样品**
 * 不是加载态),测试文件按的是渲染结果、不是落点裁定。
 */
const SPINNER_TAG = /<Spinner\b/g

const isDev = (file) => /(^|[\\/])src[\\/]dev[\\/]/.test(file)

function ruleSpinnerPlacement(file, text) {
  if (isTest(file) || isDev(file) || !file.endsWith('.tsx')) return []
  const hits = []
  SPINNER_TAG.lastIndex = 0
  let m
  while ((m = SPINNER_TAG.exec(text)) !== null) {
    hits.push({
      rule: 'spinner-placement',
      file,
      line: lineOf(text, m.index),
      note: 'Spinner 只许在按钮内或状态栏(合法处逐处就地豁免,不进基线)',
    })
  }
  return hits
}

/* ────────────────────────────────────────────────────────────────────────
 * 规则 ⑧  视觉词汇的多产地 —— 同一个词在各面各画一遍
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * `.dot` / `.card` / `.groupHead` 这些**不是某个面的私有类名**,它们是这套壳的
 * 视觉词汇:状态丸、卡、组头、字段、读数条、丸标、徽、片。同一个词在八个
 * module.css 里各画一遍,结果就是同名不同形 —— 用户看见的是「同一种东西
 * 在两块面里长得不一样」,而没有任何一道门能发现,因为每一份自己都合规。
 *
 * 判据是**行首选择器**,驼峰续段用大写界定(`.dotBottom` 算 dot 一族,
 * `.dotted` 是另一个词不许误伤)。严格说这是命名近似而非语义判定 ——
 * 它要抓的不是违例,是**产地数**:批 2 立件收编时,这张表就是清单。
 * 存量 73 条 / 8 个词(dot 8 产地 / card 7 / meter 2 / groupHead 4 / …)全入基线。
 */
const SHARED_VOCAB = /^\.(dot|card|groupHead|field|meter|pill|badge|chip)([A-Z][\w-]*)?\s*[,{:]/

function ruleSharedVocabCss(file, css) {
  const hits = []
  css.split('\n').forEach((line, i) => {
    const m = line.match(SHARED_VOCAB)
    if (!m) return
    hits.push({
      rule: 'shared-vocab-css',
      file,
      line: i + 1,
      note: `视觉词汇多产地(${m[1]}),待批 2 立件收编`,
    })
  })
  return hits
}

/* ────────────────────────────────────────────────────────────────────────
 * 规则 ⑨⑩⑪  响应链的三条(设计 `docs/design/react-shell-focus-2026-09.md` §8)
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * **R3(09-03)起这三条是硬闸:severity `violation`、基线零、不进 baseline 文件。**
 * 一条新命中直接红 —— 没有「先记一笔账」这条路,因为响应链的整个价值就是
 * 「谁在接键盘」只有一个答案,而一条例外就是第二个答案。
 *
 * 立法在响应链设计的三条不变量上(`docs/design/react-shell-focus-2026-09.md` §3):
 *  · I2 —— `keydown` 监听只许出现在 `src/focus/`;
 *  · I3 —— `.focus()` 只许出现在 `src/focus/` 与三处**作用域内部**的焦点移动;
 *  · 「我是不是当前」不许靠读 `document.activeElement`(改问 `useFocusScopeActive()`)。
 *
 * 三条走过的路:R0 立成 `report` 档只打表(12 / 22 / 2),因为那时树**零消费者**,
 * 八套旧机制一格没动,判红等于要求一批干完三批的活;R1 拆到 5 / 15 / 2;
 * R2 内容面接树之后归零(0 / 0 / 0);R3 就是把那个零钉死。
 *
 * ── 这三条的扫描面比别的规则**宽一格**:`src/ui/**` 也扫 ─────────────────
 * 别的规则问的是「业务面有没有手写 ui/ 已有职责的东西」,组件库自己是被消费的
 * 那一头,所以豁免。这三条问的是**机制住在哪儿**,而当年要被树收编的两件
 * (`ui/float.ts` 的 Esc 捕获、`ui/a11y/focus-trap.ts` 的 Tab 圈禁)恰恰长在
 * `src/ui/` 里 —— 漏扫它们等于把清单删掉一半。两件今天都已退役,扫描面留着:
 * 下一个想在库件里自己接一下键盘的人,得先撞上这道门。
 *
 * ── 内置允许区(设计 I2/I3 写死的那几处,不是「暂时留着」)──────────────────
 *  · `src/focus/**` —— 树自己(三条全免);
 *  · `.focus()` 另许 `ui/a11y/roving.ts` / `ui/a11y/list-selection.ts` /
 *    `ui/inline-edit.ts` —— **作用域内部**的焦点移动(方向键在项之间走、
 *    编辑框拿到手就选中),它们不跨作用域,设计 §4.3 明确留着;
 *  · `activeElement` 另许 `ui/a11y/**` —— roving 的当前项判据就是它。
 *
 * `keydown` 那一条的允许区**只有 `src/focus/**`**,一格不多:R0/R1/R2 期间
 * `roving.ts` 那条容器级监听是写死在这只函数里的一个分支,R3 把它拆出去改成
 * **就地豁免**(照 spinner-placement 的体例:合法的那几处各自在原地说明自己
 * 为什么合法,而不是躲在这只函数里)。于是这三条的判据从此只有一句话:
 * **不在允许区里 = 红**,想留就在命中处上方写理由。
 *
 * 测试文件整体不受这三条管:用例**按**键、**摆**焦点,那是夹具在驱动产品,
 * 不是产品自己又长了一套机制。
 */
const KEYDOWN_LISTENER = /\b(?:window|document|[\w.?]+)\.addEventListener\(\s*['"]keydown['"]/g
const FOCUS_CALL = /\.focus\s*\(/g
const ACTIVE_ELEMENT = /document\.activeElement/g

const inFocusDomain = (file) => /(^|[\\/])src[\\/]focus[\\/]/.test(file)
/** 作用域**内部**的焦点移动:方向键走项、编辑框拿到手就选中。不跨作用域,留着。 */
const SCOPE_INTERNAL_FOCUS = [
  'src/ui/a11y/roving.ts',
  'src/ui/a11y/list-selection.ts',
  'src/ui/inline-edit.ts',
]
const inA11yDir = (file) => /(^|[\\/])src[\\/]ui[\\/]a11y[\\/]/.test(file)

function ruleFocusDomain(file, text) {
  if (isTest(file) || inFocusDomain(file)) return []
  const norm = file.split(path.sep).join('/')
  const hits = []

  KEYDOWN_LISTENER.lastIndex = 0
  let m
  while ((m = KEYDOWN_LISTENER.exec(text)) !== null) {
    const global = /\b(?:window|document)\.addEventListener/.test(m[0])
    hits.push({
      rule: 'keydown-outside-focus',
      file,
      line: lineOf(text, m.index),
      note: `${global ? 'window/document' : '元素'}级 keydown 监听,该收进 src/focus/dispatch(I2)`,
    })
  }

  if (!SCOPE_INTERNAL_FOCUS.includes(norm)) {
    FOCUS_CALL.lastIndex = 0
    while ((m = FOCUS_CALL.exec(text)) !== null) {
      hits.push({
        rule: 'focus-outside-focus',
        file,
        line: lineOf(text, m.index),
        note: '跨作用域搬焦点,该走 activate() / 结构性归还(I3)',
      })
    }
  }

  if (!inA11yDir(file)) {
    ACTIVE_ELEMENT.lastIndex = 0
    while ((m = ACTIVE_ELEMENT.exec(text)) !== null) {
      hits.push({
        rule: 'active-element-read',
        file,
        line: lineOf(text, m.index),
        note: '读 activeElement 判「我是不是当前」,该问 useFocusScopeActive()',
      })
    }
  }

  return hits
}

/**
 * severity 表。加规则 = 加一行这里 + 一个 judge。
 *   'violation' / 'debt' —— 进棘轮,只减不增;
 *   'report'             —— **只打表不判红**。今天一条都没有:响应链三条在 R0 用的
 *                           就是这一档,R3 全部转 `violation`。这一档留着不是死码,
 *                           它是「先立门、后还账」那条路本身(R0→R2 走了一遍,
 *                           下一条要分期还的规则照走)。
 */
export const RULE_SEVERITY = {
  'kbd-select-hover': 'violation',
  'kbd-select-handwritten': 'violation',
  'tooltip-native-title': 'violation',
  'tooltip-handwritten': 'violation',
  'icon-button-hover': 'violation',
  'bare-button-text': 'violation',
  'bare-button-icon': 'violation',
  'bare-button-structural': 'debt',
  'async-busy-boolean': 'debt',
  'float-handwritten': 'violation',
  'spinner-placement': 'violation',
  'shared-vocab-css': 'debt',
  // 响应链三条(R3 起硬闸,基线零,不进 baseline 文件)。
  'keydown-outside-focus': 'violation',
  'focus-outside-focus': 'violation',
  'active-element-read': 'violation',
}

export function findViolations() {
  const hits = []
  /*
   * 组件库自己(`src/ui/**`)只进**响应链那三条**的扫描面,别的规则照旧豁免它 ——
   * 理由写在那三条的注释里:它们问的是「机制住在哪儿」,而 ui/ 正是要被收编的一头。
   */
  const consumeFiles = new Set(walk(srcDir))
  for (const file of walk(srcDir, { all: true })) {
    if (consumeFiles.has(file) || file.endsWith('.css')) continue
    const rel = path.relative(appRoot, file)
    const raw = readFileSync(file, 'utf-8')
    const lines = raw.split('\n')
    const found = ruleFocusDomain(rel, stripComments(raw, false))
    hits.push(...found.filter((h) => !waived(lines, h.rule, h.line)))
  }
  for (const file of consumeFiles) {
    const rel = path.relative(appRoot, file)
    const isCss = file.endsWith('.css')
    const raw = readFileSync(file, 'utf-8')
    const text = stripComments(raw, isCss)
    const found = []
    if (isCss) {
      found.push(...ruleIconButtonHover(rel, text))
      found.push(...ruleHandwrittenTooltip(rel, text, true))
      found.push(...ruleSharedVocabCss(rel, text))
    } else {
      const tags = scanTags(text)
      found.push(...ruleHoverWritesActive(rel, text))
      found.push(...ruleHandwrittenKeyNav(rel, text))
      found.push(...ruleHandwrittenTooltip(rel, text, false))
      found.push(...ruleNativeTitle(rel, tags))
      found.push(...ruleBareButton(rel, tags))
      found.push(...ruleAsyncBusyBoolean(rel, text))
      found.push(...ruleHandwrittenFloat(rel, text))
      found.push(...ruleSpinnerPlacement(rel, text))
      found.push(...ruleFocusDomain(rel, text))
    }
    // 豁免读的是**原文**:注释在上面已经被抹平了,而豁免恰恰写在注释里。
    const lines = raw.split('\n')
    hits.push(...found.filter((h) => !waived(lines, h.rule, h.line)))
  }
  return hits.sort((a, b) =>
    a.file === b.file ? (a.line === b.line ? a.rule.localeCompare(b.rule) : a.line - b.line) : a.file.localeCompare(b.file),
  )
}

/** 基线里一行的样子:`规则 文件:行 备注`。 */
export const formatHit = (h) => `${h.rule} ${h.file}:${h.line} ${h.note}`

if (import.meta.url === `file://${process.argv[1]}`) {
  const hits = findViolations()
  for (const h of hits) console.log(formatHit(h))
  const byRule = new Map()
  for (const h of hits) byRule.set(h.rule, (byRule.get(h.rule) ?? 0) + 1)
  console.log('')
  for (const [rule, n] of [...byRule].sort()) console.log(`  ${rule.padEnd(26)} ${n}  [${RULE_SEVERITY[rule]}]`)
  console.log(`\n[ui-consume-check] ${hits.length} 条`)
}
