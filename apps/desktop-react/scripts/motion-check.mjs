#!/usr/bin/env node
/**
 * 动效收口的**静态执法** —— 两条规矩,两句话说得完。
 *
 *  ① **组件文件里不许出现字面时长**:`transition` / `animation`(含 -duration /
 *     -delay)的值里出现 `120ms` / `0.3s` 这样的数就是违例。时长在 tokens.css 里
 *     命名一次,组件只许 `var(--dur-*)`。这条是 global.css 顶上那条铁律的机器化
 *     ——它一直写在那儿,只是从来没人执法。
 *  ② **@keyframes 只许住在一个地方**:`src/styles/motion.css`。出现在别处就是
 *     违例。散着的代价不是字节数,是没人说得清这台上到底有几种出场
 *     (08-31 收口前:23 段散在 16 个文件里,其中 11 段逐字相同)。
 *  ③ **动画名也只许 var(--kf-*)**,不许写字面名。这条不是洁癖,是**一个真机验出来
 *     的坑**:CSS Modules 会把 `.module.css` 里 `animation:` 值中的名字无条件改写
 *     成 hash —— 连本文件里没声明过的也改。keyframes 一搬进全局产地,所有
 *     `animation: floatIn …` 就指向了一个不存在的 `_floatIn_156y4_1`,**全仓动画
 *     一次性全哑**,而单测与另外两条静态规矩都看不出来(它们不跑 postcss-modules)。
 *     `var()` 对那次改写是不透明的,所以名字进 token 就是这条 bug 的疫苗。
 *     完整病历写在 src/styles/motion.css 的文件头。
 *
 * ── 为什么这两条能静态查 ──────────────────────────────────────────────────
 * 它们都是**写法**上的规矩,不是排出来的效果 —— 同一份 CSS 跑一百遍是同一个答案,
 * 没有余量、不看机器状况。真机那一半(切到「无」档之后屏幕上真的一动不动)
 * 是另一条门:`npm run gate:motion`。
 *
 * ── 它**不**保证什么 ─────────────────────────────────────────────────────
 *  · 不查 JS 里的 ms 字面量(那半边由 components/motion.ts + 它的单测管);
 *  · 不查 `animation-name` 引的名字在不在产地里(引一个不存在的名字是静默失效,
 *    但那要解析整棵 CSS,而真机门一眼就能看出来);
 *  · 不认识 `calc(var(--dur-flash) / 2)` 里那个 2 —— 它不是时长,是个倍数。
 *
 * 跑法:`npm run motion-check` 打全表;`npm run motion-gate` 是棘轮
 * (基线 docs/audit/motion-baseline-2026-08-31.txt,新增即红)。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = path.join(appRoot, 'src')

/** 关键帧的**唯一**产地(相对 appRoot)。 */
export const MOTION_ORIGIN = 'src/styles/motion.css'

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.css')) out.push(full)
  }
  return out
}

/**
 * `transition: … 120ms …` / `animation-duration: .3s`。
 *
 * 只在**属性名对得上**的声明里找数字 + 时间单位 —— 全文找 `\d+ms` 会把
 * `--dur-exit: 120ms`(token 定义,那是它该在的地方)也算进来。
 */
const TIMED_PROPERTY = /(^|[;{\s])(transition|animation)(-duration|-delay)?\s*:([^;}]*)/gi
const LITERAL_TIME = /(^|[^\w-])\d*\.?\d+m?s\b/

/** `animation: …` / `animation-name: …` —— 规则 ③ 看的就是这两个属性的值。 */
const ANIMATION_PROPERTY = /(^|[;{\s])animation(-name)?\s*:([^;}]*)/gi

/**
 * `animation` 简写里合法的**关键字**。剩下的裸标识符就是动画名 —— 也就是违例。
 * 表短是因为简写里能出现的关键字本来就这么多;缓动函数(cubic-bezier / steps)
 * 与 calc 是函数调用,查之前会先被整段掏掉。
 */
const ANIMATION_KEYWORDS = new Set([
  'none', 'initial', 'inherit', 'unset', 'revert',
  'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end',
  'infinite', 'normal', 'reverse', 'alternate', 'alternate-reverse',
  'forwards', 'backwards', 'both', 'running', 'paused',
])

/** 值里剩下的第一个非关键字裸标识符 = 写死的动画名。找不到返回 undefined。 */
function literalAnimationName(value) {
  // 先把函数调用连同函数名一起掏掉,再看剩下什么。
  const bare = value.replace(/[\w-]+\s*\(([^()]|\([^()]*\))*\)/g, ' ')
  for (const word of bare.split(/[\s,]+/)) {
    if (!word) continue
    if (/^\d/.test(word) || word.startsWith('-')) continue
    if (!/^[A-Za-z][\w-]*$/.test(word)) continue
    if (ANIMATION_KEYWORDS.has(word.toLowerCase())) continue
    return word
  }
  return undefined
}

/** 注释掏空但保留换行 —— 行号还要对得上,而注释里常引写法当例子。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length
}

export function findViolations() {
  const hits = []
  for (const file of walk(srcDir)) {
    const rel = path.relative(appRoot, file)
    const raw = readFileSync(file, 'utf-8')
    const css = stripComments(raw)

    // ② keyframes 只许在产地
    if (rel !== MOTION_ORIGIN) {
      const re = /@keyframes\s+([\w-]+)/g
      let m
      while ((m = re.exec(css)) !== null) {
        hits.push(`${rel}:${lineOf(css, m.index)} keyframes ${m[1]}`)
      }
    }

    // ① 组件文件里不许出现字面时长(产地自己也守这条 —— 档位块写的是 token 定义,
    //    不是 transition/animation 声明,所以它天然不会命中)
    TIMED_PROPERTY.lastIndex = 0
    let d
    while ((d = TIMED_PROPERTY.exec(css)) !== null) {
      if (!LITERAL_TIME.test(d[4])) continue
      const property = `${d[2]}${d[3] ?? ''}`
      hits.push(`${rel}:${lineOf(css, d.index)} literal-time ${property}`)
    }

    // ③ 动画名只许 var(--kf-*) —— 产地自己例外:那里是名字的定义处。
    if (rel !== MOTION_ORIGIN) {
      ANIMATION_PROPERTY.lastIndex = 0
      let a
      while ((a = ANIMATION_PROPERTY.exec(css)) !== null) {
        const name = literalAnimationName(a[3])
        if (!name) continue
        hits.push(`${rel}:${lineOf(css, a.index)} literal-animation ${name}`)
      }
    }
  }
  return hits.sort()
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const hits = findViolations()
  for (const hit of hits) console.log(hit)
  const count = (mark) => hits.filter((h) => h.includes(` ${mark} `)).length
  console.log(
    `\n[motion-check] ${hits.length} 条:` +
      `${count('keyframes')} 段 @keyframes 住在产地之外、` +
      `${count('literal-time')} 处写了字面时长、` +
      `${count('literal-animation')} 处写了字面动画名`,
  )
}
