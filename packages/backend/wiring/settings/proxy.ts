/**
 * 代理自检 —— 结构债 P4c 第十一批,一份实现服务两条旧路。
 *
 * 迁移前这段逻辑在仓里有**两份逐字相同的抄件**:
 *  - `apps/electron/src/main/ipc/network-proxy.ts` 的 `testProxy`(桌面 IPC);
 *  - `packages/backend/server/runtime.ts` 的 `testServerProxy`(`network` facade
 *    adapter 背后的 `POST /api/network/test-proxy`)。
 *
 * 两条通道合并成 `settingsRouter.testProxy` 之后,抄件也合成这一份(拍板 #20)。
 * 行为逐字保留:禁用即拒、URL 非法即拒、否则拿**归一化后的** URL 现造一只受管
 * fetch 打 `generate_204`,10s 超时,`ok || 204` 算通过。
 *
 * 它整只住在装配层而不是宿主:`createRequiredAppFetch` 与 `validateProxyUrl`
 * 都是 `backend/provider-binding/bound-fetch.ts` 的东西,没有一处 Electron 触点。
 * 真正要宿主的是**套用**代理(Electron session + 内嵌浏览器分区),那一半留在
 * `configureSettingsHost` 的 `applyNetworkProxySettings` 端口上。
 */
import type { ProxySettings, TestProxyResponse } from '@shared/ipc/settings.js'
import { createRequiredAppFetch, validateProxyUrl } from '../../provider-binding/bound-fetch.js'

export async function testOnethingProxy(proxy: ProxySettings): Promise<TestProxyResponse> {
  if (!proxy.enabled) {
    return { success: false, error: 'Proxy is disabled.' }
  }

  const validated = validateProxyUrl(proxy.url)
  if (!validated.valid) {
    return { success: false, error: validated.error }
  }

  try {
    const fetchImpl = createRequiredAppFetch({
      policy: 'default',
      proxy: {
        ...proxy,
        url: validated.normalizedUrl,
      },
    })
    const response = await fetchImpl('https://www.gstatic.com/generate_204', {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    })
    return response.ok || response.status === 204
      ? { success: true, status: response.status }
      : { success: false, status: response.status, error: `Proxy test returned HTTP ${response.status}.` }
  } catch (error: any) {
    return { success: false, error: error.message || 'Proxy test failed.' }
  }
}
