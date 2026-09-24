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
  | 'edge-bottom'
  | 'edge-left'
  | 'edge-right'
  | 'float'

/** 菜单里的次序 = 这张表的次序。全仓唯一一份,菜单不许自己再排一次。 */
export const FILE_OPEN_MODES: readonly FileOpenMode[] = [
  'panel',
  'stage',
  'edge-bottom',
  'edge-left',
  'edge-right',
  'float',
]

/*
 * ── 七档全部接通(W4)────────────────────────────────────────────────────
 * W1-a 时这里有一格 `WIRED_FILE_OPEN_MODES`,只列 `panel` 与 `stage` 两档 ——
 * 那时架子与浮窗的身子还不是树,一个文件插不进去,菜单里另外五档只能禁灰
 * 加注脚。W4 把两处都换成了树(`workbench.regions['edge:<side>']` /
 * `['float:<id>']`),那五档于是**自然解灰**:插一个文件进架子与插一个文件进
 * 中央区走的是同一句 `workbench.openRef(ref, { region })`。
 *
 * 那一格连同 `isWiredFileOpenMode` 一起删掉,不留一个恒为 true 的谓词 ——
 * 一个永远答「是」的判据是下一个人的陷阱(他会以为那里还有一档要判)。
 * 菜单里那句「下一批」的注脚(连同它的 i18n 键)同批退役。
 */

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
/**
 * 「开一扇新窗」那个哨位。它是一个**合法的 RegionId 形状**(所以这张表的返回
 * 类型不必为它开一格联合),但没有任何一棵树叫这个名字 —— 读到它的人负责
 * 铸一个真窗号(唯一的读者是 `content/viewer/open-target.ts`)。
 */
export const NEW_FLOAT_REGION = 'float:new' as const satisfies RegionId

export function regionOfFileOpenMode(mode: FileOpenMode): RegionId | 'panel' {
  switch (mode) {
    case 'panel':
      return 'panel'
    case 'stage':
      return 'center'
    case 'float':
      /*
       * **一扇新窗**。区域 id 要到落点那一刻才铸得出来(`stage/placement.nextFloatId`)
       * —— 这张表是纯翻译,它铸不出 id,也不该铸:同一档连点两次该开两扇窗还是
       * 一扇,是**落点**的语义,不是「档 → 区域」的语义。所以这里给的是一个
       * **哨位**,由 `content/viewer/open-target.ts` 那一处翻成真的窗号。
       */
      return NEW_FLOAT_REGION
    case 'edge-bottom':
      return 'edge:bottom'
    case 'edge-left':
      return 'edge:left'
    case 'edge-right':
      return 'edge:right'
  }
}

/** 每一档的名字是**界面文案**,所以这里只持有 key(同 StageItemSpec.titleKey 的判例)。 */
export const FILE_OPEN_MODE_LABELS: Record<FileOpenMode, MessageKey> = {
  panel: 'files.openIn.panel',
  stage: 'files.openIn.stage',
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

/**
 * **出厂档 = 主区域新标签**(W6-a,设计 `workbench-tabs-2026-09.md` §9 那张落差表)。
 *
 * W1 起它是 `panel`(文件面板自己那条分栏)。真机复现抓到的第一条读数就是它:
 * 出厂 `panel` 档**根本不进树** —— 用户单击一个文件,标签条上什么都不出现,
 * 而他要的是「files 可以打开多个」。`panel` 这一档保留(它仍是一种合法摆法,
 * 设计 §2.1 明写),只是不再是出厂那一格。
 */
export const FACTORY_FILE_OPEN_MODE: FileOpenMode = 'stage'

export const OPEN_MODE_PER_SPACE: PerSpaceSpec<FileOpenModeStore, OpenModeFurniture> = {
  pick: (s) => ({ mode: s.mode }),
  factory: () => ({ mode: FACTORY_FILE_OPEN_MODE }),
}

/**
 * 认不出的档一律落回出厂那一格。账上每一格都过它。
 * (W6-a:从前它落回 `panel` —— 「唯一一定兑现得了的一档」那句话在七档全通之后
 * 早就不成立了,而落回一个**不进树**的档正是那条真机读数的第二个来源。)
 */
function clampMode(value: unknown): FileOpenMode {
  // 顶边架子 09-24 退役:那一档的人要的是「钉在一条横边上」,落到底边而不是出厂档。
  if (value === 'edge-top') return 'edge-bottom'
  return typeof value === 'string' && (FILE_OPEN_MODES as readonly string[]).includes(value)
    ? (value as FileOpenMode)
    : FACTORY_FILE_OPEN_MODE
}

export const useFileOpenMode = create<FileOpenModeStore>()(
  persist(
    (set) => ({
      mode: FACTORY_FILE_OPEN_MODE,
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

