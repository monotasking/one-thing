import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ViewportAnchor } from '../anchor'
import { GeometryLedger } from '../geometry-ledger'
import { FakeScrollPort, type AnchoredElement, type ResizeBatch } from '../scroll-port'

/**
 * **dev 运行时断言**(G 线 P2-c;正本 §1 推论五、§18.4)。
 *
 * 判词整段在 `geometry-ledger.ts` 的文件头。这一组钉的是**每一条违例路径**都真的
 * 报得出来,以及那两条纪律:只 `warn` 不抛、每件只报一次。整只文件一次
 * `render()` 都没有,也没有一个 `document` —— 喂一只 `FakeScrollPort` 与一只
 * 收集器就够了(与 `anchor.test.ts` 同一手)。
 */

/** **先剥注释**(仓法:病历文本会让断言自红 —— 这几条扫的是代码,不是判词)。 */
const shellSrc = (rel: string) =>
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), rel), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

function ledgerOf() {
  const heard: { msg: string; fields: Record<string, unknown> }[] = []
  const ledger = new GeometryLedger((msg, fields) => heard.push({ msg, fields }))
  return { ledger, heard }
}

describe('账本本身:哪一下算违例', () => {
  it('变矮而不是人点的 → 报一条', () => {
    const { ledger, heard } = ledgerOf()
    ledger.note('a', 'tail-growth', 100)
    ledger.note('a', 'tail-growth', 60)
    expect(heard).toHaveLength(1)
    expect(heard[0].fields).toMatchObject({ sourceId: 'a', cause: 'tail-growth', shrinkPx: 40 })
  })

  it('变矮但**是人点的** → 一条都不报(G3 的那一格例外)', () => {
    const { ledger, heard } = ledgerOf()
    ledger.note('a', 'user-toggle', 100)
    ledger.note('a', 'user-toggle', 20)
    expect(heard).toEqual([])
  })

  it('长高、没变、亚像素来回 → 都不报', () => {
    const { ledger, heard } = ledgerOf()
    ledger.note('a', 'tail-growth', 100)
    ledger.note('a', 'tail-growth', 140)
    ledger.note('a', 'tail-growth', 140)
    ledger.note('a', 'tail-growth', 139.7)
    expect(heard).toEqual([])
  })

  it('第一次见到那一件不报(没有「之前」可比)', () => {
    const { ledger, heard } = ledgerOf()
    ledger.note('a', 'settle', 100)
    expect(heard).toEqual([])
  })

  it('落定那一帧动了就报 —— **两个方向都报**(G4 判的是「动没动」)', () => {
    const one = ledgerOf()
    one.ledger.settle('col', -12)
    expect(one.heard[0].fields).toMatchObject({ cause: 'settle', deltaH: -12 })
    const two = ledgerOf()
    two.ledger.settle('col', 9)
    expect(two.heard[0].fields).toMatchObject({ cause: 'settle', deltaH: 9 })
    const zero = ledgerOf()
    zero.ledger.settle('col', 0.4)
    expect(zero.heard).toEqual([])
  })

  it('同一件只报一次,别的件照报(一段过渡逐帧都会报)', () => {
    const { ledger, heard } = ledgerOf()
    for (let h = 100; h > 0; h -= 10) ledger.note('a', 'tail-growth', h)
    ledger.note('b', 'tail-growth', 50)
    ledger.note('b', 'tail-growth', 10)
    expect(heard).toHaveLength(2)
    expect(ledger.warned).toEqual(['a', 'b'])
  })

  it('换会话清账 —— 那张表说的是**那边**那棵树上的东西', () => {
    const { ledger, heard } = ledgerOf()
    ledger.note('a', 'tail-growth', 100)
    ledger.reset()
    ledger.note('a', 'tail-growth', 60)
    expect(heard).toEqual([])
  })

  it('**不抛** —— 它是一条诊断线,不是一条崩溃线', () => {
    const ledger = new GeometryLedger(() => { throw new Error('这只 sink 自己炸了') })
    expect(() => ledger.note('a', 'tail-growth', 100)).not.toThrow()
    expect(() => ledger.note('a', 'tail-growth', 10)).toThrow('这只 sink 自己炸了')
  })
})

/* ── 接进裁决者之后,每一条路真的报得出来 ──────────────────────────────── */

const grew = (h: number): ResizeBatch => ({ containerChanged: false, columnHeights: [h] })
const EL: AnchoredElement = { alive: () => true, top: () => 0 }

function setup() {
  const port = new FakeScrollPort({ scrollHeight: 1000, clientHeight: 300, scrollTop: 0, columnHeight: 1000 })
  const heard: { msg: string; fields: Record<string, unknown> }[] = []
  const ledger = new GeometryLedger((msg, fields) => heard.push({ msg, fields }))
  const anchor = new ViewportAnchor(port, {
    onFollowChange: () => {},
    expandHoldMs: 220,
    foldSlackMs: 40,
    slideDurationOf: () => 0,
    now: () => 1000,
    ledger,
  })
  return { port, anchor, heard }
}

describe('接进 `ViewportAnchor` 之后', () => {
  it('没人动手时内容列缩了 → 报违例', () => {
    const { port, anchor, heard } = setup()
    anchor.beginObserving()
    port.geometry.scrollHeight = 1400
    anchor.onResize(grew(1400), 's1')
    port.geometry.scrollHeight = 1100
    anchor.onResize(grew(1100), 's1')
    expect(heard).toHaveLength(1)
    expect(heard[0].fields).toMatchObject({ sourceId: 'content-column', cause: 'tail-growth' })
  })

  it('人开合的那一段里缩了 → 不报(窗口里那几帧归他)', () => {
    const { port, anchor, heard } = setup()
    anchor.beginObserving()
    anchor.reportUserToggle({
      open: false,
      durationMs: 180,
      block: { height: 500, top: 10, anchor: EL },
    })
    port.geometry.scrollHeight = 700
    anchor.onResize(grew(700), 's1')
    anchor.onResize(grew(400), 's1')
    expect(heard).toEqual([])
  })

  it('落定那一拍内容列动了 → 报违例', () => {
    const { port, anchor, heard } = setup()
    anchor.beginObserving()
    anchor.onResize(grew(1400), 's1')
    port.geometry.columnHeight = 1380
    anchor.noteSettle()
    expect(heard).toHaveLength(1)
    expect(heard[0].fields).toMatchObject({ cause: 'settle', deltaH: -20 })
  })

  it('换会话把账清掉', () => {
    const { port, anchor, heard } = setup()
    anchor.beginObserving()
    anchor.onResize(grew(1400), 's1')
    anchor.enter('s2', { hasElement: true, hasMessages: false })
    anchor.beginObserving()
    port.geometry.scrollHeight = 900
    anchor.onResize(grew(900), 's2')
    expect(heard).toEqual([])
  })
})

describe('prod 零开销', () => {
  /**
   * 判据是**建不建那只对象**:`ledger` 缺席时裁决层每个报点都是一句 `?.` 的空跳,
   * 那张 `Map` / `Set` 根本不存在。所以这一条扫的是「谁 new 它」——
   * 只有薄 hook 那一句,而且挂在 `import.meta.env.DEV` 上。
   */
  it('只有薄 hook 里那一句 `new GeometryLedger`,而且挂在 `import.meta.env.DEV` 上', () => {
    const hook = shellSrc('../use-viewport-anchor.ts')
    expect(hook).toMatch(/ledger: import\.meta\.env\.DEV\s*\n\s*\? new GeometryLedger\(/)
    expect(shellSrc('../anchor.ts')).not.toMatch(/new GeometryLedger/)
  })

  it('报点一律 `?.`,裁决层不认识 `import.meta.env`', () => {
    const src = shellSrc('../anchor.ts')
    expect(src).not.toMatch(/import\.meta\.env/)
    expect((src.match(/this\.#ledger\?\./g) ?? []).length).toBeGreaterThanOrEqual(4)
    /*
     * 裸用法**恰好三处**:构造里那一句赋值,以及 `noteSettle` 里那对「先早退再用」
     * (`if (!this.#ledger) return` + `this.#ledger.settle(...)`)。多出第四处就是
     * 有人在 prod 路上直接用了它。
     */
    const bare = src.replace(/this\.#ledger\?\./g, '').match(/this\.#ledger/g) ?? []
    expect(bare).toHaveLength(3)
  })

  it('沿用的是壳自己的 `getLogger`,不是 `console.*`(仓法)', () => {
    const hook = shellSrc('../use-viewport-anchor.ts')
    expect(hook).toMatch(/getLogger\('chat\.geometry'\)/)
    expect(hook).not.toMatch(/console\./)
    expect(shellSrc('../geometry-ledger.ts')).not.toMatch(/console\./)
  })
})
