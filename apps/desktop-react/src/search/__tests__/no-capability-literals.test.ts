import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * **壳的骨架里不许出现能力 id 的字面量**(检索重建 S4a;设计
 * `docs/design/search-index-2026-09.md` §4.0 那张枚举点清账表 + 仓根 CLAUDE.md
 * 「加功能不许改骨架」)。
 *
 * 这是 §4.0 硬指标在壳这一侧的执法者。它守的一句话:**加一种能搜的东西,壳里
 * 允许动的只有「它自己的渲染模块 + 一行注册」**;面板 / tab 条 / 分组 / 分页 /
 * 状态行一个字都不该改 —— 而它们改不改的先行指标,就是它们认不认识能力的名字。
 *
 * ── 为什么是 grep 而不是别的 ────────────────────────────────────────────
 * 「不许出现某个字面量」是一条**源码层面**的规矩,类型系统表达不了它(`string`
 * 就是 `string`)。壳里既有的同类闸(`ui:consume` 的三条零基线硬闸)也是这么做的:
 * 读源文本、按行判、命中即红。这一条跟着那个体例,只是它的范围小到一个目录,
 * 所以直接进单测而不是再起一个脚本 —— 一条闸的价值在于它**会被跑到**。
 *
 * ── 三处豁免,每一处都有理由 ────────────────────────────────────────────
 *  1. `sources.ts` —— 「壳对这三类另有自己的产地」这个**事实本身**。三个 id 写在
 *     那里一次,别处一律读它。加一类能搜的东西不用碰它(新能力走通用路)。
 *  2. `targets/<kind>.tsx` —— 一种目标形一个渲染模块,§4.0 允许动的那两处之一。
 *     它们写的是 `target.kind` 不是能力 id,但同一条法管着(骨架不认识、模块自己
 *     认识),所以一起豁免、一起由「加一类 = 一个文件 + 一行注册」约束。
 *  3. `__tests__/**` —— 用例当然要点名具体的能力,那正是它们在验的东西。
 *
 * `'all'` 不在名单上也不违例:它**不是一个能力**(注册表里没有它,后端也从不
 * 返回它),是 tab 条这个控件自己的一格 —— 理由写在 `../capabilities.ts` 头上。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const searchDir = path.resolve(here, '..')

/**
 * 今天注册着的六个能力 id。**这张表是给闸用的,不是给产品用的** ——
 * 产品那一侧一个 id 都不认识,而闸要认识才判得出违例。
 *
 * 它会不会过期?会 —— 新注册一个能力,这里不加它就漏判。那是可接受的:
 * 漏判的后果是「新能力的 id 混进了骨架而没被抓到」,而**已有的六个仍然被钉着**,
 * 骨架不会因为加了一类就整个失守。要根治得让闸去问真注册表,而那要起一台 core。
 */
const CAPABILITY_IDS = ['chats', 'messages', 'files', 'daily', 'prompts', 'actions']

/** 豁免的相对路径前缀(见文件头三条理由)。 */
const ALLOWED = ['sources.ts', 'targets/', '__tests__/']

/** 用例文件当然要点名具体的能力 —— 那正是它们在验的东西(第 3 条豁免的另一半)。 */
const TEST_FILE = /\.test\.tsx?$/

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * 注释里提到某个能力的名字是**说明**,不是枚举点 —— 这道闸判的是代码。
 * 所以逐行剥掉行注释与块注释之后再看(与「读样式表源文本的门先剥注释」同一条判例:
 * 病历文本会让断言自红)。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('壳的骨架里不出现能力 id 的字面量(§4.0)', () => {
  const files = walk(searchDir)
    .map(full => ({ full, rel: path.relative(searchDir, full).split(path.sep).join('/') }))
    .filter(({ rel }) => !ALLOWED.some(prefix => rel.startsWith(prefix)) && !TEST_FILE.test(rel))

  it('有文件可判 —— 目录空了或者全被豁免了,这道闸就是绿得没有意义', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const { full, rel } of files) {
    it(`${rel} 里一个能力 id 都没有`, () => {
      const code = stripComments(fs.readFileSync(full, 'utf-8'))
      const hits: string[] = []
      for (const id of CAPABILITY_IDS) {
        // 只判**字符串字面量**:`'chats'` / `"chats"` 是枚举点,`chatsSomething`
        // 这种标识符不是(它是一个名字,不是一个值)。
        if (new RegExp(`['"\`]${id}['"\`]`).test(code)) hits.push(id)
      }
      expect(hits, `${rel} 认识了它不该认识的能力:${hits.join(' / ')}`).toEqual([])
    })
  }
})
