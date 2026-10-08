import type { BlockModel } from '../../model/blocks'
import type { ProjectedToolCall } from '../../model/segments'
import type { ToolPresenter } from '../presenter'
import { baseToolRow, partialArgString } from '../row'
import { argString, basename, detailNumber, detailString, langFromPath, toolDetails, toolOutputText } from '../result'

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
    // 图片 / PDF / 二进制这几支的 metadata 写的是 `lineCount: 0, isBinary: true` ——
    // 那个 0 不是行数,是「没有行」;画成「0 行」是把占位当事实。
    const lines = toolDetails(call)?.isBinary === true ? undefined : detailNumber(call, 'lineCount')
    return baseToolRow(call, {
      icon: 'FileText',
      // 行上是 basename,全路径进 `title`;**路径形自述**(09-13)——
      // 悬停时画成「名字一行 + 目录一行」,家目录缩成 `~`。
      ...(path ? { name: basename(path), title: { path } } : {}),
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
    return path ? { icon: 'FileText', name: basename(path), title: { path } } : { icon: 'FileText' }
  },

  detail: (call) => {
    const image = readImageBlock(call)
    if (image) return [image]
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

/**
 * 读的是一张图时,详情就是**那张图**(与正文里的图片块同一个块),不是那句
 * 「This image was attached…」的说明文字。
 *
 * 地址的来源按「越贴近这次读到的字节越优先」:结局里还带着的 base64(活流那一份)
 * → 读的那条路径。账本里大结局只留引用、旧账本的附件字节被剥掉,那时就按路径取 ——
 * 那是**此刻**磁盘上的文件,与查看器、用户附件的路径兜底同一条。
 */
function readImageBlock(call: ProjectedToolCall): BlockModel | undefined {
  const attachment = imageAttachmentOf(call.result)
  const mimeType = attachment?.mimeType ?? detailString(call, 'mimeType')
  if (!attachment && !mimeType?.startsWith('image/')) return undefined
  const path = attachment?.path ?? detailString(call, 'path') ?? argString(call, 'path', 'filePath', 'file_path')
  const data = attachment?.data
  const url = data?.startsWith('data:') ? data
    : data && mimeType ? `data:${mimeType};base64,${data}`
    : path
  if (!url) return undefined
  return { kind: 'image', ref: { kind: 'url', url }, alt: path ? basename(path) : '' }
}

interface ImageAttachment {
  path?: string
  data?: string
  mimeType?: string
}

/** 工具那份 `{ attachments }` 或规范形 `{ content }` 里的第一张图。 */
function imageAttachmentOf(result: unknown): ImageAttachment | undefined {
  if (!isRecord(result)) return undefined
  const parts = [
    ...(Array.isArray(result.attachments) ? result.attachments : []),
    ...(Array.isArray(result.content) ? result.content : []),
  ]
  for (const part of parts) {
    if (!isRecord(part) || part.type !== 'image') continue
    const data = typeof part.content === 'string' ? part.content : typeof part.data === 'string' ? part.data : undefined
    return {
      ...(typeof part.path === 'string' && part.path ? { path: part.path } : {}),
      // 被脱敏成「[Image: … omitted]」的那一格不是字节。
      ...(data && !/[\s[\]]/.test(data.slice(0, 200)) ? { data } : {}),
      ...(typeof part.mimeType === 'string' ? { mimeType: part.mimeType } : {}),
    }
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
