import { Button, Dialog } from '@onething/desktop-react'

// 受控模态框(portal 到 body,遮罩 + 居中面板)。footer 是一排兄弟按钮:
// 逃生口(取消 / Esc)永远在,主动作用 primary。这里静态开着以便截图。
export const DiscardDraft = () => (
  <Dialog
    open
    onClose={() => {}}
    title="Discard this draft?"
    footer={
      <>
        <Button onClick={() => {}}>Cancel</Button>
        <Button variant="primary" onClick={() => {}}>
          Discard
        </Button>
      </>
    }
  >
    The draft has unsaved edits from the last 12 minutes. This cannot be undone.
  </Dialog>
)
