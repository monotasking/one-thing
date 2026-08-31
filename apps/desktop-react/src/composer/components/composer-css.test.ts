import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 输入面的**光标形状**(08-31 真机报障:空框时鼠标停在占位符上是箭头,不是 I 形)。
 *
 * ── 为什么这一条是读样式表,而不是读一次 `getComputedStyle` ────────────────
 * 这一批的样式是 CSS Modules:在 vitest 里 `import s from './x.module.css'` 拿回来的
 * 是一张**类名映射**,那份 CSS 从来没有进过 jsdom 的样式表(vite 只在浏览器里注入它)。
 * 于是 `getComputedStyle(el).cursor` 在这台机器上恒等于 `auto` —— 它答的是
 * 「jsdom 没有这条规则」,不是「这块 UI 的光标是什么」。拿它当断言,规则删掉了也照样绿。
 *
 * 而这条报障的产地恰恰**就是那两行 CSS**。所以门就守在产地上:读源文件,断言那两行
 * 还在。它验不了浏览器怎么画(那要真机),但它守得住「有人把这两行删了」——
 * 这正是这条报障复发的唯一方式。
 */

/*
 * 从**应用根**拼路径(vitest 的 cwd 就是 apps/desktop-react):`import.meta.url`
 * 在这套配置下不是一条 file: URL,拿它去 fileURLToPath 会当场抛。
 */
const css = readFileSync(
  resolve(process.cwd(), 'src/composer/components/Composer.module.css'),
  'utf8',
)

/** 取一条规则的整块声明(`.sel {...}` 里那一段)。 */
function block(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  expect(at, `样式表里找不到 ${selector}`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', at)
  return css.slice(at, end)
}

describe('可编辑区的光标形状(08-31 报障的产地)', () => {
  it.each([
    ['.input', '本体行的输入面'],
    ['.askFree', 'ask 形态里「其他」那一行'],
  ])('%s(%s)显式声明 cursor: text —— 不靠 auto 去猜', (selector) => {
    expect(block(selector)).toMatch(/cursor:\s*text/)
  })

  it.each([
    ['.input:empty::before', '输入面的占位符'],
    ['.askFree:empty::before', '「其他」那一行的占位符'],
  ])('%s(%s)是画出来的一句话,命中测试一律穿过去', (selector) => {
    expect(block(selector)).toMatch(/pointer-events:\s*none/)
  })
})
