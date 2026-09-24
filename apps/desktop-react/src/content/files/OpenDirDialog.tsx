import { useEffect, useState } from 'react'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Input } from '../../ui/Input'
import { useT } from '../../i18n'
import { notifyDirOpenFailed, openDirectoryPanel } from '../dir-open'
import { useOpenDirDialog } from './open-dir-hub'

/**
 * **「打开目录…」**(W6-a,设计 `workbench-tabs-2026-09.md` §3)。
 *
 * 一扇最小的对话框:一个路径输入框 + 「打开」/「取消」。为什么今天是输入框而不是
 * 系统对话框、以及那一格宿主口欠在哪儿,判词整段写在 `./open-dir-hub.ts` 上。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:**常挂**(与 `WorkspacePalette` 同一条:它挂在外壳上,不挂在菜单里
 *    —— 菜单一关就卸载的东西里挂不住一扇要收字的窗);`open` 翻 false 时
 *    `ui/Dialog` 自己不画任何 DOM。每次开出来把上一次的字清掉(它是一次输入,
 *    不是一份偏好)。
 * ② UI 生命状态:只有一格 —— **空**(还没输入,「打开」禁灰)。没有载入 / 错误态:
 *    这一下不问后端,路径存不存在由开出来的那块面自己说(它有 denied / missing /
 *    failed 三句人话)。
 * ③ UI 交互状态:输入框随 `ui/Input`;两颗钮随 `ui/Button`;Esc / 点遮罩关闭随
 *    `ui/Dialog`(它自己那条逃生口的硬规矩)。
 */
export function OpenDirDialog() {
  const t = useT()
  const open = useOpenDirDialog((st) => st.open)
  const setOpen = useOpenDirDialog((st) => st.setOpen)
  const [path, setPath] = useState('')

  // 每次开出来从空的开始 —— 它是一次输入,不是一份偏好。
  useEffect(() => {
    if (open) setPath('')
  }, [open])

  const onPick = useOpenDirDialog((st) => st.onPick)

  const submit = () => {
    const next = path.trim()
    if (!next) return
    // 先读再关:`setOpen(false)` 会把这一次的动作清掉(判词在 hub 上)。
    const pick = onPick
    setOpen(false)
    if (pick) {
      pick(next)
      return
    }
    // 缺省那条 = 开一份目录面板。手敲的 `~/notes` 在这一步展开;展不开就说一句
    // (窗已经关了,这句话没有别的地方落)。
    void openDirectoryPanel(next).then((ok) => {
      if (!ok) notifyDirOpenFailed(next)
    })
  }

  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      title={t('files.openDirTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" disabled={path.trim().length === 0} onClick={submit}>
            {t('files.openDirConfirm')}
          </Button>
        </>
      }
    >
      {/*
        **焦点不靠 `autoFocus`**:`ui/Dialog` 开出来就把焦点送进落点(它的
        `activateOnMount`),而落点是对话框面板本身 —— 从那儿按一下 Tab 就到这格
        输入框。`autoFocus` 是 jsx-a11y 的禁令(它会在别人还没读到标题时把焦点
        抢走),而这台壳的焦点归属整体归响应链(`src/focus/`),不归控件自己。
      */}
      <Input
        value={path}
        onValueChange={setPath}
        placeholder={t('files.openDirPlaceholder')}
        aria-label={t('files.openDirTitle')}
        data-testid="open-dir-input"
        onKeyDown={(e) => {
          // ↵ = 打开(与「打开」那颗钮同一条路)。Esc 归响应链(`ui/Dialog` 认领)。
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          }
        }}
      />
    </Dialog>
  )
}
