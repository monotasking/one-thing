/**
 * 代码色 token 覆盖 —— L2 死键的修复闩(H3 §6.6 挖出、本次修掉)。
 *
 * 缺陷原貌:`applyTheme('flexoki','dark',undefined,{'syntax.keyword':'#ff00ff'})`
 * 的产出与不给覆盖时**逐字节相同**。根因是代码色变量由 `resolveThemeHighlights`
 * 发出,而覆盖只写进了 `resolvedColors`;高亮层随后把同名变量原样盖回去。
 * 声明合法、设置页显示 active、屏幕上什么都没变 —— 静默说谎。
 *
 * 修法:覆盖里的代码色键归一到权威族 `syntax.*` 之后,进 `resolveThemeHighlights`
 * 的**输入层**(在 `ensureHighlightContrast` 之前),而不是往成品变量上打补丁。
 *
 * 这里钉四件事:
 *  1. 覆盖**确实改了变量**(三条渲染路共用的变量名逐条点名);
 *  2. 覆盖**过对比度护栏** —— 与码块底色同色的覆盖会被护栏改写,不是原样落地;
 *  3. **别名族同效** —— `text.code.*` 与 `syntax.*` 的产出逐字节相同;
 *  4. **零回归** —— 不给覆盖、或只给非代码色覆盖时,代码色变量一个不动。
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { applyTheme, initializeThemes } from '../index.js'
import { canonicalHighlightToken, pickHighlightTokenOverrides } from '../css-mapper.js'

const MAGENTA = '#ff00ff'

/** 权威族里**同时**出现在 `CSS_VAR_MAP`(= 覆盖白名单)里的 11 条。 */
const OVERRIDABLE_CODE_TOKENS = [
  'syntax.plain', 'syntax.comment', 'syntax.keyword', 'syntax.string',
  'syntax.number', 'syntax.function', 'syntax.variable', 'syntax.property',
  'syntax.type', 'syntax.operator', 'syntax.punctuation',
]

let pristine: Record<string, string>

beforeAll(() => {
  initializeThemes()
  pristine = applyTheme('flexoki', 'dark')
})

describe('代码色覆盖真的落地(不再是死键)', () => {
  it('syntax.keyword 覆盖:三条渲染路共用的变量全部换色', () => {
    const themed = applyTheme('flexoki', 'dark', undefined, { 'syntax.keyword': MAGENTA })

    // 缺陷时代这一行是 toEqual —— 产出逐字节相同。
    expect(themed).not.toEqual(pristine)

    // 权威变量(StreamingCodeBlock 与 diff-theme 都先取它)。
    expect(themed['--hg-syntax-keyword-fg']).not.toBe(pristine['--hg-syntax-keyword-fg'])
    // 聊天代码块路:hljs-theme.css 消费 --hljs-*,markdown/变量兜底消费 --text-code-*。
    expect(themed['--text-code-keyword']).toBe(themed['--hg-syntax-keyword-fg'])
    expect(themed['--hljs-keyword']).toBe(themed['--hg-syntax-keyword-fg'])
    // diff UI 路:variables.css 里的 --syntax-* 别名。
    expect(themed['--syntax-keyword']).toBe(themed['--hg-syntax-keyword-fg'])

    // 没点名的代码色一动不动 —— 覆盖是逐 token 的,不是整族的。
    expect(themed['--hg-syntax-string-fg']).toBe(pristine['--hg-syntax-string-fg'])
  })

  it('每一个可覆盖的代码色 token 都动得了(11 条,逐条过)', () => {
    for (const token of OVERRIDABLE_CODE_TOKENS) {
      const themed = applyTheme('flexoki', 'dark', undefined, { [token]: MAGENTA })
      const cssVar = `--hg-${token.replace(/\./g, '-')}-fg`
      expect(themed[cssVar], token).not.toBe(pristine[cssVar])
    }
  })

  it('覆盖照过 ensureHighlightContrast:与码块底色同色的覆盖会被护栏改写', () => {
    const codeBlockBg = pristine['--ui-surface-code-block-bg']
    expect(codeBlockBg).toBeTruthy()

    const themed = applyTheme('flexoki', 'dark', undefined, { 'syntax.keyword': codeBlockBg })
    const landed = themed['--hg-syntax-keyword-fg']

    // 覆盖生效了(与主题原色不同),但护栏没让它等于底色 —— 值被改写过。
    expect(landed).not.toBe(pristine['--hg-syntax-keyword-fg'])
    expect(landed.toLowerCase()).not.toBe(codeBlockBg.toLowerCase())

    // 护栏对插件的颜色**没有豁免**:连 #ff00ff 这种鲜色也会被按最低对比度重算。
    // 这不是错误,主题自己写的代码色走的是同一道护栏(裁决:覆盖先于派生)。
    const vivid = applyTheme('flexoki', 'dark', undefined, { 'syntax.keyword': MAGENTA })
    expect(vivid['--hg-syntax-keyword-fg']).not.toBe(pristine['--hg-syntax-keyword-fg'])
    expect(vivid['--hg-syntax-keyword-fg'].toLowerCase()).not.toBe(MAGENTA)
  })
})

describe('别名族 text.code.* 归一到权威族 syntax.*', () => {
  it('两族声明产出逐字节相同', () => {
    expect(applyTheme('flexoki', 'dark', undefined, { 'text.code.keyword': MAGENTA }))
      .toEqual(applyTheme('flexoki', 'dark', undefined, { 'syntax.keyword': MAGENTA }))
    expect(applyTheme('flexoki', 'light', undefined, { 'text.code.string': MAGENTA }))
      .toEqual(applyTheme('flexoki', 'light', undefined, { 'syntax.string': MAGENTA }))
  })

  it('text.code.inline / text.code.block 都归到 syntax.plain(高亮层只有一个正文码色)', () => {
    const viaInline = applyTheme('flexoki', 'dark', undefined, { 'text.code.inline': MAGENTA })
    expect(viaInline).toEqual(applyTheme('flexoki', 'dark', undefined, { 'syntax.plain': MAGENTA }))
    expect(viaInline).toEqual(applyTheme('flexoki', 'dark', undefined, { 'text.code.block': MAGENTA }))
    expect(viaInline['--text-code-inline']).toBe(viaInline['--text-code-block'])
  })

  it('同一张表里两族撞车:权威族胜(与键的书写顺序无关)', () => {
    const authoritative = applyTheme('flexoki', 'dark', undefined, { 'syntax.keyword': MAGENTA })

    expect(applyTheme('flexoki', 'dark', undefined, {
      'text.code.keyword': '#00ff00',
      'syntax.keyword': MAGENTA,
    })).toEqual(authoritative)
    expect(applyTheme('flexoki', 'dark', undefined, {
      'syntax.keyword': MAGENTA,
      'text.code.keyword': '#00ff00',
    })).toEqual(authoritative)
  })

  it('归一表本身:权威族返回自己、别名族返回权威键、非代码色返回 null', () => {
    expect(canonicalHighlightToken('syntax.keyword')).toBe('syntax.keyword')
    expect(canonicalHighlightToken('text.code.keyword')).toBe('syntax.keyword')
    expect(canonicalHighlightToken('text.code.inline')).toBe('syntax.plain')
    expect(canonicalHighlightToken('accent')).toBeNull()
    expect(canonicalHighlightToken('bg.app')).toBeNull()
  })

  it('pickHighlightTokenOverrides 只挑代码色,并归一', () => {
    expect(pickHighlightTokenOverrides(undefined)).toBeUndefined()
    expect(pickHighlightTokenOverrides({ accent: MAGENTA })).toBeUndefined()
    expect(pickHighlightTokenOverrides({
      accent: MAGENTA,
      'text.code.string': '#00ff00',
      'syntax.keyword': MAGENTA,
    })).toEqual({ 'syntax.string': '#00ff00', 'syntax.keyword': MAGENTA })
  })
})

describe('零回归', () => {
  it('不给覆盖 / 只给非代码色覆盖时,代码色变量一个不动', () => {
    expect(applyTheme('flexoki', 'dark', undefined, {})).toEqual(pristine)

    const brandOnly = applyTheme('flexoki', 'dark', undefined, { accent: '#ff4d00' })
    for (const [name, value] of Object.entries(pristine)) {
      if (!name.startsWith('--hg-syntax-') && !name.startsWith('--text-code-') &&
          !name.startsWith('--hljs-') && !name.startsWith('--syntax-')) continue
      expect(brandOnly[name], name).toBe(value)
    }
  })
})
