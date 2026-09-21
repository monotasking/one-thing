import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { GeometryReportContext, useGeometryReport, type UserToggle } from '../geometry-report'

/**
 * **「人亲手开合了一块东西」那一条通道**(G 线 P2-b,正本
 * `docs/stream-geometry-2026-09.md` §15.4)。
 *
 * 值得进 jsdom 的只有**判据**那一半:通道通不通、缺省是不是恒等、四族可折叠的东西
 * 是不是都接上了、`viewport/` 里有没有出现它们的名字。「钉住了没有 / 垫块垫了多高」
 * 是几何,由真机门 `gate:fold-collapse` 量。
 */

const shellSrc = (rel: string) =>
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')

function Reporter({ change }: { change: UserToggle }) {
  const report = useGeometryReport()
  Reporter.answer = report(change)
  return null
}
Reporter.answer = undefined as boolean | undefined

const CHANGE: UserToggle = { el: null, open: false, durationMs: 180 }

describe('geometry-report:开与合走同一个口', () => {
  it('缺省是**恒等**,不是 noop —— 流之外的消费者照样写得了状态', () => {
    render(<Reporter change={{ ...CHANGE, open: true }} />)
    expect(Reporter.answer).toBe(true)
    render(<Reporter change={{ ...CHANGE, open: false }} />)
    expect(Reporter.answer).toBe(false)
  })

  it('装了通道就报到那一头,带的是「哪一块 / 开还是合 / 过渡多长」', () => {
    const heard: UserToggle[] = []
    render(
      <GeometryReportContext.Provider value={(change) => { heard.push(change); return change.open }}>
        <Reporter change={CHANGE} />
      </GeometryReportContext.Provider>,
    )
    expect(heard).toEqual([CHANGE])
  })

  /**
   * **「先申请后执行」由返回值保证**:消费方写状态的那一句必须吃 `report()` 的返回值,
   * 绕开它就等于绕开申请。四族各查一句。
   */
  it('四族可折叠的东西都把写状态那一句挂在返回值上', () => {
    const thought = shellSrc('../ThinkingSegment.tsx')
    const card = shellSrc('../tools/ToolCard.tsx')
    const compact = shellSrc('../CompactSeam.tsx')
    const ctxDelta = shellSrc('../ContextDeltaSeam.tsx')
    expect(thought).toMatch(/setExpanded\(report\(\{/)
    expect(card).toMatch(/setOpen\(report\(\{/)
    // 工具卡的聚合行 / 抽屉那一路是一个 Set,先拿答案再改集合。
    expect(card).toMatch(/const next = report\(\{/)
    expect(compact).toMatch(/setOpen\(report\(\{/)
    expect(ctxDelta).toMatch(/setOpen\(report\(\{/)
    expect(ctxDelta).toMatch(/setExpanded\(report\(\{/)
    for (const src of [thought, card, compact, ctxDelta]) {
      // 老那两条各说一半的通道在这四族里不许再有(重试那一路仍然用折起那一条)。
      expect(src).not.toMatch(/useNoteUserExpand/)
      expect(src).not.toMatch(/useNoteFold/)
    }
  })

  /**
   * **陌生能力演练**(仓根 09-02 法):第五种可折叠块接进来,能改的只有它自己那一行。
   * 判据写成「裁决层与聊天流里不出现任何一族的名字」。
   */
  it('`viewport/` 与 `ChatStream` 里不出现任何一族可折叠东西的名字', () => {
    const names = ['ThinkingSegment', 'ToolCard', 'CompactSeam', 'ContextDeltaSeam', 'Seam']
    for (const rel of [
      '../viewport/anchor.ts',
      '../viewport/tail-pad.ts',
      '../viewport/intent-window.ts',
      '../viewport/use-viewport-anchor.ts',
    ]) {
      const src = shellSrc(rel)
      for (const name of names) expect(src).not.toMatch(new RegExp(`\\b${name}\\b`))
    }
    /*
     * 聊天流只摆**一条** Provider,值是一只身份恒定的回调 —— 它不认识谁在报。
     * (它当然渲染得出那几族:它是消息行的宿主。判据是「这条通道上不出现它们」,
     * 不是「这个文件里不出现它们」。)
     */
    const stream = shellSrc('../ChatStream.tsx')
    expect(stream).toMatch(/<GeometryReportContext\.Provider value=\{reportUserToggle\}>/)
    expect(stream.match(/GeometryReportContext/g)?.length).toBe(3)
  })

  /**
   * `ui/Fold` 的底把手那一发 `scrollIntoView` 与锚定器打架(正本 §13.1.5 甲):
   * 同一次收起在两帧里被两只手各写一次滚动位。`anchored` 是让位口,而**焦点那一半
   * 两档都做** —— 底把手随即卸载,不接过去焦点会掉到 body 上(I1)。
   */
  it('`ui/Fold` 的底把手在有人钉着视口时不再自己滚,但焦点照旧接走', () => {
    const fold = shellSrc('../../ui/Fold.tsx')
    expect(fold).toMatch(/head\.focus\(\{ preventScroll: true \}\)[\s\S]{0,200}?if \(anchored\) return/)
    expect(fold).toMatch(/head\.scrollIntoView\(\{ block: 'nearest' \}\)/)
    // 两族折痕都让位(它们收起时由锚定器钉住被点的那一块)。
    expect(shellSrc('../CompactSeam.tsx')).toMatch(/<Fold\s+anchored/)
    expect(shellSrc('../ContextDeltaSeam.tsx')).toMatch(/<Fold\s+anchored/)
  })
})
