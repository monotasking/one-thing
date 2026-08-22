/**
 * 内嵌浏览器(WebContentsView)的**宿主处理者**(结构债 P4 终态批 A1-b,
 * 2026-08-23)。
 *
 * 19 条从 `IPC_CHANNELS.BROWSER_*` 那批手写通道搬到 `browserRouter` 上的一份表。
 * 每条的**错误包装逐字照搬**迁移前 `@main/ipc/browser.ts` 里那批闭包:
 *  - `hydrate` / `createTab` / `pickElement` / 两条搜索引擎 / 四条 profile 用
 *    try/catch 折成结构化失败,失败时的兜底字段(`tabs: []` / `engineId: 'google'` /
 *    `profiles: []` + `activeProfileId: 'default'`)一字未改;
 *  - 其余九条(选/关/导航/前进后退/刷新/停/几何/显隐/取消拾取)直接调服务并恒回
 *    `{ success: true }` —— 服务对未知 tabId 是 no-op,旧线也没有别的答案。
 *
 * `setBounds` 是**高频**的(拖拽 / resize 每帧一次,渲染侧已用 rAF 节流)。与 A1-a
 * 的 `todo-plan-window.drag` 同判例照迁:每帧多的只是一个信封字面量和一次 Map 查找,
 * 而换来的是「F12 进契约 → F12 进处理者」。
 *
 * `callerId` **一次都没用**:浏览器服务是主进程里的单例,一台 `BrowserViewService`
 * 管所有标签页,迁移前那批 handler 也从没读过 `event.sender`。
 *
 * 本文件一行 electron 都不 import —— 真正的服务由 `@main/ipc/browser.ts` 注入。
 */
import type {
  BrowserAddProfileRequest,
  BrowserCreateTabRequest,
  BrowserHydrateResponse,
  BrowserNavigateRequest,
  BrowserProfile,
  BrowserProfileIdRequest,
  BrowserRoutes,
  BrowserSearchEngineId,
  BrowserSetBoundsRequest,
  BrowserSetSearchEngineRequest,
  BrowserSetVisibleRequest,
  BrowserTabIdRequest,
  BrowserTabInfo,
  BrowserViewBounds,
  PickedWebElement,
} from '@shared/ipc/browser.js'
import { browserRouter } from '@shared/ipc/browser.js'
import { registerShellDomain, type ShellRouteHandlers } from '../shell-registry.js'

/** 服务上被这 19 条用到的那部分 —— `BrowserViewService` 的结构子集。 */
export interface BrowserShellService {
  hydrate(): { tabs: BrowserTabInfo[], activeTabId: string | null }
  createTab(url?: string, background?: boolean): BrowserTabInfo
  closeTab(tabId: string): void
  selectTab(tabId: string): void
  navigate(tabId: string, url: string): void
  goBack(tabId: string): void
  goForward(tabId: string): void
  reload(tabId: string): void
  stop(tabId: string): void
  setBounds(bounds: BrowserViewBounds): void
  setVisible(visible: boolean): void
  pickElement(tabId: string): Promise<PickedWebElement | null>
  cancelPick(tabId: string): void
  getSearchEngine(): { engineId: BrowserSearchEngineId }
  setSearchEngine(engineId: string): { engineId: BrowserSearchEngineId }
  listProfiles(): { profiles: BrowserProfile[], activeProfileId: string }
  addProfile(name: string): { profiles: BrowserProfile[], activeProfileId: string }
  removeProfile(profileId: string): { profiles: BrowserProfile[], activeProfileId: string }
  switchProfile(profileId: string): { profiles: BrowserProfile[], activeProfileId: string }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createBrowserShellHandlers(
  service: () => BrowserShellService,
): ShellRouteHandlers<BrowserRoutes> {
  const ok = { success: true } as const
  return {
    hydrate: async (): Promise<BrowserHydrateResponse> => {
      try {
        const snapshot = service().hydrate()
        return { success: true, ...snapshot }
      } catch (error) {
        return { success: false, tabs: [], activeTabId: null, error: errorMessage(error) }
      }
    },
    createTab: async (request: BrowserCreateTabRequest) => {
      try {
        const input = request ?? {}
        return { success: true, tab: service().createTab(input.url, input.background) }
      } catch (error) {
        return { success: false, error: errorMessage(error) }
      }
    },
    closeTab: async (request: BrowserTabIdRequest) => {
      service().closeTab(request.tabId)
      return ok
    },
    selectTab: async (request: BrowserTabIdRequest) => {
      service().selectTab(request.tabId)
      return ok
    },
    navigate: async (request: BrowserNavigateRequest) => {
      service().navigate(request.tabId, request.url)
      return ok
    },
    goBack: async (request: BrowserTabIdRequest) => {
      service().goBack(request.tabId)
      return ok
    },
    goForward: async (request: BrowserTabIdRequest) => {
      service().goForward(request.tabId)
      return ok
    },
    reload: async (request: BrowserTabIdRequest) => {
      service().reload(request.tabId)
      return ok
    },
    stop: async (request: BrowserTabIdRequest) => {
      service().stop(request.tabId)
      return ok
    },
    setBounds: async (request: BrowserSetBoundsRequest) => {
      service().setBounds(request.bounds)
      return ok
    },
    setVisible: async (request: BrowserSetVisibleRequest) => {
      service().setVisible(request.visible)
      return ok
    },
    pickElement: async (request: BrowserTabIdRequest) => {
      try {
        const element = await service().pickElement(request.tabId)
        return { success: true, element }
      } catch (error) {
        return { success: false, error: errorMessage(error) }
      }
    },
    pickCancel: async (request: BrowserTabIdRequest) => {
      service().cancelPick(request.tabId)
      return ok
    },
    getSearchEngine: async () => {
      try {
        return { success: true, ...service().getSearchEngine() }
      } catch (error) {
        return { success: false, engineId: 'google' as const, error: errorMessage(error) }
      }
    },
    setSearchEngine: async (request: BrowserSetSearchEngineRequest) => {
      try {
        return { success: true, ...service().setSearchEngine(request.engineId) }
      } catch (error) {
        return { success: false, engineId: 'google' as const, error: errorMessage(error) }
      }
    },
    listProfiles: async () => {
      try {
        return { success: true, ...service().listProfiles() }
      } catch (error) {
        return {
          success: false,
          profiles: [],
          activeProfileId: 'default',
          error: errorMessage(error),
        }
      }
    },
    addProfile: async (request: BrowserAddProfileRequest) => {
      try {
        return { success: true, ...service().addProfile(request.name) }
      } catch (error) {
        return {
          success: false,
          profiles: [],
          activeProfileId: 'default',
          error: errorMessage(error),
        }
      }
    },
    removeProfile: async (request: BrowserProfileIdRequest) => {
      try {
        return { success: true, ...service().removeProfile(request.profileId) }
      } catch (error) {
        return {
          success: false,
          profiles: [],
          activeProfileId: 'default',
          error: errorMessage(error),
        }
      }
    },
    switchProfile: async (request: BrowserProfileIdRequest) => {
      try {
        return { success: true, ...service().switchProfile(request.profileId) }
      } catch (error) {
        return {
          success: false,
          profiles: [],
          activeProfileId: 'default',
          error: errorMessage(error),
        }
      }
    },
  }
}

export function registerBrowserShellDomain(service: () => BrowserShellService): () => void {
  return registerShellDomain(browserRouter, createBrowserShellHandlers(service))
}
