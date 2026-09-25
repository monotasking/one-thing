import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * **两张覆盖表只许后端读**(§5.5,`docs/design/provider-settings-rework-2026-09.md`)。
 *
 * 「用户覆盖 > 接口 / 目录 > 不知道」这条折叠从前有三份:引擎、壳的
 * `data/models-source.ts`(`contextWindowOf` / `readingsOf`)、设置面的
 * `providers/projection.ts`(`overrideOf` / `capsWithOverride`)。09-10「设了上下文圆环仍
 * unknown」就是壳那一份漏读了覆盖表。现在判据只在产品层一处
 * (`runtime/providers/effective-model.ts` 的 `effectiveModelFactsOf`),后端经
 * `models.getWithCapabilities` 把每行的 `effective` 交下来,壳只读结果。
 *
 * 这条守卫钉的是「壳不再自己折」:`contextLengthByModel` / `maxOutputByModel` 在壳的
 * 源码里只许出现在**写面**——
 *   · `providers/store.ts` 的 `setModelOverride`(写之前读出整张表、改一格、整张换回);
 *   · `providers/model-maps.ts` 的按模型键表名单(手填模型改 id 时连表一起搬)。
 * 任何别处读它 = 在壳里又长出一份折叠。
 *
 * 反证:把 `config?.contextLengthByModel?.[id]` 抄回 `data/models-source.ts` → 这条当场红。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(here, '..')

/** 写面:只有这两个文件碰得到覆盖表的名字。 */
const WRITERS = new Set(['providers/store.ts', 'providers/model-maps.ts'])

const TABLES = ['contextLengthByModel', 'maxOutputByModel']

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__' || name === '__fixtures__') continue
      walk(full, out)
      continue
    }
    if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full)
  }
  return out
}

describe('覆盖表只许后端读(§5.5)', () => {
  it('壳源码里除写面之外,读不到 contextLengthByModel / maxOutputByModel', () => {
    const offenders: string[] = []
    for (const file of walk(srcRoot)) {
      const rel = path.relative(srcRoot, file).split(path.sep).join('/')
      if (WRITERS.has(rel)) continue
      // 只看真正的引用,不看注释里提到的名字(病历文本不该让断言自红)。
      const stripped = readFileSync(file, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      for (const table of TABLES) {
        if (new RegExp(`\\b${table}\\b`).test(stripped)) offenders.push(`${rel} → ${table}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('写面那两个文件还在(名单不是空转)', () => {
    for (const rel of WRITERS) {
      const source = readFileSync(path.join(srcRoot, rel), 'utf-8')
      expect(TABLES.some((table) => source.includes(table)), rel).toBe(true)
    }
  })
})
