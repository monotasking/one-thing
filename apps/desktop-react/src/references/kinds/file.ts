import { useEffect, useMemo, useRef } from 'react'
import { createFileToken, expandFileTokens } from '@onething/runtime/prompts/prompt-references'
import { resolveIcon } from '../../components/icons'
import {
  FILE_MENTION_DEBOUNCE_MS,
  useFileMentionsSource,
} from '../../data/file-mentions-source'
import type { FileMention } from '../../data/file-mentions-source'
import { matchFiles } from '../../composer/transitions'
import { basename } from '../../content/tools/result'
import { disambiguatedDirName } from '../../content/files/dir-names'
import { openFileAt } from '../../content/viewer/open-target'
import { registerReferenceKind } from '../registry'
import { isDirectoryPath, PATH_REF_PATTERN, pathRefOf } from './path-ref'
import s from '../ReferenceChip.module.css'
import type { RefTag } from '@onething/core/references'
import type { PickContext, PickResult, ReferenceKind } from '../kind'

/**
 * **文件引用** `@<绝对路径>`。
 *
 * 五格都在这一只文件里:`@` 抽屉那一列(它同时是目录的拾取口,见 `kindOf`)、
 * 落进草稿的 `{{file:…}}` 记号与它的展开、气泡里怎么认出来、画成什么、点了去哪。
 *
 * ── 这一列是文件与目录**共用的一次取数** ────────────────────────────────────
 * `files.list` 一发就带回两种(`FileMention.type`),抽屉里它们混在一列里 ——
 * 人打 `@src/` 的时候心里没有「我现在要找的是目录还是文件」这一格。所以拾取归
 * 一家、落稿归两家:`kindOf` 说这条候选落稿时算哪一种,目录那一枚的尾斜杠与
 * chip 写法归 `kinds/dir.ts` 自己。
 */

const FileIcon = resolveIcon('FileText')

/**
 * `@` 候选。**去抖在这里,不在数据源**:`search` 是立即发的(竞速由令牌管),
 * 「人打字的节奏」是编排的事 —— 与 `search/components/SearchPanel.tsx` 逐条同款。
 *
 * **首开不去抖**(09-12 第二批):去抖是给打字的节奏准备的,而 `@` 刚敲下去的那
 * 一拍没有节奏可言 —— 它是一次明确的「我要看候选」,后面跟着的 120ms 纯粹是白等。
 * 所以首开当场发一次,去抖只管此后每一次改词。
 *
 * 不在场时**清候选**(它是「此刻在匹配什么」,不是缓存),而切到在场的那一拍
 * 一个字都不清 —— 所以「开抽屉」本身从不制造一次空列表。
 */
function useFileMentions(ctx: PickContext): PickResult<FileMention> {
  const { active, query, cwd, roots, sessionId } = ctx
  const mentions = useFileMentionsSource((st) => st.mentions)
  const status = useFileMentionsSource((st) => st.status)
  const search = useFileMentionsSource((st) => st.search)
  const clear = useFileMentionsSource((st) => st.clear)

  /** 「是不是刚切到在场的那一拍」。ref 而不是 state:读它的人不需要重渲染。 */
  const justOpened = useRef(false)
  useEffect(() => {
    if (!active) {
      justOpened.current = false
      clear()
      return
    }
    if (!justOpened.current) {
      justOpened.current = true
      void search(query, cwd, sessionId, roots)
      return
    }
    const timer = setTimeout(() => void search(query, cwd, sessionId, roots), FILE_MENTION_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [active, query, cwd, roots, sessionId, search, clear])

  /*
   * 候选到手之后还得在**已到手的那批**里再收一次:去抖窗口里人又多打了两个字,
   * 列表该立刻收窄,而不是等下一次往返。两处收窄用的是同一句判据(`matchFiles`)。
   */
  const hits = useMemo(
    () => (active ? matchFiles(mentions, query) : []),
    [active, mentions, query],
  )
  return { hits, status }
}

/** 一条候选落稿时算哪一种:候选自己说得清是 `directory` 还是 `file`。 */
export function pathKindOf(hit: FileMention): string {
  return hit.type === 'directory' ? 'dir' : 'file'
}

/**
 * **一枚文件引用**(B2 起它指得到一处,不只是一份文件)。
 *
 * 四格定位全是**可选**,而且缺席各有各的意思 —— 「没给行号」与「行号是 0」是两
 * 件事,所以它们不给缺省值,由打开那一路逐级退(symbol ▷ line ▷ 只打开)。
 * `endLine` 只在写标签那一刻与 `line` 合成 `"12-30"`,屏幕上那句读数也照它画。
 */
export interface FileRef {
  kind: 'fileRef'
  path: string
  line?: number
  endLine?: number
  col?: number
  symbol?: string
  /**
   * **屏幕上那几个字由写的人说**(通用属性 `label`,判词在 `references/kind.ts`
   * 的 `ReferenceTagCodec` 上)。缺席 = 由这一种自己算(basename)。
   *
   * 它只换**名字那一格**:`:12 · parseToken` 那一截语法照旧跟在后面,提示里的
   * 两层路径形也不动 —— 模型换的是称呼,不是它指着的那个东西。composer 落稿
   * 出来的引用没有这一格,所以出站的字节一个都不变。
   */
  label?: string
}

/** `12` / `12-30` → 两格。认不出的整格当没给(不猜、不报错)。 */
function parseLineSpan(raw: string | undefined): { line?: number; endLine?: number } {
  if (!raw) return {}
  const m = /^(\d+)(?:-(\d+))?$/.exec(raw.trim())
  if (!m) return {}
  const line = Number(m[1])
  if (!Number.isFinite(line) || line <= 0) return {}
  const end = m[2] === undefined ? undefined : Number(m[2])
  // 区间反着写 / 写成 0 都当只给了起点 —— 落行只认 `line`,所以损失是零。
  return end !== undefined && Number.isFinite(end) && end >= line
    ? { line, endLine: end }
    : { line }
}

/** 一个正整数属性。`col` 与 `line` 同判据,写成一句共用的。 */
function positiveOf(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const n = Number(raw.trim())
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** `12` / `12-30`;两格都没有就不写这一格属性。 */
function lineSpanText(ref: FileRef): string | undefined {
  if (ref.line === undefined) return undefined
  return ref.endLine === undefined ? `${ref.line}` : `${ref.line}-${ref.endLine}`
}

/**
 * **屏幕上那几个字**:`label ▷ basename`,后面跟 [`:12`|`:12-30`][` · symbol`]。
 *
 * 一行恰有一个弯腰件(挤压纪律律一):会缩的只有名字那一格
 * (`.refName` 的 `max-width` + 省略号),行号与符号名是**语法**,一个字都不截
 * —— 截掉 `:12` 之后这枚 chip 就在说谎(它指的是那一行,不是那份文件)。
 *
 * 写的人给了 `label` 就用他的话:一句「看 <ref …>解析器</ref> 这一处」里,
 * 「解析器」比 `parser.ts` 更是这句话要说的东西。**语法那一截照旧跟在后面** ——
 * 换称呼不等于换定位。
 */
function fileChipLabel(ref: FileRef): { name: string; suffix: string } {
  const span = lineSpanText(ref)
  return {
    name: ref.label ?? basename(ref.path),
    suffix: `${span ? `:${span}` : ''}${ref.symbol ? ` · ${ref.symbol}` : ''}`,
  }
}

/**
 * 通用属性 `label` 读出来的那几个字。**trim 后是空串就当没给** —— 一枚写着
 * `label=" "` 的引用画出来会是一片看不见的空白,而屏幕上不该有看不见的东西。
 *
 * 三家(文件 / 目录 / 技能)各读各的,不抽成一处共用:每一种自述读它自己那几格
 * 属性,是这张表的形状(`link.ts` 读 `title`/`label` 也是自己读的)。
 */
function labelOf(tag: RefTag): string | undefined {
  return tag.attrs.label?.trim() || undefined
}

export const fileReferenceKind: ReferenceKind<FileMention, FileRef> = {
  id: 'file',

  source: {
    trigger: '@',
    where: 'anywhere',
    // 路径里的点与连字符都算 token 的一部分(`@src/a-b.ts` 打到一半不许断)。
    tokenChars: '.-',
    /*
     * **空着也画组头**:这是 `@` 这个字符下唯一的一组,组头说的是**整列是什么**,
     * 不是「这里有几条」。底下那句「无匹配 / 正在找…」跟在它后面。
     */
    group: { key: 'composer.headFiles', always: true },
    hint: 'composer.hintFile',
    useQuery: useFileMentions,
    // 抽屉那一行念的是 label(cwd 之下的相对路径),目录**不带尾斜杠**
    // (呈现层的既有拍点,a00e1728 留账未动)。
    /*
     * 不是工作目录里的那几条,副文念出处 —— 那个目录面板**标签上的名字**
     * (同名带父目录,`docs · a`),同一个名字只有一个产地(09-18,正本
     * `docs/composer-open-dir-mentions-2026-09.md` §3)。工作目录里的一行与今天逐字相同。
     */
    row: (hit) => ({
      primary: hit.label,
      ...(hit.root ? { secondary: disambiguatedDirName(hit.root) } : {}),
    }),
    kindOf: pathKindOf,
  },

  draft: {
    /*
     * 候选 → **这一枚引用**。09-14 之前这里交的是一枚 chip(`@<相对路径>`),
     * 而气泡里那一枚由 `render` 画成 basename —— 同一个文件两种写法,按下回车
     * 就换一次形。今天两边读的都是下面那只 `render`。
     */
    toRef: (hit) => ({ kind: 'fileRef' as const, path: hit.path }),
    // chip 是呈现,token 才是位置(`@onething/runtime` 的 `FILE_REF_PATTERN` 那段注)。
    token: (ref) => createFileToken(ref.path),
    /*
     * **展开在草稿出口,而且只在那里**(a00e1728):交出去的那一句必须与账本上
     * 最终落下的逐字相同,不然乐观上屏那一格永远认领不到自己那条消息。
     */
    expand: expandFileTokens,
  },

  parse: {
    text: {
      pattern: PATH_REF_PATTERN,
      toRef: (m) => {
        const hit = pathRefOf(m)
        if (isDirectoryPath(hit.path)) return null
        return { ref: { kind: 'fileRef' as const, path: hit.path }, start: hit.start, end: hit.end }
      },
    },
  },

  /*
   * **线上那条 `<ref type="file" …/>`**(B2)。
   *
   * 属性的次序是**写死的**(`path, line, col, symbol, label`),因为编解码器按
   * 插入序渲染:同一枚引用在任何一次重建里都要产出逐字相同的字节,不然账本上
   * 那条消息每重放一次就变一次。缺席的属性**一格都不写** —— `line=""` 与
   * 「没给行号」是两件事,而写一个空值等于把前者伪装成后者。
   *
   * `~/` 一个字不展:渲染层没有 homedir 这个事实(判词在 `data/files-source.ts`
   * 文件头),展不展得开由打开那条路自己答。
   */
  tag: {
    type: 'file',
    toRef: (tag: RefTag) => {
      const path = tag.attrs.path?.trim()
      // 没有路径就不是一枚文件引用 —— 认不出,照实画中性 chip、原话留屏。
      if (!path || isDirectoryPath(path)) return null
      const span = parseLineSpan(tag.attrs.line)
      const col = positiveOf(tag.attrs.col)
      const symbol = tag.attrs.symbol?.trim()
      const label = labelOf(tag)
      return {
        kind: 'fileRef' as const,
        path,
        ...span,
        ...(col === undefined ? {} : { col }),
        ...(symbol ? { symbol } : {}),
        ...(label ? { label } : {}),
      }
    },
    toTag: (ref) => {
      const attrs: Record<string, string> = { path: ref.path }
      const span = lineSpanText(ref)
      if (span) attrs.line = span
      if (ref.col !== undefined) attrs.col = `${ref.col}`
      if (ref.symbol) attrs.symbol = ref.symbol
      // `label` **恒在最后**:编解码器按插入序渲染,而宽容形折进来的那一格也在
      // 最后 —— 两条来路写出同一串字节,往返才是逐字相同的。
      if (ref.label) attrs.label = ref.label
      return { type: 'file', attrs }
    },
  },

  render: (ref) => {
    const { name, suffix } = fileChipLabel(ref)
    return {
      className: s.ref,
      dataKind: 'fileRef',
      icon: FileIcon,
      iconClassName: s.refIcon,
      label: name,
      labelClassName: s.refName,
      ...(suffix ? { suffix, suffixClassName: s.refSuffix } : {}),
      tooltipKey: 'chat.ref.openFile',
      tooltipArgs: { path: ref.path },
      // 悬停看到的是这条路径的两层形(09-13);「打开 …」那句动词退到
      // `aria-label` 上 —— `chat.ref.openFile` 这个键因此**不删**,它现在只服务
      // 无障碍名。
      tooltipPath: { path: ref.path },
      clickable: true,
    }
  },

  /*
   * 同步开完 —— 一句 `placeRef`,没有可等的东西,所以答 boolean 而不是 promise
   * (pending 那一格的判据就是这个,见 `ReferenceChip`)。
   *
   * `~/` **原样交出去**:渲染层没有 homedir 这个事实(判词逐字写在
   * `data/files-source.ts` 文件头),展不展得开由那条路自己答 —— 也**不许**在这里
   * 拼一个第二套展开。
   */
  open: (ref) => {
    // 定位那三格原样递下去,「落到哪儿」的判据整段在 `openFileAt` 里 ——
    // 这一种只说它指着哪儿,不说怎么找。
    openFileAt(ref.path, {
      ...(ref.line === undefined ? {} : { line: ref.line }),
      ...(ref.endLine === undefined ? {} : { endLine: ref.endLine }),
      ...(ref.col === undefined ? {} : { col: ref.col }),
      ...(ref.symbol ? { symbol: ref.symbol } : {}),
    })
    return true
  },
}

registerReferenceKind(fileReferenceKind, import.meta.hot)
