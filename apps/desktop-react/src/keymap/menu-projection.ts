import { t } from '../i18n'
import type { MessageKey } from '../i18n'
import { chordOfCombo } from './chord'
import { KEYMAP_COMMANDS, effectiveCombos } from './transitions'
import type { CommandId, KeymapPlatform, KeymapState } from './types'
import type { AppMenuItemSpec, AppMenuSpec } from '../data/browser-port'

/**
 * **菜单表 = 命令表的一次投影**(K4,方案
 * `apps/desktop-react/docs/keymap-responder-2026-09.md` §4「应用菜单」第二步 / §5 K4)。
 *
 * ── 这只文件为什么存在 ────────────────────────────────────────────────────
 * K1 把 Electron 那张没人审过的默认菜单拿掉了,拿掉之后菜单栏上只剩「非留不可」
 * 的那几格(appMenu / Edit / Window / Help)。于是「⌘T 是什么」这句话在**设置页**
 * 里说得出、在**保留键表**里算得出,唯独在 macOS 用户找快捷键的第一反应 ——
 * 菜单栏 —— 上说不出。K4 补的就是这一格,而补的形状是**投影**:
 * 菜单栏不认识任何一条命令的名字,它只是把同一张表换一种画法。
 *
 * ── 三件只有渲染进程有的东西 ──────────────────────────────────────────────
 *  · **字典**:`labelKey` → 人话。i18n 住在渲染层,主进程一个字都没有;
 *  · **有效键**:用户逐格覆盖 ▷ 当前键位组 ▷ 出厂表(K5 的三层),全在 store 里;
 *  · **此刻谁答得出**:活动路径是 `focus/` 那棵树。
 * 三样都在这一侧,所以投影在这一侧算完、整张推下去。主进程只负责画。
 *
 * ── 纯函数:`t` 与 `isEnabled` 都是**参数** ───────────────────────────────
 * 这只文件不读 store、不问树 —— 它收一份状态、一台机器、一只「此刻答得出吗」的
 * 判官,回一张表。判官由调用方给,而调用方给进来的那只**必须**是派发器用的
 * 同一条判据(`focus/transitions.routeCommand`):菜单画灰与按键不响是同一件事,
 * 两个产地迟早分叉。
 */

/**
 * 一条命令属于菜单栏上的哪一节。**按 id 的形状判,不列名单** ——
 * 列名单的话加一条命令就要回来改这只函数,而那正是「按能力枚举」那条法禁的形。
 *
 * 四节,顺序就是它们在菜单栏上从左到右的顺序:
 *  · `global` —— **有应用层兜底**的那些(`app: true`):呼出一块面、切工作区、
 *    收展架子。判据是命令自己那一格,不是一张名字表;
 *  · `tab` —— `tab.*` 与 `content.new`:一排标签上的事(新开 / 关 / 换 / 重开);
 *  · `content` —— `view.*` 与 `nav.*`:**对焦点那块内容**做一件事
 *    (查找 / 保存 / 重载 / 缩放 / 前进后退);
 *  · `face` —— 剩下的那些,它们属于**某一块面**自己(查看器跳行 / 浏览器地址栏 /
 *    文件详情 / 总览置顶)。
 */
export type MenuFamily = 'global' | 'tab' | 'content' | 'face'

/** 节的顺序 = 菜单栏上从左到右的顺序。 */
export const MENU_FAMILIES: readonly MenuFamily[] = ['global', 'tab', 'content', 'face']

const FAMILY_LABEL_KEYS: Record<MenuFamily, MessageKey> = {
  global: 'menu.sectionGlobal',
  tab: 'menu.sectionTab',
  content: 'menu.sectionContent',
  face: 'menu.sectionFace',
}

export function menuFamilyOf(command: { id: CommandId; app: boolean }): MenuFamily {
  if (command.app) return 'global'
  if (command.id.startsWith('tab.') || command.id === 'content.new') return 'tab'
  if (command.id.startsWith('view.') || command.id.startsWith('nav.')) return 'content'
  return 'face'
}

export interface MenuProjectionInput {
  /** 整份键位状态(三层有效键从它落出来)。 */
  state: KeymapState
  /** 这台机器 —— 串要已经解释过平台(判词在 `keymap/chord.ts`)。 */
  platform: KeymapPlatform
  /**
   * 此刻这条命令答得出吗。**必须**是派发器那条判据
   * (`focus/transitions.routeCommand` 回非 null),不许在这里另写一份。
   */
  isEnabled: (id: CommandId) => boolean
  /** 翻译。缺省是模块级那只(它当场读一次 locale,不订阅)。 */
  translate?: (key: MessageKey) => string
}

/**
 * 投影。**一条命令一行**,分节按 `menuFamilyOf`;空的节不画
 * (今天四节都不空,但「这一节此刻一条命令都没有」是合法的中间态)。
 *
 * 键面取**第一枚**:一条命令可以绑好几个键(`files.detail` 的 ⌘I 与 ⌘↵),
 * 而 Electron 的一项只画得下一个加速键。取第一枚而不是「挑一个好看的」——
 * 第一枚就是出厂表 / 用户录制时排在最前的那一枚,说得出理由。
 */
export function projectAppMenu(input: MenuProjectionInput): AppMenuSpec {
  const { state, platform, isEnabled } = input
  const translate = input.translate ?? t
  const buckets = new Map<MenuFamily, AppMenuItemSpec[]>()
  for (const family of MENU_FAMILIES) buckets.set(family, [])
  for (const command of KEYMAP_COMMANDS) {
    const combos = effectiveCombos(state, command.id)
    buckets.get(menuFamilyOf(command))?.push({
      id: command.id,
      label: translate(command.labelKey),
      chord: combos.length > 0 ? chordOfCombo(combos[0], platform) : null,
      enabled: isEnabled(command.id),
    })
  }
  return {
    sections: MENU_FAMILIES.flatMap((family) => {
      const items = buckets.get(family) ?? []
      if (items.length === 0) return []
      return [{ label: translate(FAMILY_LABEL_KEYS[family]), items }]
    }),
  }
}
