import { AsyncButton } from '../../ui/AsyncButton'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import type { TFn } from '../../i18n'
import { viewerSaveMutation } from '../../data/viewer-source'
import s from './FileViewer.module.css'

/**
 * **关掉的时候有没存的改动就先问**(09-02 批 9b 从 `FileViewer` 拆出,一行未改)。
 *
 * 三条出路各是一颗钮,顺序就是它们的分量:取消(什么都不做)· 丢弃(承认
 * 改动没了)· 保存并关闭(主行动)。**没有第四条** —— 关掉的语义在
 * `open-target` 那一处编排(内容清掉 + 那块瓦收回 Dock),这里只负责问。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *  ① 生命周期:`open` 为假时 `ui/Dialog` 整棵不挂 —— 焦点陷阱、Esc 认领、
 *     点外关都随那件走(09-01 立法:浮层行为单产地 `ui/float`,业务面禁手写)。
 *     无订阅 / 计时器 / 模块级副作用 → 不需要 HMR dispose。
 *  ② UI 生命状态:只有 open / closed 两态。存盘失败时**不关**(下面那个
 *     `if (!outcome.ok) return`),错误由脚上那条状态栏说 —— 对话框不自己
 *     长一格错误行:同一件事两处说,迟早分叉。
 *  ③ UI 交互状态(逐格,律③):
 *     · 取消 / 丢弃 rest / hover / focus —— 同步动作,无 pending;
 *     · **保存并关闭** 另有 pending:`ui/AsyncButton` 按 `pendingKey`
 *       (`save:<path>`)读**写路**的逐格忙态,忙时禁用并换字「正在保存…」。
 *       它还白拿了那件的 150ms 防闪闸 —— 比 150ms 更快回来的那一发不该报告
 *       自己在忙(E 型闪的判例);`disabled` 仍然立刻生效:它挡的是连点,
 *       而连点就发生在头 150ms 里。
 *       这一颗**本来就是 `ui/Button`**,所以换 `ui/AsyncButton` 是零像素的
 *       (①类文字动作钮:它有自己的按钮形)。
 */
export interface ViewerCloseConfirmProps {
  t: TFn
  open: boolean
  /** 文件名(问句里那一格)。 */
  name: string
  /** 存盘那一格的键(`save:<path>`)。没开文件时缺席。 */
  saveKey: string | undefined
  onCancel: () => void
  /** 丢弃:改动不要了,直接关。 */
  onDiscard: () => void
  /** 存盘。返回结果 —— **只有成功才关**。 */
  onSave: () => Promise<{ ok: boolean }>
  /** 存成功之后真正的关。 */
  onSaved: () => void
}

export function ViewerCloseConfirm({
  t,
  open,
  name,
  saveKey,
  onCancel,
  onDiscard,
  onSave,
  onSaved,
}: ViewerCloseConfirmProps) {
  return (
    <Dialog open={open} onClose={onCancel} title={t('viewer.confirmTitle')}
      footer={
        <>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          <Button className={s.dangerBtn} onClick={onDiscard}>
            {t('viewer.discard')}
          </Button>
          <AsyncButton
            variant="primary"
            action={viewerSaveMutation}
            pendingKey={saveKey}
            pendingLabel={t('common.saving')}
            onClick={() => {
              void onSave().then((outcome) => {
                if (!outcome.ok) return
                onSaved()
              })
            }}
          >
            {t('viewer.saveAndClose')}
          </AsyncButton>
        </>
      }
    >
      <p className={s.confirmText}>{t('viewer.confirmBody', { name })}</p>
    </Dialog>
  )
}
