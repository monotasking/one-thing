import { getSettings } from '../../store.js'

/**
 * 外部 agent 子进程的环境:进程环境 + 应用代理(`settings.network.proxy`)。
 *
 * **两条外部 agent 通路共用这一个函数**(2026-09-24 从 `index.ts` 搬出来):Claude Code
 * SDK connector 经 `resolveSpawnEnv`,ACP 适配器经 `ACPManager.setSpawnEnvProvider`。
 * 从前只有前一条有,ACP 那条只继承进程环境 —— 用户报「而且没有走代理」。单独成文件
 * 是因为 `index.ts` 连着 Claude SDK connector,装配层要静态 import 这一句就不能把那一整只
 * 拖进来。
 *
 * 只填缺的:用户自己在环境里设了 `HTTPS_PROXY` 就尊重它。每次调用现读设置,所以改了
 * 代理之后**新起的**子进程就走新代理(已经在跑的那台不会中途换)。
 */
export function resolveExternalAgentSpawnEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env }
  const proxy = getSettings().network?.proxy
  if (proxy?.enabled && proxy.url) {
    env.HTTPS_PROXY = env.HTTPS_PROXY ?? proxy.url
    env.HTTP_PROXY = env.HTTP_PROXY ?? proxy.url
    env.https_proxy = env.https_proxy ?? proxy.url
    env.http_proxy = env.http_proxy ?? proxy.url
    if (proxy.bypassRules) {
      const noProxy = proxy.bypassRules.split(';').map(rule => rule.trim()).filter(Boolean).join(',')
      env.NO_PROXY = env.NO_PROXY ?? noProxy
      env.no_proxy = env.no_proxy ?? noProxy
    }
  }
  return env
}
