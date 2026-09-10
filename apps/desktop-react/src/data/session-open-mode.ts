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
 */
export type SessionOpenMode = 'preview' | 'newTab' | 'replace'

/** 菜单与设置页里的次序 = 这张表的次序。全仓唯一一份,两处都不许自己再排。 */
export const SESSION_OPEN_MODES: readonly SessionOpenMode[] = ['preview', 'newTab', 'replace']

/**
 * **出厂档 = 预览**(拍点 3)。
 *
 * 它同时落对用户描述的两种情形:「只开着一条,在列表里来回切着看」= 一直复用那一格
 * 预览位,标签不增;「拖了两条到标签条上都在干活,再点第三条」= 那两条早已转正,
 * 第三条开进新的预览格,不覆盖任何一个在干活的。
 */
export const FACTORY_SESSION_OPEN_MODE: SessionOpenMode = 'preview'

/** 每一档的名字是**界面文案**,所以这里只持有 key(同 `FILE_OPEN_MODE_LABELS`)。 */
export const SESSION_OPEN_MODE_LABELS: Record<SessionOpenMode, MessageKey> = {
  preview: 'sessions.openMode.preview',
  newTab: 'sessions.openMode.newTab',
  replace: 'sessions.openMode.replace',
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

/** 认不出的档一律落回出厂那一格。账上每一格都过它(理由见下面 `merge`)。 */
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
