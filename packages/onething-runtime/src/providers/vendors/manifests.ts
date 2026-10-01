/**
 * 内置服务商名册:**每家一行**(`docs/design/architecture-direction-2026-10.md` §3)。
 *
 * 加一家 = 建 `vendors/<id>/`、在这里加一行、在壳里加图标与文案。别处读字段,不点名
 * (`bun run provider:gate` 守着)。行序就是设置页与注册表里的顺序。
 *
 * 纯模块:壳也 import。行为那一半(方言、思考参数、运行时工厂)的名册在 `runtimes.ts`。
 */
import type { ProviderManifest } from '../manifest.js'
import { CLAUDE_MANIFEST } from './claude/manifest.js'
import { CLAUDE_CODE_MANIFEST } from './claude-code/manifest.js'
import { CODEX_MANIFEST } from './codex/manifest.js'
import { DEEPSEEK_MANIFEST } from './deepseek/manifest.js'
import { GEMINI_MANIFEST } from './gemini/manifest.js'
import { GITHUB_COPILOT_MANIFEST } from './github-copilot/manifest.js'
import { GROK_MANIFEST } from './grok/manifest.js'
import { GROK_OAUTH_MANIFEST } from './grok-oauth/manifest.js'
import { KIMI_MANIFEST } from './kimi/manifest.js'
import { KIMI_CODE_MANIFEST } from './kimi-code/manifest.js'
import { OPENAI_MANIFEST } from './openai/manifest.js'
import { OPENROUTER_MANIFEST } from './openrouter/manifest.js'
import { QWEN_MANIFEST } from './qwen/manifest.js'
import { ZHIPU_MANIFEST } from './zhipu/manifest.js'

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
 * 出厂种子表(各家 manifest 的 `seed`)的**键序**。与上面的设置页顺序不同,是因为这张表
 * 照搬的是 P3 之前 `@shared/defaults/settings.ts` 默认表的历史键序 —— 设置文件里的键序就是它,
 * 而读设置的代码里有按键序取第一家的(`core/engine/title.ts` 的兜底、CLI 的 provider 列表),
 * 键序也是行为。没有 `seed` 的家(grok 两半)排在末尾、拼表时跳过。
 *
 * 加一家:这里末尾再加一行(`provider-seeds.test.ts` 钉着「每家恰好一次」)。
 */
export const VENDOR_SEED_ORDER: readonly ProviderManifest[] = [
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
  GROK_MANIFEST,
  GROK_OAUTH_MANIFEST,
]
