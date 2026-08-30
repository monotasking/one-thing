import { ToastHost, pushToast } from '@onething/desktop-react'

// Toast 栈:pushToast 是唯一入口,ToastHost 是渲染宿主(fixed 定位的栈)。
// lifeMs: null = 驻留(error 的命运);预览里全部驻留保证截图稳定。
pushToast({ level: 'success', title: 'Reconnected', body: '3 updates caught up', lifeMs: null })
pushToast({ level: 'warn', title: 'Running on a stale catalog', lifeMs: null })
pushToast({ level: 'error', title: 'Could not reach the model host', lifeMs: null })

export const Stack = () => (
  <ToastHost closeLabel="Close" moreText={(count: number) => `+${count} earlier`} />
)
