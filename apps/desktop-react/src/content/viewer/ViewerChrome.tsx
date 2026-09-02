import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { X } from '../../components/icons'
import { IconButton } from '../../ui/IconButton'
import { StatusDot } from '../../ui/StatusDot'
import { Tooltip } from '../../ui/Tooltip'
import type { TFn } from '../../i18n'
import { glyphOf } from '../../data/file-icons'
import { FileGlyphMark } from '../FileGlyph'
import s from './FileViewer.module.css'

/**
 * **头 40:身份与关闭**(09-02 批 9b 从 `FileViewer` 拆出)。
 *
 * ── 檐上只剩身份(09-01 用户裁定)────────────────────────────────────────
 * 修前这条 40 高的檐上挤着七件:类型徽 · 名 · 路径复制钮 · 未保存丸 ·
 * 读取中 · 铅笔 · Finder · 打开方式下拉 · 关闭。真机上文件名被挤成
 * `kimi-sli…`,而其中四件在树行右键菜单里**又有一份**。
 *
 * 裁定:**头只放身份与关闭,动作全归右键菜单**(CLAUDE.md 禁令区)。
 * 于是这里只剩三件 —— 类型徽 + 名(截断,Tooltip 说全名)+ 未保存丸,
 * 加行尾一颗关闭。「正在读取…」搬去脚上那条状态栏(脚是读数的地方)。
 *
 * 撤掉的四件各自的新家:
 *   复制路径 / 在 Finder 显示 / 编辑 / 打开方式 → 身上右键那张
 *   `FileActionsMenu`(与树行同一张表,同一份定义)。
 *
 * ── 这一条是 `<div>` 而不是 `<header>` ──────────────────────────────────
 * `<header>` 在无障碍树里会变成一枚 **banner 地标**,而一块面板内部的檐不是
 * 「整份文档的页眉」—— 真机 axe 当场报 landmark-no-duplicate-banner
 * (外壳自己已经有一枚)。同理脚那条不是 `<footer>`(那会变成 contentinfo)。
 * 语义靠 aria-label 与角色说,不靠一个会顺手宣布地标的标签名。
 *
 * ── 三张状态表 ──────────────────────────────────────────────────────────
 *  ① 生命周期:无订阅、无计时器、无 ref —— 挂载即画,不需要 HMR dispose。
 *     它整条**在合檐的落点里根本不挂**(判据是下面那张 `HOST_OWNS_CHROME`
 *     表,由落点决定),所以「换宿主」对它是一次真正的挂载 / 卸载。
 *  ② UI 生命状态:**没有文件就不画身份**,只剩一颗关闭(见下面那段 axe 判例);
 *     有身份时三件按在场与否各自出现(徽 / 名恒在,未保存丸只在脏的时候)。
 *     没有 loading 档 —— 「正在读取…」是脚的事。
 *  ③ UI 交互状态:名那一格 rest / hover(Tooltip 弹全路径,300ms)/ 截断;
 *     关闭那一颗的 rest/hover/focus/active 全部随 `ui/IconButton` 走
 *     (09-01 立法:图标钮必须消费库件,配方随件走);未保存丸**不是控件**
 *     (不进 Tab 序、没有 hover/active),它只是一枚状态点。
 */

/**
 * **这些落点的宿主自带一条檐** —— 那时查看器整条檐不画,身份交给宿主檐说
 * (见 `FileViewer` 文件头那张落点生命周期表)。判据在这里定一次,不散在
 * JSX 的条件里:加一种自带檐的宿主 = 这张表加一格。
 *
 * 表与它治的那条檐放在同一个文件里:改表的人一眼看得见被改掉的是什么。
 */
const HOST_OWNS_CHROME = new Set(['float', 'stage', 'cover'])

/** 这一档落点的宿主自带檐吗 —— 自带就合一(查看器整条檐不画)。 */
export function hostOwnsChrome(placement: string): boolean {
  return HOST_OWNS_CHROME.has(placement)
}

export interface ViewerChromeProps {
  t: TFn
  /** 文件路径。空串 = 一个文件都没打开(F2 之后真会到达的一帧)。 */
  path: string
  /** 文件名(截断显示,全路径进 Tooltip)。 */
  name: string
  /** 有没有没存的改动。 */
  dirty: boolean
  /** 这一型自己那一格(markdown 的渲染⇄源码 …)。`null` = 这一型没有 / 编辑态。 */
  toolbar: ReactNode
  onClose: () => void
}

export function ViewerChrome({ t, path, name, dirty, toolbar, onClose }: ViewerChromeProps) {
  const glyph = useMemo(() => glyphOf(name || '?', 'file'), [name])

  return (
    <div className={s.chrome} data-viewer-chrome="">
      {/*
       * ── 没有文件就**不画身份**(09-01 gate:a11y 的 `_chromeGlyph` 2.68 红)──
       * F2 之前查看器只可能在「有文件」的情况下出现,所以这两格无条件画。
       * F2 把它变成一块普通的瓦之后,「一个文件都没打开」成了真会到达的一帧,
       * 而那时 `glyphOf(name || '?', 'file')` 会造一枚**不存在的文件**的徽
       * (认不出 → `···` 那一格)。它有两重错:
       *  ① 它在说谎 —— 屏幕上并没有一个叫 `?` 的文件;
       *  ② 那一格的底/字是 --fb-unknown 那对灰,对比度 2.68 < 4.5(axe 当场红)。
       * 修法是**别画**:没有身份的时候檐上就只剩关闭。对比度那一格另修
       * (tokens 里 --fb-unknown-fg / --fb-bin-fg 压深到 AA),两件事各修各的。
       */}
      {path && <FileGlyphMark glyph={glyph} className={s.chromeGlyph} />}
      {/*
       * 名字截断,Tooltip 说全名(禁令区:标题截断须配 Tooltip 全名)。
       * 提示里给的是**整条路径**而不只是文件名 —— 两个同名文件在两个目录里
       * 是这一格最常见的歧义,而路径钮已经不在檐上了。
       */}
      {path && (
        <Tooltip content={path}>
          <span className={s.name} data-testid="viewer-name" data-viewer-path={path}>
            {name}
          </span>
        </Tooltip>
      )}
      {dirty && (
        <span className={s.dirty} data-testid="viewer-dirty">
          {/*
           * 未保存丸**消费 `ui/StatusDot`**(09-02 批 9b 兑现批 8b 留下的那格账)。
           * 它从前是本地一颗 `.dirtyDot`:5px 圆 + `var(--warn)`,而当时那件只认
           * 6px,于是它留在外面自绘 —— 正是「同一种东西在两块面里长得不一样」
           * 那条病。批 8a 补上 `size="sm"`(5px,`--status-dot-sm`,值就取自这一颗)
           * 之后它迁得进来,且**逐像素相同**:`.warn` 接的同样是 `var(--warn)`,
           * 圆角同样是 `--r-full`。
           *
           * 不给 `label`:旁边那句「未保存」已经把同一件事写出来了,再给它一个
           * 无障碍名,读屏软件会念两遍(判据写死在 `ui/StatusDot` 文件头)。
           */}
          <StatusDot tone="warn" size="sm" />
          {t('viewer.unsaved')}
        </span>
      )}
      {/*
       * 型工具条**长在名条右端**(09-01 自查走查:panel 宿主一屏五条横带)。
       * 它从前自成一条 51 高的带子,而 40 高的名条右边空着一大片 —— 一排放得下,
       * 就不该占两排(原则:正文优先)。它排在动作组之前:身份在左、这一型自己的
       * 那一格居中偏右、关闭永远在最右。
       */}
      {toolbar && <span className={s.chromeTool}>{toolbar}</span>}
      <span className={s.actions}>
        <IconButton icon={X} label={t('viewer.close')} testId="viewer-close" onClick={onClose} />
      </span>
    </div>
  )
}
