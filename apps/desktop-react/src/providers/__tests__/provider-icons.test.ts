import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROVIDER_FAMILIES } from '@shared/provider-families'
import { PROVIDER_ICONS, providerIconOf } from '../provider-icons'

/**
 * 供应商图标表(09-14)。这张表是**数据**,所以门要守的也只有数据的两件事:
 * 键说的是不是真的存在的一家,素材有没有落单。
 *
 * 两份名单都**不在这里硬编码**:家族 id 读 `@shared/provider-families`,独立
 * 供应商 id 读 runtime 那张内置表 —— 抄第二份名单就是又开一个会漂的产地
 * (这块面从 09-01 起反复立的同一条)。
 *
 * 内置表是**读源文本**而不是 import 进来的:`builtin-providers.ts` 经 `codex.ts`
 * 吃整只 `@onething/core` 桶,那条链一路拉到 `core/engine/content/*.md?raw` ——
 * 为了一张 id 名单把引擎的提示词素材拖进壳的单测,既慢又把这条门绑在了别人的
 * 打包细节上(worktree 里它当场是 vite 的 “Denied ID”)。名单本身是平铺字面量,
 * 读它就够;`ONETHING_*_PROVIDER_ID` 那几家是常量引用、读不出来,而它们
 * (qwen / codex / acp)一家都不在这张图标表上,所以这条门只会**偏严**。
 */

const appRoot = process.cwd()
const assetsDir = resolve(appRoot, 'src/assets/providers')
const builtinSource = readFileSync(
  resolve(appRoot, '../../packages/onething-runtime/src/providers/builtin-providers.ts'),
  'utf8',
)
const builtinIds = [...builtinSource.matchAll(/\bid:\s*"([^"]+)"/g)].map((hit) => hit[1])

const knownIds = new Set([...PROVIDER_FAMILIES.map((family) => family.id), ...builtinIds])

describe('供应商图标表', () => {
  it('内置表真的读出来了 —— 名单空了这条门就不成其为门', () => {
    expect(builtinIds.length).toBeGreaterThan(10)
    expect(builtinIds).toContain('deepseek')
  })

  it('每个键都是真的存在的一家(家族 id 或内置 provider id)', () => {
    for (const key of Object.keys(PROVIDER_ICONS)) {
      expect(knownIds.has(key), `${key} 既不是家族 id 也不是内置 provider id`).toBe(true)
    }
  })

  it('每个值都是一条资源地址', () => {
    for (const [key, url] of Object.entries(PROVIDER_ICONS)) {
      expect(typeof url, key).toBe('string')
      expect(url.length, key).toBeGreaterThan(0)
    }
  })

  /*
   * 素材不许落单:`src/assets/providers/` 里每一只 svg 都得有人认领 —— 放进去却
   * 没上表 = 打包带着一只没人画的图标,而屏幕上还是首字母(正是这次报障那一形)。
   *
   * 判据是**互不相同的地址数 == svg 文件数**,不是按文件名在地址里找:这些 svg
   * 都小于 vite 的内联线,打出来是 `data:image/svg+xml,…`,文件名一个字都不在里面。
   * 多一只没上表的 svg → 文件数大于地址数 → 红。
   */
  it('素材目录里每一只 svg 都在表上', () => {
    const files = readdirSync(assetsDir).filter((name) => name.endsWith('.svg'))
    expect(files.length).toBeGreaterThan(0)
    expect(new Set(Object.values(PROVIDER_ICONS)).size).toBe(files.length)
  })

  /*
   * 同一家厂商的另一条接入路画同一枚标志 —— `claude-code-agent`(本机 CLI 那一坑)
   * 若在名册里自成一行,画的是 Claude,不是一个孤零零的 'C'。
   */
  it('claude-code-agent 与 claude 是同一枚', () => {
    expect(providerIconOf('claude-code-agent')).toBe(providerIconOf('claude'))
  })

  it('认不出的家答 undefined —— 消费方回落首字母', () => {
    expect(providerIconOf('custom:my-gateway')).toBeUndefined()
    expect(providerIconOf('qwen')).toBeUndefined()
    expect(providerIconOf('')).toBeUndefined()
  })

  /* 表上一行都不许是判断:加一家 = 一只 svg + 一行。 */
  it('四家 family 都认得出来', () => {
    for (const family of PROVIDER_FAMILIES) {
      expect(providerIconOf(family.id), family.id).toBeTruthy()
    }
  })
})
