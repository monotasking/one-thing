import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { FoldIntentContext, useNoteFold } from '../fold-intent'

/**
 * **折起来那条通道**(单 B ④,正本 `docs/send-flow-2026-09.md` §2 规矩 ④)。
 *
 * 值得进 jsdom 的只有**判据**那一半:通道通不通、缺省是不是 noop、谁在什么时候报。
 * 「钉住了没有」是几何,由真机门量(`gate:send-flow` ④:收尾那一帧起 300ms,
 * 视口内第一块在读的东西位移 ≤ 1px;超量档还要证明折叠中 `scrollTop` 有余量)。
 */

const shellSrc = (rel: string) =>
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')

function Reporter({ ms }: { ms: number }) {
  const note = useNoteFold()
  note(ms)
  return null
}

describe('fold-intent:报一句「我开始折了」', () => {
  it('缺省是 noop —— 流之外的消费者(样例页 / 单测)一个字都不必知道有这回事', () => {
    expect(() => render(<Reporter ms={180} />)).not.toThrow()
  })

  it('装了通道就报到那一头,带的是**那段过渡有多长**', () => {
    const heard: number[] = []
    render(
      <FoldIntentContext.Provider value={(ms) => heard.push(ms)}>
        <Reporter ms={180} />
      </FoldIntentContext.Provider>,
    )
    expect(heard).toEqual([180])
  })
})

/**
 * 两条通道**不许合并**:展开说的是「别贴底」,折起说的是「把人正在读的那一行钉住」,
 * 做的事正好相反。合回一格就等于把两条相反的补偿挤进一个判据。
 */
describe('两条通道分家', () => {
  const expandSrc = shellSrc('../expand-intent.ts')
  const foldSrc = shellSrc('../fold-intent.ts')

  it('各有各的 context,谁都不导入谁', () => {
    expect(expandSrc).toMatch(/ExpandIntentContext\s*=\s*createContext/)
    expect(foldSrc).toMatch(/FoldIntentContext\s*=\s*createContext/)
    expect(expandSrc).not.toMatch(/fold-intent/)
    expect(foldSrc).not.toMatch(/expand-intent/)
  })

  it('折起那一条记的是**时长**(过渡逐帧来好几次,一次性闩活不过第一帧)', () => {
    expect(foldSrc).toMatch(/useNoteFold\(\):\s*\(ms: number\) => void/)
  })
})

describe('聊天流那一头:折叠分支只写 scrollTop,不改布局', () => {
  /*
   * ── 取件口从 `ChatStream.tsx` 搬到了 `content/viewport/scroll-port.ts`
   *    (G 线 P2-a)──────────────────────────────────────────────────────────
   * `firstVisibleChild` / `pickFoldAnchor` 是**量 DOM** 的两句,按 §13.2.1
   * 的切法它们住在适配层;折叠那一支的裁决仍在 `ChatStream.tsx`(P2-a 只搬件,
   * 不改裁决)。所以这一组的断言分成两半,各扫各的文件 —— 断言一个字没松。
   */
  const src = shellSrc('../ChatStream.tsx')
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
    const branch = /const hold = intents\.folding\(([\s\S]*?)\n {6}let contentGrew/.exec(src)?.[1] ?? ''
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

  it('开始折的那一帧报一句,动效档「无」下不报(那一档没有「一段过渡」)', () => {
    expect(src).toMatch(/const folding = wasExpanded\.current && !expanded/)
    expect(src).toMatch(/if \(currentMotionTier\(\) === 'none'\) return/)
    expect(src).toMatch(/noteFold\(CARD_FLIP_MS\)/)
  })

  it('`data-prose` / `data-testid` 仍与 role=button 在同一个元素上(取件口没搬家)', () => {
    const trigger = /<FoldTrigger([\s\S]*?)>/.exec(src)?.[1] ?? ''
    expect(trigger).toMatch(/ref=\{boxRef\}/)
    expect(trigger).toMatch(/data-prose="thought"/)
    expect(trigger).toMatch(/data-testid="chat-thought"/)
  })
})
