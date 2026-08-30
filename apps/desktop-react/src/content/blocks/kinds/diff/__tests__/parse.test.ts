import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from '../parse'

/**
 * diff 解析器的单测 —— 纯函数,所以这一层是**判据**层,不是冒烟层。
 *
 * 四类素材各有一条纪律要钉:
 *  ① 正常 hunk:头行原样留着、行号起点认对、加减归类对;
 *  ② 没有文件头:碎片一样成立,起始行号缺席就缺席(不编);
 *  ③ 只有 +− 没有 @@:最常见的那种手写片段,必须认;
 *  ④ 解析不动的行:原样透传,一个字符不丢 —— 这一条是全表最重要的。
 */

describe('正常 hunk', () => {
  const text = [
    'diff --git a/src/app.ts b/src/app.ts',
    'index 1111111..2222222 100644',
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -10,4 +10,5 @@ function boot()',
    ' const a = 1',
    '-const b = 2',
    '+const b = 3',
    '+const c = 4',
  ].join('\n')

  it('文件路径取 +++ 那一份(a/ b/ 前缀削掉)', () => {
    expect(parseUnifiedDiff(text)?.file).toBe('src/app.ts')
  })

  it('hunk 头留原文(后面挂的函数名不许被合成掉)', () => {
    expect(parseUnifiedDiff(text)?.hunks[0].header).toBe('@@ -10,4 +10,5 @@ function boot()')
  })

  it('起始行号按新文件那一侧认', () => {
    const hunk = parseUnifiedDiff(text)?.hunks[0]
    expect(hunk?.oldStart).toBe(10)
    expect(hunk?.newStart).toBe(10)
  })

  it('逐行归类 + ±统计', () => {
    const parsed = parseUnifiedDiff(text)
    expect(parsed?.hunks[0].lines).toEqual([
      { kind: 'ctx', text: 'const a = 1' },
      { kind: 'del', text: 'const b = 2' },
      { kind: 'add', text: 'const b = 3' },
      { kind: 'add', text: 'const c = 4' },
    ])
    expect(parsed?.stat).toEqual({ add: 2, del: 1 })
  })

  it('文件头不会漏进正文 —— 它们是头,不是内容', () => {
    const flat = parseUnifiedDiff(text)?.hunks.flatMap((h) => h.lines.map((l) => l.text)) ?? []
    expect(flat.some((line) => line.includes('diff --git'))).toBe(false)
    expect(flat.some((line) => line.includes('index 1111111'))).toBe(false)
  })

  it('源码原文原样留在块上(「查看源码」与降级都认它)', () => {
    expect(parseUnifiedDiff(text)?.source).toBe(text)
  })

  it('多个 hunk 各是一段', () => {
    const two = '@@ -1 +1 @@\n+a\n@@ -9 +9 @@\n-b'
    const parsed = parseUnifiedDiff(two)
    expect(parsed?.hunks).toHaveLength(2)
    expect(parsed?.hunks[1].newStart).toBe(9)
    expect(parsed?.stat).toEqual({ add: 1, del: 1 })
  })

  it('/dev/null 那一侧不是路径(新增文件)', () => {
    const added = '--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+hello'
    expect(parseUnifiedDiff(added)?.file).toBe('new.ts')
  })

  it('路径后面那截时间戳由 tab 隔开,不属于路径', () => {
    const stamped = '--- a/x.ts\t2026-08-30 10:00:00\n+++ b/x.ts\t2026-08-30 10:00:01\n@@ -1 +1 @@\n+a'
    expect(parseUnifiedDiff(stamped)?.file).toBe('x.ts')
  })
})

describe('没有文件头', () => {
  it('只有 hunk 也成立,file 缺席就缺席', () => {
    const parsed = parseUnifiedDiff('@@ -3,2 +3,2 @@\n-x\n+y')
    expect(parsed?.file).toBeUndefined()
    expect(parsed?.hunks[0].newStart).toBe(3)
  })
})

describe('只有 +− 没有 @@ 的碎片', () => {
  const parsed = parseUnifiedDiff('+added\n-removed\n unchanged')

  it('认,归进一个隐式 hunk', () => {
    expect(parsed?.hunks).toHaveLength(1)
    expect(parsed?.stat).toEqual({ add: 1, del: 1 })
  })

  it('起始行号缺席 —— 编不出来就不编', () => {
    expect(parsed?.hunks[0].newStart).toBeUndefined()
    expect(parsed?.hunks[0].header).toBeUndefined()
  })
})

describe('解析不动的行原样透传', () => {
  it('`\\ No newline at end of file` 整行照抄,不削第一个字符', () => {
    const parsed = parseUnifiedDiff('@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file')
    expect(parsed?.hunks[0].lines[2]).toEqual({ kind: 'ctx', text: '\\ No newline at end of file' })
  })

  it('认不出的方言行整行照抄', () => {
    const parsed = parseUnifiedDiff('@@ -1 +1 @@\n+a\n??? 什么方言')
    expect(parsed?.hunks[0].lines[1]).toEqual({ kind: 'ctx', text: '??? 什么方言' })
  })

  it('内容行一个字符都不丢 —— 拼回去与原文逐字相同', () => {
    const text = '@@ -1,3 +1,3 @@\n ctx line\n-  deep indent\n+  deep indent!\n'
    const parsed = parseUnifiedDiff(text)!
    const back = parsed.hunks[0].lines
      .map((line) => (line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ') + line.text)
      .join('\n')
    expect(back).toBe(' ctx line\n-  deep indent\n+  deep indent!')
  })

  it('末尾那个换行不多切出一行空行', () => {
    expect(parseUnifiedDiff('@@ -1 +1 @@\n+a\n')?.hunks[0].lines).toHaveLength(1)
    // 两个换行时最后那一行空行是真的。
    expect(parseUnifiedDiff('@@ -1 +1 @@\n+a\n\n')?.hunks[0].lines).toHaveLength(2)
  })
})

describe('认不出来就说认不出来', () => {
  it('普通文字 → undefined(调用方退回 code)', () => {
    expect(parseUnifiedDiff('just some prose\nwith two lines')).toBeUndefined()
  })

  it('空文本 → undefined', () => {
    expect(parseUnifiedDiff('')).toBeUndefined()
    expect(parseUnifiedDiff('   \n  ')).toBeUndefined()
  })

  it('有 @@ 头但一行加减都没有 —— 仍然算 diff(结构在那儿)', () => {
    expect(parseUnifiedDiff('@@ -1 +1 @@\n unchanged')?.stat).toEqual({ add: 0, del: 0 })
  })
})
