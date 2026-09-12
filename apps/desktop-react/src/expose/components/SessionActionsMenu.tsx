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
 * ── 四行(09-12 补了第四行,并给第三行改了名)──────────────────────────────
 *   打开(`files.menuOpen`)             落焦点叶 —— 与单击一行逐字同义(切换)
 *   在右侧打开(`files.menuOpenRight`)  先切一刀,新叶放右边
 *   在新标签页打开(`expose.menuOpenNewTab`)在同一片叶上多开一格
 *   Quick Look(`card.preview`)         09-12:行上那只眼睛退役成这一行
 * 前两行与文件树那一组是**同一句话**,所以复用同一组 i18n 键。
 * 后两行走的是**拖拽落定那一只**(`workbench/drop-commit.dropRef`),不是第二条
 * 路:键盘那条与鼠标那条对同一个落点必须做同一件事(W3 裁定 5,「一个事务动作,
 * 菜单与拖拽共用」)。落点由 `DropTarget` 描述,所以这里连 `splitLeaf` 都不用叫。
 *
 * ── 第三行为什么**新立一把键**而不是改 `files.menuOpenBelow` 的文案 ──────────
 * 09-12 的派工单要求先核一件事:那把键在文件树里是不是也名不副实。**不是** ——
 * `content/FileActionsMenu.openBeside(path, 'col')` 真的叫了
 * `state.splitLeaf(leaf.id, 'col')`,文件是能竖着并排的,「在下方打开」在那边
 * 字字属实。会话这边不行(§12「三格及以上并排不做」,两格只有左右),所以是
 * **会话这一张表的这一行**名不副实,不是那把键错。改那把键的文案会把文件树
 * 那一行一起改错 —— 于是新立 `expose.menuOpenNewTab`,一句话一把键。
 *
 * ── Quick Look 为什么进这张表(拍板 3)───────────────────────────────────────
 * 行上从前挂着两颗悬停钮(眼睛 = 预览、图钉 = 置顶)。09-12 悬停只留一颗 ⋯,
 * 而「动作单产地 = 右键上下文菜单」(09-01)要求退役的那两件落到这张表里。
 * 这一批先接 Quick Look(它是纯读、零副作用,而且 `Space` 那条键盘等价一直在);
 * 置顶 / 关闭 / 重命名 / 删除四行归 A2 —— **所以此刻置顶暂时只有 ⌘⇧P 一条路,
 * 这处缺口写在 A1 的交卷报留账里,由 A2 在同一批文件里填上。**
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
          openBesideFocusLeaf(sessionId, 'newTab')
        }}
      >
        {t('expose.menuOpenNewTab')}
      </MenuItem>
      <MenuSeparator />
      {/*
       * Quick Look。**它与 Space 是同一口**(`store.openQuickLook`):行上那只
       * 眼睛退役之后,鼠标这条路与键盘那条路仍然落在同一个动作上。
       * 键沿用 `card.preview` —— 卡片时代那只眼睛的名字就是它,同一句话不新立键。
       */}
      <MenuItem
        onClick={() => {
          onClose()
          useExposeStore.getState().openQuickLook(sessionId)
        }}
      >
        {t('card.preview')}
      </MenuItem>
    </Menu>
  )
}

/**
 * 「在右侧打开 / 在新标签页打开」= 一次**落在焦点会话叶上**的落定。
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
 *  · **在新标签页** → `open` —— 在同一片叶的末尾开一格新标签。
 *
 * ── 09-12:第二项**改的是名字,不是行为**(拍板 4)────────────────────────
 * W6-b 在这里留了一格账:「『在下方』在新模型里名不副实,删不删是用户的拍点,
 * 本批不擅自动它」。用户 09-12 拍了 —— **不删,改名为它真做的事**。
 * 所以这一支的实现一个字没动(仍然是那一句 `dropRef({kind:'open'})`),
 * 动的只有第二个入参的名字(`'below'` → `'newTab'`)与屏幕上那句话:
 * 参数名从前说的是「往哪个方向」,现在说的是「开成什么」—— 竖着并排这件事
 * 不存在(§12「三格及以上并排不做」),所以方向这个维度在会话这边压根没有对象。
 */
function openBesideFocusLeaf(sessionId: string, side: 'right' | 'newTab'): void {
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
