import { registerTargetRenderer } from './registry'
import { fileExt } from '../transitions'

/**
 * `kind: 'file'` —— 一个文件(`runtime/src/search/capabilities/files.ts` 的
 * `FileTarget`)。
 *
 * 徽上的字是**数据不是文案**:从路径推出来的扩展名(`.ts` → `TS`),换语言不该变。
 * 没有扩展名就把整个名字大写 —— 不造「未知」这种文案(`fileExt` 的既有判据,
 * 这里只是调它,一个字没改)。
 *
 * 09-01 报障的那条判例跟着搬过来:徽列**不许按字符数写死宽度**,词表是数据
 * (扩展名 / 无扩展名的整个文件名都会进来),不是一张能枚举完的表 —— 修法是结构性的
 * (胶囊 hug 内容 + 内层弯腰),而那两层在壳里,不在这个文件里。
 */
export interface FileTargetPayload {
  filePath: string
  /**
   * 命中在**第几行**。缺席 = 落点就是这个文件本身 —— 今天的产地(按名字找文件)
   * 给不出行号。接上内容检索(rg --json / S8 的文件内容源)时那一格才有值,
   * 届时这里一个字不用改:这正是把它写成可选而不是删掉的理由。
   */
  line?: number
}

function payloadOf(payload: unknown): FileTargetPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { filePath, line } = payload as Partial<FileTargetPayload>
  if (typeof filePath !== 'string' || filePath.length === 0) return undefined
  return typeof line === 'number' ? { filePath, line } : { filePath }
}

export const fileTargetRenderer = {
  kind: 'file',
  badge(row) {
    const payload = payloadOf(row.target.payload)
    return { text: payload === undefined ? '' : fileExt(payload.filePath) }
  },
  activate(row, context) {
    const payload = payloadOf(row.target.payload)
    if (payload === undefined) return
    context.openFile(payload.filePath, payload.line)
  },
} as const satisfies Parameters<typeof registerTargetRenderer>[0]
