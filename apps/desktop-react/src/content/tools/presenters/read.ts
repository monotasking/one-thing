import type { ToolPresenter } from '../presenter'
import { baseToolRow, partialArgString } from '../row'
import { argString, basename, detailNumber, langFromPath, toolOutputText } from '../result'

/**
 * `read` 的展示(§5.1 表第一行)。
 *
 * 行 = **文件名**(basename;全路径进 title,悬停才看)+ 成果词「N 行」。
 * 为什么行上放 basename 而不是全路径:一行放不下一条真实的绝对路径,截断之后
 * 剩下的往往正好是**目录**那一半 —— 那时这一行说的是「读了某个目录里的某个东西」,
 * 比不说还差。全路径没有丢,它在 title 上。
 *
 * 成果词只在**读得到行数**时才有:`lineCount` 是 read 自己写的 metadata。
 * 拿不到就空 —— 现数一遍输出的换行是另一个数(截断之后那一份),不是它说的那个。
 */
export const readPresenter: ToolPresenter = {
  match: (call) => (call.toolName || call.toolId) === 'read',

  row: (call) => {
    const path = argString(call, 'path', 'filePath', 'file_path')
    const lines = detailNumber(call, 'lineCount')
    return baseToolRow(call, {
      icon: 'FileText',
      ...(path ? { name: basename(path), title: path } : {}),
      // 失败时 baseToolRow 已经摆了后端那句原话,不许被成果词盖掉。
      ...(lines !== undefined && call.status === 'completed'
        ? { outcome: { key: 'chat.tool.lines', vars: { n: lines } } as const }
        : {}),
    })
  },

  /**
   * 参数流中的形:**文件名逐字长出来**。
   *
   * 与 `row` 同一条切法(行上 basename、全路径进 title),所以参数收齐那一帧
   * 只是那截字停止生长,行的形一个像素都不换。路径还没长到有 `/` 的时候
   * `basename` 就是它自己 —— 那也是事实。
   */
  partial: (call) => {
    const path = partialArgString(call, 'path', 'filePath', 'file_path')
    return path ? { icon: 'FileText', name: basename(path), title: path } : { icon: 'FileText' }
  },

  detail: (call) => {
    const source = toolOutputText(call)
    if (source === undefined) return []
    const path = argString(call, 'path', 'filePath', 'file_path')
    return [
      {
        kind: 'code',
        lang: langFromPath(path),
        source,
        // 檐的「文件名位」—— markdown 围栏那个产地填不出来的那一格,这里填得出。
        // 同一个组件、同一条檐(铁律 1)。
        ...(path ? { file: path } : {}),
        closed: true,
      },
    ]
  },
}
