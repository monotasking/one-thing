import { resolveIcon, X } from '../components/icons'
import { useT } from '../i18n'
import s from './Tabs.module.css'

/**
 * 规范画布「Tabs 族」的唯一实现:高 36、tab 左右内边距 10。
 * 活动态只换字色 + 底缘 2px accent 指示条(inset box-shadow,不占布局,
 * 所以切换 tab 一像素都不动);非活动 --text-3,hover --st-hover。
 *
 * 完全受控:它不存 activeId,也不认识 item 里装的是什么内容。
 * onClose 给了才画 ×,× 平时透明、hover 本 tab 时浮出(只动 opacity,位子一直占着)。
 */
export interface TabSpec {
  id: string
  label: string
  /** lucide 图标名,与 items 表同一套字符串 */
  icon?: string
}

interface TabsProps {
  items: TabSpec[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose?: (id: string) => void
  label?: string
}

export function Tabs({ items, activeId, onSelect, onClose, label }: TabsProps) {
  const t = useT()
  return (
    <div className={s.bar} role="tablist" aria-label={label}>
      {items.map((tab) => {
        const Icon = tab.icon ? resolveIcon(tab.icon) : null
        const on = tab.id === activeId
        return (
          <div key={tab.id} className={on ? `${s.tab} ${s.tabOn}` : s.tab}>
            <button
              type="button"
              className={s.main}
              role="tab"
              aria-selected={on}
              onClick={() => onSelect(tab.id)}
            >
              {Icon && <Icon className={s.icon} strokeWidth={1.75} aria-hidden="true" />}
              <span className={s.label}>{tab.label}</span>
            </button>
            {onClose && (
              <button
                type="button"
                className={s.close}
                onClick={() => onClose(tab.id)}
                aria-label={t('common.closeTab', { label: tab.label })}
              >
                <X className={s.closeIcon} strokeWidth={2} aria-hidden="true" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
