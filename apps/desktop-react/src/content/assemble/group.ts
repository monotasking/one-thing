import type { AnchoredNode } from './anchor'
import type { ProjectedToolCall } from '../model/segments'

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
 * ── 检索段(research)本批不做 ────────────────────────────────────────
 * `web_search` / `web_open` 族的识别是 P4(§9),本批**当普通组处理** —— 它们照样
 * 归进 tool-group,只是没有四件套那身衣服。`GroupedNode` 里 `research` 那一格留着
 * 是为了 P4 接进来时上下游的类型不用动,今天这里不产。
 *
 * 组内的同名聚合(「read ×3」)**不在这一步**:那是呈现的事(③ present),它要先
 * 有 presenter 算出来的行。这一步只回答「哪几次调用是一组」。
 */

export type GroupedNode =
  | AnchoredNode
  | { node: 'tool-group'; calls: ProjectedToolCall[] }
  | { node: 'research'; calls: ProjectedToolCall[] }

export function groupNodes(nodes: readonly AnchoredNode[]): GroupedNode[] {
  const out: GroupedNode[] = []
  let run: ProjectedToolCall[] = []

  const flush = () => {
    if (run.length === 0) return
    // 一次调用不成组:一个人做了一件事,说「执行了 1 步」比直接把那件事摆出来
    // 更远 —— 计数句是给「多到看不过来」用的。
    if (run.length === 1) out.push({ node: 'tool', call: run[0] })
    else out.push({ node: 'tool-group', calls: run })
    run = []
  }

  for (const node of nodes) {
    if (node.node === 'tool') {
      run.push(node.call)
      continue
    }
    flush()
    out.push(node)
  }
  flush()

  return out
}
