import { useMemo } from 'react'
import { resolveIcon } from '../components/icons'
import { useT } from '../i18n'
import { ButtonBase } from '../ui/ButtonBase'
import { Tooltip } from '../ui/Tooltip'
import { basename } from './tools/result'
import { openDirectoryPanel } from './dir-open'
import { openFileInCurrentTarget } from './viewer/open-target'
import s from './user-message.module.css'
import type { TFn } from '../i18n'

/**
 * **用户那句话里的引用怎么画**(2026-09-12)。
 *
 * ── 病 ────────────────────────────────────────────────────────────────────
 * 气泡从前是 `{message.content}` 一句纯文本。composer 里用 `@` 选中的文件在草稿里
 * 是 `{{file:<绝对路径>}}`,出站时 `data/chat-port` 的 `expandFileTokens` 把它展成
 * `@<绝对路径>` —— 于是屏幕上露出一整串 `@/Users/…/src/a.ts`:不能点、不截断、
 * 把气泡撑破。命令 `/cd ~/x` 与技能 `/skill:commit` 同样是裸文本。
 *
 * ── 这里只做「切」与「画」两件事 ────────────────────────────────────────────
 * `segmentUserMessage` 是**纯函数**(切),下面几个组件是**画**。切的判据一个字
 * 都不在组件里 —— 单测钉的是那张切分表,组件换形不该动它。
 *
 * ── 不发明新语法 ──────────────────────────────────────────────────────────
 * 与 `docs/design/message-references-2026-08.md` 同一条裁定:引用是**已经在正文里
 * 的写法**,壳只是认出来。所以「裸文件名不算文件」——`@foo` 没有斜杠就是三个字,
 * 原样当文字画。
 *
 * ── `~/` 的留账(做不了,不自己造第二套)──────────────────────────────────
 * 渲染层**没有 homedir 这个事实**(判词逐字写在 `data/files-source.ts` 文件头:
 * `~` 只有后端展得开,它那一处是 `port.stat('~')` 一次往返)。这里是同步的一下点击,
 * 没有第二套展开可用,也**不许**在渲染层拼一个 —— 所以 `~/x` 原样交给打开函数,
 * 展不展得开由那条路自己答。真要展,该加的是 `files-port` 上一口同步可读的 home,
 * 而不是在这只文件里 `replace('~', …)`。
 */

/** 切出来的一段。五种,别处不许再认第六种。 */
export type UserSegment =
  | { kind: 'text'; text: string }
  | { kind: 'fileRef'; path: string }
  | { kind: 'dirRef'; path: string }
  | { kind: 'command'; token: string }
  | { kind: 'skill'; token: string; name: string }

/**
 * 整条消息开头那个命令词。
 *
 * `(?=\s|$)` 那一句是**这条规则唯一的刹车**:没有它,一条以绝对路径开头的消息
 * (`/Users/me/a.ts 看一下`)会把 `/Users` 读成命令。命令词里不许再出现斜杠,
 * 所以路径开头的消息在这里整条落空 —— 不是「猜得比较准」,是结构上不可能命中。
 */
const COMMAND_HEAD = /^\/([A-Za-z][A-Za-z0-9_-]*(?::[A-Za-z0-9_-]+)?)(?=\s|$)/

/** `/skill:<name>` 的前缀。技能与普通命令的分界只有这一处。 */
const SKILL_PREFIX = '/skill:'

/**
 * 正文里的 `@` 引用。
 *
 * 三条判据各自挡一类误判,拆掉哪条就有哪类假引用:
 *  · `(^|[\s…])` —— `@` 前必须是行首、空白,**或一个左括号**。挡掉 `user@/path`
 *                  这种地址形(rsync / scp 的写法),它不是引用;左括号那一格
 *                  是给「(@/a/b.ts)」「(@/a/dir/)」这种夹注写法留的门 ——
 *                  它与地址形无关(`backup@/mnt` 里 `@` 前是字母,照旧挡住)。
 *  · `(?:~\/|\/)` —— `@` 后必须紧跟绝对路径的起笔。挡掉邮箱 `a@b.com` 与
 *                  `@foo` 这种裸名字;
 *  · 路径的字符集 —— 到下一个**空白或全角标点**为止(见下)。于是
 *                  **带空格的路径认不出整条**(`@/Users/my file.ts` 只认到
 *                  `/Users/my`),这是明知的取舍:认空格就得猜哪一个空格是路径的
 *                  一部分,而猜错的代价是把后半句正文吞进一枚 chip 里。
 */
const REF_PATTERN = /(^|[\s([{<（【「『《〈])@((?:~\/|\/)[^\s，。、；：！？）】」』》〉（【「『《〈]*)/g

/**
 * 尾随标点**剥下来还给正文**(2026-09-12 review 打回)。
 *
 * 病:路径吞了标点,chip 点开**必然**打不开(那条路径不存在)。中文正文里最自然的
 * 那几种写法全中:「看看 @/a/b.ts,然后…」「(@/a/b.ts)」「@/a/b.ts。」。
 *
 * ── 为什么是两半,不是一条「尾巴剥干净」───────────────────────────────────
 * 半角与全角在这件事上是**两种东西**,一条规则盖不住:
 *  · **全角标点直接不进路径**(写进上面那个字符集的排除表)。中文正文不用空格断句
 *    ——「@/a/b.ts,然后」整串没有一个空白,只在尾部剥的话什么都剥不掉(这正是
 *    review 那条打回的原样复现)。全角标点在真实文件名里近乎不存在,所以它可以当
 *    终止符;顺带也就管住了 `（…）` 夹注的右半边。
 *  · **半角标点只在尾部剥**(下面这条)。`,` `.` `:` 在文件名中间是合法的
 *    ——`@/a/b.v2.ts` 必须整条留着 —— 所以只锚 `$`,一次剥一串
 *    (`(@/a/b.ts)。` 的 `)` 归这条,`。` 归上一条)。
 *
 * 两件事值得写清楚:
 *  · 结尾的 `.` 也剥 —— 一个以点结尾的路径不是文件名,那个点是句号;
 *  · **目录判据在剥完之后才判** —— 不然 `(@/a/dir/)` 的尾巴是 `)`,
 *    剥之前它不以 `/` 结尾,会被判成文件。
 * `/` 两条表里都没有(它是目录的记号,不是标点)。
 */
const TRAILING_PUNCT = /[,.;:!?)\]}>'"]+$/

/** 相邻的文字并成一段:剥下来的尾巴与它后面那截正文本来就是同一句话。 */
function pushText(out: UserSegment[], text: string): void {
  if (!text) return
  const last = out[out.length - 1]
  if (last?.kind === 'text') last.text += text
  else out.push({ kind: 'text', text })
}

/** 正文那一半:把 `@…` 抠出来,其余原样留成文字。 */
function pushRefs(text: string, out: UserSegment[]): void {
  if (!text) return
  REF_PATTERN.lastIndex = 0
  let last = 0
  let match: RegExpExecArray | null
  while ((match = REF_PATTERN.exec(text)) !== null) {
    const lead = match[1]
    const raw = match[2]
    const path = raw.replace(TRAILING_PUNCT, '')
    const start = match.index + lead.length
    pushText(out, text.slice(last, start))
    // 结尾一个 `/` = 用户自己说了这是个目录。别处不许再猜(壳没有 stat)。
    out.push(path.endsWith('/') ? { kind: 'dirRef', path } : { kind: 'fileRef', path })
    // 剥下来的标点是正文,不是路径 —— 还回去。
    pushText(out, raw.slice(path.length))
    last = match.index + match[0].length
  }
  pushText(out, text.slice(last))
}

/**
 * **切分表**(单测钉的就是它)。命令只认整条消息的开头那一个词,`@` 引用全文都认。
 */
export function segmentUserMessage(text: string): UserSegment[] {
  const out: UserSegment[] = []
  if (!text) return out
  const head = text.startsWith('/') ? COMMAND_HEAD.exec(text) : null
  let rest = text
  if (head) {
    const token = head[0]
    if (token.startsWith(SKILL_PREFIX)) {
      out.push({ kind: 'skill', token, name: token.slice(SKILL_PREFIX.length) })
    } else {
      out.push({ kind: 'command', token })
    }
    rest = text.slice(token.length)
  }
  pushRefs(rest, out)
  return out
}

/** 目录名带回尾巴上那个斜杠 —— 屏幕上「b/」与「b」是两件东西。 */
function labelOf(seg: { kind: 'fileRef' | 'dirRef'; path: string }): string {
  const name = basename(seg.path)
  return seg.kind === 'dirRef' ? `${name}/` : name
}

const FileIcon = resolveIcon('FileText')
const DirIcon = resolveIcon('Folder')

/**
 * 一枚引用 chip。**结构性交互件**(裸钮三类判的第③类:它有自己的形,不该硬套
 * `ui/Button`),所以走 `ui/ButtonBase` —— 只清 UA,皮肤留在本地那份 CSS 里。
 * 全路径走 `ui/Tooltip`(禁 native `title=`);键盘可达是 `<button>` 自带的那一格,
 * 焦点环走全局 `:focus-visible`,这里一行都不写。
 */
function RefChip({ seg, t }: { seg: { kind: 'fileRef' | 'dirRef'; path: string }; t: TFn }) {
  const dir = seg.kind === 'dirRef'
  const Icon = dir ? DirIcon : FileIcon
  const hint = t(dir ? 'chat.ref.openDir' : 'chat.ref.openFile', { path: seg.path })
  return (
    <Tooltip content={hint}>
      <ButtonBase
        className={s.ref}
        data-ref-kind={seg.kind}
        aria-label={hint}
        onClick={() => (dir ? openDirectoryPanel(seg.path) : openFileInCurrentTarget(seg.path))}
      >
        <Icon className={s.refIcon} strokeWidth={1.75} aria-hidden="true" />
        <span className={s.refName}>{labelOf(seg)}</span>
      </ButtonBase>
    </Tooltip>
  )
}

function SegmentView({ seg, t }: { seg: UserSegment; t: TFn }) {
  switch (seg.kind) {
    case 'text':
      return <>{seg.text}</>
    case 'fileRef':
    case 'dirRef':
      return <RefChip seg={seg} t={t} />
    case 'command':
      // 不可点:它是**已经发生过的事**的记号,不是一个还能按的按钮。
      return <span className={s.command}>{seg.token}</span>
    case 'skill':
      return (
        <span className={s.skill}>
          <span aria-hidden="true">◇</span>
          {seg.name}
        </span>
      )
  }
}

/**
 * 气泡正文。换行仍旧由 `.user` 那句 `white-space: pre-wrap` 保留 —— 切分一个字符
 * 都不吃,拼回来与原文逐字相同。
 *
 * key 用下标:段序列是**一个不可变字符串**的投影,同一条消息里它不会重排也不会
 * 增删(消息正文改了就是另一条消息,`text` 变则整段重算)。
 */
export function UserMessageBody({ text }: { text: string }) {
  const t = useT()
  const segments = useMemo(() => segmentUserMessage(text), [text])
  return (
    <>
      {segments.map((seg, i) => (
        <SegmentView key={i} seg={seg} t={t} />
      ))}
    </>
  )
}
