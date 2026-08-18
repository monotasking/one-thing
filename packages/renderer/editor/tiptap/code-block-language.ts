/**
 * 代码块右上角的语言角标。
 *
 * 语言这件事**文档里本来就有**(codeBlock 的 `language` 属性,从 ```` ```ts ```` 解析
 * 出来、也照原样写回去),缺的只是让 CSS 看得见它:`pre` 的属性由 StarterKit 的
 * `renderHTML` 定,那上面没有 language。
 *
 * 于是这里走**节点装饰**而不是去改扩展的 `renderHTML`:改后者要先把 StarterKit 的
 * codeBlock 关掉再装一份自己的(等于把一个官方扩展叉出去养),而装饰只是往同一个
 * `pre` 上多挂一个属性,扩展照旧是官方那个。角标本身是 `::after`,不进文档、不占
 * 选区、复制不出来 —— 它是读数,不是内容。
 *
 * 无语言时**不挂属性**(而不是挂个空串):CSS 的 `pre[data-language]` 就此天然不命中,
 * 不必再写一条"空了别画"的规则。
 */
import type { EditorState } from 'prosemirror-state'
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

export const CODE_BLOCK_LANGUAGE_ATTR = 'data-language'

export const codeBlockLanguageKey = new PluginKey<DecorationSet>('noteCodeBlockLanguage')

/** 由 state 直接算出装饰集。摘出来是为了能单独测「文档 → 角标属性」这一步。 */
export function buildCodeBlockLanguageDecorations(state: EditorState): DecorationSet {
  const decorations: Decoration[] = []
  state.doc.descendants((node, pos) => {
    // 代码块里没有块级后代,进去也是白进;别的块要继续往下找(引用/列表里也会有)。
    if (node.type.name !== 'codeBlock') return true
    const language = String(node.attrs.language ?? '').trim()
    if (language) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, { [CODE_BLOCK_LANGUAGE_ATTR]: language }),
      )
    }
    return false
  })
  return DecorationSet.create(state.doc, decorations)
}

export function codeBlockLanguagePlugin(): Plugin<DecorationSet> {
  return new Plugin<DecorationSet>({
    key: codeBlockLanguageKey,
    state: {
      init: (_config, state) => buildCodeBlockLanguageDecorations(state),
      // 只有文档变了角标才可能变 —— 光标移动、水位线那条空事务都不必重算。
      apply: (tr, value, _oldState, newState) => (
        tr.docChanged ? buildCodeBlockLanguageDecorations(newState) : value
      ),
    },
    props: {
      decorations: state => codeBlockLanguageKey.getState(state) ?? DecorationSet.empty,
    },
  })
}
