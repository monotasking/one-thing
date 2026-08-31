import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LANGUAGES, languageIdOfExtension } from './languages'
import { langOfPath } from './files-source'

/**
 * **语法高亮的语言表:一行说三件事,两个消费方都从它取**(09-01)。
 *
 * 这一组守的是那条「加一门语言只动一行」的判据 —— 从前它是两处(扩展名表在
 * `files-source`,grammar 列表在 `highlight.ts`),漏加一处**不报错**,只表现为
 * 「怎么没上色」。
 *
 * 反证:把 `highlight.ts` 里那句 `LANGUAGES.map((lang) => lang.grammar())`
 * 换回一串写死的 import → 最后一条当场红。
 */

const here = path.dirname(fileURLToPath(import.meta.url))

describe('语言表:单产地', () => {
  it('每一行都说得出 id、至少一个扩展名、一个 grammar thunk', () => {
    for (const lang of LANGUAGES) {
      expect(lang.id).toBeTruthy()
      expect(lang.exts.length).toBeGreaterThan(0)
      expect(typeof lang.grammar).toBe('function')
      // 扩展名一律小写不带点 —— 查表那一口只 toLowerCase,不做别的清洗。
      for (const ext of lang.exts) expect(ext).toBe(ext.toLowerCase().replace(/^\./, ''))
    }
  })

  it('扩展名不许被两门语言抢(抢了就是「谁排后面谁输」的静默 bug)', () => {
    const seen = new Map<string, string>()
    for (const lang of LANGUAGES) {
      for (const ext of lang.exts) {
        expect(seen.has(ext), `${ext} 被 ${seen.get(ext)} 与 ${lang.id} 同时认领`).toBe(false)
        seen.set(ext, lang.id)
      }
    }
  })

  it('`langOfPath` 只是这张表的一条委托(两处口径逐字相同)', () => {
    expect(langOfPath('/a/x.ts')).toBe('typescript')
    expect(langOfPath('/a/x.TSX')).toBe('tsx')
    expect(langOfPath('/a/Makefile')).toBeNull()
    expect(langOfPath('/a/x.weird')).toBeNull()
    for (const lang of LANGUAGES) {
      for (const ext of lang.exts) {
        expect(langOfPath(`/a/file.${ext}`)).toBe(lang.id)
        expect(languageIdOfExtension(ext)).toBe(lang.id)
      }
    }
  })

  it('高亮器的 langs 那一列**取自这张表**,不是第二份手写清单', () => {
    const source = readFileSync(
      path.join(here, '../content/blocks/kinds/code/highlight.ts'),
      'utf-8',
    )
    expect(source).toMatch(/langs: LANGUAGES\.map\(/)
    // 反面:文件里不许再有写死的 grammar import(那就是第二份清单)。
    const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(stripped).not.toMatch(/import\('shiki\/langs\//)
  })
})
