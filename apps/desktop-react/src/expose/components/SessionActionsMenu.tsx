import { Menu, MenuItem, MenuSection, MenuSeparator } from '../../ui/Menu'
import { useConfirm } from '../../ui/Dialog'
import { useT } from '../../i18n'
import { sessionRefOf } from '../../content/session-ref'
import { focusSessionSeat } from '../../content/session-open'
import { dropRef } from '../../workbench/drop-commit'
import { useExposeStore } from '../store'
import { togglePinAndAnnounce } from './pin-announce'
import { closeSessionAndAnnounce, deleteSessionAndAnnounce } from './session-actions'
import type { RegionId } from '../../workbench/regions'

/**
 * **一条会话的全部动作 —— 唯一一张表**(09-01「动作单产地 = 右键上下文菜单」;
 * W5-b 交付 2)。
 *
 * SessionRow 的文件头上原本记着一格留账:「右键上下文菜单不在本批 —— 重命名 /
 * 删除 / 移到项目在 React 壳都还没有产地,挂一个弹空菜单的右键比不挂更糟」。
 * 会话多开把那个空菜单填上了第一批真动作:**这一条要在哪儿打开**。
 *
 * ── 八行(A2 把后四行接上,分成三段)──────────────────────────────────────
 *   打开(`files.menuOpen`)             落焦点叶 —— 与单击一行逐字同义(切换)
 *   在右侧打开(`files.menuOpenRight`)  先切一刀,新叶放右边
 *   在新标签页打开(`expose.menuOpenNewTab`)在同一片叶上多开一格
 *   Quick Look(`card.preview`)         09-12:行上那只眼睛退役成这一行
 *   ────
 *   关闭(`expose.menuClose`)           **只在这条此刻开着时在场**,见下
 *   置顶 / 取消置顶(`expose.pin/unpin`)行上那颗图钉退役成这一行
 *   重命名…(`expose.menuRename`)       行内原地改名(那一行的标题换成输入框)
 *   ────
 *   删除…(`expose.menuDelete`)         danger;唯一允许的确认(数据会没)
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
 * A1 先接 Quick Look(它是纯读、零副作用,而且 `Space` 那条键盘等价一直在);
 * A2 接上另外四行 —— **图钉那条鼠标路因此结清**(A1 的留账 1:那两批之间置顶
 * 只有 ⌘⇧P 一条路),而两条路共用的是同一只 `togglePinAndAnnounce`。
 *
 * ── 「关闭」为什么**会不在场**(而别的行永远在)────────────────────────────
 * 禁令那条「禁灰而不消失」(`MenuItem.disabled` 的判词:一张菜单的形状不该随
 * 上下文变)说的是**这一项此刻做不了**;而「关闭」在这条会话没开着的时候不是
 * 做不了,是**没有对象** —— 屏幕上没有任何一格装着它,一行禁灰的「关闭」会让
 * 人以为「有个地方开着但我关不掉」。判据是 `openStateOf ≠ null`,与行尾那颗
 * 开着点(`ui/OpenDot`)**同一句话、同一只纯函数**:点画得出来,这一行就在场。
 * 它由外面递进来(`openState`)而不是这里自己问树:这只组件是右键那一刻的
 * 一张**快照**(`title` 同理),订上树等于让一张菜单跟着整棵树重渲。
 *
 * ── 「删除」那一问为什么是 `ui/Dialog` 的 `useConfirm` 而不是 `MenuItem` 的
 *    两段就地确认 ─────────────────────────────────────────────────────────
 * `MenuItem.confirmLabel` 的判词写着它适用的那一族:「后果是**局部**的(删一行、
 * 删一家),一个模态框对它太重了」。删一条会话不在那一族里 —— **这条会话与它的
 * 全部历史都会没**,而那正是壳里「唯一允许的确认」那一档(09-12 判例,B3-b 给
 * 身份删除用的是同一档)。所以这里走模态:它会把焦点从菜单上拽走再结构性地
 * 还回去,而这一下**就该**打断。
 * `ConfirmHost` 早就挂在 `components/AppShell.tsx` 上(W6-a,工作区删除那一问的
 * 落点),所以这一批没有「把宿主挂进壳」这一步 —— 派工单说它只在测试里挂着,
 * 核下来不是:**这处出入写在 A2 的交卷报里**,并由 `confirm-host.test.ts` 钉住
 * (它是这条路的前提:宿主不在,`await confirm(...)` 永远不 resolve)。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *  ① 生命周期:右键 / 点 ⋯ 那一刻挂载,点任何一行 / 点外 / Esc 卸载
 *     (`ui/Menu` 自己管)。**删除那一行点下去之后菜单先卸载、确认框才开**
 *     —— 次序是刻意的(`onClose()` 排在 `await confirm` 之前):两层浮层叠着
 *     的话 Esc 该退哪一层是个说不清的问题,而那一问本来就该独占一层;
 *  ② UI 生命状态:只有 ready 一格 —— 行是同步算出来的,没有异步、没有空态。
 *     「关闭」的在与不在是**结构**(见上),不是一种加载态;
 *  ③ UI 交互状态:rest / hover / active(键盘位)/ focus / danger 全归 `ui/Menu`
 *     与 `ui/MenuItem`,这只组件一个像素都不画。pending **没有**:四个写口的
 *     反馈全在屏幕上(行搬家 / 字换了 / 那一行没了),而菜单在那之前就卸载了。
 */
export function SessionActionsMenu({
  sessionId,
  title,
  isPinned,
  openState,
  x,
  y,
  onClose,
}: {
  sessionId: string
  title: string
  /** 右键那一刻这条会话置顶没有(快照)。决定第六行念「置顶」还是「取消置顶」。 */
  isPinned: boolean
  /**
   * 右键那一刻它开着没有(快照;判据 `workbench.openStateOf`,与行尾那颗点
   * 同一只纯函数)。`null` = 哪儿都没开 → 「关闭」那一行**整格不在场**。
   */
  openState: 'shown' | 'hidden' | null
  x: number
  y: number
  onClose: () => void
}) {
  const t = useT()
  const confirm = useConfirm()
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

      {/*
       * ── 第二段:改这条会话本身(A2)──────────────────────────────────────
       * 与第一段的差别是**动手的对象**:上面四行改的是「它摆在哪儿」,这三行改的
       * 是这条会话自己(它开着没有 / 置不置顶 / 叫什么)。所以中间一条分隔线。
       */}
      <MenuSeparator />
      {openState !== null && (
        /*
         * **关闭 ≠ 删除**(拍板 5 的原话:把这条从所有开着它的格子里摘掉,
         * 不删数据)。动作整件在 `workbench.closeRef`,播报在
         * `session-actions.closeSessionAndAnnounce` —— 这一行连「摘几处」都不知道。
         */
        <MenuItem
          onClick={() => {
            onClose()
            closeSessionAndAnnounce(sessionId)
          }}
        >
          {t('expose.menuClose')}
        </MenuItem>
      )}
      {/*
       * 置顶 / 取消置顶。**与 ⌘⇧P 是同一口**(`togglePinAndAnnounce`)——
       * 一件事两个入口,播报也就只有一个产地(判词在那只文件上)。
       * 念哪一句由快照 `isPinned` 定:它说的是「按下去会发生什么」,
       * 所以置顶着的行念「取消置顶」。
       *
       * **不画 ⌘⇧P 的键帽**:`ui/MenuItem` 今天没有快捷键那一格(它的 API 是
       * children 复合形,键帽得是一格新 props + 一列排版),而全壳没有第二张
       * 菜单画键帽 —— 为一行现开一格库件 API 会让这张表成为孤例。
       * **这处与派工单的出入写在 A2 的交卷报留账里。**
       */}
      <MenuItem
        onClick={() => {
          onClose()
          togglePinAndAnnounce(sessionId)
        }}
      >
        {t(isPinned ? 'expose.unpin' : 'expose.pin')}
      </MenuItem>
      {/*
       * 重命名…:这一行**只翻形态**(store 的 `startRename`),真正改名发生在
       * 那一行长出来的输入框里(↵ 落定 / Esc 收回)。所以它不是一次写,
       * 后面那三个点说的正是「还有一步」。
       */}
      <MenuItem
        onClick={() => {
          onClose()
          useExposeStore.getState().startRename(sessionId)
        }}
      >
        {t('expose.menuRename')}
      </MenuItem>

      {/* ── 第三段:删掉它。单独一段 —— 它与上面那些不是同一个量级。 ───────── */}
      <MenuSeparator />
      <MenuItem
        danger
        onClick={() => {
          /*
           * 次序:**先关菜单,再问**(判词在文件头③)。`confirm` 是进程级单槽
           * hub 上的一个动作,引用稳定,菜单卸载之后这条 promise 照样活着。
           */
          onClose()
          void confirm({
            title: t('expose.deleteConfirmTitle'),
            description: t('expose.deleteConfirmBody', { name: title }),
            confirmLabel: t('expose.deleteConfirmAction'),
          }).then((ok) => {
            if (!ok) return
            return deleteSessionAndAnnounce(sessionId)
          })
        }}
      >
        {t('expose.menuDelete')}
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
