import { useMemo } from 'react'
import { useT } from '../../i18n'
import { DrawerStatus } from '../components/DrawerStatus'
import type { ComposerStrip, StripBarModel } from '../strip'
import { useComposerStoreOf } from '../store'
import { truncate } from '../transitions'

/** 状态条上那句话最多念这么多字,剩下的收进抽屉 —— 条是一眼,抽屉才是全文。 */
const HEADLINE_MAX = 24

/**
 * 执行状态:有执行就常驻在面板顶上,点它开合状态抽屉。
 * 执行完了它**不消失**,只是从转圈换成绿点 —— 「刚才那件事做完了」也是一种状态。
 * (从 `StatusBar` 搬来,行为逐字不变;条的皮归 `StripBar`。)
 */
function useStatusBar(sessionId: string): StripBarModel | null {
  const t = useT()
  const status = useComposerStoreOf(sessionId, (st) => st.status)
  return useMemo(() => {
    if (!status) return null
    const step = status.steps[status.stepIdx]
    const text = status.running
      ? t('status.running', {
          name: status.name,
          step: step ? truncate(`${step.label} ${step.detail}`, HEADLINE_MAX) : '',
        })
      : t('status.done', { name: status.name, count: status.steps.length })
    return {
      indicator: { kind: status.running ? 'spinner' : 'done' },
      text,
      label: t('status.toggle'),
    }
  }, [status, t])
}

function StatusDrawer({ sessionId }: { sessionId: string }) {
  const status = useComposerStoreOf(sessionId, (st) => st.status)
  return status ? <DrawerStatus status={status} /> : null
}

export const statusStrip: ComposerStrip = {
  id: 'status',
  order: 0,
  useBar: useStatusBar,
  Drawer: StatusDrawer,
}
