import claude from '../assets/providers/claude.svg'
import deepseek from '../assets/providers/deepseek.svg'
import gemini from '../assets/providers/gemini.svg'
import githubCopilot from '../assets/providers/github-copilot.svg'
import grok from '../assets/providers/grok.svg'
import kimi from '../assets/providers/kimi.svg'
import openai from '../assets/providers/openai.svg'
import openrouter from '../assets/providers/openrouter.svg'
import zhipu from '../assets/providers/zhipu.svg'

/**
 * 供应商家族 id → 图标资源 URL(09-14,用户报障「供应商只有字母」)。
 *
 * **这张表里没有一行判断** —— 加一家 = 放一只 svg + 在这里加一行。认不出的 id
 * (自定义家 `custom:xxx`、还没画图标的家)答 `undefined`,消费方回落首字母
 * (`projection.initialOf`)。「有没有图标」因此是一格**数据**,不是一段 if。
 *
 * 键 = 家族 id,也就是 `@shared/provider-families` 的 `PROVIDER_FAMILIES.id`
 * (grok / openai / claude / kimi 四家)或独立供应商自己的 provider id
 * (deepseek / zhipu / openrouter / gemini / github-copilot)。`claude-code-agent`
 * (本机 Claude Code Agent 那一坑)若在名册里自成一行,画的是 Claude 的图标 ——
 * 同一家厂商的另一条接入路,没有第二枚标志。
 *
 * 素材:`src/assets/providers/`,`@lobehub/icons-static-svg` 的**单色档**
 * (MIT,见那个目录的 LICENSE.md):`fill="currentColor"`、`viewBox 0 0 24 24`。
 * **彩色档不放** —— 壳的图标一律单色跟 `currentColor`(与 lucide 那一族同一条纪律)。
 */
export const PROVIDER_ICONS: Readonly<Record<string, string>> = {
  openai,
  claude,
  'claude-code-agent': claude,
  grok,
  kimi,
  deepseek,
  zhipu,
  openrouter,
  gemini,
  'github-copilot': githubCopilot,
}

/** 这一家有图标吗。没有(自定义家 / 认不出的 id)答 undefined,消费方回落首字母。 */
export function providerIconOf(familyId: string): string | undefined {
  return PROVIDER_ICONS[familyId]
}
