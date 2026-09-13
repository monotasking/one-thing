import type { TFn } from '../../i18n'
import type { ViewerFile } from '../../data/viewer-source'
import s from './FileViewer.module.css'

/**
 * **身:轻编辑**(定稿确认案;09-02 批 9b 从 `FileViewer` 拆出,一行未改)。
 *
 * **等宽、无高亮、无补全的一块可写文本** —— 它诚实地定位成「改配置、改几行」,
 * 不是一台编辑器。高亮编辑将来若真需要再议,那时才轮到「要不要一台真编辑器」
 * 这个问题。
 *
 * 行号在编辑态**不画**:一块 textarea 里的行号要么跟着内容重排(要一台影子渲染
 * 层),要么就是错的 —— 画一列错的数字比不画糟得多。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *  ① 生命周期:调用方按 `key={file.path}` 挂它 —— **换文件就是换一块新的
 *     文本域**(光标位、撤销栈、滚动位都不该从上一个文件继承)。它自己没有
 *     订阅 / 计时器 / 模块级副作用,不需要 HMR dispose。
 *  ② UI 生命状态:只有 ready 一档。载入中根本走不到这里(编辑态的前提是
 *     文件已经在手上),错误由脚上那条状态栏说。
 *  ③ UI 交互状态:rest / focus(焦点环走全局 `:focus-visible`)/ 输入中。
 *     没有 disabled 档 —— 存盘在飞时**不锁文本域**:锁了等于把用户刚打的字
 *     扣在半路,而存盘失败时他连改回来都做不到。
 */
export interface ViewerEditAreaProps {
  file: ViewerFile
  draft: string
  onDraft: (text: string) => void
  t: TFn
}

export function ViewerEditArea({ file, draft, onDraft, t }: ViewerEditAreaProps) {
  return (
    <textarea
      /* 编辑面拿焦点只为让键盘落进来,插入符就是指示,不画环。 */
      data-focus-ring="none"
      className={s.editor}
      data-testid="viewer-editor"
      value={draft}
      spellCheck={false}
      aria-label={t('viewer.editing', { name: file.name })}
      onChange={(e) => onDraft(e.target.value)}
    />
  )
}
