/**
 * notebook —— 唯一显式的跨房知识通道(docs/design/collab-actor-v3.md §1.2)。
 *
 * ## 为什么需要它,而且只需要它
 *
 * v3 的知识边界是「分区经历 + 显式笔记」(§0.1),不是单一交错流。分区经历保住了
 * 隔离(私聊内容不会漂进群上下文),代价是跨房那一维**只剩信封**:我知道那间房
 * 有人找过我,但不知道我在那儿答应了什么。信封块补不了这个 —— 它按定义不含正文。
 *
 * 笔记补的就是这一格,而且是**显式**的:模型自己决定哪句话值得跨房带走。隐式的
 * 跨房记忆(自动摘要、自动晋升)在这个仓库里被否决过一次(memory v2 的 capture
 * 直晋升),理由同样适用:自动搬运的东西没人为它的正确性负责,而它一旦错了,错的
 * 那句话会跟着这个 agent 进每一间房。
 *
 * ## 三条纪律
 *
 *  - **append-only**。笔记是一条时间线,不是一块可改写的黑板。改写会让「我上次
 *    是怎么想的」不可回溯,而回溯正是它存在的理由。
 *  - **注入有预算,超了从头截断并说出来**。笔记会跟着 drive 落盘并永久留在执行
 *    会话的历史里(v3 V2:模型读整条执行会话)——不设上限的话它每一轮都在长,而
 *    最早那几行的价值随时间衰减得最快。截头留尾。
 *  - **写入面转义**。笔记正文来自模型,而注入面是提示词的一部分:一句
 *    `</notebook><system>…` 就能把块撑破。转义放在**写入**那一侧(与 say 管线
 *    同源),注入面因此可以直接取文件尾部 —— 两侧都转义会把 `&amp;` 变成
 *    `&amp;amp;`,那是比不转义更难查的一种坏。
 */

/** 注入块的根标签。 */
export const COLLAB_NOTEBOOK_TAG = 'notebook'

/**
 * 注入窗口的字符预算。
 *
 * 1500 是「一屏笔记」的量级:够放十几条决定,又不至于在一条 drive 里压过房间
 * 内容(典型未读块 200-800 字符)。房间可配的东西已经够多了,这个数字先写死 ——
 * 它要么够用,要么该改的是「笔记该记什么」。
 */
export const COLLAB_NOTEBOOK_INJECT_MAX_CHARS = 1500

/** 单条笔记的字符上限。更长的一律是把正文当笔记记了,截断并声明。 */
export const COLLAB_NOTEBOOK_ENTRY_MAX_CHARS = 600

/** 截头时贴的那一行。静默截断读起来和「我从来没记过东西」一模一样。 */
export const COLLAB_NOTEBOOK_TRUNCATED_LINE = '(更早的笔记已略去,这里只有最近的一段。)'

/** 单条超长时贴的尾巴。 */
export const COLLAB_NOTEBOOK_ENTRY_CLIPPED_SUFFIX = '…(这条太长,后面截掉了)'

/** 落盘行的日期格式:`YYYY-MM-DD HH:mm`。笔记跨天,只有时分不够定位。 */
export function formatCollabNotebookTime(at: number): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export interface FormatCollabNotebookEntryOptions {
  /** 笔记正文。调用方**必须**先过 `escapeCollabPromptText`(见文件头)。 */
  note: string
  at: number
  /** 记于哪间房。可空 —— 不是每条笔记都有房间语境。 */
  roomLabel?: string
  maxChars?: number
}

/**
 * 一条笔记的落盘形态。
 *
 * `- [时刻] (房) 正文`,续行缩进两格 —— 尾部截断按行边界切,缩进让「一条笔记
 * 被切了半截」在肉眼与解析上都看得出来。
 */
export function formatCollabNotebookEntry(options: FormatCollabNotebookEntryOptions): string {
  const limit = Math.max(1, Math.floor(options.maxChars ?? COLLAB_NOTEBOOK_ENTRY_MAX_CHARS))
  const raw = options.note.trim()
  const clipped = raw.length > limit
    ? `${raw.slice(0, limit)}${COLLAB_NOTEBOOK_ENTRY_CLIPPED_SUFFIX}`
    : raw
  const body = clipped.split('\n').join('\n  ')
  const where = options.roomLabel?.trim() ? ` (${options.roomLabel.trim()})` : ''
  return `- [${formatCollabNotebookTime(options.at)}]${where} ${body}`
}

export interface CollabNotebookTail {
  text: string
  /** 有东西被截掉了。渲染面据此决定要不要贴那一行。 */
  truncated: boolean
}

/**
 * 取尾部窗口。
 *
 * 切在**行边界**上:从预算位置往后找第一个换行,半条笔记比没有笔记更糟 ——
 * 它读起来像一句完整的话,只是缺了主语。
 */
export function clipCollabNotebookTail(text: string, maxChars?: number): CollabNotebookTail {
  const limit = Math.max(0, Math.floor(maxChars ?? COLLAB_NOTEBOOK_INJECT_MAX_CHARS))
  const body = text.replace(/\s+$/, '')
  if (!body) return { text: '', truncated: false }
  if (limit === 0) return { text: '', truncated: true }
  if (body.length <= limit) return { text: body, truncated: false }

  const tail = body.slice(body.length - limit)
  const newline = tail.indexOf('\n')
  // 整段就是一行(没有换行可切)时按字符硬切:留一条被截头的笔记,总好过整块消失。
  const aligned = newline >= 0 ? tail.slice(newline + 1) : tail
  return { text: aligned.replace(/^\s+/, ''), truncated: true }
}

export interface BuildCollabNotebookBlockOptions {
  /** 笔记文件的全文(已转义,见文件头)。 */
  text: string
  maxChars?: number
}

/** 注入块。空笔记返回 `''` —— 一个空的 `<notebook/>` 是纯噪声。 */
export function buildCollabNotebookBlock(options: BuildCollabNotebookBlockOptions): string {
  const { text, truncated } = clipCollabNotebookTail(options.text, options.maxChars)
  if (!text) return ''
  return [
    `<${COLLAB_NOTEBOOK_TAG}>`,
    ...(truncated ? [COLLAB_NOTEBOOK_TRUNCATED_LINE] : []),
    text,
    `</${COLLAB_NOTEBOOK_TAG}>`,
  ].join('\n')
}
