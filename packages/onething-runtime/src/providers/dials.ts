/**
 * 计费档位(「旋钮」)的形状与三家的数据 —— 批 M(`docs/design/provider-settings-rework-2026-09.md`
 * §5.2)从壳的 `apps/desktop-react/src/providers/dials.ts` 搬进来,挂在各家的
 * `ProviderManifest.dials` 上。壳那边只剩「按 manifest 读」的几个帮手。
 *
 * ── 为什么这张表不进 i18n 字典 ────────────────────────────────────────────
 * 两条理由,都不是省事:
 *  ① 档位的**取值**(`standard` / `token-plan` / `coding-plan` / `cn` / `intl`)
 *     是写进设置文件、再被 runtime 拿去算 baseUrl 的**数据**。数据不翻译。
 *  ② 选项名与风险说明是**逐字**从生产那张表搬过来的,连全角逗号都没动。选错档位
 *     是**真扣钱**的:用按量的 Key 和地址去调订阅,会在订阅之外再按量扣一次。
 *     一句被翻译得稍软的警告 = 一笔真金白银。所以这几句话按「不许漂」处理。
 *
 * ── 归一必须借用各家自己的那几个函数 ─────────────────────────────────────
 * `normalize` 与 `baseUrlOf` 一律转手各家 `vendors/<id>/endpoint.ts`:
 * 同一件事开第二个产地,而这件事错一次的代价是钱。
 *
 * 各家的那张表(`<ID>_DIALS`)住在各家的 `vendors/<id>/manifest.ts`(服务商自述试点
 * P1 / P2);这里只剩形状。
 *
 * 本文件是**纯**模块(壳也 import 它):不许碰 node / electron / `process`。
 */

export interface DialOption {
  value: string
  label: string
}

export interface DialField {
  /** 行首那个标签。 */
  label: string
  /** 无障碍名。测试也靠它定位。 */
  ariaLabel: string
  options: DialOption[]
  /** 归一到合法取值(缺省值由它给)。 */
  normalize(value: unknown): string
  /**
   * 这一格此刻有没有意义(Kimi 的编程套餐只有一个全球地址)。缺省恒 true。
   * 返回 false 时**整行收起**,而不是留一个拨了不动的选择器。
   */
  appliesTo?(apiMode: string): boolean
}

export interface DialSpec {
  apiMode: DialField
  region?: DialField
  /** 档位落在 provider 配置上的哪一格(`qwenApiMode` / `kimiApiMode` / `zhipuApiMode`)。 */
  apiModeKey: string
  /** 地区落在哪一格。没有地区的家(智谱)缺席。 */
  regionKey?: string
  /** 选择器下面那句话。说的是**选错的代价**,不是功能介绍。 */
  note?: string
  /**
   * 这一对档位算出来的端点。写设置时**必须连 baseUrl 一起写** ——
   * 只写档位不写地址,请求还是发去旧地址,那正是「以为选对了、其实还在扣钱」。
   */
  baseUrlOf(apiMode: string, region: string): string
}
