import { useMemo } from 'react'
import { useStageStore } from '../stage/store'
import { zh } from './zh'
import { en } from './en'

/**
 * 自建 i18n:零依赖、类型安全、无运行时兜底。
 *
 * 三条规矩:
 * 1. zh.ts 是键的**定义处**(`as const`),MessageKey = keyof typeof zh;
 *    en.ts 声明成 Record<MessageKey, string> —— 漏译在 typecheck 就红,不到运行时。
 * 2. 组件里不落字面 UI 文案(与不落字面色值同级,见 styles/global.css 顶部铁律),
 *    组件用 useT();非组件上下文(纯函数 / 投影)用 t()。
 * 3. locale 存在 stage store 的设置里并持久化,'system' 用 navigator.language 判 zh 前缀。
 *
 * ── 边界:什么进字典,什么不进 ────────────────────────────────────────────
 * 进:界面外壳文案 —— 按钮、菜单项、分段器选项、占位符、aria-label、字段标签、
 *     快捷键条说明、面包屑、组头(「独立会话」「不属于任何项目」)、kind 徽文本。
 * 不进:**模拟的用户数据** —— 会话标题 / 摘要 / 章节 / 消息正文、终端输出、
 *     diff 内容、文件树条目、项目名与路径。它们是「这批 mock 的事实」,不是界面文案,
 *     原样留在数据文件里:expose/data.ts、data/chat-mock.ts、content/*Mock.tsx。
 * 判据只有一句:**换一门语言,它该不该跟着变?** 该 → 进字典;不该 → 留 mock。
 * ──────────────────────────────────────────────────────────────────────
 */
export type MessageKey = keyof typeof zh

/** 用户能选的三档;'system' 不是一种语言,是「问浏览器」。 */
export type Locale = 'system' | 'zh' | 'en'

/** 解析之后的真实语言 —— 字典只认这两个。 */
export type Lang = 'zh' | 'en'

export type MessageVars = Record<string, string | number>
export type TFn = (key: MessageKey, vars?: MessageVars) => string

const DICTS: Record<Lang, Record<MessageKey, string>> = { zh, en }

export const LOCALES: Locale[] = ['system', 'zh', 'en']

/** 'system' 只在这里被翻译成一门真语言,别处不许再判一次 navigator。 */
export function resolveLang(locale: Locale): Lang {
  if (locale !== 'system') return locale
  const nav = typeof navigator === 'undefined' ? '' : navigator.language
  return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** {name} 形插值。没给的占位原样留着 —— 不静默吞,方便一眼看出漏传。 */
export function format(template: string, vars?: MessageVars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  )
}

export function translate(lang: Lang, key: MessageKey, vars?: MessageVars): string {
  return format(DICTS[lang][key], vars)
}

/**
 * 非组件上下文用的 t:当场读一次 store。
 * 组件里别用它 —— 它不订阅,切语言不会重渲染;组件用 useT()。
 */
export function t(key: MessageKey, vars?: MessageVars): string {
  return translate(resolveLang(useStageStore.getState().locale), key, vars)
}

/**
 * 单复数:英文里「1 session / 3 sessions」是两句话,中文里是同一句。
 * 全仓只有两处计数文案,不值得引进 Intl.PluralRules —— 两个键,按数选一个。
 * 真要长出第三处、第四处再谈把它换成规则表。
 */
export function plural(count: number, one: MessageKey, many: MessageKey): MessageKey {
  return count === 1 ? one : many
}

/** 组件用的 t:订阅 locale,切语言当场生效。 */
export function useT(): TFn {
  const locale = useStageStore((st) => st.locale)
  return useMemo(() => {
    const lang = resolveLang(locale)
    return (key: MessageKey, vars?: MessageVars) => translate(lang, key, vars)
  }, [locale])
}
