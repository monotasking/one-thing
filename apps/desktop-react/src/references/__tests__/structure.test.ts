import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import '..'
import {
  parseToken,
  referenceKindList,
  referenceKindOf,
  referencePickKinds,
  registerReferenceKind,
  resetReferenceKinds,
} from '../registry'
import { segmentReferenceText } from '../segment'
import { buildPickView } from '../drawer'
import type { ReferenceKind } from '../kind'

/**
 * **骨架守卫**(仓根 CLAUDE.md「加功能不许改骨架」在这条链上的执法)。
 *
 * 三件事:
 *  ① **五处旧枚举点里一个种类名都不许再有** —— 这是这一单的全部意义。判据是
 *     「源码里出现的**引号里的种类 id**」,注释里提旧名字不算(那是病历,该留);
 *  ② 注册表本身:登记 / 重复拒 / 认得出就得画得出 / reset;
 *  ③ **陌生能力演练** —— 测试里现登记一份**设计时没想过**的引用,断言它自动出现
 *     在抽屉、落得了稿、认得出、画得出、点得了,**一个生产文件都不改**。
 *     答不出这一段 = 骨架没抽到位(正本 §3)。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = resolve(HERE, '../..')

/**
 * 把注释剥掉再 grep。**病历要留在注释里**(「从前这一格是 `'files' | 'commands'`」
 * 那种句子正是这一单的判词),而门要判的是**代码**里还有没有那几个名字。
 */
function codeOf(relative: string): string {
  const text = readFileSync(resolve(SRC, relative), 'utf8')
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n')
}

/** 今天表上的七种,外加两个已经退役的旧枚举名。 */
const KIND_WORDS = [
  'file',
  'dir',
  'command',
  'skill',
  'plugin',
  'prompt',
  'page',
  'files',
  'commands',
  'fileRef',
  'dirRef',
  'skillRef',
  'promptRef',
]

/** 引号里的那几个字 —— 一个种类 id 字面量。 */
const KIND_LITERAL = new RegExp(`(['"\`])(${KIND_WORDS.join('|')})\\1`, 'g')

describe('① 旧枚举点:核心层不出现任何一种引用的名字', () => {
  it.each([
    ['composer/types.ts', '抽屉的来源那半边收成了「哪个触发字符」'],
    ['composer/usePickDrawer.ts', '候选怎么取、落稿插什么,八处分支全归自述'],
    ['composer/components/DrawerPickList.tsx', '组头 / 一行几格 / 空态六处分支全归自述'],
    ['composer/components/ComposerInput.tsx', 'chip 画哪一形、记号怎么展开归自述'],
    ['content/user-message.tsx', '两张 switch 收成一条通路'],
  ])('%s 里没有种类 id 字面量(%s)', (relative) => {
    const hits = codeOf(relative).match(KIND_LITERAL) ?? []
    expect(hits).toEqual([])
  })

  it('`parseToken` 里没有 `@` / `/` 的手写正则 —— 触发表由自述并出来', () => {
    const code = codeOf('references/registry.ts')
    // 触发字符只能来自 `kind.source.trigger`,所以这只文件里不许出现它们的字面量。
    expect(code).not.toMatch(/['"`]@['"`]/)
    expect(code).not.toMatch(/['"`]\/['"`]/)
  })
})

describe('② 注册表', () => {
  afterEach(() => {
    // 演练与重复拒那几条动了表,跑完把 barrel 那七种装回来。
    resetReferenceKinds()
    vitestReloadBarrel()
  })

  it('barrel import 就是「这台上认得哪几种引用」', () => {
    expect(referenceKindList().map((k) => k.id)).toEqual([
      'file',
      'dir',
      'command',
      'skill',
      'plugin',
      'prompt',
      'page',
    ])
  })

  it('重复 id **抛**,不静默覆盖', () => {
    const one: ReferenceKind = { id: 'dup' }
    const two: ReferenceKind = { id: 'dup' }
    const off = registerReferenceKind(one)
    // 同一份自述再登记一次是恒等(热更那条路会这样),换一份才是真冲突。
    expect(() => registerReferenceKind(one)).not.toThrow()
    expect(() => registerReferenceKind(two)).toThrow(/重复注册/)
    off()
    expect(referenceKindOf('dup')).toBeUndefined()
  })

  it('认得出却画不出来 = 在登记那一刻抛(不许在屏幕上开天窗)', () => {
    expect(() =>
      registerReferenceKind({
        id: 'blind',
        parse: { part: { type: 'x', toRef: () => ({}) } },
      }),
    ).toThrow(/画不出来/)
  })

  it('reset 之后一个字符都不触发 —— 没登记 = 这台上没有这种能力', () => {
    resetReferenceKinds()
    expect(parseToken('看看 @a', '看看 @a')).toBeNull()
    expect(referencePickKinds()).toHaveLength(0)
  })
})

/**
 * ── ③ 陌生能力演练:「@ 一条会话」(正本 §3)────────────────────────────────
 *
 * 设计这一单的时候**没想过**会话也能被引用。这一段现造一份自述、现登记,
 * 然后逐条问:它进不进抽屉、落不落得了稿、气泡认不认得出、画不画得出、点不点得了。
 * 全程**一个生产文件都不改**(这只测试文件里没有任何 `readFileSync` 之外的
 * 生产路径改动),这就是「加功能不许改骨架」在这条链上的兑现。
 */
describe('③ 陌生能力演练:@ 一条会话', () => {
  const opened: string[] = []

  interface SessionHit {
    id: string
    title: string
  }

  const sessionKind: ReferenceKind<SessionHit, { kind: 'sessionRef'; id: string }> = {
    id: 'session',
    source: {
      trigger: '@',
      where: 'anywhere',
      tokenChars: '.-',
      group: { key: 'composer.headFiles' },
      hint: 'composer.hintFile',
      useQuery: (ctx) => ({
        hits: ctx.active ? [{ id: 's1', title: '上一条会话' }] : [],
        status: 'ready',
      }),
      row: (hit) => ({ primary: hit.title }),
    },
    draft: {
      chip: (hit) => ({ label: `@${hit.title}`, tone: 'reference' }),
      token: (hit) => `{{session:${hit.id}}}`,
      expand: (token) => `@session:${token.slice('{{session:'.length, -2)}`,
    },
    parse: {
      text: {
        pattern: /(^|\s)@session:([A-Za-z0-9_-]+)/g,
        toRef: (m) => ({
          ref: { kind: 'sessionRef' as const, id: m[2] },
          start: m.index + m[1].length,
          end: m.index + m[0].length,
        }),
      },
    },
    render: (ref) => ({
      className: 'session-chip',
      label: ref.id,
      clickable: true,
      tooltipKey: 'composer.headFiles',
    }),
    open: (ref) => {
      opened.push(ref.id)
      return true
    },
  }

  let off: (() => void) | undefined
  afterEach(() => {
    off?.()
    off = undefined
    opened.length = 0
  })

  it('一行登记之后:抽屉里有它、落得了稿、认得出、画得出、点得了', () => {
    off = registerReferenceKind(sessionKind)

    // ① 拾取:`@` 这个字符下多了一家,抽屉按登记序把它排在文件后面。
    const ids = referencePickKinds()
      .filter((k) => k.source!.trigger === '@')
      .map((k) => k.id)
    expect(ids).toEqual(['file', 'session'])

    const view = buildPickView([
      {
        kind: sessionKind,
        result: sessionKind.source!.useQuery({
          trigger: '@',
          query: '',
          cwd: null,
          sessionId: '',
          active: true,
        }),
      },
    ])
    expect(view.groups[0].entries[0].row.primary).toBe('上一条会话')

    // ② 落稿:chip 写什么、草稿里那截记号长什么样、出站展成什么。
    const hit = view.groups[0].entries[0].hit as SessionHit
    expect(sessionKind.draft!.chip(hit)).toEqual({ label: '@上一条会话', tone: 'reference' })
    const token = sessionKind.draft!.token!(hit)
    expect(token).toBe('{{session:s1}}')
    expect(sessionKind.draft!.expand!(token)).toBe('@session:s1')

    // ③ 认出:气泡里那句话被切成 文字 + 一枚会话引用 + 文字。
    const segs = segmentReferenceText('看看 @session:s1 那条')
    expect(segs.map((s) => s.kindId)).toEqual([null, 'session', null])
    expect(segs[1].value).toEqual({ kind: 'sessionRef', id: 's1' })

    // ④ 呈现 + ⑤ 打开。
    const spec = sessionKind.render!(segs[1].value as { kind: 'sessionRef'; id: string })
    expect(spec.clickable).toBe(true)
    expect(spec.label).toBe('s1')
    expect(referenceKindOf('session')!.open!(segs[1].value as never)).toBe(true)
    expect(opened).toEqual(['s1'])
  })

  it('反证:把那一行登记去掉,同一句话原样落回文字', () => {
    const segs = segmentReferenceText('看看 @session:s1 那条')
    expect(segs.map((s) => s.kindId)).toEqual([null])
    expect(segs[0].value).toEqual({ kind: 'text', text: '看看 @session:s1 那条' })
  })
})

/**
 * 表被 `resetReferenceKinds()` 清过之后要装回来。
 *
 * 模块只装载一次,所以不能靠再 `import '..'` —— 这里直接把那七份自述重新登记
 * 一遍(它们是模块级常量,身份没变,`registerReferenceKind` 对同一份是恒等)。
 */
function vitestReloadBarrel(): void {
  for (const kind of BARREL) registerReferenceKind(kind)
}

const BARREL: ReferenceKind[] = referenceKindList().slice()
