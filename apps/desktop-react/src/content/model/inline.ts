/*
 * `ImageRef` 的定义处是 blocks.ts(那里是它的第一个消费者,也是 P2 加 blob 一员时
 * 唯一要动的地方)—— 两个文件因此互相 `import type`,而 `import type` 在编译后整句
 * 消失,运行时没有环。
 */
import type { ImageRef } from './blocks'

/**
 * 行内词汇 —— 富文本里**一行之内**的东西(§1)。
 *
 * 为什么它自成一层:块(blocks.ts)说的是「一段是什么」,行内说的是「一段里那些
 * 字各是什么」。两者的产地不同(块由围栏 / 结构决定,行内由字符流决定),消费也
 * 不同(块进注册表查渲染器,行内由块自己的渲染器逐个画),混成一张表会让
 * 「加一个新块」和「加一种新强调」互相牵动。
 *
 * `citation`(检索引用角标)从第一天就在这张表里,而不是等 P4 再补:引用是**行内
 * 词汇的一员**,不是正文画完之后的后处理。少了这一格,P4 就只能在 DOM 上打补丁。
 *
 * ── 留账:citation 至今**没有产地**(P4,2026-08-30 勘察) ─────────────────
 * 真 store 全量扫过一遍:449 个会话,98 个带 web 调用,其中 62 条「既有检索调用、
 * 又有正文」的 assistant 消息里 ——
 *   · 带 `[s1.1]` / `[s1-r1]` 之类引用标记的:**0 条**;
 *   · 正文里出现某条来源 URL 的:5 条,而且是模型顺手写的普通 markdown 链接
 *     (「Issue [#51828](https://…)」那种),不是一套引用约定。
 * 工具结果里也没有任何 citation 结构:`metadata` 只说「搜到了什么」,不说
 * 「正文哪一句用了哪一条」。
 *
 * 所以 P4 **不画正文角标**:把那 5 条普通链接改画成上角标丸,是把模型写的一个
 * 带标题的链接换成一个数字 —— 既造了一个不存在的引用关系,又弄丢了它本来说的话。
 * 同理,检索清单里定稿画的「引用 N」小丸也一并不画(那个 N 只能编)。
 *
 * 缺的是**两者之一**,补上任意一个这一格就能通电,且改动只在 markdown 步布点:
 *   1. 模型输出约定 —— 提示词要求回答里用 `[sN-rM]` 引用检索结果(工具已经在
 *      输出正文里按 `[s1.1]` 编号了,约定的一半已经在);或
 *   2. 引擎结构化 citation —— 账本上多一格「这一段正文引了哪几条来源」。
 */

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'emphasis'; strong: boolean; children: InlineNode[] }
  /**
   * GFM 删除线(`~~字~~`)。
   *
   * 为什么它不塞进 `emphasis` 的一个布尔位:强调说的是「这几个字更重要」,删除线说的是
   * 「这几个字**不算数了**」—— 两件事的语义相反,合成一个节点会让「加粗的删除线」
   * (GFM 允许嵌套)没处放,也会让复制/朗读这类消费者分不出该怎么对待它。
   */
  | { type: 'strike'; children: InlineNode[] }
  | { type: 'link'; href: string; children: InlineNode[] }
  /**
   * 夹在字里的图(正本 §1 / §4)。
   *
   * 它与块那一档 `{ kind: 'image' }` 是**同一件东西的两个位置**,不是两种图:
   * 独占一段的是物件,夹在句子中间的是一个词。共用 `ImageRef` 正是为了让 P2 的
   * 账本图片一次接通两处。
   *
   * 画法是一颗芯片而不是一张小图 —— 理由在 `blocks/inline/InlineImage.tsx`:
   * 段落是 `pre-wrap` 的一段字,行内塞一件会长高的物件会把行律破掉。
   */
  | { type: 'image'; ref: ImageRef; alt: string; title?: string }
  /** 检索来源角标:`sourceId` 指向 research 段那份来源清单里的一条。 */
  | { type: 'citation'; sourceId: string; index: number }

/** 只取文字 —— 复制、成果词摘要、可读性断言都用它,不各写一遍递归。 */
export function inlineText(nodes: readonly InlineNode[]): string {
  let out = ''
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'code':
        out += node.text
        break
      case 'emphasis':
      case 'strike':
      case 'link':
        out += inlineText(node.children)
        break
      case 'image':
        // 与 GitHub 同:复制一段带图的正文,得到的是图的替代文字 —— 那正是 alt
        // 这一格存在的意义(「图没了的时候这里本该是什么」)。
        out += node.alt
        break
      case 'citation':
        // 角标是**呈现**,不是正文的字:复制正文时它不该跟着走。
        break
    }
  }
  return out
}
