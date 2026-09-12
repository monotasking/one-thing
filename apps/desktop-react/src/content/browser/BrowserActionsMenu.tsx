import { useEffect } from 'react'
import { Menu, MenuItem, MenuSection, MenuSeparator } from '../../ui/Menu'
import { useT } from '../../i18n'
import { useQuery } from '../../data/kernel'
import { browserSettingsQuery } from '../../data/browser-settings-source'
import { profileDisplayName } from '../settings/BrowserSettings'
import { insertComposerReference } from '../../composer/references'
import { createPageToken, pageReferenceLabel } from '../../data/page-references'
import { notify } from '../../services/notify'
import type { BrowserTabRow } from '../../data/browser-source'

/**
 * **一格网页的全部动作 —— 唯一一张表**(B3-b;「动作单产地 = 右键上下文菜单」,
 * 09-01 用户裁定)。
 *
 * ── 为什么新起一张,而不是塞进叶檐的钮堆里 ────────────────────────────────
 * 与 `content/FileActionsMenu` 逐条同判例:一个条目(文件 / 会话 / 瓦 / **一页网页**)
 * 的全部动作收进同一张右键菜单,头部檐只放身份与导航。地址栏那一行今天已经有
 * 四颗钮 + 一个地址框 + 一颗 ＋;再往上挂「交给对话」「换个身份打开」只会把地址
 * 挤成 `docs.googl…`(那正是查看器头挤四件的那条报障)。
 *
 * 两个开口、**同一张表**:檐右端那颗 ⋯,与右键那条檐本身。
 *
 * ── 表里今天有什么 ────────────────────────────────────────────────────────
 *  · **把这一页交给对话** —— 往输入框里落一枚引用 chip(零字节;正文在发送那一刻
 *    才取,判词整段在 `data/page-references.ts`)。
 *  · **身份** —— 「在「<身份>」中打开此页」,每个**别的**身份一行。
 *    只在名册多于一格时出现:一台只有一个身份的机器上,这一节说的是一句废话。
 *
 * ── 三张状态表 ────────────────────────────────────────────────────────────
 * ① 生命周期:开着的那一段就是它活着的那一段(叶按 `at !== null` 渲染它);
 *    挂载时 `ensure()` 问一次设置(名册)—— **一张只在右键那一下出现的菜单不值得
 *    让全壳挂一条订阅**(与 `browser-launcher` 的菜单逐字同一条)。零计时器、零监听
 *    (点外关 / Esc / roving 全在 `ui/Menu` 里)。
 * ② UI 生命状态:名册还没问到 → 只有第一节(不画一张空的「身份」节);
 *    只有一格身份 → 同上;多格 → 两节;出错 → 同「还没问到」(名册拉不到时
 *    设置页那一侧已经说过一次,这里不再报第二遍)。
 * ③ UI 交互状态:全部随 `ui/Menu`(roving / hover / 点外关 / Esc)。
 */
export function BrowserActionsMenu({
  tab,
  at,
  onClose,
  onOpenInProfile,
}: {
  /** 被右键的那一格(`undefined` = 表还没到;那时叶不画这张菜单)。 */
  tab: BrowserTabRow
  at: { x: number; y: number }
  onClose: () => void
  /** 以另一格身份开这一页。落点在叶上(它要顺手把新那格摆出来)。 */
  onOpenInProfile: (profile: string) => void
}) {
  const t = useT()
  const settings = useQuery(browserSettingsQuery)
  // 菜单开着的这一段就是这条读数要新鲜的那一段(判词在文件头)。`ensure()` 幂等。
  useEffect(() => {
    void browserSettingsQuery.ensure()
  }, [])
  const profiles = settings.data?.profiles ?? []
  const others = profiles.filter((profile) => profile.id !== tab.profile)

  const giveToChat = (): void => {
    const label = pageReferenceLabel(tab)
    const ok = insertComposerReference({
      label,
      token: createPageToken(tab.id),
      ...(tab.url ? { tip: tab.url } : {}),
    })
    /*
     * 落不进去 = 此刻壳里没有输入面(没有会话开着)。**说一句**,不静默 ——
     * 人刚按下的那一下什么都没发生,而屏幕上看不出为什么。
     */
    if (!ok) {
      notify({
        level: 'warn',
        source: 'browser.giveToChat',
        title: t('browser.giveToChatNoComposer'),
      })
    }
    onClose()
  }

  return (
    <Menu x={at.x} y={at.y} onClose={onClose} label={t('browser.actions')}>
      <MenuItem onClick={giveToChat}>{t('browser.giveToChat')}</MenuItem>
      {others.length > 0 ? (
        <>
          <MenuSeparator />
          <MenuSection>{t('browser.profileSection')}</MenuSection>
          {others.map((profile) => (
            <MenuItem
              key={profile.id}
              onClick={() => {
                onOpenInProfile(profile.id)
                onClose()
              }}
            >
              {t('browser.openInProfile', { name: profileDisplayName(profile, t) })}
            </MenuItem>
          ))}
        </>
      ) : null}
    </Menu>
  )
}
