import { createMutation, createQuery, type Mutation } from './kernel'
import { browserSettingsPort } from './browser-settings-port'
import { notify } from '../services/notify'
import { t } from '../i18n'
import {
  DEFAULT_BROWSER_CDP_PORT,
  DEFAULT_BROWSER_PROFILE_ID,
  type AppSettings,
  type BrowserProfile,
  type BrowserSettings,
} from '@shared/ipc/settings'
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
export interface BrowserSettingsView {
  enabled: boolean
  port: number
  /** MCP 名册里已经有 `chrome-devtools` 那一条了吗。 */
  mcpInstalled: boolean
  /**
   * 身份名册(B3-b)。**至少一行** —— 投影那一层就保证了,所以屏幕上永远有
   * 一格可选、叶檐那枚身份丸永远认得出自己是谁。
   */
  profiles: BrowserProfile[]
  /** 新 tab 缺省用哪一格身份。恒是名册里某一行的 id。 */
  defaultProfile: string
  /** 地址栏折 URL 用哪家搜索引擎(id;认不出由 `browser/omnibox` 回落)。 */
  searchEngine: string
}

/**
 * 整份设置 → 这一节要的六格。纯函数:投影不是画画。
 *
 * **名册的回落在这里做一次,而那不是与 defaults 重复**:`mergeWithDefaults` 归一
 * 的是**后端那一份**,而这只函数还要吃「后端答的那份压根没有 browser 这一段」
 * (老 store、被手改过的 `settings.json`、被裁过的响应)。空名册画到屏幕上是一张
 * 一行都没有、连删都删不掉的表 —— 一次取数的坏,不该变成一块用不了的面。
 */
export function toBrowserSettingsView(
  settings: Pick<AppSettings, 'browser' | 'mcp'>,
): BrowserSettingsView {
  const cdp = settings.browser?.cdp
  const profiles = (settings.browser?.profiles ?? []).filter((row) => Boolean(row?.id))
  const rows = profiles.length > 0 ? profiles : [{ id: DEFAULT_BROWSER_PROFILE_ID, name: '' }]
  const wanted = settings.browser?.defaultProfile
  return {
    enabled: cdp?.enabled === true,
    // 归一那一层保证它是合法端口;这里的回落只为「后端答的那份压根没有这一段」
    // 那一格(老 store、被手改过的 settings.json)。
    port: typeof cdp?.port === 'number' && cdp.port > 0 ? cdp.port : DEFAULT_BROWSER_CDP_PORT,
    mcpInstalled: hasChromeDevtoolsMcp(settings.mcp?.servers),
    profiles: rows,
    defaultProfile: rows.some((row) => row.id === wanted) ? wanted! : rows[0]!.id,
    searchEngine: settings.browser?.searchEngine || 'google',
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

export const browserSettingsQuery = createQuery<BrowserSettingsView>('browserSettings', async () => {
  const port = await browserSettingsPort()
  const response = await port.readSettings()
  // `success:false` 是「后端说不行」—— 抛出去,kernel 记进 error 并**留住上一份**
  // (律②)。回一个「关着」会把「拉不到」画成「你没开过」,那是编。
  if (!response.success || !response.settings) {
    throw new Error(response.error || 'settings.getSettings 未成功')
  }
  return toBrowserSettingsView(response.settings)
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
 * **`settings.browser` 那一整段的补丁器 —— 四条写路共用的唯一一手**(B3-b)。
 *
 * `BrowserSettings` 上每一格都是必填的(契约那么定,理由是「缺席的那一格会被
 * 静默丢弃」那条判例),而后端答回来的那份可能整格没有 `browser`(老 store)。
 * 于是每条写路都得先把六格补齐再改自己那一格 —— 四处各拼一遍就是四处会漂。
 * 这里拼一次:**先投影成屏幕形状(那只函数已经带着全部回落),再折回线上形状**。
 */
function patchBrowserSettings(
  current: AppSettings,
  patch: Partial<BrowserSettings>,
): BrowserSettings {
  const view = toBrowserSettingsView(current)
  return {
    cdp: { enabled: view.enabled, port: view.port },
    profiles: view.profiles,
    defaultProfile: view.defaultProfile,
    searchEngine: view.searchEngine,
    ...patch,
  }
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
      browserSettingsQuery.patch((prev) => (prev ? { ...prev, enabled } : prev)),
    run: async (enabled) => {
      const current = await readSettingsForWrite()
      await saveSettings({
        ...current,
        browser: patchBrowserSettings(current, {
          cdp: { enabled, port: current.browser?.cdp?.port ?? DEFAULT_BROWSER_CDP_PORT },
        }),
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
    settle: () => browserSettingsQuery.invalidate(),
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
    settle: () => browserSettingsQuery.invalidate(),
  },
)

/* ══════════════════════════════════════════════════════════════════════════
 * 身份名册(B3-b)
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **名册是一格数据,写它就是写整张表** —— 所以「新建 / 改名 / 删 / 换缺省」
 * 四件事**不是四条写路**:四只纯函数各算出「下一张表」,一条写路把它交出去。
 *
 * 这么切的两个好处都是硬的:①四件事的判据(新 id 怎么起、删到只剩一格怎么办、
 * 删掉的正好是缺省那一格怎么办)全是纯函数,单测不必起一台 core;②写路只有
 * 一条,于是「先读一份新的整份设置当底本」那条纪律只写一遍。
 *
 * 后果(关 tab + 清分区)**不在这条路上**:壳这边只写名册,主进程订
 * `settings:changed` 自己折(`electron/browser/profiles.ts`)。壳没有 session,
 * 也没有 tab 的真源 —— 让它去做那两步就是第二份真相。
 */

/** 名册那一张表(线上形状的两格)。四只纯函数进出的都是它。 */
export interface BrowserProfileTableView {
  profiles: BrowserProfile[]
  defaultProfile: string
}

/**
 * 新身份的 id。**随机而不是按名字**:名字是人写的字(可以重、可以改、可以是
 * 一串 emoji),而 id 直接拼进分区名 `persist:browser-<id>` —— 按名字派生会让
 * 「改个名」变成「换一个分区」,那等于把登录态删了。
 *
 * 字符集与归一那一层的 `[A-Za-z0-9_-]` 对齐(`@shared/defaults/settings.ts`)。
 */
export function nextBrowserProfileId(existing: readonly BrowserProfile[]): string {
  const taken = new Set(existing.map((row) => row.id))
  for (let i = 0; i < 1000; i += 1) {
    const id = `p${Math.random().toString(36).slice(2, 8)}`
    if (!taken.has(id)) return id
  }
  // 走不到(1000 次都撞上)。留一句诚实的回落,而不是一个可能重复的 id。
  return `p${Date.now().toString(36)}`
}

/** 加一格。缺省**不动** —— 新建一个身份不等于要用它。 */
export function addBrowserProfile(table: BrowserProfileTableView, name: string): BrowserProfileTableView {
  const id = nextBrowserProfileId(table.profiles)
  return { ...table, profiles: [...table.profiles, { id, name: name.slice(0, 64) }] }
}

/** 改名。认不出的 id 是恒等(而不是悄悄新增一行)。 */
export function renameBrowserProfile(
  table: BrowserProfileTableView,
  id: string,
  name: string,
): BrowserProfileTableView {
  return {
    ...table,
    profiles: table.profiles.map((row) => (row.id === id ? { ...row, name: name.slice(0, 64) } : row)),
  }
}

/**
 * 删一格。
 *
 * **两条硬规矩**:①名册删到空就没有任何一格 tab 跑得起来 —— 只剩一行时这一下
 * 是**恒等**(UI 那边也不画那颗钮,两处同一个判据、这里是产地);②删掉的正好
 * 是缺省那一格时,缺省落到剩下的第一行 —— 留着一个指向已删身份的缺省,后果是
 * 每开一格新 tab 都落进一个现建的空分区,而用户以为自己还登着。
 */
export function removeBrowserProfile(table: BrowserProfileTableView, id: string): BrowserProfileTableView {
  if (table.profiles.length <= 1) return table
  const profiles = table.profiles.filter((row) => row.id !== id)
  if (profiles.length === table.profiles.length) return table
  return {
    profiles,
    defaultProfile: profiles.some((row) => row.id === table.defaultProfile)
      ? table.defaultProfile
      : profiles[0]!.id,
  }
}

/** 换缺省。不在名册里的 id 是恒等。 */
export function setDefaultBrowserProfile(
  table: BrowserProfileTableView,
  id: string,
): BrowserProfileTableView {
  return table.profiles.some((row) => row.id === id) ? { ...table, defaultProfile: id } : table
}

/**
 * 把一张算好的名册交出去。
 *
 * **就地更新**(律①):`optimistic` 当场把屏上那张表换过去 —— 新建一格身份
 * 之后那一行要马上出现(人接着就要给它改名)。回滚由 `patch` 交回来。
 *
 * `key` 取 `defaultProfile` 之外的一格身份 id 不合适(一次写动的是整张表),
 * 所以**不分格**:这一格的 pending 是整张表的 pending,而屏幕上它落在被按的
 * 那颗钮上(`AsyncButton` / `Switch` 自禁)。
 */
export const saveBrowserProfilesMutation: Mutation<BrowserProfileTableView, void> = createMutation<
  BrowserProfileTableView,
  void
>('browserSettings.saveProfiles', {
  optimistic: (table) =>
    browserSettingsQuery.patch((prev) =>
      prev ? { ...prev, profiles: table.profiles, defaultProfile: table.defaultProfile } : prev,
    ),
  run: async (table) => {
    const current = await readSettingsForWrite()
    await saveSettings({
      ...current,
      browser: patchBrowserSettings(current, {
        profiles: table.profiles,
        defaultProfile: table.defaultProfile,
      }),
    })
  },
  onError: (error) => {
    notify({
      level: 'error',
      source: 'settings.browser',
      title: t('browser.profileSaveFailed'),
      body: error.message,
      detail: error.message,
    })
  },
  settle: () => browserSettingsQuery.invalidate(),
})

/**
 * 换搜索引擎。与名册那条同形(乐观 + 整份写回 + 对账)。
 *
 * 它**不在名册那条写路上**,虽然两者都写 `settings.browser`:一次写一件事,
 * 合成一条「写 browser 那一段」的通用写路会让调用方必须自己拼一份完整的段,
 * 而那正是 `patchBrowserSettings` 存在的理由 —— 拼段的活在这一层,不在调用方。
 */
export const setBrowserSearchEngineMutation: Mutation<string, void> = createMutation<string, void>(
  'browserSettings.setSearchEngine',
  {
    optimistic: (searchEngine) =>
      browserSettingsQuery.patch((prev) => (prev ? { ...prev, searchEngine } : prev)),
    run: async (searchEngine) => {
      const current = await readSettingsForWrite()
      await saveSettings({ ...current, browser: patchBrowserSettings(current, { searchEngine }) })
    },
    onError: (error) => {
      notify({
        level: 'error',
        source: 'settings.browser',
        title: t('browser.searchEngineSaveFailed'),
        body: error.message,
        detail: error.message,
      })
    },
    settle: () => browserSettingsQuery.invalidate(),
  },
)

/**
 * **HMR 退役**(壳规范「模块级副作用必须配 HMR dispose」,09-01 立法)。
 *
 * 这个文件的模块级副作用有五样:那只 query(自带监听表与缓存)与四只 mutation
 * (各自带监听表与逐格计数)。三样的寿命都是「这个模块实例」—— 不退役,旧实例
 * 的监听表会攥着已卸载组件的回调。退役**复用它们各自已有的那一口拆卸**
 * (`reset()`),不写第二套。生产构建里 `import.meta.hot` 是 undefined,整段被
 * tree-shake 掉。
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    browserSettingsQuery.reset()
    setBrowserCdpEnabledMutation.reset()
    installChromeDevtoolsMcpMutation.reset()
    saveBrowserProfilesMutation.reset()
    setBrowserSearchEngineMutation.reset()
  })
}
