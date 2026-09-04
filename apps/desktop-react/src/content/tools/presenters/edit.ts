import type { BlockModel } from '../../model/blocks'
import type { ProjectedToolCall } from '../../model/segments'
import type { ToolPresenter } from '../presenter'
import { parseUnifiedDiff } from '../../blocks/kinds/diff/parse'
import { baseToolRow, partialArgString } from '../row'
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
 * ── P2 留账在 P3 结清:detail 是 `diff` 一等块了 ────────────────────────
 * P2 时 detail 落的是 `code(lang:'diff')`,留账写着「两个产地必须同批换」。P3 两边
 * 同时换了:这里,和 markdown 的 ```diff 围栏(`markdown/fence.ts`)。同一段 diff
 * 在正文里和在抽屉里因此是**同一个组件** —— 那正是「一张注册表,两个产地」这句话
 * 要保住的东西。
 *
 * ── 统计仍然取 `changes`,不取解析出来的那份 ────────────────────────────
 * 解析器顺手数出了一份 ±统计(它要数才能分类每一行),但这里**优先用引擎给的**:
 * 行上那个「+12 −3」和抽屉檐上那个必须是同一个数,而行只能拿到 `changes`。
 * 两处各自算会分叉 —— 引擎眼里的一次改动和逐行数加减号,在有二进制/换行差异时
 * 本来就不一定相等。引擎没给才退到解析出来的那份(总比空着强)。
 *
 * ── 留账:没有 `changes.diff` 的那些仍是 `code` ────────────────────────
 * `write` 整份写下去、以及老账本里的调用,结局里根本没有统一 diff 文本 ——
 * 那不是画法问题,是**数据形状缺口**:没有 diff 就没有 hunk,编一个出来等于在
 * UI 层伪造一次比对。这一格要补得从引擎那边补(让 write 也写 changes.diff),
 * 不在这里补。在那之前它按文件内容显示,语言按扩展名推。
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

  /**
   * 参数流中的形:**文件名逐字长出来**(与 read 同判)。
   *
   * 只说文件名不说改动内容:`oldText` / `newText` 半截摆在行上既读不出意思、
   * 又会把这一行撑成一段代码。「它在改哪个文件」是这一刻唯一说得准的事。
   */
  partial: (call) => {
    const path = partialArgString(call, 'path', 'filePath', 'file_path')
    return path ? { icon: 'Pencil', name: basename(path), title: path } : { icon: 'Pencil' }
  },

  detail: (call) => {
    const path = filePath(call)
    const changes = toolChanges(call)
    const blocks: BlockModel[] = []

    if (changes?.diff) {
      const parsed = parseUnifiedDiff(changes.diff)
      if (parsed) {
        const file = path ?? parsed.file
        blocks.push({
          kind: 'diff',
          ...parsed,
          ...(file ? { file } : {}),
          stat: {
            add: changes.additions ?? parsed.stat.add,
            del: changes.deletions ?? parsed.stat.del,
          },
        })
        return blocks
      }
      // 解析不动(引擎给了个我们看不出结构的方言)→ 原文按 diff 语言的代码块摆出来。
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
