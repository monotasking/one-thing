import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { MessageKey } from '../i18n'
import type { Placement } from '../stage/types'

/**
 * 「用什么打开一个文件」—— 一条**偏好**,不是一个状态。
 *
 * 它跟着外壳既有的形态词汇走(`stage/types.ts` 的 Placement:dock / stage /
 * float / edge×4),再加上文件面自己那一档 `panel`(文件面板里那条分栏)。
 * 刻意**不发明第二套名字**:「钉到右边」这件事在壳里已经有名字了,这里再造一个
 * 近义词,两套词就得永远对表。
 *
 * ── F2:七档全接上了(09-01 报障「open 位置,调整后也没有生效」)────────────
 * F1 那批只有 `panel` 真生效,别的六档「记住但不假装」。那条诚实降级到此结清:
 * 查看器在 F2 变成了一块**普通的瓦**(`stage/items.ts` 的 VIEWER_ITEM_ID),
 * 于是「摆到主区域 / 浮窗 / 四条边」这六件事全都是壳里已经有的那一句
 * `openAs(id, placement)` —— 一行新的形态机代码都没有。
 *
 * 于是这张表现在只剩一个职责:**档 → 落点**的翻译,而且是唯一一份。
 * `panel` 是其中唯一没有 Placement 的一档(它不是「摆到某处」,而是「不摆出去,
 * 就住在文件面板那条分栏里」)—— 所以它翻出来是 null,不是拿 dock 顶。
 */
export type FileOpenMode =
  | 'panel'
  | 'stage'
  | 'edge-top'
  | 'edge-bottom'
  | 'edge-left'
  | 'edge-right'
  | 'float'

/** 菜单里的次序 = 这张表的次序。全仓唯一一份,菜单不许自己再排一次。 */
export const FILE_OPEN_MODES: readonly FileOpenMode[] = [
  'panel',
  'stage',
  'edge-top',
  'edge-bottom',
  'edge-left',
  'edge-right',
  'float',
]

/**
 * **今天真能兑现的那些**。菜单据此决定给哪些项画注脚 —— 判据在这里定一次,
 * 不散在渲染层的条件里。
 *
 * F2 起它等于全表:七档全接上了。这一格**不删**,理由是它是一条纪律的落点 ——
 * 将来再加一档(比如「在系统默认应用里打开」),没接上的那段日子里菜单仍然
 * 说得出实话,而不是又去渲染层里现写一个条件。
 */
export const WIRED_FILE_OPEN_MODES: readonly FileOpenMode[] = FILE_OPEN_MODES

export function isWiredFileOpenMode(mode: FileOpenMode): boolean {
  return WIRED_FILE_OPEN_MODES.includes(mode)
}

/**
 * 档 → 壳里的落点。**唯一一份翻译**(树行菜单与查看器檐上那颗钮共用它)。
 *
 * `panel` 回 null:它不是「摆到某处」,是「不摆出去」—— 拿 `{kind:'dock'}` 顶
 * 会读成「收进坞里」,而那是关掉,不是「在文件面板里就地看」。
 */
export function placementOfFileOpenMode(mode: FileOpenMode): Placement | null {
  switch (mode) {
    case 'panel':
      return null
    case 'stage':
      return { kind: 'stage' }
    case 'float':
      return { kind: 'float' }
    case 'edge-top':
      return { kind: 'edge', side: 'top' }
    case 'edge-bottom':
      return { kind: 'edge', side: 'bottom' }
    case 'edge-left':
      return { kind: 'edge', side: 'left' }
    case 'edge-right':
      return { kind: 'edge', side: 'right' }
  }
}

/** 每一档的名字是**界面文案**,所以这里只持有 key(同 StageItemSpec.titleKey 的判例)。 */
export const FILE_OPEN_MODE_LABELS: Record<FileOpenMode, MessageKey> = {
  panel: 'files.openIn.panel',
  stage: 'files.openIn.stage',
  'edge-top': 'files.openIn.edgeTop',
  'edge-bottom': 'files.openIn.edgeBottom',
  'edge-left': 'files.openIn.edgeLeft',
  'edge-right': 'files.openIn.edgeRight',
  float: 'files.openIn.float',
}

interface FileOpenModeStore {
  mode: FileOpenMode
  setMode: (mode: FileOpenMode) => void
}

export const useFileOpenMode = create<FileOpenModeStore>()(
  persist(
    (set) => ({
      mode: 'panel',
      setMode: (mode) => set({ mode }),
    }),
    {
      name: 'onething.files.openMode',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      // 存盘可能来自旧版本、也可能被人手改过:认不出的档一律落回 panel
      // (那是唯一一定兑现得了的一档)。同 reading/store 的 merge 钳制。
      merge: (persisted, current) => {
        const saved = (persisted as Partial<FileOpenModeStore> | undefined)?.mode
        return {
          ...current,
          mode: saved && FILE_OPEN_MODES.includes(saved) ? saved : 'panel',
        }
      },
      partialize: (s) => ({ mode: s.mode }),
    },
  ),
)
