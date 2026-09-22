import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * **折起来那条通道**(单 B ④,正本 `docs/send-flow-2026-09.md` §2 规矩 ④)。
 *
 * 值得进 jsdom 的只有**判据**那一半:通道通不通、缺省是不是 noop、谁在什么时候报。
 * 「钉住了没有」是几何,由真机门量(`gate:send-flow` ④:收尾那一帧起 300ms,
 * 视口内第一块在读的东西位移 ≤ 1px;超量档还要证明折叠中 `scrollTop` 有余量)。
 *
 * **通道本身 G 线 P2-c 已经合一**:`content/fold-intent.ts` /
 * `content/expand-intent.ts` 两条各说一半的老 context 整件退役,开与合都走
 * `content/geometry-report.ts`(那一条的用例在 `geometry-report.test.tsx`)。
 * 这只文件留下的是**几何那一半的判据**:折叠分支写什么、锚怎么选。
 */

const shellSrc = (rel: string) =>
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')

const shellPath = (rel: string) =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), rel)

/**
 * 两条老通道**整件退役**(G 线 P2-c)。它们从前分家是对的 —— 展开说「别贴底」、
 * 折起说「把人正在读的那一行钉住」,做的事正好相反;合一之后方向由**报的人给的
 * `open`** 说,不由「你调了哪一个函数」说,两条相反的补偿因此仍然是两支,只是
 * 分叉点从「哪条 context」搬到了裁决者里(`ViewportAnchor.reportUserToggle`)。
 */
describe('两条老通道退役', () => {
  it('文件没了', () => {
    expect(existsSync(shellPath('../fold-intent.ts'))).toBe(false)
    expect(existsSync(shellPath('../expand-intent.ts'))).toBe(false)
  })

  it('全流里没有一处还在引它们', () => {
    for (const rel of ['../ChatStream.tsx', '../ThinkingSegment.tsx', '../tools/ToolCard.tsx',
      '../CompactSeam.tsx', '../ContextDeltaSeam.tsx', '../viewport/use-viewport-anchor.ts']) {
      const src = shellSrc(rel)
      expect(src).not.toMatch(/fold-intent|expand-intent/)
      expect(src).not.toMatch(/useNoteFold|useNoteUserExpand/)
    }
  })

  it('引擎那一侧的窗口收成一格(`IntentWindow` 里没有第二格展开窗)', () => {
    const src = shellSrc('../viewport/intent-window.ts')
    expect(src).toMatch(/#hold: Hold \| undefined/)
    expect(src).not.toMatch(/#expandUntil/)
    expect(src).not.toMatch(/noteExpand|clearExpand|expanding\(/)
  })
})

describe('聊天流那一头:折叠分支只写 scrollTop,不改布局', () => {
  /*
   * ── 这一组扫两个文件(G 线 P2-a)──────────────────────────────────────────
   * `firstVisibleChild` / `pickFoldAnchor` 是**量 DOM** 的两句,按 §13.2.1 的切法
   * 它们住在适配层(`viewport/scroll-port.ts`);折叠那一支的**裁决**住在
   * `viewport/anchor.ts`。断言一个字没松,只是各扫各的。
   */
  const src = shellSrc('../viewport/anchor.ts')
  const portSrc = shellSrc('../viewport/scroll-port.ts')

  it('锚是「视口内第一块在读的东西」,座位垫块不算', () => {
    const one = /function firstVisibleChild\(([\s\S]*?)\n\}/.exec(portSrc)?.[1] ?? ''
    expect(one).not.toBe('')
    expect(one).toMatch(/hasAttribute\(SEAT_ATTR\)/)
    expect(one).toMatch(/getBoundingClientRect\(\)\.bottom > top/)
  })

  /**
   * **锚要钻到「块」,不许停在「行」上**(09-15 真机改判,反证写在 `pickFoldAnchor`
   * 的判词里):一轮长回答的那条助手行从视口上面几千像素处起头,思考段折回一行时
   * **行的上缘一动不动**,于是「锚漂了多少」恒为 0、补偿一次都没发生 —— ④ 那条断言
   * 曾经因此恒绿(把补偿整句拆掉重跑,门照样全绿)。长回那一支补上思考段后真相显形:
   * 锚点位移 1517px。
   */
  it('一层不够就往里钻,直到某一件**整个**落在视口上缘之下', () => {
    const fn = /pickFoldAnchor\(\): AnchoredElement \| undefined \{([\s\S]*?)\n {2}\}/.exec(portSrc)?.[1] ?? ''
    expect(fn).not.toBe('')
    expect(fn).toMatch(/depth < FOLD_ANCHOR_DEPTH/)
    expect(fn).toMatch(/firstVisibleChild\(cursor, top\)/)
    // 整块都在视口里就停:再往里钻不会有更好的锚。
    expect(fn).toMatch(/getBoundingClientRect\(\)\.top >= top - 1\) break/)
  })

  /**
   * 二分不是优化癖:这只函数跑在**折叠的每一帧**里,而超量那一档列里有 400 行 ——
   * 逐个扫就是每帧几百次 `getBoundingClientRect`。
   */
  it('一层里的查找是二分(同层 `bottom` 单调),不是逐个扫', () => {
    const one = /function firstVisibleChild\(([\s\S]*?)\n\}/.exec(portSrc)?.[1] ?? ''
    expect(one).toMatch(/const mid = \(lo \+ hi\) >> 1/)
    expect(one).not.toMatch(/for \(const /)
  })

  /**
   * 反证口:把那一句 `port.setTop(…)` 换成改布局的写法(给垫块写高之类),
   * 这一条当场红 —— 「观察器回调只读不写」禁的是**改布局**,`scrollTop` 不改布局。
   */
  it('折叠分支里除了 scrollTop 与两格记账,不碰别的', () => {
    const branch = /const hold = this\.#intents\.current\(([\s\S]*?)\n {4}let contentGrew/.exec(src)?.[1] ?? ''
    expect(branch).not.toBe('')
    expect(branch).toMatch(/port\.setTop\(Math\.max\(0, port\.top \+ drift\), 'user-toggle'\)/)
    // 不许在这一支里写样式 / 写垫块 —— 那是改布局,会把自己变成下一轮派发的起点。
    expect(branch).not.toMatch(/\.style\./)
    expect(branch).not.toMatch(/writeSeat\(\)/)
  })

  it('补不动了就让内容动:`scrollTop` 夹在 0', () => {
    expect(src).toMatch(/Math\.max\(0, port\.top \+ drift\)/)
  })
})

describe('思考段:收尾那一下是高度过渡,不是跳回去', () => {
  const src = shellSrc('../ThinkingSegment.tsx')

  it('机制复用 `ui/flip-height`,账本是这一族自己那本', () => {
    expect(src).toMatch(/useFlipHeight\(boxRef, expanded \? 'open' : 'closed'/)
    expect(src).toMatch(/book: thoughtHeights/)
    expect(src).toMatch(/durVar: '--dur-card-flip'/)
  })

  /**
   * **G 线 P2-b 换了通道**:从前这里是一只 layout effect 里的 `noteFold(CARD_FLIP_MS)`
   * —— 它跑在**已经折起来的 DOM** 上,垫块与锚都晚了一拍,而且动效档「无」下整段
   * 不报(那一档没有过渡,可钳位照样发生)。今天开与合都在**事件处理函数里**报,
   * 而且 `setExpanded` 吃的就是 `report()` 的返回值:拿不到它就写不了状态。
   */
  it('开合在改状态之前同步报一句,`setExpanded` 吃的是它的返回值', () => {
    expect(src).toMatch(/const report = useGeometryReport\(\)/)
    expect(src).toMatch(/onOpenChange=\{\(open\) => setExpanded\(report\.toggle\(\{/)
    expect(src).toMatch(/el: boxRef\.current/)
  })

  it('动效档「无」照报,只是那一段过渡长度是 0', () => {
    expect(src).toMatch(/durationMs: currentMotionTier\(\) === 'none' \? 0 : CARD_FLIP_MS/)
    // 旧通道那两句不许长回来(它们是「晚一拍」与「这一档不报」的产地)。
    expect(src).not.toMatch(/useNoteFold/)
    expect(src).not.toMatch(/useNoteUserExpand/)
  })

  it('`data-prose` / `data-testid` 仍与 role=button 在同一个元素上(取件口没搬家)', () => {
    const trigger = /<FoldTrigger([\s\S]*?)>/.exec(src)?.[1] ?? ''
    expect(trigger).toMatch(/ref=\{boxRef\}/)
    expect(trigger).toMatch(/data-prose="thought"/)
    expect(trigger).toMatch(/data-testid="chat-thought"/)
  })
})
