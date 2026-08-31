import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { MessageKey } from '../i18n'

/**
 * 「用什么打开一个文件」—— 一条**偏好**,不是一个状态。
 *
 * 它跟着外壳既有的形态词汇走(`stage/types.ts` 的 Placement:dock / stage /
 * float / edge×4),再加上文件面自己那一档 `panel`(就地盖住树的只读预览,
 * 也就是今天真跑着的那条路)。刻意**不发明第二套名字**:「钉到右边」这件事
 * 在壳里已经有名字了,这里再造一个近义词,以后接查看器时两套词就得对表。
 *
 * ── 诚实降级(本批唯一一处可感知的「还没接上」)────────────────────────────
 * 今天只有 `panel` 真生效 —— 别的六档都需要**查看器本体**(F1:一块能被放到
 * 舞台 / 钉栏 / 浮窗里的文件查看内容),而那块内容本批不做。
 *
 * 所以这里的做法是「记住,但不假装」:选了就存下来(下次开菜单勾在那儿),
 * 而菜单底下有一句注脚明说「只有面板内已经接上」。三种做法里选它的理由:
 *  · 把六档**藏起来** —— 用户不知道这套能力存在,接上那天也没人会去找;
 *  · 把六档**做成灰的** —— 那等于说「以后也不给你」,而它们只是还没到;
 *  · 记忆 + 注脚 —— 说出实情,并且把用户此刻的意愿存下来。
 * 这一条属**诚实降级**,不是缺陷,记在这里免得下一个人把它当 bug 修掉。
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
 * 不散在渲染层的条件里;接上一档就往这张表里加一格,菜单一个字都不用改。
 */
export const WIRED_FILE_OPEN_MODES: readonly FileOpenMode[] = ['panel']

export function isWiredFileOpenMode(mode: FileOpenMode): boolean {
  return WIRED_FILE_OPEN_MODES.includes(mode)
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
