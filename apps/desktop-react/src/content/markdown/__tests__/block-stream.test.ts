import { describe, expect, it } from 'vitest'
import '../../blocks'
import { blockCommitPolicies, registerBlock, resolveBlock, unregisterBlock } from '../../blocks/registry'
import { MarkdownBlockStream, parseBlockFrame } from '../block-stream'
import { MarkdownStream } from '../incremental'

/**
 * **块流生产者**(R4a)。三组断言,各钉一条设计承诺:
 *
 *  1. **行界**:一帧里没有换行就不许动结构(唯一的例外是声明出来的早成形认领);
 *  2. **身份**:提交过的块的号跨帧恒定,新旧两条路 / 直播与冷加载给出同一份号;
 *  3. **代价**:一帧里换了对象的块数 ≤ 1 + 这一帧落定的行数(O(变化行数),非 O(文档))。
 *
 * 时钟拨到每帧 +20ms:大于 16ms 的节流窗,于是每一帧都走**真解析**(要量的是解析
 * 之后那一步,不是节流窗白捡的那些帧)。
 */

/** 一台机器 + 一个能拨的钟。 */
function stage() {
  let t = 0
  const stream = new MarkdownBlockStream(() => t)
  const old = new MarkdownStream(() => t)
  return {
    tick: () => {
      t += 20
    },
    stream,
    old,
  }
}

/** 按 n 字一帧喂,回调拿到每一帧。 */
function feed(text: string, piece: number, onFrame: (upto: string, index: number) => void) {
  let index = 0
  for (let i = piece; i < text.length; i += piece) {
    onFrame(text.slice(0, i), index)
    index += 1
  }
  onFrame(text, index)
}

const PROSE = [
  '先说结论:这条链路是通的。',
  '',
  '## 三层的边界',
  '',
  '产品层不许 import 装配层。这一条由静态门守着,不靠自觉。',
  '',
  '- 骨架层零依赖',
  '- 产品层电子自由',
  '- 装配层可以说跨进程的词汇',
  '',
  '```ts',
  'const a = 1',
  'const b = 2',
  '```',
  '',
  '> 一个反复踩的坑:命令是 COW 的。',
  '',
  '> 引用里还能装一张清单:',
  '>',
  '> - 第一条',
  '> - 第二条',
  '',
  '- 列表项里装一段围栏:',
  '',
  '  ```sh',
  '  npm run verify',
  '  ```',
  '',
  '最后一段收尾,`行内代码` 与 **加粗**。',
].join('\n')

describe('块流:行界(结构只在行界变)', () => {
  it('一帧里没有换行就没有结构事件 —— 素材里没有早成形的型', () => {
    const { stream, tick } = stage()
    let prev = ''
    let checked = 0
    feed(PROSE, 7, (upto) => {
      tick()
      stream.frame('m', upto, true)
      const delta = upto.slice(prev.length)
      if (prev !== '' && !delta.includes('\n')) {
        expect(stream.structuralOps('m'), `帧「${JSON.stringify(delta)}」动了结构`).toBe(0)
        checked += 1
      }
      prev = upto
    })
    // 这条断言只有在真的量到过足够多「没有换行的帧」时才说明问题。
    expect(checked).toBeGreaterThan(10)
  })

  it('反证:把活尾槽当提交发(tail 换成 append)—— 行界这条当场没了意义', () => {
    // 不改产品代码的反证:直接问机器 —— `append` 是结构事件,`tail` 不是。
    // 生产者若把半截活行当提交发,上面那条断言的读数会从 0 变成「每帧 1」。
    const { stream, tick } = stage()
    tick()
    stream.frame('m', '一段还没写完的话', true)
    tick()
    stream.frame('m', '一段还没写完的话,又来几个字', true)
    expect(stream.structuralOps('m')).toBe(0)
  })

  it('早成形认领是**声明出来的**例外:分隔行凑齐那一刻可以在行中间换型', () => {
    const { stream, tick } = stage()
    tick()
    const before = stream.frame('t', '| 名字 | 值 |\n|--', true)
    tick()
    const after = stream.frame('t', '| 名字 | 值 |\n|---|', true)
    expect(before.blocks.at(-1)?.kind).toBe('table')
    expect(after.blocks.at(-1)?.kind).toBe('table')
  })
})

describe('承诺:一旦做出就不许来回翻(真机门 L 条抓到的那次)', () => {
  /*
   * ── 病历:换行单独成一帧时,正在长的那张表闪回一帧段落 ────────────────────
   * mdast 给段落的 `end` **不含结尾那个换行**,而承诺的守门判据当初写的是
   * `last.end >= text.length`。于是文本正好停在 `…| 备注 |\n` 的那一帧,判据当场
   * 认定「末块没贴着活尾巴」,承诺不做 —— 上一帧还是表,这一帧退回段落,下一帧又是表。
   *
   * 真机读数(gate:stream-structure 的 mixed 素材,7 字/帧,旧路那一趟):
   * `table@2077ms → p@2127ms → table@2143ms`,L 条(块整批消失)逮住了它。
   * 修法是把判据改成「末块后面只剩空白」。
   *
   * 这条用例逐字符喂真机那张八列表(**走生产路** `MarkdownStream.parse`,不是
   * 把判据抄一遍),断言翻面 0 次 —— 把判据改回去,它立刻数出 1 次。
   */
  const MIXED_TABLE = [
    '| 宿主 | 工具档 | 发送目标 | 会话技能 | MCP/ACP | 拥有后端 | 进程级端口 | 备注 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '| Electron 桌面 | full | webContents | 否 | 窗口后 | 是 | 自己拥有 | 同时挂内嵌 HTTP 面 |',
    '| 无头服务端 | full | noop | 是 | 否 | 否 | host 档不抢 | 单用户,Bearer 鉴权 |',
  ].join('\n')

  it('逐字符喂八列表:表出现之后一帧都没退回过段落', () => {
    const { old, tick } = stage()
    const full = `\n拿到了。各宿主的配置对照(这张表故意很宽):\n\n${MIXED_TABLE}\n\n收尾一句。\n`
    let wasTable = false
    const flips: string[] = []
    for (let i = 1; i <= full.length; i += 1) {
      tick()
      const isTable = old.parse('m', full.slice(0, i), true).blocks.some((b) => b.kind === 'table')
      if (wasTable && !isTable) flips.push(JSON.stringify(full.slice(Math.max(0, i - 24), i)))
      wasTable = isTable
    }
    expect(flips, `翻面处:${flips.slice(0, 3).join(' · ')}`).toEqual([])
    expect(wasTable).toBe(true)
  })
})

describe('块流:身份', () => {
  it('提交过的号跨帧恒定 —— 变化只发生在末块上', () => {
    const { stream, tick } = stage()
    let prev: readonly string[] = []
    feed(PROSE, 5, (upto) => {
      tick()
      const frame = stream.frame('m', upto, true)
      if (prev.length > 1) {
        expect(frame.ids.slice(0, prev.length - 1)).toEqual(prev.slice(0, -1))
      }
      prev = frame.ids
    })
  })

  it('直播末帧的号 == 冷加载的号(收尾不重挂)', () => {
    const { stream, tick } = stage()
    feed(PROSE, 9, (upto) => {
      tick()
      stream.frame('m', upto, true)
    })
    const live = stream.frame('m', PROSE, true)
    const cold = parseBlockFrame(PROSE)
    expect(live.ids).toEqual(cold.ids)
    expect(live.blocks).toEqual(cold.blocks)
  })

  it('号是产地派生的 —— 同一段文本,两台机器给出同一份号', () => {
    const a = stage()
    const b = stage()
    feed(PROSE, 6, (upto) => {
      a.tick()
      a.stream.frame('m', upto, true)
    })
    b.tick()
    expect(a.stream.frame('m', PROSE, true).ids).toEqual(b.stream.frame('x', PROSE, true).ids)
  })

  it('号里带着型:同一个产地换了型就是另一个号(原位换装该重挂)', () => {
    // 素材换成围栏 → 图:R4b 起表在行首竖线那一刻就承诺,`| 名字 | 值 |` 第一帧
    // 就已经是表,拿它量不到「换型」这件事了。围栏闭合换装是今天仅存的另一格。
    const { stream, tick } = stage()
    tick()
    const asCode = stream.frame('t', '```mermaid\ngraph TD;\n  A-->B;', true)
    tick()
    const asFigure = stream.frame('t', '```mermaid\ngraph TD;\n  A-->B;\n```', true)
    expect(asCode.ids.at(-1)).toBe('0:code')
    expect(asFigure.ids.at(-1)).toBe('0:figure')
    // 换型走的是「撤回 + 开新的」,合法的复生记在遥测上,不是违法。
    expect(stream.telemetry('t').violations).toBe(0)
  })
})

describe('块流:代价 O(变化行数)', () => {
  it('一帧里换了对象的块数 ≤ 1 + 这一帧落定的行数', () => {
    const { stream, tick } = stage()
    let prev = ''
    let prevBlocks: readonly unknown[] = []
    let worst = 0
    feed(PROSE, 7, (upto) => {
      tick()
      const frame = stream.frame('m', upto, true)
      const delta = upto.slice(prev.length)
      let changed = 0
      for (let i = 0; i < frame.blocks.length; i += 1) {
        if (frame.blocks[i] !== prevBlocks[i]) changed += 1
      }
      const budget = 1 + (delta.match(/\n/g)?.length ?? 0)
      if (prev !== '') {
        expect(changed, `帧「${JSON.stringify(delta)}」换了 ${changed} 块`).toBeLessThanOrEqual(budget)
      }
      worst = Math.max(worst, changed)
      prev = upto
      prevBlocks = frame.blocks
    })
    expect(worst).toBeGreaterThan(0)
  })

  it('对照读数:整条流累计换了多少块对象 —— 新路显著少于旧路', () => {
    /*
     * 这是「块树操作代价 O(变化行数) 非 O(文档)」那句话的读数版。
     *
     * 旧路的账:切点(stable-cut)一旦见过列表 / 引用 / 表的起手式就不再前进,
     * 它后面的整段每帧重解析、每帧换一批新对象 —— 而 `BlockView` 的 memo 是浅比,
     * 换了对象就是一次重画。新路在那一段上逐块比一次 `sameModel`,没变的把**上一帧
     * 那个对象**原样留着,于是重画的只剩真的变了的那几块。
     */
    const churn = (mode: 'new' | 'old') => {
      const { stream, old, tick } = stage()
      let prevBlocks: readonly unknown[] = []
      let total = 0
      feed(PROSE, 7, (upto) => {
        tick()
        const frame = mode === 'new' ? stream.frame('m', upto, true) : old.parse('m', upto, true)
        for (let i = 0; i < frame.blocks.length; i += 1) {
          if (frame.blocks[i] !== prevBlocks[i]) total += 1
        }
        prevBlocks = frame.blocks
      })
      return total
    }
    const next = churn('new')
    const legacy = churn('old')
    /*
     * 读数带在断言消息里(不 `console.log` —— eslint 的 no-console 是全仓法,而
     * 断言消息在红的那一刻自然会印出来,那正是要看它的时刻)。
     *
     * 首次读数:新路 30 / 旧路 67(-55%)。棘轮定在 0.6 —— 不是「小于就行」:
     * 那样任何一次微小回退都过得去,而这条读数正是 R4a 要守的那个数。
     */
    expect(next, `块对象累计换手:新路 ${next} / 旧路 ${legacy}`).toBeLessThan(legacy * 0.6)
  })
})

describe('块流:新旧两条路逐帧等价', () => {
  it('同一份素材、同一档粒度,每一帧的块序列逐字相同', () => {
    const { stream, old, tick } = stage()
    feed(PROSE, 7, (upto) => {
      tick()
      const next = stream.frame('m', upto, true)
      const legacy = old.parse('m', upto, true)
      expect(next.blocks).toEqual(legacy.blocks)
      expect(next.offsets).toEqual(legacy.offsets)
    })
  })
})

describe('承诺:政策住在注册契约里,不在机制里', () => {
  it('表声明了 commit,而且它是这张表上唯一一行', () => {
    expect(blockCommitPolicies().map((e: { kind: string }) => e.kind)).toEqual(['table'])
  })

  it('反证:把表的 commit 摘掉,正在出生的那张表当场退回段落', () => {
    const def = resolveBlock('table')
    const { stream, tick } = stage()
    tick()
    expect(stream.frame('t', '| 名字 | 值 |\n|--', true).blocks.at(-1)?.kind).toBe('table')

    unregisterBlock('table', def)
    registerBlock({ ...def, stream: { ...def.stream, commit: undefined } })
    try {
      const bare = stage()
      bare.tick()
      expect(bare.stream.frame('t', '| 名字 | 值 |\n|--', true).blocks.at(-1)?.kind).toBe('paragraph')
    } finally {
      unregisterBlock('table')
      registerBlock(def)
    }
    expect(blockCommitPolicies().map((e: { kind: string }) => e.kind)).toEqual(['table'])
  })
})
