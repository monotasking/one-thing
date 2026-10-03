/**
 * 皮肤档位表(H3)—— 插件能改的**形**,以及每一档对应的 CSS 值。
 *
 * 这张表之于 H3,等同 `CSS_VAR_MAP` 之于 L2:**白名单就是表本身**,不另抄一份。
 * 区别在于安全模型强一个量级 —— L2 的插件递进来的是一个颜色**字符串**(于是
 * 需要一整套字面量白名单挡 `url(` / `var(` / `;`),H3 的插件递进来的只是一个
 * **档位名**,CSS 值由宿主从这张表里取。插件永远碰不到 CSS 值,注入面为零。
 *
 * 为什么住在 themes/ 而不是 plugins/:它描述的是"宿主会往 `:root` 上写哪些变量、
 * 写什么值",跟 `CSS_VAR_MAP` 是同一类知识,和插件没关系 —— 主题系统不认识插件,
 * 只收一张**档位表**当参数(`applyTheme(…, skinTiers)`)。
 *
 * 与"主题不能定义圆角/字体"的既有裁决不冲突:那条裁决禁的是**主题自由定义形**
 * (主题 JSON 里没有、也不会有 radius 字段)。H3 是**宿主开的档位口** —— 枚举档位、
 * 宿主执行、值写死在这张表里。绕开的是"自由定义",不是"枚举档位"。
 */

/** 开放的旋钮。新增一个旋钮 = 这里一行 + `SKIN_TIER_VALUES` 一行 + 组件 CSS 一处。 */
export const SKIN_KNOBS = ['bubbleRadius'] as const

export type SkinKnob = (typeof SKIN_KNOBS)[number]

/** 旋钮 → 宿主写到 `:root` 上的变量名。 */
export const SKIN_VAR_MAP: Record<SkinKnob, string> = {
  bubbleRadius: '--skin-bubble-radius',
}

/**
 * 旋钮 → 档位 → CSS 值。
 *
 * `null` 的语义是"**不写这个变量**",不是"写一个等于现状的值"。缺省档
 * (`standard`)一律是 `null`:现状值只存在于组件 CSS 的 `var(…, 现状)` 兜底里
 * 那**一份**,这张表里不许出现它的副本 —— 抄一份就一定会漂移,而且"缺省档 ==
 * 现状"就从一条恒等式退化成一条需要人去核对的巧合。
 *
 * 于是"没插件"和"插件选了 standard"产出逐字节相同,不需要任何特殊分支。
 */
export const SKIN_TIER_VALUES: Record<SkinKnob, Record<string, string | null>> = {
  /**
   * 气泡圆角。现状 = `var(--radius-xs, 4px)`(见 MessageBubble.vue `.bubble.user`
   * 与 MessageItem.vue 的 room-mode agent frame,两处同一配方)。
   */
  bubbleRadius: {
    sharp: '0',
    standard: null,
    soft: '10px',
    round: '18px',
  },
}

export function isSkinKnob(name: string): name is SkinKnob {
  return Object.prototype.hasOwnProperty.call(SKIN_TIER_VALUES, name)
}

export function isSkinTier(knob: SkinKnob, tier: string): boolean {
  return Object.prototype.hasOwnProperty.call(SKIN_TIER_VALUES[knob], tier)
}

/** 某个旋钮开放的档位名(顺序即声明顺序,设置页照着念)。 */
export function skinTiersOf(knob: SkinKnob): string[] {
  return Object.keys(SKIN_TIER_VALUES[knob])
}

/**
 * 档位表的键白名单 —— 这是**主题系统自己的门**:谁调 `applyTheme` 都塞不进一个
 * 不认识的旋钮或档位(与 `sanitizeThemeTokenOverrides` 同规)。
 */
export function sanitizeSkinTiers(
  skinTiers?: Record<string, string>
): Record<string, string> | undefined {
  if (!skinTiers) return undefined
  const sanitized: Record<string, string> = {}
  for (const [knob, tier] of Object.entries(skinTiers)) {
    if (!isSkinKnob(knob)) continue
    if (typeof tier !== 'string' || !isSkinTier(knob, tier)) continue
    sanitized[knob] = tier
  }
  return Object.keys(sanitized).length ? sanitized : undefined
}

/**
 * 档位 → CSS 变量。
 *
 * 产出与主题变量表是**不相交**的两组名字(`--skin-*` 前缀),所以合并时谁先谁后
 * 都一样 —— 皮肤永远不会盖住主题算出来的任何一个值,反之亦然。
 */
export function generateSkinVariables(
  skinTiers?: Record<string, string>
): Record<string, string> {
  const sanitized = sanitizeSkinTiers(skinTiers)
  if (!sanitized) return {}
  const variables: Record<string, string> = {}
  for (const [knob, tier] of Object.entries(sanitized)) {
    const value = SKIN_TIER_VALUES[knob as SkinKnob][tier]
    // null = 缺省档 = 不写变量,让组件 CSS 的兜底(现状值)透出来。
    if (value === null) continue
    variables[SKIN_VAR_MAP[knob as SkinKnob]] = value
  }
  return variables
}
