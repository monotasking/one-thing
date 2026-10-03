/**
 * 宿主版本 —— `minAppVersion` 判定的唯一输入。
 *
 * 晚绑端口而不是读 package.json:装配层跑在四个宿主里(Electron 打包后
 * package.json 不在可预测的相对位置,server/CLI 又各有各的入口),版本只有
 * 宿主自己知道。没配 = 判定跳过(拿不到版本不是拒绝加载插件的理由)。
 */
let appVersion: string | undefined

export function configurePluginAppVersion(version: string | undefined): void {
  const normalized = version?.trim()
  appVersion = normalized || undefined
}

export function getPluginAppVersion(): string | undefined {
  return appVersion
}
