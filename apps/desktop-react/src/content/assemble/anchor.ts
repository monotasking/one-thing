import type { ProjectedMessage } from '../../data/chat-fold'
import type { BlobRef } from '../model/segments'
import type { ProjectedToolCall } from '../tools/presenter'

/**
 * 管线第 ① 步:**锚点**(§2)。
 *
 * 折叠器的输出不带排布 —— 它给的是「正文是什么、推理是什么、这条消息上挂了哪些
 * 工具调用」,**没说工具卡该插在正文的哪一处**。这一步把那件事定下来,产出一条
 * 从上到下的节点序列;后面四步只在这条序列上做事。
 *
 * ── P0 是直通,而且这是**裁量,不是省略** ────────────────────────────────
 * 真正的锚点算法是 core 的 `synthesizeCoreToolAnchors`(按 turnIndex 把工具锚点
 * 织进 contentParts),renderer(Vue)与主进程已经在用它,React 壳是第三个消费者 ——
 * 三处必须逐字同算,所以**不能在这里发明第二份**。接它是 P2 的事。
 *
 * P0 直通的形状,就是今天屏幕上那一份:顶部推理 → 正文 → 工具卡依次挂在末尾。
 * 正文取 `message.content` 而**不是** `contentParts`:那一份是活尾巴与打包行共同
 * 维护的单一文本(chat-fold.ts 的 `appendTail` 两头都写),按 parts 排会把今天的
 * 一个 `<p>` 拆成多段 —— 那是可感知变化,P0 不许。
 *
 * 签名按**最终形**写(进 `ProjectedMessage`,出节点序列),所以 P2 接真算法时
 * 只换这一个函数体,上下游一行不动。
 * ──────────────────────────────────────────────────────────────────────
 */

export type AnchoredNode =
  | { node: 'text'; text: string }
  | { node: 'reasoning'; text: string; placement: 'top' | 'inline' }
  | { node: 'image'; blob: BlobRef }
  | { node: 'tool'; call: ProjectedToolCall }

export function anchorMessage(message: ProjectedMessage): AnchoredNode[] {
  const nodes: AnchoredNode[] = []

  // 顶部推理落在 `message.reasoning`(不是 part)—— 折叠器与活尾巴同一个落点。
  if (message.reasoning) {
    nodes.push({ node: 'reasoning', text: message.reasoning, placement: 'top' })
  }
  if (message.content) {
    nodes.push({ node: 'text', text: message.content })
  }
  for (const call of message.toolCalls ?? []) {
    nodes.push({ node: 'tool', call })
  }

  return nodes
}
