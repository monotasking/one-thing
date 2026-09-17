/**
 * 文档里一行「收起了一段」的提示行(待办 B 形 U4)。`EditableDoc` 只负责把它画在 `at` 那一行
 * 的前面、按下时调 `onToggle`;收起了什么、这一行说什么,都由持有文档的一层算好交进来 ——
 * 编辑器不认识「已完成」也不认识「小节」。
 */
export interface FoldRow {
  /** 行的身份(React key 与测试取件口)。 */
  readonly key: string
  /** 画在起始行为 `at` 的那个单元前面;比最后一个单元还靠后 = 画在文档末尾。 */
  readonly at: number
  /** 屏幕上那句话(已经过 i18n)。 */
  readonly label: string
  /** 展开着(▾)还是收着(▸)。 */
  readonly open: boolean
  /** 缩进档(0–3),与列表项同一套;小节提示行跟着标题走 0。 */
  readonly depth?: number
  readonly onToggle: () => void
}
