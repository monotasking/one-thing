/**
 * 插件的**全局规范顺序** —— 一个出处,三处引用。
 *
 * 引用它的地方:锚点块的排列与超容量截断(renderer 侧镜像,见
 * `packages/renderer/workspace/ui-anchor-registry.ts`)、B 期主题 token 覆盖
 * 冲突的"后者胜"(`packages/backend/plugin/plugin-theme-overrides.ts`)。
 *
 * 规则:**跨插件按 pluginId 字典序,插件内保持 manifest 声明顺序**
 * (排序稳定,声明顺序自然保留)。
 *
 * 为什么不是目录发现序:目录遍历顺序随文件系统与安装先后变化,同一套插件
 * 在两台机器上会排出两种结果 —— UI 位置与"谁的主题覆盖生效"都会不一致。
 * 为什么不是 enabledAt:本仓库的启用状态是布尔开关(`settings.plugins`),
 * 盘上没有启用时刻,凭空造一个时间戳只会引入一份需要迁移的新状态。
 */

/** 稳定比较器:仅按 pluginId 字典序;相等时返回 0,由稳定排序保留原序。 */
export function comparePluginCanonicalOrder(a: string, b: string): number {
  return a.localeCompare(b)
}

/** 按全局规范顺序排序(不改原数组;同 pluginId 的相对顺序保留)。 */
export function sortByPluginCanonicalOrder<T>(
  items: readonly T[],
  getPluginId: (item: T) => string,
): T[] {
  return [...items].sort((a, b) => comparePluginCanonicalOrder(getPluginId(a), getPluginId(b)))
}
