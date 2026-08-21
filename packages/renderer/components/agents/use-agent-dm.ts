/**
 * 「和 TA 说话」的唯一实现:幂等建私聊房 → 刷新会话表 → 交回房间 id。
 *
 * 从 AgentsPanelContent 抬出来给管理页与右栏空间页共用。导航本身留给宿主
 * (管理页开完要合上自己,右栏开完原地不动)—— 这里只负责把房间弄出来,
 * 以及把「建房被拒」变成一句看得见的话:退休 / service / web 端没有 rooms
 * 都会走到这条,静默无反应是最坏的结果。
 */
import { ref } from 'vue'
import { collabApi } from '@/platform/collab-client'
import { useSessionsStore } from '@/stores/sessions'

export function useAgentDmOpener() {
  const openingDm = ref(false)
  const dmError = ref('')

  async function openDmRoom(agentId: string): Promise<string> {
    if (!agentId || openingDm.value) return ''
    openingDm.value = true
    dmError.value = ''
    try {
      const response = await collabApi.dmRoomEnsure({ agentId: String(agentId) })
      if (!response?.success || !response.roomSessionId) {
        dmError.value = response?.error || '打不开私聊'
        return ''
      }
      // 这一处**留着**(架构收敛 C4 §3):`dmRoomEnsure` 幂等,但第一次调用
      // 是**新建**一间房,而 `session:collab-updated` 只改已知的行。调用方拿到 id
      // 之后马上就要导航过去,那一拍它必须已经在列表里。
      await useSessionsStore().loadSessions()
      return response.roomSessionId
    } catch (cause) {
      dmError.value = cause instanceof Error ? cause.message : String(cause)
      return ''
    } finally {
      openingDm.value = false
    }
  }

  return { openingDm, dmError, openDmRoom }
}
