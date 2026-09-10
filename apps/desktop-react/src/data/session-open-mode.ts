import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { MessageKey } from '../i18n'
import {
  foldFlatIntoDefaultSpace,
  spreadSpace,
  stashSpace,
  type PerSpaceSpec,
  type PerSpaceState,
} from '../workspace/per-space'
import { DEFAULT_SPACE_ID } from '../workspace/types'

/**
 * 「**在会话列表里点一行,那一下是什么意思**」—— 一条偏好,不是一个状态
 * (C2,正本 `apps/desktop-react/docs/session-continuity-2026-09.md` §4.2)。
 *
 * ── 它治的是哪一句报障 ───────────────────────────────────────────────────
 * 用户 09-09 原话:「点击一个 session 的行为还是覆盖,好像没有地方能够控制。」
 * 从前 `content/session-open.enterSessionInWorkbench` 的第二档写死了「原位换 ref」
 * —— 屏幕上那条正在干活的会话被顶掉,而且**没有任何地方能改**。
 *
 * ── 形照 `data/file-open-mode.ts` 抄一份,不另起一套 ──────────────────────
 * 那只文件已经是「一条 per-space 的档位偏好」的现成判例:store / `clampMode` /
 * `partialize` / 迁移 / 一张 `MessageKey` 表,五件齐全而且各有判词。这里逐件同型
 * ——**同一件事的第二份实现迟早在「谁先存谁后取」上分叉**,而那种 bug 的现场是
 * 「切回去设置没了」(判词整段在 `workspace/per-space.ts` 上)。
 *
 * ── 为什么是 per-space 家具,而不是这台机器的偏好 ────────────────────────
 * 判据是 `per-space.ts` 那一句:**它是不是「用户在这个空间里摆好的东西」**。
 * 「点一行是翻一翻还是摊开干活」跟着这个空间里的工作方式走 —— 一个只有几条长会话
 * 的空间里人要的是「新标签」,一个几百条会话翻着看的空间里要的是「预览」。
 * 与 `file-open-mode` 同一条理由、同一条落点(`workspace/layout-scope.ts`)。
 *
 * ── 为什么出厂那一格是**替换**(09-10 用户改判,拍点 3 的第二版)──────────
 * 用户 09-10 原话:「open 的行为应该可控:可以选择覆盖(但切换速度不要慢),也可以
 * 新开 tab;tab 只是为了分屏或其他用处,对 session 来说没那么重要,重要的是加载
 * 的速度。」——**这三档的价值不在标签,在可控**;标签条是为分屏之类的用处存在的,
 * 对「切会话」这件事本身不重要。所以缺省回到最直接的那一档「原位换」,`preview` /
 * `newTab` 留作可选。
 *
 * 09-09 立 `preview` 为缺省时押的是「覆盖会顶掉在干活的那条」,而**那条病 C1 已经
 * 从另一头治了**:停靠池(74abc07a)让被换掉的会话留在内存里,换回去不重载 ——
 * 于是「替换」不再等于「丢掉」,只是屏幕上少一格标签。用户这一句要的正是这个:
 * 覆盖可以,只要切得快。
 */
export type SessionOpenMode = 'preview' | 'newTab' | 'replace'

/**
 * 菜单与设置页里的次序 = 这张表的次序。全仓唯一一份,两处都不许自己再排。
 * **缺省那一档排第一**(09-10 起是 `replace`)—— 三选里第一眼看见的就是今天的行为。
 */
export const SESSION_OPEN_MODES: readonly SessionOpenMode[] = ['replace', 'newTab', 'preview']

/**
 * **出厂档 = 替换**(09-10 用户改判;理由整段在文件头「为什么出厂那一格是替换」)。
 *
 * 速度那一半不由这只文件保证:被换掉的会话留在 C1 的停靠池里,换回去不重载。
 * 另外两档一个字没删 —— 要「翻一翻不顶掉在干活的」的人设 `preview`,要「摊开并排」
 * 的人设 `newTab`,三档都在设置页与标签条右键菜单里。
 */
export const FACTORY_SESSION_OPEN_MODE: SessionOpenMode = 'replace'

/** 每一档的名字是**界面文案**,所以这里只持有 key(同 `FILE_OPEN_MODE_LABELS`)。 */
export const SESSION_OPEN_MODE_LABELS: Record<SessionOpenMode, MessageKey> = {
  replace: 'sessions.openMode.replace',
  newTab: 'sessions.openMode.newTab',
  preview: 'sessions.openMode.preview',
}

interface SessionOpenModeStore extends PerSpaceState<SessionOpenModeFurniture> {
  mode: SessionOpenMode
  setMode: (mode: SessionOpenMode) => void
}

/** 跟着工作区走的那一格。 */
interface SessionOpenModeFurniture {
  mode: SessionOpenMode
}

export const SESSION_OPEN_MODE_PER_SPACE: PerSpaceSpec<
  SessionOpenModeStore,
  SessionOpenModeFurniture
> = {
  pick: (s) => ({ mode: s.mode }),
  factory: () => ({ mode: FACTORY_SESSION_OPEN_MODE }),
}

/**
 * 认不出的档一律落回出厂那一格。账上每一格都过它(理由见下面 `merge`)。
 *
 * **它判的是「认不认得」,不是「是不是今天的缺省」**(09-10 换缺省时立此存照):
 * 换缺省**不许**顺手把存量档案里的 `preview` 改写成 `replace` —— 那一格是用户自己
 * 在设置页或右键菜单里选过的,是**他摆好的东西**,不是没选过的空位。缺省只对
 * 「账上压根没有这一格」的空间生效(`factory()` / `spreadSpace` 那条路),
 * 迁移 `migrate` 同理:它只把旧的扁平形折进默认空间,一个值都不翻译。
 */
function clampMode(value: unknown): SessionOpenMode {
  return typeof value === 'string' && (SESSION_OPEN_MODES as readonly string[]).includes(value)
    ? (value as SessionOpenMode)
    : FACTORY_SESSION_OPEN_MODE
}

export const useSessionOpenMode = create<SessionOpenModeStore>()(
  persist(
    (set) => ({
      mode: FACTORY_SESSION_OPEN_MODE,
      byWorkspace: {},
      setMode: (mode) => set({ mode }),
    }),
    {
      name: 'onething.sessions.openMode',
      /*
       * v1 就是 per-space 的形(这一格是 C2 新立的,没有「只有一个空间的时代」)。
       * 迁移那一句照旧留着 —— 它是**幂等**的,而且 `foldFlatIntoDefaultSpace` 对
       * 一份没有 `byWorkspace` 也没有 `mode` 的档案答的是「一格都没摘到 → 不造空家具」。
       * 留着它是为了让下一个改这只文件的人有现成的落点(与 file-open-mode 同型)。
       */
      version: 1,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, version) => {
        if (version >= 1 || !persisted || typeof persisted !== 'object') return persisted
        return foldFlatIntoDefaultSpace<SessionOpenModeFurniture>(
          persisted as Record<string, unknown>,
          ['mode'],
          DEFAULT_SPACE_ID,
        )
      },
      // 存盘可能来自旧版本、也可能被人手改过:账上**每一格**都钳一次
      // (只钳当前那一格的话,切过去才塌,而那一帧已经画出去了)。
      merge: (persisted, current) => {
        const saved = ((persisted as Partial<SessionOpenModeStore> | undefined)?.byWorkspace
          ?? {}) as Record<string, SessionOpenModeFurniture>
        const byWorkspace: Record<string, SessionOpenModeFurniture> = {}
        for (const [spaceId, furniture] of Object.entries(saved)) {
          byWorkspace[spaceId] = { mode: clampMode(furniture?.mode) }
        }
        // 同步摊开当前空间那一格 —— 第一帧就是对的(理由同 file-open-mode 的 merge)。
        return { ...current, byWorkspace, ...spreadSpace(byWorkspace, SESSION_OPEN_MODE_PER_SPACE) }
      },
      partialize: (s) => ({
        byWorkspace: stashSpace(s, s.byWorkspace, SESSION_OPEN_MODE_PER_SPACE),
      }),
    },
  ),
)
