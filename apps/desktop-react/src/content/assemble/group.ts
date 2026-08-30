import type { AnchoredNode } from './anchor'
import type { ProjectedToolCall } from '../model/segments'
import { isWebCall } from '../tools/web-family'

/**
 * 管线第 ② 步:**归组**(§2 ②)。
 *
 * 把「相邻、中间没有别的节点打断」的工具调用折成一组(B2 的执行清单),单发保持
 * 一张卡(A1)。
 *
 * ── 判据是**数据性质**,与后端形状无关 ────────────────────────────────
 * 这一步只看节点序列:谁挨着谁。它不问「这台 core 有没有 research 引擎」、不问
 * 调用是同一轮还是跨轮 —— 屏幕上「这几件事是连着做的」这个事实,就是它们在序列上
 * 相邻。正文一插进来(锚点归位之后这是常态:模型说一句、做几件事、再说一句),
 * 那就是两组,因为人读到的确实是两段。
 *
 * ── 检索段(research)——— P4 起这一步认它 ─────────────────────────────
 * web 族(`tools/web-family.ts` 的明表)连着来的一串折成 **research 段**,交给
 * 四件套渲染(§5.3);别的工具照旧折成 tool-group。判据仍然只看序列:
 *
 *  · **族内混序算一段**:`search → open → open → search` 是一次检索,不是四件事。
 *    人读到的是「它上网找了一圈」,中间先搜后开还是先开后搜不构成分界。
 *  · **非 web 工具打断**:中间插一次 `read`,那是两段检索夹着一次读文件 ——
 *    把它们并成一段等于说那次读文件也是检索的一部分。text / 思考同理(与 P2 一致)。
 *  · **单发也成段**:一次 `web_search` 就是一段检索。这一条与 tool-group 的
 *    「单发不成组」**故意相反**,因为两者的收起行说的不是同一句话:tool-group 收起
 *    说的是「执行了 N 步」(计数句,一步时不如直接摆出那件事),检索段收起说的是
 *    「检索 · N 个来源」(**来源清单**,一次搜索照样能带回六条来源)。检索段的价值
 *    是那份清单,与调用次数无关。
 *
 * 组内的同名聚合(「read ×3」)**不在这一步**:那是呈现的事(③ present),它要先
 * 有 presenter 算出来的行。这一步只回答「哪几次调用是一组」。
 */

export type GroupedNode =
  | AnchoredNode
  | { node: 'tool-group'; calls: ProjectedToolCall[] }
  | { node: 'research'; calls: ProjectedToolCall[] }

/** 一串连续调用的族属。族一换就断段 —— 两个族不混进同一个段。 */
type RunKind = 'web' | 'other'

export function groupNodes(nodes: readonly AnchoredNode[]): GroupedNode[] {
  const out: GroupedNode[] = []
  let run: ProjectedToolCall[] = []
  let kind: RunKind = 'other'

  const flush = () => {
    if (run.length === 0) return
    if (kind === 'web') out.push({ node: 'research', calls: run })
    // 一次调用不成组:一个人做了一件事,说「执行了 1 步」比直接把那件事摆出来
    // 更远 —— 计数句是给「多到看不过来」用的。(检索段不适用,见文件头。)
    else if (run.length === 1) out.push({ node: 'tool', call: run[0] })
    else out.push({ node: 'tool-group', calls: run })
    run = []
  }

  for (const node of nodes) {
    if (node.node === 'tool') {
      const next: RunKind = isWebCall(node.call) ? 'web' : 'other'
      if (run.length > 0 && next !== kind) flush()
      kind = next
      run.push(node.call)
      continue
    }
    flush()
    out.push(node)
  }
  flush()

  return out
}
