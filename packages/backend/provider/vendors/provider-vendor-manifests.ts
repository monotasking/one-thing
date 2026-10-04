/**
 * 内置服务商名册:**每家一行**(`docs/design/architecture-direction-2026-10.md` §3)。
 *
 * 加一家 = 建 `vendors/<id>/`、在这里加一行、在壳里加图标与文案。别处读字段,不点名
 * (`bun run provider:gate` 守着)。行序就是设置页与注册表里的顺序。
 *
 * 纯模块:壳也 import。行为那一半(方言、思考参数、运行时工厂)的名册在 `runtimes.ts`。
 */
import type { ProviderManifest } from '../provider-manifest.js'
import { CLAUDE_MANIFEST } from './claude/claude-manifest.js'
import { CLAUDE_CODE_MANIFEST } from './claude-code/claude-code-manifest.js'
import { CODEX_MANIFEST } from './codex/codex-manifest.js'
import { DEEPSEEK_MANIFEST } from './deepseek/deepseek-manifest.js'
import { GEMINI_MANIFEST } from './gemini/gemini-manifest.js'
import { GITHUB_COPILOT_MANIFEST } from './github-copilot/github-copilot-manifest.js'
import { GROK_MANIFEST } from './grok/grok-manifest.js'
import { GROK_OAUTH_MANIFEST } from './grok-oauth/grok-oauth-manifest.js'
import { KIMI_MANIFEST } from './kimi/kimi-manifest.js'
import { KIMI_CODE_MANIFEST } from './kimi-code/kimi-code-manifest.js'
import { OPENAI_MANIFEST } from './openai/openai-manifest.js'
import { OPENROUTER_MANIFEST } from './openrouter/openrouter-manifest.js'
import { QWEN_MANIFEST } from './qwen/qwen-manifest.js'
import { ZHIPU_MANIFEST } from './zhipu/zhipu-manifest.js'

export const VENDOR_MANIFESTS: readonly ProviderManifest[] = [
  OPENAI_MANIFEST,
  CLAUDE_MANIFEST,
  DEEPSEEK_MANIFEST,
  KIMI_MANIFEST,
  ZHIPU_MANIFEST,
  QWEN_MANIFEST,
  OPENROUTER_MANIFEST,
  GEMINI_MANIFEST,
  CLAUDE_CODE_MANIFEST,
  GROK_MANIFEST,
  GROK_OAUTH_MANIFEST,
  KIMI_CODE_MANIFEST,
  GITHUB_COPILOT_MANIFEST,
  CODEX_MANIFEST,
]

/**
 * 出厂种子表(各家 manifest 的 `seed`)的**键序**。与上面的设置页顺序不同,是因为今天这几家照搬的是
 * P3 之前 `@shared/defaults/settings.ts` 默认表的历史键序 —— 设置文件里的键序就是它,而读设置的代码里
 * 有按键序取第一家的(`agent-loop/agent-loop-title.ts` 的兜底、CLI 的 provider 列表),键序也是行为。
 *
 * **加一家不用碰这里**(P5 演练发现的那一处多余登记):历史那几家按历史键序排在前面,名册里其余带 `seed`
 * 的家按名册顺序接在后面,没有 `seed` 的家排在最末、拼表时跳过。
 */
const HISTORICAL_SEED_ORDER: readonly ProviderManifest[] = [
  OPENAI_MANIFEST,
  CLAUDE_MANIFEST,
  DEEPSEEK_MANIFEST,
  KIMI_MANIFEST,
  KIMI_CODE_MANIFEST,
  ZHIPU_MANIFEST,
  QWEN_MANIFEST,
  OPENROUTER_MANIFEST,
  GEMINI_MANIFEST,
  CLAUDE_CODE_MANIFEST,
  GITHUB_COPILOT_MANIFEST,
  CODEX_MANIFEST,
]

export const VENDOR_SEED_ORDER: readonly ProviderManifest[] = [
  ...HISTORICAL_SEED_ORDER,
  ...VENDOR_MANIFESTS.filter((manifest) => manifest.seed && !HISTORICAL_SEED_ORDER.includes(manifest)),
  ...VENDOR_MANIFESTS.filter((manifest) => !manifest.seed && !HISTORICAL_SEED_ORDER.includes(manifest)),
]

/**
 * 家族:同一家服务商的两条凭证通道 —— API 那一半与订阅那一半(服务商自述试点 P4,接替了
 * `@shared/provider-families` 里那张写死的表)。**每个家族一行**,写的是两半的 manifest,
 * 不是 id 字面量。两半各自在 manifest 里声明自己是哪一半(`family.role`,订阅那一半再带
 * `tag`);`provider-builtin-manifests.ts` 据此算出 `sibling` / `familyTag` 与下发的 `ProviderInfo.family`,
 * 并核对两边的 `role` 对得上。
 *
 * 为什么登记在这里而不是让半边自己写「我是谁的另一半」:那样 codex 的家里就得认识 openai,
 * 而一家的家里不许点别家的名(`provider:gate`)。名册本来就是每家都点名的登记处。
 */
export const VENDOR_FAMILIES: ReadonlyArray<{ api: ProviderManifest; subscription: ProviderManifest }> = [
  { api: GROK_MANIFEST, subscription: GROK_OAUTH_MANIFEST },
  { api: OPENAI_MANIFEST, subscription: CODEX_MANIFEST },
  { api: CLAUDE_MANIFEST, subscription: CLAUDE_CODE_MANIFEST },
  { api: KIMI_MANIFEST, subscription: KIMI_CODE_MANIFEST },
]
