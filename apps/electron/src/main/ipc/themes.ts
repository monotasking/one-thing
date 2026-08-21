/**
 * Theme IPC Handlers
 * Handles IPC communication for theme operations
 */

import {
  registerElectronThemesIpcHandlers,
  type ElectronThemeFolderOpener,
  type ElectronThemeMode,
} from '@onething/electron-host/ipc/themes'
import { defaultOnethingThemeRuntime } from '@onething/runtime/themes/theme-runtime'
import {
  getPluginThemeKnobVariables,
  getPluginThemeOverrideTokenValues,
} from '@onething/backend/wiring/plugins/theme-overrides.js'
import { getPluginSkinTiers } from '@onething/backend/wiring/plugins/skin.js'
import { IPC_CHANNELS } from '@shared/ipc.js'
import { getLogger } from '@onething/backend/wiring/logging/index.js'

const log = getLogger('ipc.themes')

/**
 * Initialize the theme system
 */
export async function initializeThemeSystem(): Promise<void> {
  log.info('theme system initializing')
  await defaultOnethingThemeRuntime.initialize()
  log.info('theme system initialized')
}

/**
 * Register all theme-related IPC handlers
 */
export function registerThemeHandlers() {
  registerElectronThemesIpcHandlers({
    channels: {
      list: IPC_CHANNELS.THEME_GET_ALL,
      get: IPC_CHANNELS.THEME_GET,
      apply: IPC_CHANNELS.THEME_APPLY,
      refresh: IPC_CHANNELS.THEME_REFRESH,
      openFolder: IPC_CHANNELS.THEME_OPEN_FOLDER,
    },
    listThemes: () => {
      return defaultOnethingThemeRuntime.listThemes()
    },
    getTheme: (themeId: string) => {
      return defaultOnethingThemeRuntime.getTheme(themeId)
    },
    applyTheme: async (themeId: string, mode: ElectronThemeMode) => {
      // 合成点(B 期,L2):插件 `contributes.theme` 覆盖以**参数**进入主题计算,
      // 在 `resolveThemeUI` / `generateCSSVariables` **之前**落位 —— ui 语义层、
      // -rgb 变体、primary 色阶都按覆盖色重新派生。
      //
      // 旧做法是拿到响应再往 cssVariables 上 spread:只盖得住原始变量,而 renderer
      // 上可见的 UI 绝大多数消费 `--ui-*`,真机上肉眼几乎无感(差异记录见
      // docs/design/plugin-ui/plugin-ui-rollout-2026-08.md §6.1.1)。
      // renderer 的 applyThemeVariables 仍然零改动:它只是消费下发的表。
      // 方案 A 口径:只有 desktop 这一个宿主做合成,server 只透传声明。
      //
      // 合成点(H3,皮肤包):插件 `contributes.theme.skin` 的**档位名**同样以参数
      // 进入主题计算。档位 → CSS 值的翻译在主题层查 `SKIN_TIER_VALUES` 完成 ——
      // 插件递进来的字符串永远不会出现在 CSS 里,所以皮肤没有、也不需要 L2 那套
      // 颜色字面量白名单。皮肤变量(`--skin-*`)与主题变量名不相交。
      //
      // 合成点(批 3b,表面旋钮):`contributes.theme.overrides` 里以 `--ot-` 开头的
      // 键是**旋钮地址**(浓度 / 模糊半径),它与上面两样反过来 —— 走**叠加**而不是
      // 参数前移。判据与颜色那条是同一句话的两面:颜色必须前移,因为 `--ui-*`、
      // `-rgb`、色阶都从它派生;旋钮**没有任何东西从它派生**,主题计算里根本不读它,
      // 它是 CSS 绘制时才求值的一个数。所以它与 `--skin-*` 同构(名字空间也不相交),
      // 叠在成品之上是正确的,不是那条被判过的降级路。
      const response = await defaultOnethingThemeRuntime.applyTheme(
        themeId,
        mode,
        getPluginThemeOverrideTokenValues(),
        getPluginSkinTiers(),
      )
      if (!response.success) return response
      return {
        ...response,
        cssVariables: { ...response.cssVariables, ...getPluginThemeKnobVariables() },
      }
    },
    refreshThemes: (projectPath?: string) => {
      return defaultOnethingThemeRuntime.refreshThemes(projectPath)
    },
    openThemesFolder: (openThemesPath: ElectronThemeFolderOpener) => {
      return defaultOnethingThemeRuntime.openThemesFolder(openThemesPath)
    },
  })

  log.info('handlers registered')
}
