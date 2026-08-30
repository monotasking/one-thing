import { ConfirmHost, useConfirmHub } from '@onething/desktop-react'

// useConfirm 的渲染宿主:壳的根上挂一次,await confirm({...}) 才有地方画。
// hub 是单槽的 —— 模块顶层预置一条待答问题,确认框就静态开着(promise 留着不结)。
void useConfirmHub.getState().ask({
  title: 'Remove “Design tokens” workspace?',
  description: 'Its 4 open sessions stay in history, but the workspace layout is dropped.',
  confirmLabel: 'Remove',
  cancelLabel: 'Keep it',
})

export const RemoveWorkspace = () => <ConfirmHost />
