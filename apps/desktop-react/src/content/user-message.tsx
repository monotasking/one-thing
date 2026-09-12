import { useCallback, useMemo, useRef, useState } from 'react'
import { resolveIcon } from '../components/icons'
import { useT } from '../i18n'
import { notify } from '../services/notify'
import { ButtonBase } from '../ui/ButtonBase'
import { Tooltip } from '../ui/Tooltip'
import { basename } from './tools/result'
import { openDirectoryPanel } from './dir-open'
import { openSkillDirectory } from './skill-open'
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
 * **第二病(09-12 用户真机报障:「发 `/skill:名` 出去,气泡里是一整份 SKILL.md」)**:
 * 引擎收到用户消息后跑 `resolvePromptReferences`(runtime `prompts/resolver.ts`),
 * 把 `/skill:<name>` 展成两样东西 —— **模型版** `modelContent`(`formatSkillForModel`
 * 把整份 SKILL.md 内联进去)与**显示版** `contentParts`(`[{text}, {skill-ref…}]`)。
 * 账本上那条消息的 `content` 存的是**模型版**,所以照着 `content` 画就是把整份
 * SKILL.md 摆进气泡。旧 Vue 壳一直是按 `contentParts` 折的(runtime 那半的
 * `displayTextFromPromptParts`),React 壳只吃了 `content` —— 这只文件补的就是那一格。
 *
 * ── 「发出去的东西」一张表(用户原话:「统一看一下」)────────────────────────
 * | 东西 | 正文里长什么样 | 气泡里画成 | 点了去哪 |
 * | --- | --- | --- | --- |
 * | 文件 | `@<绝对路径>`(草稿里是 `{{file:…}}`,出站由 `chat-port.expandFileTokens` 展开) | chip,📄 + basename | `openFileInCurrentTarget` → 查看器 |
 * | 目录 | `@<绝对路径>/`(尾巴那个 `/` 由 `usePickDrawer.applyPick` 写死 —— 壳没有 stat) | chip,📁 + `名字/` | `openDirectoryPanel` → 目录面板 |
 * | 技能 | `/skill:<name>`,**引擎折成 `skill-ref` 部件**(`content` 里是 SKILL.md 正文) | chip,◇ + 技能名 | `openSkillDirectory` → 那条技能所在的目录面板(查不到则 Finder 回落) |
 * | 提示词 | `{{prompt:<id>}}`,引擎折成 `prompt-ref` 部件 | 药丸 `[标题]`,**不可点** | —— 见下「留账」 |
 * | 命令 | 整条消息开头那个 `/x` | 药丸,不可点 | —— 它是**已经发生过的事**的记号 |
 * | 网页 | `{{page:<tabId>}}`,发送时由 `data/page-references` 物化成 **attachments** | **不归这只文件**:它进的是气泡的附件那一格 | —— 见下「留账」 |
 *
 * ── 留账两条(明知没做,别当成已治)────────────────────────────────────────
 *  · **prompt-ref 不可点**:提示词库在 React 壳里还没有一块能打开的面(没有
 *    `prompts-source`、没有查看器落点),所以今天只画一枚药丸把标题说出来 ——
 *    画一个点了没反应的按钮比不画更坏(「屏幕上不该出现一个按下去没反应的东西」)。
 *  · **附件那一格**(网页引用物化出来的那些)今天怎么画、能不能点,归浏览器那批,
 *    这一单一个字不碰。
 *
 * ── 这里只做「切」与「画」两件事 ────────────────────────────────────────────
 * `segmentUserMessage` / `segmentUserParts` 是**纯函数**(切),下面几个组件是
 * **画**。切的判据一个字都不在组件里 —— 单测钉的是那张切分表,组件换形不该动它。
 *
 * ── 不发明新语法 ──────────────────────────────────────────────────────────
 * 与 `docs/design/message-references-2026-08.md` 同一条裁定:引用是**已经在正文里
 * 的写法**,壳只是认出来。所以「裸文件名不算文件」——`@foo` 没有斜杠就是三个字,
 * 原样当文字画。同一条裁定管着部件那一半:壳**只认三种 part**,其余一律不画
 * (与 runtime 的 `displayTextFromPromptParts` 逐条同一张表)——「不认识就原样
 * 摆出来」在这里是错的,`skill-ref.content` 正是那份 4862 字的 SKILL.md。
 *
 * ── `~/` 的留账(做不了,不自己造第二套)──────────────────────────────────
 * 渲染层**没有 homedir 这个事实**(判词逐字写在 `data/files-source.ts` 文件头:
 * `~` 只有后端展得开,它那一处是 `port.stat('~')` 一次往返)。这里是同步的一下点击,
 * 没有第二套展开可用,也**不许**在渲染层拼一个 —— 所以 `~/x` 原样交给打开函数,
 * 展不展得开由那条路自己答。真要展,该加的是 `files-port` 上一口同步可读的 home,
 * 而不是在这只文件里 `replace('~', …)`。
 */

/**
 * 切出来的一段。七种,别处不许再认第八种。
 *
 * 前五种从**正文**里切(`segmentUserMessage`);后两种只可能从 **`contentParts`**
 * 来(`segmentUserParts`)—— 正文里根本没有它们的记号,引擎在展开那一刻就把
 * `{{prompt:id}}` / `/skill:name` 换成了别的东西。
 *
 * `skill`(正文形)与 `skillRef`(部件形)**是两种东西,不是一种的两个来源**:
 * 前者只有一个名字(老会话、或者引擎没展开的那一条),后者带着 `skillId` ——
 * 而「打开它所在的目录」要的正是 id。所以前者不可点,后者可点。
 */
export type UserSegment =
  | { kind: 'text'; text: string }
  | { kind: 'fileRef'; path: string }
  | { kind: 'dirRef'; path: string }
  | { kind: 'command'; token: string }
  | { kind: 'skill'; token: string; name: string }
  | { kind: 'skillRef'; skillId: string; name: string }
  | { kind: 'promptRef'; title: string }

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
 * 一截正文 → 若干段,追加进 `out`。
 *
 * `atStart` = **这一截是不是整条消息的开头**。命令词只认开头那一个,所以它是
 * 一个参数而不是一句 `out.length === 0` —— 部件那条路上,开头那一截可能排在
 * 一枚 `skill-ref` **后面**(`/skill:x 干活` 折出来是 `[skill-ref, text(' 干活')]`),
 * 那时 `' 干活'` 不是开头;反过来,一条以 `\n/cd` 换行的第二截正文也不是开头,
 * 不加这一格的话它会被读成命令。
 */
function appendText(out: UserSegment[], text: string, atStart: boolean): void {
  if (!text) return
  const head = atStart && text.startsWith('/') ? COMMAND_HEAD.exec(text) : null
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
}

/**
 * **切分表**(单测钉的就是它)。命令只认整条消息的开头那一个词,`@` 引用全文都认。
 */
export function segmentUserMessage(text: string): UserSegment[] {
  const out: UserSegment[] = []
  appendText(out, text, true)
  return out
}

/* ── 部件那一半 ───────────────────────────────────────────────────────── */

/**
 * 引擎折出来的一格 `contentParts`。
 *
 * 形状**故意是宽的**:投影那头的类型(`core/session/projection/types.ts` 的
 * `ProjectedContentPart`)里根本没有 `skill-ref` / `prompt-ref` 两支 —— 它们是
 * 引擎在用户消息上盖的,而投影把整条消息原样交出来(`materializeMessageNode`
 * 的那一句浅展开)。所以收窄发生在**这里、按 `type` 一支一支地认**,与
 * `shared/ipc/chat.ts` 的 `isProviderCitations` 同一手:不认识的一律不画,
 * 而不是 `as any` 拆袋。
 */
export interface UserContentPart {
  type?: string
  content?: string
  title?: string
  name?: string
  skillId?: string
}

/**
 * **部件切分表**。与 runtime 的 `displayTextFromPromptParts` 逐条同一张表:
 * text 原样切、prompt-ref → 标题、skill-ref → 名字、**其余什么都不画**。
 *
 * 最后那一条是这张表里唯一要紧的一条:`skill-ref.content` 就是那份整篇 SKILL.md,
 * 「不认识就把 content 摆出来」会把这一单要治的病原样种回去。
 */
export function segmentUserParts(parts: readonly UserContentPart[]): UserSegment[] {
  const out: UserSegment[] = []
  let atStart = true
  for (const part of parts) {
    const type = part.type
    if (type === 'text') {
      appendText(out, part.content ?? '', atStart)
    } else if (type === 'skill-ref' && part.skillId) {
      out.push({ kind: 'skillRef', skillId: part.skillId, name: part.name || part.skillId })
    } else if (type === 'prompt-ref') {
      out.push({ kind: 'promptRef', title: part.title ?? '' })
    }
    // 其余(reasoning / image / provider-data / tool-call…)一个字都不画:
    // 它们不是用户说的话。
    atStart = false
  }
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

/** 技能那枚记号。正文形(不可点)与部件形(可点)共用同一个字,所以它只有一处。 */
const SKILL_MARK = '◇'

/**
 * 一枚**技能** chip。与文件 / 目录 chip 同一族皮肤、同一条裸钮判(第③类 →
 * `ui/ButtonBase`),只有色不同(`--umsg-skill-*`)。
 *
 * ── 点下去是异步的,所以有 pending 那一格 ────────────────────────────────
 * 首选路(表里有目录 → 开面板)是同步的一下,但表可能还没拉过 —— 那一支要等一发
 * `skills.getAll` 回来。所以按异步反馈纪律给它一个 pending 态:**不转圈**
 * (spinner 只许出现在按钮内或状态栏,而这是一枚行内小牌),只把 `aria-busy` 打上、
 * 让 CSS 把它压淡一档。
 *
 * **不用 `disabled` 挡重复点**:一颗拿着焦点的按钮变 disabled,浏览器会把焦点
 * 丢回 `<body>` —— 那正是响应链 I1 禁的那一形。改用一格 ref 当闸:pending 期间
 * 再点是恒等,焦点一动不动。
 */
function SkillChip({ seg, t }: { seg: { kind: 'skillRef'; skillId: string; name: string }; t: TFn }) {
  const [pending, setPending] = useState(false)
  const busy = useRef(false)
  const hint = t('chat.ref.openSkill', { name: seg.name })

  const click = useCallback(() => {
    if (busy.current) return
    busy.current = true
    setPending(true)
    void openSkillDirectory(seg.skillId)
      .then((opened) => {
        if (opened) return
        // 三条路全落空。说一句话就够 —— 没有详情可看,也不该赖着不走。
        notify({ level: 'warn', source: 'chat.skillRef', title: t('chat.ref.openSkillFailed', { name: seg.name }) })
      })
      .finally(() => {
        busy.current = false
        setPending(false)
      })
  }, [seg.skillId, seg.name, t])

  return (
    <Tooltip content={hint}>
      <ButtonBase
        className={s.skillChip}
        data-ref-kind="skillRef"
        aria-label={hint}
        aria-busy={pending || undefined}
        onClick={click}
      >
        <span aria-hidden="true">{SKILL_MARK}</span>
        <span className={s.refName}>{seg.name}</span>
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
      // 正文形:只有名字,没有 id —— 打不开任何东西,所以不可点(见 `UserSegment`)。
      return (
        <span className={s.skill}>
          <span aria-hidden="true">{SKILL_MARK}</span>
          {seg.name}
        </span>
      )
    case 'skillRef':
      return <SkillChip seg={seg} t={t} />
    case 'promptRef':
      // 不可点,理由是文件头「留账」第一条:壳里还没有一块能打开提示词的面。
      return <span className={s.prompt}>[{seg.title || t('chat.ref.promptUntitled')}]</span>
  }
}

/**
 * 气泡正文。换行仍旧由 `.user` 那句 `white-space: pre-wrap` 保留 —— 切分一个字符
 * 都不吃,拼回来与原文逐字相同。
 *
 * ── 两个来源,一条判据 ────────────────────────────────────────────────────
 * **有 `parts` 就按部件画,没有才切 `text`。** 判据是「引擎到底有没有替这条消息
 * 折过显示版」:折过的那些,`text`(= 账本上的 `content`)是**模型版** ——
 * 技能那一支里它是整份 SKILL.md,照着画就是这一单要治的病。老会话、以及引擎
 * 没展开过引用的那些消息上没有这一格,照旧走正文切分,行为逐字不变。
 *
 * **空数组 = 没有**:`contentParts` 在投影那头只有 `length > 0` 时才挂上去
 * (`materializeAssistantNode` 的那一句),一个空数组只可能是某条路径传了个空壳 ——
 * 按它画会画出一个空气泡。
 *
 * key 用下标:段序列是**一个不可变输入**的投影,同一条消息里它不会重排也不会
 * 增删(消息正文改了就是另一条消息,输入变则整段重算)。
 */
export function UserMessageBody({
  text,
  parts,
}: {
  text: string
  parts?: readonly UserContentPart[]
}) {
  const t = useT()
  const segments = useMemo(
    () => (parts && parts.length > 0 ? segmentUserParts(parts) : segmentUserMessage(text)),
    [text, parts],
  )
  return (
    <>
      {segments.map((seg, i) => (
        <SegmentView key={i} seg={seg} t={t} />
      ))}
    </>
  )
}
