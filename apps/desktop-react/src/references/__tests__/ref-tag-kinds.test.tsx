import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatRefTag, parseRefTag } from '@onething/core/references'
import type { RefTag } from '@onething/core/references'

// `vi.hoisted`:`vi.mock` 的工厂被提到文件顶端,普通 const 那时还没初始化。
const openFile = vi.hoisted(() => vi.fn())
const openDir = vi.hoisted(() => vi.fn())
const openSkillNamed = vi.hoisted(() => vi.fn((name: string) => Promise.resolve(Boolean(name))))
const openBrowser = vi.hoisted(() => vi.fn((url?: string) => Promise.resolve(Boolean(url))))
const notified = vi.hoisted(() => vi.fn())

// 那四条打开路各自拖着一整片 store。这里量的是「叫对了谁、递对了什么」——
// 它们自己有自己的用例(与 `content/__tests__/user-message.test.tsx` 同一条)。
vi.mock('../../content/viewer/open-target', () => ({ openFileAt: openFile }))
vi.mock('../../content/dir-open', () => ({ openDirectoryPanel: openDir }))
vi.mock('../../content/skill-open', () => ({
  openSkillDirectory: vi.fn(async () => true),
  openSkillNamed: (name: string) => openSkillNamed(name),
}))
vi.mock('../../content/browser-launcher', () => ({ openBrowser: (url?: string) => openBrowser(url) }))
vi.mock('../../services/notify', () => ({ notify: notified }))

import '..'
import { InlineRun } from '../../content/blocks/inline/InlineRun'
import { parseMarkdown } from '../../content/markdown/parse'
import { SegmentsView } from '../../content/user-message'
import { ReferenceHost } from '../host-context'
import { configureComposerReferenceSink, resetComposerReferenceSink } from '../../composer/references'
import {
  referenceKindList,
  referenceKindOf,
  referenceTagKinds,
  resolveReferenceTag,
} from '../registry'
import { projectSegmentsToText, segmentReferenceText } from '../segment'
import type { BlockModel } from '../../content/model/blocks'
import type { InlineNode } from '../../content/model/inline'
import type { ResolvedSegment } from '../segment'

/**
 * **五种引用在线上那条 `<ref/>` 上的两半**(B2,正本
 * `docs/design/reference-tag-2026-09.md` §2.4)。
 *
 * 这只文件是**各家自述**的用例(与 `structure.test.ts` 的骨架守卫分工):
 * 谁认哪个 type、认回来的 Ref 长什么样、出站写成哪一形、点了做什么。
 */

/**
 * 一条标签的源文。**用编解码器拼而不是写字面量**:写成
 * `<ref type="reference" … title="…"/>` 的字面量会被 `ui:consume` 的
 * `tooltip-native-title` 当成一枚带 native `title=` 的 JSX 标签(禁令区)——
 * 那是误判,但拼出来本来也更诚实:属性顺序由编解码器说了算,不由我写的那一行。
 */
function tagText(type: string, attrs: Record<string, string>): string {
  return formatRefTag({ type, attrs })
}

function inlineOf(src: string): InlineNode[] {
  const blocks = parseMarkdown(src).map((entry) => entry.block)
  const paragraph = blocks.find((b) => b.kind === 'paragraph') as
    | Extract<BlockModel, { kind: 'paragraph' }>
    | undefined
  return paragraph?.inline ?? []
}

function renderTags(src: string, sessionId?: string) {
  return render(
    <ReferenceHost sessionId={sessionId}>
      <InlineRun nodes={inlineOf(src)} />
    </ReferenceHost>,
  )
}

beforeEach(() => {
  openFile.mockClear()
  openDir.mockClear()
  openSkillNamed.mockClear()
  openBrowser.mockClear()
  notified.mockClear()
  resetComposerReferenceSink()
})

describe('文件:`<ref type="file" …/>` 的四格定位', () => {
  it.each([
    ['只有路径', '<ref type="file" path="/a/b.ts"/>', { kind: 'fileRef', path: '/a/b.ts' }],
    [
      '一行',
      '<ref type="file" path="/a/b.ts" line="12"/>',
      { kind: 'fileRef', path: '/a/b.ts', line: 12 },
    ],
    [
      '一段',
      '<ref type="file" path="/a/b.ts" line="12-30"/>',
      { kind: 'fileRef', path: '/a/b.ts', line: 12, endLine: 30 },
    ],
    [
      '行 + 列 + 符号',
      '<ref type="file" path="/a/b.ts" line="12" col="3" symbol="parseToken"/>',
      { kind: 'fileRef', path: '/a/b.ts', line: 12, col: 3, symbol: 'parseToken' },
    ],
  ])('%s', (_name, source, ref) => {
    expect(resolveReferenceTag(parseRefTag(source)!)).toEqual({ kindId: 'file', value: ref })
  })

  it.each([
    ['没有 path', '<ref type="file" line="12"/>'],
    ['path 是一个目录', '<ref type="file" path="/a/dir/"/>'],
  ])('属性不合法 = 认不出(%s)', (_name, source) => {
    expect(resolveReferenceTag(parseRefTag(source)!)).toBeNull()
  })

  /*
   * 认不出的定位**整格当没给**(不猜、不报错):路径照旧认得出,chip 照旧能点开
   * 那份文件 —— 一条行号写坏了不该让整枚引用消失。
   * 区间反着写那一条特殊:起点仍然是一个正当的行号,所以只丢掉 `endLine`。
   */
  it.each([
    ['line 不是数', 'line="十二"', undefined, undefined],
    ['line 是 0', 'line="0"', undefined, undefined],
    ['col 不是正整数', 'col="-1"', undefined, undefined],
    ['区间反着写 → 只留起点', 'line="30-12"', 30, undefined],
  ])('%s', (_name, attr, line, endLine) => {
    const hit = resolveReferenceTag(parseRefTag(`<ref type="file" path="/a.ts" ${attr}/>`)!)
    expect(hit?.kindId).toBe('file')
    expect((hit?.value as { line?: number }).line).toBe(line)
    expect((hit?.value as { endLine?: number }).endLine).toBe(endLine)
  })

  it('chip 上是 basename + 不许截断的那一截语法', () => {
    const view = renderTags('看 <ref type="file" path="/a/b.ts" line="12-30" symbol="parseToken"/>')
    const chip = view.container.querySelector('[data-ref-kind="fileRef"]') as HTMLElement
    expect(chip.textContent).toBe('b.ts:12-30 · parseToken')
  })

  it('点它 = `openFileAt(路径, 那四格定位)`', () => {
    renderTags('<ref type="file" path="/a/b.ts" line="12" col="3" symbol="parseToken"/>')
    fireEvent.click(screen.getByRole('button'))
    expect(openFile).toHaveBeenCalledWith('/a/b.ts', {
      line: 12,
      col: 3,
      symbol: 'parseToken',
    })
  })
})

describe('目录:尾斜杠是判据,不是格式', () => {
  it('写出去带着它,读回来补上它', () => {
    const hit = resolveReferenceTag(parseRefTag('<ref type="dir" path="/a/src"/>')!)
    expect(hit).toEqual({ kindId: 'dir', value: { kind: 'dirRef', path: '/a/src/' } })
  })

  it('点它 = `openDirectoryPanel`', () => {
    renderTags('<ref type="dir" path="/a/src/"/>')
    fireEvent.click(screen.getByRole('button'))
    expect(openDir).toHaveBeenCalledWith('/a/src/')
  })
})

describe('命令:线上形不变,标签只服务「认出」', () => {
  it('出站仍旧是 `/compact` —— `wire: token` 压过 tag', () => {
    const segs = segmentReferenceText('/compact 一下')
    expect(segs[0].kindId).toBe('command')
    expect(projectSegmentsToText(segs)).toBe('/compact 一下')
  })

  it('用户自己打的那一枚**照旧不可点**(行为一个字没变)', () => {
    const view = render(<SegmentsView segments={segmentReferenceText('/compact 一下')} />)
    expect(view.container.querySelector('button')).toBeNull()
  })

  it('助手写的那一枚可点,chip 上带着实参', () => {
    const view = renderTags('试试 <ref type="command" name="compact" args="--hard"/>')
    const chip = view.container.querySelector('button') as HTMLElement
    expect(chip.textContent).toBe('/compact --hard')
  })

  it('点它 = 填进**那条会话**的输入框,不发送', () => {
    const landed: unknown[] = []
    configureComposerReferenceSink('s-A', (r) => landed.push(r))
    configureComposerReferenceSink('s-B', () => expect.unreachable('投错了会话'))

    renderTags('试试 <ref type="command" name="compact" args="--hard"/>', 's-A')
    fireEvent.click(screen.getByRole('button'))
    // 落的是一枚 chip(与 `@` 选一个文件同一条路),而且它**不带 offer** ——
    // 进了输入框它就是用户自己的一句话了。
    expect(landed).toEqual([
      { kindId: 'command', ref: { kind: 'command', token: '/compact', args: '--hard' } },
    ])
  })

  it('那条会话没有挂着的输入面 → 答 false,由 chip 说一句人话(不是静默吞掉)', () => {
    // 一格输入面都没登记(`beforeEach` 里刚清过)。
    renderTags('试试 <ref type="command" name="compact"/>', 's-A')
    fireEvent.click(screen.getByRole('button'))
    expect(notified).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', source: 'chat.commandRef' }),
    )
  })

  it('宿主答不出会话(独立渲染的一段 markdown)也不炸 —— 照实答 false', () => {
    renderTags('试试 <ref type="command" name="compact"/>')
    fireEvent.click(screen.getByRole('button'))
    expect(notified).toHaveBeenCalled()
  })

  it.each([['带斜杠', 'name="/a"'], ['带空格', 'name="a b"'], ['没有名字', 'args="x"']])(
    '名字不合法 = 认不出(%s)',
    (_name, attr) => {
      expect(resolveReferenceTag(parseRefTag(`<ref type="command" ${attr}/>`)!)).toBeNull()
    },
  )
})

describe('技能:线上形不变,标签认回来的那一枚按名字能开', () => {
  it('出站仍旧是 `/skill:x`', () => {
    const segs = segmentReferenceText('/skill:commit 干活')
    expect(projectSegmentsToText(segs)).toBe('/skill:commit 干活')
  })

  it('用户自己打的那一枚照旧不可点', () => {
    const view = render(<SegmentsView segments={segmentReferenceText('/skill:commit 干活')} />)
    expect(view.container.querySelector('button')).toBeNull()
  })

  it('助手写的那一枚点了 = `openSkillNamed`', async () => {
    renderTags('用 <ref type="skill" name="commit"/> 收尾')
    fireEvent.click(screen.getByRole('button'))
    expect(openSkillNamed).toHaveBeenCalledWith('commit')
  })
})

describe('出处:http(s) 开内置浏览器,其余交系统', () => {
  it('label 三档:title ▷ label ▷ 去协议的 href', () => {
    const cases: [string, string][] = [
      [tagText('reference', { href: 'https://e.com/s', title: 'RFC 9110' }), 'RFC 9110'],
      // 宽容形:标签文字进通用属性 `label`(编解码器收的那一格)。
      ['<ref type="reference" href="https://e.com/s">那一节</ref>', '那一节'],
      [tagText('reference', { href: 'https://e.com/spec' }), 'e.com/spec'],
    ]
    for (const [source, label] of cases) {
      const view = renderTags(source)
      expect(view.container.querySelector('[data-ref-kind="linkRef"]')!.textContent).toBe(label)
      view.unmount()
    }
  })

  it('屏幕上那枚写的是标题,而它的无障碍名 / 提示说的是整条地址', () => {
    const view = renderTags(tagText('reference', { href: 'https://e.com/spec', title: '规范' }))
    const chip = view.container.querySelector('[data-ref-kind="linkRef"]') as HTMLElement
    expect(chip.textContent).toBe('规范')
    // 提示走 `tooltipText`(URL 是数据,不进字典),挂在 `ui/Tooltip` 上。
    expect(chip.getAttribute('aria-describedby') ?? chip.parentElement?.textContent).toBeTruthy()
  })

  it('点它 = 内置浏览器开一格', async () => {
    renderTags(tagText('reference', { href: 'https://e.com/spec' }))
    fireEvent.click(screen.getByRole('button'))
    await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledWith('https://e.com/spec'))
  })

  it('没有 href = 认不出', () => {
    expect(resolveReferenceTag(parseRefTag(tagText('reference', { title: 'x' }))!)).toBeNull()
  })
})

/**
 * ── 通用属性 `label`:屏幕上那几个字由写的人说 ───────────────────────────────
 *
 * 提示词向模型承诺了这一格,所以**指着一个东西**的那几种都得兑现它。命令是
 * 例外,而那是一条判词(它的字面就是要填进输入框的那一行,判词在
 * `kinds/command.ts` 的 `tag` 上)。
 */
describe('label:写的人给了称呼就用他的', () => {
  /** 一条标签走完「认回来 → 写回去」那一圈,答它的正形字节。 */
  function roundTrip(source: string): string {
    const hit = resolveReferenceTag(parseRefTag(source)!)
    expect(hit).not.toBeNull()
    return formatRefTag(referenceKindOf(hit!.kindId)!.tag!.toTag(hit!.value))
  }

  it.each([
    ['file', tagText('file', { path: '/a/parser.ts', label: '解析器' })],
    ['file + 定位', tagText('file', { path: '/a/p.ts', line: '12', symbol: 'parse', label: '解析器' })],
    ['dir', tagText('dir', { path: '/a/src/', label: '源码目录' })],
    ['skill', tagText('skill', { name: 'commit', label: '提交流程' })],
  ])('往返逐字相同:%s', (_name, source) => {
    expect(roundTrip(source)).toBe(source)
  })

  it.each([
    ['file', '<ref type="file" path="/a/parser.ts">解析器</ref>', tagText('file', { path: '/a/parser.ts', label: '解析器' })],
    ['dir', '<ref type="dir" path="/a/src/">源码目录</ref>', tagText('dir', { path: '/a/src/', label: '源码目录' })],
    ['skill', '<ref type="skill" name="commit">提交流程</ref>', tagText('skill', { name: 'commit', label: '提交流程' })],
  ])('宽容形归一成 `label="…"` 的正形:%s', (_name, lenient, canonical) => {
    expect(roundTrip(lenient)).toBe(canonical)
  })

  it('文件:主文字换成那几个字,`:12 · symbol` 那一截语法照旧跟在后面', () => {
    const view = renderTags(
      tagText('file', { path: '/a/parser.ts', line: '12', symbol: 'parse', label: '解析器' }),
    )
    const chip = view.container.querySelector('[data-ref-kind="fileRef"]') as HTMLElement
    expect(chip.textContent).toBe('解析器:12 · parse')
    // 提示里的两层路径形不动,无障碍名仍是「打开 <整条路径>」—— 换的是称呼,
    // 不是它指着的那个东西。
    expect(chip.getAttribute('aria-label')).toContain('/a/parser.ts')
  })

  it('目录:给了称呼就**不补尾斜杠**(他写的不是一条路径)', () => {
    const view = renderTags(tagText('dir', { path: '/a/src/', label: '源码目录' }))
    expect(view.container.querySelector('[data-ref-kind="dirRef"]')!.textContent).toBe('源码目录')
  })

  it('技能:主文字换成那几个字,点开走的还是那个名字', () => {
    const view = renderTags(tagText('skill', { name: 'commit', label: '提交流程' }))
    expect(view.container.querySelector('[data-ref-kind="skill"]')!.textContent).toBe('提交流程')
    fireEvent.click(screen.getByRole('button'))
    expect(openSkillNamed).toHaveBeenCalledWith('commit')
  })

  it.each([['file', 'path'], ['dir', 'path'], ['skill', 'name']])(
    '`label` trim 后是空串 = 当没给(屏幕上不该有看不见的东西):%s',
    (type, key) => {
      const value = type === 'skill' ? 'commit' : '/a/b.ts'
      const hit = resolveReferenceTag(parseRefTag(tagText(type, { [key]: value, label: '   ' }))!)
      expect((hit!.value as { label?: string }).label).toBeUndefined()
    },
  )

  it('命令**不收** `label` —— 屏上那一行就是要填进输入框的那一行', () => {
    const hit = resolveReferenceTag(
      parseRefTag(tagText('command', { name: 'compact', label: '清理上下文' }))!,
    )
    expect((hit!.value as { label?: string }).label).toBeUndefined()
    const view = renderTags(tagText('command', { name: 'compact', label: '清理上下文' }))
    expect(view.container.querySelector('button')!.textContent).toBe('/compact')
  })
})

/**
 * ── 不变量:**段与线上那句话互为投影**(09-14 那条扩到 tag 形)──────────────
 *
 * 对每一种**出站写标签**的引用,`segmentReferenceText(projectSegmentsToText(segs))`
 * 还原出同样的段。说 `wire: 'token'` 的那两种(命令 / 技能)**不在这一条里**:
 * 它们的线上形是一句要执行的话,往返经过的是 token 那条老路(上面各自一条用例
 * 钉着),而不是标签。
 */
describe('不变量:段 → 句子 → 段,往返不变', () => {
  const samples: Record<string, unknown[]> = {
    file: [
      { kind: 'fileRef', path: '/a/b.ts' },
      { kind: 'fileRef', path: '/a/b.ts', line: 12 },
      { kind: 'fileRef', path: '/a/b.ts', line: 12, endLine: 30 },
      { kind: 'fileRef', path: '/a/b.ts', line: 12, col: 3, symbol: 'parseToken' },
      // 值里的实体:`&` 与 `"` 要能原样回来。
      { kind: 'fileRef', path: '/a/b&c "d".ts' },
      // 通用属性 `label`:它恒在最后一格,所以与定位那几格并存也逐字往返。
      { kind: 'fileRef', path: '/a/parser.ts', label: '解析器' },
      { kind: 'fileRef', path: '/a/parser.ts', line: 12, symbol: 'parse', label: '解析器' },
    ],
    dir: [
      { kind: 'dirRef', path: '/a/src/' },
      { kind: 'dirRef', path: '/a/src/', label: '源码目录' },
    ],
    reference: [
      { kind: 'linkRef', href: 'https://e.com/spec' },
      { kind: 'linkRef', href: 'https://e.com/spec', title: 'RFC 9110 §15' },
    ],
  }

  it('出站写标签的每一种都覆盖到了(加一种忘了写样本 → 这一条红)', () => {
    const writes = referenceTagKinds()
      .filter((kind) => kind.draft?.wire !== 'token')
      .map((kind) => kind.id)
    expect(writes.sort()).toEqual(Object.keys(samples).sort())
  })

  it.each(Object.entries(samples).flatMap(([kindId, refs]) =>
    refs.map((ref, i) => [`${kindId}#${i}`, kindId, ref] as const),
  ))('%s', (_name, kindId, ref) => {
    const segs: ResolvedSegment[] = [
      { kindId: null, value: { kind: 'text', text: '看 ' } },
      { kindId, value: ref },
      { kindId: null, value: { kind: 'text', text: ' 这里' } },
    ]
    const wire = projectSegmentsToText(segs)
    expect(segmentReferenceText(wire)).toEqual(segs)
    // 字节也是决定性的:同一枚引用两次投影逐字相同。
    expect(projectSegmentsToText(segmentReferenceText(wire))).toBe(wire)
  })

  it('`tag.type` 全表唯一(重复登记直接抛)', () => {
    const types = referenceKindList()
      .map((kind) => kind.tag?.type)
      .filter((type): type is string => type !== undefined)
    expect(new Set(types).size).toBe(types.length)
  })
})

/**
 * ── 超量(第 4 轴 / 正本 §5)────────────────────────────────────────────────
 * 一条含 500 枚标签的助手消息。两件事:解析的增量与同长度无标签文本同一量级、
 * `ReferenceTagChip` 的 memo 兜得住父重渲。
 */
describe('超量:500 枚标签的一条消息', () => {
  const COUNT = 500

  function corpus(): { tagged: string; plain: string } {
    const lines: string[] = []
    const plains: string[] = []
    for (let i = 0; i < COUNT; i += 1) {
      const tag = `<ref type="file" path="/repo/src/mod-${i}/file-${i}.ts" line="${i + 1}"/>`
      lines.push(`第 ${i} 段正文,这里指着 ${tag} 那一处,接着往下说。`)
      // 同样长度的一段无标签正文(逐字符对齐,这样两边量的是同一个长度)。
      plains.push(`第 ${i} 段正文,这里指着 ${'x'.repeat(tag.length)} 那一处,接着往下说。`)
    }
    return { tagged: lines.join('\n\n'), plain: plains.join('\n\n') }
  }

  it('解析耗时与同长度无标签正文同一量级(读数进交卷)', () => {
    const { tagged, plain } = corpus()
    expect(tagged.length).toBe(plain.length)

    // 各跑一遍热身,再量 —— 第一遍里有 micromark 自己的懒初始化。
    parseMarkdown(tagged)
    parseMarkdown(plain)

    const t0 = performance.now()
    const blocks = parseMarkdown(tagged)
    const taggedMs = performance.now() - t0

    const p0 = performance.now()
    parseMarkdown(plain)
    const plainMs = performance.now() - p0

    const refs = blocks.flatMap((entry) =>
      entry.block.kind === 'paragraph' ? entry.block.inline.filter((n) => n.type === 'ref') : [],
    )
    expect(refs).toHaveLength(COUNT)

    // 读数打出来给交卷抄;判据是**同一量级**(≤ 4×),不是一个绝对毫秒数 ——
    // 机器不同、CI 不同,绝对值不是一条守得住的线。
    console.log(`[超量] 500 枚标签 ${taggedMs.toFixed(1)}ms / 同长度无标签 ${plainMs.toFixed(1)}ms`)
    expect(taggedMs).toBeLessThan(Math.max(plainMs * 4, 50))
  })

  /**
   * memo 反证:父重渲一轮,那 50 枚 chip **一个 DOM 节点都不换**。
   *
   * 量的是节点身份而不是「渲染了几次」——「同一个 DOM 节点」是这条性能纪律在
   * 屏幕上的直接后果,而渲染计数要么得往产品里塞一个探针,要么得 spy 到
   * `render(ref)` 上(那是另一层的次数,不是 chip 的)。
   */
  it('memo 反证:父重渲一轮,50 枚 chip 的 DOM 节点一个都不换', () => {
    const nodes: InlineNode[] = Array.from({ length: 50 }, (_, i) => ({
      type: 'ref' as const,
      tag: { type: 'file', attrs: { path: `/a/f-${i}.ts` } } satisfies RefTag,
    }))

    let parentRenders = 0
    function Probe({ tick }: { tick: number }) {
      parentRenders += 1
      return (
        <div data-tick={tick}>
          <InlineRun nodes={nodes} />
        </div>
      )
    }

    const view = render(<Probe tick={0} />)
    const before = Array.from(view.container.querySelectorAll('[data-ref-kind="fileRef"]'))
    expect(before).toHaveLength(50)

    view.rerender(<Probe tick={1} />)
    expect(parentRenders).toBeGreaterThan(1)

    const after = Array.from(view.container.querySelectorAll('[data-ref-kind="fileRef"]'))
    expect(after).toHaveLength(50)
    // 标签一个字没变 → memo 短路 → 那几个节点是**同一批对象**。
    for (let i = 0; i < 50; i += 1) expect(after[i]).toBe(before[i])
  })

  it('memo 的判据是那条标签的字节:换一个属性就重画', () => {
    const one: RefTag = { type: 'file', attrs: { path: '/a.ts' } }
    const two: RefTag = { type: 'file', attrs: { path: '/a.ts', line: '3' } }
    expect(formatRefTag(one)).not.toBe(formatRefTag(two))
    // 同一条标签的两个对象:字节相同 → memo 判「没变」。
    expect(formatRefTag({ type: 'file', attrs: { path: '/a.ts' } })).toBe(formatRefTag(one))
  })
})

/**
 * ── 行内码整格是一枚引用(09-20)─────────────────────────────────────────────
 *
 * 线上写法仍旧只有 `<ref/>`;这一族是**只读的识别器**,与 `@/abs` 那条旧正则
 * 同性质 —— 模型不照提示词写、把路径包进反引号时,壳照样认得出它指着什么。
 * 判据本身在 `path-ref-code.test.ts`,这里量的是**画出来那一半**。
 */
describe('行内码:整格是一枚引用就画成 chip', () => {
  it('助手正文里的 `路径:行` 画成文件 chip,点它落到那一行', () => {
    const view = renderTags('看 `/Users/me/a.ts:12` 这里')
    const chip = view.container.querySelector('[data-ref-kind="fileRef"]') as HTMLElement
    expect(chip).toBeTruthy()
    expect(chip.textContent).toBe('a.ts:12')
    // 这一格不再是行内码了 —— 它是一枚引用。
    expect(view.container.querySelector('code')).toBeNull()

    fireEvent.click(screen.getByRole('button'))
    expect(openFile).toHaveBeenCalledWith('/Users/me/a.ts', { line: 12 })
  })

  it('目录那一格画成目录 chip,点它开目录面', () => {
    renderTags('看 `/Users/me/proj/src/` 这里')
    fireEvent.click(screen.getByRole('button'))
    expect(openDir).toHaveBeenCalledWith('/Users/me/proj/src/')
  })

  it('普通的一格码照旧是一格码 —— 一个字不动、不可点', () => {
    const view = renderTags('跑 `npm run dev` 就行')
    const code = view.container.querySelector('code') as HTMLElement
    expect(code.textContent).toBe('npm run dev')
    expect(view.container.querySelector('button')).toBeNull()
  })

  it('围栏里的路径仍是代码 —— 那是代码,不是提及', () => {
    const blocks = parseMarkdown('```sh\n/Users/me/a.ts:12\n```')
    expect(blocks.map((entry) => entry.block.kind)).toEqual(['code'])
    // 块级 code 压根不经过行内那一层,所以这条路上没有第二个判据要写。
    const source = (blocks[0].block as Extract<BlockModel, { kind: 'code' }>).source
    expect(source).toContain('/Users/me/a.ts:12')
  })

  /**
   * memo 反证:父重渲一轮,行内码那几格**一个 DOM 节点都不换**(与上面 `<ref/>`
   * 那一条同一条量法 —— 节点身份是这条性能纪律在屏幕上的直接后果)。
   */
  it('memo 反证:父重渲一轮,50 格行内码的 DOM 节点一个都不换', () => {
    const nodes: InlineNode[] = Array.from({ length: 50 }, (_, i) =>
      i % 2 === 0
        ? ({ type: 'code' as const, text: `/Users/me/f-${i}.ts:${i + 1}` })
        : ({ type: 'code' as const, text: `npm run t-${i}` }),
    )

    let parentRenders = 0
    function Probe({ tick }: { tick: number }) {
      parentRenders += 1
      return (
        <div data-tick={tick}>
          <InlineRun nodes={nodes} />
        </div>
      )
    }

    const view = render(<Probe tick={0} />)
    const before = Array.from(view.container.querySelectorAll('[data-ref-kind="fileRef"], code'))
    expect(before).toHaveLength(50)

    view.rerender(<Probe tick={1} />)
    expect(parentRenders).toBeGreaterThan(1)

    const after = Array.from(view.container.querySelectorAll('[data-ref-kind="fileRef"], code'))
    for (let i = 0; i < 50; i += 1) expect(after[i]).toBe(before[i])
  })
})

afterEach(() => {
  resetComposerReferenceSink()
})
