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

/**
 * 抽屉候选列表的**封顶**(08-31 真机报障:`@` 命中一多,抽屉一直往上长)。
 *
 * 与上面那一族同一条理由守在产地上:CSS Modules 那份样式表没进过 jsdom,
 * `getComputedStyle(...).maxHeight` 在这台机器上恒等于空 —— 它答的是
 * 「jsdom 没有这条规则」。而这条报障的产地就是这三行 CSS,删掉任何一行都复发。
 *
 * 「选中项滚进视野」是**行为**,不在这里:Composer.test.tsx 里真按一下 ↑↓ 去验。
 * 两件事必须都在 —— 只封顶不滚,比不封顶更糟。
 */
describe('抽屉候选列表:封顶 + 自己滚 + 不把滚动传给身后', () => {
  const scroll = () => block('.pickScroll')

  it('列表区有上限,而且上限走 token(不是拍在样式表里的一个像素数)', () => {
    expect(scroll()).toMatch(/max-height:\s*var\(--composer-drawer-max\)/)
  })

  it('超出照常滚:纵向 auto', () => {
    expect(scroll()).toMatch(/overflow-y:\s*auto/)
  })

  /* 仓判例(Select / Tabs / 目录 / 文件面):浮在正文上的一层,滚到头之后
   * 不把剩下的滚动量传给身后的聊天流。 */
  it('滚到头不把滚动链传给身后的聊天流', () => {
    expect(scroll()).toMatch(/overscroll-behavior:\s*contain/)
  })

  /* 抽屉本身的开合语义**一字未动**:封顶的是列表区,不是抽屉。
   * 这一条守的就是「有人图省事把上限加到 .drawer 上」那种改法。 */
  it('抽屉自己仍然是 grid 0fr↔1fr,没有被顺手改成 max-height', () => {
    expect(block('.drawer')).toMatch(/grid-template-rows:\s*0fr/)
    expect(block('.drawer')).not.toMatch(/max-height/)
  })
})
