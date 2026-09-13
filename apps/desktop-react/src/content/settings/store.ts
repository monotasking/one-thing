import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { DEFAULT_SETTINGS_PAGE, isSettingsPageId, type SettingsPageId } from './pages'
import { useStageStore } from '../../stage/store'
import { panelRef } from '../../stage/panel-ref'
import { SETTINGS_ITEM_ID } from '../../stage/items'

/**
 * **设置页此刻停在哪一页**(2026-09-13 分页)。
 *
 * ── 为什么它要落盘 ────────────────────────────────────────────────────────
 * 与「上次开到哪个 tab」同一条:一个人来设置页多半是**接着上次那件事**
 * (贴完一把密钥回来再贴一把)。重开就回到第一页,是每一次都要重新导航一遍。
 *
 * ── 存档是不可信输入(判例 `keymap/persisted.ts`,adbb17dda)────────────────
 * 水合那一路**按形状归一,不看版本号**:`page` 不是这张表上的 id 就落缺省页。
 * 版本号说的是「写它的代码是哪一版」,而写它的代码可以是半改的 —— 一格读不懂的
 * 页名最坏的后果应该是「回到通用页」,不是一块画不出来的面。
 * 所以这只 store **没有 `version` / `migrate`**:归一每次水合都跑一遍。
 */
interface SettingsNavStore {
  page: SettingsPageId
  setPage: (page: SettingsPageId) => void
}

export const useSettingsNav = create<SettingsNavStore>()(
  persist(
    (set) => ({
      page: DEFAULT_SETTINGS_PAGE,
      setPage: (page) => set({ page }),
    }),
    {
      name: 'onething.settings-nav',
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        const raw = (persisted as { page?: unknown } | undefined)?.page
        return { ...current, page: isSettingsPageId(raw) ? raw : DEFAULT_SETTINGS_PAGE }
      },
      partialize: (s) => ({ page: s.page }),
    },
  ),
)

/**
 * **深链口:把设置页开到某一页**。
 *
 * 今天**没有第二个调用方** —— 它是给「从别处跳进设置的某一节」准备的那条缝
 * (最近的一个候选是模型抽屉里的「管理模型…」)。写在这里而不是等到那天再写,
 * 是因为那时的写法只有两种:要么在调用点拼「设置 store 一句 + 形态机一句」,
 * 要么就是这一只 —— 而前者拼第二遍的那天,两处对「已经开着怎么办」的答案就会分叉。
 *
 * ── 「已经开着」时**不许收起来** ──────────────────────────────────────────
 * 形态机那台四态机器的第四格是「看得见、焦点已在里面 → 收起来」(`summonItem`
 * 走的就是 `toggle` 档)。而这只函数的语义是「**去**设置的那一页」,它没有反面:
 * 一个人点「管理模型…」而设置页恰好开着且聚焦,得到的不该是「设置被关掉了」。
 * 所以先按 `reveal` 档召唤那一格内容(只去不收);哪棵树上都没有它(答 `null`)
 * 才退回 `summonItem` 把它开出来 —— 那一格此刻不在场,`toggle` 也只会是「开」。
 */
export function openSettingsPage(page: SettingsPageId): void {
  useSettingsNav.getState().setPage(page)
  const stage = useStageStore.getState()
  if (stage.summonRef(panelRef(SETTINGS_ITEM_ID), 'reveal') === null) {
    stage.summonItem(SETTINGS_ITEM_ID)
  }
}

/*
 * **没有 HMR 退役,而这是有判据的**(壳规范那条法的判词:「这东西的寿命是不是
 * 『这个模块实例』」)。这只文件的模块级东西只有 store 本身:它不订推送、不起
 * 定时器、不往任何全局注册表登记,热更之后旧实例连同它的订阅表一起被丢掉,
 * 没有第二台在后台活着。与 `data/session-open-mode.ts` / `data/file-open-mode.ts`
 * 两只同型的偏好 store 逐字同一条处置。
 *
 * 尤其**不许**在这里 `persist.clearStorage()` —— 那不是退役,那是把用户存着的
 * 那一格删掉。
 */
