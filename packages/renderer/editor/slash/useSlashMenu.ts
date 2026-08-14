/**
 * 斜杠菜单的**状态机与键盘**——两个引擎共用的那一半。
 *
 * 编辑器永远不失焦:菜单只是一块浮层,上下键/回车/Esc 全在编辑器的 keydown 里
 * 判,判完了才告诉调用方"这一下我吃了"(返回 true → 调用方 preventDefault)。
 * 让浮层自己抢焦点是同类组件最常见的错——IME 会在焦点跳走的一瞬间把未上屏的
 * 拼音吞掉。
 *
 * 引擎侧只需要接三件事:光标位置(`openAt` 的点)、光标前的文本(`sync`)、
 * 和最终的 `apply`。
 */
import { computed, ref } from 'vue'
import {
  filterSlashCommands,
  slashQueryBefore,
  type SlashCommandId,
  type SlashCommandItem,
} from './slash-commands'

export interface SlashAnchorPoint {
  x: number
  y: number
}

export interface UseSlashMenuOptions {
  /** 选中一条:由引擎决定"删掉 `/query` 这几个字 + 插入这个块"怎么做。 */
  apply: (id: SlashCommandId, query: string) => void
}

export function useSlashMenu(options: UseSlashMenuOptions) {
  const open = ref(false)
  const query = ref('')
  const anchor = ref<SlashAnchorPoint>({ x: 0, y: 0 })
  const activeIndex = ref(0)

  const items = computed<SlashCommandItem[]>(() => filterSlashCommands(query.value))

  function close(): void {
    open.value = false
    query.value = ''
    activeIndex.value = 0
  }

  function openAt(point: SlashAnchorPoint, nextQuery = ''): void {
    anchor.value = point
    query.value = nextQuery
    activeIndex.value = 0
    open.value = true
  }

  /**
   * 每次文档/选区变动后调一次:传光标前的文本和当前光标屏幕坐标。
   *
   * 三种结局——没有 `/` 触发词就关掉;有触发词但过滤后一条都不剩也关掉
   * (让用户继续打字,而不是盯着一块空浮层);否则跟着光标走。
   */
  function sync(textBeforeCursor: string, point: SlashAnchorPoint): void {
    const next = slashQueryBefore(textBeforeCursor)
    if (next === null) {
      if (open.value) close()
      return
    }
    anchor.value = point
    if (query.value !== next) {
      query.value = next
      activeIndex.value = 0
    }
    if (items.value.length === 0) {
      close()
      return
    }
    open.value = true
  }

  function move(delta: number): void {
    const total = items.value.length
    if (total === 0) return
    activeIndex.value = (activeIndex.value + delta + total) % total
  }

  function commit(index = activeIndex.value): void {
    const item = items.value[index]
    if (!item) return
    const usedQuery = query.value
    close()
    options.apply(item.id, usedQuery)
  }

  /** 返回 true = 这一下已经被菜单吃掉,调用方该 preventDefault。 */
  function handleKeydown(event: KeyboardEvent): boolean {
    if (!open.value) return false
    // IME 组字期间的方向键/回车属于候选框,不属于菜单——`isComposing` 是唯一
    // 可靠的判据(keyCode 229 只在部分平台出现)。
    if (event.isComposing) return false
    if (event.key === 'ArrowDown') {
      move(1)
      return true
    }
    if (event.key === 'ArrowUp') {
      move(-1)
      return true
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      commit()
      return true
    }
    if (event.key === 'Escape') {
      close()
      return true
    }
    return false
  }

  return {
    open,
    query,
    anchor,
    activeIndex,
    items,
    openAt,
    sync,
    close,
    move,
    commit,
    handleKeydown,
  }
}
