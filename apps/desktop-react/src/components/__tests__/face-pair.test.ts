import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * **脸与檐是一对,谁改写脸谁就得改写檐**(2026-09-14,判词在 tokens.css `--strip-face`)。
 *
 * 自定义属性在**声明处**求值:根上 `--strip-face` 从 `--surface-0` 兑出来之后,架子把
 * `--pane-face` 改写成 `--surface-2`,檐并不跟着变 —— 用户主题真机读数是檐 #E9E9E9 对
 * 活动 tab #ECECED,差 3 个灰阶。所以每一条改写了 `--pane-face` 的规则,**同一个花括号里**
 * 必须也改写 `--strip-face`;而 `--code-face` 的缺省「= 叶的脸」只许写在读它的地方
 * (`var(--code-face, var(--pane-face))`),根上一声明就又是同一个病。
 */
const SRC = path.resolve(__dirname, '../..')

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) cssFiles(p, out)
    else if (name.endsWith('.css')) out.push(p)
  }
  return out
}

/**
 * 一份样式表里每个 `{ … }` 块的正文(嵌套花括号在本仓 CSS 里不出现,`@media` 块只当外层)。
 * **先剥注释**(壳 CLAUDE.md「读样式表源文本的门先剥注释」):病历文本里常有 `{ }`,
 * 不剥的话 tokens.css 的 `:root` 块会被一条注释切成两半,`--pane-face` 与 `--strip-face` 落进两块。
 */
function blocksOf(text: string): string[] {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks: string[] = []
  const re = /\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped))) blocks.push(m[1])
  return blocks
}

describe('脸与檐配对', () => {
  const files = cssFiles(SRC)

  it('每一条改写 --pane-face 的规则在同一块里也改写 --strip-face', () => {
    const offenders: string[] = []
    let pairs = 0
    for (const file of files) {
      for (const block of blocksOf(readFileSync(file, 'utf8'))) {
        if (!/^\s*--pane-face\s*:/m.test(block)) continue
        pairs += 1
        if (!/^\s*--strip-face\s*:/m.test(block)) offenders.push(path.relative(SRC, file))
      }
    }
    expect(offenders).toEqual([])
    // 根 + 架子 / 浮窗 / 舞台 / 全屏:少了说明有宿主把脸的声明搬走了,多了说明长出了新宿主 —— 都该来改这个数。
    expect(pairs).toBe(5)
  })

  it('--code-face 不在根上声明:缺省落在读它的地方', () => {
    const tokens = readFileSync(path.join(SRC, 'styles/tokens.css'), 'utf8')
    expect(/^\s*--code-face\s*:/m.test(tokens)).toBe(false)
    const lines = readFileSync(path.join(SRC, 'content/code/CodeLines.module.css'), 'utf8')
    const reads = lines.match(/var\(--code-face(?:, var\(--pane-face\))?\)/g) ?? []
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) expect(read).toBe('var(--code-face, var(--pane-face))')
  })
})
