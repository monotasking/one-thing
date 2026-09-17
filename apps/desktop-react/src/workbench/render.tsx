import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { ErrorBoundary } from '../components/ErrorBoundary'
import {
  DEFAULT_PANEL_VISIBILITY,
  PanelVisibilityContext,
  usePanelVisibility,
} from '../content/visibility'
import { contentKindOf, refId } from './kinds'
import type { ContentRef } from './kinds'
import type { PanelVisibility } from '../content/visibility'

/**
 * **一个 ref 的唯一出口**(W1;它是 `content/index.tsx` 那只 `renderContent` 的
 * 种类版,分家的判据、memo 的理由、错误边界的落点三条逐字继承)。
 *
 * 错误边界包在这一层而不是每种内容自己包 —— 一格炸了只塌它自己(树里的、
 * 架子里的、浮窗里的都一样),外壳和别的格照常活着。边界的 `where` 就是
 * `refId`:错误卡上显示的、崩溃日志里记的,与查表用的是同一个字符串。
 *
 * ── memo 的 key 是 `refId`,memo 不许省(08-30 真机 CDP 画像钉的)──────────
 * 宿主(叶 / 架子层 / 浮窗)每重渲染一次都会重新调这只函数。若在那里现造
 * Provider / 边界 / 内容的元素,元素引用每次都是新的,React 就把那棵子树整棵
 * 重渲 —— 会话总览那 439 张卡重造一遍 JSX,dev 下 ~300ms,正是「切 tab 卡」的
 * 主项。这里把内容树 `useMemo` 在 `[id]` 上:宿主再怎么重渲染、可见性再怎么翻,
 * 子树元素引用不变,React 直接短路。
 *
 * **可见性的翻转仍然到得了内容**:它走 context,由最里面那一格 `KindBody`
 * 消费 —— 「翻转只到达真正消费 `usePanelVisibility` 的叶子」这句话在这里逐字成立。
 */
export function renderRef(
  ref: ContentRef | null,
  visibility: PanelVisibility = DEFAULT_PANEL_VISIBILITY,
): ReactNode {
  if (!ref) return null
  /*
   * 认不得的种类 = 什么都不画。存量档案里的那些由 `tree.sanitize` 在入口就剔掉了,
   * 走到这儿还认不得的只可能是热更中途的一帧 —— 那一帧画一个错误卡比空白更糟。
   */
  if (!contentKindOf(ref.kind)) return null
  return (
    <RefInstance
      key={refId(ref)}
      refKind={ref.kind}
      refKey={ref.key}
      visible={visibility.visible}
      interactive={visibility.interactive}
      headerInStrip={visibility.headerInStrip === true}
    />
  )
}

/**
 * 一份内容实例 = 「稳定的内容树」×「宿主随时在改的可见性声明」,两者在这里分家。
 * 可见性以两个布尔量进 props(不收对象):宿主侧无需为引用稳定操心。
 */
function RefInstance({
  refKind,
  refKey,
  visible,
  interactive,
  headerInStrip,
}: {
  refKind: string
  refKey: string
  visible: boolean
  interactive: boolean
  headerInStrip: boolean
}) {
  const visibility = useMemo<PanelVisibility>(() => ({ visible, interactive, headerInStrip }), [visible, interactive, headerInStrip])
  const id = `${refKind}:${refKey}`
  // 可见性挂在**边界外面**:错误卡也是这一份实例的一部分,后台那一份的错误卡
  // 同样不该抢键盘。边界在里面,所以「重试」重挂的仍然只有内容自己。
  const tree = useMemo(
    () => (
      <ErrorBoundary where={id}>
        <KindBody refKind={refKind} refKey={refKey} />
      </ErrorBoundary>
    ),
    [id, refKind, refKey],
  )
  return <PanelVisibilityContext.Provider value={visibility}>{tree}</PanelVisibilityContext.Provider>
}

/**
 * 真正调那张表的那一格。它**消费 context**,所以可见性翻转只重渲它 ——
 * 上面那棵 memo 住的元素树一动不动。
 */
function KindBody({ refKind, refKey }: { refKind: string; refKey: string }) {
  const visibility = usePanelVisibility()
  const kind = contentKindOf(refKind)
  if (!kind) return null
  return <>{kind.render({ kind: refKind, key: refKey }, visibility)}</>
}
