import { Fragment } from 'react'
import s from './PathText.module.css'

/**
 * **一条路径画出来的样子** —— 纯展示、零状态、零 hook。
 *
 * 它只回答一件事:一条绝对路径摆在一块窄地方(提示体 320px 上限)里,
 * 怎么读得出来。09-13 之前那条提示是「动词 + 整条路径当一句话排」,
 * 于是真机截图里 `lenovo-scripts/ChatBot.lua` 在**连字符**处被掰成两截 ——
 * 断点不讲道理,而「哪个文件、在哪个目录」这两件要核对的事都没说清。
 *
 * ── 两形 ────────────────────────────────────────────────────────────────
 *  · `inline`  —— 一行,斜杠处可断。给「这条路径本身就是那句话」的场合。
 *  · `stacked` —— 名字一行(字重 600)+ 目录一行(同字号、淡一档)。
 *    悬停一枚文件 chip 时人要核对的正是这两件,眼睛不必在一长串里找文件名。
 *
 * ── 断行:每个 `/` 后面一枚 `<wbr>`,**不写 `overflow-wrap: normal`** ──────
 * `<wbr>` 是「这里可以断」的机会点。`.tip` 上那条 `overflow-wrap: anywhere`
 * 的语义按 CSS 规范原话就是:**有别的软换行机会先用别的**,只有「一整段放不下
 * 一整行」时才退到任意字符处断。`<wbr>` 恰恰给了它别的机会点,于是常态下路径
 * 按目录段折、每一行都是完整的一段;单个超长文件名(一段就比整行宽)才落到
 * 那条兜底上 —— 那是要的行为,不是漏网。
 *
 * 所以这里**不给路径节点写 `overflow-wrap: normal`**:写了就等于把兜底也关掉,
 * 一个 55 字的截图文件名会直接伸出深色底外面,退回修之前那一族的病。
 *
 * ── 家目录只是显示层 ────────────────────────────────────────────────────
 * `home` 给了就把前缀画成 `~`(单用户桌面上 `/Users/yitiansong` 这 17 个字不带
 * 任何信息,却让九成路径多出一行)。**只有画出来的那一份缩** —— 无障碍名、
 * 复制、打开一律是全路径,判词在各消费方自己那一行上。
 */
interface PathTextProps {
  path: string
  /** 家目录;给了就把前缀画成 `~`。null/undefined = 不缩。 */
  home?: string | null
  /** inline = 一行(斜杠处可断);stacked = 名字行 + 目录行。默认 inline。 */
  layout?: 'inline' | 'stacked'
  /** 这条路径指的是目录:stacked 时名字行带尾随 `/`。 */
  dir?: boolean
}

/**
 * 家目录前缀 → `~`。**只认两形**:整条就是家目录,或家目录后面跟着一条 `/`。
 *
 * 那条 `/` 不能省:`startsWith(home)` 会把 `/Users/yitiansongX` 也缩成 `~X`,
 * 而那是另一个人的家 —— 同名前缀不是同一个目录。
 */
export function abbreviateHome(path: string, home?: string | null): string {
  if (!home) return path
  // `os.homedir()` 不带尾斜杠,但这一格是别人给的事实,归一一次比信它便宜。
  const root = home.endsWith('/') ? home.slice(0, -1) : home
  if (!root) return path
  if (path === root) return '~'
  if (path.startsWith(`${root}/`)) return `~${path.slice(root.length)}`
  return path
}

/**
 * 一条路径拆成「目录 + 名字」。尾随 `/` **先剥**(`/a/b/` 说的是目录 `b`,
 * 它的名字是 `b`、父目录是 `/a`),所以目录形态与文件形态走同一只函数。
 */
export function splitPath(path: string): { dir: string; name: string } {
  // 根自己没有父目录,也不该被剥成空串。
  if (path === '/') return { dir: '', name: '/' }
  const bare = path.endsWith('/') ? path.slice(0, -1) : path
  if (bare === '') return { dir: '', name: path }
  const at = bare.lastIndexOf('/')
  if (at < 0) return { dir: '', name: bare }
  // `/a.ts` 的父目录是根本身,不是空串。
  if (at === 0) return { dir: '/', name: bare.slice(1) }
  return { dir: bare.slice(0, at), name: bare.slice(at + 1) }
}

/**
 * 一段路径 → 带 `<wbr>` 的节点。每个 `/` 后面恰好一枚,所以「断点数 = 斜杠数」
 * 是这只函数的性质(用例钉的就是它)。
 */
function withBreaks(text: string) {
  const parts = text.split('/')
  return parts.map((part, i) => (
    // 下标当 key 是对的:这一串按位置切出来,第 i 段永远是第 i 段。
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 && (
        <>
          {'/'}
          <wbr />
        </>
      )}
    </Fragment>
  ))
}

export function PathText({ path, home, layout = 'inline', dir = false }: PathTextProps) {
  const shown = abbreviateHome(path, home)
  if (layout === 'inline') return <>{withBreaks(shown)}</>
  const split = splitPath(shown)
  // 目录的名字带回尾巴上那个斜杠 —— 屏幕上「b/」与「b」是两件东西。
  const name = dir ? `${split.name}/` : split.name
  return (
    <>
      <span className={s.name}>{withBreaks(name)}</span>
      {/* 目录那一行**空了就不画**:裸名字与根路径没有父目录可说,
        * 画一格空的 block 只会在提示体里多出一行白。 */}
      {split.dir !== '' && <span className={s.dir}>{withBreaks(split.dir)}</span>}
    </>
  )
}
