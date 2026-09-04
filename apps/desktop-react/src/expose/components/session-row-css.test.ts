import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * 09-04 用户报:钉在边架(320px)时标题只剩「屏幕使…」三个字。病根是悬停动作
 * 两颗钮**常驻在 flex 流里**,静息时也占 ~56px;改成浮在行尾之上(绝对定位),
 * 标题在静息态拿回整行。jsdom 不排版,这条守在样式表源文本上(剥注释后判)。
 */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const css = strip(readFileSync(path.join(__dirname, 'SessionRow.module.css'), 'utf-8'))
const block = (selector: string) => css.slice(css.indexOf(selector)).split('}')[0]

describe('SessionRow 悬停动作不占行内空间', () => {
  it('.actions 绝对定位、.row 是它的定位上下文', () => {
    expect(block('.actions {')).toMatch(/position:\s*absolute/)
    expect(block('.row {')).toMatch(/position:\s*relative/)
  })
  it('显形时只动 opacity:时间列同帧淡出,而不是被推开', () => {
    expect(css).toMatch(/\.row:hover \.time[\s\S]*?opacity:\s*0/)
    expect(block('.actions {')).not.toMatch(/margin|flex:/)
  })
})
