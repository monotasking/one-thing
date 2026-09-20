import { describe, expect, it } from 'vitest'
import { textSymbolLocator } from '../symbol-locator'

/**
 * **`<ref … symbol="…"/>` 落到第几行**(B2,正本 §2.7)。
 *
 * 这只策略是纯函数,所以它的用例就是一张表:各语言的定义形、三种非定义形
 * (`名(` / `名 =` / `名:`)、整词首现兜底、`nearLine` 取最近、找不到答 null、
 * 正则元字符。**不测「打开之后落到哪一行」** —— 那是 `openFileAt` 的事,
 * 而它在那一条链上的角色正是「换实现调用方不动」。
 */

const locate = (text: string, symbol: string, near?: number) =>
  textSymbolLocator.locate(text, symbol, near)

describe('定义形优先', () => {
  it.each([
    ['TS function', 'const x = 1\n\nexport function parseToken(s: string) {}\n', 'parseToken', 3],
    ['TS class', '// 注\nexport class RefTagCodec {}\n', 'RefTagCodec', 2],
    ['TS const', 'import a from "b"\nconst REF_PATTERN = /x/\n', 'REF_PATTERN', 2],
    ['TS interface', '\ninterface RefTag {\n  type: string\n}\n', 'RefTag', 2],
    ['TS type', 'type Wire = "tag" | "token"\n', 'Wire', 1],
    ['Python def', 'import os\n\n\ndef parse_tag(src):\n    pass\n', 'parse_tag', 4],
    ['Python class', 'class RefTag:\n    pass\n', 'RefTag', 1],
    ['Go func', 'package main\n\nfunc ParseTag(s string) {}\n', 'ParseTag', 3],
    ['Rust fn', 'pub fn parse_tag(s: &str) {}\n', 'parse_tag', 1],
    ['Rust struct', '#[derive(Debug)]\nstruct RefTag {}\n', 'RefTag', 2],
    ['enum', 'export enum Wire { Tag, Token }\n', 'Wire', 1],
  ])('%s', (_name, text, symbol, line) => {
    expect(locate(text, symbol)).toBe(line)
  })

  it('调用在前、定义在后 —— 答的是**定义**那一行', () => {
    const text = 'parseToken(a)\nparseToken(b)\nfunction parseToken(s) {}\n'
    expect(locate(text, 'parseToken')).toBe(3)
  })

  /**
   * 定义那一轮赢过 `nearLine`:一处调用永远不比它的定义更像「我指的是这个符号」。
   * 这里提示行贴着第 2 行那处调用,答的仍是第 4 行那个定义。
   */
  it('定义那一轮压过 nearLine', () => {
    const text = 'a\nparseToken(b)\n\nfunction parseToken(s) {}\n'
    expect(locate(text, 'parseToken', 2)).toBe(4)
  })
})

describe('非定义形的三种写法', () => {
  it('`名(` —— 方法', () => {
    expect(locate('class A {\n  render(props) {}\n}\n', 'render')).toBe(2)
  })

  it('`名 =` —— 赋值形(箭头函数)', () => {
    expect(locate('let x\nparseToken = (s) => s\n', 'parseToken')).toBe(2)
  })

  it('`名 :=` —— Go 的短声明', () => {
    expect(locate('x := 1\ntag := parse()\n', 'tag')).toBe(2)
  })

  it('`名:` —— 对象字面量的一格', () => {
    expect(locate('const spec = {\n  toRef: (t) => t,\n}\n', 'toRef')).toBe(2)
  })

  it('`==` / `=>` / `>=` 不是赋值', () => {
    // 三行都只是「提到」这个名字 —— 没有定义形,于是落到整词首现那一轮(第 1 行)。
    expect(locate('if (tag == null) {}\nif (tag >= 1) {}\ntag => tag\n', 'tag')).toBe(1)
  })
})

describe('兜底与取最近', () => {
  it('没有任何定义形 → 整词首现', () => {
    expect(locate('a\n\n看 parseToken 一眼\n再看 parseToken\n', 'parseToken')).toBe(3)
  })

  it('多处定义 + nearLine → 取离它最近的那一处', () => {
    const text = [
      'function handle(a) {}', // 1
      '',
      '',
      '',
      'function handle(b) {}', // 5
      '',
      '',
      '',
      'function handle(c) {}', // 9
    ].join('\n')
    expect(locate(text, 'handle', 6)).toBe(5)
    expect(locate(text, 'handle', 8)).toBe(9)
    expect(locate(text, 'handle')).toBe(1)
  })

  it('找不到 = null(不猜、不报错)', () => {
    expect(locate('const a = 1\n', 'parseToken')).toBeNull()
    expect(locate('', 'x')).toBeNull()
    expect(locate('x', '')).toBeNull()
  })

  it('整词:`parseToken` 不被 `parseTokenList` 钓走', () => {
    expect(locate('const parseTokenList = []\nfunction parseToken() {}\n', 'parseToken')).toBe(2)
  })
})

describe('正则元字符:符号名是数据,不是模式', () => {
  it('`$store`', () => {
    // `\b` 的字集里没有 `$`,所以边界断言是手写的两条负向前瞻/后顾。
    expect(locate('let a\nconst $store = create()\n', '$store')).toBe(2)
  })

  it('`operator+`', () => {
    expect(locate('class V {\n  operator+(o) {}\n}\n', 'operator+')).toBe(2)
  })

  it('`a.b` 这种带点的名字不当成通配', () => {
    expect(locate('const axb = 1\nconst a.b = 2\n', 'a.b')).toBe(2)
  })

  it('`[x]` 这种带方括号的名字不当成字符组', () => {
    expect(locate('foo\nconst [x] = arr\n', '[x]')).toBe(2)
  })
})
