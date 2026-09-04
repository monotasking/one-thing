import { registerTargetRenderer } from './registry'
import { fileExt, fileName } from '../transitions'
import type { SearchContinuation } from '../continuations'
import type { SearchRow } from '../types'

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

/** 这条路径的目录段。没有分隔符 = 它就在根上,答空串(那时范围片没有意义)。 */
function dirOf(filePath: string): string {
  const at = filePath.lastIndexOf('/')
  return at <= 0 ? '' : filePath.slice(0, at)
}

/**
 * 续搜两条(S4b,§4.6 那张场景表第三行「搜到一个文件 → 想知道**哪些对话改过 /
 * 讨论过它**」,以及结论 1 的「文件 → `dir`」)。
 *
 *  · **枢轴**「提到它的消息」= 换到消息那一档,种子词 = **文件名**(不是整条路径:
 *    人在对话里说的是 `model-registry.ts`,不是 `/repo/packages/…/model-registry.ts`)。
 *    §4.6 的真库读数说 10% 的用户消息提到一个文件路径,「上次让它改 X 是哪次」是
 *    高频问句 —— 这一条就是那句话的入口。
 *  · **范围片**「在此目录内搜」= 一格 `dir`。**S4b 修之后它按得动了**,而这个
 *    文件一个字没改:files 在自述里声明了 `dir`(扫描根),于是
 *    `continuationEnabled` 判它有效,面板照旧画成能按的。
 *    从「灰的」到「活的」全靠那一格自述 —— 那正是「片可不可用由能力自述答」
 *    这条规矩的正面用例(它当反面用例的那半年记在 git 里)。
 *    × 掉它**回到缺省的当前会话工作目录**,不是回到「无 dir」——
 *    理由(无 dir = 后端自己的根列表,那不是旧行为)在 `../filters.ts` 的
 *    `DIR_FACET` 上。
 */
function continuationsOf(row: SearchRow): SearchContinuation[] {
  const payload = payloadOf(row.target.payload)
  if (payload === undefined) return []
  const out: SearchContinuation[] = [{
    kind: 'pivot',
    labelKey: 'search.pivotFileMentions',
    capability: 'messages',
    query: fileName(payload.filePath),
  }]
  const dir = dirOf(payload.filePath)
  if (dir) {
    out.push({
      kind: 'scope',
      labelKey: 'search.continueInDir',
      chip: { key: 'dir', value: dir, label: dir },
    })
  }
  return out
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
  continuations: continuationsOf,
} as const satisfies Parameters<typeof registerTargetRenderer>[0]
