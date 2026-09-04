import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * 09-04 用户报「项目下拉框的长度会根据 project 的 name 无限增长」:选项名是数据
 * (目录名),没有上限;jsdom 不排版,所以这条守在样式表源文本上 —— 面板宽度封顶
 * 那一行不许消失,项名的省略号三件套也不许消失。剥注释后再判,免得病历文本自红。
 */
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const select = strip(readFileSync(path.join(__dirname, '../Select.module.css'), 'utf-8'))
const menu = strip(readFileSync(path.join(__dirname, '../Menu.module.css'), 'utf-8'))
const tokens = strip(readFileSync(path.join(__dirname, '../../styles/tokens.css'), 'utf-8'))
const block = (css: string, selector: string) => css.slice(css.indexOf(selector)).split('}')[0]

describe('Select 面板宽度封顶', () => {
  it('.list 有 max-width,且量入 tokens', () => {
    expect(block(select, '.list {')).toMatch(/max-width:\s*var\(--select-menu-max-w\)/)
    expect(tokens).toMatch(/--select-menu-max-w:\s*\d+px/)
  })
  it('菜单项名只截断不换行,且 min-width:0 让它真能缩', () => {
    const label = block(menu, '.itemLabel {')
    expect(label).toMatch(/min-width:\s*0/)
    expect(label).toMatch(/overflow:\s*hidden/)
    expect(label).toMatch(/text-overflow:\s*ellipsis/)
    expect(label).toMatch(/white-space:\s*nowrap/)
  })
})
