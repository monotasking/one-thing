import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, expect, it } from 'vitest'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const rendererDir = path.resolve(dirname, '..', '..')

// Chromium 只让 drag 元素的 **子孙** 用 no-drag 挖洞。跨分支的 fixed 浮层挖不动,
// 所以一旦某个控件浮在另一条分支的顶栏上,就只能靠"按坐标手工预留一块 no-drag"
// 来给它让位 —— 而那块预留必然是死的:它盖住的是一段坐标区间,不是控件本身,
// 控件数量、侧栏宽度、交通灯位置任一变化都会让洞和控件错开,错开的部分要么
// 吃掉点击,要么变成拖不动的死带。2026-07-29 侧栏收起时"按钮和红绿灯之外拖不动"
// 就是这么来的。
//
// 现在的规矩:每一行顶栏是自己那条 drag 的根,控件都是它的真实子孙,靠自身
// no-drag 挖洞。这条守卫拦住"预留槽"这种写法回来。

// `components/MediaPanel.vue` 曾是第三位 drag 宿主(它那条 40px 头带着交通灯
// 让位与 SidebarActionGroup)。P1 把六个工作区面板迁进右侧工作台之后那个全屏
// 容器整个拆除,连带它那条顶栏 —— 侧栏收起时的落点回到 SessionHeader(聊天区
// 现在永远在屏上,不再会被面板盖住),**没有新开让位槽**。
const HEADER_HOSTS = [
  'components/chat/SessionHeader.vue',
  'components/sidebar/SidebarHeader.vue',
]

function read(relativePath: string): string {
  return fs.readFileSync(path.join(rendererDir, relativePath), 'utf8')
}

function ruleBlocksFor(source: string, selectorFragment: string): string[] {
  const blocks: string[] = []
  const pattern = new RegExp(`[^{}]*${selectorFragment}[^{}]*\\{([^{}]*)\\}`, 'g')
  for (const match of source.matchAll(pattern)) blocks.push(match[1])
  return blocks
}

describe('顶栏拖拽区的组合方式', () => {
  it('操作按钮不再是跨分支的 fixed 浮层', () => {
    const app = read('App.vue')
    expect(app).not.toContain('app-sidebar-actions')
    // 那条 100vw 的假 drag 带子只是在补浮层够不着的红绿灯段,一并作废。
    expect(app).not.toMatch(/width:\s*100vw[\s\S]{0,120}-webkit-app-region:\s*drag/)
  })

  it('按钮住在各自的 drag 宿主里', () => {
    expect(read('components/sidebar/SidebarHeader.vue')).toContain('<slot />')
    expect(read('components/chat/SessionHeader.vue')).toContain('<SidebarActionGroup')
  })

  it('没有任何"让位槽"再声明 no-drag', () => {
    const offenders: string[] = []
    for (const host of HEADER_HOSTS) {
      const source = read(host)
      for (const block of ruleBlocksFor(source, '-actions-slot')) {
        if (/-webkit-app-region:\s*no-drag/.test(block)) {
          offenders.push(`${host}: 让位槽自己声明了 no-drag`)
        }
      }
      for (const block of ruleBlocksFor(source, 'traffic-lights-space')) {
        if (/-webkit-app-region:\s*no-drag/.test(block)) {
          offenders.push(`${host}: 交通灯让位区自己声明了 no-drag`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('按钮组自己带 no-drag —— 洞由控件挖,不由坐标挖', () => {
    const group = read('components/sidebar/SidebarActionGroup.vue')
    expect(group).toMatch(/\.sidebar-action-group\s*\{[^}]*-webkit-app-region:\s*no-drag/)
    expect(group).toMatch(/\.sidebar-action-btn\s*\{[^}]*-webkit-app-region:\s*no-drag/)
  })
})
