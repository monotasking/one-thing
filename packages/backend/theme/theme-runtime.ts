import fs from 'node:fs'
import path from 'node:path'
import { getOnethingDebugDir } from '../storage/paths.js'
import type {
  ApplyThemeResponse,
  GetThemeResponse,
  GetThemesResponse,
  OpenThemesFolderResponse,
  RefreshThemesResponse,
  ThemeFolderOpener,
} from './types.js'
import {
  applyTheme,
  getTheme,
  getThemeList,
  getThemesFolderPath,
  initializeThemes,
  loadCustomThemes,
  refreshThemes,
} from './index.js'
import { buildThemeDebugReport, type ThemeDebugData } from './theme-debug.js'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class OnethingThemeRuntime {
  private initialized = false

  async initialize(): Promise<void> {
    if (this.initialized) return

    initializeThemes()
    loadCustomThemes()
    this.initialized = true
  }

  async listThemes(): Promise<GetThemesResponse> {
    try {
      await this.initialize()
      return { success: true, themes: getThemeList() }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  }

  async getTheme(themeId: string): Promise<GetThemeResponse> {
    try {
      await this.initialize()
      const theme = getTheme(themeId)
      if (!theme) {
        return { success: false, error: `Theme not found: ${themeId}` }
      }
      return { success: true, theme }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  }

  /**
   * @param tokenOverrides 已裁决完的 token → 颜色字面量覆盖。宿主(装配层持有
   *   插件清单)把它当**参数**递进来 —— 而不是拿到响应再往 cssVariables 上叠,
   *   那样只有原始变量会变色,派生层留在旧色上。
   * @param skinTiers 已裁决完的皮肤旋钮 → 档位名(H3)。同样是**参数**;档位到
   *   CSS 值的翻译在主题层查表完成,宿主与插件都碰不到 CSS 值。
   */
  async applyTheme(
    themeId: string,
    mode: 'dark' | 'light',
    tokenOverrides?: Record<string, string>,
    skinTiers?: Record<string, string>
  ): Promise<ApplyThemeResponse> {
    try {
      await this.initialize()
      const debugCallback = (data: ThemeDebugData) => {
        try {
          // §16.22:落点走 store 口,不再 `os.homedir()` 直拼 —— 直拼的那份对
          // `ONETHING_STORE_PATH` 完全无感,于是任何指了别处 store 的进程
          // (测试、dev-self、server)照样往用户真机库里写调试快照。
          const dir = path.join(getOnethingDebugDir(), 'theme-tokens')
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(
            path.join(dir, `${data.themeId}-${data.mode}.json`),
            JSON.stringify(buildThemeDebugReport(data), null, 2),
            'utf-8'
          )
        } catch { /* silent — debug writes must never crash theme loading */ }
      }
      return {
        success: true,
        cssVariables: applyTheme(themeId, mode, debugCallback, tokenOverrides, skinTiers),
      }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  }

  async refreshThemes(projectPath?: string): Promise<RefreshThemesResponse> {
    try {
      return { success: true, themes: refreshThemes(projectPath) }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  }

  getThemesFolderPath(): string {
    return getThemesFolderPath()
  }

  async openThemesFolder(openThemesPath: ThemeFolderOpener): Promise<OpenThemesFolderResponse> {
    try {
      const result = await openThemesPath(this.getThemesFolderPath())
      if (typeof result === 'string' && result.trim().length > 0) {
        return { success: false, error: result }
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: errorMessage(error) }
    }
  }
}

export const defaultOnethingThemeRuntime = new OnethingThemeRuntime()
