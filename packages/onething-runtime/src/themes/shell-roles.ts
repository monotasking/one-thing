/**
 * **壳的角色表**:主题直接说「画布用哪个色、侧栏用哪个色……」,不经任何计算。
 *
 * 起因(2026-09-24,用户:「我们不应该在转后的结果上改来改去」):base46 主题一路要被
 * 算三遍 —— `convertBase46ToTheme` 按对比度搜字色、`deriveSurfaceRoles` 推开面层,
 * `resolver.ts` 的面层护栏再推一遍,主题桥再兑一遍 —— one_light 的画布落在
 * `darker_black`、架子身子落在弹出菜单色 `one_bg`,整屏昏暗。
 *
 * 这张表走的是另一条路:**值从主题源文件原样取,输出在所有派生之后**,护栏碰不到它。
 * 桥(`apps/desktop-react/src/styles/theme-bridge.css`)优先读 `--role-*`,
 * 主题没有角色表时退回旧取法 —— 所以没有角色表的主题(今天剩下的内置 JSON)一个像素都不变。
 *
 * 角色名与变量名**只在这一个文件里出现**;加一个角色 = 这里加一行 + 产地(如
 * `base46-parser.ts`)填一格 + 桥里读一格。
 */
export interface ThemeShellRoles {
  /** 聊天画布 / 主区叶的脸 —— NvChad 编辑区 `Normal` 的底(`black`)。 */
  canvas: string
  /** 内嵌底:代码块、diff、终端、架子外壳 —— NvChad 文件树/浮窗(`darker_black`)。 */
  inset: string
  /**
   * 卡片面:工具卡、架子身子 —— 同画布(`black`)。NvChad 的内容区一律 `black`,只有标签栏
   * 是 `black2`;亮色主题里 `darker_black` 与 `black2` 只差一点,架子身子取它会让架子上的活动
   * 标签在标签条上看不出来(09-25 one_light 真机截图:#efeff0 对 #EAEAEB)。
   */
  card: string
  /** 浮起:菜单、输入框、Dock —— NvChad Telescope 输入栏(`black2`)。 */
  raised: string
  /** 标签条:顶栏与架子的檐 —— NvChad `TbFill`(`black2`)。 */
  strip: string
  /** 非活动标签悬停的底 —— base46 给 `transparent`:NvChad 的标签没有悬停底,悬停只换字色。 */
  tabHover: string
  /** 分隔线 —— NvChad `WinSeparator`(`line`)。 */
  line: string
  /** 正文墨 —— NvChad `Normal` 的前景(base16 `base05`)。 */
  ink: string
  /** 次级墨 —— base46 `white`(NvChad 活动标签、光标行号的字)。 */
  ink2: string
  /** 弱墨:思考行、时长、占位字 —— base46 `light_grey`(NvChad 非活动标签的字)。 */
  inkWeak: string
}

const SHELL_ROLE_VAR_MAP: Record<keyof ThemeShellRoles, string> = {
  canvas: '--role-canvas',
  inset: '--role-inset',
  card: '--role-card',
  raised: '--role-raised',
  strip: '--role-strip',
  tabHover: '--role-tab-hover',
  line: '--role-line',
  ink: '--role-ink',
  ink2: '--role-ink-2',
  inkWeak: '--role-ink-weak',
}

const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|transparent)$/

/**
 * 角色表 → CSS 变量。与主题变量、`--skin-*` 都不相交(`--role-*` 前缀),合并顺序无关。
 * 值只放行颜色字面量:主题文件是用户机器上的文件,当不可信输入。
 */
export function generateShellRoleVariables(roles?: Partial<ThemeShellRoles>): Record<string, string> {
  if (!roles) return {}
  const variables: Record<string, string> = {}
  for (const [role, cssVar] of Object.entries(SHELL_ROLE_VAR_MAP) as Array<[keyof ThemeShellRoles, string]>) {
    const value = roles[role]
    if (typeof value === 'string' && SAFE_COLOR.test(value.trim())) variables[cssVar] = value.trim()
  }
  return variables
}
