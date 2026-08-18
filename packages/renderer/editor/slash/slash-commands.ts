/**
 * 斜杠菜单的**一份**清单与过滤规则。
 *
 * 两个引擎(自研 PM 升级档 / Tiptap 档)共用这一份数据和键盘交互,各自只接
 * `apply` 那一步——菜单里有哪些块、怎么搜、怎么排,不该有两种答案。
 *
 * id 刻意取 `MarkdownCommand` 的子集:PM 档拿到 id 可以直接喂
 * `applyNoteCommand`,不必在中间再翻一张映射表。
 */
import type { MarkdownCommand } from '../markdown-document'

export type SlashCommandId = Extract<
  MarkdownCommand,
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'bullet-list'
  | 'ordered-list'
  | 'task-list'
  | 'blockquote'
  | 'code-block'
  | 'table'
  | 'horizontal-rule'
  | 'image'
>

export interface SlashCommandItem {
  id: SlashCommandId
  label: string
  /** 右侧的一行淡字:说这个块长什么样,不是重复标题。 */
  hint: string
  /** 搜索词。中英各来一套——用户可能打 `bt`,也可能打「无序」。 */
  keywords: string[]
}

export const SLASH_COMMANDS: SlashCommandItem[] = [
  { id: 'heading-1', label: '标题 1', hint: '大标题', keywords: ['h1', 'heading', 'title', '标题', 'biaoti'] },
  { id: 'heading-2', label: '标题 2', hint: '中标题', keywords: ['h2', 'heading', '标题', 'biaoti'] },
  { id: 'heading-3', label: '标题 3', hint: '小标题', keywords: ['h3', 'heading', '标题', 'biaoti'] },
  { id: 'bullet-list', label: '无序列表', hint: '· 一条条列', keywords: ['ul', 'bullet', 'list', '无序', '列表', 'liebiao'] },
  { id: 'ordered-list', label: '有序列表', hint: '1. 带编号', keywords: ['ol', 'ordered', 'number', 'list', '有序', '列表', 'liebiao'] },
  { id: 'task-list', label: '待办', hint: '☐ 可勾选', keywords: ['todo', 'task', 'check', 'box', '待办', '勾选', 'daiban'] },
  { id: 'blockquote', label: '引用', hint: '│ 竖线引一段', keywords: ['quote', 'blockquote', '引用', 'yinyong'] },
  { id: 'code-block', label: '代码块', hint: '``` 等宽', keywords: ['code', 'pre', 'fence', '代码', 'daima'] },
  { id: 'table', label: '表格', hint: '3×2 带表头', keywords: ['table', 'grid', 'sheet', '表格', 'biaoge'] },
  { id: 'horizontal-rule', label: '分隔线', hint: '——— 断一段', keywords: ['hr', 'divider', 'rule', 'line', '分隔', 'fenge'] },
  { id: 'image', label: '图片', hint: '插一张图', keywords: ['image', 'img', 'picture', 'photo', '图片', 'tupian'] },
]

function haystack(item: SlashCommandItem): string[] {
  return [item.label, item.id, ...item.keywords].map(entry => entry.toLowerCase())
}

/**
 * 过滤 + 排序。
 *
 * 前缀命中排在包含命中前面——打 `h` 时「标题 1/2/3」应该在最上面,而不是被
 * 某个词里恰好含 h 的条目顶掉。同一档内保持清单里的声明顺序(稳定排序)。
 */
export function filterSlashCommands(query: string): SlashCommandItem[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...SLASH_COMMANDS]
  const scored: { item: SlashCommandItem, rank: number }[] = []
  for (const item of SLASH_COMMANDS) {
    const fields = haystack(item)
    if (fields.some(field => field.startsWith(needle))) {
      scored.push({ item, rank: 0 })
      continue
    }
    if (fields.some(field => field.includes(needle))) scored.push({ item, rank: 1 })
  }
  return scored.sort((a, b) => a.rank - b.rank).map(entry => entry.item)
}

/**
 * 光标前那一段 `/query`——菜单开着时用它决定过滤词与何时该关。
 *
 * 判据:`/` 必须贴在行首或空白之后(`a/b` 里的斜杠不是命令),`/` 之后不许再
 * 出现空白(打出空格 = 用户在写正文,菜单该退场)。返回 null = 不该开菜单。
 */
export function slashQueryBefore(textBeforeCursor: string): string | null {
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(textBeforeCursor)
  return match ? match[1] : null
}
