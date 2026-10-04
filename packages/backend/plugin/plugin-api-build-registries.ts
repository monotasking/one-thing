/**
 * 插件 API 里开放给插件的四个宿主注册表(IM 连接器、搜索供给方、深链动作、凭证策略):同一套形状门 / 声明门 / 拆除闩 / 退订进 `disposeCallbacks`。
 *
 * 从 `plugin-api-builder.ts` 按面拆出(大文件拆分批 2,2026-10-04):每一格的方法正文与拆分前一字不差,
 * 从前读闭包变量的地方,现在读开头从上下文(`plugin-api-context.ts`)解构出来的同名局部量。
 * 键的顺序不在这里定 —— `createCorePluginAPI` 按拆分前那只对象字面量的顺序拼。
 */
import {
  pluginScope,
  PLUGIN_PERMISSION_SEARCH_PROVIDE,
  type CorePluginSearchProviderRegistration,
  PLUGIN_CREDENTIAL_STRATEGY_NAME_PATTERN,
  PLUGIN_PERMISSION_CREDENTIAL_STRATEGY,
  pluginCredentialStrategyPolicy,
  type CorePluginCredentialStrategyRegistration,
} from '@onething/backend/plugin-contract'
import {
  PLUGIN_DEEPLINK_ACTION_NAME_PATTERN,
  PLUGIN_PERMISSION_DEEPLINK_HANDLE,
  pluginDeepLinkAddress,
  type CorePluginDeepLinkActionRegistration,
} from '@onething/backend/deeplink'
import type { CorePluginAPITypeArgs, PluginApiBuildContext } from './plugin-api-context.js'

export function buildPluginApiRegistries<T extends CorePluginAPITypeArgs>(ctx: PluginApiBuildContext<T>) {
  const { pluginId, host, logger, disposeCallbacks, declaredPermissions, reportFailure, rejectLateCall } = ctx

  return {
    /**
     * IM 连接器(R7 试点)。
     *
     * 三件宿主的事都在这里:disposed 闩(拆除之后再注册 = 往一个没人再会来清扫的
     * 表里塞东西)、退订函数收进 disposeCallbacks(插件不调也能拆干净)、
     * 失败进熔断账(scope `connector`,策略表判为 degrade-surface —— 一条渠道
     * 坏掉不该放大成插件故障)。
     */
    registerIMConnector(connector: { id?: unknown }): () => void {
      if (rejectLateCall('registerIMConnector')) return () => {}
      const rawId = String(connector?.id ?? '').trim()
      if (!rawId) {
        logger.error(`[Plugin:${pluginId}] registerIMConnector needs a connector with an id`, undefined)
        // 注册期违规是**代码错误**,与未声明的 panel id 同构 —— 归 registration
        // 家族(阈值 1),不是运行期的 connector 家族。
        reportFailure(pluginScope.registration('IMConnector'), new Error('connector without an id'))
        return () => {}
      }
      // 命名空间与 registerTool 同构:插件不能占用一个全局 id,更不能顶掉别人的。
      const connectorId = `plugin:${pluginId}:${rawId}`
      let unregister: (() => void) | undefined
      try {
        unregister = host.registerIMConnector?.(pluginId, { ...connector, id: connectorId })
      } catch (error) {
        logger.error(`[Plugin:${pluginId}] registerIMConnector("${connectorId}") failed:`, undefined, error)
        reportFailure(pluginScope.registration('IMConnector'), error)
        return () => {}
      }
      if (!unregister) {
        // 宿主没接这条线(headless / server / CLI daemon —— §6 方案 A 下只有
        // 桌面宿主执行插件)。如实告诉插件它被忽略了,而不是假装成功。
        logger.debug(`[Plugin:${pluginId}] IM connectors are not available on this host; "${connectorId}" was ignored`)
        return () => {}
      }
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        try {
          unregister?.()
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] Failed to unregister IM connector "${connectorId}":`, undefined, error)
        }
      }
      // 插件自己不调 release 也能拆干净 —— 拆除语义不建立在插件守规矩上。
      disposeCallbacks.push(release)
      logger.debug(`[Plugin:${pluginId}] Registered IM connector: ${connectorId}`)
      return release
    },

    /**
     * 搜索供给方(M2)。三件宿主的事,与 registerIMConnector 同构:
     *  - **声明门**:manifest 没声明 `search:provide` 就拒绝 —— 报错 + 返回 noop,
     *    **不计熔断**(那是作者写错了 manifest,与 sendMessage / interceptInput 同规:
     *    一次笔误不该连坐整个插件);
     *  - **disposed 闩**:拆除之后再注册 = 往一个没人再会来清扫的表里塞东西;
     *  - **退订进 disposeCallbacks**:插件不调也能拆干净。
     *
     * 并发 / 超时 / 熔断都在装配层的聚合器(它才认识健康账本);core 只做门控与
     * 转发。宿主没接这条线(headless / server / CLI daemon —— §6 方案 A)时如实
     * 告诉插件它被忽略了,而不是假装成功。
     */
    registerSearchProvider(registration: CorePluginSearchProviderRegistration): () => void {
      if (rejectLateCall('registerSearchProvider')) return () => {}
      const providerId = String(registration?.id ?? '').trim()
      const label = String(registration?.label ?? '').trim()
      if (!providerId || !label || typeof registration?.search !== 'function') {
        logger.error(
          `[Plugin:${pluginId}] registerSearchProvider needs { id, label, search() }`,
          undefined,
        )
        reportFailure(pluginScope.registration('SearchProvider'), new Error('malformed search provider'))
        return () => {}
      }
      if (!declaredPermissions.has(PLUGIN_PERMISSION_SEARCH_PROVIDE)) {
        logger.error(
          `[Plugin:${pluginId}] registerSearchProvider requires "${PLUGIN_PERMISSION_SEARCH_PROVIDE}" in `
          + 'contributes.permissions (plugin.json). Declare it first — the install page tells the user '
          + 'this plugin can contribute results to Search Everywhere.',
          undefined,
        )
        return () => {}
      }
      let unregister: (() => void) | undefined
      try {
        unregister = host.registerSearchProvider?.(pluginId, { ...registration, id: providerId, label })
      } catch (error) {
        logger.error(`[Plugin:${pluginId}] registerSearchProvider("${providerId}") failed:`, undefined, error)
        reportFailure(pluginScope.registration('SearchProvider'), error)
        return () => {}
      }
      if (!unregister) {
        logger.debug(
          `[Plugin:${pluginId}] Search providers are not available on this host; "${providerId}" was ignored`,
        )
        return () => {}
      }
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        try {
          unregister?.()
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] Failed to unregister search provider "${providerId}":`, undefined, error)
        }
      }
      disposeCallbacks.push(release)
      logger.debug(`[Plugin:${pluginId}] Registered search provider: ${providerId}`)
      return release
    },

    /**
     * 深链动作(H4)。第三个既有宿主动词面,五件事与前两个同构:
     *  - **形状**:`{ name, title, handler }` 三件全要,name 限 `[a-z0-9-]+` ——
     *    它要进 URL 路径,松一点就得在解析侧补一堆转义;
     *  - **声明门**:manifest 没声明 `deeplink:handle` 就拒绝 —— 报错 + 返回 noop,
     *    **不计熔断**(manifest 笔误不该连坐整个插件,与 sessions:* / search:provide 同规);
     *  - **disposed 闩**:拆除之后再注册 = 往一个没人再会来清扫的表里塞东西;
     *  - **退订进 disposeCallbacks**:插件不调也能拆干净;
     *  - **命名空间**:全局地址由宿主拼(`plugin:<id>:<name>`),插件抢不到别人的格子。
     *
     * 确认门、超时、熔断都在宿主侧(它们要认识窗口与健康账本);core 只做门控与
     * 转发。宿主没接这条线(headless / server / CLI daemon —— 它们连 URL scheme
     * 都没有)时如实告诉插件它被忽略了,而不是假装成功。
     */
    registerDeepLinkAction(registration: CorePluginDeepLinkActionRegistration): () => void {
      if (rejectLateCall('registerDeepLinkAction')) return () => {}
      const name = String(registration?.name ?? '').trim()
      const title = String(registration?.title ?? '').trim()
      if (!name || !title || typeof registration?.handler !== 'function') {
        logger.error(
          `[Plugin:${pluginId}] registerDeepLinkAction needs { name, title, handler() }`,
          undefined,
        )
        reportFailure(pluginScope.registration('DeepLinkAction'), new Error('malformed deep link action'))
        return () => {}
      }
      if (!PLUGIN_DEEPLINK_ACTION_NAME_PATTERN.test(name)) {
        logger.error(
          `[Plugin:${pluginId}] registerDeepLinkAction("${name}") — the name must match `
          + `${PLUGIN_DEEPLINK_ACTION_NAME_PATTERN} (it goes into a URL path).`,
          undefined,
        )
        reportFailure(pluginScope.registration('DeepLinkAction'), new Error(`illegal action name: ${name}`))
        return () => {}
      }
      if (!declaredPermissions.has(PLUGIN_PERMISSION_DEEPLINK_HANDLE)) {
        logger.error(
          `[Plugin:${pluginId}] registerDeepLinkAction requires "${PLUGIN_PERMISSION_DEEPLINK_HANDLE}" in `
          + 'contributes.permissions (plugin.json). Declare it first — the install page tells the user '
          + 'this plugin can be invoked by onething:// links from outside the app.',
          undefined,
        )
        return () => {}
      }
      const address = pluginDeepLinkAddress(pluginId, name)
      let unregister: (() => void) | undefined
      try {
        unregister = host.registerDeepLinkAction?.(pluginId, { ...registration, name, title })
      } catch (error) {
        logger.error(`[Plugin:${pluginId}] registerDeepLinkAction("${address}") failed:`, undefined, error)
        reportFailure(pluginScope.registration('DeepLinkAction'), error)
        return () => {}
      }
      if (!unregister) {
        logger.debug(
          `[Plugin:${pluginId}] Deep links are not available on this host; "${address}" was ignored`,
        )
        return () => {}
      }
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        try {
          unregister?.()
        } catch (error) {
          logger.error(`[Plugin:${pluginId}] Failed to unregister deep link action "${address}":`, undefined, error)
        }
      }
      disposeCallbacks.push(release)
      logger.debug(`[Plugin:${pluginId}] Registered deep link action: ${address}`)
      return release
    },

    /**
     * 凭证轮换策略(批 E)。第四个既有宿主动词面,五件事与前三个同构:
     *  - **形状**:`{ name, title, select }` 三件全要,name 限 `[a-z0-9-]+` ——
     *    它要进 `credentials.json` 的 `policy` 字段并被人眼读;
     *  - **声明门**:manifest 没声明 `credentials:strategy` 就拒绝 —— 报错 + 返回
     *    noop,**不计熔断**(manifest 笔误不该连坐整个插件,与 sessions:* /
     *    search:provide / deeplink:handle 同规);
     *  - **disposed 闩**:拆除之后再注册 = 往一个没人再会来清扫的表里塞东西;
     *  - **退订进 disposeCallbacks**:插件不调也能拆干净;
     *  - **命名空间**:policy 取值由宿主拼(`plugin:<id>:<name>`),插件抢不到
     *    别人的格子,也抢不到 `single` / `priority-failover` / `round-robin`
     *    这三个内置名(它们不含冒号,拼不出来)。
     *
     * 脱敏投影、超时预算、熔断降级、用量聚合都在装配层(它才认识凭证池与账本);
     * core 只做门控与转发。宿主没接这条线(headless / server / CLI daemon ——
     * 它们只有默认空间,没有凭证池)时如实告诉插件它被忽略了,而不是假装成功。
     */
    registerCredentialStrategy(
      registration: CorePluginCredentialStrategyRegistration,
    ): () => void {
      if (rejectLateCall('registerCredentialStrategy')) return () => {}
      const name = String(registration?.name ?? '').trim()
      const title = String(registration?.title ?? '').trim()
      if (!name || !title || typeof registration?.select !== 'function') {
        logger.error(
          `[Plugin:${pluginId}] registerCredentialStrategy needs { name, title, select() }`,
          undefined,
        )
        reportFailure(
          pluginScope.registration('CredentialStrategy'),
          new Error('malformed credential strategy'),
        )
        return () => {}
      }
      if (!PLUGIN_CREDENTIAL_STRATEGY_NAME_PATTERN.test(name)) {
        logger.error(
          `[Plugin:${pluginId}] registerCredentialStrategy("${name}") — the name must match `
          + `${PLUGIN_CREDENTIAL_STRATEGY_NAME_PATTERN} (it is stored as the pool's policy value).`,
          undefined,
        )
        reportFailure(
          pluginScope.registration('CredentialStrategy'),
          new Error(`illegal strategy name: ${name}`),
        )
        return () => {}
      }
      if (!declaredPermissions.has(PLUGIN_PERMISSION_CREDENTIAL_STRATEGY)) {
        logger.error(
          `[Plugin:${pluginId}] registerCredentialStrategy requires `
          + `"${PLUGIN_PERMISSION_CREDENTIAL_STRATEGY}" in contributes.permissions (plugin.json). `
          + 'Declare it first — the install page tells the user this plugin can choose which of '
          + 'their credentials a workspace uses (it never sees the key itself).',
          undefined,
        )
        return () => {}
      }
      const policy = pluginCredentialStrategyPolicy(pluginId, name)
      let unregister: (() => void) | undefined
      try {
        unregister = host.registerCredentialStrategy?.(pluginId, { ...registration, name, title })
      } catch (error) {
        logger.error(`[Plugin:${pluginId}] registerCredentialStrategy("${policy}") failed:`, undefined, error)
        reportFailure(pluginScope.registration('CredentialStrategy'), error)
        return () => {}
      }
      if (!unregister) {
        logger.debug(
          `[Plugin:${pluginId}] Credential strategies are not available on this host; `
          + `"${policy}" was ignored`,
        )
        return () => {}
      }
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        try {
          unregister?.()
        } catch (error) {
          logger.error(
            `[Plugin:${pluginId}] Failed to unregister credential strategy "${policy}":`,
            undefined, error,
          )
        }
      }
      disposeCallbacks.push(release)
      logger.debug(`[Plugin:${pluginId}] Registered credential strategy: ${policy}`)
      return release
    },
  }
}
