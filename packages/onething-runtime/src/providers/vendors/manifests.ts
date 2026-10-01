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
