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

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (EXEMPT_DIRS.some((d) => full === d || full.startsWith(`${d}${path.sep}`))) continue
      out.push(...walk(full))
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

/** severity 表。加规则 = 加一行这里 + 一个 judge。 */
export const RULE_SEVERITY = {
  'kbd-select-hover': 'violation',
  'kbd-select-handwritten': 'violation',
  'tooltip-native-title': 'violation',
  'tooltip-handwritten': 'violation',
  'icon-button-hover': 'violation',
  'bare-button-text': 'violation',
  'bare-button-icon': 'violation',
  'bare-button-structural': 'debt',
}

export function findViolations() {
  const hits = []
  for (const file of walk(srcDir)) {
    const rel = path.relative(appRoot, file)
    const isCss = file.endsWith('.css')
    const raw = readFileSync(file, 'utf-8')
    const text = stripComments(raw, isCss)
    const found = []
    if (isCss) {
      found.push(...ruleIconButtonHover(rel, text))
      found.push(...ruleHandwrittenTooltip(rel, text, true))
    } else {
      const tags = scanTags(text)
      found.push(...ruleHoverWritesActive(rel, text))
      found.push(...ruleHandwrittenKeyNav(rel, text))
      found.push(...ruleHandwrittenTooltip(rel, text, false))
      found.push(...ruleNativeTitle(rel, tags))
      found.push(...ruleBareButton(rel, tags))
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
