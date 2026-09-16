import { GeneralPage } from './GeneralPage'
import { AppearancePage } from './AppearancePage'
import { DockPage } from './DockPage'
import { OpenPage } from './OpenPage'
import { BrowserSettings } from './BrowserSettings'
import { NetworkSettings } from './NetworkSettings'
import { SearchSettings } from './SearchSettings'
import { PermissionGrants } from './PermissionGrants'
import { Section } from './Section'
import { KeymapSettings } from '../KeymapSettings'
import { ProviderSettingsPanel } from '../../providers/components/ProviderSettingsPanel'
import type { ReactNode } from 'react'
import type { MessageKey } from '../../i18n'

/**
 * **设置页那张页表**(2026-09-13,用户拍「把模型设置移到设置中去」)。
 *
 * ── 为什么从「分区不分页」改成「左导航 + 右页」 ────────────────────────────
 * `SettingsMock.tsx` 的文件头原本写着「分区不分页:左侧竖向锚点导航等设置真长到
 * 那个量级再说」。那个量级到了 —— 模型服务是一块**要吃满高度的两栏面**
 * (左栏名册 + 右面分坑,自述 `min-width: 502`),塞进单列滚动表单只能得到
 * 嵌套滚动:外面一根条滚整页,里面一根条滚那块面,而两根条谁也说不清自己管的是
 * 哪一段。macOS 系统设置那种「左导航 + 右页」正是给这种混合版式准备的形。
 *
 * ── 表是唯一产地:导航与内容**读同一张表** ────────────────────────────────
 * 「加功能不许改骨架」在这里的字面落地:**加一页 = 这张表上加一行**。外壳
 * (`content/SettingsMock.tsx`)里没有一个页名,它只会 `SETTINGS_PAGES.map`;
 * 真机门那一屏也是照着这张表的 id 逐页点过去的。
 *
 * ── `layout` 这一格答的是「这一页的内容自己管不管滚动」 ────────────────────
 *  · `'form'` —— 单列表单,外面那层给内边距、给 `overflow: auto` (今天八页);
 *  · `'fill'` —— 内容吃满整页、自己管滚动,页这一层不加内边距也不滚
 *    (今天只有模型服务:`ProviderSettingsPanel` 的 `.panel` 是 `height: 100%`)。
 * 它是**页自述的一格数据**,不是外壳里的一句 `if (id === 'models')`。
 */
export type SettingsPageId =
  | 'general'
  | 'models'
  | 'appearance'
  | 'dock'
  | 'open'
  | 'search'
  | 'browser'
  | 'network'
  | 'permissions'
  | 'keymap'

export interface SettingsPageSpec {
  id: SettingsPageId
  /** 导航行与页标题共用一个键 —— 两处说的是同一句话,不该有两份文案。 */
  titleKey: MessageKey
  /** 'form' = 单列表单(页管滚动与内边距);'fill' = 内容吃满页面、自己管滚动。 */
  layout: 'form' | 'fill'
  render: () => ReactNode
}

/**
 * 次序判据照旧是「**用户想改的是哪件事**」,从最常改的往最少改的排:
 * 通用 → 模型服务 → 外观 → Dock → 打开方式 → 搜索 → 内置浏览器 → 网络代理 → 已授权 → 快捷键。
 *
 * 模型服务排第二而不是最后:它是这台产品里改得最勤的一页(换家、换模型、
 * 贴一把新密钥),而「已授权」与「快捷键」是**看一眼就走**的两页。
 */
export const SETTINGS_PAGES: readonly SettingsPageSpec[] = [
  { id: 'general', titleKey: 'settings.sectionGeneral', layout: 'form', render: () => <GeneralPage /> },
  /*
   * 模型服务。**整块面直接摆进页里,不再包一层 `Section`** —— 它自己就有檐、
   * 有左栏、有分坑,再罩一个 11px 的节标只会多一层边界。
   * 它是今天唯一的 `fill` 页,理由写在 `layout` 那一格上。
   */
  { id: 'models', titleKey: 'item.providers', layout: 'fill', render: () => <ProviderSettingsPanel /> },
  { id: 'appearance', titleKey: 'settings.pageAppearance', layout: 'form', render: () => <AppearancePage /> },
  { id: 'dock', titleKey: 'settings.sectionDock', layout: 'form', render: () => <DockPage /> },
  { id: 'open', titleKey: 'dock.openWith', layout: 'form', render: () => <OpenPage /> },
  /*
   * 下面四页各自只有一节,所以节标与页标题是同一句话 —— 但**节仍然画**:
   * 一页里将来多一节时不必回头补,而且 `<h3>` 是这几块面里辅助技术唯一的层级锚。
   *
   * 「搜索」排在「打开方式」与「内置浏览器」之间:前面五页是**每天都在改**的东西,
   * 它和内置浏览器一样是「配一次就不再看」的一页;而它排在浏览器前面,是因为搜索
   * 是这台产品每天都在用的能力,浏览器不是。
   */
  {
    id: 'search',
    titleKey: 'settings.sectionSearch',
    layout: 'form',
    render: () => (
      <Section titleKey="settings.sectionSearch">
        <SearchSettings />
      </Section>
    ),
  },
  {
    id: 'browser',
    titleKey: 'settings.sectionBrowser',
    layout: 'form',
    render: () => (
      <Section titleKey="settings.sectionBrowser">
        <BrowserSettings />
      </Section>
    ),
  },
  {
    id: 'network',
    titleKey: 'settings.sectionNetwork',
    layout: 'form',
    render: () => (
      <Section titleKey="settings.sectionNetwork">
        <NetworkSettings />
      </Section>
    ),
  },
  {
    id: 'permissions',
    titleKey: 'settings.sectionPermissions',
    layout: 'form',
    render: () => (
      <Section titleKey="settings.sectionPermissions">
        <PermissionGrants />
      </Section>
    ),
  },
  {
    id: 'keymap',
    titleKey: 'settings.sectionKeymap',
    layout: 'form',
    render: () => (
      <Section titleKey="settings.sectionKeymap">
        <KeymapSettings />
      </Section>
    ),
  },
]

/** 没选过 / 认不出时落这一页。 */
export const DEFAULT_SETTINGS_PAGE: SettingsPageId = 'general'

/** 认不认得这个页名。**存档是不可信输入**,水合那一路问的就是它。 */
export function isSettingsPageId(value: unknown): value is SettingsPageId {
  return typeof value === 'string' && SETTINGS_PAGES.some((page) => page.id === value)
}

/** 这一页的声明。认不出的 id 回**缺省页**,不回 undefined —— 屏幕上永远有一页。 */
export function settingsPageOf(id: SettingsPageId): SettingsPageSpec {
  return SETTINGS_PAGES.find((page) => page.id === id) ?? SETTINGS_PAGES[0]!
}
