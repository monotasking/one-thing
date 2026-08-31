import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * **类型标识的表现形式只有两个产地**(09-01 用户定的交卷判据:「文件列表图标的
 * 表现形式可整体切换」——比如哪天全部从品牌字标改成 lucide 图标)。
 *
 * 两个产地是:
 *   ① `data/file-icons.ts` —— **判据**:这个文件名交出哪一枚(brand | icon 的判别联合);
 *   ② `content/FileGlyph.tsx` —— **画法**:把那一枚兑成 DOM 与 CSS 变量。
 *
 * 整体换形 = 只动这两处(操作清单写在交卷报告里),**任何行组件零改**。
 * 这条守卫钉的正是「零改」那一半:消费方只许拿到 `glyphOf()` 的结果转手交给
 * `<FileGlyphMark>`,不许自己拆开那个联合去画 —— 一旦有人在行里写
 * `glyph.kind === 'brand' ? <span style={{background: brandVars(…)}}/> : <Icon/>`,
 * 换形就得改三处而不是两处,而第三处一定会被忘掉。
 *
 * 反证:把 `brandVars` 的 import 抄进 FilesPanel.tsx → 这条当场红。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(here, '../..')

/** 只有这两个文件有资格碰「怎么画」那一层的原语。 */
const PAINTERS = new Set(['content/FileGlyph.tsx', 'data/file-icons.ts'])

/** 画法层的原语:色值变量的两口,加上那个判别联合的两个标签。 */
const PAINT_PRIMITIVES = ['brandVars', 'toneVar']

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue
      walk(full, out)
      continue
    }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

describe('类型标识:判据一处、画法一处,行组件零改', () => {
  it('只有 FileGlyph 与 file-icons 碰得到色值原语(brandVars / toneVar)', () => {
    const offenders: string[] = []
    for (const file of walk(srcRoot)) {
      const rel = path.relative(srcRoot, file)
      if (PAINTERS.has(rel)) continue
      const source = readFileSync(file, 'utf-8')
      for (const token of PAINT_PRIMITIVES) {
        // 只看真正的引用,不看注释里提到的名字(病历文本不该让断言自红)。
        const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        if (new RegExp(`\\b${token}\\b`).test(stripped)) offenders.push(`${rel} → ${token}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('拿到 glyph 的地方都把它转手给 FileGlyphMark,自己不拆那个联合', () => {
    /*
     * 判据是**结构**不是措辞:一个文件如果调了 `glyphOf(`,它就必须也用
     * `<FileGlyphMark`。拆联合去自画的那种写法必然出现在这两者之一缺席的文件里。
     * (`file-icons.ts` 自己是产地,`FileGlyph.tsx` 自己是画法,两者豁免。)
     */
    const offenders: string[] = []
    for (const file of walk(srcRoot)) {
      const rel = path.relative(srcRoot, file)
      if (PAINTERS.has(rel)) continue
      const source = readFileSync(file, 'utf-8')
      if (!source.includes('glyphOf(')) continue
      if (!source.includes('<FileGlyphMark')) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
})
