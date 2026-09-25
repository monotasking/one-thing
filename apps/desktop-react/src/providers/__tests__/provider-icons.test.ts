import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROVIDER_FAMILIES } from '@shared/provider-families'
import { BUILTIN_PROVIDER_MANIFESTS } from '@onething/runtime/providers/builtin-manifests'
import { PROVIDER_ICONS, providerIconOf } from '../provider-icons'

/**
 * 供应商图标表(09-14)。这张表是**数据**,所以门要守的也只有数据的两件事:
 * 键说的是不是真的存在的一家,素材有没有落单。
 *
 * 两份名单都**不在这里硬编码**:家族 id 读 `@shared/provider-families`,独立
 * 供应商 id 读 runtime 那张内置表 —— 抄第二份名单就是又开一个会漂的产地
 * (这块面从 09-01 起反复立的同一条)。
 *
 * 内置表 import 的是 `builtin-manifests.ts`(批 M):它是**纯**模块(不经 `codex.ts`,
 * 不吃 `@onething/core` 桶),壳本来就读它拿档位与家族,所以这里不再读源文本 ——
 * 常量引用的那几家(qwen / codex / acp)也一起进了名单,这条门不再偏严。
 */

const appRoot = process.cwd()
const assetsDir = resolve(appRoot, 'src/assets/providers')
const builtinIds = BUILTIN_PROVIDER_MANIFESTS.map((manifest) => manifest.id)

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
