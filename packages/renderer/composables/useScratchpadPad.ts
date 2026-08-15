import { computed, onUnmounted, watch } from 'vue'
import { useScratchpadStore, type ScratchpadRecord } from '@/stores/scratchpad'

export interface UseScratchpadPadOptions {
  /**
   * 这一刻宿主是不是真的在展示草稿纸。
   *
   * **形态说明(2026-08-14 二次改版)**:草稿纸不再有自己的浮卡壳,它是
   * Todo 窗的一种**模式**(`components/chat/todo-panel-mode.ts`)。所以"开没开"
   * 不再是一位每会话记忆的状态,而就是"当前模式是不是草稿纸" —— 由宿主传进来,
   * 这里不再自己记账(那份账连同浮卡一起退役了)。
   */
  active?: () => boolean
}

/**
 * 草稿纸的那一面 —— 宿主只接线,判断和生命周期住在这里。
 *
 * 两条纪律照旧:
 * 1. 只有真的在场时才装载:模式一关(或会话不明),不打 IPC、不占内存。
 * 2. 切会话 / 卸载前把欠的 flush 结掉:纸是文件,不是内存草稿,离开时没落盘
 *    就是真丢了。
 */
export function useScratchpadPad(
  sessionId: () => string | undefined,
  options: UseScratchpadPadOptions = {},
) {
  const store = useScratchpadStore()

  const currentId = computed(() => sessionId() || undefined)
  const isActive = computed(() => (options.active?.() ?? true) && Boolean(currentId.value))

  const record = computed<ScratchpadRecord | null>(() => store.getRecord(currentId.value))
  const content = computed(() => record.value?.content ?? '')
  const filePath = computed(() => record.value?.filePath ?? '')
  /** 纸所在的目录:相对引用以它为基准(粘贴落盘时用的是同一个基准)。 */
  const documentDir = computed(() => {
    const path = filePath.value
    if (!path) return ''
    const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    return index > 0 ? path.slice(0, index) : ''
  })
  const charCount = computed(() => content.value.length)
  const isDirty = computed(() => record.value?.dirty === true)

  /** 已读末尾在当前文档里的位置;null = 还没有任何一版被消费过。 */
  const consumedOffset = computed(() => store.consumedOffset(currentId.value))
  const hasUnreadTail = computed(() => {
    const offset = consumedOffset.value
    if (offset === null) return content.value.trim().length > 0
    return content.value.slice(offset).trim().length > 0
  })

  function setContent(next: string) {
    const id = currentId.value
    if (!id) return
    store.setContent(id, next)
  }

  /** 水位之后没被读过的那一段(手动发送的缺省载荷)。 */
  function pendingText(): string {
    return store.pendingText(currentId.value)
  }

  watch(
    () => [currentId.value, isActive.value] as const,
    ([nextId, active], previous) => {
      const previousId = previous?.[0]
      if (previousId && previousId !== nextId) void store.flushNow(previousId)
      if (active && nextId) void store.load(nextId)
    },
    { immediate: true },
  )

  onUnmounted(() => {
    void store.flushNow(currentId.value)
  })

  return {
    store,
    sessionId: currentId,
    isActive,
    record,
    content,
    filePath,
    documentDir,
    charCount,
    isDirty,
    consumedOffset,
    hasUnreadTail,
    setContent,
    pendingText,
  }
}
