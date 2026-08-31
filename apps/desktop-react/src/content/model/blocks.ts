import type { InlineNode } from './inline'

/**
 * 块词汇 —— 富文本里的**物件单位**(§1)。
 *
 * 三条读法:
 *
 * 1. **模型是数据,不是组件**。这里一个 React 类型都没有,也没有一个函数指针:
 *    块可序列化、可深比、可单测。谁来画由注册表(blocks/registry.ts)按 `kind`
 *    查表决定 —— 同一个 `code` 块,来自 markdown 围栏还是来自 read 工具的结果,
 *    画出来是同一个组件。这是「一张注册表,两个产地」的落点。
 * 2. **`figure` 不枚举图种**:`figKind` 是二级注册表的键(§3.3)。今天只有
 *    mermaid,明天来 sequence / math / gantt 时这张表一行都不改。
 * 3. **`source-fallback` 是一切失败的归宿**:解析不出来、注册表不认识、渲染器
 *    抛错,统统落到它 —— 源码永远可见。这不是兜底的客气话,是全系统的失败语义,
 *    所以它是一等公民,和 `code` 平级。
 *
 * P0 只有 `paragraph` 与 `source-fallback` 有渲染器;其余变体的类型先立着 ——
 * 词汇是一次拍板的事,渲染器是逐期补的事,两件事不必同时发生。
 */

/** 结构化 diff 的一段。`edit`/`write` 工具的 changes 与 markdown 的 ```diff 围栏共用。 */
export interface DiffHunk {
  /** 原文起始行(1 基);拿不到结构时缺席。 */
  oldStart?: number
  newStart?: number
  /**
   * `@@ …… @@` 那一行的**原文**(P3 补)。
   *
   * 不由 oldStart/newStart 现合成:真实的 hunk 头后面常挂一段所属函数名
   * (`@@ -1,7 +1,9 @@ function foo()`),合成出来的那一行会把它吞掉。存原文是
   * 「解析不动的东西原样透传」这条纪律在结构化字段上的同一个答案。
   * 碎片 diff(没有 @@ 的那种)这一格缺席,渲染时就没有头行。
   */
  header?: string
  lines: DiffLine[]
}

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
}

export type BlockModel =
  | { kind: 'paragraph'; inline: InlineNode[] }
  | { kind: 'heading'; level: 1 | 2 | 3; inline: InlineNode[] }
  | { kind: 'list'; ordered: boolean; items: InlineNode[][] }
  | { kind: 'quote'; blocks: BlockModel[] }
  /** `closed:false` = 流式中还没闭合的围栏(§6 的流式契约靠它成立)。 */
  | { kind: 'code'; lang: string | null; source: string; file?: string; closed: boolean }
  | { kind: 'table'; caption?: string; head: InlineNode[][]; rows: InlineNode[][][] }
  | { kind: 'figure'; figKind: string; source: string; title?: string }
  /**
   * `source` 是那段**统一 diff 原文**(P3 补)。
   *
   * 结构(hunks / stat)是从它解析出来的**投影**,不是替代品:「查看源码」与降级
   * 都要拿到作者/引擎真正给的那几行(`blockSourceText` 认的就是这一格),而 hunks
   * 里被归成 ctx 的那些「解析不动的行」也因此有一份逐字对照。同 `code` 一样,
   * 一个块自己带着它的源码,失败语义才落得下来。
   */
  | { kind: 'diff'; file?: string; source: string; hunks: DiffHunk[]; stat: { add: number; del: number } }
  /**
   * `---` 分隔线(mdast `thematicBreak`,08-31 真机报障后补画法 —— 此前它落
   * source-fallback,一条横线被画成带「复制源码」的代码块)。零参数:它没有内容,
   * 只有存在;节奏量 `--pr-hr` 在 tokens.css 里早就备好,今天起有了消费者。
   */
  | { kind: 'divider' }
  /**
   * 一切失败的归宿。`reason` 是**机器口径的一个词**(`render-error` /
   * `unknown-kind:foo` / `tool-default`),不是界面文案 —— 它和错误边界的 `where`
   * 同一条判据:换一门语言它不该跟着变,所以它不进字典,原样以 mono 灰显示。
   */
  | { kind: 'source-fallback'; reason: string; source: string }

export type BlockKind = BlockModel['kind']

/** 注册表查不到时兜到的那个 kind —— 写成常量,免得三处各拼一遍字符串。 */
export const SOURCE_FALLBACK_KIND = 'source-fallback' satisfies BlockKind
