/**
 * 拖外壳分隔条期间把元素宽度冻结在起拖值 —— 重排昂贵内容的"拖拽中"护罩。
 *
 * 外壳层逐帧跟随实测只要几毫秒(2026-08-25 web 端 212 帧 p99=9ms),掉帧的
 * 大头是重消费者(CodeMirror remeasure、内嵌 Splitter 重排)对每帧宽度变化的
 * 全量响应。罩上它之后:拖拽中内容保持起拖排版,被面板边缘裁切(拖宽时短暂
 * 露白),松手解冻,一次 remeasure 成型。
 *
 * 用法:根元素挂 `:style="freezeStyle"`。宿主面板必须 `overflow: hidden`
 * (workbench 的 slide/panel 本来就是),否则拖窄时冻结内容会戳出去。
 */
import { computed, ref, watch, type ComputedRef, type Ref, type StyleValue } from 'vue'
import { shellResizing } from './useShellLayout'

export function useShellResizeFreeze(target: Ref<HTMLElement | null>): ComputedRef<StyleValue> {
  const frozenWidth = ref<number | null>(null)

  watch(shellResizing, resizing => {
    frozenWidth.value = resizing
      ? (target.value?.getBoundingClientRect().width ?? null)
      : null
  })

  return computed<StyleValue>(() =>
    frozenWidth.value === null ? undefined : { width: `${frozenWidth.value}px` },
  )
}
