import { computed, onUnmounted, watch } from 'vue'
import { useScratchpadStore, type ScratchpadRecord } from '@/stores/scratchpad'

export interface UseScratchpadPadOptions {
  /**
   * 这个会话允不允许草稿垫。messenger 形态传 false —— 房里的输入框不是工程台面,
   * 开关整个不该出现,而不是出现了点不动。
   */
  available?: () => boolean
}

/**
 * 悬浮草稿垫的那一面 —— 组件只接线,判断和生命周期住在这里。
 *
 * **形态说明(2026-08-14 改版)**:草稿纸不再是 composer 的"第二种模式",而是
 * 一张浮在聊天区之上、可拖可缩的垫子。所以这里只剩两个开关:
 *   · `isOpen` —— 垫子在不在场(每会话记忆,composer 的 NotebookPen 钮控制它)
 *   · 收起/展开 —— 垫子自己的事,住在每窗口的 `floating-pad-state.ts`
 *
 * 两条纪律照旧:
 * 1. `isOpen` 永远与 `available` 取交集 —— 形态一变(直聊 → 房),垫子立刻退场,
 *    而记忆里那一位不动(切回去还在)。
 * 2. 切会话 / 卸载前把欠的 flush 结掉:纸是文件,不是内存草稿,离开时没落盘
 *    就是真丢了。
 */
export function useScratchpadPad(
  sessionId: () => string | undefined,
  options: UseScratchpadPadOptions = {},
) {
  const store = useScratchpadStore()

  const currentId = computed(() => sessionId() || undefined)
  const available = computed(() => options.available?.() ?? true)
  const isOpen = computed(() => available.value && store.isPadOpen(currentId.value))

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

  function toggleOpen() {
    const id = currentId.value
    if (!id || !available.value) return
    store.togglePad(id)
  }

  function close() {
    const id = currentId.value
    if (!id) return
    store.setPadOpen(id, false)
  }

  /** 水位之后没被读过的那一段(手动发送的缺省载荷)。 */
  function pendingText(): string {
    return store.pendingText(currentId.value)
  }

  watch(
    () => [currentId.value, isOpen.value] as const,
    ([nextId, open], previous) => {
      const previousId = previous?.[0]
      if (previousId && previousId !== nextId) void store.flushNow(previousId)
      if (open && nextId) void store.load(nextId)
    },
    { immediate: true },
  )

  onUnmounted(() => {
    void store.flushNow(currentId.value)
  })

  return {
    store,
    sessionId: currentId,
    isOpen,
    available,
    record,
    content,
    filePath,
    documentDir,
    charCount,
    isDirty,
    consumedOffset,
    hasUnreadTail,
    setContent,
    toggleOpen,
    close,
    pendingText,
  }
}
