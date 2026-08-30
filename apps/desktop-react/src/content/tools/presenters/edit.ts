import type { BlockModel } from '../../model/blocks'
import type { ProjectedToolCall } from '../../model/segments'
import type { ToolPresenter } from '../presenter'
import { baseToolRow } from '../row'
import {
  argString,
  basename,
  langFromPath,
  toolChanges,
  toolOutputText,
} from '../result'

/**
 * `edit` / `write` 的展示(§5.1 表第二行)。
 *
 * 两个工具一个 presenter:它们说的是同一件事(这个文件被改成了什么),差别只在
 * 「改了一段」还是「整份写下去」。拆成两个文件会让那份**逐字相同**的 detail 逻辑
 * 有两个产地,而它们必须同时改(下一批 diff 块进来时)。
 *
 * 行 = 文件名 + 「+a −d」。统计取 `call.changes`(引擎写的结构化 diff,投影把它
 * 放在调用自己身上)—— 拿不到就不显示,不去数 diff 文本里的加减号:那是在替
 * 引擎重算一遍,两份算法迟早会分叉。
 *
 * ── 留账:detail 本批以 `code` 呈现,不是 `diff` 块 ────────────────────
 * `diff` 是一等块(§1 要点 2),但它的**渲染器**是 P3(§9)。本批把 detail 落成
 * `code(lang:'diff')`:内容一模一样(引擎给的就是统一 diff 文本),换的只是画法。
 * P3 上 diff 块时,改的就是下面这一个 `kind` —— 而且**两个产地同批换**
 * (markdown 的 ```diff 围栏在 `markdown/to-blocks.ts`,工具这一份在这里),
 * 否则同一段 diff 在正文里和在抽屉里会长得不一样。
 */
export const editPresenter: ToolPresenter = {
  match: (call) => EDIT_TOOLS.has(call.toolName || call.toolId),

  row: (call) => {
    const path = filePath(call)
    const changes = toolChanges(call)
    const add = changes?.additions
    const del = changes?.deletions
    return baseToolRow(call, {
      icon: 'Pencil',
      ...(path ? { name: basename(path), title: path } : {}),
      ...(add !== undefined && del !== undefined && call.status === 'completed'
        ? { outcome: { key: 'chat.tool.diffStat', vars: { add, del } } as const }
        : {}),
    })
  },

  detail: (call) => {
    const path = filePath(call)
    const changes = toolChanges(call)
    const blocks: BlockModel[] = []

    if (changes?.diff) {
      blocks.push({ kind: 'code', lang: 'diff', source: changes.diff, ...(path ? { file: path } : {}), closed: true })
      return blocks
    }

    // 没有结构化 diff 的那些(write 整份写下去、老账本):把工具自己说的那段
    // 正文原样摆出来。语言按扩展名推 —— 它此刻是这个文件的内容,不是一段 diff。
    const source = toolOutputText(call)
    if (source !== undefined) {
      blocks.push({
        kind: 'code',
        lang: langFromPath(path),
        source,
        ...(path ? { file: path } : {}),
        closed: true,
      })
    }
    return blocks
  },
}

const EDIT_TOOLS = new Set(['edit', 'write'])

/** 路径:参数优先,退到 changes 里那一份(参数名写错时它是唯一的真相)。 */
function filePath(call: ProjectedToolCall): string | undefined {
  return argString(call, 'path', 'filePath', 'file_path') ?? toolChanges(call)?.filePath
}
