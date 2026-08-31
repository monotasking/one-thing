import { useStageStore } from '../stage/store'
import { STAGE_ITEMS } from '../stage/items'
import { isItemHidden } from '../stage/transitions'
import { resolveIcon } from '../components/icons'
import { Switch } from '../ui/Switch'
import { useT } from '../i18n'
import s from './AppsPanel.module.css'

/**
 * 「所有应用」——这台壳里能打开的**全部**,以及每一块在 Dock 上露不露面。
 *
 * ── 它为什么是一块普通的瓦 ───────────────────────────────────────────────
 * 与通知中心 / 工作区切换器同一条判例(见 stage/items.ts):它有内容、有落点、
 * 有打开方式,和别的瓦逐字走同一条路。所以这里没有一行「浮层」代码 ——
 * 它长在舞台上、浮窗里、架子上还是盖着内容栏,由形态机说了算,本文件不知道。
 *
 * ── 藏的是入口,不是这块面 ───────────────────────────────────────────────
 * 关掉一行,那块瓦从 Dock 上消失;它的落点、位置记忆、快捷键一件都不动,
 * 从这张清单里点名字照样打开(每行的名字就是那道门)。所以这不是「卸载」,
 * 而是「先收起来」—— 这也是为什么开关的话是「显示在 Dock」而不是「启用」。
 *
 * ── 留一个回家的门 ───────────────────────────────────────────────────────
 * 这块瓦自己藏不掉(items 表上的 `alwaysInDock`):它是把别的瓦放回来的唯一入口,
 * 藏掉它用户就再也找不到那扇门了。开关画成 disabled 只是**告诉**用户这件事,
 * 真正挡住它的是形态机里那条判据(transitions.setItemHidden)——
 * UI 是绕得过去的(右键、快捷键、将来的命令面板),而这条规矩不该有例外。
 *
 * 版式:一列账页行,与设置页那张「分区不分页的单列表单」同族 ——
 * 一行一件事,左边是它是什么,右边是关于它的那一个决定。
 */
export function AppsPanel() {
  const t = useT()
  const hiddenItems = useStageStore((st) => st.hiddenItems)
  const setItemHidden = useStageStore((st) => st.setItemHidden)
  const click = useStageStore((st) => st.clickDockIcon)

  const hiddenCount = STAGE_ITEMS.filter((item) => isItemHidden(hiddenItems, item.id)).length

  return (
    <div className={s.panel} data-testid="apps-panel">
      {/*
        这里是 `<div>` 而**不是** `<header>`。`<header>` 在不属于任何 sectioning
        内容时会隐式拿到 `banner` 地标,而整页只该有一个 banner(顶栏)——
        gate:a11y 首跑当场报 landmark-no-duplicate-banner。
        语义上它本来也不是「本节的页眉」:一句说明加一个读数,`<div>` 才是实话。
      */}
      <div className={s.head}>
        <p className={s.subtitle}>{t('apps.subtitle')}</p>
        {/* 计数只在**真有**隐藏项时出现:0 不是一条要说的消息。
          * 它也刻意不是一枚徽 —— tab / 列表上的计数徽是禁令,这里是一句话。 */}
        {hiddenCount > 0 && (
          <span className={s.count}>{t('apps.hiddenCount', { count: hiddenCount })}</span>
        )}
      </div>

      <ul className={s.list}>
        {STAGE_ITEMS.map((item) => {
          const name = t(item.titleKey)
          const Icon = resolveIcon(item.icon)
          const hidden = isItemHidden(hiddenItems, item.id)
          const locked = item.alwaysInDock === true
          return (
            <li key={item.id} className={s.row} data-testid={`apps-row-${item.id}`}>
              {/* 名字本身就是那道门:清单里点一块面 = 打开它(与点 Dock 瓦同一条路,
                * 所以藏起来的面照样打得开)。 */}
              <button
                type="button"
                className={s.open}
                onClick={() => click(item.id)}
                aria-label={t('apps.open', { name })}
              >
                <Icon className={s.icon} strokeWidth={1.75} aria-hidden="true" />
                <span className={s.name}>{name}</span>
              </button>
              {locked && <span className={s.note}>{t('apps.alwaysInDock')}</span>}
              <Switch
                checked={!hidden}
                disabled={locked}
                onChange={(on) => setItemHidden(item.id, !on)}
                label={t('apps.showRow', { name })}
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}
