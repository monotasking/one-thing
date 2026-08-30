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
 */

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'emphasis'; strong: boolean; children: InlineNode[] }
  | { type: 'link'; href: string; children: InlineNode[] }
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
      case 'link':
        out += inlineText(node.children)
        break
      case 'citation':
        // 角标是**呈现**,不是正文的字:复制正文时它不该跟着走。
        break
    }
  }
  return out
}
