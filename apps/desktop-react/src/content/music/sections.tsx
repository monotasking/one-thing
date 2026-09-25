import type { ReactNode } from 'react'
import type { MusicRadioState, MusicRuntimeState } from '@shared/ipc/music'
import { CircleUserRound, Disc3, Radio, Search } from '../../components/icons'
import type { LucideIcon } from '../../components/icons'
import type { MusicNowPlayingView, MusicProgrammeView } from '../../data/music-source'
import type { MessageKey } from '../../i18n'
import { AccountSection } from './AccountSection'
import type { HostTalk } from './useHostTalk'
import { RadioSection } from './RadioSection'
import { RecordDeck } from './RecordDeck'
import type { RecordDeckProps } from './RecordDeck'
import { SearchSection } from './SearchSection'
import { MUSIC_ACCOUNT_SECTION, MUSIC_DEFAULT_SECTION_ID, MUSIC_RADIO_SECTION, MUSIC_SEARCH_SECTION } from './section-ids'
import type { MusicStatus } from './status'

/**
 * **音乐面的分区表**(音乐面 v9,2026-09-25;正本 `docs/music-panel-2026-09.md` §10)。
 *
 * 用户那一条硬要求里的最后半句:「支持后续的扩展」。仓根 09-02 法说得更死:**加功能不许改骨架** ——
 * 凡「按能力枚举」的地方改成「能力自述、别人读表」。所以这块面上「有哪几格」是**这一张表**:
 * 导航读它画按钮、面板读它画身子、登录闸读它的 `requiresLogin`、状态条的「去哪一格」也只是它的一个 id。
 * `MusicPanel.tsx` 里**一个分区的名字都没有**。
 *
 * ── 陌生能力演练(交卷前必做)─────────────────────────────────────────────
 * 假设明天要加「每日推荐」:写一只 `DailySection.tsx`(它自己的模块 + 它自己的壳渲染),在这张表上加
 * 一行 `{ id: 'daily', labelKey, icon, requiresLogin: true, nav: true, render }`,i18n 两句。面板、
 * 导航、登录闸、状态模型一个字不动。答案是「能力自己的模块 + 一行注册」—— 骨架抽到位了。
 *
 * ── 一行说四件事 ────────────────────────────────────────────────────────
 *  · `nav`           —— 在檐上的导航里有没有一颗钮。账号那一格不在导航里:它的入口是檐右端那颗
 *                       账号 / 登录钮(成熟的音乐 App 都这么放);
 *  · `requiresLogin` —— 没登录时这一格画不画身子。画不了的话面板画登录引导卡,**不是空白**;
 *  · `hostsSetup`    —— 接入向导住在这一格。没登录时面板自动落到它(登录引导的「自动」那一半);
 *  · `layout`        —— 身子铺满(唱机)还是一列可滚的卡片;
 *  · `render(ctx)`   —— 身子。`ctx` 是面板已经订好的那一份读数(同一份真相只订一遍),一格拿它要的。
 */

/** 面板交给每一格的那一份。**只读** —— 一格要改什么都走 `musicOps`,不改这里。 */
export interface MusicSectionContext {
  runtime?: MusicRuntimeState
  brief?: MusicRadioState
  programme?: MusicProgrammeView
  /** 画在屏上的那一首(可能是「上次放到哪」拼出来的)。 */
  nowPlaying?: MusicNowPlayingView
  /** 此刻的播放位置(秒)。 */
  position?: number
  radioOn: boolean
  loggedIn: boolean
  status: MusicStatus
  /** 跟主持人说话那一份(黑豆的菜单与电台那一格共用;同一份真相不订两遍)。 */
  talk: HostTalk
  /** 去另一格。 */
  navigate: (sectionId: string) => void
  /** 唱机那一格的全部参数(面板已经算好:宠物、菜单、唱臂回调……)。 */
  deck: RecordDeckProps
}

export interface MusicSectionSpec {
  id: string
  labelKey: MessageKey
  icon: LucideIcon
  nav: boolean
  requiresLogin: boolean
  hostsSetup?: boolean
  /**
   * 身子的形,**分区自述的一格数据**(与设置页 `SETTINGS_PAGES` 的 `layout` 同一种说法):
   * `fill` = 吃满面板余下的高、自己不滚(唱机那一块);`page` = 一列卡片、由面板的滚动条滚。
   */
  layout: 'fill' | 'page'
  render: (ctx: MusicSectionContext) => ReactNode
}

export const MUSIC_SECTIONS: readonly MusicSectionSpec[] = [
  {
    id: MUSIC_DEFAULT_SECTION_ID,
    labelKey: 'music.section.now',
    icon: Disc3,
    layout: 'fill',
    nav: true,
    requiresLogin: true,
    render: (ctx) => <RecordDeck {...ctx.deck} />,
  },
  {
    id: MUSIC_RADIO_SECTION,
    labelKey: 'music.section.radio',
    icon: Radio,
    layout: 'page',
    nav: true,
    requiresLogin: true,
    render: (ctx) => <RadioSection ctx={ctx} />,
  },
  {
    id: MUSIC_SEARCH_SECTION,
    labelKey: 'music.section.search',
    icon: Search,
    layout: 'page',
    nav: true,
    requiresLogin: true,
    render: (ctx) => <SearchSection radioOn={ctx.radioOn} navigate={ctx.navigate} />,
  },
  {
    id: MUSIC_ACCOUNT_SECTION,
    labelKey: 'music.section.account',
    icon: CircleUserRound,
    layout: 'page',
    nav: false,
    requiresLogin: false,
    hostsSetup: true,
    render: (ctx) => <AccountSection runtime={ctx.runtime} navigate={ctx.navigate} />,
  },
]

/** 缺省那一格:表上第一格在导航里的。 */
export const MUSIC_DEFAULT_SECTION = MUSIC_SECTIONS.find((row) => row.nav)?.id ?? MUSIC_SECTIONS[0].id

/** 接入向导住的那一格。 */
export const MUSIC_SETUP_SECTION = MUSIC_SECTIONS.find((row) => row.hostsSetup)?.id ?? MUSIC_DEFAULT_SECTION

export function findMusicSection(id: string): MusicSectionSpec | undefined {
  return MUSIC_SECTIONS.find((row) => row.id === id)
}
