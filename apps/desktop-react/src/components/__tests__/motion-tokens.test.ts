import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  ATT_GRACE_MS,
  CARD_FLIP_MS,
  DOCK_HIDE_DELAY_MS,
  DOCK_WAKE_DWELL_MS,
  DUR_MS,
  LAND_MS,
  NEIGHBOR_MS,
  SETTLE_MS,
  EXIT_MS,
  EXIT_MS_BY_TIER,
  FLASH_MS,
  DOCK_LENS_MS,
  DRAWER_MS,
  RELEASE_MS,
  TOAST_LIFE_MS,
  TOC_FLASH_MS,
  TOC_HOVER_MS,
  TOOLTIP_DELAY_MS,
} from '../motion'

/**
 * **一个数只有一个出处** —— 时长在 CSS 里是 token,在 JS 里是常量,两边必须相等。
 *
 * 从前这只是 components/motion.ts 文件头上的一句话("改时长时两边一起改这一处"),
 * 没有任何东西拦着人只改一边。这只测试就是那句话的执法:它**解析 tokens.css 的
 * 文本**,逐条比对。tokens.css 是产地,JS 那一份是镜像 —— 所以对不上时该改的
 * 永远是 JS(除非产地本身就是要改的那一处)。
 */

const stylesDir = path.resolve(__dirname, '../../styles')
const tokensCss = readFileSync(path.join(stylesDir, 'tokens.css'), 'utf-8')
const motionCss = readFileSync(path.join(stylesDir, 'motion.css'), 'utf-8')
/** 注释里会**提到**档位名(说明为什么不写 standard 那个块),查规则得先把注释掏掉。 */
const motionCode = motionCss.replace(/\/\*[\s\S]*?\*\//g, '')

/** 读 `:root { … --name: 120ms; … }` 里那个数(ms)。取**第一处**声明。 */
function tokenMs(css: string, name: string): number | undefined {
  const match = new RegExp(`${name}\\s*:\\s*([0-9.]+)(ms|s)\\s*;`).exec(css)
  if (!match) return undefined
  const n = Number.parseFloat(match[1])
  return match[2] === 's' ? n * 1000 : n
}

/** 读某个档位块里的那个数 —— 先切出块,再在块里找。 */
function tierMs(tier: string, name: string): number | undefined {
  const head = `:root[data-motion-tier='${tier}']`
  const at = motionCode.indexOf(head)
  if (at < 0) return undefined
  const block = motionCode.slice(at, motionCode.indexOf('}', at))
  return tokenMs(block, name)
}

describe('JS 侧的时长常量与 tokens.css 逐条相等', () => {
  it.each([
    ['--dur', DUR_MS],
    ['--dur-exit', EXIT_MS],
    ['--dur-release', RELEASE_MS],
    ['--dur-flash', FLASH_MS],
    ['--dur-tooltip-delay', TOOLTIP_DELAY_MS],
    ['--dur-toc-hover', TOC_HOVER_MS],
    ['--dur-toc-flash', TOC_FLASH_MS],
    ['--dur-att-grace', ATT_GRACE_MS],
    /*
     * Dock 镜头开合(分类 ④,见 styles/motion.css 文件头)。它进这张表的理由与
     * 其它几行一模一样:**时长的产地是 tokens.css**,JS 那份是镜像。
     * 09-02 第二轮它换了名字与语义:从「跟手期临界阻尼的 τ」变成「进出标量的
     * 过渡时长」—— 跟手期已经没有第二个时钟了。
     */
    ['--dur-dock-lens', DOCK_LENS_MS],
    /* **手势/宽限**窗口(不是动画,动效档不清零它)。这一类一直有 token 也一直有
     * JS 常量,却一直不在这张表里 —— 09-01 顺手补齐:一个数只有一个出处这条纪律,
     * 不该按「是不是动画」挑着执行。09-02 预览泡退役,它那四条(preview-delay /
     * -grace / -switch / dock-aim-window)与回身窗口的 dock-reentry 一并删了。 */
    ['--dur-dock-hide-delay', DOCK_HIDE_DELAY_MS],
    /* 09-03 新增的同类:唤醒停留门槛(碰到 → 停留)。它与收回宽限是一对
     * ——一个说「多久才叫得出来」,一个说「多久才收得回去」,两个都是手势窗口。 */
    ['--dur-dock-wake', DOCK_WAKE_DWELL_MS],
    /* 工具卡的 FLIP(C2-a):JS 侧那个数只服务收尾定时器(过渡跑完摘掉内联 height),
     * 产地仍是 tokens.css —— 与 --dur-exit 同一条理由。 */
    ['--dur-card-flip', CARD_FLIP_MS],
    /* composer 抽屉槽的开合(09-12 补):候选列表的高度 FLIP 复用它,收尾定时器
     * 要这个数 —— 与 --dur-card-flip 同一条理由。 */
    ['--dur-drawer', DRAWER_MS],
    /* 拖拽的三拍(W6-b,设计 `docs/workbench-tabs-2026-09.md` §4.1)。三个都是动画
     * (让位 / 滑入新槽 / 卡片飞入),各有一个 JS 收尾定时器跟着走。
     * 从前还有第四行,镜像那个「停多久算我要二合一」的时长 —— 二合一先改成位置
     * 判据(条底缘下 6–24px),token 与 JS 常量当时就一起没了;U2(2026-09-08)
     * 又把那条带整段删掉(判词在 `ui/drag/constants.ts` 的 `ONTO_FROM_PX` 退役段),
     * 标签条上从此没有这件事,这一行更没有回来的理由。 */
    ['--dur-neighbor', NEIGHBOR_MS],
    ['--dur-settle', SETTLE_MS],
    ['--dur-land', LAND_MS],
  ])('%s', (name, js) => {
    expect(tokenMs(tokensCss, name), `tokens.css 里找不到 ${name}`).toBe(js)
  })

  it('toast 的三档寿命也是一张表两处写(级别 → ms)', () => {
    expect(tokenMs(tokensCss, '--dur-toast-success')).toBe(TOAST_LIFE_MS.success)
    expect(tokenMs(tokensCss, '--dur-toast-info')).toBe(TOAST_LIFE_MS.info)
    expect(tokenMs(tokensCss, '--dur-toast-warn')).toBe(TOAST_LIFE_MS.warn)
  })
})

describe('名字表与关键帧一一对应', () => {
  const declared = [...motionCode.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]).sort()
  const named = [...motionCode.matchAll(/--kf-[a-z0-9-]+:\s*([\w-]+)\s*;/g)].map((m) => m[1]).sort()

  /*
   * 这两条守的是**同一个坑的两半**(病历在 styles/motion.css 的文件头):
   * 名字表少一行 → 有段关键帧没人能引;名字表多一行 → 组件引到一个不存在的名字,
   * 动画静默不播。两种都不该在构建里才被发现,更不该在真机上才被看见。
   */
  it('每段 @keyframes 都有一个 --kf-* token 指着它', () => {
    expect(named).toEqual(declared)
  })

  it('名字表里没有指向空气的 token', () => {
    for (const name of named) expect(declared, `--kf-* 指着不存在的 ${name}`).toContain(name)
  })
})

describe('动效档:JS 镜像的那一列与 motion.css 的档位块相等', () => {
  it('standard 就是 tokens.css 的原值(档位块里刻意没有这一档)', () => {
    expect(EXIT_MS_BY_TIER.standard).toBe(tokenMs(tokensCss, '--dur-exit'))
    // 写一个把每个数抄一遍的 standard 块 = 第二份真相。规则里不许有它
    //(注释里可以提它 —— 那正是在解释为什么没有)。
    expect(motionCode).not.toContain("data-motion-tier='standard'")
  })

  it('calm 的 --dur-exit 与 JS 那一格相等', () => {
    expect(tierMs('calm', '--dur-exit')).toBe(EXIT_MS_BY_TIER.calm)
  })

  it('none 的 --dur-exit 是 0,JS 那一格也是 0', () => {
    expect(tierMs('none', '--dur-exit')).toBe(0)
    expect(EXIT_MS_BY_TIER.none).toBe(0)
  })

  it('calm 只减半那五个装饰时长,--dur 与 --dur-release 一个都不动', () => {
    for (const name of [
      '--dur-enter',
      '--dur-exit',
      '--dur-hover-fade',
      '--dur-flash',
    ]) {
      expect(tierMs('calm', name), name).toBe(tokenMs(tokensCss, name)! / 2)
    }
    expect(tierMs('calm', '--dur')).toBeUndefined()
    expect(tierMs('calm', '--dur-release')).toBeUndefined()
  })

  it('none 把整张装饰表归 0,而延迟与寿命一格都不碰', () => {
    const decorative = [
      '--dur',
      '--dur-enter',
      '--dur-exit',
      '--dur-release',
      '--dur-flash',
      '--dur-hover-fade',
      '--dur-toc-flash',
      '--dur-cursor-blink',
      '--dur-drawer',
      '--dur-mode',
      '--dur-att-move',
      '--dur-tool-pulse',
    ]
    for (const name of decorative) expect(tierMs('none', name), name).toBe(0)

    // 延迟不是动画,寿命 / 进度读数也不是 —— 归 0 等于删掉这件事的信号。
    // 分类表在 styles/motion.css 的文件头,这几条是它的执法。
    for (const name of [
      '--dur-tooltip-delay',
      '--dur-preview-delay',
      '--dur-toc-hover',
      '--dur-att-grace',
      '--dur-dock-wake',
      '--dur-spin',
      '--dur-toast-success',
      '--dur-toast-info',
      '--dur-toast-warn',
    ]) {
      expect(tierMs('none', name), `${name} 属于延迟 / 寿命,不该进 none 的归零表`).toBeUndefined()
    }
  })
})
