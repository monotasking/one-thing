import { t } from '../../i18n'
import { registerReferenceKind } from '../registry'
import s from '../../content/user-message.module.css'
import type { ReferenceKind } from '../kind'

/**
 * **提示词引用** `{{prompt:<id>}}`。引擎把它折成 `contentParts` 里的一格
 * `prompt-ref`(标题 + 正文),气泡里画一枚药丸把标题说出来。
 *
 * ── 它只有「认出」与「呈现」两格,**没有 `open`**(留账,不是疏漏)────────────
 * 提示词库在 React 壳里还没有一块能打开的面(没有 `prompts-source`、没有查看器
 * 落点),所以今天只画一枚药丸 —— **画一个点了没反应的按钮比不画更坏**
 * (「屏幕上不该出现一个按下去没反应的东西」)。哪天那块面有了,要加的是这只
 * 文件里的一格 `open` 与 `clickable: true`,别处一个字不动。
 *
 * 也没有 `draft`:壳里没有任何一处**落**一枚提示词引用(它只从引擎那边来)。
 */

export const promptReferenceKind: ReferenceKind<never, { kind: 'promptRef'; title: string }> = {
  id: 'prompt',

  parse: {
    part: {
      type: 'prompt-ref',
      toRef: (part) => ({ kind: 'promptRef', title: part.title ?? '' }),
    },
  },

  /*
   * 标题缺席时兜底一句人话。它是**文案**,所以走字典 —— 而这里用的是非 hook 的
   * `t()`:`render` 是一只纯函数(数据,不是 JSX),不在 React 的调用栈上。
   * 切语言时整条消息会重渲染(`useT` 在 `UserMessageBody` 那一层),所以这一句
   * 跟着换,不会卡在旧语言上。
   */
  render: (ref) => ({
    className: s.prompt,
    label: `[${ref.title || t('chat.ref.promptUntitled')}]`,
    clickable: false,
  }),
}

registerReferenceKind(promptReferenceKind, import.meta.hot)
