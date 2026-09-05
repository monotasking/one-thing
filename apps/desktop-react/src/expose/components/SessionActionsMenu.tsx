import { Menu, MenuItem, MenuSection, MenuSeparator } from '../../ui/Menu'
import { useT } from '../../i18n'
import { sessionRefOf } from '../../content/session-ref'
import { focusSessionSeat } from '../../content/session-open'
import { dropRef } from '../../workbench/drop-commit'
import { useExposeStore } from '../store'
import type { RegionId } from '../../workbench/regions'

/**
 * **一条会话的全部动作 —— 唯一一张表**(09-01「动作单产地 = 右键上下文菜单」;
 * W5-b 交付 2)。
 *
 * SessionRow 的文件头上原本记着一格留账:「右键上下文菜单不在本批 —— 重命名 /
 * 删除 / 移到项目在 React 壳都还没有产地,挂一个弹空菜单的右键比不挂更糟」。
 * 会话多开把那个空菜单填上了第一批真动作:**这一条要在哪儿打开**。
 *
 * ── 三行,与文件树那一组是**同一句话**,所以复用同一组 i18n 键 ──────────
 *   打开(`files.menuOpen`)      落焦点叶 —— 与单击一行逐字同义(切换)
 *   在右侧(`files.menuOpenRight`)先切一刀,新叶放右边
 *   在下方(`files.menuOpenBelow`)同上,放下面
 * 后两行走的是**拖拽落定那一只**(`workbench/drop-commit.dropRef`),不是第二条
 * 路:键盘那条与鼠标那条对同一个落点必须做同一件事(W3 裁定 5,「一个事务动作,
 * 菜单与拖拽共用」)。落点由 `DropTarget` 描述,所以这里连 `splitLeaf` 都不用叫。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *  ① 生命周期:右键那一刻挂载,点任何一行 / 点外 / Esc 卸载(`ui/Menu` 自己管);
 *  ② UI 生命状态:只有 ready 一格 —— 三行恒在,没有异步、没有空态;
 *  ③ UI 交互状态:rest / hover / active(键盘位)/ focus 全归 `ui/Menu`
 *     与 `ui/MenuItem`,这只组件一个像素都不画。
 */
export function SessionActionsMenu({
  sessionId,
  title,
  x,
  y,
  onClose,
}: {
  sessionId: string
  title: string
  x: number
  y: number
  onClose: () => void
}) {
  const t = useT()
  return (
    <Menu x={x} y={y} onClose={onClose} label={t('expose.rowMenu')}>
      <MenuSection>{title}</MenuSection>
      <MenuItem
        onClick={() => {
          onClose()
          useExposeStore.getState().enterSession(sessionId)
        }}
      >
        {t('files.menuOpen')}
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        onClick={() => {
          onClose()
          openBesideFocusLeaf(sessionId, 'right')
        }}
      >
        {t('files.menuOpenRight')}
      </MenuItem>
      <MenuItem
        onClick={() => {
          onClose()
          openBesideFocusLeaf(sessionId, 'below')
        }}
      >
        {t('files.menuOpenBelow')}
      </MenuItem>
    </Menu>
  )
}

/**
 * 「在右侧 / 在下方打开」= 一次**落在焦点会话叶上**的落定。
 *
 * 走 `dropRef` 而不是自己拼动作:落点的语义(并成两格 / 开成新标签、落完点亮它、
 * 焦点跟过去)整件住在那一只事务动作里,拖拽与菜单读同一份。
 * 焦点叶不在(树还没播种)时什么都不做 —— 那一刻没有「旁边」可言。
 *
 * ── W6-b:两项各自换了落点,**行为一项不变一项变好** ──────────────────────
 * 单叶政策(设计 v3 §2)之后中央区不再切第二片叶,所以从前那两句
 * `{kind:'leaf', zone:'e'|'s'}` 已经没有对象:W6-a 的止血把它们都退成了
 * 「开成一格新标签」。现在:
 *  · **在右侧** → `pair right` —— 「开在右边」在两格模型里的字面意思就是
 *    「与你正在看的那个并排,放右边」(设计 v3 §5 的内容区右带,同一只
 *    `store.pairRefs`,菜单与拖拽共用);
 *  · **在下方** → `open` —— 竖着并排这件事**不存在**(§12「三格及以上并排不做」,
 *    两格只有左右)。所以它保持 W6-a 之后的实际行为(末尾开一格新标签),
 *    一个像素都不变。**这一项在新模型里名不副实,删不删是用户的拍点**,
 *    本批不擅自动它(判例:行为裁定须先问)。留账写在交卷报里。
 */
function openBesideFocusLeaf(sessionId: string, side: 'right' | 'below'): void {
  /*
   * 落点是**焦点会话叶**,不是「此刻的焦点叶」——「开在右边」的意思是开在
   * **会话**旁边,而焦点此刻很可能正在会话总览那块面上(用户就是在那儿右键的)。
   * 判据复用 `content/session-open.focusSessionSeat`(与点一行进会话同一条梯子)。
   */
  const seat = focusSessionSeat()
  if (!seat) return
  const ref = sessionRefOf(sessionId)
  const region = seat.region as RegionId
  if (side === 'right') {
    dropRef(ref, { kind: 'pair', region, leafId: seat.leafId, side: 'right' })
    return
  }
  dropRef(ref, { kind: 'open', region, leafId: seat.leafId })
}
