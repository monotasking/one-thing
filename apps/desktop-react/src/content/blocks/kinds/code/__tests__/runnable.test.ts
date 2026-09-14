import { describe, expect, it } from 'vitest'
import { isRunnableCode, runnableScriptOf } from '../runnable'

/**
 * 「这块代码跑不跑得了 / 跑的是哪一段」那两只纯函数(2026-09-14)。
 *
 * 反证(每条真跑过一次):
 *  · 把 `isRunnableCode` 里的 `toLowerCase()` 拆掉 → 大小写那条红;
 *  · 把 `closed` 那一问拆掉 → 「还在流式」那条红(而屏幕上一切正常:人点下去
 *    跑的是半句命令,这正是它必须有门的理由);
 *  · 把剥提示符那条正则的 `^` 去掉 → 「行当中的 $ 不动」红。
 */

const code = (over: Partial<{ lang: string | null; source: string; closed: boolean }> = {}) => ({
  kind: 'code' as const,
  lang: 'bash',
  source: 'ls',
  closed: true,
  ...over,
})

describe('哪些围栏能跑', () => {
  for (const lang of ['bash', 'sh', 'zsh', 'shell', 'console']) {
    it(`${lang} 能跑`, () => {
      expect(isRunnableCode(code({ lang }))).toBe(true)
    })
  }

  it('**大小写不算数**:Bash / SH / Shell 在真实 markdown 里都见得到', () => {
    expect(isRunnableCode(code({ lang: 'Bash' }))).toBe(true)
    expect(isRunnableCode(code({ lang: 'SH' }))).toBe(true)
    expect(isRunnableCode(code({ lang: 'ZsH' }))).toBe(true)
  })

  it('ts 不能跑 —— 词表是封闭的', () => {
    expect(isRunnableCode(code({ lang: 'ts' }))).toBe(false)
  })

  it('没写语言的围栏不能跑(猜一个出来就是替人做主)', () => {
    expect(isRunnableCode(code({ lang: null }))).toBe(false)
  })

  it('**围栏没闭合就不露出** —— 还在流式,脚本没写完', () => {
    expect(isRunnableCode(code({ closed: false }))).toBe(false)
  })
})

describe('剥提示符:只剥行首那一个 `$ `', () => {
  it('逐行剥掉行首提示符(console 这种围栏由此变成能跑的脚本)', () => {
    expect(runnableScriptOf('$ npm run build\n$ echo done')).toBe('npm run build\necho done')
  })

  it('行首有缩进的提示符也剥(`^\\s*\\$ `)', () => {
    expect(runnableScriptOf('  $ ls')).toBe('ls')
  })

  it('**行当中的 `$` 一个字都不动**:那是变量与命令替换,不是提示符', () => {
    expect(runnableScriptOf('echo $HOME && echo $(pwd)')).toBe('echo $HOME && echo $(pwd)')
  })

  it('没有空格的 `$foo` 不是提示符', () => {
    expect(runnableScriptOf('$foo=1')).toBe('$foo=1')
  })

  it('**行当中的 `$ ` 也不动** —— 判据是「行首」,不是「这两个字符」', () => {
    expect(runnableScriptOf('echo "价格 $ 5"')).toBe('echo "价格 $ 5"')
  })

  it('缩进、空行、注释原样留着(整理只做剥提示符这一件事)', () => {
    const source = 'if true; then\n  # 注释\n  echo hi\n\nfi'
    expect(runnableScriptOf(source)).toBe(source)
  })

  it('**不补末尾换行** —— 回车是执行器那一层的语义', () => {
    expect(runnableScriptOf('ls')).toBe('ls')
    expect(runnableScriptOf('ls\n')).toBe('ls\n')
  })
})
