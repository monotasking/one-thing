/**
 * `contributes.theme` —— L2 主题 token 覆盖的**安全面**(B 期,见
 * `docs/design/plugin-ui/plugin-ui-rollout-2026-08.md` §6.1)。
 *
 * 覆盖值是插件伸进 `:root` 的一根字符串管子。`setProperty` 不会让它逃出
 * "属性值"的语法位置,但属性值本身足够危险:
 *  - `url(...)` 能发起远程请求(追踪像素、指纹);
 *  - `var(...)` 能制造递归引用与求值异常;
 *  - `;` / `}` 在别的注入面(拼 CSS 文本)上就是逃逸字符 —— 今天不拼文本,
 *    但白名单不该依赖"当前实现恰好安全"。
 *
 * 于是这里只放行**颜色字面量**:hex(3/4/6/8 位)、rgb/rgba、hsl/hsla、
 * oklch/oklab、以及 CSS 标准命名色。判据钉在正则上,函数式颜色的括号内
 * **不允许再出现括号** —— 这一条就把 `var(`/`url(`/`calc(`/`expression(`
 * 一起挡在门外,不需要逐个黑名单(黑名单永远漏下一个)。
 *
 * 这里只放**判据**,不放执行:键是否属于主题 token 表由产品层判(core 吃不到
 * 主题模块),合并与注入由装配层/宿主做。
 */

/** 一个插件最多覆盖多少个 token —— 超过即形状非法(拒载),不是"截断"。 */
export const PLUGIN_THEME_OVERRIDE_MAX_ENTRIES = 32

/** 单个覆盖值的长度上限;超长值没有正当颜色写法,只可能是塞东西。 */
export const PLUGIN_THEME_COLOR_MAX_LENGTH = 128

/**
 * `contributes.theme.skin`(H3,皮肤包)一个插件最多拧多少个旋钮 —— 超过即形状
 * 非法(拒载),不是"截断"。
 *
 * 这里**只有形状上限**,没有旋钮名、没有档位名、更没有 CSS 值:那三样住在主题层
 * (`SKIN_TIER_VALUES`),core 吃不到主题模块。皮肤不需要 L2 那套颜色字面量白名单 ——
 * 插件递进来的是**档位名**,CSS 值由宿主查表得到,插件的字符串永远不进 CSS。
 */
export const PLUGIN_SKIN_MAX_ENTRIES = 16

/**
 * CSS 标准命名色(148 个)+ `transparent`。
 *
 * 不含 `currentColor` / `inherit` / `initial` / `unset`:它们是**引用**而不是
 * 颜色字面量,语义随上下文漂移,不属于"插件声明了一个颜色"这件事。
 */
export const CSS_NAMED_COLORS: ReadonlySet<string> = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque', 'black',
  'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood', 'cadetblue', 'chartreuse',
  'chocolate', 'coral', 'cornflowerblue', 'cornsilk', 'crimson', 'cyan', 'darkblue', 'darkcyan',
  'darkgoldenrod', 'darkgray', 'darkgreen', 'darkgrey', 'darkkhaki', 'darkmagenta',
  'darkolivegreen', 'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise', 'darkviolet', 'deeppink',
  'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue', 'firebrick', 'floralwhite', 'forestgreen',
  'fuchsia', 'gainsboro', 'ghostwhite', 'gold', 'goldenrod', 'gray', 'green', 'greenyellow',
  'grey', 'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral', 'lightcyan',
  'lightgoldenrodyellow', 'lightgray', 'lightgreen', 'lightgrey', 'lightpink', 'lightsalmon',
  'lightseagreen', 'lightskyblue', 'lightslategray', 'lightslategrey', 'lightsteelblue',
  'lightyellow', 'lime', 'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine',
  'mediumblue', 'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue', 'mintcream',
  'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace', 'olive', 'olivedrab', 'orange',
  'orangered', 'orchid', 'palegoldenrod', 'palegreen', 'paleturquoise', 'palevioletred',
  'papayawhip', 'peachpuff', 'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple',
  'red', 'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen',
  'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray', 'slategrey', 'snow',
  'springgreen', 'steelblue', 'tan', 'teal', 'thistle', 'tomato', 'transparent', 'turquoise',
  'violet', 'wheat', 'white', 'whitesmoke', 'yellow', 'yellowgreen',
])

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`。 */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/**
 * 函数式颜色。括号内的字符类**不含括号**,因此 `var(`/`url(`/`calc(`/
 * `expression(` 天然无法出现;`;` `}` `"` `'` `\` 同样不在字符类里。
 */
const FUNCTIONAL_COLOR_PATTERN = /^(?:rgba?|hsla?|oklch|oklab)\([0-9a-z.,%/ +-]*\)$/i

/** 命名色只可能是纯字母。 */
const NAMED_COLOR_PATTERN = /^[a-z]+$/i

/**
 * 一个覆盖值是否是被放行的颜色字面量。
 *
 * 非字符串、空串、超长、含括号嵌套/分号/花括号的一律 false —— 调用方据此
 * **丢弃该条目**(降级),而不是拒载整个插件(与未知锚点同规)。
 */
export function isPluginThemeColorValue(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed) return false
  if (trimmed.length > PLUGIN_THEME_COLOR_MAX_LENGTH) return false
  if (HEX_COLOR_PATTERN.test(trimmed)) return true
  if (FUNCTIONAL_COLOR_PATTERN.test(trimmed)) return true
  if (NAMED_COLOR_PATTERN.test(trimmed)) return CSS_NAMED_COLORS.has(trimmed.toLowerCase())
  return false
}

/** 归一化:白名单通过后统一用 trim 后的值(前后空白不是语义)。 */
export function normalizePluginThemeColorValue(value: string): string {
  return value.trim()
}
