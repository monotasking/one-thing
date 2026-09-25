import { useCallback } from 'react'
import { t } from '../../i18n'
import { useAsyncPending } from '../../data/kernel'
import { sessionCwdOf } from '../../data/files-source'
import { sessionMutation, useSessionsSource, workdirKey } from '../../data/sessions-source'
import { notify } from '../../services/notify'
import { requestDirectory } from './open-dir-hub'

/**
 * **给一条会话挑工作目录**:挑目录走全壳唯一那一口(`requestDirectory`:系统对话框优先,
 * 没有对话框的宿主退到路径输入窗),挑到了交给 `sessions-source.setWorkingDirectory`。
 *
 * 忙态只有一个产地:`sessionMutation` 的 `workdir:<sessionId>` 那一格(与文件面板的
 * 「绑定…」同一格,谁发起的那一发两边都看得见)。绑不上说一句 warn —— 这一口没有
 * 就地的输入行可以留错话(composer 上是一颗图标钮)。
 */
export function useBindWorkdir(sessionId: string) {
  const cwd = useSessionsSource((st) => sessionCwdOf(st.sessions, sessionId))
  const setWorkingDirectory = useSessionsSource((st) => st.setWorkingDirectory)
  // 读自 `sessionMutation` 的那一格,不是本地布尔。
  const pending = useAsyncPending(sessionMutation, workdirKey(sessionId))

  const pick = useCallback(() => {
    if (!sessionId || pending) return
    void requestDirectory(
      async (path) => {
        const outcome = await setWorkingDirectory(sessionId, path)
        if (outcome.ok) return
        notify({
          level: 'warn',
          source: 'composer.workdir',
          title: t('files.bindFailed'),
          body: outcome.error,
        })
      },
      { title: t('composer.workdirUnset'), defaultPath: cwd ?? undefined },
    )
  }, [sessionId, pending, cwd, setWorkingDirectory])

  return { cwd, pending, pick }
}
