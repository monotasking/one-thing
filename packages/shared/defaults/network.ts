import type { NetworkSettings } from '../ipc/settings.js'

/**
 * 网络代理的出厂值。
 *
 * 出厂设置整张表住在后端(`packages/backend/settings/defaults/settings-factory-defaults.ts`);只有这一格客户端
 * 也要 —— 网络设置页在后端还没答复之前拿它当占位值 —— 所以单独留在 shared,后端从这里取。
 */
export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = {
  proxy: {
    enabled: false,
    url: '',
    bypassRules: 'localhost;127.0.0.1;::1;*.local',
  },
}
