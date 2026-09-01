import { Menu, MenuItem, MenuSection, MenuSeparator } from '../../ui/Menu'
import { useT } from '../../i18n'

/**
 * 一行 provider 的**全部行级动作**(09-01 立法「动作单产地 = 右键上下文菜单」)。
 *
 * ── 为什么这块面需要它 ───────────────────────────────────────────────────
 * 用户报障:「custom provider 没有删除选项」。其实删是有的 —— 它藏在**编辑对话框
 * 的页脚**里:得先在右面点「编辑这一家」,开出对话框,才在角落看到一颗 ghost 钮。
 * 那正是「动作散落」的样子:一个动作要先打开另一个东西才找得到。
 * 09-01 的法条给的落点是**行的右键菜单**,所以删除搬到这里,对话框页脚那颗撤掉 ——
 * 单产地的意思是**只有一处**,不是「多一处也行」。
 *
 * ── 两族行,两张表 ───────────────────────────────────────────────────────
 *  · **自定义家**:编辑 / 删除。删是危险动作,所以 danger 字色 + **两段就地确认**
 *    (`ui/Menu` 的 `confirmLabel`,第一下换字不执行、第二下才真删)——
 *    不弹 confirm 对话框:那会把焦点从菜单上拽走再拽回来,而这一下的后果是局部的。
 *  · **内置家**:**不给删,只给停用**(用户裁定)。内置的那些是这台机器认识的
 *    provider 名册,删掉它等于让一条老会话永远解释不了自己绑的是谁。
 *
 * 「启用 / 停用」在右面的模式卡上也有一个开关 —— 这里是**同一个动作的第二个入口**,
 * 不是第二份设置(菜单里没有任何别处没有的开关)。行右键问「这一行我能干什么」,
 * 答案里当然该有它。
 *
 * ── 删除的级联,照实说 ───────────────────────────────────────────────────
 * 确认那句话把后果说全:**模型勾选**与**这个空间里它的密钥**一起没。
 * 会话**不动** —— 老会话还绑着它的话,历史照留,发消息时诚实地失败
 * (与「配错家的模型选得中、发消息才失败」是同一条既有口径)。
 */
export function ProviderRowMenu({
  familyId,
  label,
  custom,
  enabled,
  x,
  y,
  onClose,
  onEdit,
  onDelete,
  onToggleEnabled,
}: {
  familyId: string
  label: string
  custom: boolean
  enabled: boolean
  x: number
  y: number
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
  onToggleEnabled: () => void
}) {
  const t = useT()
  return (
    <Menu
      x={x}
      y={y}
      onClose={onClose}
      label={t('providers.rowMenu', { name: label })}
      id={`provider-row-menu-${familyId}`}
    >
      {/* 头一行是身份,不是动作 —— 与文件行菜单同一手:先说清「这张表说的是谁」。 */}
      <MenuSection>{label}</MenuSection>

      <MenuItem
        onClick={() => {
          onToggleEnabled()
          onClose()
        }}
      >
        {enabled ? t('providers.rowDisable') : t('providers.rowEnable')}
      </MenuItem>

      {custom && (
        <>
          <MenuSeparator />
          <MenuItem
            onClick={() => {
              onEdit()
              onClose()
            }}
          >
            {t('providers.customEdit')}
          </MenuItem>
          {/*
           * 两段就地确认由库件自己管(`confirmLabel`):第一下只换字,第二下才
           * 调 onDelete。所以这里的 onClick **就是真删** —— 业务面不再自己写
           * 一个 `confirming` 状态(那正是「基础件先行」要拦的重复实现)。
           */}
          <MenuItem
            danger
            confirmLabel={t('providers.customDeleteConfirm')}
            onClick={() => {
              onDelete()
              onClose()
            }}
          >
            {t('providers.customDeleteMenu')}
          </MenuItem>
        </>
      )}

      {!custom && (
        <>
          <MenuSeparator />
          {/* 内置家为什么没有「删除」,就地说一句 —— 比让人找一圈找不到强。 */}
          <MenuSection>{t('providers.builtinNoDelete')}</MenuSection>
        </>
      )}
    </Menu>
  )
}
