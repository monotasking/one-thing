/**
 * themes(主题)域 —— 结构债 P4c 第七批,整只从手写 IPC 通道搬到通用
 * `rpc:invoke` / `POST /api/rpc`。
 *
 * 替换掉三处镜像:
 *  - `apps/electron/src/ipc/themes.ts` 的手写 IPC 工厂 + `apps/electron/src/main/ipc/themes.ts`
 *    那层壳适配(`IPC_CHANNELS` 上那五条 theme 通道);
 *  - `preload/bridge.ts` 的五条包装与 `platform/web.ts` 的五条 REST 镜像;
 *  - `server/http.ts` 的三条 REST 路由 + `/api/themes/<id>[/apply]` 那个正则块与
 *    `withThemeId` / `readThemeId` 两个助手、`server/runtime.ts` 的 `themes` facade adapter。
 *
 * 四条纯 runtime:逐条转调 `@onething/runtime/themes` 的
 * `defaultOnethingThemeRuntime`(它自己 `initialize()` 是幂等的,每个方法都先过一遍
 * —— 所以宿主启动时那次 eager 预热不是必需的,随壳一起删)。
 *
 * ## 两处口径变化,都写在这里
 *
 * **1. 插件主题覆盖从 `@main` 搬进了域处理者(拍板 #20)。**
 * 三样合成(token 覆盖 / 皮肤档位 / 表面旋钮)从前只在 Electron 桌面那一层拼,
 * 旧 server adapter 直接调 `defaultOnethingThemeRuntime.applyTheme(themeId, mode)`
 * ——「方案 A:只有 desktop 这一个宿主做合成,server 只透传声明」。搬进来之后
 * **server 顺带获得了同一份合成**:一个 store 一份插件清单,两个宿主看到的主题
 * 从此逐字相同。这是 #20 接受的那类收敛(同 app-state / skills 判例),不是零变化。
 *
 * **2. `openFolder` 走宿主端口。**
 * 「在文件管理器里打开主题目录」只有 Electron 桌面做得到。它现在走
 * `@onething/runtime/shell` 的 `configureShellHost`(P4c 第二批立的端口):桌面注入
 * Electron 的目录打开原语,server / CLI 不注入 —— 于是拿到结构化的
 * 「宿主没有外壳能力」。这正是旧 server adapter 那句
 * "Opening the local themes folder is not available in the web server runtime."
 * 的同义降级,区别是它不再需要第二份实现。
 */
import { getShellHost } from '@onething/runtime/shell/host-ports'
import { defaultOnethingThemeRuntime } from '@onething/runtime/themes/theme-runtime'
import { themesRouter, type ThemesRoutes } from '@shared/ipc/themes.js'
import { getPluginSkinTiers } from '../../wiring/plugins/skin.js'
import {
  getPluginThemeKnobVariables,
  getPluginThemeOverrideTokenValues,
} from '../../wiring/plugins/theme-overrides.js'
import { registerRouterHandlers, type RpcRouteHandlers } from '../registry.js'

export const themesRpcHandlers: RpcRouteHandlers<ThemesRoutes> = {
  async getAll() {
    return defaultOnethingThemeRuntime.listThemes()
  },
  async get(request) {
    return defaultOnethingThemeRuntime.getTheme(request.themeId)
  },
  async apply(request) {
    // 合成点(B 期,L2):插件 `contributes.theme` 覆盖以**参数**进入主题计算,
    // 在 `resolveThemeUI` / `generateCSSVariables` **之前**落位 —— ui 语义层、
    // -rgb 变体、primary 色阶都按覆盖色重新派生。
    //
    // 旧做法是拿到响应再往 cssVariables 上 spread:只盖得住原始变量,而 renderer
    // 上可见的 UI 绝大多数消费 `--ui-*`,真机上肉眼几乎无感(差异记录见
    // docs/design/plugin-ui/plugin-ui-rollout-2026-08.md §6.1.1)。
    // renderer 的 applyThemeVariables 仍然零改动:它只是消费下发的表。
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
    //
    // P4c 第七批:这段合成从 `@main/ipc/themes.ts` 逐字搬到这里,于是它不再是
    // 「只有 desktop 这一个宿主做」的事 —— 见文件头口径变化 1。
    const response = await defaultOnethingThemeRuntime.applyTheme(
      request.themeId,
      request.mode,
      getPluginThemeOverrideTokenValues(),
      getPluginSkinTiers(),
    )
    if (!response.success) return response
    return {
      ...response,
      cssVariables: { ...response.cssVariables, ...getPluginThemeKnobVariables() },
    }
  },
  async refresh(request) {
    return defaultOnethingThemeRuntime.refreshThemes(request?.projectPath)
  },
  async openFolder() {
    // 未注入宿主 = 拿到一句非空的失败原因,投影据此把它折成失败结果
    // (Electron 打开原语的约定:空串才算成功)。
    return defaultOnethingThemeRuntime.openThemesFolder(targetPath =>
      getShellHost().openPath(targetPath),
    )
  },
}

export function registerThemesRpcDomain(): () => void {
  return registerRouterHandlers(themesRouter, themesRpcHandlers)
}
