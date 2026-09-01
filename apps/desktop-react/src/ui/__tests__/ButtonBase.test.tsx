import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ButtonBase } from '../ButtonBase'

const uiDir = path.resolve(__dirname, '..')
const srcDir = path.resolve(uiDir, '..')
const sheetPath = path.join(uiDir, 'ButtonBase.css')
/**
 * 读样式表的门先剥注释 —— 病历文本里就写着 `.module.css`,不剥会让断言自红。
 * 文件不在时给空串而不是让 readFileSync 抛:样式表被改名/删掉正是这条门要抓的
 * 那件事,它该以一条读得懂的断言失败收场,而不是在收集阶段炸成一堆栈。
 */
function readStripped(file: string): string {
  try {
    return readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')
  } catch {
    return ''
  }
}
const sheet = readStripped(sheetPath)
const tsx = readStripped(path.join(uiDir, 'ButtonBase.tsx'))

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(full)) out.push(full)
  }
  return out
}

describe('ButtonBase:组件行为', () => {
  it('默认 type="button"(表单里不许顺手提交整张表)', () => {
    render(<ButtonBase>展开这一组</ButtonBase>)
    expect(screen.getByRole('button').getAttribute('type')).toBe('button')
  })

  it('type 可被显式覆盖', () => {
    render(<ButtonBase type="submit">提交</ButtonBase>)
    expect(screen.getByRole('button').getAttribute('type')).toBe('submit')
  })

  it('贴 data-ui-base —— 样式表认的就是这个属性,不是类名', () => {
    render(<ButtonBase>瓦</ButtonBase>)
    expect(screen.getByRole('button').hasAttribute('data-ui-base')).toBe(true)
  })

  it('不往元素上挂任何类:皮肤全归消费方,基座一个像素都不画', () => {
    render(<ButtonBase>行</ButtonBase>)
    expect(screen.getByRole('button').className).toBe('')
  })

  it('消费方的 className / aria / disabled 原样透传,ref 落在真按钮上', () => {
    const ref = createRef<HTMLButtonElement>()
    render(
      <ButtonBase ref={ref} className="tile" aria-label="会话卡" disabled>
        卡
      </ButtonBase>,
    )
    const el = screen.getByRole('button', { name: '会话卡' })
    expect(el.className).toBe('tile')
    expect(el.hasAttribute('disabled')).toBe(true)
    expect(ref.current).toBe(el)
  })
})

/**
 * ── 防复发:这一族断言钉的是 09-02 那个「dev 有 prod 无」的病(批 3.6)───────
 * 病历全文在 `src/ui/ButtonBase.css` 文件头。一句话:那份样式表从前叫
 * `.module.css`、零本地类名、只被「为副作用」import 一次,于是 `vite build` 把
 * 那个没有任何导出被消费的模块摇掉,**规则整份没进过生产产物**。
 *
 * 这里是**源码侧的早鸣**(便宜、每次单测都跑);真正的判据在
 * `scripts/verify.mjs` 的 buttonbase-css 一步 —— 它 grep 的是构建产物本身,
 * 不依赖任何关于打包器行为的推断。两条一起才算钉住。
 */
describe('ButtonBase:样式表必须进得了生产产物', () => {
  it('样式表是普通 .css —— 普通 CSS 的 import 摇不掉', () => {
    expect(sheet, 'src/ui/ButtonBase.css 读不到 —— 样式表被改名或删了').not.toBe('')
    expect(tsx).toMatch(/import\s+'\.\/ButtonBase\.css'/)
    expect(tsx).not.toMatch(/ButtonBase\.module\.css/)
  })

  it('普通 CSS 里不许留 :global() —— 那是 CSS Modules 专用伪类,写在这儿整条规则会被丢掉', () => {
    expect(sheet).not.toContain(':global(')
  })

  it('全 src 不许再出现「只为副作用」的 .module.css import(这就是那条病根)', () => {
    const offenders = walk(srcDir).filter((file) => {
      const text = readFileSync(file, 'utf-8')
      // `import './X.module.css'` —— 前面没有 `… from`,即没有任何绑定被消费。
      return /(^|\n)\s*import\s+'[^']*\.module\.css'/.test(text)
    })
    expect(offenders.map((f) => path.relative(srcDir, f))).toEqual([])
  })
})

/**
 * 基座的立身之本是**零特异性**:消费方随便一个类都要能无条件盖过它,顺序不参与。
 * 焦点环走全局 `:focus-visible`,基座不许把 outline 一起清掉。
 */
describe('ButtonBase:样式表的配方', () => {
  it('两条规则都包在 :where() 里 —— 特异性压成 0', () => {
    const selectors = [...sheet.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim())
    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) {
      expect(selector.startsWith(':where(')).toBe(true)
      expect(selector).toContain('button[data-ui-base]')
    }
  })

  it('清掉 global.css 的 `button {}` 兜不住的那两条:appearance / text-align', () => {
    expect(sheet).toMatch(/appearance:\s*none/)
    expect(sheet).toMatch(/text-align:\s*inherit/)
  })

  it('禁裸删 outline:清 UA 不许把焦点环一起清掉', () => {
    expect(sheet).not.toMatch(/outline\s*:\s*none/)
  })
})
