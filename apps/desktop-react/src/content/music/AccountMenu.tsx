import { useRef, useState } from 'react'
import type { MusicPlayerBackend, MusicRuntimeState } from '@shared/ipc/music'
import { ButtonBase } from '../../ui/ButtonBase'
import { Menu, MenuItem, MenuSeparator } from '../../ui/Menu'
import { useConfirm } from '../../ui/Dialog'
import { musicSetupOp } from '../../data/music-source'
import { useT } from '../../i18n'
import s from '../MusicPanel.module.css'

/**
 * **账号那颗钮**(2026-09-18;正本 `apps/desktop-react/docs/music-panel-2026-09.md` §6.4)。
 *
 * 电台条右端一枚圆点 —— **不是头像的占位图**:这台机器上根本没有头像这件事实
 * (ncm-cli 不交出用户资料),画一张灰方块会被读成「头像还没加载出来」,而它永远
 * 不会来(与唱片标签不画封面同一条判据,写在 `MusicPanel` 文件头)。
 *
 * ── 一张表,两个入口(动作单产地)──────────────────────────────────────
 * 点这颗钮开的,与在电台条上右键开的,是**同一张** `<AccountMenuItems>`。壳规
 * 「一个条目的全部动作收进同一张右键菜单」说的就是这个:两处入口共用一份表,
 * 而不是钮上一份、右键一份。
 *
 * ── 为什么只有这两项 ────────────────────────────────────────────────────
 * §6.4 那张表就两行:出声方式(mpv / 网易云 App),与退出登录。别的设置(换音乐
 * CLI、电台的开关)各有各的家 —— 一张账号菜单收所有东西,就成了第二个设置页。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 * ① 生命周期:开合是这一格自己的本地状态;换宿主不重挂,菜单开着也不会丢。
 *    电台条在向导那一步根本不画,所以这颗钮只在 `ready` 之后在场 —— 这是对的:
 *    还没登上的时候,「退出登录」是一句没有意义的话。
 * ② UI 生命状态:这件不取数,读的是父级已经有的那份 `state`。`playerBackend`
 *    永远有值(后端出厂是 `mpv`),所以两项里恒有一项打勾,没有「都不打勾」那一档。
 * ③ UI 交互状态:项随 `ui/MenuItem`(rest / hover / active / disabled);打勾那两项
 *    是 `menuitemradio`,由 `checked` 自己推出来;退出登录是 `danger`,先弹确认。
 */
export function AccountMenu({ state }: { state: MusicRuntimeState }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement | null>(null)

  return (
    <>
      <ButtonBase
        ref={anchor}
        className={s.account}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('music.account.menu')}
        data-testid="music-account"
        onClick={() => setOpen((on) => !on)}
      >
        <span className={s.accountMark} aria-hidden="true" />
      </ButtonBase>
      {open && (
        <Menu
          x={0}
          y={0}
          anchor={() => anchor.current?.getBoundingClientRect() ?? null}
          anchorPlace="below-end"
          label={t('music.account.menu')}
          onClose={() => setOpen(false)}
        >
          <AccountMenuItems state={state} onDone={() => setOpen(false)} />
        </Menu>
      )}
    </>
  )
}

/**
 * 表本身。抽出来是因为它有**两个入口**(这颗钮,与电台条上的右键)—— 表只有一份,
 * 开表的地方可以有两处。
 */
export function AccountMenuItems({ state, onDone }: { state: MusicRuntimeState; onDone: () => void }) {
  const t = useT()
  const confirm = useConfirm()

  const pick = (player: MusicPlayerBackend) => {
    onDone()
    if (player === state.playerBackend) return
    void musicSetupOp('set-player').run({ player })
  }

  return (
    <>
      <MenuItem checked={state.playerBackend === 'mpv'} onClick={() => pick('mpv')}>
        {t('music.account.playHere')}
      </MenuItem>
      <MenuItem checked={state.playerBackend === 'orpheus'} onClick={() => pick('orpheus')}>
        {t('music.account.playInApp')}
      </MenuItem>
      <MenuSeparator />
      {/*
        * 退出登录**先确认**(§6.4)。这里刻意不用 `MenuItem` 的两段就地确认:
        * 那一档是给**后果局部**的动作用的(删一行、删一家),而这一下会把电台停掉、
        * 把向导整块退回第 ③ 步 —— 那是整块面的后果,值一个模态框。
        */}
      <MenuItem
        danger
        onClick={() => {
          onDone()
          void confirm({
            title: t('music.account.logoutConfirmTitle'),
            description: t('music.account.logoutConfirmBody'),
            confirmLabel: t('music.account.logout'),
          }).then((yes) => {
            if (yes) void musicSetupOp('logout').run({})
          })
        }}
      >
        {t('music.account.logout')}
      </MenuItem>
    </>
  )
}
