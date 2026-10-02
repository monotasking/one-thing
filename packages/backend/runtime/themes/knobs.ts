/**
 * 表面旋钮的**类型表**(批 3b)—— 插件能拨的数,以及每一类数的合法区间。
 *
 * ── 为什么这里没有旋钮清单 ────────────────────────────────────────────────
 * 用户裁决,一字为准:「那个面板多少档,这种旋钮,应该交由**组件**;至于旋转多少,
 * 应该交由**插件**」,以及「不做宿主手编的旋钮 schema,让插件自己需要什么注入什么
 * —— **token 名字空间本身就是 API**」。
 *
 * 于是这张表与 `skin.ts`(H3)是**两种相反的治理**,不是同一套抄两遍:
 *   · H3 皮肤:宿主枚举旋钮名 + 枚举档位名,插件递档位名,值宿主查表 —— 因为那里
 *     开放的是"形"(圆角),形没有连续语义,一个自由数字只会造出十七种圆角。
 *   · 本表(旋钮):宿主**不列名字**,只按前缀开放名字空间、按**类型**立验证器。
 *     旋钮是连续量(浓度 / 半径),"多少档"是组件在 CSS 里决定的事(六级体系),
 *     "转到几"才是插件的事。宿主手编一份旋钮清单等于把组件的档位知识抄到装配层,
 *     那正是被否决的做法。
 *
 * ── 名字空间 ──────────────────────────────────────────────────────────────
 * `--ot-` 是旋钮前缀。这条界线在 `styles/wallpaper.css` 里是**有强制力**的:
 * 主题变量的唯一出口是 `documentElement.style.setProperty`,行内样式只压得住同一个
 * 元素上的规则声明 —— 所以旋钮必须声明在根(`html.has-wallpaper`)上才拨得动。
 * 批 3b 把 C / E 两级那三枚从 `body` 提到根并改名进 `--ot-`,`--wallpaper-*` 从此
 * 只剩住在 `body` 的派生内部件(ink 快照 + 兑好的成品色),按名字即可分辨。
 *
 * ── 类型 = 后缀 ───────────────────────────────────────────────────────────
 * 规则按**类型**写一次,不按条目维护:后缀决定验证器与钳制区间。名字空间里新增一枚
 * 同类型旋钮(组件那边加一档),这里**一个字都不用改**,插件当天就能寻址它。
 * 后缀不在类型表里的 `--ot-*` 名字不可寻址 —— 不是"还没登记",是宿主**没有办法**
 * 校验一个自己不知道类型的值,而放行一个不知道类型的字符串就是开一个注入面。
 * (`--ot-frost-filter` 就在这一格:它收的是一整条滤镜函数串;插件要拨的那个数是
 * `--ot-frost-blur`。`--ot-region-ink` / `--ot-ink-*` 同样不开:颜色早有正门 ——
 * `contributes.theme.overrides` 的**主题 token 路径**,那条路会让 `--ui-*` 语义层、
 * `-rgb` 变体、色阶一起重新派生;从旋钮侧塞一枚颜色只盖得住那一枚原始变量。)
 *
 * ── 越界是**钳制**不是丢弃 ────────────────────────────────────────────────
 * 一个能解析的数越了界,插件的意图是清楚的("我要更淡 / 更糊"),丢弃它等于把一个
 * 可满足的意图变成静默的无事发生。钳到边界既保住可读性红线,又保住意图方向。
 * 解析不出来的**串**才丢弃(与颜色白名单同规:丢弃 + 目录页投影可见,不拒载)。
 */

/** 旋钮名字空间。前缀本身就是 API —— 不在前缀内的键仍走 `CSS_VAR_MAP` 那道门。 */
export const THEME_KNOB_VAR_PREFIX = '--ot-'

/** 旋钮的类型(由后缀判定)。 */
export type ThemeKnobType = 'alpha' | 'blur'

/**
 * 后缀 → 类型。**这就是全部的"清单"** —— 两行,与旋钮有几枚无关。
 *
 * 顺序即匹配顺序;后缀之间互不为前缀,所以顺序在今天是无关紧要的。
 */
const KNOB_TYPE_BY_SUFFIX: ReadonlyArray<readonly [suffix: string, type: ThemeKnobType]> = [
  ['-alpha', 'alpha'],
  ['-blur', 'blur'],
]

/**
 * alpha 类的**可读性地板**(百分比)。
 *
 * 依据取现场而不是拍脑袋:六级体系里最淡的一档就是 B 级·纱 `--ot-surface-alpha: 18%`
 * (`styles/wallpaper.css`),而 B 级面是**承载正文的区域 chrome**(侧栏、顶栏、
 * 工作台)。宿主自己在真机上把 35% 降到 18% 并停在那里 —— 18% 是宿主验过的"字仍
 * 读得出"的下沿。低于宿主自己验过的下沿,就没有任何依据可援引了,所以地板取它。
 *
 * 注意这是**全类型一个数**,不是逐旋钮一个数:逐旋钮的地板就是逐条目维护,正是
 * 这份文件拒绝做的事。
 */
export const THEME_KNOB_ALPHA_FLOOR_PERCENT = 18

/** alpha 天花板:100% = 实色,再高没有意义(color-mix 自己也会夹)。 */
export const THEME_KNOB_ALPHA_CEILING_PERCENT = 100

/** blur 地板:0px。 */
export const THEME_KNOB_BLUR_FLOOR_PX = 0

/**
 * blur 天花板(px)。
 *
 * 依据同样取现场:磨砂半径曾是 14px,真机三轮把它判为**过重** ——「重模糊把图案
 * 抹成色浆,透过去的不是壁纸是色晕,肉眼即『没覆盖』」,宿主随即降到 6px。
 * 14 是**已知过重**的那一档,取作硬上限:插件可以比宿主更糊,但不能糊过一个已经
 * 被真机判过"等于没铺壁纸"的值。上限同时也是性能闸(`backdrop-filter` 逐帧重算)。
 */
export const THEME_KNOB_BLUR_CEILING_PX = 14

/** 这个名字是否落在旋钮名字空间里(只看前缀,不看它是不是已知旋钮)。 */
export function isThemeKnobVar(name: string): boolean {
  return name.startsWith(THEME_KNOB_VAR_PREFIX)
}

/**
 * 名字 → 类型。前缀内但后缀不认识 → `null`(不可寻址,见文件头)。
 */
export function themeKnobType(name: string): ThemeKnobType | null {
  if (!isThemeKnobVar(name)) return null
  for (const [suffix, type] of KNOB_TYPE_BY_SUFFIX) {
    if (name.endsWith(suffix)) return type
  }
  return null
}

/** `18` / `58.5` 这样的十进制数,不收正负号、不收指数、不收 `.5`。 */
const KNOB_NUMBER_PATTERN = /^\d{1,4}(?:\.\d{1,4})?$/

/** 每一类的单位与区间。规则写一次,旋钮加多少枚都不用回来。 */
const KNOB_RANGE: Record<ThemeKnobType, { unit: string; min: number; max: number }> = {
  alpha: {
    unit: '%',
    min: THEME_KNOB_ALPHA_FLOOR_PERCENT,
    max: THEME_KNOB_ALPHA_CEILING_PERCENT,
  },
  blur: {
    unit: 'px',
    min: THEME_KNOB_BLUR_FLOOR_PX,
    max: THEME_KNOB_BLUR_CEILING_PX,
  },
}

export interface ThemeKnobResolution {
  /** 钳制后写进 `:root` 的值(带单位,已归一)。 */
  value: string
  /** 越界被钳时的原值(带单位),设置页据此说"你写的是 X,生效的是 Y"。 */
  clampedFrom?: string
}

/**
 * 解析 + 钳制一枚旋钮值。
 *
 * 返回 `null` 的两种情形都按"丢弃该条目"处理(与颜色白名单同规):
 *  - 名字不在类型表里(宿主不知道怎么校验它);
 *  - 值不是"数字 + 本类型单位"(带 `var(` / `calc(` / 分号的串一律在这里出局 ——
 *    正则不含括号与分号,不需要逐个黑名单)。
 */
export function resolveThemeKnobValue(name: string, rawValue: unknown): ThemeKnobResolution | null {
  const type = themeKnobType(name)
  if (!type) return null
  if (typeof rawValue !== 'string') return null

  const range = KNOB_RANGE[type]
  const trimmed = rawValue.trim()
  if (!trimmed.endsWith(range.unit)) return null

  const numeric = trimmed.slice(0, trimmed.length - range.unit.length)
  if (!KNOB_NUMBER_PATTERN.test(numeric)) return null

  const parsed = Number(numeric)
  if (!Number.isFinite(parsed)) return null

  const clamped = Math.min(range.max, Math.max(range.min, parsed))
  const value = `${clamped}${range.unit}`
  if (clamped === parsed) return { value }
  return { value, clampedFrom: `${parsed}${range.unit}` }
}

/**
 * 旋钮表的键白名单 —— 这是**主题系统自己的门**:谁往 `:root` 上写变量都塞不进一个
 * 不是旋钮、或者值越界没钳过的条目(与 `sanitizeSkinTiers` /
 * `sanitizeThemeTokenOverrides` 同规,三处一套规矩)。
 */
export function sanitizeThemeKnobVariables(
  knobs?: Record<string, string>
): Record<string, string> | undefined {
  if (!knobs) return undefined
  const sanitized: Record<string, string> = {}
  for (const [name, rawValue] of Object.entries(knobs)) {
    const resolved = resolveThemeKnobValue(name, rawValue)
    if (!resolved) continue
    sanitized[name] = resolved.value
  }
  return Object.keys(sanitized).length ? sanitized : undefined
}
