import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { MessageKey } from '../i18n'
import type { RegionId } from '../workbench/regions'
import {
  foldFlatIntoDefaultSpace,
  spreadSpace,
  stashSpace,
  type PerSpaceSpec,
  type PerSpaceState,
} from '../workspace/per-space'
import { DEFAULT_SPACE_ID } from '../workspace/types'

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
 * F2 起它曾等于全表;**W1-a 退回两档**,那是一次可感知的退化,理由见下。
 * 这一格**不删**,理由是它是一条纪律的落点 —— 没接上的那段日子里菜单仍然
 * 说得出实话,而不是又去渲染层里现写一个条件。
 *
 * ── W1-a:七档退回两档(交付报告点名的临时退化)────────────────────────
 * 查看器从「一块瓦」降格为一种内容之后,「摆到哪儿」不再是 `openAs(id, placement)`
 * 那一句形态机调用,而是「把这个 ref 插进哪个**区域**的活动叶」。中央区那棵树
 * 在 W1-a 落地,架子与浮窗的树要等 W4(设计 §8 那张分期表)。所以这一批里
 * 只有 `panel`(文件面板那条分栏,不进树)与 `stage`(= 中央区)真接通;
 * 四条边与浮窗那五档在菜单里**禁灰 + 注脚**,选择器读到它们时回落中央区。
 */
export const WIRED_FILE_OPEN_MODES: readonly FileOpenMode[] = ['panel', 'stage']

export function isWiredFileOpenMode(mode: FileOpenMode): boolean {
  return WIRED_FILE_OPEN_MODES.includes(mode)
}

/**
 * 档 → **区域**(W1;从前是档 → `Placement`)。**唯一一份翻译**。
 *
 * `panel` 回 `'panel'` 而不是一个 RegionId:它不是「插进某个区域的树」,是
 * 「不进树,就住在文件面板那条分栏里」(设计 §2.1 明写保留)。拿 `'center'` 顶
 * 会读成「开在中央区」,而那是另一件事。
 *
 * `stage` 这一档的**值域与 i18n 键都没改**(它的文案本来就是「主区域 / Main stage」),
 * 改的只有它翻出来的东西:从「摆一块瓦上舞台」变成「插进中央区那棵树」——
 * 那正是设计 §2.1 把七档改名成「新标签开在哪」时说的那一档「中央区」。
 */
export function regionOfFileOpenMode(mode: FileOpenMode): RegionId | 'panel' {
  switch (mode) {
    case 'panel':
      return 'panel'
    case 'stage':
      return 'center'
    case 'float':
      return 'float:new'
    case 'edge-top':
      return 'edge:top'
    case 'edge-bottom':
      return 'edge:bottom'
    case 'edge-left':
      return 'edge:left'
    case 'edge-right':
      return 'edge:right'
  }
}

/**
 * 旧名留的一格别名。派工规格点名要 `placementOfFileOpenMode` 返回
 * `RegionId | 'panel'`,而这个名字在 W4 之后名不副实(它回的不是 Placement)。
 * 所以真名叫 `regionOfFileOpenMode`,这一行是给规格里那个名字留的门。
 * **留账:W4 收掉这一行。**
 */
export const placementOfFileOpenMode = regionOfFileOpenMode

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

interface FileOpenModeStore extends PerSpaceState<OpenModeFurniture> {
  mode: FileOpenMode
  setMode: (mode: FileOpenMode) => void
}

/** 跟着工作区走的那一格:「在哪儿打开文件」是这个空间里的摆法(T-W1)。 */
interface OpenModeFurniture {
  mode: FileOpenMode
}

export const OPEN_MODE_PER_SPACE: PerSpaceSpec<FileOpenModeStore, OpenModeFurniture> = {
  pick: (s) => ({ mode: s.mode }),
  factory: () => ({ mode: 'panel' }),
}

/** 认不出的档一律落回 panel(唯一一定兑现得了的一档)。账上每一格都过它。 */
function clampMode(value: unknown): FileOpenMode {
  return typeof value === 'string' && (FILE_OPEN_MODES as readonly string[]).includes(value)
    ? (value as FileOpenMode)
    : 'panel'
}

export const useFileOpenMode = create<FileOpenModeStore>()(
  persist(
    (set) => ({
      mode: 'panel',
      byWorkspace: {},
      setMode: (mode) => set({ mode }),
    }),
    {
      name: 'onething.files.openMode',
      // v2:打开方式按工作区各持一份(T-W1)。存量那一份原样折进默认空间。
      version: 2,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, version) => {
        if (version >= 2 || !persisted || typeof persisted !== 'object') return persisted
        return foldFlatIntoDefaultSpace<OpenModeFurniture>(
          persisted as Record<string, unknown>,
          ['mode'],
          DEFAULT_SPACE_ID,
        )
      },
      // 存盘可能来自旧版本、也可能被人手改过:账上**每一格**都钳一次
      // (只钳当前那一格的话,切过去才塌,而那一帧已经画出去了)。
      merge: (persisted, current) => {
        const saved = ((persisted as Partial<FileOpenModeStore> | undefined)?.byWorkspace
          ?? {}) as Record<string, OpenModeFurniture>
        const byWorkspace: Record<string, OpenModeFurniture> = {}
        for (const [spaceId, furniture] of Object.entries(saved)) {
          byWorkspace[spaceId] = { mode: clampMode(furniture?.mode) }
        }
        // 同步摊开当前空间那一格 —— 第一帧就是对的(理由同 stage 的 merge)。
        return { ...current, byWorkspace, ...spreadSpace(byWorkspace, OPEN_MODE_PER_SPACE) }
      },
      partialize: (s) => ({ byWorkspace: stashSpace(s, s.byWorkspace, OPEN_MODE_PER_SPACE) }),
    },
  ),
)

