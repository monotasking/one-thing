import { createMutation, createQuery, type Mutation } from './kernel'
import { themeSettingsPort } from './theme-settings-port'
import {
  patchDarkTheme,
  patchLightTheme,
  patchThemeMode,
  projectThemeSettings,
  type ThemeMode,
  type ThemeSettingsView,
} from './theme-settings-model'
import { refreshThemeFromSettings } from '../theme/theme-source'
import { notify } from '../services/notify'
import { t } from '../i18n'
import type { AppSettings } from '@shared/ipc/settings'

/**
 * 设置页「外观 · 主题」那一节的取数与三条写路(2026-09-13)。
 *
 * 形逐条照 `browser-settings-source.ts` 抄:query 只投一次形状、三条写路各自
 * 「当场读一份新的 → 合一格 → 整份写回」、失败 `notify`、`settle` 回后台对账、
 * 模块级副作用配 HMR 退役。**同一件事的第二份实现迟早分叉**,所以这里一条判据
 * 都不新发明,只把「哪一格」换掉。
 *
 * ── 为什么写完还要手动 `refreshThemeFromSettings()` ──────────────────────
 * 设置变更有推送面(`theme/theme-source` 订着 `settings:changed`),所以屏幕上的
 * 颜色**迟早**会跟着变。但那是一趟绕出去再绕回来的往返,而人此刻正盯着屏幕等它。
 * `refreshThemeFromSettings` 是 `theme-source` 文件头写明的**手动重判口**,而推送
 * 面那一路回来时会经 `applyIfChanged` 去重 —— 于是「立刻变」与「别人改了也变」
 * 两件事都成立,而且不会贴两遍。
 */

/** 屏幕形状就是投影函数那一份 —— 这一层不另起一个名字。 */
export type { ThemeSettingsView, ThemeMode }

export const themeSettingsQuery = createQuery<ThemeSettingsView>('themeSettings', async () => {
  const port = await themeSettingsPort()
  const [settingsResponse, themesResponse] = await Promise.all([
    port.readSettings(),
    port.listThemes(),
  ])
  // `success:false` 是「后端说不行」—— 抛出去,kernel 记进 error 并**留住上一份**
  // (律②)。编一个「跟随系统 + 空名册」会把「拉不到」画成「你什么都没选过」。
  if (!settingsResponse.success || !settingsResponse.settings) {
    throw new Error(settingsResponse.error || 'settings.getSettings 未成功')
  }
  /*
   * 名册拉不到**不算整节失败**:明暗那一行照样可以改,两格主题选择器退化成
   * 「只有当前那一项」(`themesFor` 的补位那一支)。一趟取数的坏不该让一整块面
   * 用不了 —— 与 `toBrowserSettingsView` 里名册回落那一段同一条判词。
   */
  const themes = themesResponse.success ? (themesResponse.themes ?? []) : []
  return projectThemeSettings(settingsResponse.settings, themes)
})

/** 读一份**新的**整份设置当底本。三条写路共用 —— 拼三遍就是三处会漂。 */
async function readSettingsForWrite(): Promise<AppSettings> {
  const port = await themeSettingsPort()
  const response = await port.readSettings()
  if (!response.success || !response.settings) {
    throw new Error(response.error || 'settings.getSettings 未成功')
  }
  return response.settings
}

async function saveSettings(next: AppSettings): Promise<void> {
  const port = await themeSettingsPort()
  const response = await port.saveSettings(next)
  if (!response.success) throw new Error(response.error || 'settings.saveSettings 未成功')
}

function failed(error: Error): void {
  notify({
    level: 'error',
    source: 'settings.theme',
    title: t('settings.themeSaveFailed'),
    body: error.message,
    detail: error.message,
  })
}

/**
 * 三条写路只差「合哪一格」,所以它们共用这一只工厂。
 *
 * **就地更新**(律①):`optimistic` 当场把屏上那一格翻过去(交出来的函数就是
 * 回滚),`settle` 再 `invalidate()` 后台对账 —— 没有「清空 → 骨架 → 重灌」。
 * 成功之后手动重判一次主题(理由在文件头)。
 */
function themeWrite<T extends string>(
  name: string,
  patch: (settings: AppSettings, value: T) => AppSettings,
  project: (view: ThemeSettingsView, value: T) => ThemeSettingsView,
): Mutation<T, void> {
  return createMutation<T, void>(name, {
    optimistic: (value) =>
      themeSettingsQuery.patch((prev) => (prev ? project(prev, value) : prev)),
    run: async (value) => {
      await saveSettings(patch(await readSettingsForWrite(), value))
      await refreshThemeFromSettings()
    },
    onError: failed,
    settle: () => themeSettingsQuery.invalidate(),
  })
}

export const setThemeModeMutation: Mutation<ThemeMode, void> = themeWrite<ThemeMode>(
  'themeSettings.setMode',
  patchThemeMode,
  (view, mode) => ({ ...view, mode }),
)

export const setLightThemeMutation: Mutation<string, void> = themeWrite<string>(
  'themeSettings.setLightTheme',
  patchLightTheme,
  (view, lightThemeId) => ({ ...view, lightThemeId }),
)

export const setDarkThemeMutation: Mutation<string, void> = themeWrite<string>(
  'themeSettings.setDarkTheme',
  patchDarkTheme,
  (view, darkThemeId) => ({ ...view, darkThemeId }),
)

/**
 * **别的客户端改了主题,这一节要跟着变**。
 *
 * 订阅挂在这只 `start()` 上而不是组件里:这一节可能同时挂着好几份(设置页在
 * 架子里开着、又被抬上舞台),而订阅只该有一条。幂等 —— 再调一次什么都不做。
 */
let unsubscribe: (() => void) | undefined
let starting: Promise<void> | undefined

export function startThemeSettingsSource(): Promise<void> {
  starting ??= (async () => {
    const port = await themeSettingsPort()
    await port.ready()
    unsubscribe?.()
    unsubscribe = port.onSettingsChanged(() => {
      void themeSettingsQuery.invalidate()
    })
  })().catch(() => {
    // 连不上就没有推送面 —— 这一节照旧可读可写(那两条各自有自己的错处理),
    // 只是听不见别人改。静默是对的:这里没有一句话是用户此刻在等的。
  })
  return starting
}

/** 测试用:把模块级的一次性状态清干净。 */
export function resetThemeSettingsSourceForTest(): void {
  unsubscribe?.()
  unsubscribe = undefined
  starting = undefined
  themeSettingsQuery.reset()
  setThemeModeMutation.reset()
  setLightThemeMutation.reset()
  setDarkThemeMutation.reset()
}

/**
 * **HMR 退役**(壳规范「模块级副作用必须配 HMR dispose」,09-01 立法)。
 * 退役**复用这只模块已有的那一口拆卸**,不写第二套。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    resetThemeSettingsSourceForTest()
  })
}
