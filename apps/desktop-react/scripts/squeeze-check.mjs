#!/usr/bin/env node
/**
 * 抗挤压**静态近似** —— 律一的机器化,便宜的那一半。
 *
 * 律一(docs/design/react-shell-squeeze-rules-2026-08.md):一行里可伸缩的文本件
 * 必须**同时**有 `min-width: 0` 和一条截断策略;不承担伸缩的件一律 `flex: none`。
 *
 * 这个脚本只查其中最机械、也最常漏的那半句:**声明块里出现了 `flex: 1` /
 * `flex-grow`,同一个块里却没有 `min-width` / `min-height`**。
 * 为什么这半句值得单独立一条门:flex 项的 `min-width` 默认是 `auto` =
 * 「不许缩到 min-content 以下」。一个能拉伸却不能收缩的文本件,窄下来就会
 * 溢出自己的格子去压别人 —— 08-30 用户报的组头重叠正是这一形(`.groupName`
 * 少了 min-width: 0,长组名折行 / 溢出压住右端的计数徽)。
 *
 * ── 它**不**保证什么(所以真机门不能省)──────────────────────────────────
 *  · 只看单个声明块,不做层叠:分散在两条规则里的 min-width 会被误报;
 *  · 不看方向:column flex 里该配的是 min-height,这里两者都收;
 *  · 不看截断策略在不在(ellipsis / line-clamp 可能写在另一条规则上);
 *  · 完全不认识「实际排出来重不重叠」—— 那是 `gate:squeeze` 的活。
 * 所以它是**近似**:抓的是一类高发写法,不是律一的完整判定。
 * ──────────────────────────────────────────────────────────────────────
 *
 * 跑法:`npm run squeeze-check` 打全表;`npm run squeeze-gate` 是棘轮
 * (基线 docs/audit/squeeze-baseline-2026-08-30.txt,新增即红)。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(appRoot, 'src')

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.module.css')) out.push(full)
  }
  return out
}

/** `flex: 1` / `flex: 1 1 auto` / `flex-grow: 1` —— 「我要吸剩余空间」的三种写法。 */
const GROWS = /(^|[;{\s])flex\s*:\s*(?!none\b)(\d|auto\b)|(^|[;{\s])flex-grow\s*:\s*[1-9]/
/** 解锁收缩的那一句。方向不判,两个都收(column flex 里正解是 min-height)。 */
const UNLOCKS = /(^|[;{\s])min-(width|height)\s*:/

/**
 * 极简的声明块切分:`selector { ... }`,不进 @规则的花括号(@container /
 * @media 里的块靠同一条正则再切一层)。CSS Modules 里没有嵌套语法,所以
 * 这一层朴素切分对本仓是够的 —— 真要上嵌套,这里换成 postcss。
 */
function blocks(css, lineOffset = 0) {
  const out = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].trim().replace(/\s+/g, ' ')
    // 行号要指向**选择器那一行**,不是上一个块的收尾:m.index 停在前一个 `}`
    // 之后的空白上,所以先跳过空白再数换行。
    const at = m.index + m[0].length - m[0].trimStart().length
    const line = lineOffset + css.slice(0, at).split('\n').length - 1
    // @container / @media 的头不是选择器,它的花括号里还有真块 —— 递归一层,
    // 并把行号的基准一起带下去(不带的话 @ 规则里的条目会全部指到文件开头)。
    if (selector.startsWith('@')) {
      const inner = m.index + m[0].indexOf('{') + 1
      out.push(...blocks(m[2], lineOffset + css.slice(0, inner).split('\n').length - 1))
      continue
    }
    if (!selector) continue
    out.push({ selector, body: m[2], line })
  }
  return out
}

export function findViolations() {
  const hits = []
  for (const file of walk(srcDir)) {
    const css = readFileSync(file, 'utf-8')
    // 注释里的示例代码不算数(本仓的 CSS 注释很长,里面常引用写法)。
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    for (const block of blocks(stripped, 1)) {
      if (!GROWS.test(block.body)) continue
      if (UNLOCKS.test(block.body)) continue
      hits.push(`${path.relative(appRoot, file)}:${block.line} ${block.selector}`)
    }
  }
  return hits.sort()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hits = findViolations()
  for (const hit of hits) console.log(hit)
  console.log(`\n[squeeze-check] ${hits.length} 条:flex 会拉伸、却没解开收缩下界`)
}
