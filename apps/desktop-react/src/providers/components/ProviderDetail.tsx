import { Button } from '../../ui/Button'
import { Segmented } from '../../ui/Segmented'
import { Switch } from '../../ui/Switch'
import { Tooltip } from '../../ui/Tooltip'
import { useT } from '../../i18n'
import { initialOf } from '../projection'
import type { ModeTab, ProviderFamilyView, ProviderMode } from '../types'
import s from './ProviderDetail.module.css'

/**
 * 右面 = 一家的详情:头(图标 / 名 / 副语 / 启用开关)+ 模式分段器 + 模式内容区。
 *
 * **一家的启用是一个开关,不是每坑一个**:家族一开全开(与 Vue 壳
 * `ConnectionsSection.toggleCardEnabled` 同一条语义)。所以开关画在头上,
 * 而不是画在每一坑里 —— 画在坑里就等于宣布它们可以各开各的。
 *
 * 模式分段器只在**真有两坑**时出现。一坑的家画一个只有一格的分段器是噪音:
 * 那一格点了也不会变。
 *
 * ── 批二起,这块组件不认识「坑里画什么」────────────────────────────────────
 * 批一时四种坑的卡片长在这里。批二每一种坑都长出了真东西(密钥池 / 登录流 /
 * 用量 / 计费档位),再留在这里就等于让「一家的外框」同时知道 OAuth 怎么轮询、
 * 凭证怎么排序。所以卡片全部由上面递进来(`children`),这里只剩外框:
 * 谁的名字、开没开、有几坑、当下是哪一坑。
 */

export function ProviderDetail({
  family,
  mode,
  tabs,
  enabled,
  enabledPending,
  customPending,
  onToggleEnabled,
  onSelectMode,
  onEditCustom,
  children,
}: {
  family: ProviderFamilyView
  mode: ProviderMode
  tabs: readonly ModeTab[]
  enabled: boolean
  /**
   * **这一家的启用开关**此刻在写吗(`family:` 那一格)。
   * 从前这里是整面共享的 `saving` —— 于是勾一个模型也会把这颗开关禁灰。
   */
  enabledPending: boolean
  /** 这一家的**自定义定义**此刻在写吗(`custom:` 那一格)。「编辑」钮读它。 */
  customPending: boolean
  onToggleEnabled: (next: boolean) => void
  onSelectMode: (providerId: string) => void
  /** 只有自定义家有「编辑」——别家的名字与地址不是用户定的。 */
  onEditCustom: () => void
  /** 模式卡 + 模型目录。由上面递进来 —— 详情不该知道它们是怎么来的。 */
  children?: React.ReactNode
}) {
  const t = useT()

  return (
    /*
     * 头这一行**不用 `<header>`**,这一格是真机门抓出来的:`<header>` 的隐含角色是
     * banner,而整页只该有一个 banner(那是顶栏的),axe 的
     * landmark-no-duplicate-banner 当场红。套一层无名 `<section>` 也救不回来 ——
     * 无名的 section 角色是 generic,axe 判祖先看的是**角色**不是标签名,
     * 所以那一层挡不住(真机上试过一轮,读数记在这里免得下一个人再试一遍)。
     * 层级由 `<h2>` 给,分量由 CSS 给 —— 这一行本来也不需要是个地标。
     */
    <div className={s.detail}>
      <div className={s.head}>
        <span className={`${s.icon} ${family.custom ? s.iconCustom : ''}`} aria-hidden="true">
          {initialOf(family.label)}
        </span>
        <div className={s.headText}>
          {/* 名字单行截断(律二),所以配一句 Tooltip 把全名说出来 ——
              壳 CLAUDE.md「标题截断须配 Tooltip 全名」,禁 native title=。 */}
          <Tooltip content={family.label}>
            <h2 className={s.name}>{family.label}</h2>
          </Tooltip>
          {family.description && <p className={s.desc}>{family.description}</p>}
        </div>
        {family.custom && (
          <Button size="sm" onClick={onEditCustom} disabled={customPending}>
            {t('providers.customEdit')}
          </Button>
        )}
        <div className={s.enable}>
          <span className={s.enableLabel}>{t('providers.enable')}</span>
          <Switch
            checked={enabled}
            onChange={onToggleEnabled}
            disabled={enabledPending}
            label={t('providers.enableFamily', { name: family.label })}
          />
        </div>
      </div>

      {tabs.length > 1 && (
        <div className={s.modes}>
          <Segmented
            options={tabs.map((tab) => ({
              value: tab.providerId,
              label: `${t(tab.label.key, tab.label.vars)} · ${t(tab.state.key, tab.state.vars)}`,
            }))}
            value={mode.providerId}
            onChange={onSelectMode}
            label={t('providers.modeLabel')}
          />
        </div>
      )}

      <div className={s.body}>{children}</div>
    </div>
  )
}
