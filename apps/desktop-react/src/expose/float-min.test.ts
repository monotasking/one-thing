import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXPOSE_FLOAT_MIN, EXPOSE_RAIL_BP } from './float-min'
import { findItem, floatMinOfItem, SESSIONS_ITEM_ID } from '../stage/items'

/**
 * **同一个阈值的四份写法,对账在这里**(W7-d 裁定 1)。
 *
 * 侧栏那道阈值在仓里有**七份**(09-12 方向 A 从四份长到七份:两种形之后,
 * 「宽档怎么画」是每一件各自那一组覆写):tokens.css 的 `--expose-rail-bp`、
 * `Rail.module.css` 那条 `max-width: 760`、`NavRows` / `SessionRow` /
 * `SectionHead` / `SessionTree` / `Overview` 五件各自那条 `min-width: 761`
 * (`@container` 的条件里不能写 `var()`,那条判例写在 tokens 里),
 * 以及 W7-d 加的这一份 JS 常量(纯函数读不了 CSS)。
 * 七份**必须同源**,而「哪天忘了同步」不该由人记 —— 这只用例把真的 CSS 文本读进来比。
 *
 * `resolve` 用相对**仓库工作目录**的路径而不是 `__dirname`:jsdom 环境里
 * `import.meta.url` 是个 http URL(同一条判例见 `stage/transitions.test.ts` 末尾那组)。
 */
const css = (rel: string): string =>
  readFileSync(resolve(rel), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')

describe('会话总览自述的浮窗下限(W7-d 裁定 1)', () => {
  it('阈值七处同源:tokens、Rail、五件宽档覆写、这格 JS 常量', () => {
    const tokens = /--expose-rail-bp:\s*([0-9.]+)px/.exec(css('src/styles/tokens.css'))
    expect(tokens?.[1]).toBe(String(EXPOSE_RAIL_BP))
    // 侧栏那一条说的是「≤ 阈值就不在场」。
    expect(css('src/expose/components/Rail.module.css')).toMatch(
      new RegExp(`@container expose \\(max-width: ${EXPOSE_RAIL_BP}px\\)`),
    )
    /*
     * 总览形那五组覆写说的是「> 阈值才画成那样」—— 所以字面量是阈值 +1。
     * 逐件问而不是随便找一件:09-12 的两种形是**每一件各自**声明的
     * (行的几何 / 节头的高 / 列表的页边距 / 范围行在不在 / 错误行的页边距),
     * 少一件就是那一件在宽档里还长着侧栏形的样子,而这正是抄阈值最容易漏的地方。
     */
    for (const file of [
      'NavRows.module.css',
      'SessionRow.module.css',
      'SectionHead.module.css',
      'SessionTree.module.css',
      'Overview.module.css',
    ]) {
      expect(css(`src/expose/components/${file}`), file).toMatch(
        new RegExp(`@container expose \\(min-width: ${EXPOSE_RAIL_BP + 1}px\\)`),
      )
    }
  })

  it('自述的宽度真的落在**宽档**里,而且留了一档余量', () => {
    // 这一条是这格常量存在的全部理由:640(FLOAT_DEFAULT_W)< 761 才有了 gate:a11y 那两条红。
    expect(EXPOSE_FLOAT_MIN.w ?? 0).toBeGreaterThan(EXPOSE_RAIL_BP)
    /*
     * 阈值量的是**容器**(`.view` 的 inline-size),自述量的是**窗**:中间隔着窗的
     * 边框(今天各 1px)与将来可能长出来的内衬。骑在阈值上的那一两个像素量的是舍入
     * 不是形(与 `gate:squeeze` 的 `CONTAINER_BANDS` 取 800 逐字同一条判词),
     * 所以这里要求一档实打实的余量,而不是「差一像素也算过」。
     */
    expect(EXPOSE_FLOAT_MIN.w ?? 0).toBeGreaterThanOrEqual(EXPOSE_RAIL_BP + 32)
    // 高度没有意见:这块面窄了会换形,矮了只是少几行(判词在 float-min.ts 上)。
    expect(EXPOSE_FLOAT_MIN.h).toBeUndefined()
  })

  it('名册上挂着它,而且壳读表读得到(只有这一块面自述)', () => {
    expect(findItem(SESSIONS_ITEM_ID)?.floatMin).toBe(EXPOSE_FLOAT_MIN)
    expect(floatMinOfItem(SESSIONS_ITEM_ID)).toBe(EXPOSE_FLOAT_MIN)
    // 没自述的一律 undefined —— 缺席就是「听全体默认身量的」。
    expect(floatMinOfItem('terminal')).toBeUndefined()
    expect(floatMinOfItem(null)).toBeUndefined()
    expect(floatMinOfItem('不认识这块瓦')).toBeUndefined()
  })
})
