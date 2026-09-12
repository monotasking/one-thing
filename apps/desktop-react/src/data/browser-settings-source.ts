import { createMutation, createQuery, type Mutation } from './kernel'
import { browserSettingsPort } from './browser-settings-port'
import { notify } from '../services/notify'
import { t } from '../i18n'
import { DEFAULT_BROWSER_CDP_PORT, type AppSettings } from '@shared/ipc/settings'
import type { MCPServerConfig } from '@shared/ipc/mcp'

/**
 * 设置页「内置浏览器」那一节的取数与两条写路(B2′,方案
 * `apps/desktop-react/docs/terminal-browser-2026-09.md` §2.2-5)。
 *
 * ── 屏幕上那一节要的形状 ──────────────────────────────────────────────────
 * 整份 `AppSettings` 不是这一节的形状:它只问三件事 —— 调试口开着没有、开在
 * 哪个口、那条 MCP 装过没有。所以「线上形状 → 屏幕形状只投一次」(与
 * `permission-grants-source` 的排序、`agents-source` 的 `toAgentOption` 同判),
 * 投影住在这里,渲染层拿到的是一个三格的小对象。
 *
 * ── 两条写路都「当场读一份新的」再整份写回 ────────────────────────────────
 * `settings.saveSettings` 收整份,而这一节手上那份是**缓存**(可能已经旧了:
 * 别的面刚改过主题、刚存过一把 key)。拿缓存当底本写回去 = 把别人那一格抹掉。
 * 所以两条写路的第一句都是 `readSettings()`,与 provider 面那条
 * 「先读整份 → 合并一格 → 整份写回」的纪律逐字相同。
 */

/** 那条 MCP 的 id 与展示名。**一处产地** —— 判「装过没有」与写它的人读同一个串。 */
export const CHROME_DEVTOOLS_MCP_ID = 'chrome-devtools'

/**
 * 屏幕上那一节的形状。
 *
 * `port` 在 UI 上**不可改**(「设置极简」:技术参数走默认值),但它要露脸 ——
 * 复制给 Claude Code / Cursor 的那个片段里有它,一句「装在 9333」比一个藏起来
 * 的数字诚实。
 */
export interface BrowserCdpView {
  enabled: boolean
  port: number
  /** MCP 名册里已经有 `chrome-devtools` 那一条了吗。 */
  mcpInstalled: boolean
}

/** 整份设置 → 这一节要的三格。纯函数:投影不是画画。 */
export function toBrowserCdpView(settings: Pick<AppSettings, 'browser' | 'mcp'>): BrowserCdpView {
  const cdp = settings.browser?.cdp
  return {
    enabled: cdp?.enabled === true,
    // 归一那一层保证它是合法端口;这里的回落只为「后端答的那份压根没有这一段」
    // 那一格(老 store、被手改过的 settings.json)。
    port: typeof cdp?.port === 'number' && cdp.port > 0 ? cdp.port : DEFAULT_BROWSER_CDP_PORT,
    mcpInstalled: hasChromeDevtoolsMcp(settings.mcp?.servers),
  }
}

/** 名册里有没有那一条。**按 id 判**,不按名字 —— 名字是人写的,id 是身份。 */
export function hasChromeDevtoolsMcp(servers: readonly MCPServerConfig[] | undefined): boolean {
  return (servers ?? []).some((server) => server.id === CHROME_DEVTOOLS_MCP_ID)
}

/**
 * 要往 MCP 名册里写的那一条。
 *
 * `npx -y`:没有 `-y` 的话 npx 在没装过这个包时会停下来问一句 yes/no,而 MCP
 * 的 stdio 握手那一侧没有人回答它 —— 表现是「装上了但连不上」。
 *
 * `--browserUrl` 指的是**内置浏览器的调试口**,不是让它自己拉一个 Chrome 起来:
 * 这一整格的意思就是「让 AI 驱动**这台**浏览器」(登着账号的那台)。
 */
export function chromeDevtoolsMcpConfig(port: number): MCPServerConfig {
  return {
    id: CHROME_DEVTOOLS_MCP_ID,
    name: CHROME_DEVTOOLS_MCP_ID,
    transport: 'stdio',
    enabled: true,
    command: 'npx',
    args: ['-y', 'chrome-devtools-mcp@latest', '--browserUrl', `http://127.0.0.1:${port}`],
  }
}

/**
 * 复制给 Claude Code / Cursor 的那段配置。
 *
 * **不是 i18n 文案,是数据** —— 它是要贴进别人配置文件里的 JSON,换一门语言
 * 不该跟着变(判据见 `i18n/index.ts` 顶部)。两家今天都认 `mcpServers` 这个形。
 */
export function chromeDevtoolsMcpSnippet(port: number): string {
  const config = chromeDevtoolsMcpConfig(port)
  return `${JSON.stringify(
    {
      mcpServers: {
        [CHROME_DEVTOOLS_MCP_ID]: { command: config.command, args: config.args },
      },
    },
    null,
    2,
  )}\n`
}

export const browserCdpQuery = createQuery<BrowserCdpView>('browserSettings.cdp', async () => {
  const port = await browserSettingsPort()
  const response = await port.readSettings()
  // `success:false` 是「后端说不行」—— 抛出去,kernel 记进 error 并**留住上一份**
  // (律②)。回一个「关着」会把「拉不到」画成「你没开过」,那是编。
  if (!response.success || !response.settings) {
    throw new Error(response.error || 'settings.getSettings 未成功')
  }
  return toBrowserCdpView(response.settings)
})

/** 读一份**新的**整份设置当底本。两条写路共用 —— 拼两遍就是两处会漂。 */
async function readSettingsForWrite(): Promise<AppSettings> {
  const port = await browserSettingsPort()
  const response = await port.readSettings()
  if (!response.success || !response.settings) {
    throw new Error(response.error || 'settings.getSettings 未成功')
  }
  return response.settings
}

async function saveSettings(next: AppSettings): Promise<void> {
  const port = await browserSettingsPort()
  const response = await port.saveSettings(next)
  if (!response.success) throw new Error(response.error || 'settings.saveSettings 未成功')
}

/**
 * 开 / 关调试口。
 *
 * **就地更新**(律①):`optimistic` 当场把屏上那一格翻过去(交出来的函数就是
 * 回滚),`settle` 再 `invalidate()` 后台对账 —— 没有「清空 → 骨架 → 重灌」。
 *
 * 这条路**只写设置**。真正落成 Chromium 开关的是主进程:它订 `settings:changed`
 * 把这一格折成 `<store>/run/cdp.json`,下次启动 `ready` 之前读它
 * (`electron/browser/cdp-settings.ts`)。所以那一行的副文案必须说「重启生效」。
 */
export const setBrowserCdpEnabledMutation: Mutation<boolean, void> = createMutation<boolean, void>(
  'browserSettings.setCdpEnabled',
  {
    optimistic: (enabled) =>
      browserCdpQuery.patch((prev) => (prev ? { ...prev, enabled } : prev)),
    run: async (enabled) => {
      const current = await readSettingsForWrite()
      await saveSettings({
        ...current,
        browser: {
          ...current.browser,
          cdp: {
            enabled,
            port: current.browser?.cdp?.port ?? DEFAULT_BROWSER_CDP_PORT,
          },
        },
      })
    },
    onError: (error) => {
      notify({
        level: 'error',
        source: 'settings.browser',
        title: t('browser.cdpSaveFailed'),
        body: error.message,
        detail: error.message,
      })
    },
    settle: () => browserCdpQuery.invalidate(),
  },
)

/**
 * 「给 AI 装上」= 往 MCP 名册里追加一条 `chrome-devtools`。
 *
 * **已经有了就一个字都不写**(判据按 id,见 `hasChromeDevtoolsMcp`)。重复写的
 * 后果不是多一条:MCP 域按 id 认服务器,第二条同 id 会把用户可能改过的那一条
 * (换了端口、加了 env)原样盖掉 —— 一颗「装上」的钮不该有覆盖的权力。
 * 钮那一侧也照这一格变成「已装上 · disabled」,两处同一个判据、同一个产地。
 *
 * **没有乐观补丁**:这一发要先读一份新设置才知道写什么,而「装上了」这件事的
 * 可见结果就是钮自己变成「已装上」—— `settle` 的对账回来那一拍它就变了,
 * 中间那几百毫秒 `AsyncButton` 已经在说「安装中…」。先斩后奏地把钮画成「已装上」
 * 然后发现后端拒了,是骗。
 */
export const installChromeDevtoolsMcpMutation: Mutation<void, void> = createMutation<void, void>(
  'browserSettings.installChromeDevtoolsMcp',
  {
    run: async () => {
      const current = await readSettingsForWrite()
      const servers = current.mcp?.servers ?? []
      if (hasChromeDevtoolsMcp(servers)) return
      const port = current.browser?.cdp?.port ?? DEFAULT_BROWSER_CDP_PORT
      await saveSettings({
        ...current,
        mcp: {
          // `enabled` 缺席时给 true:一个人刚点了「给 AI 装上」,而 MCP 总开关
          // 从来没被表过态 —— 那一格的缺省本来就是 true(`DEFAULT_MCP_SETTINGS`)。
          enabled: current.mcp?.enabled ?? true,
          ...current.mcp,
          servers: [...servers, chromeDevtoolsMcpConfig(port)],
        },
      })
    },
    onError: (error) => {
      notify({
        level: 'error',
        source: 'settings.browser',
        title: t('browser.mcpInstallFailed'),
        body: error.message,
        detail: error.message,
      })
    },
    settle: () => browserCdpQuery.invalidate(),
  },
)

/**
 * **HMR 退役**(壳规范「模块级副作用必须配 HMR dispose」,09-01 立法)。
 *
 * 这个文件的模块级副作用有三样:那只 query(自带监听表与缓存)与两只 mutation
 * (各自带监听表与逐格计数)。三样的寿命都是「这个模块实例」—— 不退役,旧实例
 * 的监听表会攥着已卸载组件的回调。退役**复用它们各自已有的那一口拆卸**
 * (`reset()`),不写第二套。生产构建里 `import.meta.hot` 是 undefined,整段被
 * tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    browserCdpQuery.reset()
    setBrowserCdpEnabledMutation.reset()
    installChromeDevtoolsMcpMutation.reset()
  })
}
